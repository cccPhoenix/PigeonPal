"""Configured model processing still cannot consume local homework."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.storage import NoticeStore
from notice_ai.config import AIConfig
from notice_ai.schema import AIError
from notice_ai.service import NoticeProcessor


class HomeworkModelBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.store = NoticeStore(root / "crawler-state.json")
        self.addCleanup(self.store.close)
        self.homework = {
            "activityId": "12", "courseId": "34", "courseName": "Synthetic course",
            "courseCode": "TEST", "openAt": None, "deadlineAt": None,
            "submissionStatus": "unknown", "isClosed": None,
        }
        item = {"id": "xzzd:12", "title": "Synthetic homework", "publishedAt": "",
                "url": "https://courses.zju.edu.cn/course/34/learning-activity#/12",
                "homework": self.homework}
        self.store.sync_list("xzzd", [item], 1000)
        self.store.save_detail("xzzd", item["id"], {**item, "content": "Synthetic requirements"}, item["url"], 1000)
        self.client = Mock()
        self.processor = NoticeProcessor(self.store, root / "notice-ai.json",
                                         AIConfig(api_key="synthetic-test-key"), client=self.client)
        self.addCleanup(self.processor.close)

    def test_background_skips_homework_even_with_configured_model(self):
        self.assertFalse(self.processor.run_once())
        self.client.analyze.assert_not_called()
        self.assertEqual(self.processor.status()["counts"]["local_only"], 1)
        self.assertEqual(self.processor.cache.records(), [])

    def test_explicit_submit_cannot_override_local_only_policy(self):
        with self.assertRaises(AIError) as rejected:
            self.processor.submit("xzzd:12", force=True)
        self.assertEqual(rejected.exception.code, "local_only_source")
        self.client.analyze.assert_not_called()
        self.assertEqual(self.processor.analysis(self.store.get_notice("xzzd:12"))["state"], "local_only")


if __name__ == "__main__":
    unittest.main()
