"""Offline ZJUAM fixtures; these tests never contact university servers."""

from email.message import Message
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from local_auth.zjuam import AuthError, CAS, LOGIN_URL, PUBLIC_KEY_URL, _CASClient, _HostCookiePolicy, login_zjuam


FORM = '<form action="/cas/login" method="post"><input name="username"><input type="password" name="password"><input type="hidden" name="execution" value="fake-execution"><input name="authcode" type="text"><input type="hidden" name="_eventId" value="submit"><input type="hidden" name="ys" value="fixture-protocol-value"></form>'
SUCCESS = '<div id="msg" class="success"><h2>登录成功</h2><p>您已经成功登录中央认证系统。</p></div>'
PUBLIC_KEY = json.dumps({"exponent": "10001", "modulus": "e" + "f" * 255})
LOGIN_COOKIE = "CASTGC=fixture-sso-cookie; Path=/cas; Secure; HttpOnly"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now


class Response:
    def __init__(self, status=200, body="", **headers):
        self.status = status
        self.body = body.encode("utf-8")
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"
        for name, value in headers.items():
            for item in value if isinstance(value, list) else [value]:
                self.headers[name.replace("_", "-")] = item

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def info(self):
        return self.headers

    def read(self, maximum):
        return self.body[:maximum]


class FakeOpener:
    def __init__(self, jar, responses):
        self.jar = jar
        self.responses = list(responses)
        self.calls = []
        self.require_csrf = False
        self.on_open = None

    def open(self, request, timeout):
        self.jar.add_cookie_header(request)
        self.calls.append({"url": request.full_url, "method": request.get_method(), "data": request.data, "cookie": request.get_header("Cookie", ""), "timeout": timeout})
        if self.on_open:
            self.on_open(request)
        if self.require_csrf and request.get_method() == "POST" and "_csrf=" not in request.get_header("Cookie", ""):
            return Response(body=FORM + '<p>会话已过期</p>')
        if not self.responses:
            raise AssertionError("Fake transport has no more responses")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        self.jar.extract_cookies(response, request)
        return response


def initial(form=FORM):
    return [Response(body=form, Set_Cookie=["JSESSIONID=fixture-form-cookie; Path=/cas; Secure", "_csrf=fixture-parent-csrf; Domain=.zju.edu.cn; Path=/; Secure"]), Response(body=PUBLIC_KEY)]


def complete():
    return initial() + [Response(body=SUCCESS, Set_Cookie=LOGIN_COOKIE)]


class ZjuamAuthTests(unittest.TestCase):
    def client(self, responses, *, cancel=None, budget=60):
        clock = Clock()
        progress = []
        cancel = cancel or threading.Event()
        client = _CASClient(cancel, progress.append, monotonic=clock.time, wall_time=clock.time, budget_seconds=budget)
        client.opener = FakeOpener(client.jar, responses)
        return client, clock, progress, cancel

    def login(self, client, cancel):
        return login_zjuam("fixture-user", "fixture-password", cancel, client.progress, client=client)

    def error(self, responses, expected):
        client, clock, progress, cancel = self.client(responses)
        with self.assertRaises(AuthError) as caught:
            self.login(client, cancel)
        self.assertEqual(caught.exception.code, expected)
        self.assertEqual(str(caught.exception), expected)
        self.assertEqual(list(client.jar), [])
        return caught.exception, client

    def test_direct_flow_is_three_continuous_cas_requests_without_service_or_waits(self):
        client, clock, progress, cancel = self.client(complete())
        with patch("time.sleep", side_effect=AssertionError("Authentication must not sleep")), patch.object(cancel, "wait", side_effect=AssertionError("Authentication must not wait")):
            result = self.login(client, cancel)
        calls = client.opener.calls
        self.assertEqual([call["url"] for call in calls], [LOGIN_URL, PUBLIC_KEY_URL, LOGIN_URL])
        self.assertEqual([call["method"] for call in calls], ["GET", "GET", "POST"])
        self.assertTrue(all(urlsplit(call["url"]).hostname == "zjuam.zju.edu.cn" for call in calls))
        self.assertTrue(all("service" not in parse_qs(urlsplit(call["url"]).query) for call in calls))
        fields = parse_qs(calls[-1]["data"].decode(), keep_blank_values=True)
        self.assertEqual(fields["username"], ["fixture-user"])
        self.assertEqual(fields["execution"], ["fake-execution"])
        self.assertNotIn("ys", fields)
        self.assertNotEqual(fields["password"], ["fixture-password"])
        self.assertEqual(fields["authcode"], [""])
        self.assertNotIn("service", fields)
        self.assertNotIn("rememberMe", fields)
        self.assertEqual(progress, ["loading_login", "loading_public_key", "submitting", "verifying_login"])
        self.assertEqual(result.authenticated_at, clock.now)
        self.assertEqual(result.session.last_request_monotonic, clock.now)
        self.assertEqual(list(client.jar), [])
        self.assertNotIn("fixture-sso-cookie", repr(result))
        self.assertFalse(hasattr(result, "list_html"))
        self.assertFalse(hasattr(result, "list_url"))

    def test_retained_cas_cookies_never_go_to_another_site(self):
        client, _, _, cancel = self.client(complete())
        result = self.login(client, cancel)
        domains = {cookie.domain.lstrip(".") for cookie in result.session.cookies}
        self.assertEqual(domains, {"zjuam.zju.edu.cn", "zju.edu.cn"})
        for url in ("https://itc.zju.edu.cn/", "https://courses.zju.edu.cn/", "https://evil.example/"):
            request = Request(url)
            result.session.cookies.add_cookie_header(request)
            self.assertIsNone(request.get_header("Cookie"))
        request = Request(LOGIN_URL)
        result.session.cookies.add_cookie_header(request)
        self.assertIn("CASTGC=fixture-sso-cookie", request.get_header("Cookie", ""))

    def test_parent_domain_csrf_cookie_is_required_for_submission(self):
        client, _, _, cancel = self.client(complete())
        client.opener.require_csrf = True
        self.login(client, cancel)
        self.assertIn("_csrf=fixture-parent-csrf", client.opener.calls[-1]["cookie"])
        client, _, _, cancel = self.client(complete())
        client.jar.set_policy(_HostCookiePolicy(allow_parent_domain=False))
        client.opener.require_csrf = True
        with self.assertRaisesRegex(AuthError, "session_expired"):
            self.login(client, cancel)
        self.assertEqual(list(client.jar), [])

    def test_pre_cancel_and_between_requests_cancel_never_submit(self):
        cancel = threading.Event()
        cancel.set()
        client, _, _, _ = self.client(complete(), cancel=cancel)
        with self.assertRaisesRegex(AuthError, "cancelled"):
            self.login(client, cancel)
        self.assertEqual(client.opener.calls, [])
        client, _, _, cancel = self.client(complete())
        client.progress = lambda code: cancel.set() if code == "loading_public_key" else None
        with self.assertRaisesRegex(AuthError, "cancelled"):
            self.login(client, cancel)
        self.assertEqual(len(client.opener.calls), 1)

    def test_cancel_after_success_prevents_session_return(self):
        client, _, _, cancel = self.client(complete())
        client.progress = lambda code: cancel.set() if code == "verifying_login" else None
        with self.assertRaisesRegex(AuthError, "cancelled"):
            self.login(client, cancel)
        self.assertEqual(list(client.jar), [])

    def test_rejected_login_never_retries(self):
        _, client = self.error(initial() + [Response(body=FORM)], "login_rejected")
        self.assertEqual(sum(call["method"] == "POST" for call in client.opener.calls), 1)

    def test_challenges_stop_before_post_or_after_single_post(self):
        _, client = self.error(initial(FORM + '<p>请输入验证码</p>'), "challenge_required")
        self.assertEqual(sum(call["method"] == "POST" for call in client.opener.calls), 0)
        self.error(initial() + [Response(body=FORM + '<input name="otp">')], "challenge_required")
        self.error(initial() + [Response(body='<h1>二次认证</h1>')], "challenge_required")
        self.error(initial() + [Response(body=FORM + '<p>请填写验证码</p>')], "challenge_required")

    def test_optional_authcode_and_hidden_challenge_widgets_do_not_block_login(self):
        for form in (FORM, FORM + '<div style="display:none"><p>请输入验证码</p><input name="captcha"></div><script>请输入验证码</script>', FORM + '<div id="kaptcha" class="code"><label>验证码</label><input name="authcode" type="text"></div>'):
            with self.subTest(form=form):
                client, _, _, cancel = self.client(initial(form) + complete()[2:])
                self.login(client, cancel)

    def test_failure_messages_are_classified_without_echoing_remote_text(self):
        self.error(initial() + [Response(body=FORM + '<p>会话已过期 fake-sensitive-token</p>')], "session_expired")
        self.error(initial() + [Response(body=FORM + '<p>用户名或密码错误 fake-sensitive-identifier</p>')], "invalid_credentials")

    def test_illegal_form_actions_hidden_service_and_get_method_never_submit(self):
        forms = [FORM.replace('/cas/login" method', action + '" method') for action in ("https://evil.example/steal", "http://zjuam.zju.edu.cn:8080/cas/login", "/cas/other", "https://itc.zju.edu.cn/cas/login", "/cas/login?service=https%3A%2F%2Fitc.zju.edu.cn")]
        forms += [FORM.replace('</form>', '<input type="hidden" name="service" value="anything"></form>'), FORM.replace('method="post"', 'method="get"')]
        for form in forms:
            with self.subTest(form=form):
                _, client = self.error(initial(form), "unexpected_destination")
                self.assertFalse(any(call["method"] == "POST" for call in client.opener.calls))

    def test_cas_redirect_after_post_is_allowed_without_replaying_credentials(self):
        client, _, _, cancel = self.client(initial() + [Response(302, Location="/cas/login", Set_Cookie=LOGIN_COOKIE), Response(body=SUCCESS)])
        self.login(client, cancel)
        self.assertEqual([call["method"] for call in client.opener.calls], ["GET", "GET", "POST", "GET"])

    def test_same_cas_http_form_action_is_upgraded_before_post(self):
        form = FORM.replace('action="/cas/login"', 'action="http://zjuam.zju.edu.cn/cas/login"')
        client, _, _, cancel = self.client(initial(form) + [Response(body=SUCCESS, Set_Cookie=LOGIN_COOKIE)])
        self.login(client, cancel)
        self.assertEqual(client.opener.calls[-1]["url"], LOGIN_URL)
        self.assertEqual(client.opener.calls[-1]["method"], "POST")

    def test_same_cas_http_redirect_is_upgraded_before_any_request(self):
        for destination in ("http://zjuam.zju.edu.cn/cas/login", "http://zjuam.zju.edu.cn:80/cas/login?service="):
            with self.subTest(destination=destination):
                client, _, _, cancel = self.client(initial() + [
                    Response(302, Location=destination, Set_Cookie=LOGIN_COOKIE), Response(body=SUCCESS),
                ])
                self.login(client, cancel)
                self.assertEqual(client.opener.calls[-1]["url"], LOGIN_URL)
                self.assertTrue(all(call["url"].startswith(CAS + "/") for call in client.opener.calls))
                self.assertTrue(all(call["url"].startswith("https://") for call in client.opener.calls))
                self.assertEqual(sum(call["method"] == "POST" for call in client.opener.calls), 1)

    def test_new_sso_cookie_with_blocked_redirect_is_verified_only_at_cas(self):
        for destination in ("https://portal.zju.edu.cn/?ticket=fixture-ticket", LOGIN_URL + "?service=https%3A%2F%2Fportal.zju.edu.cn"):
            with self.subTest(destination=destination):
                client, _, _, cancel = self.client(initial() + [
                    Response(302, Location=destination, Set_Cookie=LOGIN_COOKIE), Response(body=SUCCESS),
                ])
                self.login(client, cancel)
                self.assertEqual([call["url"] for call in client.opener.calls], [LOGIN_URL, PUBLIC_KEY_URL, LOGIN_URL, LOGIN_URL])
                self.assertEqual([call["method"] for call in client.opener.calls], ["GET", "GET", "POST", "GET"])
                self.assertIn("CASTGC=fixture-sso-cookie", client.opener.calls[-1]["cookie"])

    def test_blocked_redirect_recovery_never_treats_cookie_alone_as_success(self):
        _, client = self.error(initial() + [
            Response(302, Location="https://portal.zju.edu.cn/?ticket=fixture-ticket", Set_Cookie=LOGIN_COOKIE),
            Response(body=FORM),
        ], "login_rejected")
        self.assertEqual(client.opener.calls[-1]["url"], LOGIN_URL)
        for status in (307, 308):
            with self.subTest(status=status):
                _, client = self.error(initial() + [
                    Response(status, Location=LOGIN_URL, Set_Cookie=LOGIN_COOKIE),
                    Response(body=FORM),
                ], "login_rejected")
                self.assertEqual([call["method"] for call in client.opener.calls], ["GET", "GET", "POST", "GET"])

    def test_redirect_failures_expose_only_fixed_reason_codes(self):
        error, client = self.error(initial() + [Response(302, Location="https://evil.example/?ticket=fixture-sensitive-ticket")], "unexpected_destination")
        self.assertEqual(error.reason, "blocked_host")
        self.assertNotIn("fixture-sensitive-ticket", repr(error))
        for destination, reason in (
            ("http://zjuam.zju.edu.cn:8080/cas/login", "blocked_scheme"),
            ("http://zjuam.zju.edu.cn/logout", "blocked_scheme"),
            ("https://zjuam.zju.edu.cn:8443/cas/login", "blocked_port"),
            ("https://zjuam.zju.edu.cn.evil.example/cas/login", "blocked_host"),
            (LOGIN_URL + "?service=https%3A%2F%2Fitc.zju.edu.cn", "blocked_service"),
        ):
            with self.assertRaises(AuthError) as raised:
                _CASClient.redirect_url(destination)
            self.assertEqual(raised.exception.reason, reason)

    def test_redirects_never_replay_post_and_other_hosts_and_services_are_rejected(self):
        for status in (307, 308):
            with self.subTest(status=status):
                client, _, _, cancel = self.client(initial() + [
                    Response(status, Location=LOGIN_URL, Set_Cookie=LOGIN_COOKIE),
                    Response(body=SUCCESS),
                ])
                self.login(client, cancel)
                self.assertEqual([call["method"] for call in client.opener.calls], ["GET", "GET", "POST", "GET"])
        for destination in ("https://evil.example/?ticket=fixture-ticket", "https://itc.zju.edu.cn/90618/list.psp", LOGIN_URL + "?service=https%3A%2F%2Fitc.zju.edu.cn"):
            self.error(initial() + [Response(302, Location=destination)], "unexpected_destination")

    def test_rate_limit_and_network_errors_are_fixed_and_redacted(self):
        error, _ = self.error([Response(429, Retry_After="600")], "rate_limited")
        self.assertEqual(error.retry_after, 600.0)
        self.error([URLError("fixture-password https://example.invalid/?ticket=fixture-ticket")], "network_error")
        self.error([TimeoutError("fixture-sensitive")], "network_error")
        self.error([Response(403)], "login_rejected")

    def test_success_requires_cookie_and_explicit_success_without_any_login_form(self):
        for response in (
            Response(body="<html>欢迎</html>", Set_Cookie=LOGIN_COOKIE),
            Response(body=SUCCESS),
            Response(body=SUCCESS, Set_Cookie="SESSION=fixture-cookie; Path=/cas; Secure"),
            Response(body='<h1>登录成功指南</h1>', Set_Cookie=LOGIN_COOKIE),
            Response(body='<script>登录成功</script>', Set_Cookie=LOGIN_COOKIE),
        ):
            self.error(initial() + [response], "invalid_cas_page")
        self.error(initial() + [Response(body=SUCCESS + FORM, Set_Cookie=LOGIN_COOKIE)], "login_rejected")
        self.error(initial() + [Response(body=SUCCESS + '<form><input name="username"><input name="password"></form>', Set_Cookie=LOGIN_COOKIE)], "login_rejected")
        self.error(initial() + [Response(body=SUCCESS + '<p>用户名或密码错误</p>', Set_Cookie=LOGIN_COOKIE)], "invalid_credentials")

    def test_confirmation_rejects_generic_page_even_with_new_sso_cookie(self):
        error, client = self.error(initial() + [
            Response(body="<p>Please try later</p>", Set_Cookie=LOGIN_COOKIE),
            Response(body="<p>Please try later</p>"),
        ], "invalid_cas_page")
        self.assertEqual(error.reason, "sso_not_confirmed")
        self.assertEqual([call["method"] for call in client.opener.calls], ["GET", "GET", "POST", "GET"])

    def test_confirmation_accepts_explicit_success_with_new_sso_cookie(self):
        client, _, _, cancel = self.client(initial() + [
            Response(body="<p>Continue</p>", Set_Cookie=LOGIN_COOKIE),
            Response(body=SUCCESS),
        ])
        result = self.login(client, cancel)
        self.assertTrue(any(cookie.name == "CASTGC" for cookie in result.session.cookies))

    def test_sso_cookie_without_secure_attribute_is_used_only_over_https(self):
        client, _, _, cancel = self.client(initial() + [
            Response(body=SUCCESS, Set_Cookie="CASTGC=fixture-cookie; Path=/cas"),
        ])
        result = self.login(client, cancel)
        self.assertTrue(any(cookie.name == "CASTGC" for cookie in result.session.cookies))
        self.assertTrue(all(call["url"].startswith("https://") for call in client.opener.calls))

    def test_recognized_chinese_and_official_english_success_messages(self):
        for message in ('<h2>认证成功</h2>', '<p>您已成功登录。</p>', '<h2>Log In Successful</h2><p>You have successfully logged into the Central Authentication Service.</p>'):
            client, _, _, cancel = self.client(initial() + [Response(body=message, Set_Cookie=LOGIN_COOKIE)])
            self.login(client, cancel)

    def test_deadline_and_request_timeout_are_bounded_without_waiting(self):
        client, clock, _, cancel = self.client(complete())
        client.opener.on_open = lambda request: setattr(clock, "now", clock.now + 25)
        with self.assertRaisesRegex(AuthError, "network_error"):
            self.login(client, cancel)
        self.assertEqual([call["timeout"] for call in client.opener.calls], [15.0, 15.0, 10.0])
        self.assertEqual(list(client.jar), [])
        client, clock, _, cancel = self.client(complete(), budget=0)
        with self.assertRaisesRegex(AuthError, "network_error"):
            self.login(client, cancel)
        self.assertEqual(client.opener.calls, [])

    def test_invalid_public_key_and_destination_values_fail_privately(self):
        self.error(initial()[:1] + [Response(body="not-json fixture-ticket")], "invalid_cas_page")
        self.error(initial()[:1] + [Response(body=json.dumps({"modulus": "invalid", "exponent": "10001"}))], "invalid_cas_page")
        for url in ("https://zjuam.zju.edu.cn.evil.example/cas/login", "https://user:password@zjuam.zju.edu.cn/cas/login", "https://zjuam.zju.edu.cn:8443/", "https://zjuam.zju.edu.cn:bad/", "https://itc.zju.edu.cn/", LOGIN_URL + "?service="):
            with self.subTest(url=url):
                with self.assertRaisesRegex(AuthError, "unexpected_destination"):
                    _CASClient.safe_url(url)

    def test_trickled_body_obeys_deadline_and_adjusts_remaining_socket_timeout(self):
        client, clock, _, cancel = self.client(initial())
        socket_timeouts = []

        class TrickleResponse(Response):
            def __init__(self):
                super().__init__(body=SUCCESS, Set_Cookie=LOGIN_COOKIE)
                self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=SimpleNamespace(settimeout=socket_timeouts.append)))
                self.read_calls = 0

            def read1(self, maximum):
                self.read_calls += 1
                clock.now += 25
                return b"a"

        response = TrickleResponse()
        client.opener.responses.append(response)
        with self.assertRaisesRegex(AuthError, "network_error"):
            self.login(client, cancel)
        self.assertEqual(response.read_calls, 3)
        self.assertEqual(socket_timeouts, [15.0, 15.0, 10.0])
        self.assertEqual(list(client.jar), [])

    def test_cancellation_during_streamed_body_stops_reading_and_clears_cookies(self):
        client, _, _, cancel = self.client(initial())

        class CancelResponse(Response):
            def __init__(self):
                super().__init__(body=SUCCESS, Set_Cookie=LOGIN_COOKIE)
                self.read_calls = 0

            def read1(self, maximum):
                self.read_calls += 1
                cancel.set()
                return b"a"

        response = CancelResponse()
        client.opener.responses.append(response)
        with self.assertRaisesRegex(AuthError, "cancelled"):
            self.login(client, cancel)
        self.assertEqual(response.read_calls, 1)
        self.assertEqual(list(client.jar), [])


if __name__ == "__main__":
    unittest.main()
