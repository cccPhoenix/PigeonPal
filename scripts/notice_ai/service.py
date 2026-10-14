"""A single model worker, restart-safe cache and version-aware local API."""

from collections import deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import threading
import time

from crawlers.sources import SOURCES
from crawlers.storage import StorageError
from .client import ModelClient
from .config import AIConfig
from .schema import AIError, PROMPT_VERSION, prepare_notice, validate_result
from .storage import AnalysisStore


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class NoticeProcessor:
    def __init__(self, notices, path: Path, config: AIConfig, *, client=None, clock=time.time, on_result=None):
        self.notices, self.config = notices, config
        self.client = client or ModelClient(config)
        self.clock = clock
        self.on_result = on_result
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.lock = threading.RLock()
        self.queue = deque()
        self.scheduled = set()
        self.thread = None
        self.last_error = None
        self.retry_at = 0
        self.blocked = False
        self.active = None
        self.generation = 0
        self.storage_error = None
        try:
            self.cache = AnalysisStore(path)
        except StorageError:
            self.cache = None
            self.storage_error = "ai_storage_error"

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._work, name="pigeonpal-notice-ai", daemon=True)
            self.thread.start()

    def configure(self, config):
        with self.lock:
            self.config = config
            self.client = ModelClient(config)
            self.generation += 1
            self.blocked, self.retry_at, self.last_error = False, 0, None
            if config.configured and config.automatic and self.cache is not None:
                try:
                    for record in self.cache.records():
                        if record["state"] == "failed" and record["error"] in {"ai_auth_failed", "ai_request_rejected"}:
                            record.update(state="pending", error=None, nextRetryAt=None, attemptCount=0)
                            self.cache.put(record)
                except StorageError:
                    self.storage_error = "ai_storage_error"
        self.wake.set()

    def reconcile_deadlines(self):
        if (self.stop.is_set() or not self.config.configured or not self.config.automatic_deadlines
                or self.on_result is None or self.storage_error):
            return
        for notice in self.notices.export_items():
            analysis = self.analysis(notice)
            if analysis["state"] == "ready":
                self.on_result(notice, analysis["result"])
        if self.last_error == "reminder_storage_error":
            self.last_error = None

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(timeout=2)

    def _work(self):
        while not self.stop.is_set():
            try:
                worked = self.run_once()
            except Exception:
                # No provider response, key, article or stack trace in logs/status.
                self.last_error = "ai_worker_error"
                worked = False
            if not worked:
                self.wake.wait(5)
                self.wake.clear()

    def _allowed(self, notice):
        source = SOURCES.get(notice.get("sourceId"))
        if source is None:
            raise AIError("invalid_source", 400)
        if source.requires_auth and not self.config.allow_protected:
            raise AIError("protected_source_not_allowed", 403)

    def fingerprint(self, notice):
        value = {"input": prepare_notice(notice), "contentHash": notice.get("contentHash"),
                 "provider": self.config.provider, "model": self.config.model,
                 "endpoint": self.config.base_url, "promptVersion": PROMPT_VERSION}
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()

    def analysis(self, notice):
        try:
            self._allowed(notice)
            fingerprint = self.fingerprint(notice)
        except AIError as error:
            return {"state": "blocked" if error.status == 403 else "waiting_body", "error": error.code, "result": None}
        if self.storage_error:
            return {"state": "failed", "error": self.storage_error, "result": None}
        record = self.cache.get(notice["id"])
        if record and record["fingerprint"] == fingerprint:
            if not self.config.configured and record["state"] != "ready":
                return {"state": "unconfigured", "error": self.config.error, "result": None}
            return {key: record.get(key) for key in ("state", "error", "result", "processedAt", "provider", "model")}
        return {"state": "pending" if self.config.configured else "unconfigured",
                "error": self.config.error, "result": None}

    def status(self):
        counts = {"ready": 0, "pending": 0, "processing": 0, "failed": 0, "blocked": 0, "waiting_body": 0, "unconfigured": 0}
        for notice in self.notices.export_items():
            state = self.analysis(notice)["state"]
            counts[state] += 1
        return {"configured": self.config.configured, "provider": self.config.provider,
                "model": self.config.model or None, "automatic": self.config.automatic,
                "allowProtected": self.config.allow_protected, "counts": counts,
                "error": self.storage_error or self.config.error or self.last_error,
                "retryAt": iso(self.retry_at) if self.retry_at > self.clock() else None}

    def submit(self, notice_id, *, force=False):
        if not isinstance(notice_id, str) or not notice_id or len(notice_id) > 160 or type(force) is not bool:
            raise AIError("invalid_input", 400)
        notice = self.notices.get_notice(notice_id)
        if notice is None:
            raise AIError("notice_not_found", 404)
        self._allowed(notice)
        fingerprint = self.fingerprint(notice)
        if not self.config.configured:
            raise AIError(self.config.error or "ai_not_configured", 503)
        if self.storage_error:
            raise AIError(self.storage_error, 503)
        if self.blocked:
            raise AIError(self.last_error or "ai_processing_error", 503)
        with self.lock:
            record = self.cache.get(notice_id)
            if record and record["fingerprint"] == fingerprint and record["state"] == "ready" and not force:
                return {"noticeId": notice_id, "cached": True, **self.analysis(notice)}
            if notice_id not in self.scheduled:
                if len(self.queue) >= 100:
                    raise AIError("ai_queue_full", 429)
                previous = record if record and record["fingerprint"] == fingerprint else None
                record = self._pending(notice, fingerprint)
                if previous and previous.get("result"):
                    record.update(result=previous["result"], processedAt=previous["processedAt"])
                self.cache.put(record)
                self.queue.append(notice_id)
                self.scheduled.add(notice_id)
        self.wake.set()
        return {"noticeId": notice_id, "cached": False, **self.analysis(notice)}

    def _pending(self, notice, fingerprint):
        return {"noticeId": notice["id"], "sourceId": notice["sourceId"], "fingerprint": fingerprint,
                "provider": self.config.provider, "model": self.config.model, "state": "pending",
                "attemptCount": 0, "nextRetryAt": None, "error": None, "result": None, "processedAt": None}

    def _next(self):
        with self.lock:
            while self.queue:
                notice_id = self.queue.popleft()
                notice = self.notices.get_notice(notice_id)
                if notice is not None:
                    return notice
                self.scheduled.discard(notice_id)
            for notice in self.notices.export_items():
                try:
                    self._allowed(notice)
                    fingerprint = self.fingerprint(notice)
                except AIError:
                    continue
                if notice["id"] in self.scheduled:
                    continue
                record = self.cache.get(notice["id"])
                if not self.config.automatic and not (record and record["fingerprint"] == fingerprint
                        and record["state"] in {"pending", "processing"}):
                    continue
                if record and record["fingerprint"] == fingerprint:
                    if record["state"] == "ready":
                        continue
                    if record["state"] == "failed" and (record["nextRetryAt"] is None or record["nextRetryAt"] > self.clock()):
                        continue
                self.scheduled.add(notice["id"])
                return notice
        return None

    def run_once(self):
        if self.stop.is_set() or not self.config.configured or self.storage_error or self.blocked or self.retry_at > self.clock():
            return False
        notice = self._next()
        if notice is None:
            return False
        notice_id = notice["id"]
        self.active = notice_id
        try:
            with self.lock:
                generation = self.generation
                client = self.client
                self._allowed(notice)
                fingerprint = self.fingerprint(notice)
                record = self.cache.get(notice_id)
                if not record or record["fingerprint"] != fingerprint:
                    record = self._pending(notice, fingerprint)
                record.update(state="processing", error=None, nextRetryAt=None)
                record["attemptCount"] += 1
                self.cache.put(record)
            try:
                result = validate_result(client.analyze(prepare_notice(notice)))
                if notice.get("attachments"):
                    result["notes"] = (["附件正文未读取，摘要仅依据网页正文。"] + result["notes"])[:20]
                with self.lock:
                    current = self.notices.get_notice(notice_id)
                    if self.stop.is_set() or generation != self.generation or current is None or self.fingerprint(current) != fingerprint:
                        return True
                    record.update(state="ready", result=result, processedAt=iso(self.clock()), error=None)
                    self.last_error = None
                    self.cache.put(record)
                    if self.on_result is not None and self.config.automatic_deadlines:
                        try:
                            self.on_result(current, result)
                        except (AIError, StorageError):
                            self.last_error = "reminder_storage_error"
            except AIError as error:
                with self.lock:
                    if self.stop.is_set() or generation != self.generation:
                        return True
                    delay = max(error.retry_after, min(3600, 60 * 2 ** min(record["attemptCount"] - 1, 6)))
                    record.update(state="failed", error=error.code,
                                  nextRetryAt=self.clock() + delay if error.retryable else None)
                    self.last_error = error.code
                    if error.retryable:
                        self.retry_at = record["nextRetryAt"]
                    if error.code in {"ai_auth_failed", "ai_request_rejected"}:
                        self.blocked = True
                    self.cache.put(record)
        except StorageError:
            self.storage_error = "ai_storage_error"
        except AIError:
            # Body may have been replaced or policy may now forbid the source.
            pass
        except Exception:
            # Persist a fixed terminal failure, avoiding an infinite paid loop.
            self.last_error = "ai_processing_error"
            self.blocked = True
        finally:
            with self.lock:
                self.scheduled.discard(notice_id)
            self.active = None
        return True
