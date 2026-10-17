import test from 'node:test'
import assert from 'node:assert/strict'
import { orderHomeworkMessages, homeworkReminderMessage } from '../web/js/services/homework.js'
import { createStore, hydrate } from '../web/js/store.js'
import { buildChatHistory } from '../web/js/services/chat.js'

const card = (id, deadlineAt) => ({ id, kind: 'notice', role: 'bot', channelId: 'src-xzzd', text: '作业', at: 1,
  item: { sourceId: 'xzzd', noticeId: `xzzd:${id}`, kind: 'homework', real: true, title: `作业${id}`,
    homework: { activityId: id, courseId: '3', deadlineAt, courseName: '测试课程', submissionStatus: 'not_submitted', isClosed: false } } })

test('homework cards sort descending by deadline, unknown last, without moving user or reminder rows', () => {
  const early = card('1', '2030-03-18T10:00:00+08:00'), late = card('2', '2030-03-19T10:00:00+08:00')
  const unknown = card('3', null), reply = { id: 'user', kind: 'text', role: 'user', text: '你好' }
  const reminder = { ...card('4', '2030-03-17'), kind: 'reminder' }
  const original = [unknown, reply, early, late, reminder]
  assert.deepEqual(orderHomeworkMessages(original).map(row => row.id), ['2', 'user', '1', '3', '4'])
  assert.deepEqual(original.map(row => row.id), ['3', 'user', '1', '2', '4'])
  assert.deepEqual(orderHomeworkMessages([card('5', '2030-03-18T02:00:00Z'), early]).map(row => row.id), ['5', '1'])
})

test('deadline refresh reorders ordinary cards and keeps unknown relative order', () => {
  const unknown = [card('1', null), card('2', 'invalid')]
  assert.deepEqual(orderHomeworkMessages(unknown).map(row => row.id), ['1', '2'])
  assert.deepEqual(orderHomeworkMessages([card('1', '2030-03-18'), card('2', '2030-03-19')]).map(row => row.id), ['2', '1'])
})

test('reminder repost is a separate complete local card, persists and stays out of model history', () => {
  const store = createStore(null), base = card('12', '2030-03-18T16:00:00+08:00')
  store.addMessage('src-xzzd', base)
  const event = { id: 'six-hours', at: 2, kind: 'reminder', reminderId: 'rem-hw-test', text: '⏰ {nickname}，快到截止时间啦', item: base.item }
  const repost = homeworkReminderMessage(event)
  assert.match(repost.text, /测试课程/)
  assert.match(repost.text, /2030-03-18/)
  store.addMessage('src-xzzd', { ...repost, role: 'bot' })
  const restored = hydrate(store.state)
  assert.equal(restored.messages['src-xzzd'].length, 2)
  assert.equal(restored.messages['src-xzzd'][1].item.homework.activityId, '12')
  assert.match(restored.messages['src-xzzd'][1].text, /快到截止/)
  assert.deepEqual(buildChatHistory(restored.messages['src-xzzd'], restored.profile), [])
})

test('live reordering reuses avatar nodes and preserves conversation slots', async () => {
  const { reorderHomeworkNodes } = await import('../web/js/services/homework.js')
  const list = [card('1', null), { id: 'user', kind: 'text', role: 'user' }, card('2', '2030-03-18'), card('3', '2030-03-19')]
  const nodes = list.map(message => ({ dataset: { id: message.id }, avatar: {} }))
  const container = {
    children: [...nodes],
    querySelectorAll() { return this.children.filter(node => node.dataset) },
    insertBefore(node, reference) {
      const old = this.children.indexOf(node)
      if (old >= 0) this.children.splice(old, 1)
      this.children.splice(this.children.indexOf(reference), 0, node)
      node.remove = () => this.children.splice(this.children.indexOf(node), 1)
    },
  }
  reorderHomeworkNodes(container, id => list.find(row => row.id === id), { createComment: () => ({}) })
  assert.deepEqual(container.children.map(node => node.dataset.id), ['3', 'user', '2', '1'])
  assert.equal(container.children[0], nodes[3])
  assert.equal(container.children[1], nodes[1])
  assert.equal(container.children[3].avatar, nodes[0].avatar)
})

test('transcript renders sorted initial cards and a complete reminder card at its message position', async () => {
  globalThis.matchMedia = () => ({ matches: false })
  const { createTranscript } = await import('../web/js/ui/transcript.js')
  const store = createStore(null)
  const early = card('1', '2030-03-18'), late = card('2', '2030-03-19')
  store.addMessage('src-xzzd', early); store.addMessage('src-xzzd', late)
  const fields = homeworkReminderMessage({ id: 'event-card', kind: 'reminder', at: 2, text: '⏰ {nickname}，快截止啦', item: early.item, reminderId: 'r' })
  store.addMessage('src-xzzd', { ...fields, role: 'bot' })
  const root = { innerHTML: '', firstElementChild: { querySelectorAll: () => [] }, addEventListener() {}, scrollTo() {} }
  const jump = { addEventListener() {} }
  createTranscript({ root, jump, store }).render('src-xzzd')
  assert.ok(root.innerHTML.indexOf('data-id="2"') < root.innerHTML.indexOf('data-id="1"'))
  assert.ok(root.innerHTML.indexOf('data-id="1"') < root.innerHTML.indexOf('data-id="event-card"'))
  assert.match(root.innerHTML, /作业截止提醒/)
  assert.match(root.innerHTML, /测试课程/)
  assert.ok(!root.innerHTML.includes('{nickname}'))
})
