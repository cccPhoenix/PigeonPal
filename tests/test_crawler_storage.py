"""Offline checks for persistent queues, incremental updates and safe recovery."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.crawlers.storage import NoticeStore, StorageError


def notice(number=1, title="列表标题", date="2026-10-14"):
    return {"id": f"yunfeng:{number}", "title": title, "publishedAt": date, "url": f"https://yunfeng.zju.edu.cn/{number}/page.htm"}


def detail(content="第一段正文\n第二段正文", title="正文完整标题"):
    return {"title": title, "publishedAt": "2026-10-14", "publisher": "学院", "content": content, "attachments": [{"name": "通知.pdf", "url": "https://yunfeng.zju.edu.cn/_upload/article/files/notice.pdf"}]}


class NoticeStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "portable" / "crawler-state.json"
        self.store = NoticeStore(self.path)

    def test_reads_do_not_create_files_and_restart_keeps_queue(self):
        self.assertEqual(self.store.status()["totalItems"], 0)
        self.assertEqual(self.store.export_items(), [])
        self.assertFalse(self.path.parent.exists())
        self.store.sync_list("yunfeng", [notice(), notice(), notice(2)], 100)
        self.assertTrue(self.path.with_name(self.path.name + ".bak").exists())
        self.store.close()
        restarted = NoticeStore(self.path)
        self.assertEqual(len(restarted.detail_jobs("yunfeng", 100)), 2)
        self.assertEqual(restarted.get_notice("yunfeng:1")["qualityFlags"], ["pending_body"])
        self.assertEqual(restarted.get_notice("yunfeng:1")["firstSeenAt"], "1970-01-01T00:01:40Z")

    def test_listing_metadata_does_not_conflict_with_full_body_title(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        self.assertTrue(self.store.save_detail("yunfeng", "yunfeng:1", detail(), "https://yunfeng.zju.edu.cn/1/page.psp", 120))
        summary = self.store.sync_list("yunfeng", [notice()], 300)
        self.assertEqual(summary, {"new": 0, "changed": 0, "total": 1})
        self.assertEqual(self.store.detail_jobs("yunfeng", 300), [])
        self.assertEqual(self.store.get_notice("yunfeng:1")["title"], "正文完整标题")
        self.store.sync_list("yunfeng", [notice(title="列表改名")], 600)
        row = self.store.get_notice("yunfeng:1")
        self.assertEqual(row["state"], "pending")
        self.assertEqual(row["content"], detail()["content"])
        self.assertEqual(row["version"], 1)
        self.assertEqual(len(self.store.detail_jobs("yunfeng", 600)), 1)

    def test_content_hash_and_failed_fetch_preserve_previous_success(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        final_url = "https://yunfeng.zju.edu.cn/1/page.psp"
        self.store.save_detail("yunfeng", "yunfeng:1", detail(), final_url, 120)
        previous_hash = self.store.get_notice("yunfeng:1")["contentHash"]
        self.assertFalse(self.store.save_detail("yunfeng", "yunfeng:1", detail(), final_url, 300))
        row = self.store.get_notice("yunfeng:1")
        self.assertEqual(row["version"], 1)
        self.assertEqual(row["lastFetchedAt"], "1970-01-01T00:05:00Z")
        self.assertTrue(self.store.save_detail("yunfeng", "yunfeng:1", detail("修订正文"), final_url, 400))
        row = self.store.get_notice("yunfeng:1")
        self.assertEqual(row["version"], 2)
        self.assertNotEqual(row["contentHash"], previous_hash)
        self.assertFalse(self.store.save_detail("yunfeng", "yunfeng:1", detail(" "), final_url, 500))
        row = self.store.get_notice("yunfeng:1")
        self.assertEqual(row["content"], "修订正文")
        self.assertEqual(row["version"], 2)
        self.assertIn("body_failed", row["qualityFlags"])
        self.assertIn("has_attachments", row["qualityFlags"])
        self.assertEqual(self.store.detail_jobs("yunfeng", 4099), [])
        self.assertEqual(len(self.store.detail_jobs("yunfeng", 4100)), 1)
        self.store.fail_detail("yunfeng", "yunfeng:1", "http_error", 4100)
        self.assertEqual(self.store.detail_jobs("yunfeng", 11299), [])
        self.assertEqual(len(self.store.detail_jobs("yunfeng", 11300)), 1)

    def test_jobs_prioritize_pending_and_limit_latest_page_rechecks(self):
        self.store.sync_list("yunfeng", [notice(i) for i in range(1, 5)], 100)
        for i in range(1, 4):
            self.store.save_detail("yunfeng", f"yunfeng:{i}", detail(), f"https://yunfeng.zju.edu.cn/{i}/page.psp", 120)
        self.store.sync_list("yunfeng", [notice(2), notice(3), notice(4)], 200)
        restarted = NoticeStore(self.path)
        jobs = restarted.detail_jobs("yunfeng", 90000, limit=3)
        self.assertEqual(jobs[0]["id"], "yunfeng:4")
        self.assertEqual(len(jobs), 2)
        self.assertNotIn("yunfeng:1", {job["id"] for job in jobs})
        self.assertEqual(len(restarted.export_items()), 4)

    def test_corrupt_main_recovers_backup_without_rewriting_during_read(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        self.store.save_detail("yunfeng", "yunfeng:1", detail(), "https://yunfeng.zju.edu.cn/1/page.psp", 120)
        backup = self.path.with_name(self.path.name + ".bak")
        valid_backup = backup.read_bytes()
        self.path.write_bytes(b"{broken")
        recovered = NoticeStore(self.path)
        self.assertTrue(recovered.status()["recoveredFromBackup"])
        self.assertEqual(recovered.get_notice("yunfeng:1")["state"], "pending")
        self.assertEqual(self.path.read_bytes(), b"{broken")
        recovered.set_source_status("yunfeng", "ready", 200)
        self.assertEqual(backup.read_bytes(), valid_backup)
        self.assertEqual(json.loads(self.path.read_text("utf-8"))["schemaVersion"], 1)
        self.path.write_bytes(b"broken")
        backup.write_bytes(b"broken")
        with self.assertRaisesRegex(StorageError, "invalid_state_file"):
            NoticeStore(self.path)

    def test_failed_atomic_replace_leaves_disk_and_memory_unchanged(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        original = self.path.read_bytes()
        import scripts.crawlers.storage as storage
        replace = storage.os.replace

        def fail_main(source, target):
            if Path(target) == self.path:
                raise OSError("simulated interrupted write")
            return replace(source, target)

        with patch.object(storage.os, "replace", side_effect=fail_main):
            with self.assertRaisesRegex(StorageError, "state_write_failed"):
                self.store.sync_list("yunfeng", [notice(), notice(2)], 200)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.store.status()["totalItems"], 1)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_damaged_structure_uses_valid_backup_before_reading_queue(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        self.store.set_source_status("yunfeng", "ready", 120)
        original = json.loads(self.path.read_text("utf-8"))
        for damage in ("isLatest", "images", "sourceState", "qualityFlags", "listMetadata"):
            with self.subTest(damage=damage):
                state = json.loads(json.dumps(original))
                row = next(iter(state["notices"].values()))
                if damage == "isLatest":
                    row.pop("isLatest")
                elif damage == "images":
                    row["images"] = [{"url": "https://yunfeng.zju.edu.cn/image.png"}]
                elif damage == "sourceState":
                    state["sources"]["yunfeng"]["state"] = {"bad": True}
                elif damage == "qualityFlags":
                    row["qualityFlags"] = ["https://example.com?ticket=SECRET"]
                else:
                    row["listMetadata"].pop("publishedAt")
                self.path.write_text(json.dumps(state), encoding="utf-8")
                recovered = NoticeStore(self.path)
                self.assertTrue(recovered.status()["recoveredFromBackup"])
                self.assertEqual(len(recovered.detail_jobs("yunfeng", 200)), 1)

    def test_unknown_schema_is_not_silently_cleared(self):
        self.path.parent.mkdir()
        self.path.write_text('{"schemaVersion": 99}', encoding="utf-8")
        with self.assertRaisesRegex(StorageError, "unsupported_state_schema"):
            NoticeStore(self.path)
        self.path.write_text('{"schemaVersion": 1, "sources": {}, "notices": {"bad": {}}, "runs": []}', encoding="utf-8")
        with self.assertRaisesRegex(StorageError, "invalid_state_file"):
            NoticeStore(self.path)
        self.path.write_text('{"schemaVersion": 1, "sources": {}, "notices": {}, "runs": [], "bad": NaN}', encoding="utf-8")
        with self.assertRaisesRegex(StorageError, "invalid_state_file"):
            NoticeStore(self.path)

    def test_source_isolation_and_redacted_error_codes(self):
        self.store.sync_list("yunfeng", [notice()], 100)
        self.store.sync_list("other", [notice()], 100)
        self.assertEqual(len(self.store.export_items("other")), 1)
        with self.assertRaisesRegex(StorageError, "ambiguous_notice_id"):
            self.store.get_notice("yunfeng:1")
        self.store.fail_detail("yunfeng", "yunfeng:1", "https://example.com?ticket=SECRET", 200)
        self.assertNotIn("SECRET", self.path.read_text("utf-8"))
        self.assertEqual(self.store.export_items("yunfeng")[0]["lastError"], "unspecified_error")
        for url in ("https://yunfeng.zju.edu.cn/page?authcode=SECRET", "https://yunfeng.zju.edu.cn/page;jsessionid=SECRET", "https://yunfeng.zju.edu.cn/page#access_token=SECRET"):
            with self.subTest(url=url):
                unsafe = {**notice(2), "url": url}
                with self.assertRaisesRegex(StorageError, "invalid_notice_url"):
                    self.store.sync_list("yunfeng", [unsafe], 300)
        with self.assertRaisesRegex(StorageError, "invalid_source_id"):
            self.store.sync_list("https://example.com", [notice()], 300)


if __name__ == "__main__":
    unittest.main()
