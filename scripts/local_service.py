"""Loopback-only UI/API and crawler host; private values never enter logs."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from urllib.parse import urlsplit

from crawlers.engine import CrawlEngine
from crawlers.http import CrawlFailure, SlowClient
from crawlers.sources import SOURCES
from crawlers.storage import NoticeStore, StorageError
from local_auth.manager import AuthActionError, AuthManager
from local_auth.site_sessions import SiteSessionError, SiteSessionProvider
from local_auth.vault import CredentialVault
from pigeonpal_crawler import default_data_dir, single_writer

ROOT = Path(__file__).resolve().parent.parent
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
        self.engine = CrawlEngine(self.store, list(SOURCES), auth=self.site_auth, sleep=self._sleep,
                                  client_factory=lambda host, protected, session: SlowClient(
                                      host, protected, session, sleep=self._sleep),
                                  report=lambda message: print(message, flush=True))
        self.worker_error = None
        self.thread = None
        if start_worker:
            self.thread = threading.Thread(target=self._work, name="pigeonpal-crawler", daemon=True)
            self.thread.start()

    def _sleep(self, seconds):
        if self.stop.wait(seconds):
            raise KeyboardInterrupt

    def _work(self):
        previous_session = None
        try:
            while not self.stop.is_set():
                self.auth.tick()
                session = self.auth.campus_session()
                if session is not None and session is not previous_session:
                    for runtime in self.engine.runtimes.values():
                        if runtime.source.requires_auth:
                            runtime.next_due = time.time()
                previous_session = session
                self._run_due_sources()
                self.stop.wait(2)
        except KeyboardInterrupt:
            pass
        except Exception:
            self.worker_error = "crawler_worker_error"
            print("crawler: crawler_worker_error", file=sys.stderr, flush=True)

    def _run_due_sources(self):
        for runtime in self.engine.runtimes.values():
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
                "id": source.id, "title": "云峰通知" if source.id == "yunfeng" else "信息技术中心",
                "url": source.url, "requiresAuth": source.requires_auth, "state": state,
                "totalCount": saved.get("totalCount", 0), "completeCount": saved.get("completeCount", 0),
                "pendingCount": saved.get("pendingCount", 0), "lastCheckedAt": saved.get("lastRunAt"),
                "lastError": self.worker_error or saved.get("lastError"),
                "nextCheckAt": saved.get("nextDueAt"), "everySeconds": 300,
            })
        return {"sources": sources}

    def close(self):
        self.stop.set()
        self.auth.close()
        if self.thread is not None:
            self.thread.join(timeout=35)
        self.engine.close()
        self.site_auth.close()
        self.store.close()


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        print("local_service: request_error", file=sys.stderr, flush=True)


def handler_for(backend):
    class Handler(SimpleHTTPRequestHandler):
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
                path = urlsplit(self.path).path
                if path == "/api/bootstrap":
                    if self._allowed(token=False):
                        self._json(200, {"csrfToken": backend.token})
                elif path.startswith("/api/"):
                    if not self._allowed():
                        return
                    if path == "/api/auth/status":
                        self._json(200, backend.auth.status())
                    elif path == "/api/sources":
                        self._json(200, backend.source_status())
                    else:
                        self._json(404, {"error": "not_found"})
                elif self._allowed(token=False):
                    super().do_GET()
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
                if not 0 < length <= MAX_BODY:
                    self._json(413, {"error": "invalid_body_size"})
                    return
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(body, dict):
                        raise ValueError
                except (UnicodeError, ValueError):
                    self._json(400, {"error": "invalid_input"})
                    return
                path = urlsplit(self.path).path
                if path == "/api/auth/login":
                    result = backend.auth.start_login(body.get("username"), body.get("password"), body.get("requestId"))
                    body.clear()
                    self._json(202, result)
                elif path == "/api/auth/confirm":
                    self._json(200, backend.auth.confirm(body.get("requestId")))
                elif path == "/api/auth/cancel":
                    self._json(200, backend.auth.cancel(body.get("requestId")))
                elif path == "/api/auth/unbind":
                    self._json(200, backend.auth.unbind())
                else:
                    self._json(404, {"error": "not_found"})
            except AuthActionError as error:
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
