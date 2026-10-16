"""Persistent reminders, delivery events and idempotent chat receipts."""

import copy
import heapq
from datetime import datetime, time as day_time, timedelta, timezone
import json
import math
import re
import threading
import time
import uuid

from crawlers.storage import StorageError, _atomic_replace
from .schema import AIError, parse_time


LOCAL_ZONE = timezone(timedelta(hours=8))


def valid_channel(value):
    return isinstance(value, str) and bool(re.fullmatch(r"(?:bot|src-[\w-]{1,48}|talks|academic|clubs)", value))


class RuntimeStore:
    def __init__(self, path):
        self.path, self.backup = path, path.with_name(path.name + ".bak")
        self.lock = threading.RLock()
        self.state = {"schemaVersion": 1, "reminders": {}, "events": [], "sequence": 0, "receipts": {}}
        self.last_bytes = None
        self._due_heap = []
        self._scheduled = {}
        damaged = False
        for candidate in (path, self.backup):
            try:
                raw = candidate.read_bytes()
                def reject_constant(value):
                    raise ValueError
                value = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
                if (not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != 1
                        or not isinstance(value.get("reminders"), dict) or not isinstance(value.get("events"), list)
                        or type(value.get("sequence")) is not int or value["sequence"] < 0 or not isinstance(value.get("receipts"), dict)):
                    raise ValueError
                for identity, row in value["reminders"].items():
                    if (not isinstance(row, dict) or not isinstance(identity, str) or row.get("id") != identity
                            or not isinstance(row.get("title"), str) or not valid_channel(row.get("channelId"))
                            or row.get("status") not in {"pending", "done", "cancelled"}
                            or type(row.get("dueAt")) not in {int, float} or not math.isfinite(row["dueAt"]) or row["dueAt"] <= 0):
                        raise ValueError
                    for name in ("createdAt", "deliveredAt", "updatedAt"):
                        stamp = row.get(name)
                        if stamp is not None and (type(stamp) not in {int, float} or not math.isfinite(stamp) or stamp < 0):
                            raise ValueError
                for event in value["events"]:
                    if (not isinstance(event, dict) or not isinstance(event.get("id"), str)
                            or not isinstance(event.get("text"), str) or not valid_channel(event.get("channelId"))
                            or type(event.get("sequence")) is not int or not 0 < event["sequence"] <= value["sequence"]
                            or type(event.get("at")) not in {int, float} or not math.isfinite(event["at"])
                            or not isinstance(event.get("reminderId"), str)):
                        raise ValueError
                for receipt in value["receipts"].values():
                    if (not isinstance(receipt, dict) or not isinstance(receipt.get("signature"), str)
                            or not isinstance(receipt.get("response"), dict) or not isinstance(receipt["response"].get("events"), list)):
                        raise ValueError
                self.state, self.last_bytes = value, raw
                self._rebuild_queue()
                return
            except FileNotFoundError:
                continue
            except (OSError, UnicodeError, ValueError):
                damaged = True
        if damaged:
            raise StorageError("runtime_state_invalid")

    def _rebuild_queue(self):
        self._scheduled = {identity: row['dueAt'] for identity, row in self.state['reminders'].items()
                           if row['status'] == 'pending' and row['deliveredAt'] is None}
        self._due_heap = [(due, identity) for identity, due in self._scheduled.items()]
        heapq.heapify(self._due_heap)

    def _update_queue(self, identities):
        for identity in identities:
            row = self.state['reminders'].get(identity)
            if row is None or row['status'] != 'pending' or row['deliveredAt'] is not None:
                self._scheduled.pop(identity, None)
            elif self._scheduled.get(identity) != row['dueAt']:
                self._scheduled[identity] = row['dueAt']
                heapq.heappush(self._due_heap, (row['dueAt'], identity))
        # Lazy stale entries keep updates cheap; compact on mutations only.
        if len(self._due_heap) > max(64, 2 * len(self._scheduled)):
            self._due_heap = [(due, identity) for identity, due in self._scheduled.items()]
            heapq.heapify(self._due_heap)

    def commit(self, mutate, *, queue_ids=None):
        with self.lock:
            state = copy.deepcopy(self.state)
            result = mutate(state)
            raw = (json.dumps(state, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_replace(self.backup, self.last_bytes or raw)
                _atomic_replace(self.path, raw)
            except OSError:
                raise AIError("reminder_storage_error", 503) from None
            self.state, self.last_bytes = state, raw
            if queue_ids is None:
                self._rebuild_queue()
            else:
                self._update_queue(queue_ids)
            return copy.deepcopy(result)

    def reminders(self):
        with self.lock:
            return sorted(copy.deepcopy(list(self.state["reminders"].values())), key=lambda row: row["dueAt"])

    @staticmethod
    def due_time(value, *, allow_past=False):
        if isinstance(value, str):
            try:
                parsed = parse_time(value)
            except AIError:
                raise AIError("invalid_reminder_time", 400) from None
            if not isinstance(parsed, datetime):
                raise AIError("reminder_time_required", 400)
            value = parsed.timestamp() * 1000
        if type(value) not in {int, float} or not math.isfinite(value) or value <= 0:
            raise AIError("invalid_reminder_time", 400)
        try:
            datetime.fromtimestamp(value / 1000, timezone.utc)
        except (ValueError, OverflowError, OSError):
            raise AIError("invalid_reminder_time", 400) from None
        if not allow_past and value <= time.time() * 1000:
            raise AIError("reminder_time_in_past", 400)
        return int(value)

    def create(self, title, due_at, channel_id="bot", notice_id=None, *, identity=None, automatic=False):
        if not isinstance(title, str) or not title.strip() or len(title) > 80 or not valid_channel(channel_id):
            raise AIError("invalid_reminder", 400)
        if notice_id is not None and (not isinstance(notice_id, str) or len(notice_id) > 160):
            raise AIError("invalid_reminder", 400)
        due = self.due_time(due_at)
        with self.lock:
            if identity and identity in self.state["reminders"]:
                return copy.deepcopy(self.state["reminders"][identity])
            if notice_id is None:
                duplicate = next((row for row in self.state["reminders"].values() if row["status"] == "pending"
                                  and row["channelId"] == channel_id and row["title"] == title.strip() and row["dueAt"] == due), None)
                if duplicate:
                    return copy.deepcopy(duplicate)
            existing = next((row for row in self.state["reminders"].values()
                             if notice_id and row["noticeId"] == notice_id and row["status"] == "pending"), None)
            if existing:
                return self.update(existing["id"], {"title": title.strip(), "dueAt": due})
            row = {"id": identity or "rem-" + str(uuid.uuid4()), "title": title.strip(), "dueAt": due,
                   "channelId": channel_id, "noticeId": notice_id, "status": "pending",
                   "deliveredAt": None, "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000), "automatic": automatic}
            return self.commit(lambda state: state["reminders"].setdefault(row["id"], row), queue_ids=(row["id"],))

    def update(self, identity, patch, *, internal=False):
        if not isinstance(identity, str) or not isinstance(patch, dict) or set(patch) - {"title", "dueAt", "status"}:
            raise AIError("invalid_reminder", 400)
        def mutate(state):
            row = state["reminders"].get(identity)
            if row is None:
                raise AIError("reminder_not_found", 404)
            if "title" in patch:
                if not isinstance(patch["title"], str) or not patch["title"].strip() or len(patch["title"]) > 80:
                    raise AIError("invalid_reminder", 400)
                row["title"] = patch["title"].strip()
            if "dueAt" in patch:
                due = self.due_time(patch["dueAt"])
                if due != row["dueAt"]:
                    row.update(dueAt=due, deliveredAt=None, status="pending")
            if "status" in patch:
                if patch["status"] not in {"pending", "done", "cancelled"}:
                    raise AIError("invalid_reminder", 400)
                row["status"] = patch["status"]
                if patch["status"] == "cancelled" and not internal:
                    row["cancelReason"] = "user"
                elif patch["status"] == "pending":
                    row.pop("cancelReason", None)
            if not internal and ("dueAt" in patch or "title" in patch):
                row["automatic"] = False
            row["updatedAt"] = int(time.time() * 1000)
            return row
        return self.commit(mutate, queue_ids=(identity,))

    def import_legacy(self, rows):
        if not isinstance(rows, list) or len(rows) > 200:
            raise AIError("invalid_input", 400)
        imported = []
        def mutate(state):
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str) or len(row["id"]) > 160:
                    raise AIError("invalid_reminder", 400)
                if row["id"] in state["reminders"]:
                    continue
                if not isinstance(row.get("title"), str) or not row["title"].strip() or len(row["title"]) > 80:
                    raise AIError("invalid_reminder", 400)
                due = self.due_time(row.get("dueAt"), allow_past=True)
                status = row.get("status", "pending")
                if status not in {"pending", "done", "cancelled"}:
                    raise AIError("invalid_reminder", 400)
                delivered = row.get("deliveredAt")
                if delivered is not None:
                    delivered = self.due_time(delivered, allow_past=True)
                imported.append(row["id"])
                state["reminders"][row["id"]] = {
                    "id": row["id"], "title": row["title"].strip(), "dueAt": due,
                    "channelId": row.get("channelId") if valid_channel(row.get("channelId")) else "bot",
                    "noticeId": row.get("noticeId") if isinstance(row.get("noticeId"), str) else None,
                    "status": status, "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000), "deliveredAt": delivered, "automatic": False,
                }
        self.commit(mutate, queue_ids=imported)
        return self.reminders()

    def schedule_deadline(self, notice, result):
        identity = "rem-ddl-" + str(uuid.uuid5(uuid.NAMESPACE_URL, notice["id"]))
        deadline = parse_time(result.get("deadlineAt"))
        now = datetime.now(LOCAL_ZONE)
        expired = deadline is None or (deadline <= now if isinstance(deadline, datetime) else deadline < now.date())
        if expired:
            with self.lock:
                old = self.state["reminders"].get(identity)
                if (old and old.get("automatic") and old["status"] == "pending" and old.get("sourceHash")
                        and old["sourceHash"] != notice.get("contentHash")):
                    def cancel(state):
                        state["reminders"][identity].update(status="cancelled", cancelReason="notice_updated", updatedAt=int(time.time() * 1000))
                    self.commit(cancel, queue_ids=(identity,))
            return
        if isinstance(deadline, datetime):
            due = deadline - timedelta(hours=24)
            if due <= now:
                due = max(now + timedelta(seconds=5), deadline - timedelta(hours=1))
            if due >= deadline:
                due = min(deadline, now + timedelta(seconds=1))
        else:
            # This is the reminder time, never an invented deadline time.
            due = datetime.combine(deadline, day_time(9), LOCAL_ZONE)
            if due <= now:
                due = now + timedelta(seconds=5)
        with self.lock:
            old = self.state["reminders"].get(identity)
            if old:
                if not old.get("automatic") or old["status"] == "done" or (old["status"] == "cancelled" and old.get("cancelReason") != "notice_updated"):
                    return
                if old.get("deadlineValue") != result["deadlineAt"] or old["status"] == "cancelled":
                    self.update(identity, {"dueAt": int(due.timestamp() * 1000), "status": "pending"}, internal=True)
                if old.get("sourceHash") != notice.get("contentHash") or old.get("deadlineValue") != result["deadlineAt"]:
                    self.commit(lambda state: state["reminders"][identity].update(deadlineValue=result["deadlineAt"], sourceHash=notice.get("contentHash")), queue_ids=())
                return
            if any(row["noticeId"] == notice["id"] and row["status"] == "pending" for row in self.state["reminders"].values()):
                return
            row = self.create("「" + notice["title"][:60] + "」截止提醒", int(due.timestamp() * 1000),
                              "src-" + notice["sourceId"], notice["id"], identity=identity, automatic=True)
            self.commit(lambda state: state["reminders"][row["id"]].update(deadlineValue=result["deadlineAt"], sourceHash=notice.get("contentHash")), queue_ids=())

    def tick(self):
        now = int(time.time() * 1000)
        with self.lock:
            due_entries, seen = [], set()
            while self._due_heap:
                due, identity = self._due_heap[0]
                if self._scheduled.get(identity) != due:
                    heapq.heappop(self._due_heap)
                    continue
                if due > now:
                    break
                heapq.heappop(self._due_heap)
                if identity not in seen:
                    due_entries.append((due, identity))
                    seen.add(identity)
            if not due_entries:
                return
            def mutate(state):
                for _, identity in due_entries:
                    row = state['reminders'][identity]
                    if row['status'] != 'pending' or row['deliveredAt'] is not None or row['dueAt'] > now:
                        continue
                    row['deliveredAt'] = now
                    row['updatedAt'] = now
                    state['sequence'] += 1
                    text = '⏰ {nickname}，' + row['title'] + '到时间啦。'
                    if row.get('deadlineValue'):
                        text += '\n原通知截止日期／时间：' + row['deadlineValue'] + '。具体要求请查看原文。'
                    event_id = 'event-' + str(uuid.uuid5(uuid.NAMESPACE_URL, row['id'] + ':' + str(row['dueAt'])))
                    state['events'].append({'id': event_id, 'sequence': state['sequence'],
                        'channelId': row['channelId'], 'at': now,
                        'kind': 'reminder', 'text': text, 'reminderId': row['id']})
                state['events'] = state['events'][-2000:]
            try:
                self.commit(mutate, queue_ids=seen)
            except Exception:
                # Persisted JSON still says pending. Restore popped candidates
                # so a storage failure cannot silently lose a due reminder.
                for entry in due_entries:
                    heapq.heappush(self._due_heap, entry)
                raise

    def events(self, after=0):
        with self.lock:
            if after > self.state["sequence"]:
                after = 0
            rows = copy.deepcopy([row for row in self.state["events"] if row["sequence"] > after][:100])
            return {"events": rows, "cursor": rows[-1]["sequence"] if rows else after}

    def receipt(self, request_id):
        with self.lock:
            return copy.deepcopy(self.state["receipts"].get(request_id))

    def save_receipt(self, request_id, value):
        def mutate(state):
            state["receipts"][request_id] = value
            while len(state["receipts"]) > 500:
                state["receipts"].pop(next(iter(state["receipts"])))
        self.commit(mutate, queue_ids=())
