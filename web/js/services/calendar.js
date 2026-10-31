import { cleanHomework } from './homework.js'

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const partOf = (at, name) => parts.formatToParts(new Date(at)).find(part => part.type === name)?.value || ''
const usableTime = at => Number.isFinite(at) && Number.isFinite(new Date(at).getTime())

export const validCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
export const validCalendarTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
export const shanghaiDate = at => usableTime(at) ? `${partOf(at, 'year')}-${partOf(at, 'month')}-${partOf(at, 'day')}` : null
export const shanghaiTime = at => usableTime(at) ? `${partOf(at, 'hour')}:${partOf(at, 'minute')}` : ''

// Date-only deadlines stay date-only. They never acquire an invented clock time.
const deadlineDate = value => {
  if (typeof value !== 'string' || !validCalendarDate(value.slice(0, 10))) return null
  if (!value.includes('T')) return value
  const at = Date.parse(value)
  return Number.isFinite(at) ? shanghaiDate(at) : null
}
const deadlineTime = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
  ? shanghaiTime(Date.parse(value)) : ''

export function noticeCalendarDateTime(notice) {
  if (Number.isFinite(notice?.eventAt) && notice.eventAt > 0) {
    return { date: shanghaiDate(notice.eventAt), time: shanghaiTime(notice.eventAt) }
  }
  const date = deadlineDate(notice?.deadlineAt)
  return { date: date || '', time: date ? deadlineTime(notice.deadlineAt) : '' }
}

export function buildCalendarItems(state) {
  const completion = state.calendarCompleted || {}
  const rows = []
  const homeworkOverrides = new Map(Object.values(state.calendarItems || {})
    .filter(item => item.noticeId?.startsWith('xzzd:')).map(item => [item.noticeId, item]))
  for (const item of Object.values(state.homeworkItems || {})) {
    const hw = cleanHomework(item.homework)
    const date = deadlineDate(hw.deadlineAt)
    if (!date) continue
    const override = homeworkOverrides.get(item.noticeId)
    if (override && validCalendarDate(override.date)) {
      rows.push({ id: override.id, title: override.title, date: override.date, time: override.time || '', kind: 'homework',
        source: hw.courseName || '学在浙大', completed: override.completed === true, noticeId: item.noticeId, calendarOverride: true })
      continue
    }
    const id = `homework:${item.noticeId}`
    rows.push({ id, title: item.title, date, time: deadlineTime(hw.deadlineAt), kind: 'homework',
      source: hw.courseName || '学在浙大', completed: completion[id] ?? hw.submissionStatus === 'submitted', noticeId: item.noticeId })
  }
  const noticeReminders = new Map()
  const noticeCalendarItems = new Map()
  for (const reminder of state.reminders || []) {
    if (reminder.status === 'cancelled' || reminder.automatic === true
        || reminder.automatic == null && /^rem-(?:ddl|hw)-/.test(reminder.id)) continue
    if (reminder.noticeId?.startsWith('xzzd:')) continue // The homework deadline already has one calendar row.
    if (reminder.noticeId) {
      const old = noticeReminders.get(reminder.noticeId)
      if (!old || (reminder.updatedAt || reminder.createdAt || 0) > (old.updatedAt || old.createdAt || 0)) noticeReminders.set(reminder.noticeId, reminder)
      continue
    }
    const date = shanghaiDate(reminder.dueAt)
    if (!date) continue
    const id = `reminder:${reminder.id}`
    rows.push({ id, title: reminder.title, date, time: shanghaiTime(reminder.dueAt), kind: 'reminder',
      source: '提醒', completed: reminder.status === 'done', reminderId: reminder.id, reminderStatus: reminder.status })
  }
  for (const item of Object.values(state.calendarItems || {})) {
    if (item.noticeId) noticeCalendarItems.set(item.noticeId, item)
  }
  for (const [noticeId, reminder] of noticeReminders) {
    if (noticeCalendarItems.has(noticeId)) continue
    const notice = state.notices?.[noticeId]
    const date = shanghaiDate(reminder.dueAt)
    if (!date) continue
    const id = `notice:${noticeId}`
    const source = state.channels?.find(channel => channel.sourceId === notice?.sourceId)?.title || '通知提醒'
    rows.push({ id, title: notice?.title || reminder.title, date,
      time: shanghaiTime(reminder.dueAt), kind: 'notice', source,
      completed: reminder.status === 'done', noticeId, reminderAt: reminder.dueAt,
      reminderId: reminder.id, reminderStatus: reminder.status })
  }
  for (const item of Object.values(state.calendarItems || {})) {
    if (!validCalendarDate(item.date)) continue
    if (item.noticeId?.startsWith('xzzd:')) {
      if (!state.homeworkItems?.[item.noticeId]) rows.push({ id: item.id, title: item.title, date: item.date,
        time: item.time || '', kind: 'homework', source: '学在浙大', completed: item.completed === true,
        noticeId: item.noticeId, calendarOverride: true })
      continue
    }
    if (item.noticeId) {
      const notice = state.notices?.[item.noticeId]
      const reminder = noticeReminders.get(item.noticeId)
      const source = state.channels?.find(channel => channel.sourceId === notice?.sourceId)?.title || '通知'
      rows.push({ id: item.id, title: item.title || notice?.title || '通知事项', date: item.date, time: item.time || '', kind: 'notice',
        source, completed: reminder ? reminder.status === 'done' : completion[item.id] ?? completion[`notice:${item.noticeId}`] ?? item.completed === true, noticeId: item.noticeId,
        ...(reminder ? { reminderAt: reminder.dueAt, reminderId: reminder.id, reminderStatus: reminder.status } : {}) })
      continue
    }
    rows.push({ id: item.id, title: item.title, date: item.date, time: item.time || '', kind: 'personal',
      source: '我的待办', completed: item.completed === true })
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
    || Number(a.completed) - Number(b.completed) || a.title.localeCompare(b.title, 'zh-CN'))
}
