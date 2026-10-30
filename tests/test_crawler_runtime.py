"""Small offline checks for pacing, auth boundaries and incremental scheduling."""

from email.message import Message
from http.client import IncompleteRead
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.engine import CrawlEngine
from crawlers.auth import AuthSession
from crawlers.http import CrawlFailure, MAX_HTML_BYTES, SlowClient
from crawlers.storage import NoticeStore, StorageError
from pigeonpal_crawler import export_json, main, single_writer
from http.cookiejar import CookieJar


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.waits = []

    def time(self):
        return self.now

    def sleep(self, delay):
        self.waits.append(delay)
        self.now += delay


class Response:
    def __init__(self, status=200, body=b"<html>notice</html>", **headers):
        self.status = status
        self.body = body
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"
        for name, value in headers.items():
            self.headers[name.replace("_", "-")] = value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return self.body[:limit]


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def open(self, request, timeout):
        self.urls.append(request.full_url)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class TransportTests(unittest.TestCase):
    def test_truncated_response_is_a_retryable_network_failure(self):
        class Truncated(Response):
            def read(self, limit):
                raise IncompleteRead(b"private-body", 10)
        client, _, _ = self.client([Truncated()])
        with self.assertRaises(CrawlFailure) as raised:
            client.html("https://itc.zju.edu.cn/90618/list.psp")
        self.assertEqual(str(raised.exception), "network_error")
        self.assertIsNotNone(client.last_finished)


    def client(self, responses, protected=False):
        clock = Clock()
        opener = Opener(responses)
        client = SlowClient("itc.zju.edu.cn", protected, opener=opener,
                            monotonic=clock.time, sleep=clock.sleep, wall_time=clock.time,
                            choose_delay=lambda low, high: low)
        return client, clock, opener

    def test_redirects_stay_https_and_obey_pacing_across_calls(self):
        client, clock, opener = self.client([
            Response(301, Location="http://itc.zju.edu.cn:80/c1a100/page.psp"), Response(), Response(),
        ])
        client.html("https://itc.zju.edu.cn/c1a100/page.htm")
        client.html("https://itc.zju.edu.cn/c1a101/page.htm")
        self.assertEqual(clock.waits, [15.0, 15.0])
        self.assertEqual(opener.urls[1], "https://itc.zju.edu.cn/c1a100/page.psp")
        self.assertEqual(client.request_count, 3)

    def test_auth_callback_is_not_followed_or_disclosed(self):
        for location in [
            "https://zjuam.zju.edu.cn/cas/login?ticket=SECRET",
            "https://itc.zju.edu.cn/90618/list.psp?ticket=SECRET",
        ]:
            client, _, opener = self.client([Response(302, Location=location)], True)
            with self.assertRaises(CrawlFailure) as raised:
                client.html("https://itc.zju.edu.cn/90618/list.psp")
            self.assertEqual(str(raised.exception), "auth_required")
            self.assertEqual(len(opener.urls), 1)

    def test_limit_and_network_errors_use_safe_codes(self):
        client, _, _ = self.client([Response(429, Retry_After="900")])
        with self.assertRaises(CrawlFailure) as raised:
            client.html("https://itc.zju.edu.cn/90618/list.psp")
        self.assertEqual(raised.exception.retry_after, 900)
        client, _, _ = self.client([URLError("private_password=SECRET")])
        with self.assertRaises(CrawlFailure) as raised:
            client.html("https://itc.zju.edu.cn/90618/list.psp")
        self.assertEqual(str(raised.exception), "network_error")
        client, _, _ = self.client([Response(body=b"x" * (MAX_HTML_BYTES + 1))])
        with self.assertRaises(CrawlFailure) as raised:
            client.html("https://itc.zju.edu.cn/90618/list.psp")
        self.assertEqual(str(raised.exception), "page_too_large")


LIST = "<div id='wp_news_w6'><ul>" + "".join(
    f"<li class='news'><span class='news_title'><a href='/c1a{number}/page.htm' "
    f"title='Notice {number}'>Notice</a></span><span class='news_meta'>2026-10-{number:02d}</span></li>"
    for number in range(1, 5)
) + "</ul></div>"
ARTICLE = "<h1 class='arti_title'>Full notice</h1><div class='wp_articlecontent'><p>正文内容</p></div>"


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "crawler-state.json"
        self.store = NoticeStore(self.path)
        self.clock = Clock()
        self.clients = []

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def factory(self, host, protected, session):
        parent = self

        class Client:
            request_count = 0
            last_finished = None
            failure = None

            def html(self, url):
                self.request_count += 1
                if self.failure:
                    raise self.failure
                parent.clock.now += 20
                self.last_finished = parent.clock.now
                return (LIST if "list.psp" in url else ARTICLE), url

        client = Client()
        self.clients.append(client)
        return client

    def engine(self, **kwargs):
        return CrawlEngine(self.store, ["yunfeng", "itc"], report=lambda text: None,
                           wall_time=self.clock.time, sleep=self.clock.sleep,
                           client_factory=self.factory, **kwargs)

    def test_missing_itc_auth_has_zero_requests_and_queue_resumes(self):
        engine = self.engine()
        rows = engine.run_once()
        self.assertEqual(rows[0]["detailsFetched"], 3)
        self.assertEqual(rows[1]["state"], "auth_required")
        self.assertEqual(rows[1]["requests"], 0)
        self.assertEqual(len(self.clients), 1)
        self.assertEqual(len(self.store.detail_jobs("yunfeng", self.clock.now)), 1)
        # The detail title differs from the list title. It must not cause all
        # three completed bodies to be queued again in the next list round.
        self.clock.now = 1300
        rows = engine.run_once()
        self.assertEqual(rows[0]["detailsFetched"], 1)
        self.assertEqual(rows[0]["new"], 0)
        self.assertEqual(len(self.store.export_items("yunfeng")), 4)

    def test_due_and_retry_after_survive_restarting_engine(self):
        engine = self.engine(detail_limit=0)
        engine.run_once()
        requests = self.clients[0].request_count
        engine.run_once()
        self.assertEqual(self.clients[0].request_count, requests)
        self.clock.now = 1300
        self.clients[0].failure = CrawlFailure("rate_limited", 900)
        rows = engine.run_once()
        self.assertEqual(rows[0]["state"], "backoff")
        restarted = self.engine(detail_limit=0)
        self.clock.now = 1600
        self.assertEqual(restarted.run_once()[0]["state"], "not_due")
        self.assertEqual(len(self.clients), 1)

    def test_overrun_is_delayed_without_catch_up(self):
        engine = self.engine(detail_limit=0)
        runtime = engine.runtimes["yunfeng"]
        client = engine._client(runtime, None)
        original = client.html

        def slow(url):
            self.clock.now += 400
            return original(url)

        client.html = slow
        engine.run_once()
        self.assertEqual(runtime.next_due, self.clock.now + 300)
        requests = client.request_count
        engine.run_once()
        self.assertEqual(client.request_count, requests)

    def test_lock_and_reserved_export_protect_state(self):
        with single_writer(Path(self.temp.name) / "crawler.lock"):
            with self.assertRaises(StorageError):
                with single_writer(Path(self.temp.name) / "crawler.lock"):
                    self.fail("two writers acquired the same lock")
        self.assertEqual(main(["--data-dir", self.temp.name, "export", "--output", str(self.path)]), 2)
        output = Path(self.temp.name) / "export.json"
        export_json(output, [])
        self.assertTrue(output.is_file())

    def test_expired_session_login_html_invalidates_auth_safely(self):
        class Provider:
            invalidated = False
            session = AuthSession(CookieJar())

            def session_for(self, source_id):
                return self.session

            def invalidate(self, source_id):
                self.invalidated = True
                raise RuntimeError("private_secret=SECRET")

        provider = Provider()
        reports = []

        def factory(host, protected, session):
            client = self.factory(host, protected, session)
            def login(url):
                client.request_count += 1
                return "<form><input name='username'><input type='password'></form>", url
            client.html = login
            return client

        engine = CrawlEngine(self.store, ["itc"], auth=provider, report=reports.append,
                             wall_time=self.clock.time, client_factory=factory)
        self.assertEqual(engine.run_once()[0]["state"], "auth_required")
        self.assertTrue(provider.invalidated)
        engine.close()
        self.assertNotIn("SECRET", " ".join(reports))
        self.assertEqual(self.store.status()["sources"][0]["lastError"], "auth_required")


if __name__ == "__main__":
    unittest.main()
