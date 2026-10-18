"""An attached notice reaches the model as a bounded, single source of context."""

import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.chat import ChatService
from notice_ai.schema import AIError


class Model:
    config = SimpleNamespace(configured=True, error=None)

    def __init__(self):
        self.messages = None

    def complete(self, messages, *, tools=None):
        self.messages = messages
        return {"content": "这是通知的主要内容。", "tool_calls": []}


class Runtime:
    def receipt(self, request_id):
        return None

    def reminders(self):
        return []

    def save_receipt(self, request_id, row):
        pass


class AttachedChatTests(unittest.TestCase):
    def service(self, content, state="complete"):
        row = {"id": "yunfeng:1", "sourceId": "yunfeng", "title": "讲座通知",
               "publishedAt": "2026-10-18", "url": "https://yunfeng.zju.edu.cn/1.htm",
               "content": content, "state": state, "attachments": []}
        model = Model()
        notices = SimpleNamespace(get_notice=lambda notice_id: row if notice_id == row["id"] else None,
                                  export_items=lambda source=None: self.fail("attachment should not load the notice snapshot"))
        processor = SimpleNamespace(notices=notices, _allowed=lambda notice: None,
                                    config=SimpleNamespace(allow_protected=True), client=model,
                                    generation=0, stop=SimpleNamespace(is_set=lambda: False))
        return ChatService(processor, Runtime()), model

    def test_attached_notice_is_sent_once_with_a_bounded_excerpt(self):
        service, model = self.service("开头" + "中" * 20000 + "结尾")
        result = service.respond({"text": "这条通知讲什么？", "channelId": "bot",
                                  "requestId": "request123", "noticeId": "yunfeng:1"})
        self.assertEqual(result["events"][-1]["text"], "这是通知的主要内容。")
        self.assertEqual(len(model.messages), 3)
        attached = json.loads(model.messages[1]["content"].split("：", 1)[1])
        self.assertTrue(attached["contentTruncated"])
        self.assertIn("开头", attached["content"])
        self.assertIn("结尾", attached["content"])
        self.assertLess(len(attached["content"]), 13000)

    def test_incomplete_notice_has_a_specific_error(self):
        service, _ = self.service("", state="pending")
        with self.assertRaises(AIError) as error:
            service.respond({"text": "看看通知", "channelId": "bot",
                             "requestId": "request124", "noticeId": "yunfeng:1"})
        self.assertEqual(error.exception.code, "notice_body_unavailable")


if __name__ == "__main__":
    unittest.main()
