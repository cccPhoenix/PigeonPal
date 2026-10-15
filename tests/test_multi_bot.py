"""Offline multi-bot contract checks. No user files, model or campus network."""
from pathlib import Path
import copy
import json
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from notice_ai.chat import ChatService
from notice_ai.runtime import RuntimeStore
from notice_ai.schema import AIError


def call(function_name, **args):
    return {'id': 'call-' + function_name, 'function': {'name': function_name, 'arguments': json.dumps(args)}}


class StubClient:
    config = SimpleNamespace(configured=True)

    def __init__(self, replies):
        self.replies, self.requests = list(replies), []

    def complete(self, messages, *, tools=None):
        self.requests.append((copy.deepcopy(messages), copy.deepcopy(tools)))
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply(messages) if callable(reply) else reply


class MultiBotTests(unittest.TestCase):
    def setUp(self):
        from notice_ai.bots import BotStore
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.bots = BotStore(self.path / 'bots.json')
        self.runtime = RuntimeStore(self.path / 'runtime.json')
        self.initial_bot_count = len(self.bots.snapshot()['bots'])
        self.initial_events = self.bots.events()['events']

    def chat(self, replies):
        client = StubClient(replies)
        processor = SimpleNamespace(client=client, generation=0, stop=threading.Event(),
                                    config=SimpleNamespace(allow_protected=False))
        return ChatService(processor, self.runtime, self.bots), client

    def body(self, text='你好', request_id='request-0001', **fields):
        return {'text': text, 'requestId': request_id, 'channelId': 'bot', **fields}

    def test_creation_membership_and_restart(self):
        from notice_ai.bots import BotStore
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer', 'style': '直接', 'look': 'courier'})['bot']
        self.assertNotIn(bot['id'], self.bots.channel('bot')['memberIds'])
        self.bots.set_members('bot', ['chief', bot['id']])
        with self.assertRaises(AIError):
            self.bots.set_members('bot', [bot['id']])
        with self.assertRaises(AIError):
            self.bots.set_members('bot', ['chief', 'bot-absent'])
        restored = BotStore(self.path / 'bots.json')
        self.assertEqual(restored.bot(bot['id'])['style'], '直接')
        self.assertEqual(restored.bot(bot['id'])['look'], 'courier')
        self.assertEqual(restored.channel('bot')['memberIds'], ['chief', bot['id']])
        self.assertEqual(restored.bot('chief')['name'], '小浙')

    def test_outside_member_and_invalid_mentions_never_call_model(self):
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer'})['bot']
        chat, client = self.chat([])
        for fields in ({'botId': bot['id']}, {'text': '@写作鸽 润色'}, {'text': '@不存在 帮忙'}):
            with self.assertRaises(AIError):
                chat.respond(self.body(**fields))
        self.assertEqual(client.requests, [])

    def test_mentions_route_to_member_and_keep_role_capabilities(self):
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer', 'instructions': '负责文字', 'style': '直接', 'channelId': 'bot'})['bot']
        chat, client = self.chat([{'content': '已润色'}, {'content': '主入口回复'}, {'content': '继续写'}])
        result = chat.respond(self.body('@写作鸽 润色秘密草稿'))
        self.assertEqual(result['events'][-1]['botId'], bot['id'])
        names = {row['function']['name'] for row in client.requests[0][1]}
        self.assertNotIn('create_reminder', names)
        self.assertNotIn('search_notices', names)
        chat.respond(self.body('你好', 'request-0002'))
        self.assertIn('秘密草稿', json.dumps(client.requests[1][0], ensure_ascii=False))
        chat.respond(self.body('继续', 'request-0003', botId=bot['id']))
        self.assertIn('秘密草稿', json.dumps(client.requests[2][0], ensure_ascii=False))

    def test_response_receipt_and_poll_text_share_stable_id(self):
        from notice_ai.bots import BotStore
        chat, client = self.chat([{'content': '你好'}])
        result = chat.respond(self.body())
        self.assertEqual(chat.respond(self.body()), result)
        self.assertEqual(len(client.requests), 1)
        events = self.bots.events(0)['events']
        message = next(row for row in result['events'] if row['type'] == 'message')
        self.assertEqual(next(row for row in events if row['kind'] == 'text')['id'], message['id'])
        task = [row for row in events if row['kind'] == 'activity' and row['activity']['type'] in {'processing', 'completed'}]
        self.assertEqual(task[0]['id'], task[-1]['id'])
        restored = BotStore(self.path / 'bots.json')
        self.assertEqual(restored.receipt('request-0001')['response'], result)
        with self.assertRaises(AIError):
            chat.respond(self.body('另一条'))

    def test_real_failure_has_terminal_failed_and_no_completed(self):
        chat, _ = self.chat([AIError('ai_timeout', 504)])
        with self.assertRaises(AIError):
            chat.respond(self.body())
        activities = [row['activity']['type'] for row in self.bots.events()['events'] if row['kind'] == 'activity']
        self.assertIn('failed', activities)
        self.assertNotIn('completed', activities)

    def test_chief_create_invite_delegate_and_specialist_cannot_recurse(self):
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer', 'channelId': 'bot'})['bot']
        chat, client = self.chat([
            {'tool_calls': [call('delegate_task', botId=bot['id'], task='润色这段话')]},
            {'tool_calls': [call('delegate_task', botId='chief', task='递归')]},
            {'content': '润色后的文字'},
        ])
        result = chat.respond(self.body('请交给写作鸽润色'))
        self.assertEqual([row['botId'] for row in result['events'] if row['type'] == 'message'], [bot['id']])
        specialist_tools = {row['function']['name'] for row in client.requests[1][1]}
        self.assertNotIn('delegate_task', specialist_tools)
        self.assertEqual(sum(row['activity']['type'] == 'handoff' for row in self.bots.events()['events'] if row['kind'] == 'activity'), 1)

    def test_partial_failure_keeps_real_creation_and_retry_does_not_duplicate(self):
        chat, client = self.chat([
            {'tool_calls': [call('create_bot', name='写作鸽', role='writer')]},
            AIError('ai_timeout', 504),
        ])
        result = chat.respond(self.body('添加一个写作鸽'))
        self.assertEqual(len(self.bots.snapshot()['bots']), self.initial_bot_count + 1)
        self.assertEqual(chat.respond(self.body('添加一个写作鸽')), result)
        self.assertEqual(len(client.requests), 2)
        activities = [row['activity']['type'] for row in self.bots.events()['events'] if row['kind'] == 'activity']
        self.assertIn('failed', activities)
        self.assertNotIn('completed', activities)

    def test_complete_create_invite_delegate_chain_uses_real_ids(self):
        def invite(messages):
            created = json.loads(messages[-1]['content'])['bot']
            return {'tool_calls': [call('invite_bot', botId=created['id'])]}

        def delegate(messages):
            members = json.loads(messages[-1]['content'])['channel']['memberIds']
            return {'tool_calls': [call('delegate_task', botId=members[-1], task='润色原文')]}

        chat, client = self.chat([
            {'tool_calls': [call('create_bot', name='写作鸽', role='writer', style='简洁')]},
            invite, delegate, {'content': '修改后的原文'},
        ])
        result = chat.respond(self.body('请创建写作鸽，邀请并交给它润色'))
        bot = next(row for row in self.bots.snapshot()['bots'] if row['role'] == 'writer')
        self.assertIn(bot['id'], self.bots.channel('bot')['memberIds'])
        self.assertEqual(result['events'][-1]['botId'], bot['id'])
        self.assertEqual(sum(row['name'] == 'bots.sync' for row in result['events'] if row['type'] == 'action'), 2)
        self.assertEqual(len(client.requests), 4)
        self.assertIsNone(client.requests[-1][1])

    def test_invalid_mutation_does_not_publish_joined(self):
        before = self.bots.events()['events']
        with self.assertRaises(AIError):
            self.bots.create({'name': '写作鸽', 'role': 'writer', 'channelId': 'src-missing'})
        self.assertEqual(len(self.bots.snapshot()['bots']), self.initial_bot_count)
        self.assertEqual(self.bots.events()['events'], before)

    def test_long_reply_chunks_match_poll_ids_and_text(self):
        text = '长' * 4500 + '末尾信息必须保留'
        chat, client = self.chat([{'content': text}, {'content': '继续'}])
        result = chat.respond(self.body())
        messages = [row for row in result['events'] if row['type'] == 'message']
        polled = [row for row in self.bots.events()['events'] if row['kind'] == 'text']
        self.assertEqual([row['id'] for row in messages], [row['id'] for row in polled])
        self.assertEqual([row['text'] for row in messages], [row['text'] for row in polled])
        self.assertTrue(all(len(row['text']) <= 1800 for row in messages))
        self.assertEqual(''.join(row['text'] for row in messages), text)
        chat.respond(self.body('继续刚才末尾的内容', 'request-0002'))
        self.assertIn('末尾信息必须保留', json.dumps(client.requests[-1][0], ensure_ascii=False))

    def test_interrupted_request_restores_unknown_without_rerunning_model(self):
        from notice_ai.bots import BotStore
        chat, _ = self.chat([KeyboardInterrupt()])
        with self.assertRaises(KeyboardInterrupt):
            chat.respond(self.body())
        restored = BotStore(self.path / 'bots.json')
        latest = {row['id']: row for row in restored.events()['events']}
        self.assertEqual(next(row for row in latest.values() if row['id'].startswith('team-task-'))['activity']['type'], 'unknown')
        client = StubClient([])
        processor = SimpleNamespace(client=client, generation=0, stop=threading.Event())
        retried = ChatService(processor, self.runtime, restored)
        with self.assertRaises(AIError) as raised:
            retried.respond(self.body())
        self.assertEqual(raised.exception.code, 'chat_interrupted')
        self.assertEqual(client.requests, [])

    def test_specialist_reminder_keeps_creator_signature(self):
        bot = self.bots.create({'name': '提醒鸽', 'role': 'reminder', 'channelId': 'bot'})['bot']
        chat, _ = self.chat([
            {'tool_calls': [call('create_reminder', title='上课', dueAt='2099-01-01T09:00:00+08:00')]},
            {'content': '提醒已保存'},
        ])
        result = chat.respond(self.body('提醒我上课', botId=bot['id']))
        reminder = self.runtime.reminders()[0]
        self.assertEqual(reminder['botId'], bot['id'])
        action = next(row for row in result['events'] if row['type'] == 'action')
        self.assertEqual(action['botId'], bot['id'])
        actions = []
        updated = chat.execute('update_reminder', {'reminderId': reminder['id'], 'status': 'done'}, 'bot', 'x', actions, 'chief')
        self.assertEqual(updated['reminder']['status'], 'done')
        self.assertEqual(updated['reminder']['botId'], bot['id'])
        self.assertEqual(actions[0]['botId'], 'chief')

    def test_tool_round_limit_has_terminal_failure(self):
        chat, client = self.chat([{'tool_calls': [call('list_reminders', query='')]}] * 4)
        with self.assertRaises(AIError) as raised:
            chat.respond(self.body())
        self.assertEqual(raised.exception.code, 'ai_tool_limit')
        self.assertIsNone(client.requests[-1][1])
        latest = {row['id']: row for row in self.bots.events()['events']}
        self.assertEqual(next(row for row in latest.values() if row['id'].startswith('team-task-'))['activity']['type'], 'failed')

    def test_dm_preserves_target_and_chief_is_not_mutable_id(self):
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer'})['bot']
        channel = self.bots.create_channel({'title': '私聊', 'memberIds': [bot['id']], 'kind': 'dm'})['channel']
        self.assertEqual(channel['id'], 'src-dm-' + bot['id'])
        self.assertEqual(self.bots.route(channel['id'], '')['id'], bot['id'])
        with self.assertRaises(AIError):
            self.bots.set_members(channel['id'], ['chief'])
        with self.assertRaises(AIError):
            self.bots.update('chief', {'id': bot['id']})

    def test_chief_profile_alias_and_email_do_not_misroute(self):
        chat, _ = self.chat([{'content': '在'}, {'content': '收到'}])
        result = chat.respond(self.body('@咕咕 你好', profile={'botName': '咕咕'}))
        self.assertEqual(result['events'][-1]['botId'], 'chief')
        actor = next(row for row in result['events'] if row['type'] == 'activity')['activity']['actors'][0]
        self.assertEqual(actor['name'], '咕咕')
        result = chat.respond(self.body('这段文案邮件是 user@example.com', 'request-0002'))
        self.assertEqual(result['events'][-1]['botId'], 'chief')

    def test_creation_tool_cannot_smuggle_another_channel(self):
        self.bots.create_channel({'title': '别处', 'memberIds': ['chief'], 'id': 'src-group-other'})
        chat, _ = self.chat([
            {'tool_calls': [call('create_bot', name='写作鸽', role='writer', channelId='src-group-other')]},
            {'content': '未创建'},
        ])
        chat.respond(self.body('添加写作鸽'))
        self.assertEqual(len(self.bots.snapshot()['bots']), self.initial_bot_count)

    def test_http_contract_dispatch_without_server_or_credentials(self):
        from email.message import Message
        from io import BytesIO
        from local_service import handler_for
        backend = SimpleNamespace(bots=self.bots, runtime=self.runtime)
        Handler = handler_for(backend)

        def dispatch(path, body=None):
            handler = object.__new__(Handler)
            handler.path = path
            handler.headers = Message()
            result = []
            handler._allowed = lambda **_: True
            handler._json = lambda status, value: result.append((status, value))
            if body is None:
                handler.do_GET()
            else:
                raw = json.dumps(body).encode()
                handler.headers['Content-Type'] = 'application/json'
                handler.headers['Content-Length'] = str(len(raw))
                handler.rfile = BytesIO(raw)
                handler.do_POST()
            return result[0]

        status, created = dispatch('/api/bots/create', {'name': '写作鸽', 'role': 'writer'})
        self.assertEqual(status, 201)
        identity = created['bot']['id']
        status, updated = dispatch('/api/bots/update', {'id': identity, 'patch': {'style': '直接'}})
        self.assertEqual((status, updated['bot']['style']), (200, '直接'))
        status, created = dispatch('/api/bots/channels/create', {'title': '文字', 'memberIds': ['chief', identity]})
        self.assertEqual(status, 201)
        status, members = dispatch('/api/bots/channels/members', {'channelId': created['channel']['id'], 'memberIds': [identity]})
        self.assertEqual(status, 200)
        self.assertEqual(members['channel']['memberIds'], [identity])
        self.assertEqual(dispatch('/api/bots')[0], 200)
        status, reminder = dispatch('/api/reminders/create', {'title': '表单提醒', 'dueAt': '2099-01-01T09:00:00+08:00'})
        self.assertEqual(status, 201)
        self.assertEqual(reminder['reminder']['botId'], 'bot-defaultreminder')
        status, events = dispatch('/api/bots/events?after=0')
        self.assertEqual(status, 200)
        self.assertGreater(events['cursor'], 0)
        self.assertEqual(self.runtime.events()['cursor'], 0)
        self.assertEqual(dispatch('/api/bots/events?after=-1')[0], 400)
        self.assertEqual(dispatch('/api/bots/channels/create', {'title': '错误', 'memberIds': ['chief'], 'kind': []})[0], 400)

    def test_explicit_source_migration_and_profile_size_limits(self):
        source = self.bots.create_channel({'title': '旧来源', 'memberIds': ['chief'], 'kind': 'source', 'id': 'src-legacy'})['channel']
        self.assertEqual(source['memberIds'], ['chief'])
        self.assertEqual(source['kind'], 'source')
        for identity in ['src-group-forged', 'src-dm-forged']:
            with self.assertRaises(AIError):
                self.bots.create_channel({'title': '错误', 'memberIds': ['chief'], 'kind': 'source', 'id': identity})
        bot = self.bots.create({'name': '写作鸽', 'role': 'writer', 'instructions': '字' * 3000, 'style': '字' * 1000})['bot']
        self.assertEqual(len(bot['instructions']), 3000)
        self.assertEqual(len(bot['style']), 1000)
        with self.assertRaises(AIError):
            self.bots.update(bot['id'], {'instructions': '字' * 3001})

    def test_failed_disk_commit_does_not_publish_success_or_mutate_memory(self):
        from unittest.mock import patch
        before = self.bots.snapshot()
        with patch('notice_ai.bots._atomic_replace', side_effect=OSError('offline simulated disk error')):
            with self.assertRaises(AIError) as raised:
                self.bots.create({'name': '写作鸽', 'role': 'writer', 'channelId': 'bot'})
        self.assertEqual(raised.exception.code, 'bots_storage_error')
        self.assertEqual(self.bots.snapshot(), before)
        self.assertEqual(self.bots.events()['events'], self.initial_events)

    def test_group_history_is_shared_but_other_group_and_dm_are_isolated(self):
        writer = self.bots.create({'name': '写作鸽', 'role': 'writer'})['bot']
        group = self.bots.create_channel({'title': '讨论', 'memberIds': ['chief', writer['id']]})['channel']
        other = self.bots.create_channel({'title': '别处', 'memberIds': [writer['id']]})['channel']
        dm = self.bots.create_channel({'title': '私聊', 'memberIds': [writer['id']], 'kind': 'dm'})['channel']
        chat, client = self.chat([
            {'content': 'Chief 原文只有共享群可见'},
            {'tool_calls': [call('delegate_task', botId=writer['id'], task='润色上面的原文')]},
            {'content': 'writer 润色结果'},
            {'content': 'Chief 接续结果'},
            {'content': '另一群'}, {'content': '私聊'},
        ])
        chat.respond(self.body('给出一段原文', channelId=group['id']))
        chat.respond(self.body('请交给写作鸽润色上面原文', 'request-0002', channelId=group['id']))
        self.assertIn('Chief 原文只有共享群可见', json.dumps(client.requests[2][0], ensure_ascii=False))
        chat.respond(self.body('继续刚才的润色', 'request-0003', channelId=group['id']))
        self.assertIn('writer 润色结果', json.dumps(client.requests[3][0], ensure_ascii=False))
        chat.respond(self.body('你好', 'request-0004', channelId=other['id']))
        chat.respond(self.body('你好', 'request-0005', channelId=dm['id']))
        for index in [4, 5]:
            value = json.dumps(client.requests[index][0], ensure_ascii=False)
            self.assertNotIn('Chief 原文只有共享群可见', value)
            self.assertNotIn('writer 润色结果', value)

    def test_reminder_role_can_find_and_reschedule_chief_reminder(self):
        reminder = self.runtime.create('之前的提醒', '2099-01-01T09:00:00+08:00')
        bot = self.bots.create({'name': '提醒鸽', 'role': 'reminder', 'channelId': 'bot'})['bot']
        chat, client = self.chat([
            {'tool_calls': [call('list_reminders', query='之前')]},
            {'tool_calls': [call('update_reminder', reminderId=reminder['id'], dueAt='2099-01-01T10:00:00+08:00')]},
            {'content': '提醒已推迟'},
        ])
        result = chat.respond(self.body('请推迟之前的提醒到上午十点', botId=bot['id']))
        listed = json.loads(client.requests[1][0][-1]['content'])['reminders']
        self.assertEqual(listed[0]['id'], reminder['id'])
        updated = self.runtime.reminders()[0]
        self.assertGreater(updated['dueAt'], reminder['dueAt'])
        self.assertEqual(updated['botId'], 'chief')
        action = next(row for row in result['events'] if row['type'] == 'action')
        self.assertEqual(action['botId'], bot['id'])
        self.assertIn('之前的提醒', client.requests[0][0][0]['content'])

    def test_quoted_and_unquoted_full_names_route_with_member_boundaries(self):
        bot = self.bots.create({'name': 'Writing Bot', 'role': 'writer', 'channelId': 'bot'})['bot']
        short = self.bots.create({'name': 'Writing', 'role': 'writer', 'channelId': 'bot'})['bot']
        outsider = self.bots.create({'name': 'Outside Bot', 'role': 'writer'})['bot']
        self.assertEqual(self.bots.route('bot', '@「Writing Bot」 润色')['id'], bot['id'])
        self.assertEqual(self.bots.route('bot', '@Writing Bot 润色')['id'], bot['id'])
        self.assertEqual(self.bots.route('bot', '@Writing 润色')['id'], short['id'])
        for text, target in [('@「Outside Bot」 润色', None), ('@Outside Bot 润色', None),
                             ('@「Writing Bot」 @Writing 润色', None), ('@「Writing Bot」 润色', 'chief'),
                             ('@「Writing Botplus」 润色', None), ('@Writing Botplus 润色', bot['id'])]:
            with self.assertRaises(AIError):
                self.bots.route('bot', text, target)
        self.assertEqual(self.bots.route('bot', '邮件 user@example.com')['id'], 'chief')

    def test_removing_writer_keeps_shared_main_channel_context(self):
        writer = self.bots.create({'name': '写作鸽', 'role': 'writer', 'channelId': 'bot'})['bot']
        chat, client = self.chat([{'content': '写作鸽完成的共享草稿'}, {'content': 'Chief 接续'}])
        chat.respond(self.body('写一段草稿', botId=writer['id']))
        self.bots.set_members('bot', ['chief'])
        chat.respond(self.body('继续刚才草稿', 'request-0002'))
        self.assertIn('写作鸽完成的共享草稿', json.dumps(client.requests[1][0], ensure_ascii=False))

    def test_legacy_chief_history_import_is_persistent_and_only_once(self):
        from notice_ai.bots import BotStore
        legacy = [{'role': 'user', 'content': '升级前的问题'}, {'role': 'assistant', 'content': '升级前的答案'}]
        chat, client = self.chat([{'content': '迁移后的回复'}])
        chat.respond(self.body('接着上次说', history=legacy))
        self.assertIn('升级前的答案', json.dumps(client.requests[0][0], ensure_ascii=False))
        restored = BotStore(self.path / 'bots.json')
        self.assertEqual(sum(row['content'] == '升级前的答案' for row in restored.history('bot', 'chief', shared=True)), 1)
        next_client = StubClient([{'content': '后续回复'}, {'content': '专职回复'}, {'content': '私聊回复'}])
        processor = SimpleNamespace(client=next_client, generation=0, stop=threading.Event())
        resumed = ChatService(processor, self.runtime, restored)
        resumed.respond(self.body('再接着说', 'request-0002', history=[{'role': 'assistant', 'content': '不应重复信任的新客户端历史'}]))
        self.assertIn('升级前的答案', json.dumps(next_client.requests[0][0], ensure_ascii=False))
        self.assertNotIn('不应重复信任的新客户端历史', json.dumps(next_client.requests[0][0], ensure_ascii=False))
        self.assertEqual(sum(row['content'] == '升级前的答案' for row in restored.history('bot', 'chief', shared=True)), 1)
        writer = restored.create({'name': '写作鸽', 'role': 'writer'})['bot']
        group = restored.create_channel({'title': '新群', 'memberIds': [writer['id']]})['channel']
        dm = restored.create_channel({'title': 'Chief 私聊', 'kind': 'dm', 'memberIds': ['chief']})['channel']
        resumed.respond(self.body('你好', 'request-0003', channelId=group['id'], history=legacy))
        resumed.respond(self.body('你好', 'request-0004', channelId=dm['id'], history=legacy))
        for index in [1, 2]:
            self.assertNotIn('升级前的答案', json.dumps(next_client.requests[index][0], ensure_ascii=False))

    def test_default_team_seed_and_member_customization_survive_restart(self):
        from notice_ai.bots import BotStore
        snapshot = self.bots.snapshot()
        roles = {row['role']: row for row in snapshot['bots'] if not row['isChief']}
        self.assertEqual(set(roles), {'news', 'reminder'})
        self.assertEqual(roles['news']['id'], 'bot-defaultnews')
        self.assertEqual(roles['reminder']['id'], 'bot-defaultreminder')
        self.assertEqual(self.bots.channel('bot')['memberIds'], ['chief', roles['news']['id'], roles['reminder']['id']])
        self.assertEqual(self.bots.channel('src-itc')['memberIds'], ['chief', roles['news']['id'], roles['reminder']['id']])
        for bot in roles.values():
            self.assertEqual(self.bots.channel('src-dm-' + bot['id'])['memberIds'], [bot['id']])
        self.bots.update(roles['news']['id'], {'name': '我自己的通知助手', 'style': '短句'})
        self.bots.set_members('bot', ['chief'])
        restored = BotStore(self.path / 'bots.json')
        self.assertEqual(restored.bot(roles['news']['id'])['name'], '我自己的通知助手')
        self.assertEqual(restored.channel('bot')['memberIds'], ['chief'])

    def test_legacy_team_migration_reuses_existing_roles_and_preserves_members(self):
        from notice_ai.bots import BotStore
        old = copy.deepcopy(self.bots.state)
        old.pop('defaultTeamVersion', None)
        old['events'], old['sequence'] = [], 0
        old['bots'] = {'chief': old['bots']['chief'], 'bot-customnews': {
            'id': 'bot-customnews', 'name': '已有新闻鸽', 'role': 'news', 'instructions': '用户职责',
            'style': '用户风格', 'look': 'courier', 'isChief': False, 'createdAt': 1}}
        old['channels'] = {identity: row for identity, row in old['channels'].items() if row['kind'] != 'dm'}
        for row in old['channels'].values():
            row['memberIds'] = ['chief', 'bot-customnews']
        migration_path = self.path / 'legacy-bots.json'
        migration_path.write_text(json.dumps(old), encoding='utf-8')
        migrated = BotStore(migration_path)
        news = [row for row in migrated.snapshot()['bots'] if row['role'] == 'news']
        self.assertEqual(len(news), 1)
        self.assertEqual(news[0]['id'], 'bot-customnews')
        self.assertEqual(news[0]['style'], '用户风格')
        self.assertIn('bot-customnews', migrated.channel('bot')['memberIds'])
        self.assertIn('bot-defaultreminder', migrated.channel('bot')['memberIds'])
        self.assertEqual(migrated.channel('src-itc')['memberIds'], ['chief', 'bot-customnews', 'bot-defaultreminder'])
        self.assertFalse(any(row['botId'] == 'bot-customnews' and row['channelId'] == 'src-itc' for row in migrated.events()['events']))

    def test_terminal_receipt_cap_retains_active_and_prunes_linked_operations(self):
        from notice_ai.bots import BotStore
        bots = BotStore()
        def populate(state):
            for index in range(501):
                key = 'request-' + str(index).zfill(4)
                state['receipts'][key] = {'signature': key, 'status': 'completed', 'response': {'events': []}}
                state['operations'][key + ':create_bot:test'] = {'ok': True}
            state['receipts']['request-active'] = {'signature': 'active', 'status': 'processing', 'response': {'events': []}}
            state['operations']['request-active:create_bot:test'] = {'ok': True}
        bots.commit(populate)
        self.assertEqual(len(bots.state['receipts']), 501)
        self.assertIsNone(bots.receipt('request-0000'))
        self.assertIsNotNone(bots.receipt('request-0500'))
        self.assertIsNotNone(bots.receipt('request-active'))
        self.assertNotIn('request-0000:create_bot:test', bots.state['operations'])
        self.assertIn('request-active:create_bot:test', bots.state['operations'])

    def test_relative_reminder_fastpath_uses_no_model_and_keeps_receipt(self):
        reminder = next(row for row in self.bots.snapshot()['bots'] if row['role'] == 'reminder')
        chat, client = self.chat([])
        client.config = SimpleNamespace(configured=False, error='ai_not_configured')
        body = self.body('10分钟后提醒我喝水', channelId='src-dm-' + reminder['id'])
        result = chat.respond(body)
        row = self.runtime.reminders()[0]
        self.assertEqual(row['title'], '喝水')
        self.assertEqual(row['botId'], reminder['id'])
        self.assertEqual(client.requests, [])
        self.assertEqual(chat.respond(body), result)
        self.assertEqual(len(self.runtime.reminders()), 1)
        self.assertIn('10分钟', result['events'][-1]['text'])

    def test_relative_fastpath_keeps_ambiguous_time_with_model(self):
        reminder = next(row for row in self.bots.snapshot()['bots'] if row['role'] == 'reminder')
        chat, client = self.chat([{'content': '请补充确定时间'}])
        result = chat.respond(self.body('过一会儿提醒我喝水', botId=reminder['id']))
        self.assertEqual(len(client.requests), 1)
        self.assertEqual(self.runtime.reminders(), [])
        self.assertEqual(result['events'][-1]['text'], '请补充确定时间')

    def test_deadline_default_author_is_reminder_and_old_owner_is_preserved(self):
        from local_service import LocalBackend
        notice = {'id': 'notice-deadline', 'sourceId': 'yunfeng', 'title': '报名', 'contentHash': 'a'}
        result = {'deadlineAt': '2099-01-02T09:00:00+08:00'}
        backend = SimpleNamespace(bots=self.bots, runtime=self.runtime)
        LocalBackend._schedule_deadline(backend, notice, result)
        self.assertEqual(self.runtime.reminders()[0]['botId'], 'bot-defaultreminder')
        old_notice = {**notice, 'id': 'old-notice'}
        self.runtime.schedule_deadline(old_notice, result, bot_id='chief')
        LocalBackend._schedule_deadline(backend, old_notice, result)
        old = next(row for row in self.runtime.reminders() if row['noticeId'] == 'old-notice')
        self.assertEqual(old['botId'], 'chief')

    def test_seed_emits_joined_for_new_members_only_once(self):
        from notice_ai.bots import BotStore
        events = self.bots.events()['events']
        joined = [(row['channelId'], row['botId']) for row in events if row.get('activity', {}).get('type') == 'joined']
        self.assertEqual(len(joined), 14)
        self.assertIn(('bot', 'bot-defaultnews'), joined)
        self.assertIn(('src-itc', 'bot-defaultreminder'), joined)
        self.assertIn(('src-qsxy', 'bot-defaultnews'), joined)
        self.assertIn(('src-bksy', 'bot-defaultreminder'), joined)
        restored = BotStore(self.path / 'bots.json')
        self.assertEqual(restored.events()['events'], events)

    def test_legacy_seed_preserves_full_state_and_adds_registered_sources(self):
        from notice_ai.bots import BotStore
        old = copy.deepcopy(self.bots.state)
        old.pop('defaultTeamVersion', None)
        chief = old['bots']['chief']
        old['bots'] = {'chief': chief}
        for index in range(49):
            identity = 'bot-filler' + str(index).zfill(4)
            old['bots'][identity] = {**chief, 'id': identity, 'isChief': False, 'role': 'writer', 'name': '已有写作鸽' + str(index)}
        old['channels'] = {identity: {**old['channels'][identity], 'memberIds': ['chief']}
                           for identity in ['bot', 'src-itc', 'src-yunfeng']}
        for index in range(197):
            identity = 'src-group-existing-' + str(index)
            old['channels'][identity] = {'id': identity, 'kind': 'group', 'title': '已有群', 'memberIds': ['chief']}
        old['events'], old['sequence'] = [], 0
        migration_path = self.path / 'full-bots.json'
        migration_path.write_text(json.dumps(old), encoding='utf-8')
        migrated = BotStore(migration_path)
        self.assertEqual(len(migrated.snapshot()['bots']), 50)
        self.assertEqual(len(migrated.snapshot()['channels']), 202)
        self.assertEqual(migrated.channel('src-group-existing-196')['title'], '已有群')


if __name__ == '__main__':
    unittest.main()
