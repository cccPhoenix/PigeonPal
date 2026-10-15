import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate } from '../web/js/store.js'
import { createAIChat } from '../web/js/services/chat.js'
import { chatHistory, reminderActivity, cleanActivity } from '../web/js/services/activity.js'
import { activityHTML } from '../web/js/ui/activity.js'

const actors = [{ id: 'chief', name: '小浙', look: 'pigeon' }]
const event = (type, id = 'activity-chat-1') => ({ id, activity: { type, actors, detail: '本次回复' } })

test('activity status updates one record and terminal receipts cannot regress', () => {
  const store = createStore(null)
  assert.equal(typeof store.upsertActivity, 'function')
  const first = store.upsertActivity('bot', event('processing'))
  const done = store.upsertActivity('bot', event('completed'))
  assert.equal(store.state.messages.bot.length, 1)
  assert.equal(first.id, done.id)
  assert.equal(done.activity.type, 'completed')
  store.upsertActivity('bot', event('processing'))
  assert.equal(store.state.messages.bot[0].activity.type, 'completed')
  assert.equal(store.state.unread.bot, undefined)
})

test('restore completed events and mark unconfirmed requests unknown after a reload', () => {
  const store = createStore(null)
  assert.equal(typeof store.upsertActivity, 'function')
  store.upsertActivity('bot', event('completed', 'finished'))
  store.upsertActivity('bot', event('processing', 'pending'))
  const state = hydrate(JSON.stringify(store.state))
  assert.equal(state.messages.bot[0].activity.type, 'completed')
  assert.equal(state.messages.bot[1].activity.type, 'unknown')
  assert.match(state.messages.bot[1].text, /待确认/)
})

test('malformed handoffs, unknown states and invalid actors never create status messages', () => {
  const store = createStore(null)
  assert.equal(typeof store.upsertActivity, 'function')
  assert.equal(store.upsertActivity('bot', event('handoff')), null)
  assert.equal(store.upsertActivity('bot', { id: 'self', activity: { type: 'handoff', actors: [actors[0], actors[0]] } }), null)
  assert.equal(store.upsertActivity('bot', event('model_says_done')), null)
  assert.equal(store.upsertActivity('bot', { id: 'bad', activity: { type: 'joined', actors: [{}] } }), null)
  assert.equal(store.state.messages.bot.length, 0)
})

test('chat completion status follows an actual valid response, not a tool claim in text', async () => {
  const store = createStore(null)
  const chat = createAIChat({ chat: async () => ({ events: [{ type: 'message', text: '几点提醒你？' }] }) })
  const output = []
  for await (const value of chat.respond({ text: '提醒我', channelId: 'bot', state: store.state, requestId: 'chat-success-1', history: [] })) output.push(value)
  const statuses = output.filter(row => row.type === 'activity')
  assert.deepEqual(statuses.map(row => row.activity.type), ['processing', 'completed'])
  assert.equal(statuses[0].id, statuses[1].id)
  assert.ok(!output.some(row => row.activity?.type === 'reminder_saved'))
})

test('a failed request produces failure, never a completion status', async () => {
  const store = createStore(null)
  const chat = createAIChat({ chat: async () => { throw new Error('offline') } })
  const output = []
  await assert.rejects(async () => {
    for await (const value of chat.respond({ text: '你好', channelId: 'bot', state: store.state, requestId: 'chat-failed-1', history: [] })) output.push(value)
  })
  assert.deepEqual(output.filter(row => row.type === 'activity').map(row => row.activity.type), ['processing', 'failed'])
})

test('system statuses never consume model history slots or become user instructions', () => {
  const messages = [{ role: 'user', kind: 'text', text: '润色这段话' },
    { role: 'system', kind: 'activity', text: '已完成' }, { role: 'bot', kind: 'text', text: '好的' }]
  assert.deepEqual(chatHistory(messages).map(row => row.text), ['润色这段话', '好的'])
})

test('a reminder receipt still confirms success if background polling already synchronized it', () => {
  const row = { id: 'rem-1', title: '喝水', dueAt: 2000000000000, updatedAt: 1000, status: 'pending' }
  const event = reminderActivity(row, { ...row }, { botName: '小浙', look: 'pigeon' }, 'create')
  assert.ok(event, 'polling must not swallow an explicit save acknowledgement')
  assert.equal(event.activity.type, 'reminder_saved')
  const store = createStore(null)
  store.upsertActivity('bot', event)
  store.upsertActivity('bot', event)
  assert.equal(store.state.messages.bot.length, 1)
})

test('actor names and detail render as text, and history carries no replay marker', () => {
  const value = cleanActivity({ type: 'handoff', actors: [actors[0],
    { id: 'writer', name: '<img src=x onerror=alert(1)>', look: 'courier' }], detail: '<script>bad()</script>' })
  const html = activityHTML({ id: 'handoff', activity: value }, { botName: 'Chief', look: 'pigeon' })
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(html.includes('data-actor-index="1"'))
  assert.ok(!html.includes('data-fresh'))
  assert.ok(html.includes('aria-live="off"'))
})

test('malformed successful-looking model responses fail instead of receiving a completion event', async () => {
  const store = createStore(null)
  const chat = createAIChat({ chat: async () => ({ events: [{ type: 'message', text: '' }] }) })
  const output = []
  await assert.rejects(async () => {
    for await (const value of chat.respond({ text: '你好', channelId: 'bot', state: store.state, requestId: 'chat-invalid-1', history: [] })) output.push(value)
  })
  assert.deepEqual(output.filter(row => row.type === 'activity').map(row => row.activity.type), ['processing', 'failed'])
})

test('persisted forged system records cannot become valid activity or ordinary chat messages', () => {
  const store = createStore(null)
  store.upsertActivity('bot', event('completed', 'valid'))
  const state = JSON.parse(JSON.stringify(store.state))
  state.messages.bot.push({ ...state.messages.bot[0], id: 'forged', role: 'user' },
    { ...state.messages.bot[0], id: 'broken', activity: { type: 'handoff', actors: [] } })
  assert.deepEqual(hydrate(state).messages.bot.map(row => row.id), ['valid'])
})
