"""Offline persistence and scheduling checks for the two public sources."""

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.engine import CrawlEngine
from crawlers.storage import NoticeStore, StorageError
from local_service import LocalBackend


def item(number=1, *, link=False):
    return {
        "id": f"bksy:{number}", "title": f"公告 {number}", "publishedAt": "2026-10-13",
        "url": "https://example.edu/notice" if link else f"https://bksy.zju.edu.cn/c28418a{number}/page.htm",
        **({"fetchable": False, "qualityFlags": ["external_link"]} if link else {}),
    }


class PublicStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "crawler-state.json"
        self.store = NoticeStore(self.path)
        self.addCleanup(self.store.close)

    def test_links_persist_but_never_become_detail_jobs(self):
        self.store.sync_list("bksy", [item(), item(2, link=True)], 100)
        self.assertEqual([row["id"] for row in self.store.detail_jobs("bksy", 100)], ["bksy:1"])
        skipped = self.store.get_notice("bksy:2")
        self.assertEqual(skipped["state"], "skipped")
        self.assertFalse(skipped["fetchable"])
        self.assertIn("external_link", skipped["qualityFlags"])
        self.assertNotIn("pending_body", skipped["qualityFlags"])
        self.assertEqual(skipped["content"], "")
        restarted = NoticeStore(self.path)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.get_notice("bksy:2"), skipped)
        self.assertEqual(restarted.status()["sources"][0]["skippedCount"], 1)
        self.assertEqual(restarted.status()["sources"][0]["completeCount"], 0)
        with self.assertRaisesRegex(StorageError, "notice_not_fetchable"):
            restarted.save_detail("bksy", "bksy:2", {"content": "must not fetch"}, skipped["url"], 200)

    def test_link_changed_into_article_rejoins_queue_without_stale_flags(self):
        self.store.sync_list("bksy", [item(2, link=True)], 100)
        self.store.sync_list("bksy", [item(2)], 200)
        row = self.store.get_notice("bksy:2")
        self.assertEqual(row["state"], "pending")
        self.assertNotIn("external_link", row["qualityFlags"])
        self.assertNotIn("body_not_fetched", row["qualityFlags"])
        self.assertTrue(row.get("fetchable", True))
        self.assertEqual(len(self.store.detail_jobs("bksy", 200)), 1)


class PublicPipelineTests(unittest.TestCase):
    def test_homepage_only_round_is_incremental_and_external_link_is_not_requested(self):
        homepage = """<ul class="right-list">
          <li class="right-list-item"><a href="/2026/1013/c28418a101/page.htm"><p>普通通知</p><span class="time">2026-10-13</span></a></li>
          <li class="right-list-item"><a href="https://example.edu/notice"><p>外站通知</p><span class="time">2026-10-12</span></a></li>
        </ul>"""
        article = """<div class="article"><div class="article-title"><h3>普通通知</h3><div class="time">2026-10-13</div></div>
          <div class="wp_articlecontent"><p>这是公告的真实正文。</p></div></div>"""
        requested = []

        class FakeClient:
            request_count = 0
            last_finished = None
            def html(self, url):
                self.request_count += 1
                requested.append(url)
                return (homepage if url.endswith("list.htm") else article), url

        with tempfile.TemporaryDirectory() as directory:
            store = NoticeStore(Path(directory) / "crawler-state.json")
            engine = CrawlEngine(store, ["bksy"], detail_limit=1, report=lambda value: None,
                                 wall_time=lambda: 1000, client_factory=lambda *args, **kwargs: FakeClient())
            try:
                result = engine.run_once()[0]
                self.assertEqual(result["state"], "ready")
                self.assertEqual(result["listItems"], 2)
                self.assertEqual(result["linksOnly"], 1)
                self.assertEqual(result["detailsFetched"], 1)
                self.assertEqual(len(requested), 2)
                self.assertTrue(all("bksy.zju.edu.cn" in url for url in requested))
                self.assertFalse(any("list2" in url for url in requested))
                self.assertEqual(engine.run_once()[0]["state"], "not_due")
                self.assertEqual(len(requested), 2)
                self.assertEqual(store.get_notice("bksy:101")["content"], "这是公告的真实正文。")
            finally:
                engine.close()
                store.close()

    def test_api_has_all_four_titles_and_link_metadata_without_model_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = LocalBackend(root / "data", root / "auth", start_worker=False)
            try:
                backend.store.sync_list("bksy", [item(2, link=True)], 100)
                sources = {row["id"]: row for row in backend.source_status()["sources"]}
                self.assertEqual(set(sources), {"yunfeng", "itc", "qsxy", "bksy", "xzzd"})
                self.assertIn("本科生院", sources["bksy"]["title"])
                self.assertIn("求是学院", sources["qsxy"]["title"])
                self.assertFalse(sources["qsxy"]["requiresAuth"])
                self.assertEqual(sources["bksy"]["skippedCount"], 1)
                row = backend.notices("bksy")["items"][0]
                self.assertFalse(row["fetchable"])
                self.assertIn("external_link", row["qualityFlags"])
                self.assertEqual(row["analysis"]["state"], "waiting_body")
                self.assertFalse(backend.ai_settings.config.configured)
                updated = {**item(2, link=True), "title": "更新后的外站通知"}
                backend.store.sync_list("bksy", [updated], 200)
                refreshed = backend.notices("bksy")["items"][0]
                self.assertEqual(refreshed["title"], updated["title"])
                self.assertNotEqual(refreshed["revision"], row["revision"])
                backend.store.sync_list("bksy", [updated], 300)
                self.assertEqual(backend.notices("bksy")["items"][0]["revision"], refreshed["revision"])
            finally:
                backend.close()


if __name__ == "__main__":
    unittest.main()
