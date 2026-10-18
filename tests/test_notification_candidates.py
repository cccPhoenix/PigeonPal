from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from local_service import LocalBackend
class NotificationCandidateTests(unittest.TestCase):
    def test_complete_identity_index_does_not_apply_five_plus_three_digest(self):
        backend=LocalBackend.__new__(LocalBackend)
        rows=[{'id':f'xzzd:{i}','sourceId':'xzzd','title':'测试作业','homework':{}} for i in range(9)]
        backend.store=SimpleNamespace(export_items=lambda _:rows)
        result=backend.notification_candidates('xzzd')
        self.assertEqual(len(result['items']),9)
        self.assertEqual({r['id'] for r in result['items']},{r['id'] for r in rows})
        self.assertNotIn('homework',result['items'][0])
