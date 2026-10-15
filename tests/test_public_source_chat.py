"""Registered public sources participate in local chat lookup without network calls."""

from pathlib import Path
import json
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from crawlers.sources import SOURCES
from notice_ai.chat import ChatService, TOOLS, notice_context_source
from notice_ai.schema import AIError
from notice_ai.bots import BotStore


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

    def test_registered_sources_have_real_channels_and_default_specialists(self):
        bots = BotStore()
        for identity in ('qsxy', 'bksy'):
            channel = bots.channel('src-' + identity)
            self.assertEqual(channel['kind'], 'source')
            self.assertEqual(channel['memberIds'], ['chief', 'bot-defaultnews', 'bot-defaultreminder'])

    def test_reminder_context_uses_its_new_source_instead_of_all_notices(self):
        service = self.service([notice('qsxy'), notice('bksy')])
        service.runtime = SimpleNamespace(reminders=lambda: [])
        reminder = service.bots.bot('bot-defaultreminder')
        for identity in ('qsxy', 'bksy'):
            messages, _ = service._messages({'channelId': 'src-' + identity}, reminder, '提醒一下报名截止')
            facts = next(row['content'] for row in messages if row['content'].startswith('当前通知资料'))
            self.assertIn('"sourceId": "' + identity + '"', facts)
            other = 'bksy' if identity == 'qsxy' else 'qsxy'
            self.assertNotIn('"sourceId": "' + other + '"', facts)

    def test_old_bot_state_gains_new_sources_once_and_preserves_custom_members(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bots.json'
            bots = BotStore(path)
            bots.set_members('src-itc', ['chief'])
            old = bots.state
            for identity in ('src-qsxy', 'src-bksy'):
                old['channels'].pop(identity)
            old['events'] = [row for row in old['events'] if row['channelId'] not in ('src-qsxy', 'src-bksy')]
            path.write_text(json.dumps(old), encoding='utf-8')
            restored = BotStore(path)
            self.assertEqual(restored.channel('src-itc')['memberIds'], ['chief'])
            self.assertEqual(restored.channel('src-qsxy')['memberIds'], ['chief', 'bot-defaultnews', 'bot-defaultreminder'])
            self.assertEqual(BotStore(path).events(), restored.events())

    def test_registered_sources_migrate_even_when_old_channel_capacity_is_full(self):
        for total in (199, 200):
            with self.subTest(total=total), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'bots.json'
                old = BotStore().state
                for identity in ('src-qsxy', 'src-bksy'):
                    old['channels'].pop(identity)
                old['events'] = [row for row in old['events'] if row['channelId'] not in ('src-qsxy', 'src-bksy')]
                for index in range(total - len(old['channels'])):
                    identity = 'src-group-legacy-' + str(index)
                    old['channels'][identity] = {'id': identity, 'kind': 'group', 'title': '保留的频道', 'memberIds': ['chief']}
                path.write_text(json.dumps(old), encoding='utf-8')
                restored = BotStore(path)
                self.assertTrue(set(old['channels']).issubset(restored.state['channels']))
                self.assertEqual(len(restored.state['channels']), total + 2)
                self.assertEqual(restored.channel('src-bksy')['memberIds'], ['chief', 'bot-defaultnews', 'bot-defaultreminder'])


if __name__ == "__main__":
    unittest.main()
