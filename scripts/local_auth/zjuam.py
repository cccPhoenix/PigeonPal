"""One-shot ZJUAM validation; all credentials, cookies and HTML stay in memory.

The raw RSA operation follows the campus login form, not general RSA encryption.
Authentication talks only to the official CAS host, without a service parameter.
Website-specific SSO and crawler request pacing belong to the collection layer.
Only fixed error/progress codes leave this module.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
import http.cookiejar
from html.parser import HTMLParser
import re
import threading
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPCookieProcessor, ProxyHandler, Request, build_opener,
)

from crawlers.auth import AuthSession
from crawlers.http import retry_after_seconds
from .cas_protocol import build_submission


CAS = "https://zjuam.zju.edu.cn"
LOGIN_URL = CAS + "/cas/login"
PUBLIC_KEY_URL = CAS + "/cas/v2/getPubKey"
HOSTS = {"zjuam.zju.edu.cn"}
MAX_BYTES = 1024 * 1024
AUTH_BUDGET_SECONDS = 60.0
REQUEST_TIMEOUT_SECONDS = 15.0
# Match the reference project's browser request profile. Crawling keeps its own
# identifying User-Agent and pacing; this profile is for the CAS form only.
AUTH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
ERROR_CODES = {
    "login_rejected", "challenge_required", "network_error",
    "campus_network_required", "rate_limited", "cancelled",
    "invalid_cas_page", "unexpected_destination", "invalid_credentials", "session_expired",
}
REASON_CODES = {
    "blocked_host", "blocked_scheme", "blocked_port", "blocked_service", "blocked_url",
    "form_route", "form_method", "form_service", "credential_post_route", "post_replay",
    "public_key_route", "success_route", "success_message_missing", "sso_cookie_missing",
    "sso_not_confirmed", "redirect_limit",
}


class AuthError(RuntimeError):
    def __init__(self, code: str, retry_after: float | None = None, *, reason: str | None = None):
        self.code = code if code in ERROR_CODES else "invalid_cas_page"
        self.retry_after = retry_after
        self.reason = reason if reason in REASON_CODES else None
        super().__init__(self.code)


@dataclass(repr=False)
class LoginResult:
    session: AuthSession
    authenticated_at: float


class _SignedInRedirect(Exception):
    """A fresh CAS session may leave CAS; its destination is never visited."""


class _HostCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Accept legal campus-domain CAS cookies; never send them to other hosts."""

    def __init__(self, *, allow_parent_domain=True):
        super().__init__(strict_ns_domain=self.DomainStrict)
        self.allow_parent_domain = allow_parent_domain

    @staticmethod
    def _same_host(cookie, request):
        return cookie.domain.lstrip(".").lower() == urlsplit(request.full_url).hostname

    def _allowed_scope(self, cookie, request):
        host = urlsplit(request.full_url).hostname
        return host in HOSTS and (
            self._same_host(cookie, request)
            or self.allow_parent_domain and cookie.domain.lstrip(".").lower() == "zju.edu.cn"
        )

    def set_ok(self, cookie, request):
        return self._allowed_scope(cookie, request) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return self._allowed_scope(cookie, request) and super().return_ok(cookie, request)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _Page(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.forms = []
        self.current = None
        self.ids = set()
        self.classes = set()
        self.text = []
        self._stack = []
        self.challenge_input = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.ids.add(attrs.get("id", ""))
        self.classes.update(attrs.get("class", "").split())
        style = attrs.get("style", "").replace(" ", "").lower()
        hidden = bool(self._stack and self._stack[-1][1]) or tag in {"script", "style", "template"} or "hidden" in attrs or "display:none" in style or "visibility:hidden" in style
        if tag not in {"input", "img", "br", "hr", "meta", "link", "source", "area", "base", "embed", "param", "wbr"}:
            self._stack.append((tag, hidden))
        if tag == "form":
            self.current = {"action": attrs.get("action", ""), "method": attrs.get("method", "post").lower(), "inputs": {}, "hidden": {}}
        elif tag == "input":
            name = attrs.get("name", "")
            if self.current is not None and name:
                self.current["inputs"][name] = attrs.get("value", "")
                if attrs.get("type", "").lower() == "hidden":
                    self.current["hidden"][name] = attrs.get("value", "")
            # ZJUAM always includes its authcode input; the #kaptcha group is
            # shown dynamically by CSS/JS. Its presence alone is not a demand
            # for CAPTCHA. Use the school's required/error message below.
            if not hidden and attrs.get("type", "").lower() != "hidden" and name.lower() in {"captcha", "otp", "totp", "smscode", "verificationcode"}:
                self.challenge_input = True

    def handle_endtag(self, tag):
        if tag == "form" and self.current is not None:
            self.forms.append(self.current)
            self.current = None
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                del self._stack[index:]
                break

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if not self._stack or not self._stack[-1][1]:
            self.text.append(data)

    def login_form(self):
        candidates = [f for f in self.forms if {"username", "password", "execution"} <= f["inputs"].keys()]
        if len(candidates) > 1:
            raise AuthError("invalid_cas_page")
        return candidates[0] if candidates else None

    def needs_challenge(self):
        visible = " ".join(self.text).lower()
        return self.challenge_input or any(marker in visible for marker in (
            "请输入验证码", "请填写验证码", "验证码错误", "验证码不能为空", "验证码必填", "二次认证",
            "动态口令", "短信验证码", "一次性密码", "multi-factor",
            "two-factor", "verification code", "enter captcha",
        ))

    def has_credential_form(self):
        return any({"username", "password"} <= form["inputs"].keys() for form in self.forms)

    def authenticated_success(self):
        """Recognize an explicit CAS success message, not a generic welcome."""
        if self.has_credential_form() or self.explicit_failure():
            return False
        pieces = [re.sub(r"\s+", " ", text).strip().lower() for text in self.text]
        exact = {"登录成功", "登陆成功", "认证成功", "log in successful", "login successful", "authentication successful"}
        if any(piece.rstrip("。.!！") in exact for piece in pieces):
            return True
        visible = " ".join(pieces)
        return any(marker in visible for marker in (
            "您已经成功登录", "您已成功登录", "您已经成功登陆", "您已成功登陆",
            "you have successfully logged into the central authentication service",
            "you have successfully logged in to the central authentication service",
            "successfully initiated a single sign-on session",
        ))

    def explicit_failure(self):
        if self.failure_code() != "login_rejected":
            return True
        # Exact messages avoid treating help/footer links about failed logins
        # as a failed response. Never return the remote text to the caller.
        failures = {
            "登录失败", "认证失败", "系统异常", "系统错误", "服务不可用", "未登录", "未认证",
            "authentication failed", "login failed", "system error", "access denied", "unauthorized",
        }
        return any(re.sub(r"\s+", " ", item).strip().lower().rstrip("。.!！") in failures for item in self.text)

    def failure_code(self):
        # Map known messages to fixed codes without returning school HTML or
        # arbitrary error text, which can echo identifiers or form values.
        if self.needs_challenge():
            return "challenge_required"
        visible = " ".join(self.text).lower()
        if any(value in visible for value in (
            "会话已过期", "会话失效", "登录超时", "请求已过期", "无效的登录请求",
            "invalid execution", "invalid flow execution", "session expired",
        )):
            return "session_expired"
        if any(value in visible for value in (
            "用户名或密码错误", "用户名或密码不正确", "用户名和密码不匹配",
            "账号或密码错误", "帐号或密码错误", "invalid credentials",
        )):
            return "invalid_credentials"
        return "login_rejected"


class _CASClient:
    def __init__(self, cancel: threading.Event, progress: Callable[[str], None], *,
                 opener=None, monotonic=time.monotonic, wall_time=time.time,
                 budget_seconds=AUTH_BUDGET_SECONDS):
        self.cancel = cancel
        self.progress = progress
        self.clock = monotonic
        self.wall_time = wall_time
        self.deadline = self.clock() + budget_seconds
        self.last_finished = None
        self.login_cookie_sent = False
        self.jar = http.cookiejar.CookieJar(_HostCookiePolicy())
        # Deliberately do not forward local credentials to a configured proxy.
        # Default urllib HTTPS keeps certificate and hostname verification on.
        self.opener = opener or build_opener(ProxyHandler({}), _NoRedirect(), HTTPCookieProcessor(self.jar))

    def check_cancel(self):
        if self.cancel.is_set():
            raise AuthError("cancelled")
        if self.clock() >= self.deadline:
            raise AuthError("network_error")

    def emit(self, code):
        self.check_cancel()
        self.progress(code)
        self.check_cancel()

    def _timeout(self):
        self.check_cancel()
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise AuthError("network_error")
        return min(REQUEST_TIMEOUT_SECONDS, remaining)

    def _read_body(self, response):
        reader = getattr(response, "read1", None)
        if not callable(reader):
            # Minimal offline transports may expose only read(). urllib's
            # HTTPResponse exposes read1(), used below in the real transport.
            body = response.read(MAX_BYTES + 1)
            self.check_cancel()
            return body
        chunks = []
        size = 0
        while size <= MAX_BYTES:
            timeout = self._timeout()
            # Keep each remaining body read inside the same overall deadline.
            # HTTPResponse's buffered stream wraps the HTTPS socket here.
            socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if socket is not None:
                socket.settimeout(timeout)
            chunk = reader(min(65536, MAX_BYTES + 1 - size))
            self.check_cancel()
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b"".join(chunks)

    @staticmethod
    def safe_url(url: str) -> str:
        try:
            parts = urlsplit(url)
            if parts.username or parts.password:
                raise AuthError("unexpected_destination", reason="blocked_url")
            if parts.hostname not in HOSTS:
                raise AuthError("unexpected_destination", reason="blocked_host")
            if parts.scheme != "https":
                raise AuthError("unexpected_destination", reason="blocked_scheme")
            if parts.port not in {None, 443}:
                raise AuthError("unexpected_destination", reason="blocked_port")
            if "service" in parse_qs(parts.query, keep_blank_values=True):
                raise AuthError("unexpected_destination", reason="blocked_service")
            return urlunsplit(parts._replace(fragment=""))
        except (TypeError, ValueError):
            raise AuthError("unexpected_destination", reason="blocked_url") from None

    @classmethod
    def redirect_url(cls, url: str) -> str:
        """Normalize a CAS-generated GET redirect without ever downgrading TLS.

        ZJUAM's public login page publishes an HTTP CAS base URL even when
        requested over HTTPS. Only this exact host's ordinary HTTP port is
        upgraded; credential form actions still use the stricter safe_url.
        Empty service parameters are discarded, never sent to CAS.
        """
        try:
            parts = urlsplit(url)
            if parts.hostname in HOSTS and not parts.username and not parts.password:
                if (parts.scheme == "http" and parts.port in {None, 80}
                        and (parts.path == "/cas" or parts.path.startswith("/cas/"))):
                    parts = parts._replace(scheme="https", netloc=parts.hostname)
                parameters = parse_qsl(parts.query, keep_blank_values=True)
                services = [value for name, value in parameters if name == "service"]
                if services and all(value == "" for value in services):
                    parts = parts._replace(query=urlencode([(name, value) for name, value in parameters if name != "service"]))
            return cls.safe_url(urlunsplit(parts))
        except (TypeError, ValueError):
            raise AuthError("unexpected_destination", reason="blocked_url") from None

    def one(self, url: str, data=None, headers=None, *, sso_baseline=None):
        current = self.safe_url(url)
        parts = urlsplit(current)
        if data is not None and (parts.hostname != "zjuam.zju.edu.cn" or not _is_login_path(parts.path)):
            raise AuthError("unexpected_destination", reason="credential_post_route")
        self.check_cancel()
        request = Request(current, data=data, headers={
            "User-Agent": AUTH_USER_AGENT,
            "Accept": "text/html,application/json", **(headers or {}),
        }, method="POST" if data is not None else "GET")
        self.jar.add_cookie_header(request)
        if data is None and _is_login_path(parts.path):
            self.login_cookie_sent |= any(
                item.partition("=")[0].strip().upper() in {"CASTGC", "TGC"}
                for item in request.get_header("Cookie", "").split(";")
            )
        try:
            try:
                response = self.opener.open(request, timeout=self._timeout())
            except HTTPError as error:
                response = error
            with response:
                self.check_cancel()
                status = response.status
                if status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location:
                        raise AuthError("invalid_cas_page")
                    try:
                        return None, self.redirect_url(urljoin(current, location))
                    except AuthError as error:
                        if (sso_baseline is not None
                                and error.reason in {"blocked_host", "blocked_scheme", "blocked_port", "blocked_service"}
                                and _login_cookies(self.jar, self.wall_time()) - sso_baseline):
                            raise _SignedInRedirect() from None
                        raise
                if status in {429, 503}:
                    raise AuthError("rate_limited", retry_after_seconds(response.headers.get("Retry-After"), self.wall_time()))
                if status in {401, 403}:
                    raise AuthError("login_rejected")
                if status != 200:
                    raise AuthError("network_error")
                body = self._read_body(response)
                self.check_cancel()
                if len(body) > MAX_BYTES:
                    raise AuthError("invalid_cas_page")
                encoding = response.headers.get_content_charset() or "utf-8"
                try:
                    text = body.decode(encoding, errors="replace")
                except LookupError:
                    raise AuthError("invalid_cas_page") from None
                if "该信息仅允许校内地址访问" in text or "您当前ip并非校内地址" in text:
                    raise AuthError("campus_network_required")
                return text, None
        except (URLError, TimeoutError, OSError):
            raise AuthError("network_error") from None
        finally:
            self.last_finished = self.clock()

    def follow(self, url: str, data=None, headers=None, *, sso_baseline=None):
        self.login_cookie_sent = False
        # Port of reference request(): retain cookies at every hop, change all
        # redirect continuations to GET, never replay credentials, max 15 hops.
        for _ in range(16):
            url = self.safe_url(url)
            html, location = self.one(url, data, headers, sso_baseline=sso_baseline)
            if location is None:
                return html, url
            url, data, headers = location, None, None
        raise AuthError("invalid_cas_page", reason="redirect_limit")


def _is_login_path(path):
    return bool(re.fullmatch(r"/cas/login(?:;jsessionid=[A-Za-z0-9._-]{1,256})?", path, re.IGNORECASE))


def _login_action(client: _CASClient, landing: str, form: dict) -> str:
    landing = client.safe_url(landing)
    parts = urlsplit(landing)
    if parts.hostname != "zjuam.zju.edu.cn" or not _is_login_path(parts.path):
        raise AuthError("unexpected_destination", reason="form_route")
    # Use the school's form action as the reference does, upgrading its public
    # HTTP CAS base to HTTPS before any credentials are submitted.
    action = client.redirect_url(urljoin(landing, form["action"] or landing))
    destination = urlsplit(action)
    if destination.hostname != "zjuam.zju.edu.cn" or not _is_login_path(destination.path):
        raise AuthError("unexpected_destination", reason="form_route")
    if form["method"] != "post":
        raise AuthError("unexpected_destination", reason="form_method")
    if form["inputs"].get("service"):
        raise AuthError("unexpected_destination", reason="form_service")
    if not form["inputs"].get("execution"):
        raise AuthError("invalid_cas_page")
    return action


def _login_cookies(jar, now):
    """Private identity fingerprints of CAS cookies applicable to /cas/login.

    Secure is a browser transport attribute, not a login-success signal. All
    requests in this client already enforce HTTPS and the official CAS host.
    """
    path = urlsplit(LOGIN_URL).path
    return frozenset(
        (cookie.name, cookie.domain, cookie.path, cookie.value)
        for cookie in jar
        if cookie.name.upper() in {"CASTGC", "TGC"} and bool(cookie.value)
        and cookie.domain.lstrip(".").lower() in {"zjuam.zju.edu.cn", "zju.edu.cn"}
        and not cookie.is_expired(now)
        and (path == cookie.path or path.startswith(cookie.path.rstrip("/") + "/"))
    )


def _has_login_cookie(jar, now):
    return bool(_login_cookies(jar, now))


def _check_page(page):
    if page.has_credential_form() or page.explicit_failure():
        raise AuthError(page.failure_code())


def _confirm_sso(client, baseline):
    """Confirm the newly issued cookie at CAS without visiting a portal."""
    client.emit("verifying_login")
    try:
        html, _ = client.follow(LOGIN_URL, sso_baseline=baseline)
    except _SignedInRedirect:
        # CAS accepted the cookie presented to its login endpoint and chose a
        # post-login destination. We only observe that response, never visit it.
        if client.login_cookie_sent and _login_cookies(client.jar, client.wall_time()) - baseline:
            return
        raise AuthError("invalid_cas_page", reason="sso_not_confirmed") from None
    page = _Page(html)
    _check_page(page)
    if (not client.login_cookie_sent
            or not (_login_cookies(client.jar, client.wall_time()) - baseline)
            or not page.authenticated_success()):
        raise AuthError("invalid_cas_page", reason="sso_not_confirmed")
    # A retained new TGC sent back to CAS and an explicit success page form
    # the evidence. A generic HTTP 200 or the cookie alone never suffices.


def login_zjuam(username: str, password: str, cancel: threading.Event,
              progress: Callable[[str], None], *, client: _CASClient | None = None) -> LoginResult:
    """Validate one account directly against ZJUAM; never contact a website.

    Normal flow: login form, RSA key, login POST, with no crawler sleep.
    ``client`` is an offline-test injection point. A failure never retries the
    credential POST. Only the caller may persist credentials.
    """
    client = client or _CASClient(cancel, progress)
    form = payload = html = page = public_text = None
    try:
        if not isinstance(username, str) or not isinstance(password, str) or not username.strip() or not password or len(username) > 256 or len(password) > 1024:
            raise AuthError("login_rejected")
        client.emit("loading_login")
        html, landing = client.follow(LOGIN_URL)
        page = _Page(html)
        form = page.login_form()
        if form is None:
            if page.needs_challenge():
                raise AuthError("challenge_required")
            raise AuthError("invalid_cas_page")
        action = _login_action(client, landing, form)
        if page.needs_challenge():
            raise AuthError("challenge_required")
        client.emit("loading_public_key")
        public_text, public_url = client.follow(PUBLIC_KEY_URL)
        if urlsplit(public_url).path != urlsplit(PUBLIC_KEY_URL).path:
            raise AuthError("unexpected_destination", reason="public_key_route")
        try:
            payload = build_submission(username.strip(), password, form["inputs"]["execution"], public_text)
        except ValueError:
            raise AuthError("invalid_cas_page") from None
        client.emit("submitting")
        baseline = _login_cookies(client.jar, client.wall_time())
        redirected = False
        try:
            html, final_url = client.follow(action, payload, {
                "Content-Type": "application/x-www-form-urlencoded", "Origin": CAS,
                "Referer": landing,
            }, sso_baseline=baseline)
        except _SignedInRedirect:
            redirected = True
        username = password = payload = public_text = None
        form["inputs"].clear()
        form["hidden"].clear()
        client.emit("verifying_login")
        page = None if redirected else _Page(html)
        if page is not None:
            _check_page(page)
        if not (_login_cookies(client.jar, client.wall_time()) - baseline):
            raise AuthError("invalid_cas_page", reason="sso_cookie_missing")
        if page is None or not page.authenticated_success():
            _confirm_sso(client, baseline)
        client.check_cancel()
        session_jar = http.cookiejar.CookieJar(_HostCookiePolicy())
        for cookie in client.jar:
            session_jar.set_cookie(copy.copy(cookie))
        return LoginResult(AuthSession(session_jar, last_request_monotonic=client.last_finished), client.wall_time())
    except AuthError:
        raise
    except Exception:
        # Never expose urllib/parser exception text or its credential URLs.
        raise AuthError("invalid_cas_page") from None
    finally:
        if form is not None:
            form["inputs"].clear()
            form["hidden"].clear()
        username = password = payload = html = page = form = public_text = None
        client.jar.clear()
