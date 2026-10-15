"""Atomic processing cache; crawler-state.json keeps its existing schema."""

import copy
import json
import math
from pathlib import Path
import re
import threading

from crawlers.storage import StorageError, _atomic_replace
from .schema import AIError, validate_cached_result


def validate_cache(value):
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("items"), dict):
        raise ValueError
    for key, row in value["items"].items():
        if not isinstance(row, dict) or row.get("noticeId") != key or not isinstance(key, str):
            raise ValueError
        if not isinstance(row.get("sourceId"), str) or not isinstance(row.get("fingerprint"), str):
            raise ValueError
        if row.get("state") not in {"pending", "processing", "ready", "failed"}:
            raise ValueError
        if type(row.get("attemptCount")) is not int or row["attemptCount"] < 0:
            raise ValueError
        retry = row.get("nextRetryAt")
        if retry is not None and (type(retry) not in {int, float} or not math.isfinite(retry)):
            raise ValueError
        error = row.get("error")
        if error is not None and (not isinstance(error, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", error)):
            raise ValueError
        for field in ("provider", "model"):
            if not isinstance(row.get(field), str):
                raise ValueError
        if row.get("processedAt") is not None and not isinstance(row["processedAt"], str):
            raise ValueError
        if row.get("result") is not None:
            row["result"] = validate_cached_result(row["result"])
        if row["state"] == "ready" and row.get("result") is None:
            raise ValueError
    return value


class AnalysisStore:
    def __init__(self, path: Path):
        self.path = path
        self.backup = path.with_name(path.name + ".bak")
        self.lock = threading.RLock()
        self.last_bytes = None
        self.items = {}
        missing = True
        for candidate in (self.path, self.backup):
            try:
                data = candidate.read_bytes()
                missing = False
                def reject_constant(value):
                    raise ValueError
                state = validate_cache(json.loads(data.decode("utf-8"), parse_constant=reject_constant))
                self.items, self.last_bytes = state["items"], data
                return
            except FileNotFoundError:
                continue
            except (OSError, UnicodeError, ValueError, AIError):
                missing = False
        if not missing:
            raise StorageError("ai_state_invalid")

    def get(self, notice_id):
        with self.lock:
            return copy.deepcopy(self.items.get(notice_id))

    def records(self):
        with self.lock:
            return copy.deepcopy(list(self.items.values()))

    def put(self, row):
        with self.lock:
            items = {**self.items, row["noticeId"]: copy.deepcopy(row)}
            state = {"schemaVersion": 1, "items": items}
            try:
                validate_cache(state)
                data = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")
                self.path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_replace(self.backup, self.last_bytes or data)
                _atomic_replace(self.path, data)
            except (OSError, ValueError, AIError):
                raise StorageError("ai_state_write_failed") from None
            self.items, self.last_bytes = items, data
