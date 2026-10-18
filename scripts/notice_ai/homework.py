"""Deterministic local homework deadlines; no model or school requests."""
import copy
from datetime import datetime, timezone, timedelta
import time
import uuid

from crawlers.homework_contract import normalize_homework
from crawlers.homework_selection import is_current_homework

SIX_HOURS = 6 * 60 * 60 * 1000
POLICY = 'homework-six-hour'


def homework_item(notice):
    metadata = normalize_homework(notice.get('homework'))
    activity, course = metadata['activityId'], metadata['courseId']
    url = f'https://courses.zju.edu.cn/course/{course}/learning-activity#/{activity}' if course else 'https://courses.zju.edu.cn/'
    return {'id': notice['id'], 'noticeId': notice['id'], 'sourceId': 'xzzd', 'kind': 'homework',
            'real': True, 'analysisState': 'local_only', 'title': str(notice.get('title', '作业'))[:1000],
            'url': url, 'homework': metadata, 'deadlineAt': metadata['deadlineAt']}


def deadline_ms(value):
    # Date-only deadlines never acquire an invented time, even for reminders.
    if not isinstance(value, str) or 'T' not in value:
        return None
    try:
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(at.timestamp() * 1000) if at.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None



def deadline_order_ms(value):
    """Date-only midnight is a sorting key, never a scheduled deadline."""
    if isinstance(value, str) and len(value) == 10:
        try:
            return int(datetime.fromisoformat(value).replace(tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000)
        except (ValueError, OverflowError, OSError):
            return None
    return deadline_ms(value)

def reconcile_homework(runtime, notices):
    now = int(time.time() * 1000)
    updates = {}
    with runtime.lock:
        for notice in notices:
            if notice.get('sourceId') != 'xzzd' or not str(notice.get('id', '')).startswith('xzzd:'):
                continue
            identity = 'rem-hw-' + str(uuid.uuid5(uuid.NAMESPACE_URL, notice['id']))
            old = runtime.state['reminders'].get(identity)
            if old and (not old.get('automatic') or old['status'] == 'done'
                        or old['status'] == 'cancelled' and old.get('cancelReason') != 'homework_updated'):
                continue
            try:
                item = homework_item(notice)
            except (ValueError, TypeError):
                item = None
            homework = item['homework'] if item else {}
            deadline = deadline_ms(homework.get('deadlineAt'))
            eligible = (is_current_homework(notice, now / 1000) and deadline is not None and deadline > now
                        and homework.get('submissionStatus') != 'submitted' and homework.get('isClosed') is not True)
            if not eligible:
                if old and old['status'] == 'pending':
                    updates[identity] = {**old, 'status': 'cancelled', 'cancelReason': 'homework_updated', 'updatedAt': now}
                continue
            row = copy.deepcopy(old) if old else {
                'id': identity, 'channelId': 'src-xzzd', 'noticeId': notice['id'], 'automatic': True,
                'createdAt': now, 'updatedAt': now, 'deliveredAt': None,
            }
            if old and old.get('homeworkDeadlineMs') != deadline:
                event_id = 'event-' + str(uuid.uuid5(uuid.NAMESPACE_URL, identity + ':' + str(deadline - SIX_HOURS)))
                delivered = next((event for event in runtime.state['events'] if event['id'] == event_id), None)
                row['deliveredAt'] = delivered['at'] if delivered else None
            row.update(title=item['title'][:80] or '作业', dueAt=deadline - SIX_HOURS, status='pending',
                       policy=POLICY, homeworkDeadlineMs=deadline, homeworkItem=item)
            row.pop('cancelReason', None)
            if row != old:
                row['updatedAt'] = now
                updates[identity] = row
        if updates:
            runtime.commit(lambda state: state['reminders'].update(updates), queue_ids=tuple(updates))
