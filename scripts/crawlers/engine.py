"""Incremental notice collection and a non-overlapping local scheduler."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import time
from typing import Callable

from itc_html import AuthenticationRequired, list_diagnostics as itc_list_diagnostics

from .auth import AuthProvider, AuthSession, NoAuthProvider
from .http import CrawlFailure, SlowClient
from .sources import SOURCES, Source, clean_detail, clean_list
from .storage import NoticeStore


INTERVAL = 300.0
RECHECK_AFTER = 86400.0


def epoch(value: str | None) -> float:
    try:
        # Python 3.10 requires +00:00 rather than the ISO UTC suffix Z.
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


@dataclass
class Runtime:
    source: Source
    next_due: float = 0.0
    state: str = "idle"
    failures: int = 0
    session: AuthSession | None = None
    client: SlowClient | None = None


class CrawlEngine:
    def __init__(
        self, store: NoticeStore, source_ids: list[str], detail_limit: int = 3,
        *, auth: AuthProvider | None = None, report: Callable[[str], None] = print,
        wall_time=time.time, sleep=time.sleep, client_factory=SlowClient,
    ):
        if not 0 <= detail_limit <= 3:
            raise ValueError("invalid_detail_limit")
        self.store = store
        self.auth = auth or NoAuthProvider()
        self.detail_limit = detail_limit
        self.report = report
        self.clock = wall_time
        self.sleep = sleep
        self.client_factory = client_factory
        status = store.status()
        saved = {row["id"]: row for row in status["sources"]}
        self.runtimes = {}
        for source_id in source_ids:
            row = saved.get(source_id, {})
            failures = 0
            for run in reversed(status["recentRuns"]):
                if run["sourceId"] != source_id:
                    continue
                if run["state"] != "backoff":
                    break
                failures += 1
            self.runtimes[source_id] = Runtime(
                SOURCES[source_id], epoch(row.get("nextDueAt")), row.get("state", "idle"), failures,
            )

    def _client(self, runtime: Runtime, session: AuthSession | None):
        if runtime.client is None or runtime.session is not session:
            previous = runtime.client
            runtime.client = self.client_factory(
                runtime.source.host, runtime.source.requires_auth, session,
            )
            if previous is not None:
                runtime.client.last_finished = previous.last_finished
            if session is not None and session.last_request_monotonic is not None:
                runtime.client.last_finished = max(
                    runtime.client.last_finished or 0, session.last_request_monotonic,
                )
            runtime.session = session
        return runtime.client

    def _delay(self, runtime: Runtime, failure: CrawlFailure) -> float:
        runtime.failures += 1
        delay = min(86400.0, INTERVAL * (2 ** min(runtime.failures - 1, 9)))
        if failure.code in {"list_parse_failed", "article_parse_failed", "empty_notice_list"}:
            delay = max(delay, 3600.0)
        return max(delay, failure.retry_after or 0)

    def run_source(self, runtime: Runtime) -> dict:
        source = runtime.source
        started = self.clock()
        try:
            session = self.auth.session_for(source.id) if source.requires_auth else None
        except Exception:
            runtime.state = "auth_required"
            runtime.next_due = started + INTERVAL
            self.store.set_source_status(source.id, "auth_required", started,
                                         last_error="auth_provider_error")
            self.report(f"{source.id}: auth_provider_error (no network request)")
            return {"state": "auth_required", "requests": 0}
        if source.requires_auth and session is None:
            runtime.next_due = started + INTERVAL
            if runtime.state != "auth_required":
                self.store.set_source_status(source.id, "auth_required", started,
                                             last_error="auth_required")
                self.report(f"{source.id}: auth_required (no network request)")
            runtime.state = "auth_required"
            return {"state": "auth_required", "requests": 0}

        client = self._client(runtime, session)
        request_start = client.request_count
        counts = {"listItems": 0, "new": 0, "metadataChanged": 0,
                  "detailsFetched": 0, "bodyChanged": 0, "detailsFailed": 0, "requests": 0}
        state, error, delay = "ready", None, INTERVAL
        self.store.set_source_status(source.id, "running", started)
        try:
            self._check_session(runtime, session)
            html, final_url = client.html(source.url)
            self._check_session(runtime, session)
            try:
                items = clean_list(source, source.parse_list(html, final_url))
            except AuthenticationRequired:
                raise CrawlFailure("auth_required") from None
            except ValueError:
                if source.id == "itc":
                    counts.update(itc_list_diagnostics(html))
                raise CrawlFailure("list_parse_failed") from None
            synced = self.store.sync_list(source.id, items, self.clock())
            counts.update(listItems=len(items), new=synced["new"], metadataChanged=synced["changed"])
            jobs = self.store.detail_jobs(source.id, self.clock(), limit=self.detail_limit,
                                         recheck_after=RECHECK_AFTER, recheck_limit=1)
            for job in jobs:
                try:
                    self._check_session(runtime, session)
                    html, final_url = client.html(job["url"])
                    self._check_session(runtime, session)
                    try:
                        detail = clean_detail(source.parse_article(html, final_url))
                    except AuthenticationRequired:
                        raise CrawlFailure("auth_required") from None
                    except ValueError:
                        raise CrawlFailure("article_parse_failed") from None
                    changed = self.store.save_detail(source.id, job["id"], detail, final_url, self.clock())
                    counts["detailsFetched"] += 1
                    counts["bodyChanged"] += int(changed)
                except CrawlFailure as failure:
                    counts["detailsFailed"] += 1
                    per_item_delay = max(3600.0, failure.retry_after or 0)
                    self.store.fail_detail(source.id, job["id"], failure.code, self.clock(),
                                           retry_after=per_item_delay)
                    # A gone article or broken body must not block other pending
                    # articles. Network/access/limit errors stop the whole round.
                    if failure.code not in {
                        "not_found", "article_parse_failed", "empty_article_body", "invalid_article_date",
                    }:
                        raise
            state = "partial" if counts["detailsFailed"] else "ready"
            runtime.failures = 0
        except CrawlFailure as failure:
            error = failure.code
            if error in {"auth_required", "auth_session_changed"}:
                state = "auth_required"
                if error == "auth_required":
                    self._drop_session(runtime)
                else:
                    runtime.client, runtime.session = None, None
            else:
                state = "backoff"
                delay = self._delay(runtime, failure)
        except KeyboardInterrupt:
            state, error = "interrupted", "interrupted"
            raise
        finally:
            finished = self.clock()
            counts["requests"] = client.request_count - request_start
            # Normal runs stay on the 5-minute cadence. Overruns do not spawn a
            # catch-up run, and failures wait from the end of the failed round.
            runtime.next_due = (
                finished + delay if state == "backoff" or finished >= started + INTERVAL
                else started + INTERVAL
            )
            runtime.state = state
            self.store.set_source_status(source.id, state, finished, last_error=error,
                                         next_due=None if state == "auth_required" else runtime.next_due)
            self.store.record_run(source.id, started, finished, state, counts, error=error)
            self.report(
                f"{source.id}: {state}; list={counts['listItems']} new={counts['new']} "
                f"details={counts['detailsFetched']} failed={counts['detailsFailed']} "
                f"requests={counts['requests']}" + (f" error={error}" if error else "")
            )
        return {"state": state, **counts}

    def run_once(self) -> list[dict]:
        results = []
        for runtime in self.runtimes.values():
            if self.clock() < runtime.next_due:
                self.report(f"{runtime.source.id}: not_due (no network request)")
                results.append({"state": "not_due", "requests": 0})
            else:
                results.append(self.run_source(runtime))
        return results

    def run_forever(self):
        self.report("Local crawler running; interval=300s; stop with Ctrl+C.")
        while True:
            self.run_once_due()
            nearest = min(runtime.next_due for runtime in self.runtimes.values())
            self.sleep(min(30.0, max(1.0, nearest - self.clock())))

    def run_once_due(self):
        # Do not print a log line on every scheduler wake-up.
        for runtime in self.runtimes.values():
            if self.clock() >= runtime.next_due:
                self.run_source(runtime)

    def _drop_session(self, runtime: Runtime):
        try:
            current = self.auth.session_for(runtime.source.id)
            if current is None or current is runtime.session:
                self.auth.invalidate(runtime.source.id)
        except Exception:
            self.report(f"{runtime.source.id}: auth_cleanup_error")
        finally:
            runtime.client = None
            runtime.session = None

    def _check_session(self, runtime: Runtime, expected):
        if runtime.source.requires_auth and self.auth.session_for(runtime.source.id) is not expected:
            raise CrawlFailure("auth_session_changed")

    def close(self):
        for runtime in self.runtimes.values():
            if runtime.source.requires_auth:
                self._drop_session(runtime)
            else:
                runtime.client = None
