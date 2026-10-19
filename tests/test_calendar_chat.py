"""Calendar creation is a separate chat action from alarm scheduling."""

from pathlib import Path
import json
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.chat import ChatService
from notice_ai.schema import AIError


class CalendarChatTests(unittest.TestCase):
    def setUp(self):
        self.service = ChatService(SimpleNamespace(), SimpleNamespace())

    def test_create_calendar_item_is_idempotent_and_has_no_reminder(self):
        actions = []
        args = {"title": "交读书报告", "date": "2026-10-20"}
        first = self.service.execute("create_calendar_item", args, "bot", "request:calendar", actions)
        again = self.service.execute("create_calendar_item", args, "bot", "request:calendar", [])
        self.assertEqual(first["item"], again["item"])
        self.assertEqual(first["item"]["time"], "")
        self.assertEqual(actions[0]["name"], "calendar.upsert")
        self.assertEqual(actions[0]["args"]["completed"], False)

    def test_invalid_date_or_time_does_not_emit_an_action(self):
        for args in ({"title": "作业", "date": "2026-02-30"},
                     {"title": "作业", "date": "2026-10-20", "time": "25:00"},
                     {"title": " ", "date": "2026-10-20"}):
            actions = []
            with self.subTest(args=args), self.assertRaises(AIError):
                self.service.execute("create_calendar_item", args, "bot", "request:calendar", actions)
            self.assertEqual(actions, [])

    def test_conversation_offers_calendar_tool_and_returns_a_calendar_action(self):
        class Model:
            config = SimpleNamespace(configured=True, error=None)

            def __init__(self):
                self.calls = 0

            def complete(self, messages, *, tools=None):
                self.calls += 1
                if self.calls == 1:
                    names = {item["function"]["name"] for item in tools}
                    self_test.assertIn("create_calendar_item", names)
                    self_test.assertNotIn("create_reminder", names)
                    return {"content": None, "tool_calls": [{"id": "tool-1", "function": {
                        "name": "create_calendar_item", "arguments": json.dumps({"title": "交报告", "date": "2026-10-20"}),
                    }}]}
                return {"content": "已经加到日历。", "tool_calls": []}

        self_test = self
        model = Model()
        processor = SimpleNamespace(client=model, generation=0, stop=SimpleNamespace(is_set=lambda: False))
        runtime = SimpleNamespace(reminders=lambda: [], receipt=lambda _id: None, save_receipt=lambda _id, _value: None)
        service = ChatService(processor, runtime)
        response = service.respond({"text": "把交报告加到日历", "channelId": "bot", "requestId": "calendar-request-1"})
        self.assertEqual(model.calls, 2)
        self.assertEqual(response["events"][0]["name"], "calendar.upsert")
        self.assertEqual(response["events"][0]["args"]["date"], "2026-10-20")


if __name__ == "__main__":
    unittest.main()
