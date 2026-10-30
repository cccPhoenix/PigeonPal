"""Offline homework API boundaries, pagination and privacy regression checks."""

from email.message import Message
from http.client import IncompleteRead
from http.cookiejar import CookieJar
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from crawlers.homework_contract import normalize_homework
from crawlers.http import CrawlFailure, SlowClient
from crawlers.xzzd import (
    COURSE_REFRESH, MAX_JSON_BYTES, XzzdClient, XzzdCollector, clean_checkpoint,
)


def courses_path(page=1, statuses=None):
    return "/api/my-courses?" + urlencode({
        "conditions": json.dumps({"status": statuses or ["ongoing", "notStarted"], "keyword": ""}),
        "page": page, "page_size": 50,
    })


class Response:
    def __init__(self, data=None, *, status=200, kind="application/json", location=None, retry=None, raw=None):
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = kind
        if location is not None:
            self.headers["Location"] = location
        if retry is not None:
            self.headers["Retry-After"] = retry
        self.body = json.dumps(data or {}).encode("utf-8") if raw is None else raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return self.body[:limit]


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return self.responses.pop(0)


class TransportTests(unittest.TestCase):
    def test_truncated_response_is_a_retryable_network_failure(self):
        class Truncated(Response):
            def read(self, limit):
                raise IncompleteRead(b"private-homework", 10)
        client, _ = self.client([Truncated()])
        with self.assertRaises(CrawlFailure) as raised:
            client.json("/api/todos?no-intercept=true")
        self.assertEqual(str(raised.exception), "network_error")
        self.assertIsNotNone(client.last_finished)


    def client(self, responses):
        self.time = 100
        self.waits = []
        opener = Opener(responses)

        def sleep(delay):
            self.waits.append(delay)
            self.time += delay

        client = XzzdClient(session=AuthSession(CookieJar()), opener=opener,
                            monotonic=lambda: self.time, sleep=sleep,
                            choose_delay=lambda low, high: low, wall_time=lambda: 1000)
        return client, opener

    def test_allowlisted_gets_use_existing_pacing(self):
        paths = ["/api/todos?no-intercept=true", courses_path(),
                 "/api/courses/12/homework-activities?page=2&page_size=50", "/api/activities/34"]
        client, opener = self.client([Response() for _ in paths])
        for path in paths:
            self.assertEqual(client.json(path), {})
        self.assertIsInstance(client, SlowClient)
        self.assertEqual(client.request_count, 4)
        self.assertEqual(self.waits, [15, 15, 15])
        for request in opener.requests:
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(urlsplit(request.full_url).netloc, "courses.zju.edu.cn")
            self.assertEqual(request.get_header("X-requested-with"), "XMLHttpRequest")

    def test_refuses_other_hosts_missing_session_and_mutating_routes(self):
        for kwargs in ({}, {"session": AuthSession(CookieJar()), "host": "itc.zju.edu.cn"},
                       {"session": AuthSession(CookieJar()), "protected": False},
                       {"session": AuthSession(CookieJar()), "allow_http": True}):
            with self.assertRaisesRegex(CrawlFailure, "invalid_transport_policy"):
                XzzdClient(**kwargs)
        client, opener = self.client([])
        for path in (
            "https://courses.zju.edu.cn/api/activities/1", "//evil.example/api/activities/1",
            "/api/uploads", "/api/submissions/1/retract", "/api/course/activities/1/submissions",
            "/api/activities/1/students/2/submission_list", "/api/activities/1?ticket=SECRET",
            "/api/todos?no-intercept=true&token=SECRET", "/api/todos?no-intercept=true&no-intercept=true",
            "/api/activities/1#token=SECRET", "/api/courses/12/homework-activities?page=0&page_size=50",
            "/api/courses/12/homework-activities?page=1&page_size=500", courses_path(statuses=["ended"]),
        ):
            with self.subTest(path=path):
                with self.assertRaisesRegex(CrawlFailure, "invalid_homework_api_url") as caught:
                    client.json(path)
                self.assertNotIn("SECRET", str(caught.exception))
        self.assertEqual(opener.requests, [])

    def test_session_expiry_and_rate_limit_never_follow_redirect(self):
        cases = [
            (Response(status=302, location="https://zjuam.zju.edu.cn/cas/login?ticket=SECRET"), "auth_required"),
            (Response(status=302, location="https://identity.zju.edu.cn/auth/realms/zju/protocol/cas/login?service=SECRET"), "auth_required"),
            (Response(status=302, location="https://identity.zju.edu.cn/auth/realms/zju/broker/cas-client/login"), "auth_required"),
            (Response(status=302, location="https://identity.zju.edu.cn/other?token=SECRET"), "unsafe_api_redirect"),
            (Response(status=302, location="/login"), "auth_required"),
            (Response(status=302, location="https://evil.example/?token=SECRET"), "unsafe_api_redirect"),
            (Response(kind="text/html", raw=b"<html>password SECRET</html>"), "auth_required"),
            (Response(status=401), "auth_required"), (Response(status=403), "access_denied"),
            (Response(status=429, retry="1200"), "rate_limited"),
            (Response(status=503, retry="1200"), "service_unavailable"),
        ]
        for response, error in cases:
            with self.subTest(error=error):
                client, opener = self.client([response])
                with self.assertRaisesRegex(CrawlFailure, error) as caught:
                    client.json("/api/todos?no-intercept=true")
                self.assertNotIn("SECRET", str(caught.exception))
                self.assertEqual(len(opener.requests), 1)
                if error in {"rate_limited", "service_unavailable"}:
                    self.assertEqual(caught.exception.retry_after, 1200)

    def test_forbidden_responses_distinguish_assignment_permission_from_login(self):
        paths = [("/api/activities/1", "homework_access_denied"),
                 ("/api/todos?no-intercept=true", "access_denied"),
                 (courses_path(), "access_denied"),
                 ("/api/courses/1/homework-activities?page=1&page_size=50", "access_denied")]
        for path, expected in paths:
            for response in (Response(status=403), Response(status=403, kind="text/html"),
                             Response(status=403, kind="application/octet-stream"),
                             Response(data={"code": 403})):
                with self.subTest(path=path, status=response.status, kind=response.headers["Content-Type"]):
                    client, opener = self.client([response])
                    with self.assertRaises(CrawlFailure) as caught:
                        client.json(path)
                    self.assertEqual(caught.exception.code, expected)
                    self.assertEqual(caught.exception.retry_after, 3600)
                    self.assertEqual(len(opener.requests), 1)

    def test_unauthorized_json_and_login_html_still_require_authentication(self):
        for path in ("/api/activities/1", "/api/todos?no-intercept=true"):
            for response in (Response(status=401), Response(data={"code": 401}),
                             Response(kind="text/html", raw=b"<html>login</html>")):
                with self.subTest(path=path, status=response.status):
                    client, _ = self.client([response])
                    with self.assertRaises(CrawlFailure) as caught:
                        client.json(path)
                    self.assertEqual(caught.exception.code, "auth_required")

    def test_json_is_bounded_and_strict(self):
        for raw, code in ((b'{"x":1,"x":2}', "invalid_api_json"),
                          (b'{"x":NaN}', "invalid_api_json"), (b'[]', "invalid_api_json"),
                          (b'bad SECRET', "invalid_api_json"),
                          (b'x' * (MAX_JSON_BYTES + 1), "page_too_large")):
            client, _ = self.client([Response(raw=raw)])
            with self.assertRaisesRegex(CrawlFailure, code) as caught:
                client.json("/api/activities/1")
            self.assertNotIn("SECRET", str(caught.exception))


class FakeAPI:
    def __init__(self, responses):
        self.responses = list(responses)
        self.paths = []

    def json(self, path):
        self.paths.append(path)
        if not self.responses:
            raise AssertionError("unexpected API request")
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def course(identity, name="测试课程", **extra):
    return {"id": identity, "name": name, "course_code": f"C{identity}", **extra}


def assignment(identity, **extra):
    return {"id": identity, "title": f"第 {identity} 次作业", "type": "homework", **extra}


class CollectorTests(unittest.TestCase):
    def test_empty_courses_and_todos_are_success(self):
        api = FakeAPI([{"todo_list": []}, {"courses": [], "pages": 0}])
        result = XzzdCollector(api, now=1000).collect()
        self.assertEqual(result["items"], [])
        self.assertEqual(result["requests"], 2)
        self.assertEqual(result["checkpoint"]["coursesFetchedAt"], 1000)
        self.assertEqual(result["checkpoint"]["coursePage"], 0)

    def test_only_homework_is_saved_and_fields_are_minimal(self):
        api = FakeAPI([
            {"todo_list": [assignment(10, course_name="数学", course_code="C1", end_time="2026-10-20T15:59:59Z"),
                           {"id": 90, "title": "测验", "type": "exam"},
                           {"id": 91, "title": "问卷", "type": "questionnaire"}]},
            {"courses": [course(1, "数学")], "pages": 1},
            {"homework_activities": [assignment(10, submitted=False, is_closed=False,
                                               score=100, submissions=[{"answer": "SECRET"}]),
                                      assignment(11, submitted=True),
                                      {"id": 92, "title": "考试", "type": "exam"}], "pages": 1},
        ])
        result = XzzdCollector(api, now=1000).collect()
        self.assertEqual(result["requests"], 3)
        self.assertEqual(result["todoItems"], 1)
        self.assertEqual({row["id"] for row in result["items"]}, {"xzzd:10", "xzzd:11"})
        self.assertEqual(result["items"][0]["url"], "https://courses.zju.edu.cn/course/1/learning-activity#/10")
        self.assertEqual(result["items"][0]["homework"]["courseId"], "1")
        self.assertEqual(result["items"][0]["homework"]["deadlineAt"], "2026-10-20T15:59:59Z")
        self.assertEqual(result["items"][1]["homework"]["submissionStatus"], "submitted")
        saved = json.dumps(result["checkpoint"])
        self.assertNotIn("score", saved)
        self.assertNotIn("submissions", saved)
        self.assertNotIn("SECRET", saved)
        for item in result["items"]:
            self.assertEqual(item["homework"], normalize_homework(item["homework"]))
        conditions = json.loads(parse_qs(urlsplit(api.paths[1]).query)["conditions"][0])
        self.assertEqual(conditions["status"], ["ongoing", "notStarted"])

    def test_rotation_and_pagination_resume_across_runs_without_losing_old_items(self):
        first = FakeAPI([
            {"todo_list": []}, {"courses": [course(1), course(2), course(3)], "pages": 1},
            {"homework_activities": [assignment(10, submitted=True)], "pages": 2},
            {"homework_activities": [assignment(11, submitted=False)], "pages": 2},
        ])
        one = XzzdCollector(first, now=1000).collect()
        self.assertEqual(one["requests"], 4)
        self.assertIn("page=2", first.paths[-1])
        self.assertEqual(one["checkpoint"]["courseCursor"], 1)
        second = FakeAPI([
            {"todo_list": []},
            {"homework_activities": [assignment(20)], "pages": 1},
            {"homework_activities": [assignment(30)], "pages": 1},
        ])
        two = XzzdCollector(second, one["checkpoint"], now=1300).collect()
        self.assertEqual(two["requests"], 3)
        self.assertFalse(any("my-courses" in path for path in second.paths))
        self.assertIn("/courses/2/", second.paths[1])
        self.assertIn("/courses/3/", second.paths[2])
        self.assertEqual({row["id"] for row in two["items"]}, {"xzzd:10", "xzzd:11", "xzzd:20", "xzzd:30"})
        self.assertEqual(two["checkpoint"]["items"]["11"]["homework"]["submissionStatus"], "not_submitted")

    def test_todos_disappearance_is_not_inferred_to_mean_submitted(self):
        initial = FakeAPI([
            {"todo_list": [assignment(10)]}, {"courses": [], "pages": 0},
        ])
        one = XzzdCollector(initial, now=1000).collect()
        following = FakeAPI([{"todoList": []}])
        two = XzzdCollector(following, one["checkpoint"], now=1300).collect()
        self.assertEqual(two["items"][0]["homework"]["submissionStatus"], "not_submitted")
        self.assertEqual(two["items"][0]["homework"]["courseId"], "")
        self.assertEqual(two["items"][0]["url"], "https://courses.zju.edu.cn/")

    def test_course_catalog_refreshes_after_six_hours_and_continues_next_page(self):
        first = FakeAPI([
            {"todo_list": []}, {"courses": [course(1)], "pages": 2},
            {"homework_activities": [], "pages": 1},
        ])
        one = XzzdCollector(first, now=1000).collect()
        self.assertEqual(one["checkpoint"]["coursePage"], 2)
        second = FakeAPI([
            {"todo_list": []}, {"courses": [course(2), course(3, status="ended")], "pages": 2},
            {"homework_activities": [], "pages": 1}, {"homework_activities": [], "pages": 1},
        ])
        two = XzzdCollector(second, one["checkpoint"], now=1300).collect()
        self.assertEqual(parse_qs(urlsplit(second.paths[1]).query)["page"], ["2"])
        self.assertEqual({row["id"] for row in two["checkpoint"]["courses"]}, {"1", "2"})
        self.assertEqual(two["checkpoint"]["coursesFetchedAt"], 1300)
        refresh = FakeAPI([{"todo_list": []}, {"courses": [], "pages": 0}])
        three = XzzdCollector(refresh, two["checkpoint"], now=1300 + COURSE_REFRESH).collect()
        self.assertEqual(three["requests"], 2)
        self.assertEqual(three["checkpoint"]["courses"], [])

    def test_api_failure_does_not_advance_checkpoint(self):
        checkpoint = clean_checkpoint(None)
        api = FakeAPI([{"todo_list": []}, CrawlFailure("rate_limited", 900)])
        collector = XzzdCollector(api, checkpoint, now=1000)
        with self.assertRaisesRegex(CrawlFailure, "rate_limited"):
            collector.collect()
        self.assertEqual(collector.checkpoint, checkpoint)

    def test_detail_extracts_description_and_links_without_grades_or_submission_files(self):
        api = FakeAPI([
            {"todo_list": [assignment(10, course_id=1)]}, {"courses": [], "pages": 0},
            assignment(10, course_id=1, submitted=True, is_closed=False,
                       data={"description": '<p>完成第一章练习。</p><script>SECRET</script><a href="/files/teacher.pdf">题目</a><a href="/files/file.pdf?token=SECRET">私有链接</a>'},
                       submissions=[{"uploads": [{"name": "我的答案", "url": "https://courses.zju.edu.cn/answer.pdf"}]}], score=100),
        ])
        collector = XzzdCollector(api, now=1000)
        job = collector.collect()["items"][0]
        detail = collector.detail(job)
        self.assertIn("完成第一章练习", detail["content"])
        self.assertNotIn("SECRET", detail["content"])
        self.assertEqual(detail["attachments"], [{"name": "题目", "url": "https://courses.zju.edu.cn/files/teacher.pdf"}])
        self.assertEqual(detail["homework"]["submissionStatus"], "submitted")
        self.assertNotIn("score", detail)
        self.assertNotIn("submissions", detail)
        self.assertEqual(api.paths[-1], "/api/activities/10")
        self.assertEqual(len(api.paths), 3)

    def test_missing_description_stays_empty_without_fabricated_body(self):
        api = FakeAPI([assignment(10)])
        job = {"id": "xzzd:10", "title": "作业", "homework": {"activityId": "10", "courseId": "1"}}
        detail = XzzdCollector(api).detail(job)
        self.assertEqual(detail["content"], "")
        self.assertIn("homework_description_missing", detail["qualityFlags"])
        self.assertEqual(detail["homework"]["submissionStatus"], "unknown")

    def test_checkpoint_reconstruction_drops_credential_and_grade_fields(self):
        checkpoint = clean_checkpoint(None)
        checkpoint.update(token="SECRET", raw_response={"cookie": "SECRET"})
        checkpoint["items"] = {"10": {"title": "任务", "url": "https://evil.example/?ticket=SECRET",
                                      "homework": {"activityId": "10", "courseId": "1", "score": 100},
                                      "submission": {"answer": "SECRET"}}}
        result = clean_checkpoint(checkpoint)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("score", json.dumps(result))
        self.assertEqual(result["items"]["10"]["url"], "https://courses.zju.edu.cn/course/1/learning-activity#/10")


if __name__ == "__main__":
    unittest.main()
