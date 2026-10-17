import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChatHistory, createAIChat } from '../web/js/services/chat.js'

const reminders = [
  { id: 'private-channel', channelId: 'src-xzzd', noticeId: null },
  { id: 'private-notice', channelId: 'bot', noticeId: 'xzzd:123' },
  { id: 'normal', channelId: 'bot', noticeId: 'yunfeng:123' },
]
const message = (id, fields) => ({ id, role: 'bot', kind: 'text', channelId: 'bot', text: id, ...fields })
const messages = [
  message('assignment', { kind: 'notice', item: { sourceId: 'xzzd', homework: {} } }),
  message('delivered-homework', { kind: 'reminder', channelId: 'src-xzzd' }),
  message('moved-homework', { kind: 'reminder', reminderId: 'private-notice' }),
  message('channel-homework', { kind: 'reminder', reminderId: 'private-channel' }),
  message('ordinary-reminder', { kind: 'reminder', reminderId: 'normal' }),
  message('typed-by-user', { role: 'user', channelId: 'src-xzzd', text: '我手动输入的作业问题' }),
]

test('automatic homework and delivered reminders stay out of model history, user text remains', () => {
  const history = buildChatHistory(messages, {}, reminders)
  assert.deepEqual(history, [
    { role: 'assistant', content: 'ordinary-reminder' },
    { role: 'user', content: '我手动输入的作业问题' },
  ])
  assert.deepEqual(buildChatHistory([messages[1]], {}), [])
})

test('quoting homework reminder events sends neither quotedText nor noticeId', async () => {
  const calls = []
  const client = { async chat(body) { calls.push(body); return { events: [{ type: 'message', text: '已收到' }] } } }
  const chat = createAIChat(client)
  const state = { messages: { bot: messages }, reminders, profile: { botName: '小浙', nickname: '同学' } }
  for (const quoteId of ['assignment', 'delivered-homework', 'moved-homework', 'channel-homework']) {
    for await (const event of chat.respond({ text: '看看这条', channelId: 'bot', state, requestId: `request-${quoteId}`, quoteId, history: [] })) {}
    const body = calls.at(-1)
    assert.equal(body.quotedText, undefined)
    assert.equal(body.noticeId, undefined)
  }
  for await (const event of chat.respond({ text: '看看这条', channelId: 'bot', state, requestId: 'request-normal', quoteId: 'ordinary-reminder', history: [] })) {}
  assert.equal(calls.at(-1).quotedText, 'ordinary-reminder')
  for await (const event of chat.respond({ text: '我自己写的问题', channelId: 'src-xzzd', state, requestId: 'request-user', quoteId: 'typed-by-user', history: [] })) {}
  assert.equal(calls.at(-1).quotedText, '我手动输入的作业问题')
  assert.equal(calls.at(-1).text, '我自己写的问题')
})
