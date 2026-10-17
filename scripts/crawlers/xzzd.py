"""Read-only, paced homework collection from the official TronClass JSON API.

Only the four documented GET routes below are available. Raw API responses,
submission files, grades and session material never enter a checkpoint.
"""

from __future__ import annotations

import copy
from datetime import date, datetime
import json
import math
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit
from urllib.request import Request

from yunfeng_html import _ATTACHMENT_SUFFIXES, _body_text, _tree, _walk

from .homework_contract import normalize_homework
from .homework_selection import course_is_current
from .http import CrawlFailure, SlowClient, has_sensitive_query, retry_after_seconds


HOST = "courses.zju.edu.cn"
ORIGIN = "https://" + HOST
PAGE_SIZE = 50
COURSE_REFRESH = 6 * 3600
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_COURSES = 500
MAX_ITEMS = 5000
MAX_PAGE = 1000
_IDENTIFIER = re.compile(r"[1-9][0-9]{0,19}\Z")
def _id(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    value = str(value)
    return value if _IDENTIFIER.fullmatch(value) else None


def _text(value, maximum=1000):
    return re.sub(r"\s+", " ", value).strip()[:maximum] if isinstance(value, str) else ""


def _timestamp(value):
    """Keep only explicit ISO dates or times; do not invent an unknown timezone."""
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date.fromisoformat(value)
            return value
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})", value):
            return None
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return moment.isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def homework_url(course_id, activity_id):
    course_id, activity_id = _id(course_id), _id(activity_id)
    if not activity_id:
        raise CrawlFailure("invalid_homework_metadata")
    return (f"{ORIGIN}/course/{course_id}/learning-activity#/{activity_id}"
            if course_id else ORIGIN + "/")


def _api_url(path):
    """Accept relative API paths with an exact read-only query contract."""
    try:
        parts = urlsplit(path)
        if not isinstance(path, str) or parts.scheme or parts.netloc or parts.fragment:
            raise ValueError
        pairs = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True) if parts.query else []
        query = dict(pairs)
        if len(query) != len(pairs):
            raise ValueError
        if parts.path == "/api/todos":
            if query != {"no-intercept": "true"}:
                raise ValueError
        elif parts.path == "/api/my-courses" or re.fullmatch(r"/api/courses/[1-9][0-9]{0,19}/homework-activities", parts.path):
            expected = {"page", "page_size"}
            if parts.path == "/api/my-courses":
                expected.add("conditions")
                condition = json.loads(query.get("conditions", ""))
                if (not isinstance(condition, dict) or set(condition) != {"status", "keyword"}
                        or condition["keyword"] != "" or not isinstance(condition["status"], list)
                        or not condition["status"] or len(condition["status"]) > 2
                        or len(set(condition["status"])) != len(condition["status"])
                        or any(status not in {"ongoing", "notStarted"} for status in condition["status"])):
                    raise ValueError
            if set(query) != expected:
                raise ValueError
            if (not re.fullmatch(r"[1-9][0-9]{0,3}", query["page"])
                    or not 1 <= int(query["page"]) <= MAX_PAGE
                    or query["page_size"] != str(PAGE_SIZE)):
                raise ValueError
        elif re.fullmatch(r"/api/activities/[1-9][0-9]{0,19}", parts.path):
            if query:
                raise ValueError
        else:
            raise ValueError
        return ORIGIN + path
    except (TypeError, ValueError, KeyError):
        raise CrawlFailure("invalid_homework_api_url") from None


def _json_object(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError
            result[key] = value
        return result

    def constant(value):
        raise ValueError

    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (UnicodeError, ValueError, RecursionError):
        raise CrawlFailure("invalid_api_json") from None


class XzzdClient(SlowClient):
    """Use the existing pacing and per-source cookie jar for GET JSON only."""

    def __init__(self, host=HOST, protected=True, session=None, **kwargs):
        if host != HOST or protected is not True or session is None or kwargs.get("allow_http"):
            raise CrawlFailure("invalid_transport_policy")
        super().__init__(host, protected, session, **kwargs)

    def json(self, path):
        url = _api_url(path)
        denied_code = ("homework_access_denied" if urlsplit(url).path.startswith("/api/activities/")
                       else "access_denied")
        self._wait()
        self.request_count += 1
        request = Request(url, headers={
            "User-Agent": "PigeonPal/0.2 (local read-only homework fetcher)",
            "Accept": "application/json", "X-Requested-With": "XMLHttpRequest",
        }, method="GET")
        try:
            try:
                response = self.opener.open(request, timeout=30)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                if status in {301, 302, 303, 307, 308}:
                    # Session setup owns CAS. Never forward cookies or replay a
                    # JSON request to a login page or an arbitrary destination.
                    target = urlsplit(urljoin(url, response.headers.get("Location", "")))
                    identity_login = target.hostname == "identity.zju.edu.cn" and target.path in {
                        "/auth/realms/zju/protocol/cas/login", "/auth/realms/zju/broker/cas-client/login",
                    }
                    if identity_login or target.hostname == "zjuam.zju.edu.cn" or (target.hostname == HOST and target.path in {"/login", "/user/login"}):
                        raise CrawlFailure("auth_required")
                    raise CrawlFailure("unsafe_api_redirect")
                if status == 401:
                    raise CrawlFailure("auth_required", 3600)
                if status == 403:
                    # A denied assignment does not prove that the whole site
                    # session expired, regardless of the error page's MIME type.
                    raise CrawlFailure(denied_code, 3600)
                if status in {429, 503}:
                    raise CrawlFailure("rate_limited" if status == 429 else "service_unavailable",
                                       retry_after_seconds(response.headers.get("Retry-After"), self.wall_time()))
                if status == 404:
                    raise CrawlFailure("not_found", 86400)
                if status != 200:
                    raise CrawlFailure("http_error")
                content_type = response.headers.get_content_type()
                if content_type in {"text/html", "application/xhtml+xml"}:
                    raise CrawlFailure("auth_required")
                if content_type != "application/json" and not content_type.endswith("+json"):
                    raise CrawlFailure("unexpected_content_type")
                data = response.read(MAX_JSON_BYTES + 1)
                if len(data) > MAX_JSON_BYTES:
                    raise CrawlFailure("page_too_large")
                result = _json_object(data)
                if type(result.get("code")) is int:
                    if result["code"] == 401:
                        raise CrawlFailure("auth_required")
                    if result["code"] == 403:
                        raise CrawlFailure(denied_code, 3600)
                return result
        except (URLError, TimeoutError, OSError):
            raise CrawlFailure("network_error") from None
        except ValueError:
            raise CrawlFailure("unsafe_api_redirect") from None
        finally:
            self.last_finished = self.clock()


def _page(data, key, page):
    if not isinstance(data, dict) or not isinstance(data.get(key), list):
        raise CrawlFailure("invalid_homework_response")
    rows = data[key]
    if len(rows) > PAGE_SIZE or not all(isinstance(row, dict) for row in rows):
        raise CrawlFailure("invalid_homework_response")
    pages = data.get("pages")
    if pages is not None:
        if type(pages) is not int or not 0 <= pages <= MAX_PAGE:
            raise CrawlFailure("invalid_homework_response")
        more = bool(rows) and page < pages
    elif type(data.get("total")) is int and data["total"] >= 0:
        more = bool(rows) and page * PAGE_SIZE < data["total"]
    else:
        more = len(rows) == PAGE_SIZE
    if more and page >= MAX_PAGE:
        raise CrawlFailure("homework_collection_limit")
    return rows, more


def _item(activity, *, course=None, previous=None, todo=False):
    previous = previous if isinstance(previous, dict) else {}
    old = previous.get("homework", {})
    course = course if isinstance(course, dict) else {}
    activity_id = _id(activity.get("id", activity.get("activity_id")))
    if activity_id is None:
        raise CrawlFailure("invalid_homework_metadata")
    title = _text(activity.get("title")) or _text(previous.get("title"))
    if not title:
        raise CrawlFailure("invalid_homework_metadata")
    nested_course = activity.get("course")
    nested_course = nested_course if isinstance(nested_course, dict) else {}
    course_id = (_id(activity.get("course_id")) or _id(nested_course.get("id"))
                 or _id(course.get("id")) or _id(old.get("courseId")) or "")
    homework = {
        "activityId": activity_id, "courseId": course_id,
        "courseName": (_text(activity.get("course_name"), 300) or _text(nested_course.get("name"), 300)
                       or _text(course.get("name"), 300) or _text(old.get("courseName"), 300)),
        "courseCode": (_text(activity.get("course_code"), 100) or _text(nested_course.get("course_code"), 100)
                       or _text(course.get("courseCode"), 100) or _text(old.get("courseCode"), 100)),
        "openAt": old.get("openAt"), "deadlineAt": old.get("deadlineAt"),
        "submissionStatus": old.get("submissionStatus", "unknown"), "isClosed": old.get("isClosed"),
    }
    for output, fields in (("openAt", ("start_time", "open_time")),
                           ("deadlineAt", ("end_time", "deadline"))):
        for field in fields:
            if field in activity:
                homework[output] = _timestamp(activity[field])
                break
    if type(activity.get("submitted")) is bool:
        homework["submissionStatus"] = "submitted" if activity["submitted"] else "not_submitted"
    elif todo:
        homework["submissionStatus"] = "not_submitted"
    if type(activity.get("is_closed")) is bool:
        homework["isClosed"] = activity["is_closed"]
    return {"id": f"xzzd:{activity_id}", "title": title, "url": homework_url(course_id, activity_id),
            "publishedAt": "", "homework": normalize_homework(homework)}


def clean_checkpoint(value):
    """Return a bounded checkpoint made solely of safe, whitelisted metadata."""
    result = {"version": 1, "coursesFetchedAt": None, "coursePage": 1,
              "courseRefreshIds": [], "courses": [], "courseCursor": 0,
              "homeworkPages": {}, "items": {}}
    if not isinstance(value, dict) or value.get("version") != 1:
        return result
    fetched = value.get("coursesFetchedAt")
    if type(fetched) in {int, float} and math.isfinite(fetched) and fetched >= 0:
        result["coursesFetchedAt"] = fetched
    for key, maximum in (("coursePage", MAX_PAGE), ("courseCursor", MAX_COURSES - 1)):
        number = value.get(key)
        if type(number) is int and 0 <= number <= maximum:
            result[key] = number
    courses = value.get("courses", [])
    if isinstance(courses, list):
        seen = set()
        for course in courses[:MAX_COURSES]:
            if not isinstance(course, dict) or not _id(course.get("id")) or course["id"] in seen:
                continue
            seen.add(course["id"])
            result["courses"].append({"id": str(course["id"]), "name": _text(course.get("name"), 300),
                                      "courseCode": _text(course.get("courseCode"), 100)})
    refresh_ids = value.get("courseRefreshIds", [])
    if isinstance(refresh_ids, list):
        result["courseRefreshIds"] = list(dict.fromkeys(str(identifier) for identifier in refresh_ids[:MAX_COURSES] if _id(identifier)))
    pages = value.get("homeworkPages", {})
    if isinstance(pages, dict):
        result["homeworkPages"] = {key: page for key, page in list(pages.items())[:MAX_COURSES]
                                   if _id(key) and type(page) is int and 1 <= page <= MAX_PAGE}
    items = value.get("items", {})
    if isinstance(items, dict):
        for activity_id, item in list(items.items())[:MAX_ITEMS]:
            if not _id(activity_id) or not isinstance(item, dict):
                continue
            homework = item.get("homework")
            if not isinstance(homework, dict) or _id(homework.get("activityId")) != activity_id or not _text(item.get("title")):
                continue
            # Reconstruct instead of copying unknown properties such as scores,
            # submission files, or a server-provided ticket-bearing URL.
            status = homework.get("submissionStatus")
            safe = {"activityId": activity_id, "courseId": _id(homework.get("courseId")) or "",
                    "courseName": _text(homework.get("courseName"), 300), "courseCode": _text(homework.get("courseCode"), 100),
                    "openAt": _timestamp(homework.get("openAt")), "deadlineAt": _timestamp(homework.get("deadlineAt")),
                    "submissionStatus": status if isinstance(status, str) and status in {"submitted", "not_submitted", "unknown"} else "unknown",
                    "isClosed": homework.get("isClosed") if type(homework.get("isClosed")) is bool else None}
            result["items"][activity_id] = {"id": f"xzzd:{activity_id}", "title": _text(item["title"]),
                                             "url": homework_url(safe["courseId"], activity_id),
                                             "publishedAt": "", "homework": safe}
    return result


class XzzdCollector:
    """Poll todos and rotate bounded current-course pages across five-minute runs."""

    def __init__(self, client, checkpoint=None, now=None):
        self.client = client
        self.checkpoint = clean_checkpoint(checkpoint)
        self.clock = now if callable(now) else (time.time if now is None else lambda: now)

    def collect(self):
        checkpoint = copy.deepcopy(self.checkpoint)
        now = self.clock()
        if type(now) not in {int, float} or not math.isfinite(now) or now < 0:
            raise CrawlFailure("invalid_collection_time")
        checkpoint["courses"] = [course for course in checkpoint["courses"]
                                  if course_is_current(course.get("courseCode"), now) is not False]
        checkpoint["items"] = {key: item for key, item in checkpoint["items"].items()
                               if course_is_current(item.get("homework", {}).get("courseCode"), now) is not False}
        items = checkpoint["items"]
        response = self.client.json("/api/todos?no-intercept=true")
        todos = response.get("todo_list", response.get("todoList"))
        if not isinstance(todos, list) or len(todos) > MAX_ITEMS or not all(isinstance(row, dict) for row in todos):
            raise CrawlFailure("invalid_homework_response")
        count = 0
        for todo in todos:
            if todo.get("type") != "homework":
                continue
            activity_id = _id(todo.get("id", todo.get("activity_id")))
            item = _item(todo, previous=items.get(activity_id), todo=True)
            if course_is_current(item["homework"].get("courseCode"), now) is False:
                continue
            items[activity_id] = item
            count += 1
        requests = 1
        if checkpoint["coursePage"] == 0 and (checkpoint["coursesFetchedAt"] is None or now - checkpoint["coursesFetchedAt"] >= COURSE_REFRESH):
            checkpoint["coursePage"], checkpoint["courseRefreshIds"] = 1, []
        course_pages = 0
        if checkpoint["coursePage"]:
            page = checkpoint["coursePage"]
            query = urlencode({"conditions": json.dumps({"status": ["ongoing", "notStarted"], "keyword": ""}, separators=(",", ":")),
                               "page": page, "page_size": PAGE_SIZE})
            response = self.client.json("/api/my-courses?" + query)
            requests += 1
            course_pages += 1
            rows, more = _page(response, "courses", page)
            courses = {course["id"]: course for course in checkpoint["courses"]}
            refresh = set(checkpoint["courseRefreshIds"])
            for row in rows:
                # The request excludes ended courses; also reject an explicit
                # ended status should a server ignore the filter.
                if row.get("status") == "ended" or course_is_current(row.get("course_code"), now) is False:
                    continue
                course_id = _id(row.get("id"))
                if course_id is None:
                    raise CrawlFailure("invalid_homework_metadata")
                courses[course_id] = {"id": course_id, "name": _text(row.get("name"), 300),
                                      "courseCode": _text(row.get("course_code"), 100)}
                refresh.add(course_id)
            if len(courses) > MAX_COURSES:
                raise CrawlFailure("homework_collection_limit")
            checkpoint["courseRefreshIds"] = sorted(refresh, key=int)
            if more:
                checkpoint["coursePage"] += 1
            else:
                courses = {key: course for key, course in courses.items() if key in refresh}
                checkpoint["coursePage"] = 0
                checkpoint["coursesFetchedAt"] = now
                checkpoint["courseRefreshIds"] = []
            checkpoint["courses"] = list(courses.values())
            checkpoint["homeworkPages"] = {key: page for key, page in checkpoint["homeworkPages"].items() if key in courses}
        homework_pages = 0
        visited = set()
        courses = checkpoint["courses"]
        for _ in range(2):
            if not courses:
                break
            index = checkpoint["courseCursor"] % len(courses)
            course = courses[index]
            course_id = course["id"]
            page = checkpoint["homeworkPages"].get(course_id, 1)
            if (course_id, page) in visited:
                break
            visited.add((course_id, page))
            response = self.client.json(f"/api/courses/{course_id}/homework-activities?page={page}&page_size={PAGE_SIZE}")
            requests += 1
            homework_pages += 1
            rows, more = _page(response, "homework_activities", page)
            for activity in rows:
                if activity.get("type") not in {None, "homework"}:
                    continue
                activity_id = _id(activity.get("id", activity.get("activity_id")))
                item = _item(activity, course=course, previous=items.get(activity_id))
                items[activity_id] = item
            if more:
                checkpoint["homeworkPages"][course_id] = page + 1
                checkpoint["courseCursor"] = index
            else:
                checkpoint["homeworkPages"][course_id] = 1
                checkpoint["courseCursor"] = (index + 1) % len(courses)
        if len(items) > MAX_ITEMS:
            raise CrawlFailure("homework_collection_limit")
        # A todo may not carry course_id. Enrich it only from an unambiguous
        # current-course match, never by guessing from an arbitrary course.
        for item in items.values():
            homework = item["homework"]
            if not homework["courseId"]:
                candidates = [course for course in courses
                              if (homework["courseCode"] and course["courseCode"] == homework["courseCode"])
                              or (not homework["courseCode"] and homework["courseName"] and course["name"] == homework["courseName"])]
                if len(candidates) == 1:
                    homework["courseId"] = candidates[0]["id"]
                    item["url"] = homework_url(homework["courseId"], homework["activityId"])
        self.checkpoint = checkpoint
        return {"items": list(copy.deepcopy(items).values()), "checkpoint": copy.deepcopy(checkpoint),
                "requests": requests, "todoItems": count, "coursePages": course_pages,
                "homeworkPages": homework_pages, "courses": len(courses)}

    def detail(self, job):
        homework = job.get("homework", {})
        activity_id = _id(homework.get("activityId")) if isinstance(homework, dict) else None
        if not activity_id or job.get("id") != f"xzzd:{activity_id}":
            raise CrawlFailure("invalid_homework_metadata")
        response = self.client.json(f"/api/activities/{activity_id}")
        activity = response.get("activity", response)
        if not isinstance(activity, dict) or activity.get("type") not in {None, "homework"}:
            raise CrawlFailure("unexpected_activity_type")
        if "id" in activity and _id(activity["id"]) != activity_id:
            raise CrawlFailure("invalid_homework_metadata")
        activity = {**activity, "id": activity_id}
        item = _item(activity, previous=job)
        data = activity.get("data")
        data = data if isinstance(data, dict) else {}
        description = activity.get("description")
        if not isinstance(description, str):
            description = data.get("description")
        description = description if isinstance(description, str) else ""
        root = _tree(description)
        content = _body_text(root)
        attachments, images, flags = _description_links(root)
        for collection in (activity.get("uploads"), data.get("uploads"), activity.get("attachments"), data.get("attachments")):
            if not isinstance(collection, list):
                continue
            for attachment in collection[:100]:
                if not isinstance(attachment, dict):
                    continue
                url = attachment.get("download_url") or attachment.get("url")
                if not _safe_link(url):
                    if url:
                        flags.add("attachment_link_redacted")
                    continue
                if url not in {row["url"] for row in attachments}:
                    attachments.append({"name": _text(attachment.get("name") or attachment.get("file_name")), "url": url})
        if not content:
            flags.add("homework_description_missing")
        return {"title": item["title"], "content": content, "publishedAt": "", "publisher": "",
                "attachments": attachments, "images": images, "qualityFlags": sorted(flags),
                "homework": item["homework"], "url": item["url"]}


def _safe_link(url):
    if not isinstance(url, str) or any(char.isspace() or ord(char) < 32 for char in url):
        return False
    try:
        parts = urlsplit(url)
        return bool(parts.scheme in {"http", "https"} and parts.hostname
                    and parts.port in {None, 80 if parts.scheme == "http" else 443}
                    and not parts.username and not parts.password and not parts.fragment
                    and not has_sensitive_query(url) and ";" not in parts.path)
    except ValueError:
        return False


def _description_links(root):
    attachments, images, flags = [], [], set()
    for node in _walk(root):
        raw = node.attrs.get("href") if node.tag == "a" else node.attrs.get("src") if node.tag == "img" else None
        if not raw:
            continue
        url = urljoin(ORIGIN + "/", raw)
        if not _safe_link(url):
            flags.add("image_link_redacted" if node.tag == "img" else "attachment_link_redacted")
            continue
        if node.tag == "img":
            if url not in images:
                images.append(url)
        elif any(urlsplit(url).path.lower().endswith(suffix) for suffix in _ATTACHMENT_SUFFIXES) or "/uploads/" in urlsplit(url).path:
            if url not in {row["url"] for row in attachments}:
                attachments.append({"name": _text(_body_text(node)), "url": url})
    return attachments, images, flags
