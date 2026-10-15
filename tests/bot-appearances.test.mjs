import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate } from '../web/js/store.js'
import { activityHTML } from '../web/js/ui/activity.js'

test('each bot keeps an independent appearance and survives a reload', () => {
  const store = createStore(null)
  assert.equal(typeof store.setBotAppearance, 'function')
  store.setBotAppearance('writer', { look: 'character4', name: '小笔' })
  store.setBotAppearance('reminder', { look: 'character9' })
  assert.equal(store.botAppearance({ id: 'writer' }).look, 'character4')
  assert.equal(store.botAppearance({ id: 'reminder' }).look, 'character9')
  assert.equal(store.state.profile.look, 'placeholder')
  const restored = hydrate(JSON.stringify(store.state))
  assert.equal(restored.botAppearances.writer.look, 'character4')
  assert.equal(restored.botAppearances.reminder.look, 'character9')
})

test('chief appearance reuses the existing profile without resetting nickname or preferences', () => {
  const store = createStore(null)
  assert.equal(typeof store.setBotAppearance, 'function')
  store.setProfile({ botName: '小浙', nickname: '阿俊', motion: 'calm' })
  store.setBotAppearance('chief', { look: 'character2', name: 'Chief' })
  assert.equal(store.state.profile.look, 'character2')
  assert.equal(store.state.profile.botName, 'Chief')
  assert.equal(store.state.profile.nickname, '阿俊')
  assert.equal(store.state.profile.motion, 'calm')
})

test('changing the appearance updates old activity renderings without replaying the event', () => {
  const store = createStore(null)
  assert.equal(typeof store.setBotAppearance, 'function')
  const message = { id: 'joined-writer', activity: { type: 'joined', actors: [{ id: 'writer', name: '写作鸽', look: 'courier' }], detail: '' } }
  store.setBotAppearance('writer', { name: '小笔', look: 'character4' })
  const html = activityHTML(message, store.state.profile, { resolveActor: actor => store.botAppearance(actor) })
  assert.ok(html.includes('小笔'))
  assert.ok(!html.includes('写作鸽'))
  assert.ok(!html.includes('data-fresh'))
})

test('uploaded avatars belong to their bot and invalid image URLs are rejected', () => {
  const store = createStore(null)
  assert.equal(typeof store.setBotAppearance, 'function')
  const image = 'data:image/png;base64,YQ=='
  assert.equal(store.setBotAppearance('writer', { look: 'image', image }), true)
  assert.equal(store.botAppearance({ id: 'writer' }).image, image)
  assert.equal(store.botAppearance({ id: 'reminder' }).image, null)
  assert.equal(store.setBotAppearance('writer', { look: 'image', image: 'javascript:alert(1)' }), false)
  assert.equal(store.botAppearance({ id: 'writer' }).image, image)
  store.setBotAppearance('writer', { look: 'courier' })
  store.setBotAppearance('writer', { look: 'image' })
  assert.equal(store.botAppearance({ id: 'writer' }).image, image)
})

test('untrusted saved appearance maps cannot overwrite chief or inject prototype properties', () => {
  const store = createStore(null)
  const raw = JSON.parse(JSON.stringify(store.state))
  raw.botAppearances = JSON.parse('{"chief":{"name":"wrong","look":"pigeon"},"__proto__":{"name":"bad","look":"pigeon"},"writer":{"name":"小笔","look":"missing","image":"https://bad.example/x.png"}}')
  const state = hydrate(raw)
  assert.ok(state.botAppearances)
  assert.equal(state.profile.botName, '小浙')
  assert.equal(Object.hasOwn(state.botAppearances, '__proto__'), false)
  assert.equal(Object.hasOwn(state.botAppearances, 'chief'), false)
  assert.equal(state.botAppearances.writer?.look, 'placeholder')
})

test('server team metadata preserves member IDs, custom appearance and message attribution on reload', () => {
  const store = createStore(null)
  store.setBotAppearance('bot-write', { look: 'character8' })
  assert.equal(store.syncBots({ bots: [{ id: 'chief', name: 'Chief' }, { id: 'bot-write', name: '写作鸽', role: 'writer' }],
    channels: [{ id: 'bot', kind: 'bot', memberIds: ['chief', 'bot-write'] },
      { id: 'src-dm-bot-write', kind: 'dm', title: '写作鸽', botId: 'bot-write', memberIds: ['bot-write'] }] }), true)
  store.addMessage('src-dm-bot-write', { role: 'bot', botId: 'bot-write', text: '润色完成' })
  store.setTeamCursor(42)
  const state = hydrate(JSON.stringify(store.state))
  assert.deepEqual(state.channels.find(c => c.id === 'bot').memberIds, ['chief', 'bot-write'])
  assert.equal(state.channels.find(c => c.id === 'src-dm-bot-write').kind, 'dm')
  assert.equal(state.messages['src-dm-bot-write'][0].botId, 'bot-write')
  assert.equal(state.botAppearances['bot-write'].look, 'character8')
  assert.equal(state.teamCursor, 42)
  assert.equal(state.teamReady, false)
})

test('server managed chat forwards stable message/activity IDs without duplicate client statuses', async () => {
  const { createAIChat } = await import('../web/js/services/chat.js')
  const store = createStore(null)
  store.syncBots({ bots: [{ id: 'chief', name: 'Chief' }], channels: [] })
  const expected = [{ type: 'activity', id: 'task-status', activity: { type: 'completed', actors: [{ id: 'chief', name: 'Chief' }] } },
    { type: 'message', id: 'task-message', botId: 'chief', text: '完成了' }]
  const output = []
  for await (const row of createAIChat({ chat: async () => ({ events: expected }) }).respond({
    text: '你好', channelId: 'bot', requestId: 'request-multibot', state: store.state, history: [],
  })) output.push(row)
  assert.deepEqual(output.filter(row => row.type === 'activity'), expected.slice(0, 1))
  assert.deepEqual(output.find(row => row.type === 'message'), expected[1])
})

test('reminders retain their actual author through reload and legacy records default to chief', () => {
  const store = createStore(null)
  store.syncReminders([{ id: 'rem-one', title: '喝水', dueAt: Date.now() + 60000, channelId: 'bot',
    botId: 'bot-defaultreminder', status: 'pending', deliveredAt: null },
  { id: 'rem-old', title: '旧提醒', dueAt: Date.now() + 60000, channelId: 'bot', status: 'pending', deliveredAt: null }])
  const state = hydrate(JSON.stringify(store.state))
  assert.equal(state.reminders.find(row => row.id === 'rem-one').botId, 'bot-defaultreminder')
  assert.equal(state.reminders.find(row => row.id === 'rem-old').botId, 'chief')
})

test('a source creation response merges an earlier team poll without dropping messages or duplicating channels', () => {
  const store = createStore(null)
  const channel = { id: 'src-newsource', kind: 'source', title: '新来源', memberIds: ['chief'] }
  store.syncBots({ bots: store.state.bots, channels: [channel] })
  const message = store.addMessage(channel.id, { role: 'bot', text: '已同步的消息' })
  store.addChannel({ ...channel, site: 'https://example.edu', emoji: '🏫' })
  assert.equal(store.state.channels.filter(row => row.id === channel.id).length, 1)
  assert.equal(store.state.messages[channel.id][0].id, message.id)
  assert.equal(store.channel(channel.id).site, 'https://example.edu')
  assert.equal(store.channel(channel.id).emoji, '🏫')
})

test('reset immediately persists a team replay boundary while clearing local conversation and appearance', () => {
  let saved
  const storage = { getItem: () => saved, setItem: (key, value) => { saved = value }, removeItem: () => { saved = undefined } }
  const store = createStore(storage)
  store.setTeamCursor(42)
  store.addMessage('bot', { role: 'bot', text: '旧回复' })
  store.setBotAppearance('chief', { look: 'courier' })
  const before = Date.now()
  store.reset()
  const restored = hydrate(saved)
  assert.equal(restored.teamCursor, 42)
  assert.ok(restored.teamResetAt >= before)
  assert.equal(restored.messages.bot.length, 0)
  assert.equal(restored.profile.look, 'placeholder')
})
