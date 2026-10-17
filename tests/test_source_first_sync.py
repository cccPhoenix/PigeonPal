"""Offline scheduling checks; no school requests, credentials, or real data."""
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from crawlers.engine import Runtime
from crawlers.sources import SOURCES
from local_service import LocalBackend


class SourceFirstSyncTests(unittest.TestCase):
    def backend(self, states, due=None):
        backend = LocalBackend.__new__(LocalBackend)
        backend.stop = threading.Event()
        backend.auth = SimpleNamespace(campus_session=lambda: None)
        backend.site_auth = Mock()
        backend.engine = SimpleNamespace(runtimes={
            key: Runtime(SOURCES[key], next_due=(due or {}).get(key, 0), state=state)
            for key, state in states.items()
        }, run_source=Mock())
        return backend

    def test_new_homework_source_runs_before_existing_slow_sources(self):
        backend = self.backend({'yunfeng': 'ready', 'itc': 'ready', 'qsxy': 'ready', 'bksy': 'ready', 'xzzd': 'idle'})
        with patch('local_service.time.time', return_value=1000):
            backend._run_due_sources()
        self.assertEqual([call.args[0].source.id for call in backend.engine.run_source.call_args_list],
                         ['xzzd', 'yunfeng', 'itc', 'qsxy', 'bksy'])

    def test_first_install_prioritizes_homework_but_keeps_other_order(self):
        backend = self.backend({key: 'idle' for key in SOURCES})
        with patch('local_service.time.time', return_value=1000):
            backend._run_due_sources()
        self.assertEqual(backend.engine.run_source.call_args_list[0].args[0].source.id, 'xzzd')

    def test_waiting_for_auth_keeps_homework_priority(self):
        backend = self.backend({'yunfeng': 'ready', 'xzzd': 'auth_required'})
        with patch('local_service.time.time', return_value=1000):
            backend._run_due_sources()
        self.assertEqual(backend.engine.run_source.call_args_list[0].args[0].source.id, 'xzzd')

    def test_backoff_and_normal_polling_are_unchanged(self):
        backend = self.backend({'yunfeng': 'ready', 'itc': 'ready', 'xzzd': 'backoff'}, {'xzzd': 2000})
        with patch('local_service.time.time', return_value=1000):
            backend._run_due_sources()
        self.assertEqual([call.args[0].source.id for call in backend.engine.run_source.call_args_list], ['yunfeng', 'itc'])
        backend.site_auth.prepare.assert_not_called()
