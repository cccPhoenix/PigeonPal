"""Offline fake-login tests plus loopback API access-control verification."""

from contextlib import redirect_stdout, redirect_stderr
from http.client import HTTPConnection
from http.cookiejar import CookieJar
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from local_auth.manager import AuthActionError, AuthManager
from local_auth.site_sessions import SiteSessionError
from local_auth.vault import CredentialVault
from local_auth.zjuam import AuthError, LoginResult
from local_service import LocalBackend, LocalServer, handler_for


def result():
    return LoginResult(AuthSession(CookieJar()), time.time())


def await_phase(manager, phase=None, state=None):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = manager.status()
        if (phase is None or snapshot["phase"] == phase) and (state is None or snapshot["state"] == state):
            return snapshot
        threading.Event().wait(.005)
    raise AssertionError("fake auth worker did not reach expected state")


class AuthManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = CredentialVault(Path(self.temp.name) / "auth")
        self.managers = []

    def tearDown(self):
        for manager in self.managers:
            manager.close()
        self.temp.cleanup()

    def manager(self, login=None, **kwargs):
        manager = AuthManager(self.vault, login=login or (lambda *args: result()), **kwargs)
        self.managers.append(manager)
        return manager

    def test_verified_login_commits_only_after_live_ui_confirm(self):
        manager = self.manager()
        manager.start_login("fake-username", "fake-secret-password", "request-0001")
        snapshot = await_phase(manager, "ready_to_bind")
        self.assertFalse(self.vault.exists())
        self.assertFalse(snapshot["bound"])
        self.assertIsNone(manager.campus_session())
        bound = manager.confirm("request-0001")
        self.assertEqual(bound["state"], "authenticated")
        self.assertNotIn("fake-username", json.dumps(bound))
        self.assertNotIn("fake-secret-password", json.dumps(bound))
        self.assertEqual(self.vault.read().username, "fake-username")
        self.assertIsNotNone(manager.campus_session())

    def test_cancel_before_post_and_during_worker_cannot_bind_late(self):
        release = threading.Event()
        entered = threading.Event()
        def login(*args):
            entered.set()
            release.wait(1)
            return result()
        manager = self.manager(login)
        manager.cancel("request-pre-cancel")
        with self.assertRaises(AuthActionError):
            manager.start_login("fake", "fake-pass", "request-pre-cancel")
        manager.start_login("fake", "fake-pass", "request-running")
        self.assertTrue(entered.wait(1))
        manager.cancel("request-running")
        release.set()
        threading.Event().wait(.02)
        self.assertFalse(self.vault.exists())
        self.assertEqual(manager.status()["state"], "unbound")

    def test_cancel_ready_or_confirmation_response_in_transit_rolls_back(self):
        manager = self.manager()
        manager.start_login("fake", "fake-pass", "request-0001")
        await_phase(manager, "ready_to_bind")
        manager.cancel("request-0001")
        self.assertFalse(self.vault.exists())
        manager.start_login("fake", "fake-pass", "request-0002")
        await_phase(manager, "ready_to_bind")
        manager.confirm("request-0002")
        manager.cancel("request-0002")
        self.assertFalse(self.vault.exists())
        self.assertEqual(manager.status()["state"], "unbound")

    def test_existing_binding_is_restored_on_late_cancel_and_unbind_removes_auth_only(self):
        self.vault.save("old-fake-user", "old-fake-pass")
        data_file = Path(self.temp.name) / "notices.json"
        data_file.write_text("{}")
        manager = self.manager()
        manager.start_login("new-fake-user", "new-fake-pass", "request-0001")
        await_phase(manager, "ready_to_bind")
        manager.confirm("request-0001")
        manager.cancel("request-0001")
        self.assertEqual(self.vault.read().username, "old-fake-user")
        manager.unbind()
        self.assertFalse(self.vault.exists())
        self.assertTrue(data_file.exists())
        self.assertIsNone(manager.campus_session())

    def test_restart_automatically_unlocks_but_login_rejection_stops_retries(self):
        self.vault.save("fake", "fake-pass")
        calls = []
        def login(*args):
            calls.append(1)
            raise AuthError("login_rejected")
        now = [1000.0]
        manager = self.manager(login, clock=lambda: now[0])
        manager.tick()
        await_phase(manager, state="error")
        now[0] += 10000
        manager.tick()
        self.assertEqual(len(calls), 1)
        self.assertEqual(manager.status()["error"], "login_rejected")
        restarted = self.manager()
        restarted.tick()
        await_phase(restarted, state="authenticated")
        self.assertTrue(restarted.status()["bound"])

    def test_manual_network_failure_does_not_freeze_old_binding_renewal(self):
        self.vault.save("old-fake-user", "old-fake-pass")
        now = [1000.0]
        calls = []
        def login(*args):
            calls.append(1)
            if len(calls) == 2:
                raise AuthError("network_error")
            return result()
        manager = self.manager(login, clock=lambda: now[0])
        manager.tick()
        await_phase(manager, state="authenticated")
        manager.start_login("new-fake", "new-fake-pass", "request-0001")
        await_phase(manager, state="error")
        self.assertEqual(self.vault.read().username, "old-fake-user")
        now[0] += 301
        manager.tick()
        await_phase(manager, state="authenticated")
        self.assertEqual(len(calls), 3)

    def test_failed_validation_never_creates_binding(self):
        def rejected(*args):
            raise AuthError("invalid_credentials")
        manager = self.manager(rejected)
        manager.start_login("fake-user", "fake-password", "request-rejected")
        snapshot = await_phase(manager, state="error")
        self.assertEqual(snapshot["error"], "invalid_credentials")
        self.assertFalse(snapshot["bound"])
        self.assertFalse(self.vault.exists())

    def test_fixed_failure_diagnostic_retains_stage_and_next_binding_resets_it(self):
        now = [1000.0]
        calls = []
        def login(username, password, cancel, progress):
            calls.append(1)
            if len(calls) == 1:
                progress("submitting")
                error = AuthError("unexpected_destination")
                error.reason = "blocked_service"
                raise error
            return result()
        manager = self.manager(login, clock=lambda: now[0])
        self.assertIsNone(manager.status()["diagnostic"])
        manager.start_login("fake-user", "fake-password", "request-failed")
        snapshot = await_phase(manager, state="error")
        expected = {"stage": "submitting", "reason": "blocked_service"}
        self.assertEqual(snapshot["diagnostic"], expected)
        self.assertIsNone(snapshot["phase"])
        snapshot["diagnostic"]["reason"] = "tampered"
        self.assertEqual(manager.status()["diagnostic"], expected)
        now[0] += 31
        manager.start_login("fake-user", "fake-password", "request-success")
        self.assertIsNone(await_phase(manager, "ready_to_bind")["diagnostic"])
        self.assertIsNone(manager.confirm("request-success")["diagnostic"])

    def test_remote_diagnostic_values_and_progress_never_enter_public_snapshot(self):
        secret = "fake-sensitive-diagnostic"
        for reason in (
            "https://remote.example/?ticket=" + secret,
            secret,
            {"reason": secret},
        ):
            with self.subTest(reason=reason):
                def login(username, password, cancel, progress):
                    progress("submitting")
                    progress(secret)
                    error = AuthError("unexpected_destination")
                    # Independently validate even a mutated transport error.
                    error.reason = reason
                    raise error
                manager = self.manager(login)
                output = io.StringIO()
                with redirect_stdout(output), redirect_stderr(output):
                    manager.start_login("fake-user", "fake-password", "request-failed")
                    snapshot = await_phase(manager, state="error")
                self.assertEqual(snapshot["error"], "unexpected_destination")
                self.assertIsNone(snapshot["diagnostic"])
                self.assertNotIn(secret, json.dumps(snapshot))
                self.assertNotIn(secret, output.getvalue())

    def test_normal_cancel_restores_previous_diagnostic_and_unbind_clears_it(self):
        now = [1000.0]
        release, entered = threading.Event(), threading.Event()
        calls = []
        def login(username, password, cancel, progress):
            calls.append(1)
            if len(calls) == 1:
                progress("submitting")
                error = AuthError("unexpected_destination")
                error.reason = "blocked_host"
                raise error
            progress("loading_public_key")
            entered.set()
            release.wait(1)
            return result()
        manager = self.manager(login, clock=lambda: now[0])
        manager.start_login("fake-user", "fake-password", "request-failed")
        previous = await_phase(manager, state="error")["diagnostic"]
        now[0] += 31
        manager.start_login("fake-user", "fake-password", "request-cancel")
        self.assertTrue(entered.wait(1))
        self.assertIsNone(manager.status()["diagnostic"])
        cancelled = manager.cancel("request-cancel")
        release.set()
        self.assertEqual(cancelled["state"], "error")
        self.assertEqual(cancelled["diagnostic"], previous)
        self.assertIsNone(manager.unbind()["diagnostic"])
        self.assertFalse(self.vault.exists())

    def test_stale_site_expiration_cannot_revoke_a_new_campus_session(self):
        manager = self.manager()
        manager.start_login("old-fake", "fake-password", "request-old")
        await_phase(manager, "ready_to_bind")
        manager.confirm("request-old")
        previous = manager.campus_session()
        manager.start_login("new-fake", "fake-password", "request-new")
        await_phase(manager, "ready_to_bind")
        manager.confirm("request-new")
        current = manager.campus_session()
        manager.invalidate_campus(previous)
        self.assertIs(manager.campus_session(), current)
        self.assertEqual(manager.status()["state"], "authenticated")


class LocalAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.manager = AuthManager(CredentialVault(root / "auth"), login=lambda *args: result())
        self.backend = LocalBackend(root / "data", root / "auth", auth=self.manager, start_worker=False)
        self.server = LocalServer(("127.0.0.1", 0), handler_for(self.backend))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)
        self.backend.close()
        self.temp.cleanup()

    def request(self, method, path, value=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        body = json.dumps(value).encode() if value is not None else None
        all_headers = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, body, all_headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        status = response.status
        connection.close()
        return status, data

    def headers(self):
        return {"Origin": self.origin, "X-PigeonPal-Token": self.backend.token}

    def test_forged_origin_host_and_missing_token_are_rejected(self):
        self.assertEqual(self.request("GET", "/api/auth/status")[0], 403)
        self.assertEqual(self.request("GET", "/api/bootstrap", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/bootstrap", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/unbind", {}, {"X-PigeonPal-Token": self.backend.token})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/unbind", {}, {**self.headers(), "Origin": "https://evil.example"})[0], 403)
        self.assertFalse(self.manager.vault.exists())

    def test_end_to_end_local_contract_never_returns_credentials(self):
        self.assertEqual(self.request("GET", "/api/bootstrap")[0], 200)
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            status, started = self.request("POST", "/api/auth/login", {
                "username": "fake-username", "password": "fake-secret-password", "requestId": "request-0001",
            }, self.headers())
            self.assertEqual(status, 202)
            await_phase(self.manager, "ready_to_bind")
            status, finished = self.request("POST", "/api/auth/confirm", {"requestId": "request-0001"}, self.headers())
            self.assertEqual(status, 200)
            self.assertEqual(finished["state"], "authenticated")
            status, sources = self.request("GET", "/api/sources", headers=self.headers())
            self.assertEqual(status, 200)
            self.assertEqual({source["id"] for source in sources["sources"]}, {"yunfeng", "itc", "qsxy", "bksy"})
        for secret in ["fake-username", "fake-secret-password"]:
            self.assertNotIn(secret, output.getvalue())
            self.assertNotIn(secret, json.dumps([started, finished, sources]))
        self.assertEqual(self.request("POST", "/api/auth/unbind", {}, self.headers())[0], 200)
        self.assertFalse(self.manager.vault.exists())

    def test_source_failure_does_not_reject_a_validated_account(self):
        class UnavailableSite:
            calls = 0
            def prepare(self, source_id, cancel):
                self.calls += 1
                raise SiteSessionError("network_error")
            def session_for(self, source_id):
                return None
            def invalidate(self, source_id):
                pass
            def close(self):
                pass

        site = UnavailableSite()
        self.backend.site_auth = site
        self.backend.engine.auth = site
        self.manager.start_login("fake-user", "fake-password", "request-account")
        await_phase(self.manager, "ready_to_bind")
        self.manager.confirm("request-account")
        for runtime in self.backend.engine.runtimes.values():
            runtime.next_due = time.time() + 3600
        self.backend.engine.runtimes["itc"].next_due = 0
        # Reading auth/source APIs never bootstraps any target website.
        self.manager.status()
        self.backend.source_status()
        self.assertEqual(site.calls, 0)
        with redirect_stdout(io.StringIO()):
            self.backend._run_due_sources()
        self.assertEqual(site.calls, 1)
        self.assertEqual(self.manager.status()["state"], "authenticated")
        self.assertTrue(self.manager.vault.exists())
        state = next(row for row in self.backend.source_status()["sources"] if row["id"] == "itc")
        self.assertEqual(state["state"], "backoff")
        self.assertEqual(state["lastError"], "network_error")

    def test_failure_diagnostics_are_fixed_enums_in_loopback_response(self):
        remote_secret = "fake-private-remote-value"
        def login(username, password, cancel, progress):
            progress("submitting")
            progress("https://remote.example/?ticket=" + remote_secret)
            error = AuthError("unexpected_destination")
            error.reason = "blocked_host"
            raise error
        self.manager.login = login
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            status, started = self.request("POST", "/api/auth/login", {
                "username": "fake-username", "password": "fake-secret-password",
                "requestId": "request-diagnostic",
            }, self.headers())
            self.assertEqual(status, 202)
            await_phase(self.manager, state="error")
            status, failed = self.request("GET", "/api/auth/status", headers=self.headers())
        self.assertEqual(status, 200)
        self.assertEqual(failed["diagnostic"], {"stage": "submitting", "reason": "blocked_host"})
        for secret in (remote_secret, "fake-username", "fake-secret-password"):
            self.assertNotIn(secret, json.dumps([started, failed]))
            self.assertNotIn(secret, output.getvalue())
        self.assertFalse(self.manager.vault.exists())


if __name__ == "__main__":
    unittest.main()
