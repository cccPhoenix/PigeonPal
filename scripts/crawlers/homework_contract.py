"""Minimal local homework metadata; no grades, submissions or identity fields."""

from datetime import date, datetime
import re
from urllib.parse import urlsplit


FIELDS = {"activityId", "courseId", "courseName", "courseCode", "openAt", "deadlineAt", "submissionStatus", "isClosed"}


def normalize_homework(value):
    if not isinstance(value, dict) or set(value) - FIELDS:
        raise ValueError("invalid_homework_metadata")
    result = {}
    for key in ("activityId", "courseId"):
        item = value.get(key, "")
        if isinstance(item, bool) or not isinstance(item, (int, str)):
            raise ValueError("invalid_homework_metadata")
        item = str(item)
        if not re.fullmatch(r"[0-9]{1,24}", item) and not (key == "courseId" and item == ""):
            raise ValueError("invalid_homework_metadata")
        result[key] = item
    for key, limit in (("courseName", 300), ("courseCode", 100)):
        item = value.get(key, "")
        if not isinstance(item, str) or len(item) > limit:
            raise ValueError("invalid_homework_metadata")
        result[key] = " ".join(item.split())
    for key in ("openAt", "deadlineAt"):
        item = value.get(key)
        if item is not None:
            if not isinstance(item, str) or len(item) > 40:
                raise ValueError("invalid_homework_metadata")
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", item):
                date.fromisoformat(item)
            else:
                stamp = datetime.fromisoformat(item.replace("Z", "+00:00"))
                if stamp.tzinfo is None:
                    raise ValueError("invalid_homework_metadata")
        result[key] = item
    status = value.get("submissionStatus", "unknown")
    if status not in {"unknown", "submitted", "not_submitted"}:
        raise ValueError("invalid_homework_metadata")
    result["submissionStatus"] = status
    closed = value.get("isClosed")
    if closed is not None and type(closed) is not bool:
        raise ValueError("invalid_homework_metadata")
    result["isClosed"] = closed
    return result


def homework_url(value):
    if not isinstance(value, str) or any(char.isspace() or ord(char) < 32 for char in value):
        raise ValueError("invalid_homework_url")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname != "courses.zju.edu.cn"
            or parsed.username is not None or parsed.password is not None
            or parsed.port not in {None, 443} or parsed.query):
        raise ValueError("invalid_homework_url")
    if parsed.path == "/" and not parsed.fragment:
        return value
    if not re.fullmatch(r"/course/[0-9]+/learning-activity(?:/full-screen)?", parsed.path):
        raise ValueError("invalid_homework_url")
    if not re.fullmatch(r"/[0-9]+", parsed.fragment):
        raise ValueError("invalid_homework_url")
    return value
