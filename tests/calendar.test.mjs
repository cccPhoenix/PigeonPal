import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate } from '../web/js/store.js'
import { buildCalendarItems } from '../web/js/services/calendar.js'
import { createCalendar, calendarDetailHTML } from '../web/js/ui/calendar.js'
import { createAIChat } from '../web/js/services/chat.js'

const now = Date.parse('2026-10-19T12:00:00+08:00')
const homework = (id, deadlineAt, status = 'not_submitted') => ({
  id: `xzzd:${id}`, noticeId: `xzzd:${id}`, sourceId: 'xzzd', kind: 'homework', real: true,
  title: `作业${id}`, revision: '1', publishedAt: now,
  homework: { courseId: 'math', courseName: '高等数学', courseCode: '(2026-2027-1)-M',
    openAt: '2026-10-01T08:00:00+08:00', deadlineAt, submissionStatus: status, isClosed: false },
})

test('all synced homework deadlines enter the calendar and completion survives reload', () => {
  const store = createStore(null)
  store.syncHomeworkSnapshot([homework('one', '2026-10-30'), homework('two', '2026-10-31T20:00:00+08:00', 'submitted')], { now })
  const entries = buildCalendarItems(store.state)
  assert.deepEqual(entries.map(item => [item.id, item.date, item.time, item.completed]), [
    ['homework:xzzd:one', '2026-10-30', '', false],
    ['homework:xzzd:two', '2026-10-31', '20:00', true],
  ])
  store.setCalendarCompleted('homework:xzzd:one', true)
  const restored = hydrate(JSON.stringify(store.state))
  assert.equal(buildCalendarItems(restored).find(item => item.id === 'homework:xzzd:one').completed, true)
})

test('calendar keeps every synced assignment even when the homework rail shows only a digest', () => {
  const store = createStore(null)
  const items = Array.from({ length: 10 }, (_, index) => homework(String(index + 1), `2026-10-${String(index + 20).padStart(2, '0')}`))
  store.syncHomeworkSnapshot(items, { now })
  assert.equal(store.state.messages['src-xzzd'].filter(message => message.kind === 'notice').length, 8)
  assert.equal(buildCalendarItems(store.state).length, 10)
})

test('timezone-aware deadlines use the Shanghai calendar day', () => {
  const store = createStore(null)
  store.syncHomeworkSnapshot([homework('midnight', '2026-10-20T23:30:00Z')], { now })
  assert.deepEqual(buildCalendarItems(store.state).map(item => [item.date, item.time]), [['2026-10-21', '07:30']])
})

test('only manual notice reminders enter the calendar, on the event or deadline date', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', { id: 'n1', noticeId: 'n1', sourceId: 'yunfeng', title: '讲座',
    publishedAt: now, eventAt: Date.parse('2026-10-25T15:00:00+08:00') })
  store.upsertNotice('src-itc', { id: 'n2', noticeId: 'n2', sourceId: 'itc', title: '系统通知',
    publishedAt: now, deadlineAt: '2026-10-27' })
  const row = (id, noticeId, automatic = false) => ({ id, noticeId, title: '提醒', dueAt: Date.parse('2026-10-24T09:00:00+08:00'),
    status: 'pending', automatic, channelId: 'src-yunfeng', updatedAt: 1 })
  store.syncReminders([row('rem-ddl-auto', 'n1', true), row('rem-manual', 'n1'), row('rem-second', 'n2')])
  const entries = buildCalendarItems(store.state)
  assert.deepEqual(entries.map(item => [item.id, item.date, item.time]), [
    ['notice:n1', '2026-10-25', '15:00'], ['notice:n2', '2026-10-27', ''],
  ])
  store.setCalendarCompleted('notice:n1', true)
  store.syncReminders([{ ...row('rem-ddl-auto', 'n1'), automatic: false, updatedAt: 3 }])
  assert.equal(buildCalendarItems(store.state).filter(item => item.id === 'notice:n1').length, 1)
  store.syncReminders([{ ...row('rem-manual', 'n1'), status: 'cancelled', updatedAt: 2 }])
  assert.deepEqual(buildCalendarItems(store.state).map(item => item.id), ['notice:n1', 'notice:n2'])
  store.syncReminders([{ ...row('rem-ddl-auto', 'n1'), status: 'cancelled', updatedAt: 4 }])
  assert.deepEqual(buildCalendarItems(store.state).map(item => item.id), ['notice:n2'])
})

test('clicking a calendar task opens details while only its checkbox changes completion', async () => {
  const store = createStore(null)
  const chat = createAIChat({ chat: async () => ({ events: [
    { type: 'action', name: 'calendar.upsert', args: { id: 'cal-chat-1', title: '交读书报告', date: '2026-10-20', time: '18:00', completed: false } },
    { type: 'message', text: '已经加到日历。' },
  ] }) })
  const events = []
  for await (const event of chat.respond({ text: '把交读书报告加到日历', channelId: 'bot', state: store.state, requestId: 'calendar123', history: [] })) events.push(event)
  const action = events.find(event => event.name === 'calendar.upsert')
  store.upsertCalendarItem(action.args)
  const listeners = {}
  const root = { innerHTML: '', addEventListener(type, fn) { listeners[type] = fn }, querySelectorAll() { return [] } }
  let opened = null
  const calendar = createCalendar({ root, store, onOpen: item => { opened = item } })
  store.on('calendar', () => calendar.render())
  calendar.setMonth('2026-10')
  assert.match(root.innerHTML, /<table class="calendar-table"/)
  assert.match(root.innerHTML, /data-date="2026-10-20"/)
  assert.match(root.innerHTML, /交读书报告/)
  assert.match(root.innerHTML, /<button type="button" class="calendar-task-open" data-calendar-open="cal-chat-1"/)
  listeners.click({ target: { closest: selector => selector === '[data-calendar-open], [data-calendar-item]'
    ? { dataset: { calendarOpen: 'cal-chat-1' } } : null } })
  assert.equal(opened?.title, '交读书报告')
  assert.equal(store.state.calendarItems['cal-chat-1'].completed, false)
  assert.match(calendarDetailHTML(opened, store.state), /<h4 class="calendar-detail-title">交读书报告<\/h4>/)
  assert.match(calendarDetailHTML(opened, store.state), /2026-10-20 18:00/)
  assert.match(calendarDetailHTML(opened, store.state), /<div class="calendar-detail-head"><h3>事项详情<\/h3><button class="icon-btn flat" type="button" data-x="close" aria-label="关闭事项详情">/)
  assert.doesNotMatch(calendarDetailHTML(opened, store.state), /<div class="btns">/)
  opened = null
  listeners.click({ target: { closest: selector => selector === '[data-calendar-open], [data-calendar-item]'
    ? { dataset: { calendarItem: 'cal-chat-1' } } : null } })
  assert.equal(opened?.id, 'cal-chat-1')
  opened = null
  listeners.click({ target: { closest: selector => selector === '[data-calendar-check]'
    ? { dataset: { calendarCheck: 'cal-chat-1' } } : null } })
  assert.equal(opened, null)
  listeners.change({ target: { closest: selector => selector === '[data-calendar-check]'
    ? { dataset: { calendarCheck: 'cal-chat-1' }, checked: true } : null } })
  assert.equal(store.state.calendarItems['cal-chat-1'].completed, true)
  assert.match(root.innerHTML, /class="calendar-task completed"/)
  assert.equal(hydrate(JSON.stringify(store.state)).calendarItems['cal-chat-1'].completed, true)
  calendar.setMonth('2026-11')
  assert.match(root.innerHTML, /class="calendar-table" data-page="next"/)
  calendar.setMonth('2026-09')
  assert.match(root.innerHTML, /class="calendar-table" data-page="previous"/)
  calendar.render()
  assert.doesNotMatch(root.innerHTML, /data-page=/)
})

test('calendar details show stored homework and notice context', () => {
  const store = createStore(null)
  store.syncHomeworkSnapshot([homework('detail', '2026-10-30')], { now })
  store.upsertNotice('src-yunfeng', { id: 'notice-detail', noticeId: 'notice-detail', sourceId: 'yunfeng',
    title: '讲座', summary: '主讲科研方向', where: '报告厅', publishedAt: now,
    eventAt: Date.parse('2026-10-25T15:00:00+08:00') })
  store.syncReminders([{ id: 'rem-detail', noticeId: 'notice-detail', title: '讲座提醒',
    dueAt: Date.parse('2026-10-25T14:30:00+08:00'), status: 'pending', automatic: false, channelId: 'src-yunfeng' }])
  const entries = buildCalendarItems(store.state)
  const homeworkHTML = calendarDetailHTML(entries.find(item => item.kind === 'homework'), store.state)
  const noticeHTML = calendarDetailHTML(entries.find(item => item.kind === 'notice'), store.state)
  assert.match(homeworkHTML, /高等数学/)
  assert.match(homeworkHTML, /未提交/)
  assert.match(noticeHTML, /主讲科研方向/)
  assert.match(noticeHTML, /报告厅/)
  assert.match(noticeHTML, /2026-10-25 14:30/)
})
