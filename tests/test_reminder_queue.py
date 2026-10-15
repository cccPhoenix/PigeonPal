"""Offline reminder scheduling checks; temporary files and a fixed local clock."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from notice_ai.runtime import RuntimeStore
from notice_ai.schema import AIError


class ReminderQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'runtime.json'
        self.clock = patch('notice_ai.runtime.time.time', return_value=1_900_000_000)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        self.runtime = RuntimeStore(self.path)

    def create(self, title, delay):
        return self.runtime.create(title, int(self.now.return_value * 1000 + delay))

    def test_due_delivery_order_and_single_delivery(self):
        late = self.create('较晚', 20000)
        early = self.create('较早', 10000)
        self.now.return_value += 30
        self.runtime.tick()
        self.runtime.tick()
        self.assertEqual([row['reminderId'] for row in self.runtime.events()['events']], [early['id'], late['id']])

    def test_idle_tick_does_not_scan_reminder_records(self):
        self.create('未来', 100000)
        class NoScan(dict):
            def values(self):
                raise AssertionError('idle tick scanned all reminders')
            def items(self):
                raise AssertionError('idle tick scanned all reminders')
            def __iter__(self):
                raise AssertionError('idle tick scanned all reminders')
        self.runtime.state['reminders'] = NoScan(self.runtime.state['reminders'])
        self.runtime.tick()

    def test_cancel_complete_and_postpone_invalidate_previous_due_entries(self):
        cancelled = self.create('取消', 1000)
        done = self.create('完成', 2000)
        postponed = self.create('推迟', 3000)
        self.runtime.update(cancelled['id'], {'status': 'cancelled'})
        self.runtime.update(done['id'], {'status': 'done'})
        self.runtime.update(postponed['id'], {'dueAt': int(self.now.return_value * 1000 + 10000)})
        self.now.return_value += 5
        self.runtime.tick()
        self.assertEqual(self.runtime.events()['events'], [])
        self.now.return_value += 6
        self.runtime.tick()
        self.assertEqual([row['reminderId'] for row in self.runtime.events()['events']], [postponed['id']])

    def test_snooze_rearms_once_and_restart_rebuilds_from_json(self):
        row = self.create('再提醒', 1000)
        self.now.return_value += 2
        self.runtime.tick()
        self.runtime.update(row['id'], {'dueAt': int(self.now.return_value * 1000 + 1000)})
        restored = RuntimeStore(self.path)
        self.now.return_value += 2
        restored.tick()
        restored.tick()
        events = restored.events()['events']
        self.assertEqual(len(events), 2)
        self.assertNotEqual(events[0]['id'], events[1]['id'])
        self.assertIsNotNone(restored.reminders()[0]['deliveredAt'])

    def test_failed_delivery_save_remains_retryable_without_duplicates(self):
        self.create('持久化后再发送', 1000)
        self.now.return_value += 2
        with patch('notice_ai.runtime._atomic_replace', side_effect=OSError('simulated disk failure')):
            with self.assertRaises(AIError):
                self.runtime.tick()
        self.assertIsNone(self.runtime.reminders()[0]['deliveredAt'])
        self.assertEqual(self.runtime.events()['events'], [])
        self.runtime.tick()
        self.runtime.tick()
        self.assertEqual(len(self.runtime.events()['events']), 1)

    def test_imported_overdue_reminder_enters_queue(self):
        self.runtime.import_legacy([{'id': 'old-reminder', 'title': '旧提醒', 'dueAt': int(self.now.return_value * 1000 - 1000)}])
        self.runtime.tick()
        self.assertEqual(self.runtime.events()['events'][0]['reminderId'], 'old-reminder')


if __name__ == '__main__':
    unittest.main()
