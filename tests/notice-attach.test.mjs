import test from 'node:test'
import assert from 'node:assert/strict'
import { localAdapters, isAttachable, parseDropPayload, NOTICE_DRAG_TYPE } from '../web/js/services/sources.js'
import { createStore } from '../web/js/store.js'

const base = {
  id: 'x1', sourceId: 'yunfeng', title: '讲座通知', url: 'https://a.edu.cn/x.htm',
  publishedAt: '2026-10-16', state: 'complete', revision: 'r1', version: 1,
  firstSeenAt: '2026-10-15T00:00:00Z', analysis: { state: 'ready', result: { summary: '要点' } },
}
const fetchOne = async row => (await localAdapters({ notices: async () => ({ items: [row] }) })[0].fetch())[0]

test('the adapter keeps crawl state so completeness is known without a second request', async () => {
  const item = await fetchOne(base)
  assert.equal(item.state, 'complete')
  assert.equal(isAttachable(item), true)
})

test('metadata-only and unfetched notices cannot be attached', async () => {
  assert.equal(isAttachable(await fetchOne({ ...base, state: 'pending' })), false)
  const external = await fetchOne({ ...base, state: 'skipped', fetchable: false })
  assert.equal(external.fetchable, false)
  assert.equal(isAttachable(external), false)
  assert.equal(isAttachable({ real: false, state: 'complete' }), false)
})

test('a notice survives the store round-trip with its crawl state', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', { ...base, noticeId: 'x1', real: true, analysisState: 'ready' })
  assert.equal(store.notice('x1').state, 'complete')
  assert.equal(isAttachable(store.notice('x1')), true)
})

test('drop payloads are parsed narrowly and junk is refused', () => {
  assert.deepEqual(parseDropPayload(JSON.stringify({ noticeId: 'x1', title: '讲座' })), { noticeId: 'x1', title: '讲座' })
  assert.equal(parseDropPayload('not json'), null)
  assert.equal(parseDropPayload(JSON.stringify({ title: '没有 id' })), null)
  assert.equal(parseDropPayload(''), null)
  assert.equal(NOTICE_DRAG_TYPE, 'application/x-pp-notice')
})

test('an attached notice wins over the quoted message when sending', async () => {
  const bodies = []
  const { createAIChat } = await import('../web/js/services/chat.js')
  const chat = createAIChat({ chat: async body => { bodies.push(body); return { events: [{ type: 'message', text: '好' }] } } })
  const state = { messages: { bot: [{ id: 'm1', noticeId: 'fromQuote' }] }, profile: { botName: '小浙', nickname: '' } }
  for await (const event of chat.respond({ text: '这个呢', channelId: 'bot', state, requestId: 'r1', quoteId: 'm1', noticeId: 'fromChip', history: [] })) void event
  assert.equal(bodies[0].noticeId, 'fromChip')
  for await (const event of chat.respond({ text: '这个呢', channelId: 'bot', state, requestId: 'r2', quoteId: 'm1', history: [] })) void event
  assert.equal(bodies[1].noticeId, 'fromQuote')
  for await (const event of chat.respond({ text: '随便问', channelId: 'bot', state, requestId: 'r3', history: [] })) void event
  assert.equal(bodies[2].noticeId, undefined)
})

test('unchanged reminder polls do not re-emit, changed ones do', () => {
  const store = createStore(null)
  const row = { id: 'rem1', title: '讲座', dueAt: 1900000000000, status: 'pending', channelId: 'src-yunfeng', noticeId: 'x1', deliveredAt: null, createdAt: 1, updatedAt: 1 }
  let events = 0
  store.on('reminders', () => { events += 1 })
  store.syncReminders([row])
  store.syncReminders([row])
  store.syncReminders([{ ...row, status: 'done', updatedAt: 2 }])
  assert.equal(events, 2)
  assert.equal(store.state.reminders[0].status, 'done')
})
