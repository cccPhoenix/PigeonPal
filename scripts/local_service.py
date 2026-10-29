"""Loopback-only UI/API and crawler host; private values never enter logs."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hmac
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

from crawlers.engine import CrawlEngine
from crawlers.http import CrawlFailure, SlowClient
from crawlers.xzzd import XzzdClient
from crawlers.sources import SOURCES
from crawlers.homework_selection import select_homework, is_current_homework
from crawlers.storage import NoticeStore, StorageError
from local_auth.manager import AuthActionError, AuthManager
from local_auth.site_sessions import SiteSessionError, SiteSessionProvider
from local_auth.vault import CredentialVault
from pigeonpal_crawler import default_data_dir, single_writer
from notice_ai.chat import ChatService
from notice_ai.client import ModelClient
from notice_ai.config import AISettings
from notice_ai.runtime import RuntimeStore
from notice_ai.homework import reconcile_homework
from notice_ai.schema import AIError
from notice_ai.service import NoticeProcessor
from notice_ai.user_profile import UserProfileStore
from notice_ai.recommendation import RecommendationService

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB = ROOT / "web"
MAX_BODY = 8192


def default_auth_dir():
    return Path.home() / ".pigeonpal" / "auth"


def credential_directory(path: Path):
    resolved = path.expanduser().resolve()
    if resolved.is_relative_to(ROOT):
        raise StorageError("auth_directory_inside_workspace")
    return resolved


class LocalBackend:
    def __init__(self, data_dir: Path, auth_dir: Path, *, auth=None, site_auth=None, start_worker=True):
        self.store = NoticeStore(data_dir / "crawler-state.json")
        self.auth = auth or AuthManager(CredentialVault(auth_dir))
        self.site_auth = site_auth or SiteSessionProvider(
            self.auth, {source.id: source.url for source in SOURCES.values() if source.requires_auth},
        )
        self.token = secrets.token_urlsafe(32)
        self.stop = threading.Event()
        self.ai_settings = AISettings(auth_dir / "ai")
        self.ai_settings_lock = threading.RLock()
        self.runtime = RuntimeStore(data_dir / "runtime-state.json")
        self.user_profile = UserProfileStore(data_dir / "user-profile.json")
        self.recommendations = RecommendationService(self.user_profile, data_dir / "notice-recommendations.json")
        self.ai = NoticeProcessor(self.store, data_dir / "notice-ai.json", self.ai_settings.config,
                                  on_result=self._notice_result, user_profile=self.user_profile,
                                  recommendations=self.recommendations)
        self.runtime.delivery_policy = self._reminder_delivery_policy
        self.chat = ChatService(self.ai, self.runtime, user_profile=self.user_profile,
                                on_profile_changed=self.profile_changed)
        self.engine = CrawlEngine(self.store, list(SOURCES), auth=self.site_auth, sleep=self._sleep,
                                  client_factory=lambda host, protected, session, **options: (XzzdClient if host == "courses.zju.edu.cn" else SlowClient)(
                                      host, protected, session, sleep=self._sleep, **options),
                                  report=lambda message: print(message, flush=True))
        self.worker_error = None
        self.thread = None
        self.reminder_thread = None
        if start_worker:
            self.thread = threading.Thread(target=self._work, name="pigeonpal-crawler", daemon=True)
            self.thread.start()
            self.ai.start()
            self.start_reminders()

    def start_reminders(self):
        if self.reminder_thread is None:
            self.reminder_thread = threading.Thread(target=self._reminders, name="pigeonpal-reminders", daemon=True)
            self.reminder_thread.start()

    def _reminders(self):
        next_reconcile = 0
        failed = False
        while not self.stop.is_set():
            try:
                if time.time() >= next_reconcile:
                    reconcile_homework(self.runtime, self.store.export_items("xzzd"))
                self.runtime.tick(homework_lookup=self.store.get_notice)
                if time.time() >= next_reconcile:
                    self.ai.reconcile_deadlines()
                    next_reconcile = time.time() + 30
                failed = False
            except Exception:
                if not failed:
                    print("reminders: reminder_worker_error", file=sys.stderr, flush=True)
                failed = True
            self.stop.wait(10 if failed else 1)

    def _notice_result(self, notice, result):
        recommendation = self.ai.recommendation(notice)
        if not recommendation["allowPush"]:
            self.runtime.suppress_notice_reminders(notice["id"])
        elif not recommendation.get("deferPush"):
            self.runtime.schedule_deadline(notice, result)

    def _reminder_allowed(self, row):
        return self._reminder_delivery_policy(row) is True

    def _reminder_delivery_policy(self, row):
        if not row.get("automatic") or not row.get("noticeId") or row["noticeId"].startswith("xzzd:"):
            return True
        notice = self.store.get_notice(row["noticeId"])
        if notice is None:
            return True
        recommendation = self.ai.recommendation(notice)
        return "defer" if recommendation.get("deferPush") else recommendation["allowPush"]

    def profile_changed(self):
        self.ai.prefer_recommendations = True
        self.ai.wake.set()
        try:
            self.ai.reconcile_deadlines()
        except (AIError, StorageError):
            self.ai.last_error = "reminder_storage_error"

    def save_user_profile(self, body):
        result = self.user_profile.update(body)
        self.profile_changed()
        return result

    def clear_user_profile(self, body):
        if set(body) - {"expectedVersion"}:
            raise AIError("profile_invalid", 400)
        result = self.user_profile.clear(expected_version=body.get("expectedVersion"))
        self.profile_changed()
        return result

    def override_recommendation(self, body):
        if set(body) != {"noticeId", "decision"} or not isinstance(body["noticeId"], str):
            raise AIError("invalid_input", 400)
        notice = self.store.get_notice(body["noticeId"])
        if notice is None:
            raise AIError("notice_not_found", 404)
        self.recommendations.override(notice["id"], body["decision"])
        self.profile_changed()
        return self.ai.recommendation(notice)

    def reminders(self):
        return {"reminders": [{**row, "notifyEligible": self._reminder_allowed(row)} for row in self.runtime.reminders()]}

    def events(self, after):
        result = self.runtime.events(after)
        reminders = {row["id"]: row for row in self.runtime.reminders()}
        result["events"] = [event for event in result["events"]
                            if self._reminder_allowed(reminders.get(event.get("reminderId"), {}))]
        return result

    def save_ai(self, body):
        return self.change_ai(self.ai_settings.save, body)

    def change_ai(self, mutate, *args):
        with self.ai_settings_lock:
            before = self.ai_settings.config
            result = mutate(*args)
            config = self.ai_settings.config
            # Saving or verifying an inactive profile must not interrupt chat.
            if before != config:
                self.ai.configure(config)
                try:
                    self.ai.reconcile_deadlines()
                except AIError:
                    self.ai.last_error = "reminder_storage_error"
            return result

    def clear_ai(self):
        return self.change_ai(self.ai_settings.clear)

    def check_ai(self, identity=None):
        identity, config = self.ai_settings.check_target(identity)
        try:
            ModelClient(config).check_connection()
        except AIError:
            self.ai_settings.mark_verified(identity, config, success=False)
            raise
        settings = self.ai_settings.mark_verified(identity, config)
        return {"ok": True, "model": config.model, "profileId": identity, "settings": settings}

    def notices(self, source_id=None, limit=100, offset=0):
        if source_id is not None and source_id not in SOURCES:
            raise AIError("invalid_source", 400)
        if not 1 <= limit <= 100 or offset < 0:
            raise AIError("invalid_input", 400)
        rows = self.store.export_items(source_id)
        if source_id == "xzzd":
            rows = select_homework(rows)
        items = []
        for row in rows[offset:offset + limit]:
            items.append({key: row[key] for key in ("id", "sourceId", "title", "url", "publishedAt", "state", "version", "contentHash", "lastChangedAt", "firstSeenAt")})
            items[-1].update(fetchable=row.get("fetchable", True), qualityFlags=row.get("qualityFlags", []))
            if "homework" in row:
                items[-1]["homework"] = row["homework"]
            analysis = self.ai.analysis(row)
            items[-1]["analysis"] = analysis
            recommendation = self.ai.recommendation(row)
            items[-1]["recommendation"] = recommendation
            visible = {key: items[-1][key] for key in ("title", "url", "publishedAt", "state", "fetchable", "qualityFlags")}
            if "homework" in row:
                visible["homework"] = row["homework"]
                visible["homeworkChangedAt"] = row["lastChangedAt"]
            digest = hashlib.sha256(json.dumps({"metadata": visible, "result": analysis.get("result"),
                                               "analysisState": analysis.get("state"), "analysisError": analysis.get("error")},
                                               sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
            personal = hashlib.sha256(json.dumps(recommendation, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]
            items[-1]["revision"] = f"{row['version']}:{row['contentHash']}:{digest}:{personal}"
        return {"items": items, "total": len(rows), "nextOffset": offset + limit if offset + limit < len(rows) else None}

    def notice_detail(self, notice_id):
        row = self.store.get_notice(notice_id)
        if row is None:
            raise AIError("notice_not_found", 404)
        return {**row, "analysis": self.ai.analysis(row), "recommendation": self.ai.recommendation(row)}

    def notification_candidates(self, source_id, offset=0):
        """Complete ingestion identity index, independent of the bounded UI view."""
        if source_id not in SOURCES or offset < 0:
            raise AIError("invalid_input", 400)
        rows = self.store.export_items(source_id)
        items = []
        for row in rows[offset:offset + 100]:
            if source_id == "xzzd":
                eligible = is_current_homework(row, time.time()) and row.get("homework", {}).get("submissionStatus") != "submitted"
                deferred = False
            else:
                recommendation = self.ai.recommendation(row)
                eligible, deferred = recommendation["allowPush"], recommendation.get("deferPush", False)
            items.append({"id": row["id"], "title": row["title"], "notifyEligible": eligible,
                          "deferPush": deferred})
        return {"items": items, "nextOffset": offset + 100 if offset + 100 < len(rows) else None}

    def _sleep(self, seconds):
        if self.stop.wait(seconds):
            raise KeyboardInterrupt

    def _work(self):
        previous_session = None
        while not self.stop.is_set():
            try:
                self.auth.tick()
                session = self.auth.campus_session()
                if session is not None and session is not previous_session:
                    for runtime in self.engine.runtimes.values():
                        if runtime.source.requires_auth:
                            runtime.next_due = time.time()
                previous_session = session
                self._run_due_sources()
                self.worker_error = None
                self.stop.wait(2)
            except KeyboardInterrupt:
                break
            except Exception:
                if self.worker_error != "crawler_worker_error":
                    print("crawler: crawler_worker_error", file=sys.stderr, flush=True)
                self.worker_error = "crawler_worker_error"
                # A temporary storage/session failure must not kill all future
                # collection until the user restarts the application.
                self.stop.wait(30)

    def _run_due_sources(self):
        # A new or newly authenticated homework channel must not wait behind
        # every public site's paced detail fetches. Keep normal/backoff cadence.
        runtimes = sorted(self.engine.runtimes.values(), key=lambda runtime: not (
            runtime.source.kind == "homework" and runtime.state in {"idle", "auth_required"}
        ))
        for runtime in runtimes:
            if self.stop.is_set() or time.time() < runtime.next_due:
                continue
            if runtime.source.requires_auth and self.auth.campus_session() is not None:
                try:
                    self.site_auth.prepare(runtime.source.id, self.stop)
                except SiteSessionError as failure:
                    if self.stop.is_set():
                        return
                    # A target site's availability is not an account-validation
                    # result. Report it on that source, never the auth dialog.
                    started = time.time()
                    delay = self.engine._delay(runtime, CrawlFailure(failure.code, failure.retry_after))
                    runtime.state, runtime.next_due = "backoff", started + delay
                    self.store.set_source_status(runtime.source.id, "backoff", started,
                                                 last_error=failure.code, next_due=runtime.next_due)
                    self.store.record_run(runtime.source.id, started, started, "backoff",
                                          {"sessionSetupFailed": True}, error=failure.code)
                    print(f"{runtime.source.id}: backoff; error={failure.code}", flush=True)
                    continue
            self.engine.run_source(runtime)

    def source_status(self):
        rows = {row["id"]: row for row in self.store.status()["sources"]}
        auth = self.auth.status()
        sources = []
        for source in SOURCES.values():
            saved = rows.get(source.id, {})
            state = saved.get("state", "waiting")
            if source.requires_auth:
                if auth["state"] == "authenticating":
                    state = "authenticating"
                elif self.auth.campus_session() is None:
                    state = "auth_required"
                elif state == "auth_required":
                    state = "waiting"
            sources.append({
                "id": source.id, "title": source.title or source.id,
                "url": source.url, "requiresAuth": source.requires_auth, "state": state,
                "kind": source.kind, "allowAI": source.allow_ai,
                "totalCount": saved.get("totalCount", 0), "completeCount": saved.get("completeCount", 0),
                "pendingCount": saved.get("pendingCount", 0), "lastCheckedAt": saved.get("lastRunAt"),
                "skippedCount": saved.get("skippedCount", 0),
                "lastError": self.worker_error or saved.get("lastError"),
                "nextCheckAt": saved.get("nextDueAt"), "everySeconds": 300,
            })
        return {"sources": sources}

    def close(self):
        self.stop.set()
        self.ai.close()
        self.auth.close()
        if self.thread is not None:
            self.thread.join(timeout=35)
        if self.reminder_thread is not None:
            self.reminder_thread.join(timeout=2)
        self.engine.close()
        self.site_auth.close()
        self.store.close()


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    # The desktop protocol proxy loads the module graph concurrently. The
    # socketserver default backlog of five can reset those local connections.
    request_queue_size = 128

    def handle_error(self, request, client_address):
        print("local_service: request_error", file=sys.stderr, flush=True)


def handler_for(backend):
    class Handler(SimpleHTTPRequestHandler):
        # Concurrent cold module requests otherwise all initialize mimetypes
        # from the Windows registry. Pin core UI types before serving threads.
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                          ".js": "text/javascript", ".mjs": "text/javascript",
                          ".css": "text/css", ".html": "text/html"}

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB), **kwargs)

        def log_message(self, *args):
            pass

        def end_headers(self):
            for key, value in {
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            }.items():
                self.send_header(key, value)
            super().end_headers()

        def _json(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self, *, token=True, post=False):
            hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if self.headers.get("Host") not in hosts:
                self._json(403, {"error": "invalid_host"})
                return False
            origin = self.headers.get("Origin")
            if (post and not origin) or (origin and origin not in {f"http://{host}" for host in hosts}):
                self._json(403, {"error": "invalid_origin"})
                return False
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self._json(403, {"error": "invalid_origin"})
                return False
            if token:
                try:
                    valid_token = hmac.compare_digest(self.headers.get("X-PigeonPal-Token", ""), backend.token)
                except (TypeError, ValueError):
                    valid_token = False
                if not valid_token:
                    self._json(403, {"error": "csrf_invalid"})
                    return False
            return True

        def do_GET(self):
            try:
                address = urlsplit(self.path)
                path, query = address.path, parse_qs(address.query)
                if path == "/api/bootstrap":
                    if self._allowed(token=False):
                        self._json(200, {"csrfToken": backend.token})
                elif path.startswith("/api/"):
                    if not self._allowed():
                        return
                    if path == "/api/auth/status":
                        self._json(200, backend.auth.status())
                    elif path == "/api/user-profile":
                        self._json(200, backend.user_profile.snapshot())
                    elif path == "/api/sources":
                        self._json(200, backend.source_status())
                    elif path == "/api/ai/settings":
                        self._json(200, backend.ai_settings.snapshot())
                    elif path == "/api/ai/status":
                        self._json(200, backend.ai.status())
                    elif path == "/api/notices":
                        try:
                            limit, offset = int(query.get("limit", ["100"])[0]), int(query.get("offset", ["0"])[0])
                        except ValueError:
                            raise AIError("invalid_input", 400) from None
                        self._json(200, backend.notices(query.get("source", [None])[0], limit, offset))
                    elif path == "/api/notices/detail":
                        self._json(200, backend.notice_detail(query.get("noticeId", [""])[0]))
                    elif path == "/api/notification-candidates":
                        try:
                            offset = int(query.get("offset", ["0"])[0])
                        except ValueError:
                            raise AIError("invalid_input", 400) from None
                        self._json(200, backend.notification_candidates(query.get("source", [""])[0], offset))
                    elif path == "/api/reminders":
                        self._json(200, backend.reminders())
                    elif path == "/api/events":
                        try:
                            after = int(query.get("after", ["0"])[0])
                            if after < 0:
                                raise ValueError
                        except ValueError:
                            raise AIError("invalid_input", 400) from None
                        self._json(200, backend.events(after))
                    else:
                        self._json(404, {"error": "not_found"})
                elif self._allowed(token=False):
                    super().do_GET()
            except AIError as error:
                self._json(error.status, {"error": error.code})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self._json(500, {"error": "local_service_error"})

        def do_POST(self):
            if not self._allowed(post=True):
                return
            try:
                if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                    self._json(415, {"error": "invalid_content_type"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                path = urlsplit(self.path).path
                maximum = 262144 if path in {"/api/chat", "/api/reminders/import"} else MAX_BODY
                if not 0 < length <= maximum:
                    self._json(413, {"error": "invalid_body_size"})
                    return
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(body, dict):
                        raise ValueError
                except (UnicodeError, ValueError):
                    self._json(400, {"error": "invalid_input"})
                    return
                if path == "/api/auth/login":
                    result = backend.auth.start_login(body.get("username"), body.get("password"), body.get("requestId"))
                    body.clear()
                    self._json(202, result)
                elif path == "/api/user-profile":
                    result = backend.save_user_profile(body)
                    body.clear()
                    self._json(200, result)
                elif path == "/api/user-profile/reset":
                    self._json(200, backend.clear_user_profile(body))
                elif path == "/api/recommendations/override":
                    self._json(200, backend.override_recommendation(body))
                elif path == "/api/auth/confirm":
                    self._json(200, backend.auth.confirm(body.get("requestId")))
                elif path == "/api/auth/cancel":
                    self._json(200, backend.auth.cancel(body.get("requestId")))
                elif path == "/api/auth/unbind":
                    self._json(200, backend.auth.unbind())
                elif path == "/api/ai/settings":
                    result = backend.save_ai(body)
                    body.clear()
                    self._json(200, result)
                elif path == "/api/ai/clear":
                    self._json(200, backend.clear_ai())
                elif path == "/api/ai/profiles":
                    result = backend.change_ai(backend.ai_settings.add, body)
                    body.clear()
                    self._json(201, result)
                elif path == "/api/ai/profiles/update":
                    result = backend.change_ai(backend.ai_settings.update, body)
                    body.clear()
                    self._json(200, result)
                elif path in {"/api/ai/profiles/select", "/api/ai/profiles/delete"}:
                    if set(body) != {"id"}:
                        raise AIError("invalid_input", 400)
                    mutate = backend.ai_settings.select if path.endswith("/select") else backend.ai_settings.delete
                    self._json(200, backend.change_ai(mutate, body["id"]))
                elif path == "/api/ai/check":
                    if set(body) - {"profileId"}:
                        raise AIError("invalid_input", 400)
                    self._json(200, backend.check_ai(body.get("profileId")))
                elif path == "/api/ai/process":
                    if set(body) - {"noticeId", "force"}:
                        raise AIError("invalid_input", 400)
                    result = backend.ai.submit(body.get("noticeId"), force=body.get("force", False))
                    self._json(200 if result.get("cached") else 202, result)
                elif path == "/api/chat":
                    self._json(200, backend.chat.respond(body))
                elif path == "/api/reminders/create":
                    self._json(201, {"reminder": backend.runtime.create(body.get("title"), body.get("dueAt"),
                               body.get("channelId", "bot"), body.get("noticeId"))})
                elif path == "/api/reminders/update":
                    self._json(200, {"reminder": backend.runtime.update(body.get("id"), body.get("patch"))})
                elif path == "/api/reminders/import":
                    self._json(200, {"reminders": backend.runtime.import_legacy(body.get("reminders"))})
                else:
                    self._json(404, {"error": "not_found"})
            except (AuthActionError, AIError) as error:
                self._json(error.status, {"error": error.code})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self._json(500, {"error": "local_service_error"})

        def do_OPTIONS(self):
            self._json(403, {"error": "cross_origin_not_allowed"})

        def do_HEAD(self):
            if self._allowed(token=False):
                if self.path.startswith("/api/"):
                    self._json(405, {"error": "method_not_allowed"})
                else:
                    super().do_HEAD()

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT") or 4174))
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--auth-dir", type=Path, default=default_auth_dir())
    args = parser.parse_args(argv)
    try:
        data_dir = args.data_dir.expanduser().resolve()
        auth_dir = credential_directory(args.auth_dir)
        with ExitStack() as stack:
            server = LocalServer(("127.0.0.1", args.port), handler_for(None))
            stack.callback(server.server_close)
            stack.enter_context(single_writer(data_dir / "crawler.lock"))
            stack.enter_context(single_writer(auth_dir / "auth.lock"))
            backend = LocalBackend(data_dir, auth_dir)
            server.RequestHandlerClass = handler_for(backend)
            print(f"PigeonPal: http://127.0.0.1:{server.server_port}", flush=True)
            try:
                server.serve_forever()
            finally:
                backend.close()
    except KeyboardInterrupt:
        print("PigeonPal local service stopped.", flush=True)
    except (StorageError, OSError):
        print("PigeonPal: local_start_failed (check port, directory, or another running crawler).", file=sys.stderr)
        return 2
    except Exception:
        print("PigeonPal: local_service_error.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
