"""Local bot identities, channel membership, isolated histories and team events."""

import copy
import json
import re
import threading
import time
import uuid

from crawlers.storage import StorageError, _atomic_replace
from crawlers.sources import SOURCES
from .runtime import valid_channel
from .schema import AIError, redact_text

ROLES = {'general', 'news', 'reminder', 'writer', 'planner'}
BOT_ID = re.compile(r'(?:chief|bot-[a-z0-9]{8,32})')


def stamp():
    return int(time.time() * 1000)


def clean_string(value, maximum, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise AIError('invalid_bot', 400)
    return value.strip()


class BotStore:
    def __init__(self, path=None):
        self.path = path
        self.backup = path.with_name(path.name + '.bak') if path else None
        self.lock = threading.RLock()
        self.last_bytes = None
        chief = {'id': 'chief', 'name': '小浙', 'role': 'general', 'instructions': '',
                 'style': '', 'look': 'placeholder', 'isChief': True, 'createdAt': stamp()}
        self.state = {'schemaVersion': 1, 'bots': {'chief': chief}, 'channels': {
            'bot': {'id': 'bot', 'kind': 'bot', 'title': 'Chief', 'memberIds': ['chief']},
            'src-itc': {'id': 'src-itc', 'kind': 'source', 'title': 'ITC 通知', 'memberIds': ['chief']},
            'src-yunfeng': {'id': 'src-yunfeng', 'kind': 'source', 'title': '云峰通知', 'memberIds': ['chief']},
        }, 'histories': {}, 'events': [], 'sequence': 0, 'receipts': {}, 'operations': {}}
        damaged = False
        if path:
            for candidate in (path, self.backup):
                try:
                    raw = candidate.read_bytes()
                    value = json.loads(raw.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    self.validate(value)
                    self.state, self.last_bytes = value, raw
                    break
                except FileNotFoundError:
                    continue
                except (OSError, UnicodeError, ValueError, AIError, KeyError, TypeError):
                    damaged = True
            else:
                if damaged:
                    raise StorageError('bots_state_invalid')
        self._seed_defaults()
        self._seed_sources()
        self._recover()

    def _seed_sources(self):
        # A new crawler source needs a durable channel before AI/DDL workers run.
        missing = [identity for identity in SOURCES if 'src-' + identity not in self.state['channels']]
        if not missing:
            return
        def mutate(state):
            members = ['chief']
            for role in ('news', 'reminder'):
                bot = next((row for row in state['bots'].values() if row['role'] == role and not row['isChief']), None)
                if bot:
                    members.append(bot['id'])
            for identity in missing:
                # Registered system sources must migrate even for a full old
                # state; user-created channels still follow the existing cap.
                channel_id = 'src-' + identity
                state['channels'][channel_id] = {'id': channel_id, 'kind': 'source',
                    'title': getattr(SOURCES[identity], 'title', '') or identity, 'memberIds': list(members)}
                for bot_id in members:
                    self._joined(state, channel_id, state['bots'][bot_id])
        self.commit(mutate)

    def _seed_defaults(self):
        # Seed once, preserving later user changes to members, names and roles.
        if self.state.get('defaultTeamVersion') == 1:
            return
        def mutate(state):
            defaults = {}
            for role, name, look, instructions in (
                    ('news', '通知鸽', 'courier', '整理本机校园通知，标注来源和未知事项。'),
                    ('reminder', '提醒鸽', 'pigeon', '按用户要求设置、调整提醒；应用按时投递已保存的提醒。')):
                bot = next((row for row in state['bots'].values() if row['role'] == role and not row['isChief']), None)
                if bot is None:
                    if len(state['bots']) >= 50:
                        continue
                    identity = 'bot-default' + role
                    if identity in state['bots']:
                        identity = 'bot-' + uuid.uuid4().hex[:12]
                    bot = {'id': identity, 'name': name, 'role': role, 'instructions': instructions,
                           'style': '简洁、直接。', 'look': look, 'isChief': False, 'createdAt': stamp()}
                    state['bots'][identity] = bot
                defaults[role] = bot
            for identity in ('bot', 'src-itc', 'src-yunfeng'):
                members = state['channels'][identity]['memberIds']
                for bot in defaults.values():
                    if bot['id'] not in members and len(members) < 30:
                        members.append(bot['id'])
                        self._joined(state, identity, bot)
            for bot in defaults.values():
                identity = 'src-dm-' + bot['id']
                if identity not in state['channels'] and len(state['channels']) < 200:
                    state['channels'][identity] = {'id': identity, 'kind': 'dm', 'title': bot['name'],
                                                   'memberIds': [bot['id']], 'botId': bot['id']}
                    self._joined(state, identity, bot)
            state['defaultTeamVersion'] = 1
        self.commit(mutate)

    @staticmethod
    def _prune_receipts(state):
        # Idempotency is retained for the most recent 500 terminal requests.
        # Active requests and all their operation receipts survive pruning.
        terminal = [identity for identity, row in state['receipts'].items() if row['status'] != 'processing']
        expired = set(terminal[:-500])
        for identity in expired:
            state['receipts'].pop(identity)
        if expired:
            state['operations'] = {identity: row for identity, row in state['operations'].items()
                                   if identity.split(':', 1)[0] not in expired}

    @staticmethod
    def validate(state):
        if (not isinstance(state, dict) or state.get('schemaVersion') != 1
                or any(not isinstance(state.get(key), dict) for key in ('bots', 'channels', 'histories', 'receipts', 'operations'))
                or not isinstance(state.get('events'), list) or type(state.get('sequence')) is not int or state['sequence'] < 0):
            raise ValueError
        for identity, bot in state['bots'].items():
            if (not isinstance(bot, dict) or not BOT_ID.fullmatch(identity) or bot.get('id') != identity
                    or bot.get('role') not in ROLES or bot.get('isChief') is not (identity == 'chief')
                    or type(bot.get('createdAt')) is not int or bot['createdAt'] < 0):
                raise ValueError
            for field, maximum in (('name', 32), ('instructions', 3000), ('style', 1000), ('look', 40)):
                clean_string(bot.get(field), maximum, empty=field in {'instructions', 'style'})
        if 'chief' not in state['bots']:
            raise ValueError
        for identity, channel in state['channels'].items():
            if (not isinstance(channel, dict) or channel.get('id') != identity or not valid_channel(identity)
                    or channel.get('kind') not in {'bot', 'source', 'group', 'dm'}):
                raise ValueError
            clean_string(channel.get('title'), 80)
            BotStore._members(state, channel.get('memberIds'))
            if channel.get('kind') == 'dm' and (channel.get('botId') not in channel['memberIds']
                    or channel['memberIds'] != [channel['botId']] or identity != 'src-dm-' + channel['botId']):
                raise ValueError
        if any(identity not in state['channels'] for identity in ('bot', 'src-itc', 'src-yunfeng')) or 'chief' not in state['channels']['bot']['memberIds']:
            raise ValueError
        for rows in state['histories'].values():
            if not isinstance(rows, list) or any(not isinstance(row, dict) or row.get('role') not in {'user', 'assistant'}
                    or not isinstance(row.get('content'), str) for row in rows):
                raise ValueError
        for event in state['events']:
            if (not isinstance(event, dict) or not isinstance(event.get('id'), str) or event.get('channelId') not in state['channels']
                    or event.get('botId') not in state['bots'] or type(event.get('sequence')) is not int
                    or not 0 < event['sequence'] <= state['sequence'] or type(event.get('at')) is not int
                    or event.get('kind') not in {'activity', 'text'}):
                raise ValueError
            if event['kind'] == 'text' and not isinstance(event.get('text'), str):
                raise ValueError
            if event['kind'] == 'activity' and (not isinstance(event.get('activity'), dict)
                    or event['activity'].get('type') not in {'joined', 'handoff', 'processing', 'completed', 'failed', 'unknown'}
                    or not isinstance(event['activity'].get('actors'), list)):
                raise ValueError
        for receipt in state['receipts'].values():
            if (not isinstance(receipt, dict) or not isinstance(receipt.get('signature'), str)
                    or receipt.get('status') not in {'processing', 'completed', 'failed', 'interrupted'}
                    or not isinstance(receipt.get('response'), dict) or not isinstance(receipt['response'].get('events'), list)):
                raise ValueError

    @staticmethod
    def _members(state, members):
        if (not isinstance(members, list) or not 1 <= len(members) <= 30 or any(not isinstance(value, str) for value in members)
                or len(members) != len(set(members)) or any(identity not in state['bots'] for identity in members)):
            raise AIError('invalid_bot_members', 400)
        return members

    def commit(self, mutate):
        with self.lock:
            state = copy.deepcopy(self.state)
            result = mutate(state)
            self._prune_receipts(state)
            self.validate(state)
            raw = (json.dumps(state, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
            if self.path:
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_replace(self.backup, self.last_bytes or raw)
                    _atomic_replace(self.path, raw)
                except OSError:
                    raise AIError('bots_storage_error', 503) from None
            self.state, self.last_bytes = state, raw
            return copy.deepcopy(result)

    def _recover(self):
        if not any(row['status'] == 'processing' for row in self.state['receipts'].values()):
            return
        def mutate(state):
            latest = {row['id']: row for row in state['events'] if row['kind'] == 'activity'}
            for row in list(latest.values()):
                if row['activity']['type'] == 'processing':
                    self._event(state, {**row, 'activity': {**row['activity'], 'type': 'unknown', 'detail': '上次请求状态待确认'}})
            for receipt in state['receipts'].values():
                if receipt['status'] == 'processing':
                    receipt.update(status='interrupted', error='chat_interrupted', statusCode=409)
        self.commit(mutate)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({'bots': list(self.state['bots'].values()), 'channels': list(self.state['channels'].values())})

    def bot(self, identity):
        with self.lock:
            row = self.state['bots'].get(identity) if isinstance(identity, str) else None
            if row is None:
                raise AIError('bot_not_found', 404)
            return copy.deepcopy(row)

    def channel(self, identity):
        with self.lock:
            row = self.state['channels'].get(identity) if isinstance(identity, str) else None
            if row is None:
                raise AIError('channel_not_found', 404)
            return copy.deepcopy(row)

    def actor(self, identity, profile=None):
        bot = self.bot(identity)
        # Chief keeps the user's existing locally chosen name and named look.
        profile = profile if identity == 'chief' and isinstance(profile, dict) else {}
        name = profile.get('botName')
        look = profile.get('look')
        return {'id': identity, 'name': name.strip()[:32] if isinstance(name, str) and name.strip() else bot['name'],
                'look': look if isinstance(look, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,39}', look) else bot['look']}

    @staticmethod
    def _event(state, row):
        state['sequence'] += 1
        event = {**copy.deepcopy(row), 'at': stamp(), 'sequence': state['sequence']}
        state['events'].append(event)
        state['events'] = state['events'][-2000:]
        return event

    @staticmethod
    def response_event(row):
        if row['kind'] == 'text':
            return {'type': 'message', 'id': row['id'], 'text': row['text'], 'botId': row['botId']}
        return {'type': 'activity', 'id': row['id'], 'activity': row['activity'], 'botId': row['botId']}

    def activity(self, identity, channel_id, kind, actors, detail='', request_id=None):
        row = {'id': identity, 'channelId': channel_id, 'kind': 'activity', 'botId': actors[-1]['id'],
               'activity': {'type': kind, 'actors': actors, 'detail': detail[:160]}}
        def mutate(state):
            event = self._event(state, row)
            result = self.response_event(event)
            if request_id:
                self._remember_event(state['receipts'][request_id], result)
            return result
        return self.commit(mutate)

    @staticmethod
    def _remember_event(receipt, event):
        events = receipt['response']['events']
        index = next((index for index, row in enumerate(events) if row.get('id') == event.get('id') and event.get('id')), None)
        if index is None:
            events.append(copy.deepcopy(event))
        else:
            events[index] = copy.deepcopy(event)

    def events(self, after=0):
        if type(after) is not int or after < 0:
            raise AIError('invalid_input', 400)
        with self.lock:
            if after > self.state['sequence']:
                after = 0
            rows = copy.deepcopy([row for row in self.state['events'] if row['sequence'] > after][:100])
            return {'events': rows, 'cursor': rows[-1]['sequence'] if rows else after}

    def create(self, body, *, operation_id=None):
        if not isinstance(body, dict) or set(body) - {'name', 'role', 'instructions', 'style', 'look', 'channelId'}:
            raise AIError('invalid_bot', 400)
        role = body.get('role')
        if not isinstance(role, str) or role not in ROLES:
            raise AIError('invalid_bot_role', 400)
        bot = {'id': 'bot-' + uuid.uuid4().hex[:12], 'role': role, 'isChief': False, 'createdAt': stamp()}
        for field, maximum, default in (('name', 32, None), ('instructions', 3000, ''), ('style', 1000, ''), ('look', 40, 'placeholder')):
            bot[field] = clean_string(body.get(field, default), maximum, empty=field in {'instructions', 'style'})
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', bot['look']):
            raise AIError('invalid_bot', 400)
        def mutate(state):
            if operation_id and operation_id in state['operations']:
                return state['operations'][operation_id]
            if len(state['bots']) >= 50:
                raise AIError('bot_limit', 400)
            channel_id = body.get('channelId')
            if channel_id is not None and (not isinstance(channel_id, str) or channel_id not in state['channels']):
                raise AIError('channel_not_found', 404)
            state['bots'][bot['id']] = bot
            result = {'bot': bot}
            if channel_id is not None:
                channel = state['channels'][channel_id]
                if channel['kind'] == 'dm' or len(channel['memberIds']) >= 30:
                    raise AIError('invalid_bot_members', 400)
                channel['memberIds'].append(bot['id'])
                result['channel'] = channel
                self._joined(state, channel_id, bot)
            if operation_id:
                state['operations'][operation_id] = copy.deepcopy(result)
            return result
        return self.commit(mutate)

    def update(self, identity, patch):
        self.bot(identity)
        if not isinstance(patch, dict) or not patch or set(patch) - {'name', 'role', 'instructions', 'style', 'look'}:
            raise AIError('invalid_bot', 400)
        def mutate(state):
            bot = state['bots'][identity]
            for field, value in patch.items():
                if field == 'role':
                    if not isinstance(value, str) or value not in ROLES:
                        raise AIError('invalid_bot_role', 400)
                else:
                    value = clean_string(value, {'name': 32, 'instructions': 3000, 'style': 1000, 'look': 40}[field], empty=field in {'instructions', 'style'})
                    if field == 'look' and not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', value):
                        raise AIError('invalid_bot', 400)
                bot[field] = value
            return {'bot': bot}
        return self.commit(mutate)

    def _joined(self, state, channel_id, bot):
        actor = {key: bot[key] for key in ('id', 'name', 'look')}
        self._event(state, {'id': 'team-joined-' + uuid.uuid4().hex, 'channelId': channel_id, 'botId': bot['id'],
                           'kind': 'activity', 'activity': {'type': 'joined', 'actors': [actor], 'detail': ''}})

    def create_channel(self, body):
        if not isinstance(body, dict) or set(body) - {'title', 'memberIds', 'id', 'kind'}:
            raise AIError('invalid_channel', 400)
        title = clean_string(body.get('title'), 80)
        kind = body.get('kind', 'group')
        if not isinstance(kind, str) or kind not in {'group', 'dm', 'source'}:
            raise AIError('invalid_channel', 400)
        members = body.get('memberIds')
        def mutate(state):
            self._members(state, members)
            if kind == 'dm' and len(members) != 1:
                raise AIError('invalid_bot_members', 400)
            identity = body.get('id') or ('src-dm-' + members[0] if kind == 'dm' else 'src-group-' + uuid.uuid4().hex[:12])
            if not isinstance(identity, str) or not valid_channel(identity):
                raise AIError('invalid_channel', 400)
            if kind == 'source':
                if not body.get('id') or not identity.startswith('src-') or identity.startswith(('src-group-', 'src-dm-')):
                    raise AIError('invalid_channel', 400)
            elif not identity.startswith('src-' + kind + '-'):
                raise AIError('invalid_channel', 400)
            if kind == 'dm' and identity != 'src-dm-' + members[0]:
                raise AIError('invalid_channel', 400)
            if identity in state['channels']:
                old = state['channels'][identity]
                if kind == 'dm' and old.get('botId') == members[0]:
                    return {'channel': old}
                raise AIError('channel_exists', 409)
            if len(state['channels']) >= 200:
                raise AIError('channel_limit', 400)
            row = {'id': identity, 'kind': kind, 'title': title, 'memberIds': list(members)}
            if kind == 'dm':
                row['botId'] = members[0]
            state['channels'][identity] = row
            for bot_id in members:
                self._joined(state, identity, state['bots'][bot_id])
            return {'channel': row}
        return self.commit(mutate)

    def set_members(self, channel_id, members, *, operation_id=None):
        self.channel(channel_id)
        def mutate(state):
            if operation_id and operation_id in state['operations']:
                return state['operations'][operation_id]
            self._members(state, members)
            row = state['channels'][channel_id]
            if channel_id == 'bot' and 'chief' not in members or row['kind'] == 'dm' and members != [row['botId']]:
                raise AIError('invalid_bot_members', 400)
            for bot_id in members:
                if bot_id not in row['memberIds']:
                    self._joined(state, channel_id, state['bots'][bot_id])
            row['memberIds'] = list(members)
            result = {'channel': row}
            if operation_id:
                state['operations'][operation_id] = copy.deepcopy(result)
            return result
        return self.commit(mutate)

    def route(self, channel_id, text, bot_id=None, *, chief_name=None):
        channel = self.channel(channel_id)
        bots = self.snapshot()['bots']
        labels = [(bot['id'], label) for bot in bots for label in {bot['id'], bot['name']}]
        if isinstance(chief_name, str) and chief_name.strip():
            labels.append(('chief', chief_name.strip()))
        marker = re.compile(r'(?<![\w.+%-])[@＠]')
        mentioned, position = [], 0
        while match := marker.search(text, position):
            rest = text[match.end():]
            if rest.startswith('「'):
                close = rest.find('」')
                if close < 0:
                    raise AIError('bot_mention_invalid', 400)
                token = rest[1:close]
                candidates = {identity for identity, label in labels if label == token}
                consumed = close + 1
            else:
                candidates_by_length = [(len(label), identity) for identity, label in labels
                    if rest.startswith(label) and (len(rest) == len(label) or rest[len(label)].isspace()
                        or rest[len(label)] in '，,。:：!?！？、;；()（）')]
                longest = max((length for length, _ in candidates_by_length), default=0)
                candidates = {identity for length, identity in candidates_by_length if length == longest}
                consumed = longest
            if len(candidates) != 1:
                raise AIError('bot_mention_invalid', 400)
            mentioned.append(next(iter(candidates)))
            position = match.end() + consumed
        if len(mentioned) > 1:
            raise AIError('multiple_bot_mentions', 400)
        if mentioned:
            target = mentioned[0]
            if bot_id is not None and bot_id != target:
                raise AIError('bot_target_conflict', 400)
            bot_id = target
        if bot_id is None:
            bot_id = channel.get('botId') or ('chief' if 'chief' in channel['memberIds'] else channel['memberIds'][0])
        if not isinstance(bot_id, str) or bot_id not in channel['memberIds']:
            raise AIError('bot_not_in_channel', 403)
        return self.bot(bot_id)

    def has_history(self, channel_id):
        with self.lock:
            return any(key.startswith(channel_id + ':') and rows for key, rows in self.state['histories'].items())

    def import_legacy_history(self, channel_id, bot_id, rows):
        """Import bounded pre-upgrade local chat once; never override server data."""
        if bot_id != 'chief' or self.channel(channel_id)['kind'] == 'dm':
            return False
        if (not isinstance(rows, list) or len(rows) > 24
                or any(not isinstance(row, dict) or row.get('role') not in {'user', 'assistant'}
                       or not isinstance(row.get('content'), str) for row in rows)
                or sum(len(row['content']) for row in rows) > 24000):
            raise AIError('invalid_input', 400)
        if not rows:
            return False
        imported = [{'role': row['role'], 'content': redact_text(row['content']),
                     **({'botId': 'chief'} if row['role'] == 'assistant' else {})} for row in rows]
        def mutate(state):
            if any(key.startswith(channel_id + ':') and existing for key, existing in state['histories'].items()):
                return False
            state['histories'][channel_id + ':*'] = copy.deepcopy(imported)
            state['histories'][channel_id + ':chief'] = copy.deepcopy(imported)
            return True
        return self.commit(mutate)

    def history(self, channel_id, bot_id, *, shared=False):
        with self.lock:
            return copy.deepcopy(self.state['histories'].get(channel_id + ':' + ('*' if shared else bot_id), []))

    def receipt(self, request_id):
        with self.lock:
            return copy.deepcopy(self.state['receipts'].get(request_id))

    def begin(self, request_id, signature):
        def mutate(state):
            state['receipts'][request_id] = {'signature': signature, 'status': 'processing', 'response': {'events': []}}
        self.commit(mutate)

    def remember(self, request_id, event):
        self.commit(lambda state: self._remember_event(state['receipts'][request_id], event))

    def finish(self, request_id, *, channel_id, bot_id, text=None, user_text=None, error=None):
        def mutate(state):
            receipt = state['receipts'][request_id]
            receipt['status'] = 'failed' if error else 'completed'
            if error:
                receipt.update(error=error.code, statusCode=error.status)
            if text:
                # One model answer is one document: arbitrary character cuts
                # can split Markdown fences, links, lists or tables.
                row = self._event(state, {'id': 'team-text-' + request_id + '-0', 'channelId': channel_id, 'botId': bot_id, 'kind': 'text', 'text': text})
                self._remember_event(receipt, self.response_event(row))
                if user_text is not None and not error:
                    key = channel_id + ':' + bot_id
                    rows = state['histories'].setdefault(key, [])
                    addition = [{'role': 'user', 'content': user_text[:4000]}] + [
                        {'role': 'assistant', 'content': text[offset:offset + 1800], 'botId': bot_id}
                        for offset in range(0, len(text), 1800)]
                    rows.extend(addition)
                    state['histories'][key] = rows[-24:]
                    if state['channels'][channel_id]['kind'] != 'dm':
                        shared_key = channel_id + ':*'
                        shared_rows = state['histories'].setdefault(shared_key, [])
                        shared_rows.extend(copy.deepcopy(addition))
                        state['histories'][shared_key] = shared_rows[-24:]
            return receipt['response']
        return self.commit(mutate)
