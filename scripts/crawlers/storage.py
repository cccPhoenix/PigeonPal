"""Portable JSON notice storage. Public timestamps are ISO 8601 in UTC.

The scheduler owns the single-writer lock. Construction and read methods never
write files; a valid backup can be read without replacing a damaged main file.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from datetime import datetime, timezone
from urllib.parse import parse_qsl, unquote, urlsplit


class StorageError(RuntimeError):
    """A fixed error code suitable for a local status log."""


_TIMES = (
    "firstSeenAt", "lastSeenAt", "lastFetchedAt", "lastChangedAt",
    "nextAttemptAt", "lastRunAt", "lastUpdatedAt", "nextDueAt",
    "startedAt", "finishedAt",
)
_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
_SECRET_QUERY_KEYS = {
    "ticket", "token", "access_token", "id_token", "refresh_token",
    "authorization", "password", "passwd", "username", "session",
    "sessionid", "jsessionid", "auth", "authcode", "code", "signature",
}
_SECRET_FRAGMENT = re.compile(r"(?:^|[?&#;/])(?:" + "|".join(sorted(_SECRET_QUERY_KEYS)) + r")=", re.I)


def _code(value, fallback="unspecified_error"):
    if value is None:
        return None
    return value if isinstance(value, str) and _CODE.fullmatch(value) else fallback


def _time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise StorageError("invalid_timestamp")
    try:
        datetime.fromtimestamp(value, timezone.utc)
    except (ValueError, OverflowError, OSError):
        raise StorageError("invalid_timestamp") from None
    return float(value)


def _iso(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _url(value):
    if not isinstance(value, str):
        raise StorageError("invalid_notice_url")
    try:
        parsed = urlsplit(value)
        sensitive = any(key.lower() in _SECRET_QUERY_KEYS for key, _ in parse_qsl(parsed.query, keep_blank_values=True))
        sensitive = sensitive or ";jsessionid=" in unquote(parsed.path).lower()
        sensitive = sensitive or bool(_SECRET_FRAGMENT.search(unquote(parsed.fragment)))
        if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or sensitive:
            raise StorageError("invalid_notice_url")
    except ValueError:
        raise StorageError("invalid_notice_url") from None
    return value


def _hash(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _reject_json_constant(_value):
    raise ValueError("invalid_json_constant")


def _key(source_id, notice_id):
    return json.dumps([source_id, notice_id], ensure_ascii=False, separators=(",", ":"))


def _flags(row, extra=()):
    flags = {flag for flag in extra if isinstance(flag, str) and _CODE.fullmatch(flag)}
    flags.difference_update({"pending_body", "body_failed", "body_not_fetched", "has_attachments", "publication_date_missing"})
    if not row.get("publishedAt"):
        flags.add("publication_date_missing")
    if row["state"] == "skipped":
        flags.add("body_not_fetched")
    elif row["state"] == "pending" or not row.get("content"):
        flags.add("pending_body")
    if row["state"] == "failed":
        flags.add("body_failed")
        if row.get("lastError") in {"image_only_article", "attachment_only_article"}:
            flags.add("image_only" if row["lastError"] == "image_only_article" else "attachment_only")
    if row.get("attachments"):
        flags.add("has_attachments")
    return sorted(flags)


def _atomic_replace(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _validate(state):
    if not isinstance(state, dict) or type(state.get("schemaVersion")) is not int or state.get("schemaVersion") != 1:
        raise StorageError("unsupported_state_schema")
    if not isinstance(state.get("sources"), dict) or not isinstance(state.get("notices"), dict) or not isinstance(state.get("runs"), list):
        raise StorageError("invalid_state_file")
    try:
        for source_id, source in state["sources"].items():
            if not isinstance(source_id, str) or not _CODE.fullmatch(source_id) or not isinstance(source, dict) or source.get("id") != source_id:
                raise ValueError
            for field in ("state", "lastError"):
                if source[field] is not None and (not isinstance(source[field], str) or not _CODE.fullmatch(source[field])):
                    raise ValueError
            for field in ("lastRunAt", "lastUpdatedAt", "nextDueAt"):
                if source[field] is not None:
                    _time(source[field])
        for key, row in state["notices"].items():
            if not isinstance(row, dict) or key != _key(row["sourceId"], row["id"]):
                raise ValueError
            if not isinstance(row["sourceId"], str) or not isinstance(row["id"], str) or not row["id"]:
                raise ValueError
            if row["sourceId"] not in state["sources"] or row["state"] not in {"pending", "complete", "failed", "skipped"}:
                raise ValueError
            if not isinstance(row["listMetadata"], dict) or not isinstance(row["listHash"], str):
                raise ValueError
            for field in ("title", "url", "publishedAt"):
                if not isinstance(row["listMetadata"][field], str):
                    raise ValueError
            if type(row["listMetadata"].get("fetchable", True)) is not bool:
                raise ValueError
            list_flags = row["listMetadata"].get("qualityFlags", [])
            if not isinstance(list_flags, list) or not all(isinstance(flag, str) and _CODE.fullmatch(flag) for flag in list_flags):
                raise ValueError
            if row["state"] == "skipped" and row["listMetadata"].get("fetchable", True):
                raise ValueError
            _url(row["listMetadata"]["url"])
            for field in ("title", "url", "publishedAt", "publisher", "content"):
                if not isinstance(row[field], str):
                    raise ValueError
            _url(row["url"])
            if not isinstance(row["attachments"], list) or not isinstance(row["qualityFlags"], list) or not all(isinstance(flag, str) and _CODE.fullmatch(flag) for flag in row["qualityFlags"]):
                raise ValueError
            for attachment in row["attachments"]:
                if not isinstance(attachment, dict) or not isinstance(attachment.get("url"), str) or not isinstance(attachment.get("name"), str):
                    raise ValueError
                _url(attachment["url"])
            if not isinstance(row["images"], list) or not all(isinstance(url, str) for url in row["images"]):
                raise ValueError
            for url in row["images"]:
                _url(url)
            if type(row["version"]) is not int or row["version"] < 0 or type(row["failureCount"]) is not int or row["failureCount"] < 0:
                raise ValueError
            if type(row["isLatest"]) is not bool or (row["contentHash"] is not None and not isinstance(row["contentHash"], str)):
                raise ValueError
            if row["lastError"] is not None and (not isinstance(row["lastError"], str) or not _CODE.fullmatch(row["lastError"])):
                raise ValueError
            for field in ("firstSeenAt", "lastSeenAt", "lastFetchedAt", "lastChangedAt", "nextAttemptAt"):
                if row[field] is not None:
                    _time(row[field])
        for run in state["runs"]:
            if not isinstance(run, dict) or not isinstance(run.get("summary"), dict) or run.get("sourceId") not in state["sources"]:
                raise ValueError
            for field in ("state", "error"):
                if run[field] is not None and (not isinstance(run[field], str) or not _CODE.fullmatch(run[field])):
                    raise ValueError
            for key, value in run["summary"].items():
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key):
                    raise ValueError
                if value is not None and not isinstance(value, bool) and (not isinstance(value, (int, float)) or not math.isfinite(value)):
                    raise ValueError
            _time(run["startedAt"])
            _time(run["finishedAt"])
    except (KeyError, ValueError, TypeError, StorageError):
        raise StorageError("invalid_state_file") from None
    return state


class NoticeStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.backup_path = self.path.with_name(self.path.name + ".bak")
        self.recovered_from_backup = False
        self._last_valid_bytes = None
        self._closed = False
        main, main_bytes, main_error = self._read(self.path)
        if main is not None:
            self._state, self._last_valid_bytes = main, main_bytes
            return
        backup, backup_bytes, backup_error = self._read(self.backup_path)
        if backup is not None:
            self._state, self._last_valid_bytes = backup, backup_bytes
            self.recovered_from_backup = True
            return
        if main_error != "missing" or backup_error != "missing":
            raise StorageError(main_error if main_error != "missing" else backup_error)
        self._state = {"schemaVersion": 1, "timestampUnit": "unix-seconds-utc", "sources": {}, "notices": {}, "runs": []}

    @staticmethod
    def _read(path):
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return None, None, "missing"
        except OSError:
            return None, None, "state_read_failed"
        try:
            state = _validate(json.loads(data.decode("utf-8"), parse_constant=_reject_json_constant))
            return state, data, None
        except (UnicodeError, ValueError):
            return None, None, "invalid_state_file"
        except StorageError as error:
            return None, None, str(error)

    def close(self):
        self._closed = True

    def _commit(self, change):
        if self._closed:
            raise StorageError("store_closed")
        state = copy.deepcopy(self._state)
        result = change(state)
        data = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Use the last validated snapshot, never blindly copy a damaged file.
            _atomic_replace(self.backup_path, self._last_valid_bytes or data)
            _atomic_replace(self.path, data)
        except OSError:
            raise StorageError("state_write_failed") from None
        self._state, self._last_valid_bytes = state, data
        self.recovered_from_backup = False
        return result

    @staticmethod
    def _source(state, source_id):
        if not isinstance(source_id, str) or not _CODE.fullmatch(source_id):
            raise StorageError("invalid_source_id")
        return state["sources"].setdefault(source_id, {
            "id": source_id, "state": "ready", "lastRunAt": None,
            "lastUpdatedAt": None, "nextDueAt": None, "lastError": None,
        })

    def sync_list(self, source_id: str, items: list[dict], now: float) -> dict:
        now = _time(now)
        unique = {}
        for item in items:
            notice_id = item.get("id")
            if not isinstance(notice_id, str) or not notice_id or not _text(item.get("title")):
                raise StorageError("invalid_notice_metadata")
            metadata = {"title": _text(item["title"]), "url": _url(item.get("url")), "publishedAt": _text(item.get("publishedAt"))}
            if type(item.get("fetchable", True)) is not bool:
                raise StorageError("invalid_notice_metadata")
            if item.get("fetchable") is False:
                metadata["fetchable"] = False
            if "qualityFlags" in item:
                flags = item["qualityFlags"]
                if not isinstance(flags, list) or not all(isinstance(flag, str) and _CODE.fullmatch(flag) for flag in flags):
                    raise StorageError("invalid_notice_metadata")
                if flags:
                    metadata["qualityFlags"] = sorted(set(flags))
            unique.setdefault(notice_id, metadata)

        def change(state):
            self._source(state, source_id)["lastUpdatedAt"] = now
            for row in state["notices"].values():
                if row["sourceId"] == source_id:
                    row["isLatest"] = False
            new, changed = 0, 0
            for notice_id, metadata in unique.items():
                key = _key(source_id, notice_id)
                row = state["notices"].get(key)
                list_hash = _hash(metadata)
                fetchable = metadata.get("fetchable", True)
                if row is None:
                    row = {
                        "id": notice_id, "sourceId": source_id, **metadata,
                        "publisher": "", "content": "", "attachments": [], "images": [],
                        "qualityFlags": metadata.get("qualityFlags", []), "state": "pending" if fetchable else "skipped",
                        "listMetadata": metadata, "listHash": list_hash,
                        "firstSeenAt": now, "lastSeenAt": now, "lastFetchedAt": None,
                        "lastChangedAt": now, "nextAttemptAt": now if fetchable else None,
                        "contentHash": None, "version": 0, "failureCount": 0,
                        "lastError": None, "isLatest": True,
                    }
                    row["qualityFlags"] = _flags(row, row["qualityFlags"])
                    state["notices"][key] = row
                    new += 1
                elif row["listHash"] != list_hash:
                    old_list_flags = set(row["listMetadata"].get("qualityFlags", []))
                    flags = set(row["qualityFlags"]) - old_list_flags
                    flags.update(metadata.get("qualityFlags", []))
                    row.update(metadata)
                    row.pop("fetchable", None)
                    row.update(listMetadata=metadata, listHash=list_hash, state="pending" if fetchable else "skipped", nextAttemptAt=now if fetchable else None, lastChangedAt=now, failureCount=0, lastError=None)
                    row["qualityFlags"] = _flags(row, flags)
                    changed += 1
                row["isLatest"], row["lastSeenAt"] = True, now
            return {"new": new, "changed": changed, "total": len(unique)}

        return self._commit(change)

    def detail_jobs(self, source_id: str, now: float, limit: int = 3, recheck_after: float = 86400, recheck_limit: int = 1) -> list[dict]:
        now = _time(now)
        rows = [row for row in self._state["notices"].values() if row["sourceId"] == source_id and row["listMetadata"].get("fetchable", True)]
        due = [row for row in rows if row["state"] in {"pending", "failed"} and (row["nextAttemptAt"] or 0) <= now]
        due.sort(key=lambda row: (row["state"] == "pending", row["listMetadata"]["publishedAt"], row["firstSeenAt"]), reverse=True)
        limit = max(0, int(limit))
        selected = due[:limit]
        if len(selected) < limit and recheck_limit > 0:
            rechecks = [row for row in rows if row["state"] == "complete" and row["isLatest"] and row["lastFetchedAt"] is not None and row["lastFetchedAt"] <= now - recheck_after]
            rechecks.sort(key=lambda row: row["lastFetchedAt"])
            selected.extend(rechecks[:min(limit - len(selected), int(recheck_limit))])
        result = []
        for row in selected:
            item = self._export(row)
            # Fetch the current listing URL, while exported notices keep the
            # resolved detail URL from their last successful fetch.
            item.update(row["listMetadata"])
            result.append(item)
        return result

    def save_detail(self, source_id: str, notice_id: str, detail: dict, final_url: str, now: float) -> bool:
        now = _time(now)
        row = self._state["notices"].get(_key(source_id, notice_id))
        if row is None:
            raise StorageError("notice_not_found")
        if not row["listMetadata"].get("fetchable", True):
            raise StorageError("notice_not_fetchable")
        content = str(detail.get("content") or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        if not content:
            self.fail_detail(source_id, notice_id, "empty_body", now)
            return False
        attachments = []
        seen = set()
        for attachment in detail.get("attachments") or []:
            value = {"name": _text(attachment.get("name")), "url": _url(attachment.get("url"))}
            signature = (value["name"], value["url"])
            if signature not in seen:
                attachments.append(value)
                seen.add(signature)
        snapshot = {
            "title": _text(detail.get("title")) or row["listMetadata"]["title"],
            "publishedAt": _text(detail.get("publishedAt")) or row["listMetadata"]["publishedAt"],
            "publisher": _text(detail.get("publisher")), "content": content,
            "attachments": attachments,
        }
        images = [_url(url) for url in detail.get("images") or []]
        content_hash = _hash({**snapshot, "images": images})
        final_url = _url(final_url)
        extra_flags = detail.get("qualityFlags") or []

        def change(state):
            current = state["notices"][_key(source_id, notice_id)]
            changed = current["contentHash"] != content_hash
            current.update(snapshot)
            current.update(url=final_url, images=images, state="complete", lastFetchedAt=now, nextAttemptAt=None, lastError=None, failureCount=0)
            current["qualityFlags"] = _flags(current, extra_flags)
            if changed:
                current.update(contentHash=content_hash, version=current["version"] + 1, lastChangedAt=now)
            return changed

        return self._commit(change)

    def fail_detail(self, source_id, notice_id, code, now, retry_after=3600):
        now = _time(now)
        retry_after = max(1, _time(retry_after))

        def change(state):
            row = state["notices"].get(_key(source_id, notice_id))
            if row is None:
                raise StorageError("notice_not_found")
            row["failureCount"] += 1
            delay = min(86400, retry_after * 2 ** min(row["failureCount"] - 1, 20))
            row.update(state="failed", lastError=_code(code), nextAttemptAt=now + delay)
            row["qualityFlags"] = _flags(row, row["qualityFlags"])

        self._commit(change)

    def set_source_status(self, source_id, state, now, last_error=None, next_due=None):
        now = _time(now)
        next_due = None if next_due is None else _time(next_due)

        def change(data):
            source = self._source(data, source_id)
            source.update(state=_code(state, "unknown") or "unknown", lastUpdatedAt=now, lastError=_code(last_error), nextDueAt=next_due)

        self._commit(change)

    def record_run(self, source_id, started_at, finished_at, state, summary: dict, error=None):
        started_at, finished_at = _time(started_at), _time(finished_at)
        safe_summary = {key: value for key, value in summary.items() if isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key) and (value is None or isinstance(value, bool) or isinstance(value, (int, float)) and math.isfinite(value))}

        def change(data):
            source = self._source(data, source_id)
            source["lastRunAt"] = finished_at
            data["runs"].append({"sourceId": source_id, "startedAt": started_at, "finishedAt": finished_at, "state": _code(state, "unknown") or "unknown", "summary": safe_summary, "error": _code(error)})
            data["runs"] = data["runs"][-200:]

        self._commit(change)

    @staticmethod
    def _export(row):
        result = {key: copy.deepcopy(value) for key, value in row.items() if key not in {"listMetadata", "listHash"}}
        if "listMetadata" in row and not row["listMetadata"].get("fetchable", True):
            result["fetchable"] = False
        for field in _TIMES:
            if field in result:
                result[field] = _iso(result[field])
        return result

    def status(self) -> dict:
        sources = []
        for source_id, source in sorted(self._state["sources"].items()):
            rows = [row for row in self._state["notices"].values() if row["sourceId"] == source_id]
            sources.append({**self._export(source), "totalCount": len(rows), "latestCount": sum(row["isLatest"] for row in rows), "pendingCount": sum(row["state"] == "pending" for row in rows), "failedCount": sum(row["state"] == "failed" for row in rows), "completeCount": sum(row["state"] == "complete" for row in rows), "skippedCount": sum(row["state"] == "skipped" for row in rows)})
        return {"schemaVersion": 1, "timestampFormat": "ISO-8601 UTC", "recoveredFromBackup": self.recovered_from_backup, "sources": sources, "totalItems": len(self._state["notices"]), "recentRuns": [self._export(run) for run in self._state["runs"][-20:]]}

    def export_items(self, source_id=None) -> list[dict]:
        rows = [row for row in self._state["notices"].values() if source_id is None or row["sourceId"] == source_id]
        rows.sort(key=lambda row: (row["publishedAt"], row["firstSeenAt"], row["id"]), reverse=True)
        return [self._export(row) for row in rows]

    def get_notice(self, notice_id) -> dict | None:
        matches = [row for row in self._state["notices"].values() if row["id"] == notice_id]
        if len(matches) > 1:
            raise StorageError("ambiguous_notice_id")
        return self._export(matches[0]) if matches else None
