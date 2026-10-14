"""Bounded authentication jobs; private values never enter public snapshots."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import re
import threading
import time
import uuid

from crawlers.auth import AuthSession
from .vault import CredentialVault, Credentials, VaultError
from .zjuam import AuthError, LoginResult, REASON_CODES, login_zjuam
from .cas_protocol import build_submission


_DIAGNOSTIC_STAGES = frozenset({
    "loading_login", "loading_public_key", "submitting", "verifying_login",
})


def iso(value: float | None) -> str | None:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds") if value is not None else None


def masked(username: str) -> str:
    if len(username) <= 2:
        return "**"
    return username[:2] + "***" + (username[-2:] if len(username) > 4 else "")


class AuthActionError(RuntimeError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code, self.status = code, status


class AuthManager:
    """Own the campus account binding, independent of any target website.

    Manual login is verified first, then the still-open UI commits the binding.
    Cancel IDs are remembered so a cancelled, delayed POST cannot start a job.
    Automatic renewal uses existing credentials, once per scheduled attempt.
    """

    def __init__(self, vault: CredentialVault, *, login=login_zjuam, clock=time.time):
        self.vault, self.login, self.clock = vault, login, clock
        self.lock = threading.RLock()
        self.generation = 0
        self.cancelled_ids = deque(maxlen=100)
        self._session: AuthSession | None = None
        self._bound = False
        self._account = None
        self._state = "unbound"
        self._error = None
        self._phase = None
        self._diagnostic = None
        self._request_id = None
        self._authenticated_at = None
        self._can_retry_at = None
        self._auto_retry_at = 0.0
        self._auto_suppressed = False
        self._failures = 0
        self._job = None
        self._pending = None
        self._receipt = None
        self._previous = None
        self._closed = False
        try:
            credentials = vault.read()
            if credentials is not None:
                self._bound = True
                self._account = masked(credentials.username)
                self._state = "expired"
            credentials = None
        except VaultError:
            self._state, self._error = "error", "auth_storage_error"
            try:
                self._bound = vault.exists()
            except VaultError:
                self._bound = False
            self._auto_suppressed = True

    def _snapshot(self):
        return {
            "state": self._state, "bound": self._bound, "account": self._account,
            "phase": self._phase, "error": self._error, "requestId": self._request_id,
            "authenticatedAt": iso(self._authenticated_at), "canRetryAt": iso(self._can_retry_at),
            "diagnostic": dict(self._diagnostic) if self._diagnostic is not None else None,
        }

    def status(self):
        with self.lock:
            self._expire_pending()
            return self._snapshot()

    def _expire_pending(self):
        if self._receipt is not None and self.clock() > self._receipt["expires"]:
            self._receipt = None
        if self._pending is not None and self.clock() > self._pending["expires"]:
            self._cancel_current()

    def _previous_state(self):
        return (self._state, self._error, self._account, self._session,
                self._authenticated_at, self._diagnostic)

    def _restore_previous(self):
        if self._previous is not None:
            (self._state, self._error, self._account, self._session,
             self._authenticated_at, self._diagnostic) = self._previous
        else:
            self._state = "expired" if self._bound else "unbound"
            self._diagnostic = None
        self._phase, self._request_id, self._previous = None, None, None

    def _cancel_current(self):
        self.generation += 1
        if self._job:
            self._job["cancel"].set()
        if self._pending:
            self._pending["result"].session.cookies.clear()
        self._pending, self._job = None, None
        self._restore_previous()

    def start_login(self, username, password, request_id):
        if (
            not isinstance(username, str) or not username.strip() or len(username) > 128
            or any(ord(char) < 32 for char in username)
            or not isinstance(password, str) or not password or len(password) > 512
            or not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id)
        ):
            raise AuthActionError("invalid_input")
        with self.lock:
            self._expire_pending()
            if self._closed or request_id in self.cancelled_ids:
                raise AuthActionError("cancelled", 409)
            if self._job is not None:
                raise AuthActionError("auth_busy", 409)
            if self._can_retry_at and self.clock() < self._can_retry_at:
                raise AuthActionError("auth_retry_later", 429)
            self._begin(Credentials(username.strip(), password), request_id, automatic=False)
            return self._snapshot()

    def _begin(self, credentials, request_id, automatic):
        self.generation += 1
        generation = self.generation
        event = threading.Event()
        self._previous = self._previous_state()
        self._job = {"id": request_id, "cancel": event, "automatic": automatic}
        self._request_id = request_id
        self._state, self._error, self._phase = "authenticating", None, "loading_login"
        self._diagnostic = None
        thread = threading.Thread(target=self._work, args=(credentials, request_id, generation, event, automatic),
                                  name="pigeonpal-auth", daemon=True)
        thread.start()

    def _work(self, credentials, request_id, generation, event, automatic):
        result = None

        def progress(phase):
            with self.lock:
                if (generation == self.generation and not event.is_set()
                        and isinstance(phase, str) and phase in _DIAGNOSTIC_STAGES):
                    self._phase = phase

        try:
            result = self.login(credentials.username, credentials.password, event, progress)
            with self.lock:
                if generation != self.generation or event.is_set() or self._closed:
                    result.session.cookies.clear()
                    return
                if automatic:
                    self._activate(result, credentials.username)
                else:
                    self._pending = {"result": result, "credentials": credentials,
                                     "expires": self.clock() + 120, "id": request_id}
                    self._phase = "ready_to_bind"
        except Exception as exception:
            code = exception.code if isinstance(exception, AuthError) else "authentication_error"
            # AuthError's codes are fixed by our transport, never remote text.
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code):
                code = "authentication_error"
            with self.lock:
                if generation != self.generation or event.is_set() or self._closed:
                    return
                reason = getattr(exception, "reason", None) if isinstance(exception, AuthError) else None
                self._diagnostic = (
                    {"stage": self._phase, "reason": reason}
                    if (isinstance(reason, str) and reason in REASON_CODES
                        and self._phase in _DIAGNOSTIC_STAGES) else None
                )
                self._job, self._request_id, self._phase = None, None, None
                self._state = "challenge_required" if code == "challenge_required" else "error"
                self._error = code
                if self._session is not None:
                    self._session.cookies.clear()
                self._session, self._authenticated_at = None, None
                self._previous = None
                self._failures += 1
                delay = min(3600, 300 * 2 ** min(self._failures - 1, 4))
                delay = max(delay, getattr(exception, "retry_after", None) or 0)
                self._auto_retry_at = self.clock() + delay
                self._can_retry_at = self.clock() + (delay if code == "rate_limited" else 30)
                self._auto_suppressed = code not in {"network_error", "rate_limited", "service_unavailable"}
        finally:
            credentials = None

    def _activate(self, result: LoginResult, username: str):
        if self._session is not None and self._session is not result.session:
            self._session.cookies.clear()
        self._session = result.session
        self._bound = True
        self._account = masked(username)
        self._state, self._error, self._phase = "authenticated", None, None
        self._diagnostic = None
        self._authenticated_at = result.authenticated_at
        self._job, self._request_id, self._pending, self._previous = None, None, None, None
        self._failures, self._auto_suppressed = 0, False
        self._auto_retry_at = 0.0
        self._can_retry_at = None

    def confirm(self, request_id):
        with self.lock:
            self._expire_pending()
            if (request_id in self.cancelled_ids or self._pending is None
                    or self._pending["id"] != request_id):
                raise AuthActionError("cancelled", 409)
            pending = self._pending
            try:
                previous_credentials = self.vault.read()
                self.vault.save(pending["credentials"].username, pending["credentials"].password)
            except VaultError:
                self._cancel_current()
                if self._session is not None:
                    self._session.cookies.clear()
                self._session = None
                self._auto_suppressed = True
                self._state, self._error = "error", "auth_storage_error"
                self._diagnostic = None
                raise AuthActionError("auth_storage_error", 500) from None
            self._activate(pending["result"], pending["credentials"].username)
            # A closing UI may have sent cancel while this response was still
            # in transit. Keep a short rollback receipt, never persist it.
            self._receipt = {"id": request_id, "generation": self.generation,
                             "credentials": previous_credentials, "expires": self.clock() + 120}
            return self._snapshot()

    def cancel(self, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", request_id):
            raise AuthActionError("invalid_input")
        with self.lock:
            self._expire_pending()
            self.cancelled_ids.append(request_id)
            if self._job and self._job["id"] == request_id:
                self._cancel_current()
            elif (self._receipt is not None and self._receipt["id"] == request_id
                  and self._receipt["generation"] == self.generation):
                receipt, self._receipt = self._receipt, None
                if self._session is not None:
                    self._session.cookies.clear()
                self._session = None
                self._auto_suppressed = True
                try:
                    previous = receipt["credentials"]
                    if previous is None:
                        self.vault.clear()
                    else:
                        self.vault.save(previous.username, previous.password)
                    self._bound = previous is not None
                    self._account = masked(previous.username) if previous is not None else None
                    self._state = "expired" if self._bound else "unbound"
                    self._auto_suppressed = not self._bound
                    self._auto_retry_at = self.clock() + 30
                    self._error, self._authenticated_at = None, None
                    self._diagnostic = None
                except VaultError:
                    self._state, self._error = "error", "auth_storage_error"
                    self._diagnostic = None
                    raise AuthActionError("auth_storage_error", 500) from None
            return self._snapshot()

    def unbind(self):
        with self.lock:
            # Revoke in-memory access immediately, even if filesystem removal
            # fails. A failed deletion is reported, never called successful.
            if self._job:
                self.cancelled_ids.append(self._job["id"])
            self._cancel_current()
            if self._session is not None:
                self._session.cookies.clear()
            self._session = None
            self._auto_suppressed = True
            self._receipt = None
            self._diagnostic = None
            try:
                self.vault.clear()
            except VaultError:
                self._state, self._error = "error", "auth_storage_error"
                raise AuthActionError("auth_storage_error", 500) from None
            self._bound, self._account, self._authenticated_at = False, None, None
            self._state, self._error = "unbound", None
            self._can_retry_at = None
            return self._snapshot()

    def tick(self):
        """Called by the service worker, not by status polling or HTTP GET."""
        with self.lock:
            self._expire_pending()
            if (self._closed or self._job is not None or self._session is not None
                    or not self._bound or self._auto_suppressed or self.clock() < self._auto_retry_at):
                return
            try:
                credentials = self.vault.read()
            except VaultError:
                self._state, self._error, self._auto_suppressed = "error", "auth_storage_error", True
                self._diagnostic = None
                return
            if credentials is not None:
                self._begin(credentials, "auto-" + uuid.uuid4().hex, automatic=True)

    def campus_session(self):
        """Read the in-memory ZJUAM session without visiting another website."""
        with self.lock:
            return self._session if self._state == "authenticated" and not self._closed else None

    def campus_submission(self, expected_session, execution, public_key_text):
        """Build one RSA-encrypted service login without exposing vault credentials.

        The site adapter validates the official CAS form URL before requesting
        this body. An ITC-specific login form does not revoke campus identity.
        """
        credentials = None
        with self.lock:
            if expected_session is None or self.campus_session() is not expected_session:
                return None
            try:
                credentials = self.vault.read()
                if credentials is None:
                    return None
                return build_submission(credentials.username, credentials.password,
                                        execution, public_key_text)
            finally:
                credentials = None

    def invalidate_campus(self, expected_session):
        """Renew only when ZJUAM itself reports this exact session expired."""
        with self.lock:
            if self._session is not expected_session:
                return
            if self._session is not None:
                self._session.cookies.clear()
            self._session = None
            if self._job is None:
                self._state = "expired" if self._bound else "unbound"
                self._error = "auth_expired" if self._bound else None
                self._diagnostic = None
                self._auto_retry_at = max(self._auto_retry_at, self.clock() + 30)

    def close(self):
        with self.lock:
            self._closed = True
            self._receipt = None
            self._cancel_current()
            if self._session is not None:
                self._session.cookies.clear()
            self._session = None
