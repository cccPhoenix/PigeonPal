import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { NotificationMonitor, defaults } = require('../desktop/notifications.cjs')

function fixture() {
  let saved = defaults()
  const data = { items: [], reminders: [] }, sent = []
  const monitor = new NotificationMonitor({ load: () => saved, save: value => { saved = structuredClone(value) },
    now: () => Date.parse('2026-10-20T12:00:00+08:00'),
    api: async path => path === '/api/reminders' ? { reminders: data.reminders } : path === '/api/sources'
      ? { sources: [{ id: 'yunfeng', state: 'ready' }] } : { items: data.items, nextOffset: null },
    notify: async message => { sent.push(message); return true } })
  return { monitor, data, sent, state: () => saved }
}

test('desktop waits for matching, then delivers once; evidenced exclusions are consumed silently', async () => {
  const f = fixture()
  await f.monitor.poll()
  f.data.items = [{ id: 'yunfeng:1', title: 'Synthetic notice', notifyEligible: true, deferPush: true }]
  await f.monitor.poll()
  assert.equal(f.sent.length, 0)
  assert.equal(f.state().sources.yunfeng['yunfeng:1'], undefined)
  f.data.items[0].deferPush = false
  await f.monitor.poll(); await f.monitor.poll()
  assert.equal(f.sent.length, 1)
  f.data.items.push({ id: 'yunfeng:2', title: 'Excluded', notifyEligible: false, deferPush: false })
  await f.monitor.poll()
  assert.equal(f.sent.length, 1)
  assert.equal(f.state().sources.yunfeng['yunfeng:2'], true)
})

test('desktop checks the latest recommendation immediately before a source toast', async () => {
  const f = fixture()
  await f.monitor.poll()
  f.data.items = [{ id: 'yunfeng:1', title: 'Allowed initially', notifyEligible: true }]
  const original = f.monitor.api
  let reads = 0
  f.monitor.api = async path => {
    if (path.startsWith('/api/notification-candidates') && ++reads === 2) f.data.items[0].notifyEligible = false
    return original(path)
  }
  await f.monitor.poll()
  assert.equal(f.sent.length, 0)
})

test('automatic reminder suppression does not block a manually eligible reminder', async () => {
  const f = fixture(), stamp = Date.parse('2026-10-20T12:00:00+08:00')
  f.data.reminders = [
    { id: 'auto', title: 'Filtered', status: 'pending', channelId: 'src-yunfeng', deliveredAt: stamp, notifyEligible: false },
    { id: 'manual', title: 'Keep manual', status: 'pending', channelId: 'bot', deliveredAt: stamp, notifyEligible: true },
  ]
  await f.monitor.poll()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].channelId, 'bot')
})

test('a notice deferred at dispatch remains retryable when matching finishes', async () => {
  const f = fixture(); await f.monitor.poll()
  f.data.items = [{ id: 'yunfeng:race', title: 'Deferred during dispatch', notifyEligible: true, deferPush: false }]
  const original = f.monitor.api; let reads = 0
  f.monitor.api = async path => {
    const result = await original(path)
    if (path.startsWith('/api/notification-candidates')) {
      reads += 1
      return { ...result, items: result.items.map(item => ({ ...item, deferPush: reads === 2 })) }
    }
    return result
  }
  await f.monitor.poll()
  assert.equal(f.sent.length, 0)
  assert.equal(f.state().sources.yunfeng['yunfeng:race'], undefined)
  await f.monitor.poll(); await f.monitor.poll()
  assert.equal(f.sent.length, 1)
})

test('a reminder temporarily deferred at dispatch is not consumed as notified', async () => {
  const f = fixture(); const stamp = Date.parse('2026-10-20T12:00:00+08:00')
  f.data.reminders = [{ id: 'race', title: 'Deferred reminder', status: 'pending', channelId: 'bot', deliveredAt: stamp, notifyEligible: true }]
  const original = f.monitor.api; let reads = 0
  f.monitor.api = async path => {
    const result = await original(path)
    if (path === '/api/reminders') {
      reads += 1
      return { reminders: result.reminders.map(row => ({ ...row, notifyEligible: reads !== 2 })) }
    }
    return result
  }
  await f.monitor.poll()
  assert.equal(f.sent.length, 0)
  assert.equal(f.state().reminders.race, undefined)
  await f.monitor.poll(); await f.monitor.poll()
  assert.equal(f.sent.length, 1)
})
