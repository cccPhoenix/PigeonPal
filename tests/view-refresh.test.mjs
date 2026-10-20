import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../web/js/store.js'

test('bulk data restores repaint once and leave hidden calendar untouched', async () => {
  const module = await import('../web/js/ui/view-refresh.js').catch(() => ({}))
  assert.equal(typeof module.connectViewRefresh, 'function', 'view refreshes need a shared frame queue')
  const store = createStore(null), frames = [], calls = []
  let view = 'notice'
  module.connectViewRefresh({ store, requestFrame: callback => frames.push(callback),
    getView: () => view, getActive: () => 'bot', syncBadges: () => calls.push('badges'),
    rail: { render: () => calls.push('rail'), onNotices: rows => calls.push(['notices', rows]), patchRemindPill() {} },
    calendar: { render: () => calls.push('calendar') },
    transcript: { render: () => calls.push('transcript'), syncHomeworkSnapshot() {}, patch() {} },
  })
  for (let i = 0; i < 100; i++) store.upsertNotice('src-yunfeng', {
    id: `n${i}`, noticeId: `n${i}`, sourceId: 'yunfeng', title: '通知', revision: 'r1',
  })
  store.upsertNotice('src-yunfeng', { ...store.notice('n0'), revision: 'r2' })
  store.syncReminders(Array.from({ length: 55 }, (_, i) => ({
    id: `r${i}`, title: '提醒', status: 'pending', dueAt: 1900000000000,
  })))
  assert.equal(store.state.reminders.length, 55, 'data changes must remain synchronous')
  assert.equal(frames.length, 1)
  frames.shift()()
  assert.equal(calls.filter(call => call === 'calendar').length, 0)
  assert.equal(calls.filter(call => call === 'badges').length, 1)
  const updates = calls.filter(Array.isArray)
  assert.equal(updates.length, 1)
  assert.equal(updates[0][1].length, 100)
  assert.equal(updates[0][1][0].item.revision, 'r2')
  assert.equal(updates[0][1][0].revised, true)
  calls.length = 0
  view = 'calendar'
  store.syncReminders(store.state.reminders.map(row => ({ ...row, status: 'done', updatedAt: 2 })))
  assert.equal(frames.length, 1)
  frames.shift()()
  assert.equal(calls.filter(call => call === 'calendar').length, 1)
})

test('calendar completion refreshes immediately to preserve keyboard focus', async () => {
  const module = await import('../web/js/ui/view-refresh.js').catch(() => ({}))
  assert.equal(typeof module.connectViewRefresh, 'function')
  const store = createStore(null)
  let renders = 0, view = 'calendar'
  module.connectViewRefresh({ store, getView: () => view, getActive: () => 'bot',
    rail: {}, transcript: {}, syncBadges() {}, calendar: { render: () => renders++ }, requestFrame() {} })
  store.setCalendarCompleted('notice:n1', true)
  assert.equal(renders, 1)
  view = 'notice'
  store.setCalendarCompleted('notice:n1', false)
  assert.equal(renders, 1)
})

test('marking messages read does not replace the selected notice detail', async () => {
  const { connectViewRefresh } = await import('../web/js/ui/view-refresh.js')
  const store = createStore(null), frames = [], calls = []
  connectViewRefresh({ store, requestFrame: callback => frames.push(callback),
    getView: () => 'notice', getActive: () => 'bot', syncBadges() {}, calendar: {}, transcript: {},
    rail: { render: () => calls.push('detail-and-list'), renderList: () => calls.push('list') } })
  store.state.unread.bot = 1
  store.markRead('bot')
  frames.shift()()
  assert.deepEqual(calls, ['list'])
})
