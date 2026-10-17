"""Model tools may neither read nor mutate homework-linked reminders."""

from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from notice_ai.chat import ChatService, model_reminder_allowed
from notice_ai.schema import AIError


def reminder(identity, channel="bot", notice=None, title=None):
    return {"id": identity, "channelId": channel, "noticeId": notice, "title": title or identity,
            "status": "pending", "deliveredAt": None, "dueAt": 2000000000000}


class FakeRuntime:
    def __init__(self, rows):
        self.rows = deepcopy(rows)
        self.calls = []

    def reminders(self):
        return deepcopy(self.rows)

    def update(self, identity, patch):
        self.calls.append((identity, patch))
        row = next(row for row in self.rows if row["id"] == identity)
        row.update(patch)
        return deepcopy(row)


class HomeworkChatBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime([
            reminder("ordinary", title="取快递"),
            reminder("channel-private", channel="src-xzzd", title="私有课程任务"),
            reminder("notice-private", notice="xzzd:123", title="私有迁移任务"),
        ])
        self.service = ChatService(SimpleNamespace(), self.runtime)

    def execute(self, name, args, actions=None):
        return self.service.execute(name, args, "bot", "test-action", [] if actions is None else actions)

    def test_mixed_listing_returns_only_normal_reminders_and_safe_count(self):
        result = self.execute("list_reminders", {"query": ""})
        self.assertEqual([row["id"] for row in result["reminders"]], ["ordinary"])
        self.assertEqual(result["matchingCount"], 1)
        self.assertTrue(model_reminder_allowed(result["reminders"][0]))
        self.assertEqual(self.execute("list_reminders", {"query": "不存在"}), {"reminders": [], "matchingCount": 0})

    def test_search_for_only_private_reminders_is_fixed_local_only_error(self):
        for query in ("私有课程", "私有迁移"):
            with self.subTest(query=query), self.assertRaises(AIError) as caught:
                self.execute("list_reminders", {"query": query})
            self.assertEqual(caught.exception.code, "local_only_source")

    def test_private_update_rejected_before_mutation_or_action(self):
        for identity in ("channel-private", "notice-private"):
            actions = []
            before = deepcopy(self.runtime.rows)
            with self.subTest(identity=identity), self.assertRaises(AIError) as caught:
                self.execute("update_reminder", {"reminderId": identity, "status": "done"}, actions)
            self.assertEqual(caught.exception.code, "local_only_source")
            self.assertEqual(self.runtime.rows, before)
            self.assertEqual(self.runtime.calls, [])
            self.assertEqual(actions, [])

    def test_normal_update_and_action_are_unchanged(self):
        actions = []
        result = self.execute("update_reminder", {"reminderId": "ordinary", "status": "done"}, actions)
        self.assertTrue(result["ok"])
        self.assertEqual(result["reminder"]["status"], "done")
        self.assertEqual(self.runtime.calls, [("ordinary", {"status": "done"})])
        self.assertEqual(actions[0]["name"], "reminder.upsert")
        self.assertEqual(actions[0]["args"]["id"], "ordinary")


if __name__ == "__main__":
    unittest.main()
