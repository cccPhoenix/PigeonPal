"""Local six-hour delivery checks using synthetic data and a fixed clock."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from notice_ai.runtime import RuntimeStore
from notice_ai.homework import reconcile_homework

DEADLINE = '2030-03-18T16:00:00+08:00'
from datetime import datetime
STAMP = int(datetime.fromisoformat(DEADLINE).timestamp() * 1000)
HOUR = 3600000


def notice(**fields):
    metadata = dict(activityId='12', courseId='3', courseName='测试课程', courseCode='TEST', openAt=None,
                    deadlineAt=DEADLINE, submissionStatus='not_submitted', isClosed=False)
    metadata.update(fields)
    return dict(id='xzzd:12', sourceId='xzzd', title='测试作业', homework=metadata)


class HomeworkDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.clock = patch('notice_ai.runtime.time.time', return_value=(STAMP - 8 * HOUR) / 1000)
        self.now = self.clock.start(); self.addCleanup(self.clock.stop)
        self.path = Path(self.tmp.name) / 'runtime.json'
        self.runtime = RuntimeStore(self.path)

    def sync(self, row=None):
        reconcile_homework(self.runtime, [row or notice()])

    def test_delivers_once_exactly_six_hours_before_deadline_and_survives_restart(self):
        self.sync(); self.sync()
        reminder = self.runtime.reminders()[0]
        self.assertEqual(reminder['dueAt'], STAMP - 6 * HOUR)
        self.runtime.tick(); self.assertEqual(self.runtime.events()['events'], [])
        self.now.return_value = (STAMP - 6 * HOUR) / 1000
        self.runtime.tick(); self.runtime.tick()
        event = self.runtime.events()['events'][0]
        self.assertEqual(event['item']['homework']['courseName'], '测试课程')
        self.assertEqual(event['item']['noticeId'], 'xzzd:12')
        self.assertEqual(event['channelId'], 'src-xzzd')
        restored = RuntimeStore(self.path)
        reconcile_homework(restored, [notice()]); restored.tick()
        self.assertEqual(len(restored.events()['events']), 1)

    def test_first_seen_inside_six_hours_catches_up_but_expired_never_fires(self):
        self.now.return_value = (STAMP - HOUR) / 1000
        self.sync(); self.runtime.tick()
        self.assertEqual(len(self.runtime.events()['events']), 1)
        other = RuntimeStore(Path(self.tmp.name) / 'expired.json')
        self.now.return_value = STAMP / 1000
        reconcile_homework(other, [notice()]); other.tick()
        self.assertEqual(other.events()['events'], [])

    def test_ineligible_and_date_only_deadlines_are_not_guessed(self):
        for fields in [dict(deadlineAt=None), dict(deadlineAt='2030-03-18'),
                       dict(submissionStatus='submitted'), dict(isClosed=True)]:
            self.sync(notice(**fields))
        self.assertEqual(self.runtime.reminders(), [])

    def test_unknown_submission_state_remains_eligible(self):
        self.sync(notice(submissionStatus='unknown'))
        self.assertEqual(len(self.runtime.reminders()), 1)

    def test_metadata_update_cancels_or_reschedules_existing_queue(self):
        self.sync()
        self.sync(notice(deadlineAt='2030-03-19T16:00:00+08:00'))
        self.now.return_value = (STAMP - 6 * HOUR) / 1000
        self.runtime.tick(); self.assertEqual(self.runtime.events()['events'], [])
        self.sync(notice(submissionStatus='submitted'))
        self.now.return_value += 24 * 3600
        self.runtime.tick(); self.assertEqual(self.runtime.events()['events'], [])

    def test_expiration_without_reconcile_does_not_send_stale_message(self):
        self.sync(); self.now.return_value = (STAMP + HOUR) / 1000
        self.runtime.tick(); self.assertEqual(self.runtime.events()['events'], [])

    def test_latest_local_submission_is_checked_before_delivery(self):
        self.sync(); self.now.return_value = (STAMP - HOUR) / 1000
        self.runtime.tick(homework_lookup=lambda key: notice(submissionStatus='submitted'))
        self.assertEqual(self.runtime.events()['events'], [])

    def test_changed_deadline_checked_at_dispatch_defers_old_queue(self):
        self.sync(); self.now.return_value = (STAMP - HOUR) / 1000
        self.runtime.tick(homework_lookup=lambda key: notice(deadlineAt='2030-03-19T16:00:00+08:00'))
        self.assertEqual(self.runtime.events()['events'], [])

    def test_manual_cancellation_and_manual_reminders_are_respected(self):
        self.sync(); row = self.runtime.reminders()[0]
        self.runtime.update(row['id'], {'status': 'cancelled'})
        self.runtime.create('手工提醒', STAMP - HOUR, 'src-xzzd', 'xzzd:12')
        self.sync()
        self.assertEqual(self.runtime.reminders()[0]['status'], 'cancelled')
        self.assertEqual(len(self.runtime.reminders()), 2)

    def test_no_changes_do_not_rewrite_runtime_file(self):
        self.sync()
        with patch.object(self.runtime, 'commit', side_effect=AssertionError('unexpected write')):
            self.sync()

    def test_failed_dispatch_reconcile_keeps_original_due_entry_retryable(self):
        from notice_ai.schema import AIError
        self.sync(); self.now.return_value = (STAMP - HOUR) / 1000
        changed = notice(); changed['title'] = '新标题'
        with patch('notice_ai.runtime._atomic_replace', side_effect=OSError('disk failure')):
            with self.assertRaises(AIError):
                self.runtime.tick(homework_lookup=lambda key: changed)
        self.assertEqual(self.runtime.events()['events'], [])
        self.runtime.tick(homework_lookup=lambda key: changed)
        self.assertEqual(len(self.runtime.events()['events']), 1)

    def test_same_deadline_title_change_does_not_send_twice(self):
        self.sync(); self.now.return_value = (STAMP - HOUR) / 1000
        self.runtime.tick()
        changed = notice(); changed['title'] = '更新标题'
        self.sync(changed); self.runtime.tick()
        self.assertEqual(len(self.runtime.events()['events']), 1)

    def test_paginated_homework_api_uses_the_same_descending_order(self):
        from types import SimpleNamespace
        from local_service import LocalBackend
        rows = []
        for index, deadline in enumerate(['2030-03-18', None, DEADLINE, '2030-03-19T16:00:00+08:00']):
            row = notice(deadlineAt=deadline)
            row.update(id=f'xzzd:{index+1}', url='https://courses.zju.edu.cn/', publishedAt='', state='pending',
                       version=1, contentHash='', lastChangedAt='', firstSeenAt='')
            rows.append(row)
        backend = LocalBackend.__new__(LocalBackend)
        backend.store = SimpleNamespace(export_items=lambda source: rows)
        backend.ai = SimpleNamespace(analysis=lambda row: {'state': 'local_only'})
        first, second = backend.notices('xzzd', limit=2), backend.notices('xzzd', limit=2, offset=2)
        self.assertEqual([row['id'] for row in first['items'] + second['items']], ['xzzd:4', 'xzzd:3', 'xzzd:1', 'xzzd:2'])

    def test_explicit_manual_postpone_can_cross_original_homework_deadline(self):
        self.sync(); row = self.runtime.reminders()[0]
        self.runtime.update(row['id'], {'dueAt': STAMP + HOUR})
        self.now.return_value = (STAMP + HOUR) / 1000
        self.runtime.tick(homework_lookup=lambda key: notice(submissionStatus='submitted'))
        events = self.runtime.events()['events']
        self.assertEqual(len(events), 1)
        self.assertIn('设置的提醒', events[0]['text'])

    def test_deadline_changed_back_does_not_repeat_already_delivered_time(self):
        self.sync(); self.now.return_value = (STAMP - HOUR) / 1000
        self.runtime.tick()
        self.sync(notice(deadlineAt='2030-03-19T16:00:00+08:00'))
        self.sync(); self.runtime.tick()
        self.assertEqual(len(self.runtime.events()['events']), 1)

    def test_backend_worker_arms_homework_and_delivers_without_model_calls(self):
        from local_service import LocalBackend
        from types import SimpleNamespace
        from unittest.mock import Mock
        backend = LocalBackend.__new__(LocalBackend)
        backend.runtime = self.runtime
        backend.store = SimpleNamespace(export_items=lambda source: [notice()], get_notice=lambda key: notice())
        backend.ai = SimpleNamespace(reconcile_deadlines=Mock())
        backend.stop = Mock()
        backend.stop.is_set.side_effect = [False, True]
        self.now.return_value = (STAMP - HOUR) / 1000
        backend._reminders()
        self.assertEqual(len(self.runtime.events()['events']), 1)
        backend.ai.reconcile_deadlines.assert_called_once()
        backend.stop.wait.assert_called_once_with(1)
