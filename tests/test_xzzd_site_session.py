"""Offline LMS SSO broker tests. No credentials, browser state or network."""

from email.message import Message
from http.cookiejar import CookieJar
from pathlib import Path
import sys
import threading
import unittest
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from local_auth.site_sessions import SiteSessionError, SiteSessionProvider
from local_auth.zjuam import PUBLIC_KEY_URL


ENDPOINT = "https://courses.zju.edu.cn/login"
IDENTITY = "https://identity.zju.edu.cn"
CAS = "https://zjuam.zju.edu.cn"
ID_LOGIN = IDENTITY + "/auth/realms/zju/protocol/cas/login?" + urlencode({
    "service": ENDPOINT, "locale": "zh", "ts": "fixture", "ui_locales": "zh",
})
BROKER = IDENTITY + "/auth/realms/zju/broker/cas-client/login?" + urlencode({
    "client_id": "fixture", "session_code": "fixture", "tab_id": "fixture",
})
CALLBACK = IDENTITY + "/auth/realms/zju/broker/cas-client/endpoint?state=fixture"
LANDING = CAS + "/cas/login?" + urlencode({"service": CALLBACK})
FORM = (
    '<form method="post"><input name="username"><input name="password" type="password">'
    '<input name="execution" value="fixture"></form>'
)


class Response:
    def __init__(self, status=200, body="<html>LMS fixture</html>", **headers):
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


class Manager:
    def __init__(self):
        jar = CookieJar()
        jar.extract_cookies(Response(Set_Cookie=[
            "CASTGC=campus-fixture; Path=/cas; Secure; HttpOnly",
            "_csrf=parent-fixture; Domain=.zju.edu.cn; Path=/; Secure",
        ]), Request(CAS + "/cas/login"))
        self.current = AuthSession(jar)
        self.submissions = []

    def campus_session(self):
        return self.current

    def campus_submission(self, expected_session, execution, public_key_text):
        self.submissions.append((expected_session, execution, public_key_text))
        return b"encrypted-fixture-body"


class FakeOpener:
    def __init__(self, jar, responses):
        self.jar = jar
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout):
        self.jar.add_cookie_header(request)
        self.calls.append({"url": request.full_url, "method": request.get_method(),
                           "data": request.data, "cookie": request.get_header("Cookie", "")})
        response = self.responses.pop(0)
        self.jar.extract_cookies(response, request)
        return response


def start():
    return [
        Response(302, Location=ID_LOGIN),
        Response(303, Location=BROKER, Set_Cookie="AUTH_SESSION_ID=identity-fixture; Path=/auth/; Secure; HttpOnly"),
        Response(303, Location=LANDING),
    ]


def finish(*, redirect_status=302):
    return [
        Response(redirect_status, Location=CALLBACK + "&ticket=fixture-ticket", Set_Cookie="CASTGC=refreshed-fixture; Path=/cas; Secure; HttpOnly"),
        Response(302, Location=ENDPOINT + "?ticket=fixture-lms-ticket"),
        Response(302, Location="/user/index", Set_Cookie="session=courses-fixture; Path=/; Secure; HttpOnly"),
        Response(),
    ]


class XzzdSiteSessionTests(unittest.TestCase):
    def provider(self, responses, *, endpoints=None):
        manager = Manager()
        openers = []

        def factory(jar):
            opener = FakeOpener(jar, responses)
            openers.append(opener)
            return opener

        provider = SiteSessionProvider(manager, endpoints or {"xzzd": ENDPOINT},
                                       opener_factory=factory, monotonic=lambda: 1000.0)
        self.addCleanup(provider.close)
        return provider, manager, openers

    def test_existing_campus_sso_crosses_only_fixed_identity_routes(self):
        provider, manager, openers = self.provider(start() + finish())
        campus = manager.current
        session = provider.prepare("xzzd", threading.Event())
        calls = openers[0].calls
        self.assertEqual(len(calls), 7)
        self.assertTrue(all(call["method"] == "GET" for call in calls))
        self.assertEqual(manager.submissions, [])
        self.assertEqual([(cookie.domain, cookie.name) for cookie in session.cookies],
                         [("courses.zju.edu.cn", "session")])
        for call in calls:
            host = urlsplit(call["url"]).hostname
            if host == "zjuam.zju.edu.cn":
                self.assertIn("campus-fixture", call["cookie"])
                self.assertIn("parent-fixture", call["cookie"])
            else:
                self.assertNotIn("campus-fixture", call["cookie"])
                self.assertNotIn("parent-fixture", call["cookie"])
            if host != "identity.zju.edu.cn":
                self.assertNotIn("identity-fixture", call["cookie"])
        self.assertIn("identity-fixture", calls[2]["cookie"])
        self.assertIn("identity-fixture", calls[4]["cookie"])
        self.assertEqual(list(openers[0].jar), [])
        self.assertIs(provider.session_for("xzzd"), session)
        self.assertIs(manager.current, campus)
        self.assertEqual(next(cookie.value for cookie in campus.cookies if cookie.name == "CASTGC"),
                         "refreshed-fixture")

    def test_cas_form_uses_one_campus_submission_never_replays_post(self):
        provider, manager, openers = self.provider(start() + [
            Response(body=FORM), Response(body='{"modulus":"fixture"}'),
        ] + finish(redirect_status=307))
        provider.prepare("xzzd", threading.Event())
        calls = openers[0].calls
        self.assertEqual(len(calls), 9)
        self.assertEqual(calls[4]["url"], PUBLIC_KEY_URL)
        posts = [call for call in calls if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["url"], LANDING)
        self.assertEqual(posts[0]["data"], b"encrypted-fixture-body")
        self.assertEqual(calls[6]["method"], "GET")
        self.assertIsNone(calls[6]["data"])
        self.assertEqual(len(manager.submissions), 1)
        self.assertIs(manager.submissions[0][0], manager.current)

    def test_identity_html_is_never_source_authentication_success(self):
        provider, manager, openers = self.provider([Response(302, Location=ID_LOGIN), Response()])
        campus = manager.current
        with self.assertRaisesRegex(SiteSessionError, "invalid_sso_page"):
            provider.prepare("xzzd", threading.Event())
        self.assertIsNone(provider.session_for("xzzd"))
        self.assertIs(manager.current, campus)
        self.assertEqual(list(openers[0].jar), [])

    def test_lms_html_without_lms_cookie_is_not_a_live_session(self):
        provider, manager, openers = self.provider([Response()])
        with self.assertRaisesRegex(SiteSessionError, "auth_required"):
            provider.prepare("xzzd", threading.Event())
        self.assertIsNone(provider.session_for("xzzd"))

    def test_fixed_routes_reject_other_services_hosts_actions_and_http(self):
        destinations = [
            IDENTITY + "/auth/realms/other/protocol/cas/login?" + urlencode({"service": ENDPOINT}),
            IDENTITY + "/auth/realms/zju/account",
            ID_LOGIN + "&redirect_uri=https%3A%2F%2Fevil.example%2F",
            IDENTITY + "/auth/realms/zju/protocol/cas/login?" + urlencode({"service": "https://itc.zju.edu.cn/"}),
            IDENTITY + "/auth/realms/zju/broker/other/login?" + urlencode({"client_id": "a", "session_code": "b", "tab_id": "c"}),
            BROKER.replace("https://", "http://"),
            "https://identity.zju.edu.cn.evil.example/" ,
            CAS + "/cas/login?" + urlencode({"service": IDENTITY + "/auth/realms/zju/broker/cas-client/endpoint?state=fixture&redirect_uri=evil"}),
            CAS + "/cas/login?" + urlencode({"service": ENDPOINT}),
        ]
        for destination in destinations:
            with self.subTest(destination=destination):
                provider, manager, openers = self.provider([Response(302, Location=destination)])
                campus = manager.current
                with self.assertRaisesRegex(SiteSessionError, "unexpected_destination"):
                    provider.prepare("xzzd", threading.Event())
                self.assertEqual(len(openers[0].calls), 1)
                self.assertEqual(manager.submissions, [])
                self.assertIs(manager.current, campus)

    def test_identity_bridge_does_not_apply_to_itc(self):
        provider, manager, openers = self.provider([Response(302, Location=ID_LOGIN)],
            endpoints={"itc": "https://itc.zju.edu.cn/90618/list.psp"})
        with self.assertRaisesRegex(SiteSessionError, "unexpected_destination"):
            provider.prepare("itc", threading.Event())
        self.assertEqual(len(openers[0].calls), 1)

    def test_broker_redirect_budget_is_bounded(self):
        provider, _, openers = self.provider([Response(302, Location=ID_LOGIN)] * 11)
        with self.assertRaisesRegex(SiteSessionError, "invalid_sso_page"):
            provider.prepare("xzzd", threading.Event())
        self.assertEqual(len(openers[0].calls), 10)


if __name__ == "__main__":
    unittest.main()
