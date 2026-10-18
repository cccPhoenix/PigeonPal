"""Bounded current-homework views and private, deterministic local queries."""
from datetime import datetime, timedelta, timezone
import re
import time

ZONE = timezone(timedelta(hours=8))
TERM = re.compile(r'(?:^|\()(\d{4})-(\d{4})-([123])(?:\)|[-_]|$)')


def stamp(value):
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if at.tzinfo is None:
            at = at.replace(tzinfo=ZONE)
        return at.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def academic_term(now):
    at = datetime.fromtimestamp(now, ZONE)
    year = at.year if at.month >= 9 else at.year - 1
    return year, year + 1, 1 if at.month >= 9 or at.month == 1 else 2


def course_is_current(code, now):
    match = TERM.search(code) if isinstance(code, str) else None
    return tuple(map(int, match.groups())) == academic_term(now) if match else None


def is_current_homework(row, now, *, include_completed=False):
    hw = row.get('homework', {})
    if not isinstance(hw, dict) or not include_completed and hw.get('isClosed') is True:
        return False
    if course_is_current(hw.get('courseCode'), now) is False:
        return False
    opened = stamp(hw.get('openAt'))
    if opened is not None and opened > now:
        return False
    deadline = stamp(hw.get('deadlineAt'))
    if include_completed:
        year, _, term = academic_term(now)
        start = datetime(year if term == 1 else year + 1, 9 if term == 1 else 2, 1, tzinfo=ZONE).timestamp()
        return course_is_current(hw.get('courseCode'), now) is True or (deadline is not None and deadline >= start) or (opened is not None and opened >= start)
    if deadline is not None:
        if len(hw['deadlineAt']) == 10:
            # This is an eligibility boundary, not a guessed reminder time.
            return datetime.fromtimestamp(deadline, ZONE).date() >= datetime.fromtimestamp(now, ZONE).date()
        return deadline > now
    year, _, term = academic_term(now)
    start = datetime(year if term == 1 else year + 1, 9 if term == 1 else 2, 1, tzinfo=ZONE).timestamp()
    return course_is_current(hw.get('courseCode'), now) is True or opened is not None and start <= opened <= now


def _due(row):
    value = stamp(row.get('homework', {}).get('deadlineAt'))
    return value if value is not None else float('inf')


def _recent(row):
    return stamp(row.get('homework', {}).get('openAt')) or stamp(row.get('firstSeenAt')) or 0


def select_homework(rows, *, now=None, query=None):
    now = time.time() if now is None else now
    submitted = query is not None and query.get('status') == 'submitted'
    active = [row for row in rows if row.get('sourceId') == 'xzzd' and is_current_homework(row, now, include_completed=submitted)
              and (row.get('homework', {}).get('submissionStatus') == 'submitted' if submitted else row.get('homework', {}).get('submissionStatus') != 'submitted')]
    if query is not None:
        if query.get('status') == 'unsubmitted':
            active = [row for row in active if row['homework'].get('submissionStatus') == 'not_submitted']
        if query.get('days') is not None:
            today = datetime.fromtimestamp(now, ZONE).date()
            begin = today + timedelta(days=query.get('offset', 0))
            end = begin + timedelta(days=query['days'])
            active = [row for row in active if stamp(row['homework'].get('deadlineAt')) is not None
                      and begin <= datetime.fromtimestamp(stamp(row['homework']['deadlineAt']), ZONE).date() < end]
        if query.get('order') == 'recent':
            active = sorted(active, key=lambda row: (_recent(row), row['id']), reverse=True)[:query.get('limit', 5)]
            active.sort(key=lambda row: (_due(row), row['id']))
        else:
            known = [row for row in active if _due(row) != float('inf')]
            unknown = [row for row in active if _due(row) == float('inf')]
            active = sorted(known, key=_due, reverse=query.get('order') == 'desc') + unknown
        return active[:query.get('limit', 5)]
    recent = sorted([row for row in active if row['homework'].get('submissionStatus') == 'not_submitted'], key=lambda row: (_recent(row), row['id']), reverse=True)[:5]
    nearest = sorted([row for row in active if _due(row) != float('inf')], key=lambda row: (_due(row), row['id']))[:3]
    chosen = {row['id']: row for row in recent + nearest}
    return sorted(chosen.values(), key=lambda row: (_due(row), row['id']))


def _number(value):
    if value.isdigit():
        return min(20, max(1, int(value)))
    digits = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
    if '十' in value:
        left, right = value.split('十', 1)
        return min(20, max(1, (digits.get(left, 1) if left else 1) * 10 + digits.get(right, 0)))
    return max(1, digits.get(value, 5))


def parse_homework_query(text, channel_id='bot'):
    if not isinstance(text, str):
        return None
    text = text.strip()
    if ('作业' not in text and not (channel_id == 'src-xzzd' and re.search(r'列出|列一下|查看|显示|未交|未提交|截止|有哪些|最近|近到远|远到近|这学期|本学期|还有', text))
            or re.search(r'提醒|闹钟|取消|设置|叫我|叫醒|帮我写|帮我做|解答|润色|生成|完成这|写一', text)):
        return None
    if not re.search(r'列|查|看|显示|最近|哪些|什么|截止|未交|未提交|还没|没有提交|没交|没结束|没有结束|近到远|远到近|这学期|本学期|还有', text) and text != '作业':
        return None
    match = re.search(r'([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*(?:条|份|项|个)', text)
    query = {'limit': _number(match.group(1)) if match else 5, 'status': 'pending', 'order': 'asc'}
    if re.search(r'已(?:经)?(?:提交|交)|交过|已完成', text):
        query['status'] = 'submitted'
    if re.search(r'未提交|未交|没(?:有)?(?:提交|交|结束|完成)|未完成|待交', text):
        query['status'] = 'unsubmitted'
    if re.search(r'晚到早|远到近|降序|倒序', text):
        query['order'] = 'desc'
    elif re.search(r'最近|最新', text) and not re.search(r'近到远|早到晚|截止|到期|时间|升序', text):
        query['order'] = 'recent'
    if '今天' in text:
        query.update(days=1, offset=0)
    elif '明天' in text:
        query.update(days=1, offset=1)
    elif '本周' in text or '这周' in text:
        query.update(days=7-datetime.fromtimestamp(time.time(), ZONE).weekday(), offset=0)
    return query


def homework_query_reply(rows, text, channel_id='bot', *, now=None, selected=None):
    query = parse_homework_query(text, channel_id)
    if query is None:
        return None
    selected = select_homework(rows, now=now, query=query) if selected is None else selected
    if not selected:
        return '本机当前没有符合条件的作业。只查询尚未截止、未关闭的当前作业；未知提交状态不会算作“未提交”。若刚启动，作业列表可能仍在采集中。'
    label = {'unsubmitted':'明确未提交', 'submitted':'已提交', 'pending':'待处理'}[query['status']]
    order = {'asc':'截止时间从近到远', 'desc':'截止时间从远到近', 'recent':'最近开放／收录，按截止时间从近到远'}[query['order']]
    lines = [f'找到 {len(selected)} 条{label}作业（{order}）：']
    for index, row in enumerate(selected, 1):
        hw = row['homework']; value = hw.get('deadlineAt'); at = stamp(value)
        due = (datetime.fromtimestamp(at, ZONE).strftime('%Y-%m-%d %H:%M（北京时间）') if 'T' in value
               else value + '（原站仅提供日期）') if at is not None else '原站未说明'
        status = {'not_submitted':'未提交','submitted':'已提交'}.get(hw.get('submissionStatus'),'提交状态未知')
        # Plain text avoids turning school titles into Markdown instructions/links.
        title = re.sub(r'\s+', ' ', str(row.get('title', '作业')))
        course = re.sub(r'\s+', ' ', str(hw.get('courseName') or '原站未说明课程'))
        lines.append(f'{index}. {course}｜{title}\n   截止：{due}；状态：{status}')
    return '\n\n'.join(lines)
