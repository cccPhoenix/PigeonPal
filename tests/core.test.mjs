import test from 'node:test'
import assert from 'node:assert/strict'
import { addReminder, updateReminder, dueReminders, markDelivered } from '../web/js/reminders.js'
import { parseWhen, reminderTitle, cnNumber } from '../web/js/services/parse-time.js'
import { createInitialState, hydrate, createStore } from '../web/js/store.js'
import { createDemoChat } from '../web/js/services/chat.js'

// 2026-10-13 15:00 local
const now = new Date(2026, 9, 13, 15, 0).getTime()
const hm = at => { const d = new Date(at); return [d.getDate(), d.getHours(), d.getMinutes()] }

test('reminders reject empty titles and past times', () => {
  const s = createInitialState()
  assert.throws(() => addReminder(s, { title: ' ', dueAt: now + 1 }, now))
  assert.throws(() => addReminder(s, { title: '作业', dueAt: now - 1 }, now))
  assert.throws(() => addReminder(s, { title: '作业', dueAt: 'nope' }, now))
})

test('a reminder fires once, snoozing re-arms it, done stops it', () => {
  const s = createInitialState()
  const r = addReminder(s, { title: '作业', dueAt: now + 60_000 }, now)
  assert.deepEqual(dueReminders(s, now), [])
  assert.equal(dueReminders(s, now + 60_000).length, 1)
  assert.ok(markDelivered(s, r.id, now + 60_000))
  assert.equal(markDelivered(s, r.id, now + 60_001), null)
  assert.equal(dueReminders(s, now + 120_000).length, 0)
  updateReminder(s, r.id, { dueAt: now + 600_000 }, now + 60_000)
  assert.equal(dueReminders(s, now + 600_000).length, 1)
  updateReminder(s, r.id, { status: 'done' }, now)
  assert.equal(dueReminders(s, now + 600_000).length, 0)
})

test('one live reminder per notice', () => {
  const s = createInitialState()
  const a = addReminder(s, { title: '报告会', dueAt: now + 1000, noticeId: 'n1' }, now)
  const b = addReminder(s, { title: '报告会', dueAt: now + 2000, noticeId: 'n1' }, now)
  assert.equal(a.id, b.id)
  assert.equal(s.reminders.length, 1)
  assert.equal(s.reminders[0].dueAt, now + 2000)
})

test('Chinese numbers', () => {
  assert.equal(cnNumber('九'), 9)
  assert.equal(cnNumber('十'), 10)
  assert.equal(cnNumber('十二'), 12)
  assert.equal(cnNumber('二十三'), 23)
  assert.equal(cnNumber('21'), 21)
})

test('parses the times people actually say', () => {
  assert.deepEqual(hm(parseWhen('今晚九点提醒我完成数学作业', now).at), [13, 21, 0])
  assert.deepEqual(hm(parseWhen('明天早上8点半叫我起床', now).at), [14, 8, 30])
  assert.deepEqual(hm(parseWhen('下午四点一刻提醒我', now).at), [13, 16, 15])
  assert.deepEqual(hm(parseWhen('9点提醒我', now).at), [13, 21, 0], 'a bare 9点 in the afternoon means tonight')
  assert.deepEqual(hm(parseWhen('2点提醒我', now).at), [14, 2, 0], 'past for both readings → tomorrow')
  assert.equal(parseWhen('十分钟后提醒我喝水', now).at, now + 10 * 60_000)
  assert.equal(parseWhen('提醒我喝水', now), null)
})

test('pulls the task out of a reminder request', () => {
  const ask = text => reminderTitle(text, parseWhen(text, now)?.matched)
  assert.equal(ask('今晚九点提醒我完成数学作业'), '完成数学作业')
  assert.equal(ask('提醒我今晚九点写作业哦'), '写作业')
  assert.equal(ask('十分钟后提醒我喝水'), '喝水')
  assert.equal(ask('帮我定个晚上9点的闹钟'), '')
  assert.equal(ask('明早7点的闹钟，我要去跑步'), '我要去跑步')
})

test('hydrate drops malformed data and keeps the good parts', () => {
  assert.equal(hydrate('not json').profile.botName, '小浙')
  const s = createInitialState()
  s.profile.nickname = '阿俊'
  s.profile.look = 'pigeon'
  s.profile.image = 'javascript:alert(1)'
  s.messages.bot.push({ id: 'm1', role: 'bot', kind: 'text', text: 'hi', at: now }, { id: 'bad', role: 'hacker', kind: 'text', text: 'x', at: now })
  s.channels.push({ id: 'src-mine', kind: 'source', title: '计算机学院', site: 'https://example.edu.cn', emoji: '🧪', tint: '#eef3ee' })
  const back = hydrate(JSON.stringify(s))
  assert.equal(back.profile.nickname, '阿俊')
  assert.equal(back.profile.look, 'pigeon')
  assert.equal(back.profile.image, null)
  assert.deepEqual(back.messages.bot.map(m => m.id), ['m1'])
  assert.ok(back.channels.find(c => c.id === 'src-mine')?.pending)
})

test('store persists through storage and survives a broken one', async () => {
  const mem = new Map()
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) }
  const store = createStore(storage)
  store.addMessage('bot', { role: 'user', text: '你好' })
  await new Promise(r => setTimeout(r, 260))
  assert.equal(createStore(storage).state.messages.bot.at(-1).text, '你好')

  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
  const b = createStore(broken)
  let failed = false
  b.on('save-failed', () => { failed = true })
  b.addMessage('bot', { role: 'user', text: 'x' })
  await new Promise(r => setTimeout(r, 260))
  assert.ok(failed)
})

test('demo chat asks for a nickname first, then sets reminders through actions', async () => {
  const chat = createDemoChat()
  const s = createInitialState()
  const collect = async text => { const out = []; for await (const e of chat.respond({ text, state: s })) out.push(e); return out }
  const notAName = await collect('你好小浙，有什么通知吗')
  assert.ok(!notAName.some(e => e.type === 'action'), 'a question is not a nickname')
  const bare = (await collect('小林')).find(e => e.type === 'action')
  assert.equal(bare?.args.nickname, '小林')
  const first = await collect('叫我阿俊吧')
  assert.deepEqual(first.find(e => e.type === 'action'), { type: 'action', name: 'profile.update', args: { nickname: '阿俊' } })
  s.profile.nickname = '阿俊'
  const second = await collect('今晚九点提醒我完成数学作业')
  const action = second.find(e => e.type === 'action')
  assert.equal(action.name, 'reminder.create')
  assert.equal(action.args.title, '完成数学作业')
  const alarm = (await collect('帮我定个晚上9点的闹钟')).find(e => e.type === 'action')
  assert.equal(alarm?.args.title, '闹钟')
  const vague = await collect('提醒我交报告')
  assert.ok(!vague.some(e => e.type === 'action'), 'no time → ask instead of guessing')
})
