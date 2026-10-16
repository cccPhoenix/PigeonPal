import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, createInitialState, hydrate } from '../web/js/store.js'
globalThis.document = { addEventListener() {} }
const { createSidebar } = await import('../web/js/ui/sidebar.js')

test('the application exposes one companion and source channels without team controls', () => {
  const store = createStore(null)
  const root = { innerHTML: '', addEventListener() {} }
  createSidebar({ root, store }).render()
  assert.ok(!root.innerHTML.includes('data-side="add-bot"'))
  assert.ok(!root.innerHTML.includes('data-side="add-group"'))
  assert.ok(!root.innerHTML.includes('Chief'))
  assert.ok(root.innerHTML.includes('校园伙伴'))
  assert.ok(root.innerHTML.includes('求是学院'))
  assert.ok(root.innerHTML.includes('本科生院'))
  assert.equal(createInitialState().bots, undefined)
})

test('cached multi-bot state keeps personal settings and normal messages without reviving team channels', () => {
  const initial = createInitialState()
  const state = hydrate({ ...initial,
    profile: { ...initial.profile, botName: 'Alex', nickname: '同学', look: 'character4' },
    bots: [{ id: 'chief', name: 'Alex', role: 'general' }, { id: 'bot-defaultreminder', name: '提醒鸽', role: 'reminder' }],
    botAppearances: { 'bot-defaultreminder': { look: 'character2' } },
    channels: [...initial.channels,
      { id: 'src-dm-bot-defaultreminder', kind: 'dm', title: '提醒鸽', botId: 'bot-defaultreminder' },
      { id: 'src-group-old', kind: 'group', title: '旧群' },
      { id: 'src-custom', kind: 'source', title: '自选来源', site: 'example.edu' }],
    messages: { ...initial.messages, bot: [
      { id: 'plain', channelId: 'bot', kind: 'text', role: 'bot', botId: 'chief', text: '**正常消息**', at: 1 },
      { id: 'activity', channelId: 'bot', kind: 'activity', role: 'system', text: '唤醒子bot', at: 2,
        activity: { type: 'handoff', actors: [{ id: 'chief', name: 'Alex' }, { id: 'bot-defaultreminder', name: '提醒鸽' }] } }],
      'src-dm-bot-defaultreminder': [{ id: 'private-old', kind: 'text', role: 'bot', text: '私聊', at: 1 }] },
  })
  assert.equal(state.profile.botName, 'Alex')
  assert.equal(state.profile.look, 'character4')
  assert.equal(state.bots, undefined)
  assert.ok(!state.channels.some(row => row.id.startsWith('src-dm-') || row.id.startsWith('src-group-')))
  assert.ok(state.channels.some(row => row.id === 'src-custom'))
  assert.deepEqual(state.messages.bot.map(row => row.id), ['plain'])
  assert.equal(state.messages.bot[0].text, '**正常消息**')
})

test('server reminders from removed channels sync back to the companion', () => {
  const store = createStore(null)
  const old = { id: 'old-reminder', title: '旧提醒', channelId: 'src-dm-bot-defaultreminder', dueAt: 1900000000000 }
  store.syncReminders([old])
  assert.equal(store.state.reminders[0].channelId, 'bot')
  assert.equal(old.channelId, 'src-dm-bot-defaultreminder')
  store.syncReminders([{ ...old, channelId: 'src-group-old', status: 'done', updatedAt: 1 }])
  assert.equal(store.state.reminders[0].channelId, 'bot')
  assert.equal(store.state.reminders[0].status, 'done')
  store.syncReminders([{ ...old, id: 'source-reminder', channelId: 'src-itc' }])
  assert.equal(store.state.reminders[1].channelId, 'src-itc')
})
