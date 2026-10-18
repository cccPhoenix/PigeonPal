"""Default 5+3 selection and local queries against synthetic current/old terms."""
from datetime import datetime
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from crawlers.homework_selection import select_homework, is_current_homework, parse_homework_query, homework_query_reply
from notice_ai.chat import ChatService
from notice_ai.runtime import RuntimeStore

NOW = datetime.fromisoformat('2026-10-18T12:00:00+08:00').timestamp()

def row(identifier, day, *, opened=1, status='not_submitted', term='2026-2027-1', closed=False):
    return {'id': f'xzzd:{identifier}', 'sourceId': 'xzzd', 'title': f'练习{identifier}',
            'url': f'https://courses.zju.edu.cn/course/1/learning-activity#/{identifier}',
            'firstSeenAt': '2026-10-18T00:00:00Z', 'lastChangedAt': '2026-10-18T00:00:00Z',
            'homework': {'activityId': str(identifier), 'courseId': '1', 'courseName': '测试课程',
                         'courseCode': f'({term})-TEST', 'openAt': f'2026-10-{opened:02d}T08:00:00+08:00',
                         'deadlineAt': f'2026-10-{day:02d}T20:00:00+08:00' if day else None,
                         'submissionStatus': status, 'isClosed': closed}}

def mixed():
    # five newly opened, far-away assignments and three earlier-issued, near due
    rows = [row(i, 25+i, opened=10+i) for i in range(1,6)]
    rows += [row(10+i, 18+i) for i in range(3)]
    rows += [row(20, 19, status='submitted'), row(21, 19, closed=True), row(22, 16),
             row(23, 30, term='2025-2026-2'), row(24, 30, opened=20)]
    return rows

class HomeworkSelectionTests(unittest.TestCase):
    def test_default_exact_five_recent_plus_three_nearest_without_old_tasks(self):
        result = select_homework(mixed(), now=NOW)
        self.assertEqual([r['id'] for r in result], ['xzzd:10','xzzd:11','xzzd:12', 'xzzd:1','xzzd:2','xzzd:3','xzzd:4','xzzd:5'])

    def test_overlap_is_deduplicated_and_unknown_not_claimed_unsubmitted(self):
        rows = [row(1,19), row(2,20), row(3,21,status='unknown'), row(4,19,status='submitted')]
        result = select_homework(rows, now=NOW)
        self.assertEqual([r['id'] for r in result], ['xzzd:1','xzzd:2','xzzd:3'])
        pending = select_homework(rows, now=NOW, query={'status':'unsubmitted','limit':5,'order':'asc'})
        self.assertEqual([r['id'] for r in pending], ['xzzd:1','xzzd:2'])

    def test_missing_deadline_needs_current_term_or_current_opening_evidence(self):
        good = row(1,None)
        bad = row(2,None,term='UNKNOWN');bad['homework']['openAt']=None
        self.assertTrue(is_current_homework(good,NOW))
        self.assertFalse(is_current_homework(bad,NOW))
        self.assertEqual(select_homework([good,bad], now=NOW)[0]['id'], 'xzzd:1')

    def test_screenshot_queries_and_counts(self):
        for text in ['列出还没有提交的作业，从近到远五条', '列出最近五条没有结束的作业']:
            q=parse_homework_query(text,'bot');self.assertIsNotNone(q)
            self.assertEqual(q['limit'],5);self.assertEqual(q['status'],'unsubmitted')
            result=select_homework(mixed(),now=NOW,query=q)
            self.assertEqual(len(result),5)
        self.assertEqual(parse_homework_query('显示3条即将截止的作业','bot')['limit'],3)
        self.assertIsNone(parse_homework_query('明天九点提醒我交作业','src-xzzd'))
        self.assertIsNone(parse_homework_query('帮我写一份作业','bot'))
        self.assertIsNone(parse_homework_query('你好','bot'))

    def test_local_chat_query_has_real_data_even_without_model_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime=RuntimeStore(Path(tmp)/'runtime.json')
            client=Mock();client.config.configured=False
            processor=SimpleNamespace(notices=SimpleNamespace(export_items=lambda source: mixed()),client=client)
            service=ChatService(processor,runtime)
            with patch('crawlers.homework_selection.time.time',return_value=NOW):
                result=service.respond({'text':'列出还没有提交的作业，从近到远五条','channelId':'bot','requestId':'local-homework-test'})
            event=result['events'][0]
            self.assertTrue(event['localOnly'])
            self.assertIn('5',event['text'])
            cards=[e for e in result['events'] if e.get('queryResult')]
            self.assertEqual(len(cards),5)
            self.assertEqual(cards[0]['item']['title'],'练习10')
            self.assertTrue(all(e['kind']=='notice' and e['localOnly'] for e in cards))
            self.assertNotIn('练习23',[e['item']['title'] for e in cards])
            client.complete.assert_not_called()
            replay=service.respond({'text':'列出还没有提交的作业，从近到远五条','channelId':'bot','requestId':'local-homework-test'})
            self.assertEqual(result,replay)

    def test_explicit_submitted_query_never_returns_unsubmitted_instead(self):
        query=parse_homework_query('列出已经提交的作业五条','bot')
        selected=select_homework(mixed(),now=NOW,query=query)
        self.assertEqual([row['id'] for row in selected],['xzzd:20'])
        reply=homework_query_reply(mixed(),'列出已经提交的作业五条',now=NOW)
        self.assertIn('已提交',reply);self.assertNotIn('练习10',reply)

    def test_nearest_three_and_explicit_reverse_order(self):
        q=parse_homework_query('显示三条最近截止的作业','bot')
        self.assertEqual([r['id'] for r in select_homework(mixed(),now=NOW,query=q)],['xzzd:10','xzzd:11','xzzd:12'])
        q=parse_homework_query('列出未提交作业，从远到近2条','bot')
        self.assertEqual([r['id'] for r in select_homework(mixed(),now=NOW,query=q)],['xzzd:5','xzzd:4'])

    def test_collector_drops_old_course_checkpoint_without_fetching_it(self):
        from crawlers.xzzd import XzzdCollector
        class Client:
            def __init__(self): self.paths=[]
            def json(self,path):
                self.paths.append(path)
                if path.startswith('/api/todos'): return {'todo_list':[]}
                if '/my-courses' in path: return {'courses':[
                    {'id':1,'name':'旧课','course_code':'(2025-2026-2)-OLD','status':'ongoing'},
                    {'id':2,'name':'新课','course_code':'(2026-2027-1)-NEW','status':'ongoing'}],'pages':1}
                if '/courses/2/' in path: return {'homework_activities':[],'pages':1}
                raise AssertionError('Old course was fetched: '+path)
        client=Client()
        result=XzzdCollector(client,now=NOW).collect()
        self.assertEqual([r['id'] for r in result['checkpoint']['courses']],['2'])
        self.assertFalse(any('/courses/1/' in path for path in client.paths))

    def test_shared_frontend_backend_selection_contract(self):
        import json
        for case in json.loads((Path(__file__).with_name('homework-selection-fixtures.json')).read_text()):
            with self.subTest(case=case['name']):
                self.assertEqual([row['id'] for row in select_homework(case['rows'],now=case['now'])],case['expected'])
