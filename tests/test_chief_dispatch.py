"""Offline dispatch regressions: no model, credentials or real notices are used."""
import copy
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from notice_ai.bots import BotStore
from notice_ai.chat import ChatService
from notice_ai.runtime import RuntimeStore
from notice_ai.schema import AIError
from test_multi_bot import StubClient


class ChiefDispatchTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.bots = BotStore(Path(tmp.name) / 'bots.json')
        self.runtime = RuntimeStore(Path(tmp.name) / 'runtime.json')

    def chat(self, replies):
        client = StubClient(replies)
        processor = SimpleNamespace(client=client, generation=0, stop=threading.Event(),
                                    config=SimpleNamespace(allow_protected=False))
        return ChatService(processor, self.runtime, self.bots), client

    def body(self, text, request='dispatch-request-001', **extra):
        return {'requestId': request, 'text': text, 'channelId': 'bot', 'profile': {'botName': 'Alex'}, **extra}

    def test_unmentioned_notice_reminder_is_dispatched_with_source_facts_and_one_specialist_reply(self):
        chat, client = self.chat([{'content': '想提前多久提醒你？'}])
        snapshot = {'items': [{'title': '二奖三奖申报', 'url': 'https://example.edu/notice',
                              'contentExcerpt': '申报截止：10月18日17:30，年份未注明。'}]}
        lookups = []
        def lookup(source, query, limit):
            lookups.append(source)
            return copy.deepcopy(snapshot)
        chat.lookup = lookup
        result = chat.respond(self.body('提醒一下二奖三奖申报截止', channelId='src-yunfeng'))
        messages = [row for row in result['events'] if row['type'] == 'message']
        self.assertEqual([row['botId'] for row in messages], ['bot-defaultreminder'])
        self.assertEqual(len(client.requests), 1)
        self.assertIn('yunfeng', lookups)
        self.assertIn('10月18日17:30', str(client.requests[0][0]))
        tools = {row['function']['name'] for row in client.requests[0][1]}
        self.assertIn('create_reminder', tools)
        self.assertNotIn('search_notices', tools)
        handoffs = [row for row in result['events'] if row.get('activity', {}).get('type') == 'handoff']
        self.assertEqual(len(handoffs), 1)
        self.assertEqual([actor['name'] for actor in handoffs[0]['activity']['actors']], ['Alex', '提醒鸽'])
        self.assertEqual(self.runtime.reminders(), [], 'asking for clarification is not reminder success')

    def test_unmentioned_strict_reminder_dispatch_needs_no_model_and_retry_is_idempotent(self):
        chat, client = self.chat([])
        client.config = SimpleNamespace(configured=False, error='ai_not_configured')
        body = self.body('10分钟后提醒我喝水')
        result = chat.respond(body)
        self.assertEqual(result['events'][-1]['botId'], 'bot-defaultreminder')
        self.assertEqual(client.requests, [])
        self.assertEqual(chat.respond(body), result)
        self.assertEqual(len(self.runtime.reminders()), 1)
        self.assertEqual(self.runtime.reminders()[0]['botId'], 'bot-defaultreminder')

    def test_notice_query_dispatches_to_news_without_chief_model_call(self):
        chat, client = self.chat([{'content': '这里有两条校园通知。'}])
        chat.lookup = lambda *args: {'items': []}
        result = chat.respond(self.body('查一下最近的校园通知'))
        self.assertEqual(result['events'][-1]['botId'], 'bot-defaultnews')
        self.assertEqual(len(client.requests), 1)
        self.assertNotIn('delegate_task', {row['function']['name'] for row in client.requests[0][1]})

    def test_explicit_chief_mention_and_writing_or_meta_questions_stay_with_chief(self):
        texts = ['@Alex 提醒我写作业', '帮我润色这段提醒文案', '提醒功能怎么使用？', '写一份讲座通知', '你好']
        chat, client = self.chat([{'content': '主伙伴回答'} for _ in texts])
        chat.lookup = lambda *args: {'items': []}
        for index, text in enumerate(texts):
            result = chat.respond(self.body(text, 'dispatch-explicit-' + str(index)))
            self.assertEqual(result['events'][-1]['botId'], 'chief', text)
            self.assertFalse(any(row.get('activity', {}).get('type') == 'handoff' for row in result['events']))

    def test_confirmation_continues_with_the_reminder_bot_without_another_mention(self):
        chat, client = self.chat([{'content': '今晚九点提醒，可以吗？'}, {'content': '还需要确认具体日期。'}, {'content': '收到你的时间。'}])
        first = chat.respond(self.body('提醒我写作业'))
        second = chat.respond(self.body('可以', 'dispatch-confirmation-002'))
        self.assertEqual(first['events'][-1]['botId'], 'bot-defaultreminder')
        self.assertEqual(second['events'][-1]['botId'], 'bot-defaultreminder')
        self.assertEqual(len(client.requests), 2)
        time = chat.respond(self.body('十分钟后', 'dispatch-time-003'))
        self.assertEqual(time['events'][-1]['botId'], 'bot-defaultreminder')
        self.assertEqual(self.runtime.reminders(), [])

    def test_unavailable_specialist_does_not_join_or_answer_outside_the_channel(self):
        self.bots.set_members('bot', ['chief'])
        chat, client = self.chat([{'content': '主伙伴处理'}])
        result = chat.respond(self.body('提醒我写作业'))
        self.assertEqual(result['events'][-1]['botId'], 'chief')
        self.assertEqual(self.bots.channel('bot')['memberIds'], ['chief'])
        self.assertFalse(any(row.get('activity', {}).get('type') == 'handoff' for row in result['events']))

    def test_dispatched_failure_remains_failure_without_a_saved_reminder(self):
        chat, client = self.chat([AIError('ai_network_error')])
        with self.assertRaises(AIError):
            chat.respond(self.body('提醒我写作业'))
        activities = [row['activity']['type'] for row in self.bots.events()['events'] if row.get('activity')]
        self.assertIn('handoff', activities)
        self.assertIn('failed', activities)
        self.assertNotIn('completed', activities)
        self.assertEqual(self.runtime.reminders(), [])

    def test_writing_as_the_reminder_task_still_dispatches_but_bot_management_does_not(self):
        chat, client = self.chat([{'content': '明天几点叫你？'}, {'content': '需要什么样的提醒伙伴？'}])
        chat.lookup = lambda *args: {'items': []}
        reminder = chat.respond(self.body('明天提醒我写一份讲座通知'))
        self.assertEqual(reminder['events'][-1]['botId'], 'bot-defaultreminder')
        management = chat.respond(self.body('添加一个提醒bot', 'dispatch-management-002'))
        self.assertEqual(management['events'][-1]['botId'], 'chief')

    def test_notice_title_or_negation_does_not_turn_a_notice_query_into_a_reminder(self):
        chat, client = self.chat([{'content': '通知查询结果'}] * 5 + [{'content': '请在形象与称呼中修改名字'}])
        chat.lookup = lambda *args: {'items': []}
        for index, text in enumerate(['查一下提醒缴费的通知', '帮我查一下最新报名通知，不用提醒',
                                    '不用提醒我，查一下最新报名通知', '帮我查一下最新报名通知，不用提醒我',
                                    '不需要提醒我，查一下最新报名通知']):
            result = chat.respond(self.body(text, 'dispatch-query-' + str(index)))
            self.assertEqual(result['events'][-1]['botId'], 'bot-defaultnews')
        renamed = chat.respond(self.body('把提醒鸽的名字改成小闹钟', 'dispatch-rename-003'))
        self.assertEqual(renamed['events'][-1]['botId'], 'chief')

    def test_advance_offset_answer_continues_with_the_reminder_bot(self):
        chat, client = self.chat([{'content': '想提前多久提醒你？'}, {'content': '好的，还需要确定截止日期。'}])
        chat.respond(self.body('提醒一下申报截止'))
        result = chat.respond(self.body('提前一天', 'dispatch-advance-002'))
        self.assertEqual(result['events'][-1]['botId'], 'bot-defaultreminder')
