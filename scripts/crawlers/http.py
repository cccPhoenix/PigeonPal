"""Site-scoped transport with per-site pacing and fixed, redacted errors."""

from __future__ import annotations

from email.utils import parsedate_to_datetime
import random
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPCookieProcessor, OpenerDirector, ProxyHandler, Request,
    build_opener,
)

from .auth import AuthSession


MIN_DELAY = 15.0
MAX_DELAY = 30.0
MAX_HTML_BYTES = 1024 * 1024
MAX_RETRY_AFTER = 86400.0
PUBLIC_HTTP_HOST = "qsxy.zju.edu.cn"
SENSITIVE_QUERY_KEYS = {
    "ticket", "token", "access_token", "id_token", "refresh_token",
    "authorization", "password", "passwd", "username", "session",
    "sessionid", "jsessionid", "auth", "authcode", "code", "signature",
}


class CrawlFailure(RuntimeError):
    def __init__(self, code: str, retry_after: float | None = None):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def has_sensitive_query(url: str) -> bool:
    return any(key.lower() in SENSITIVE_QUERY_KEYS
               for key, _ in parse_qsl(urlsplit(url).query, keep_blank_values=True))


def notice_url(url: str, host: str, *, allow_http: bool = False) -> str:
    """Validate a same-site URL, with HTTP allowed only for public QSXY pages.

    Other sources keep their existing HTTPS upgrade. An opted-in QSXY source
    preserves the incoming scheme so HTTPS redirects are never downgraded.
    """
    try:
        if allow_http and host != PUBLIC_HTTP_HOST:
            raise CrawlFailure("invalid_notice_url")
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"} or parsed.hostname != host
            or parsed.username is not None or parsed.password is not None
            or parsed.port not in {None, 80, 443}
            or parsed.query or ";" in parsed.path
        ):
            raise CrawlFailure("invalid_notice_url")
        if allow_http and parsed.port not in {None, 80 if parsed.scheme == "http" else 443}:
            raise CrawlFailure("invalid_notice_url")
    except ValueError:
        raise CrawlFailure("invalid_notice_url") from None
    # Do not carry an explicit HTTP port into the HTTPS transport.
    scheme = parsed.scheme if allow_http else "https"
    return urlunsplit((scheme, host, parsed.path, "", ""))


def retry_after_seconds(value: str | None, now: float) -> float | None:
    if not value:
        return None
    try:
        if value.strip().isdigit():
            delay = float(value.strip())
        else:
            delay = parsedate_to_datetime(value).timestamp() - now
        return max(300.0, min(MAX_RETRY_AFTER, delay))
    except (TypeError, ValueError, OverflowError):
        return None


class SlowClient:
    """One reusable client per source. Redirects also obey request pacing."""

    def __init__(
        self, host: str, protected: bool = False, session: AuthSession | None = None,
        *, allow_http: bool = False, opener: OpenerDirector | None = None, monotonic=time.monotonic,
        sleep=time.sleep, wall_time=time.time, choose_delay=random.uniform,
    ):
        if allow_http and (host != PUBLIC_HTTP_HOST or protected or session is not None):
            raise CrawlFailure("invalid_transport_policy")
        self.host = host
        self.protected = protected
        self.allow_http = allow_http
        self.clock = monotonic
        self.sleep = sleep
        self.wall_time = wall_time
        self.choose_delay = choose_delay
        self.last_finished: float | None = None
        self.request_count = 0
        # Match account validation and site SSO: use a direct campus connection.
        # urllib's implicit ProxyHandler otherwise picks up desktop/env proxies,
        # making collection take a different route from the successful login.
        handlers = [ProxyHandler({}), NoRedirect()]
        if session is not None:
            handlers.append(HTTPCookieProcessor(session.cookies))
        self.opener = opener or build_opener(*handlers)

    def _wait(self):
        if self.last_finished is not None:
            delay = self.choose_delay(MIN_DELAY, MAX_DELAY)
            remaining = delay - (self.clock() - self.last_finished)
            if remaining > 0:
                self.sleep(remaining)

    def html(self, url: str) -> tuple[str, str]:
        current = notice_url(url, self.host, allow_http=self.allow_http)
        for _ in range(5):
            self._wait()
            self.request_count += 1
            request = Request(current, headers={
                "User-Agent": "PigeonPal/0.2 (local read-only notice fetcher)",
                "Accept": "text/html,application/xhtml+xml",
            }, method="GET")
            try:
                try:
                    response = self.opener.open(request, timeout=30)
                except HTTPError as error:
                    response = error
                with response:
                    status = response.status
                    if status in {301, 302, 303, 307, 308}:
                        location = response.headers.get("Location")
                        if not location:
                            raise CrawlFailure("redirect_missing_location")
                        try:
                            target = urljoin(current, location)
                            parsed = urlsplit(target)
                            if parsed.hostname == "zjuam.zju.edu.cn":
                                raise CrawlFailure("auth_required" if self.protected else "unexpected_auth")
                            if has_sensitive_query(target):
                                raise CrawlFailure("auth_required" if self.protected else "unsafe_redirect")
                            current = notice_url(target, self.host, allow_http=self.allow_http)
                        except ValueError:
                            raise CrawlFailure("unsafe_redirect") from None
                        continue
                    if status in {401, 403}:
                        raise CrawlFailure("auth_required" if self.protected else "access_denied", 3600)
                    if status in {429, 503}:
                        raise CrawlFailure(
                            "rate_limited" if status == 429 else "service_unavailable",
                            retry_after_seconds(response.headers.get("Retry-After"), self.wall_time()),
                        )
                    if status == 404:
                        raise CrawlFailure("not_found", 86400)
                    if status != 200:
                        raise CrawlFailure("http_error")
                    if response.headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
                        raise CrawlFailure("unexpected_content_type")
                    body = response.read(MAX_HTML_BYTES + 1)
                    if len(body) > MAX_HTML_BYTES:
                        raise CrawlFailure("page_too_large")
                    encoding = response.headers.get_content_charset() or "utf-8"
                    try:
                        html = body.decode(encoding, errors="replace")
                    except LookupError:
                        raise CrawlFailure("invalid_encoding") from None
                    if "该信息仅允许校内地址访问" in html or "您当前ip并非校内地址" in html:
                        raise CrawlFailure("campus_network_required", 3600)
                    lowered = html.lower()
                    if self.protected and (
                        "zjuam.zju.edu.cn/cas/login" in lowered
                        or ('type="password"' in lowered and "execution" in lowered)
                    ):
                        raise CrawlFailure("auth_required")
                    return html, current
            except (URLError, TimeoutError, OSError):
                # Never stringify an exception: URLs, ticket or proxy credentials
                # could otherwise become part of console/state-file output.
                raise CrawlFailure("network_error") from None
            finally:
                self.last_finished = self.clock()
        raise CrawlFailure("too_many_redirects")
