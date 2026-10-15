"""Offline public-source transport and metadata boundaries."""

from email.message import Message
from http.cookiejar import CookieJar
from pathlib import Path
import sys
import unittest
from urllib.request import HTTPCookieProcessor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.auth import AuthSession
from crawlers.http import CrawlFailure, SlowClient, notice_url
from crawlers.sources import SOURCES, clean_detail, clean_list


class Response:
    def __init__(self, status=200, location=None):
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"
        if location:
            self.headers["Location"] = location

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return b"<html>public notice</html>"


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def open(self, request, timeout):
        self.urls.append(request.full_url)
        return self.responses.pop(0)


class PublicTransportTests(unittest.TestCase):
    def client(self, responses):
        self.now = 0
        self.waits = []
        opener = Opener(responses)

        def sleep(delay):
            self.waits.append(delay)
            self.now += delay

        client = SlowClient("qsxy.zju.edu.cn", allow_http=True, opener=opener,
                            monotonic=lambda: self.now, sleep=sleep,
                            choose_delay=lambda low, high: low)
        return client, opener

    def test_only_explicit_public_qsxy_opt_in_preserves_http(self):
        url = "http://qsxy.zju.edu.cn:80/30845/list.psp"
        self.assertEqual(notice_url(url, "qsxy.zju.edu.cn", allow_http=True),
                         "http://qsxy.zju.edu.cn/30845/list.psp")
        self.assertEqual(notice_url(url, "qsxy.zju.edu.cn"),
                         "https://qsxy.zju.edu.cn/30845/list.psp")
        self.assertEqual(notice_url("https://qsxy.zju.edu.cn:443/page.htm", "qsxy.zju.edu.cn", allow_http=True),
                         "https://qsxy.zju.edu.cn/page.htm")
        for url in ("http://qsxy.zju.edu.cn:443/page.htm", "https://qsxy.zju.edu.cn:80/page.htm"):
            with self.assertRaises(CrawlFailure):
                notice_url(url, "qsxy.zju.edu.cn", allow_http=True)
        for host in ("itc.zju.edu.cn", "bksy.zju.edu.cn", "qsxy.zju.edu.cn.evil.example"):
            with self.assertRaises(CrawlFailure):
                notice_url(f"http://{host}/page.htm", host, allow_http=True)
            with self.assertRaises(CrawlFailure):
                SlowClient(host, allow_http=True)

    def test_http_opt_in_refuses_protected_or_cookie_session(self):
        for kwargs in ({"protected": True}, {"session": AuthSession(CookieJar())}):
            with self.assertRaisesRegex(CrawlFailure, "invalid_transport_policy"):
                SlowClient("qsxy.zju.edu.cn", allow_http=True, **kwargs)
        client = SlowClient("qsxy.zju.edu.cn", allow_http=True)
        self.assertFalse(any(isinstance(handler, HTTPCookieProcessor) for handler in client.opener.handlers))

    def test_http_redirects_remain_scoped_and_paced(self):
        client, opener = self.client([
            Response(302, "http://qsxy.zju.edu.cn/article.htm"),
            Response(301, "https://qsxy.zju.edu.cn/article.htm"), Response(), Response(),
        ])
        client.html("http://qsxy.zju.edu.cn/30845/list.psp")
        client.html("https://qsxy.zju.edu.cn/next.htm")
        self.assertEqual(self.waits, [15.0, 15.0, 15.0])
        self.assertEqual(opener.urls, [
            "http://qsxy.zju.edu.cn/30845/list.psp", "http://qsxy.zju.edu.cn/article.htm",
            "https://qsxy.zju.edu.cn/article.htm", "https://qsxy.zju.edu.cn/next.htm",
        ])

    def test_external_auth_or_query_redirect_is_never_requested(self):
        for target in (
            "http://outside.example/article.htm", "https://qsxy.zju.edu.cn.evil.example/article.htm",
            "https://zjuam.zju.edu.cn/cas/login", "http://qsxy.zju.edu.cn/article.htm?ticket=SECRET",
            "http://qsxy.zju.edu.cn/article.htm?page=2", "http://qsxy.zju.edu.cn:9999/article.htm",
            "http://@qsxy.zju.edu.cn/article.htm",
        ):
            with self.subTest(target=target):
                client, opener = self.client([Response(302, target)])
                with self.assertRaises(CrawlFailure) as caught:
                    client.html("http://qsxy.zju.edu.cn/30845/list.psp")
                self.assertEqual(len(opener.urls), 1)
                self.assertNotIn("SECRET", str(caught.exception))


class PublicMetadataTests(unittest.TestCase):
    def row(self, source_id="qsxy", **kwargs):
        return {"id": f"{source_id}:42", "title": "通知标题", "publishedAt": "2026-10-15",
                "url": f"http://{source_id}.zju.edu.cn/c1a42/page.htm", **kwargs}

    def test_registered_sources_are_public_and_old_shapes_remain_small(self):
        self.assertTrue(SOURCES["qsxy"].allow_http)
        self.assertFalse(SOURCES["qsxy"].requires_auth)
        self.assertFalse(SOURCES["bksy"].allow_http)
        self.assertFalse(SOURCES["bksy"].requires_auth)
        self.assertTrue(all(source.title for source in SOURCES.values()))
        row = self.row()
        self.assertEqual(clean_list(SOURCES["qsxy"], [row]), [row])
        bksy = clean_list(SOURCES["bksy"], [self.row("bksy")])[0]
        self.assertEqual(bksy["url"], "https://bksy.zju.edu.cn/c1a42/page.htm")
        self.assertNotIn("fetchable", bksy)
        self.assertNotIn("qualityFlags", bksy)

    def test_special_links_are_metadata_only_for_new_public_sources(self):
        for source_id in ("qsxy", "bksy"):
            row = self.row(source_id, url="https://forms.example.edu/app?id=42", fetchable=False,
                           qualityFlags=["external_link", "external_link"])
            result = clean_list(SOURCES[source_id], [row])[0]
            self.assertFalse(result["fetchable"])
            self.assertEqual(result["url"], row["url"])
            self.assertEqual(result["qualityFlags"], ["external_link"])
        for source_id in ("yunfeng", "itc"):
            with self.assertRaises(CrawlFailure):
                clean_list(SOURCES[source_id], [self.row(source_id, fetchable=False)])
        with self.assertRaises(CrawlFailure):
            clean_list(SOURCES["qsxy"], [self.row(url="https://outside.example/article.htm")])

    def test_special_links_reject_secret_fragments_credentials_ports_and_schemes(self):
        for url in (
            "https://forms.example.edu/app?TOKEN=SECRET", "https://forms.example.edu/app#secret",
            "https://forms.example.edu/app#", "https://user:pass@forms.example.edu/app",
            "http://@forms.example.edu/app", "https://forms.example.edu:80/app",
            "http://forms.example.edu:443/app", "https://forms.example.edu:99999/app",
            "javascript:alert(1)", "file:///C:/private", "https://forms.example.edu/a;jsessionid=secret",
            "https://forms.example.edu/a%3bjsessionid%3dsecret", "https://forms.example.edu/app?ticket=",
        ):
            with self.subTest(url=url):
                with self.assertRaises(CrawlFailure) as caught:
                    clean_list(SOURCES["qsxy"], [self.row(url=url, fetchable=False)])
                self.assertNotIn("SECRET", str(caught.exception))

    def test_public_missing_dates_are_marked_without_invention(self):
        for source_id in ("qsxy", "bksy"):
            result = clean_list(SOURCES[source_id], [self.row(source_id, publishedAt="")])[0]
            self.assertEqual(result["publishedAt"], "")
            self.assertEqual(result["qualityFlags"], ["publication_date_missing"])
            with self.assertRaisesRegex(CrawlFailure, "invalid_list_date"):
                clean_list(SOURCES[source_id], [self.row(source_id, publishedAt="2026-02-30")])

    def test_images_are_references_and_empty_special_bodies_fail_explicitly(self):
        result = clean_detail({"title": "标题", "content": "正文", "images": [
            "https://bksy.zju.edu.cn/image.png", {"url": "https://bksy.zju.edu.cn/image.png"},
            "https://bksy.zju.edu.cn/private.png?token=SECRET", "http://image.example:443/file.png",
        ], "attachments": [{"name": "附件", "url": "https://bksy.zju.edu.cn/file.docx"}]})
        self.assertEqual(result["images"], ["https://bksy.zju.edu.cn/image.png"])
        self.assertIn("image_link_redacted", result["qualityFlags"])
        self.assertEqual(len(result["attachments"]), 1)
        for flags, code in ((["image_only"], "image_only_article"),
                            (["attachment_only"], "attachment_only_article"), ([], "empty_article_body")):
            with self.assertRaisesRegex(CrawlFailure, code):
                clean_detail({"title": "标题", "content": "", "qualityFlags": flags})


if __name__ == "__main__":
    unittest.main()
