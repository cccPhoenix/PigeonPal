"""Site SSO bootstrap, independent of campus credential validation.

The caller supplies an already validated, in-memory campus session. If CAS
requires the source's own login form, the manager supplies one encrypted form
body. No plaintext password or vault is read here, and source failures do not
revoke the campus identity. Redirects never replay that credential POST.
"""

from __future__ import annotations

from http.client import HTTPException

import copy
import http.cookiejar
from html.parser import HTMLParser
import threading
import time
from typing import Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPCookieProcessor, ProxyHandler, Request, build_opener,
)

from crawlers.auth import AuthSession
from crawlers.http import retry_after_seconds
from .zjuam import AUTH_USER_AGENT, PUBLIC_KEY_URL, _Page, _is_login_path


CAS_HOST = "zjuam.zju.edu.cn"
XZZD_HOST = "courses.zju.edu.cn"
IDENTITY_HOST = "identity.zju.edu.cn"
XZZD_LOGIN_PATH = "/login"
IDENTITY_CAS_PATH = "/auth/realms/zju/protocol/cas/login"
IDENTITY_BROKER_PATH = "/auth/realms/zju/broker/cas-client/login"
IDENTITY_CALLBACK_PATH = "/auth/realms/zju/broker/cas-client/endpoint"
MAX_BYTES = 1024 * 1024
ERROR_CODES = {
    "auth_required", "cancelled", "network_error", "campus_network_required",
    "access_denied", "rate_limited", "invalid_sso_page",
    "unexpected_destination", "session_changed",
    "challenge_required", "invalid_credentials", "login_rejected", "credential_unavailable",
}


class SiteSessionError(RuntimeError):
    def __init__(self, code: str, retry_after: float | None = None):
        self.code = code if code in ERROR_CODES else "invalid_sso_page"
        self.retry_after = retry_after
        super().__init__(self.code)


class _CampusManager(Protocol):
    def campus_session(self) -> AuthSession | None: ...
    def campus_submission(self, expected_session: AuthSession, execution: str,
                          public_key_text: str) -> bytes | None: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _CookiePolicy(http.cookiejar.DefaultCookiePolicy):
    def __init__(self, hosts, *, parent_domain=False):
        super().__init__(strict_ns_domain=self.DomainStrict)
        self.hosts = frozenset(hosts)
        self.parent_domain = parent_domain

    def _scope(self, cookie, request):
        host = urlsplit(request.full_url).hostname
        domain = cookie.domain.lstrip(".").lower()
        return host in self.hosts and (
            domain == host
            or self.parent_domain and host == CAS_HOST and domain == "zju.edu.cn"
        )

    def set_ok(self, cookie, request):
        return self._scope(cookie, request) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return self._scope(cookie, request) and super().return_ok(cookie, request)


def _cookie_key(cookie):
    return cookie.domain, cookie.path, cookie.name


class _TransactionJar(http.cookiejar.CookieJar):
    """Keep track of cookies refreshed by CAS, rather than by a source host."""

    def __init__(self, host, *, identity_bridge=False):
        hosts = {CAS_HOST, host}
        if identity_bridge:
            hosts.add(IDENTITY_HOST)
        super().__init__(_CookiePolicy(hosts, parent_domain=True))
        self.cas_updates = {}

    def extract_cookies(self, response, request):
        super().extract_cookies(response, request)
        if urlsplit(request.full_url).hostname == CAS_HOST:
            for cookie in self.make_cookies(response, request):
                if self._policy.set_ok(cookie, request):
                    self.cas_updates[_cookie_key(cookie)] = copy.copy(cookie)


class _LoginPage(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.has_login_form = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.current = set()
        elif tag == "input" and self.current is not None:
            self.current.add(attrs.get("name", ""))

    def handle_endtag(self, tag):
        if tag == "form" and self.current is not None:
            self.has_login_form |= {"username", "password", "execution"} <= self.current
            self.current = None


class SiteSessionProvider:
    """Own per-source cookies while using campus SSO only on the worker thread.

    ``session_for`` is a pure lookup. ``prepare`` performs a bounded browser-style
    transaction, with at most one POST to official CAS and no crawler sleeps. The
    resulting timestamp lets the crawler pace its next ordinary page fetch.
    """

    def __init__(self, manager: _CampusManager, endpoints: Mapping[str, str], *,
                 opener_factory=None, monotonic=time.monotonic, wall_time=time.time):
        self.manager = manager
        self.endpoints = dict(endpoints)
        self.clock = monotonic
        self.wall_time = wall_time
        self.opener_factory = opener_factory or (
            lambda jar: build_opener(ProxyHandler({}), _NoRedirect(), HTTPCookieProcessor(jar))
        )
        self._lock = threading.RLock()
        self._campus = None
        self._sessions = {}
        self._epochs = {}
        self._generation = 0
        self._closed = False
        for endpoint in self.endpoints.values():
            try:
                parts = urlsplit(endpoint)
                if (
                    parts.scheme != "https" or not parts.hostname
                    or not parts.hostname.endswith(".zju.edu.cn") or parts.hostname == CAS_HOST
                    or parts.username or parts.password or parts.port not in {None, 443}
                    or parts.query or parts.fragment
                ):
                    raise ValueError()
            except (TypeError, ValueError):
                raise ValueError("invalid_site_endpoint") from None

    def _sync(self):
        current = self.manager.campus_session()
        if current is not self._campus:
            for session in self._sessions.values():
                session.cookies.clear()
            self._sessions.clear()
            self._campus = current
            self._generation += 1
        return current

    def session_for(self, source_id: str) -> AuthSession | None:
        with self._lock:
            self._sync()
            return None if self._closed else self._sessions.get(source_id)

    def invalidate(self, source_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(source_id, None)
            if session is not None:
                session.cookies.clear()
            self._epochs[source_id] = self._epochs.get(source_id, 0) + 1

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._generation += 1
            for session in self._sessions.values():
                session.cookies.clear()
            self._sessions.clear()
            self._campus = None

    @staticmethod
    def _identity_bridge(endpoint):
        target = urlsplit(endpoint)
        return target.hostname == XZZD_HOST and target.path == XZZD_LOGIN_PATH

    @staticmethod
    def _identity_url(parts, endpoint, *, service_callback=False):
        """Allow only the observed LMS CAS broker, never arbitrary IdP routes."""
        if (
            parts.scheme != "https" or parts.hostname != IDENTITY_HOST
            or parts.port not in {None, 443} or parts.username or parts.password
            or parts.fragment
        ):
            raise ValueError()
        query = parse_qs(parts.query, keep_blank_values=True)
        if any(len(values) != 1 or not values[0] for values in query.values()):
            raise ValueError()
        if service_callback:
            if parts.path != IDENTITY_CALLBACK_PATH or set(query) != {"state"}:
                raise ValueError()
            return
        if parts.path == IDENTITY_CAS_PATH:
            if not {"service"} <= set(query) <= {"service", "locale", "ts", "ui_locales"}:
                raise ValueError()
            if query["service"][0] != endpoint:
                raise ValueError()
        elif parts.path == IDENTITY_BROKER_PATH:
            if set(query) != {"client_id", "session_code", "tab_id"}:
                raise ValueError()
        elif parts.path == IDENTITY_CALLBACK_PATH:
            if not {"state"} <= set(query) <= {"state", "ticket"}:
                raise ValueError()
        else:
            raise ValueError()

    @staticmethod
    def _safe_url(url, endpoint):
        try:
            parts = urlsplit(url)
            target = urlsplit(endpoint)
            identity_bridge = SiteSessionProvider._identity_bridge(endpoint)
            if parts.username or parts.password or parts.fragment:
                raise ValueError()
            if parts.hostname == target.hostname:
                if parts.scheme == "http" and parts.port in {None, 80}:
                    return urlunsplit(("https", target.hostname, parts.path, parts.query, ""))
                if parts.scheme != "https" or parts.port not in {None, 443}:
                    raise ValueError()
            elif parts.hostname == CAS_HOST:
                if parts.scheme == "http" and parts.port in {None, 80}:
                    parts = parts._replace(scheme="https", netloc=CAS_HOST)
                if parts.scheme != "https" or parts.port not in {None, 443} or not _is_login_path(parts.path):
                    raise ValueError()
                services = parse_qs(parts.query).get("service", [])
                if len(services) != 1:
                    raise ValueError()
                service = urlsplit(services[0])
                if identity_bridge:
                    SiteSessionProvider._identity_url(service, endpoint, service_callback=True)
                elif (
                    service.hostname != target.hostname or service.username or service.password
                    or service.scheme not in {"http", "https"}
                    or service.port not in {None, 80 if service.scheme == "http" else 443}
                    or service.path != target.path or service.query or service.fragment
                ):
                    raise ValueError()
            elif identity_bridge and parts.hostname == IDENTITY_HOST:
                SiteSessionProvider._identity_url(parts, endpoint)
            else:
                raise ValueError()
            return urlunsplit(parts._replace(fragment=""))
        except (TypeError, ValueError):
            raise SiteSessionError("unexpected_destination") from None

    def prepare(self, source_id: str, cancel: threading.Event) -> AuthSession:
        with self._lock:
            campus = self._sync()
            if self._closed or cancel.is_set():
                raise SiteSessionError("cancelled")
            if campus is None:
                raise SiteSessionError("auth_required")
            if source_id not in self.endpoints:
                raise SiteSessionError("unexpected_destination")
            if source_id in self._sessions:
                return self._sessions[source_id]
            generation = self._generation
            epoch = self._epochs.get(source_id, 0)
        endpoint = self.endpoints[source_id]
        host = urlsplit(endpoint).hostname
        identity_bridge = self._identity_bridge(endpoint)
        jar = _TransactionJar(host, identity_bridge=identity_bridge)
        for cookie in campus.cookies:
            if cookie.domain.lstrip(".").lower() in {CAS_HOST, "zju.edu.cn"}:
                jar.set_cookie(copy.copy(cookie))
        deadline = self.clock() + 45.0
        last_finished = None
        html = None
        payload = None
        credential_posted = False
        completed = False

        def check_current():
            if cancel.is_set():
                raise SiteSessionError("cancelled")
            with self._lock:
                if self._closed:
                    raise SiteSessionError("cancelled")
                if (
                    self._sync() is not campus or self._generation != generation
                    or self._epochs.get(source_id, 0) != epoch
                ):
                    raise SiteSessionError("session_changed")

        try:
            opener = self.opener_factory(jar)
            current = endpoint

            def public_key():
                # Only GET the fixed official key endpoint, never a key URL
                # supplied in school HTML or a redirect. Keep the same jar.
                check_current()
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise SiteSessionError("network_error")
                req = Request(PUBLIC_KEY_URL, headers={
                    "User-Agent": AUTH_USER_AGENT, "Accept": "application/json",
                }, method="GET")
                try:
                    response = opener.open(req, timeout=min(12.0, remaining))
                except HTTPError as error:
                    response = error
                with response:
                    check_current()
                    if response.status in {429, 503}:
                        raise SiteSessionError("rate_limited", retry_after_seconds(
                            response.headers.get("Retry-After"), self.wall_time()))
                    if response.status != 200:
                        raise SiteSessionError("invalid_sso_page")
                    data = response.read(MAX_BYTES + 1)
                    check_current()
                    if len(data) > MAX_BYTES:
                        raise SiteSessionError("invalid_sso_page")
                    return data.decode("utf-8", errors="strict")

            for _ in range(10 if identity_bridge else 8):
                check_current()
                current = self._safe_url(current, endpoint)
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise SiteSessionError("network_error")
                headers = {
                    "User-Agent": AUTH_USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                }
                if payload is not None:
                    # current was validated against CAS and the exact source's
                    # service callback. Never POST this body to a source host.
                    if urlsplit(current).hostname != CAS_HOST:
                        raise SiteSessionError("unexpected_destination")
                    headers.update({"Content-Type": "application/x-www-form-urlencoded",
                                    "Origin": "https://" + CAS_HOST, "Referer": current})
                    credential_posted = True
                request = Request(current, data=payload, headers=headers,
                                  method="POST" if payload is not None else "GET")
                payload = None
                try:
                    try:
                        response = opener.open(request, timeout=min(12.0, remaining))
                    except HTTPError as error:
                        response = error
                    with response:
                        check_current()
                        status = response.status
                        if status in {301, 302, 303, 307, 308}:
                            location = response.headers.get("Location")
                            if not location:
                                raise SiteSessionError("invalid_sso_page")
                            current = self._safe_url(urljoin(current, location), endpoint)
                            continue
                        if status in {429, 503}:
                            raise SiteSessionError("rate_limited", retry_after_seconds(response.headers.get("Retry-After"), self.wall_time()))
                        if status in {401, 403}:
                            raise SiteSessionError("access_denied")
                        if status != 200:
                            raise SiteSessionError("network_error")
                        if response.headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
                            raise SiteSessionError("invalid_sso_page")
                        body = response.read(MAX_BYTES + 1)
                        check_current()
                        if len(body) > MAX_BYTES:
                            raise SiteSessionError("invalid_sso_page")
                        try:
                            html = body.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                        except LookupError:
                            raise SiteSessionError("invalid_sso_page") from None
                        if "该信息仅允许校内地址访问" in html or "您当前ip并非校内地址" in html:
                            raise SiteSessionError("campus_network_required", 3600.0)
                        login_form = _LoginPage(html).has_login_form
                        if urlsplit(current).hostname == CAS_HOST:
                            if login_form:
                                page = _Page(html)
                                if page.needs_challenge():
                                    raise SiteSessionError("challenge_required", 3600.0)
                                if credential_posted:
                                    code = page.failure_code()
                                    raise SiteSessionError(code if code in ERROR_CODES else "login_rejected", 3600.0)
                                form = page.login_form()
                                if form is None or form["method"] != "post":
                                    raise SiteSessionError("invalid_sso_page")
                                # Keep the school's service identifier unchanged;
                                # upgrade transport to HTTPS, as in account login.
                                action = self._safe_url(urljoin(current, form["action"] or current), endpoint)
                                if urlsplit(action).hostname != CAS_HOST:
                                    raise SiteSessionError("unexpected_destination")
                                field_service = form["inputs"].get("service")
                                if field_service and field_service != parse_qs(urlsplit(action).query)["service"][0]:
                                    raise SiteSessionError("unexpected_destination")
                                key = public_key()
                                check_current()
                                try:
                                    payload = self.manager.campus_submission(
                                        campus, form["inputs"]["execution"], key)
                                except ValueError:
                                    raise SiteSessionError("invalid_sso_page") from None
                                except Exception:
                                    raise SiteSessionError("credential_unavailable", 3600.0) from None
                                finally:
                                    form["inputs"].clear()
                                    form["hidden"].clear()
                                    key = None
                                if payload is None:
                                    raise SiteSessionError("session_changed")
                                current = action
                                continue
                            raise SiteSessionError("invalid_sso_page")
                        if login_form:
                            raise SiteSessionError("auth_required")
                        if urlsplit(current).hostname != host:
                            # An IdP error/consent page is not a source session.
                            raise SiteSessionError("invalid_sso_page")
                        result_jar = http.cookiejar.CookieJar(_CookiePolicy({host}))
                        for cookie in jar:
                            if cookie.domain.lstrip(".").lower() == host:
                                result_jar.set_cookie(copy.copy(cookie))
                        if identity_bridge and not any(not cookie.is_expired() for cookie in result_jar):
                            raise SiteSessionError("auth_required")
                        last_finished = self.clock()
                        session = AuthSession(result_jar, last_request_monotonic=last_finished)
                        with self._lock:
                            check_current()
                            self._sessions[source_id] = session
                            completed = True
                        return session
                finally:
                    last_finished = self.clock()
            raise SiteSessionError("invalid_sso_page")
        except SiteSessionError:
            raise
        except (HTTPException, URLError, TimeoutError, OSError):
            raise SiteSessionError("network_error") from None
        except Exception:
            raise SiteSessionError("invalid_sso_page") from None
        finally:
            # Only a completed site login can publish CAS-cookie rotations.
            # A failed source login must not replace the campus session's
            # cookies with its anonymous/rejected login-form cookies.
            if completed and self.manager.campus_session() is campus:
                for key, cookie in jar.cas_updates.items():
                    if cookie.is_expired():
                        try:
                            campus.cookies.clear(*key)
                        except KeyError:
                            pass
                    else:
                        campus.cookies.set_cookie(copy.copy(cookie))
            jar.clear()
            jar.cas_updates.clear()
            html = payload = request = None
