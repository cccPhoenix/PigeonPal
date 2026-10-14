"""Offline SSO boundary tests; never contact campus hosts or read credentials."""

from email.message import Message
from http.cookiejar import CookieJar
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from local_auth.site_sessions import SiteSessionError, SiteSessionProvider


ENDPOINT = "https://itc.zju.edu.cn/90618/list.psp"
SERVICE = "http://itc.zju.edu.cn/90618/list.psp"
CAS = "https://zjuam.zju.edu.cn"
LANDING = CAS + "/cas/login?" + urlencode({"service": SERVICE})
FORM = '<form><input name="username"><input name="password" type="password"><input name="execution" value="fixture"></form>'


class Response:
    def __init__(self, status=200, body="<html>notice fixture</html>", **headers):
        self.status = status
        self.body = body.encode()
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"
        for name, value in headers.items():
            for item in value if isinstance(value, list) else [value]:
                self.headers[name.replace("_", "-")] = item

    def info(self):
        return self.headers

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, maximum):
        return self.body[:maximum]


def central_session():
    jar = CookieJar()
    jar.extract_cookies(Response(Set_Cookie=[
        "CASTGC=campus-fixture; Path=/cas; Secure; HttpOnly",
        "_csrf=parent-fixture; Domain=.zju.edu.cn; Path=/; Secure",
    ]), Request(CAS + "/cas/login"))
    return AuthSession(jar)


class Manager:
    def __init__(self):
        self.current = central_session()
        self.invalidated = []

    def campus_session(self):
        return self.current

    def invalidate_campus(self, expected_session):
        self.invalidated.append(expected_session)
        if self.current is expected_session:
            self.current = None


class FakeOpener:
    def __init__(self, jar, responses, on_call=None):
        self.jar = jar
        self.responses = list(responses)
        self.on_call = on_call
        self.calls = []

    def open(self, request, timeout):
        self.jar.add_cookie_header(request)
        self.calls.append({"url": request.full_url, "method": request.get_method(),
                           "data": request.data, "cookie": request.get_header("Cookie", ""),
                           "timeout": timeout})
        if self.on_call:
            self.on_call(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        self.jar.extract_cookies(response, request)
        return response


def complete():
    return [
        Response(302, Location=LANDING),
        Response(302, Location=SERVICE + "?ticket=one-use-fixture", Set_Cookie="CASTGC=refreshed-fixture; Path=/cas; Secure; HttpOnly"),
        Response(302, Location="/90618/list.psp", Set_Cookie="SESSION=source-fixture; Path=/; Secure; HttpOnly"),
        Response(),
    ]


class SiteSessionTests(unittest.TestCase):
    def provider(self, responses, *, manager=None, on_call=None):
        manager = manager or Manager()
        transports = []
        def factory(jar):
            opener = FakeOpener(jar, responses, on_call)
            transports.append(opener)
            return opener
        provider = SiteSessionProvider(manager, {"itc": ENDPOINT}, opener_factory=factory,
                                       monotonic=lambda: 1000.0, wall_time=lambda: 2000.0)
        self.addCleanup(provider.close)
        return provider, manager, transports

    def test_get_only_sso_is_separate_and_reuses_site_session(self):
        provider, manager, transports = self.provider(complete())
        central = manager.current
        self.assertIsNone(provider.session_for("itc"))
        self.assertEqual(transports, [])
        session = provider.prepare("itc", threading.Event())
        calls = transports[0].calls
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(call["method"] == "GET" and call["data"] is None for call in calls))
        self.assertTrue(all(call["url"].startswith("https://") for call in calls))
        self.assertEqual(calls[1]["url"], LANDING)
        self.assertEqual(calls[2]["url"], ENDPOINT + "?ticket=one-use-fixture")
        self.assertIs(manager.current, central)
        self.assertEqual(manager.invalidated, [])
        self.assertEqual(session.last_request_monotonic, 1000.0)
        self.assertIs(provider.session_for("itc"), session)
        self.assertIs(provider.prepare("itc", threading.Event()), session)
        self.assertEqual(len(transports), 1)

    def test_cookie_scope_excludes_campus_secrets_and_other_hosts(self):
        provider, manager, transports = self.provider(complete())
        session = provider.prepare("itc", threading.Event())
        for call in transports[0].calls:
            if "zjuam.zju.edu.cn" in call["url"]:
                self.assertIn("CASTGC=campus-fixture", call["cookie"])
                self.assertIn("_csrf=parent-fixture", call["cookie"])
                self.assertNotIn("source-fixture", call["cookie"])
            else:
                self.assertNotIn("campus-fixture", call["cookie"])
                self.assertNotIn("parent-fixture", call["cookie"])
        self.assertEqual([(cookie.domain, cookie.name) for cookie in session.cookies], [("itc.zju.edu.cn", "SESSION")])
        for url in (CAS + "/cas/login", "https://courses.zju.edu.cn/", "https://evil.example/"):
            request = Request(url)
            session.cookies.add_cookie_header(request)
            self.assertIsNone(request.get_header("Cookie"))
        request = Request("https://courses.zju.edu.cn/")
        transports[0].jar.add_cookie_header(request)
        self.assertIsNone(request.get_header("Cookie"))
        self.assertEqual(list(transports[0].jar), [])
        self.assertEqual(next(cookie.value for cookie in manager.current.cookies if cookie.name == "CASTGC"), "refreshed-fixture")

    def test_site_network_permission_and_rate_errors_leave_campus_binding_intact(self):
        for response, code in [
            (URLError("private-ticket-in-error"), "network_error"),
            (Response(403), "access_denied"),
            (Response(body="该信息仅允许校内地址访问"), "campus_network_required"),
            (Response(429, Retry_After="600"), "rate_limited"),
        ]:
            with self.subTest(code=code):
                provider, manager, transports = self.provider([response])
                campus = manager.current
                with self.assertRaises(SiteSessionError) as caught:
                    provider.prepare("itc", threading.Event())
                self.assertEqual(str(caught.exception), code)
                self.assertIs(manager.current, campus)
                self.assertEqual(manager.invalidated, [])
                self.assertIsNone(provider.session_for("itc"))
                self.assertEqual(list(transports[0].jar), [])

    def test_only_official_cas_login_form_proves_sso_expired(self):
        provider, manager, transports = self.provider([Response(302, Location=LANDING), Response(body=FORM)])
        campus = manager.current
        with self.assertRaisesRegex(SiteSessionError, "auth_required"):
            provider.prepare("itc", threading.Event())
        self.assertIsNone(manager.current)
        self.assertEqual(manager.invalidated, [campus])
        self.assertTrue(all(call["method"] == "GET" for call in transports[0].calls))
        provider, manager, _ = self.provider([Response(body=FORM)])
        campus = manager.current
        with self.assertRaisesRegex(SiteSessionError, "auth_required"):
            provider.prepare("itc", threading.Event())
        self.assertIs(manager.current, campus)
        self.assertEqual(manager.invalidated, [])

    def test_rebind_and_unbind_drop_old_source_sessions_without_network(self):
        provider, manager, transports = self.provider(complete())
        session = provider.prepare("itc", threading.Event())
        manager.current = central_session()
        self.assertIsNone(provider.session_for("itc"))
        self.assertEqual(list(session.cookies), [])
        manager.current = None
        self.assertIsNone(provider.session_for("itc"))
        with self.assertRaisesRegex(SiteSessionError, "auth_required"):
            provider.prepare("itc", threading.Event())
        self.assertEqual(len(transports), 1)

    def test_rebind_during_network_discards_results_and_does_not_touch_new_identity(self):
        manager = Manager()
        old = manager.current
        def rebind(request):
            if "ticket=" in request.full_url:
                manager.current = central_session()
        provider, manager, transports = self.provider(complete(), manager=manager, on_call=rebind)
        with self.assertRaisesRegex(SiteSessionError, "session_changed"):
            provider.prepare("itc", threading.Event())
        self.assertIsNone(provider.session_for("itc"))
        self.assertIsNot(manager.current, old)
        self.assertEqual(next(cookie.value for cookie in manager.current.cookies if cookie.name == "CASTGC"), "campus-fixture")
        self.assertEqual(list(transports[0].jar), [])

    def test_invalidate_and_close_affect_only_source_cookies(self):
        provider, manager, transports = self.provider(complete())
        session = provider.prepare("itc", threading.Event())
        campus = manager.current
        provider.invalidate("itc")
        self.assertEqual(list(session.cookies), [])
        self.assertIs(manager.current, campus)
        self.assertIsNone(provider.session_for("itc"))
        provider.close()
        with self.assertRaisesRegex(SiteSessionError, "cancelled"):
            provider.prepare("itc", threading.Event())
        self.assertEqual(len(transports), 1)

    def test_cancel_before_or_during_request_cannot_return_session(self):
        provider, manager, transports = self.provider(complete())
        cancel = threading.Event()
        cancel.set()
        with self.assertRaisesRegex(SiteSessionError, "cancelled"):
            provider.prepare("itc", cancel)
        self.assertEqual(transports, [])
        cancel = threading.Event()
        provider, manager, transports = self.provider(complete(), on_call=lambda request: cancel.set())
        with self.assertRaisesRegex(SiteSessionError, "cancelled"):
            provider.prepare("itc", cancel)
        self.assertEqual(len(transports[0].calls), 1)
        self.assertIsNone(provider.session_for("itc"))

    def test_unsafe_redirects_stop_before_following_or_forwarding_cookies(self):
        for destination in (
            "https://evil.example/?ticket=secret-fixture",
            "http://zjuam.zju.edu.cn/cas/login?service=" + ENDPOINT,
            "https://zjuam.zju.edu.cn/cas/logout",
            "https://zjuam.zju.edu.cn/cas/login?" + urlencode({"service": "https://courses.zju.edu.cn/"}),
            "https://user:private@itc.zju.edu.cn/",
        ):
            with self.subTest(destination=destination):
                provider, manager, transports = self.provider([Response(302, Location=destination)])
                campus = manager.current
                with self.assertRaisesRegex(SiteSessionError, "unexpected_destination"):
                    provider.prepare("itc", threading.Event())
                self.assertEqual(len(transports[0].calls), 1)
                self.assertIs(manager.current, campus)

    def test_redirect_count_is_bounded(self):
        provider, manager, transports = self.provider([Response(302, Location=ENDPOINT)] * 9)
        with self.assertRaisesRegex(SiteSessionError, "invalid_sso_page"):
            provider.prepare("itc", threading.Event())
        self.assertEqual(len(transports[0].calls), 8)
        self.assertTrue(all(0 < call["timeout"] <= 12 for call in transports[0].calls))


if __name__ == "__main__":
    unittest.main()
