// Reminder lifecycle, pure functions over state.reminders. A reminder fires once;
// moving its time re-arms it, and finishing or cancelling it stops it for good.

export const newId = (prefix = 'id') => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`

function clean(title, dueAt, now) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('想提醒什么事呢？')
  const at = typeof dueAt === 'number' ? dueAt : new Date(dueAt).getTime()
  if (!Number.isFinite(at)) throw new Error('这个时间看不懂')
  if (at <= now) throw new Error('这个时间已经过去啦')
  return { title: title.trim().slice(0, 80), dueAt: at }
}

// A notice can hold one live reminder; asking again moves it instead of adding a second.
export function addReminder(state, { title, dueAt, channelId = 'bot', noticeId = null }, now = Date.now()) {
  const values = clean(title, dueAt, now)
  const existing = noticeId && state.reminders.find(r => r.noticeId === noticeId && r.status === 'pending')
  if (existing) return updateReminder(state, existing.id, values, now)
  const reminder = { id: newId('rem'), ...values, channelId, noticeId, status: 'pending', deliveredAt: null, createdAt: now }
  state.reminders.push(reminder)
  return reminder
}

export function updateReminder(state, id, patch, now = Date.now()) {
  const reminder = state.reminders.find(r => r.id === id)
  if (!reminder) throw new Error('找不到这条提醒')
  if (patch.title !== undefined || patch.dueAt !== undefined) {
    const moved = patch.dueAt !== undefined && patch.dueAt !== reminder.dueAt
    Object.assign(reminder, clean(patch.title ?? reminder.title, patch.dueAt ?? reminder.dueAt, now))
    if (moved) { reminder.deliveredAt = null; reminder.status = 'pending' }
  }
  if (patch.status !== undefined) {
    if (!['pending', 'done', 'cancelled'].includes(patch.status)) throw new Error('提醒状态无效')
    reminder.status = patch.status
  }
  return reminder
}

export const dueReminders = (state, now = Date.now()) =>
  state.reminders.filter(r => r.status === 'pending' && r.deliveredAt === null && r.dueAt <= now)

export function markDelivered(state, id, now = Date.now()) {
  const reminder = state.reminders.find(r => r.id === id)
  if (!reminder || reminder.status !== 'pending' || reminder.deliveredAt !== null) return null
  reminder.deliveredAt = now
  return reminder
}

export const pendingReminders = state =>
  state.reminders.filter(r => r.status === 'pending').sort((a, b) => a.dueAt - b.dueAt)
