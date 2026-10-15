"""Registered public sources participate in local chat lookup without network calls."""

from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.sources import SOURCES
from notice_ai.chat import ChatService, TOOLS, notice_context_source
from notice_ai.schema import AIError


def notice(source_id, identity="1"):
    return {"id": f"{source_id}:{identity}", "sourceId": source_id, "title": "公开通知",
            "content": "网页正文", "publishedAt": "2026-10-15", "state": "complete",
            "url": f"https://{source_id}.zju.edu.cn/{identity}/page.htm"}


class PublicSourceChatTests(unittest.TestCase):
    def service(self, rows, allow_protected=False):
        processor = SimpleNamespace(
            config=SimpleNamespace(allow_protected=allow_protected),
            notices=SimpleNamespace(export_items=lambda source=None: [row for row in rows if source is None or row["sourceId"] == source]),
            analysis=lambda row: {"result": None},
        )
        return ChatService(processor, None)

    def test_registered_sources_are_exposed_by_tool_schema(self):
        search = next(tool for tool in TOOLS if tool["function"]["name"] == "search_notices")
        self.assertEqual(search["function"]["parameters"]["properties"]["sourceId"]["enum"], ["all", *SOURCES])
        self.assertIn("qsxy", SOURCES)
        self.assertIn("bksy", SOURCES)

    def test_public_sources_are_accessible_without_protected_permission(self):
        service = self.service([notice(source_id) for source_id in SOURCES])
        self.assertEqual(service.lookup("qsxy")["items"][0]["sourceId"], "qsxy")
        self.assertEqual(service.lookup("bksy")["items"][0]["sourceId"], "bksy")
        self.assertEqual({row["sourceId"] for row in service.lookup()["items"]},
                         {source_id for source_id, source in SOURCES.items() if not source.requires_auth})
        with self.assertRaises(AIError) as rejected:
            service.lookup("itc")
        self.assertEqual(rejected.exception.code, "protected_source_not_allowed")

    def test_permission_follows_source_metadata_for_future_sources(self):
        with patch.dict(SOURCES, {"future": SimpleNamespace(requires_auth=True)}):
            service = self.service([notice("future"), notice("bksy")])
            self.assertEqual(service.lookup()["returnedCount"], 1)
            with self.assertRaises(AIError):
                service.lookup("future")
            allowed = self.service([notice("future")], allow_protected=True)
            self.assertEqual(allowed.lookup("future")["returnedCount"], 1)

    def test_context_selects_channel_or_named_public_source(self):
        self.assertEqual(notice_context_source("src-qsxy", "有什么新消息"), "qsxy")
        self.assertEqual(notice_context_source("src-bksy", "帮我看看"), "bksy")
        self.assertEqual(notice_context_source("bot", "求是学院最近发了什么"), "qsxy")
        self.assertEqual(notice_context_source("bot", "本科生院最近发了什么"), "bksy")
        self.assertEqual(notice_context_source("bot", "BKsy 的消息"), "bksy")
        self.assertEqual(notice_context_source("bot", "看看通知"), "all")
        self.assertIsNone(notice_context_source("bot", "你好"))


if __name__ == "__main__":
    unittest.main()
