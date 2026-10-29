"""Offline regressions modelled on the verified academy WebPlus templates."""

from email.message import Message
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.engine import CrawlEngine
from crawlers.http import CrawlFailure, SlowClient, notice_url
from crawlers.sources import SOURCES, clean_detail, clean_list
from crawlers.storage import NoticeStore


def row(number=42, *, published="2026-10-29", host=""):
    return (f'<li class="news n1 clearfix"><span class="news_title">'
            f'<a href="{host}/2026/1029/c51432a{number}/page.htm" title="完整活动通知">短标题</a>'
            f'</span><span class="news_meta">{published}</span></li>')


def page(source_id):
    window = "wp_news_w6" if source_id == "danyang" else "wp_news_w51"
    return f'<div id="{window}"><ul class="news_list list2">{row()}</ul></div>'


ARTICLE = ('<h1 class="arti_title">活动报名通知</h1><h2 class="arti_title"></h2>'
           '<span class="arti_update">发布时间：2026-10-29</span>'
           '<div class="wp_articlecontent"><p>活动将于周五举行。</p>'
           '<p>请在周四前<a href="https://forms.example/join">填写报名表</a>。</p>'
           '<a href="/_upload/article/files/form.docx">报名表.docx</a></div>')


class AcademyParserTests(unittest.TestCase):
    def test_exact_notice_sections_exclude_other_widgets_and_external_sites(self):
        for source_id in ("danyang", "lantian"):
            source = SOURCES[source_id]
            window = "wp_news_w6" if source_id == "danyang" else "wp_news_w51"
            html = (f'<div id="wp_news_w53"><ul>{row(999)}</ul></div>'
                    f'<div id="{window}"><ul>{row()}{row()}{row(43, host="https://www.xgb.zju.edu.cn")}'
                    f'{row(44, host="https://evil.example")}</ul></div>')
            with self.subTest(source=source_id):
                items = clean_list(source, source.parse_list(html, source.url))
                self.assertEqual(len(items), 1)
                self.assertEqual(items[0]["id"], source_id + ":42")
                self.assertEqual(items[0]["title"], "完整活动通知")
                self.assertEqual(items[0]["publishedAt"], "2026-10-29")
                self.assertTrue(items[0]["url"].startswith(source.url.split(source.host)[0] + source.host))

    def test_pinned_older_notice_does_not_hide_current_notices(self):
        source = SOURCES["danyang"]
        html = f'<div id="wp_news_w6"><ul>{row(40, published="2024-10-11")}{row(42)}</ul></div>'
        items = source.parse_list(html, source.url)
        self.assertEqual([item["id"] for item in items], ["danyang:40", "danyang:42"])

    def test_unknown_empty_duplicate_container_and_invalid_dates_fail(self):
        for source_id in ("danyang", "lantian"):
            source = SOURCES[source_id]
            window = "wp_news_w6" if source_id == "danyang" else "wp_news_w51"
            for html in ("<html></html>", f'<div id="{window}"></div>', page(source_id) * 2,
                         f'<div id="{window}"><ul>{row(published="2026-02-30")}</ul></div>',
                         f'<div id="{window}"><ul>{row(published="10-29")}</ul></div>'):
                with self.subTest(source=source_id, html=html), self.assertRaises(ValueError):
                    source.parse_list(html, source.url)

    def test_detail_keeps_body_attachment_and_registration_link(self):
        for source_id in ("danyang", "lantian"):
            source = SOURCES[source_id]
            with self.subTest(source=source_id):
                detail = clean_detail(source.parse_article(ARTICLE, source.url))
                self.assertEqual(detail["title"], "活动报名通知")
                self.assertEqual(detail["publishedAt"], "2026-10-29")
                self.assertIn("请在周四前填写报名表", detail["content"])
                self.assertEqual(len(detail["attachments"]), 1)
                self.assertEqual(detail["attachments"][0]["name"], "报名表.docx")

    def test_crawler_and_storage_accept_both_sources_without_auth(self):
        class Client:
            request_count = 0
            last_finished = None

            def __init__(self, host, protected, session, **options):
                self.source_id = next(key for key, source in SOURCES.items() if source.host == host)
                self.no_auth = not protected and session is None

            def html(self, url):
                self.request_count += 1
                source = SOURCES[self.source_id]
                return (page(self.source_id) if url == source.url else ARTICLE), url

        with tempfile.TemporaryDirectory() as folder:
            store = NoticeStore(Path(folder) / "notices.json")
            engine = CrawlEngine(store, ["danyang", "lantian"], client_factory=Client, report=lambda text: None)
            try:
                results = engine.run_once()
                self.assertEqual([result["state"] for result in results], ["ready", "ready"])
                self.assertEqual([result["detailsFetched"] for result in results], [1, 1])
                self.assertEqual({item["sourceId"] for item in store.export_items()}, {"danyang", "lantian"})
                self.assertTrue(all(runtime.client.no_auth for runtime in engine.runtimes.values()))
                self.assertTrue(all(item["content"] for item in store.export_items()))
            finally:
                engine.close()
                store.close()


class PublicHttpTests(unittest.TestCase):
    def test_only_public_lantian_http_is_preserved(self):
        for host, allowed, expected in (("lantian", True, "http"), ("lantian", False, "https")):
            self.assertEqual(notice_url(f"http://{host}.zju.edu.cn/a.htm", f"{host}.zju.edu.cn", allow_http=allowed),
                             f"{expected}://{host}.zju.edu.cn/a.htm")
        with self.assertRaises(CrawlFailure):
            notice_url("http://itc.zju.edu.cn/a.htm", "itc.zju.edu.cn", allow_http=True)
        for url in ("http://lantian.zju.edu.cn/a.htm?ticket=secret", "http://user@lantian.zju.edu.cn/a.htm",
                    "http://lantian.zju.edu.cn.evil.example/a.htm"):
            with self.assertRaises(CrawlFailure):
                notice_url(url, "lantian.zju.edu.cn", allow_http=True)

    def test_transport_uses_http_only_for_public_requests(self):
        class Response:
            status = 200
            headers = Message()
            headers["Content-Type"] = "text/html; charset=utf-8"
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b"<html>public</html>"

        class Opener:
            def __init__(self): self.urls = []
            def open(self, request, timeout):
                self.urls.append(request.full_url)
                return Response()

        for protected, scheme in ((False, "http"), (True, "https")):
            opener = Opener()
            client = SlowClient("lantian.zju.edu.cn", protected, allow_http=not protected, opener=opener)
            client.html("http://lantian.zju.edu.cn/ltoffice/main.htm")
            self.assertEqual(opener.urls[-1], f"{scheme}://lantian.zju.edu.cn/ltoffice/main.htm")


if __name__ == "__main__":
    unittest.main()
