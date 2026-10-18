import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_CHANNELS, localAdapters, noticeCopy } from '../web/js/services/sources.js'
import { cleanHomework, homeworkCopy, homeworkTime, homeworkDetailHTML } from '../web/js/services/homework.js'
import { decisionCopy } from '../web/js/services/notice-summary.js'
import { createInitialState, createStore, hydrate } from '../web/js/store.js'

const row = (revision = '1', homework = {}) => ({
  id: 'xzzd:123', sourceId: 'xzzd', title: '第 3 次作业', url: 'https://courses.zju.edu.cn/course/12/learning-activity/full-screen#/123',
  version: 1, revision, state: 'complete', firstSeenAt: '2026-10-17T03:00:00Z', lastChangedAt: '2026-10-17T04:00:00Z',
  analysis: { state: 'local_only' },
  homework: { activityId: '123', courseId: '12', courseName: '高等数学', courseCode: 'MATH1001',
    openAt: '2026-10-17T08:00:00+08:00', deadlineAt: '2026-10-20T12:00:00Z', submissionStatus: 'not_submitted', isClosed: false, ...homework },
})

test('existing four-source users automatically gain the authenticated homework channel', () => {
  const saved = createInitialState()
  saved.channels = saved.channels.filter(channel => channel.sourceId !== 'xzzd')
  delete saved.messages['src-xzzd']
  saved.channels.find(channel => channel.sourceId === 'itc').notify = 'mute'
  const state = hydrate(saved)
  const channel = state.channels.find(channel => channel.sourceId === 'xzzd')
  assert.equal(channel.kind, 'source')
  assert.equal(channel.requiresAuth, true)
  assert.equal(channel.allowAi, false)
  assert.equal(channel.url, 'https://courses.zju.edu.cn/login')
  assert.equal(channel.every, '每 5 分钟')
  assert.deepEqual(state.messages[channel.id], [])
  assert.equal(state.channels.find(channel => channel.sourceId === 'itc').notify, 'mute')
  assert.equal(LOCAL_CHANNELS.length, 5)
})

test('homework adapter displays official structured data without model analysis', async () => {
  const calls = []
  const client = { async notices(sourceId, offset) { calls.push([sourceId, offset]); return { items: [row()], nextOffset: null } } }
  const item = (await localAdapters(client).find(adapter => adapter.channelId === 'src-xzzd').fetch())[0]
  assert.deepEqual(calls, [['xzzd', 0]])
  assert.equal(item.kind, 'homework')
  assert.equal(item.analysisState, 'local_only')
  const copy = noticeCopy(item)
  assert.match(copy, /【作业】\n课程：高等数学（MATH1001）\n任务：第 3 次作业/)
  assert.match(copy, /截止：2026-10-20 20:00（北京时间）\n状态：未提交/)
  assert.doesNotMatch(copy, /整理|api-key|通知标题/)
})

test('deadline and submission revisions update one persisted card', async () => {
  const store = createStore(null)
  const adapter = localAdapters({ async notices() { return { items: [row()], nextOffset: null } } }).find(source => source.channelId === 'src-xzzd')
  const item = (await adapter.fetch())[0]
  const first = store.upsertNotice('src-xzzd', { role: 'bot', kind: 'notice', text: noticeCopy(item), item })
  const next = { ...item, revision: '2', homework: { ...item.homework, submissionStatus: 'submitted', deadlineAt: '2026-10-21' } }
  const update = store.upsertNotice('src-xzzd', { role: 'bot', kind: 'notice', text: noticeCopy(next), item: next })
  assert.equal(update.created, false)
  assert.equal(update.revised, true)
  assert.equal(update.message.id, first.message.id)
  assert.equal(store.state.messages['src-xzzd'].length, 1)
  assert.equal(update.message.item.homework.submissionStatus, 'submitted')
  assert.match(update.message.text, /已提交/)
  // Completed tasks stay in the authoritative store, but leave the default UI.
  const restored = hydrate(JSON.stringify(store.state)).messages['src-xzzd']
  assert.equal(restored.length, 0)
})

test('unknown and closed states never imply successful submission or invented deadlines', () => {
  const item = { sourceId: 'xzzd', title: '练习', homework: { submissionStatus: 'unknown', isClosed: true } }
  assert.match(decisionCopy(item), /截止：原站未说明\n状态：提交状态未知；作业已结束/)
  assert.doesNotMatch(decisionCopy(item), /已提交|已完成/)
  assert.match(homeworkCopy({ ...item, homework: { submissionStatus: 'not_submitted', isClosed: true } }), /未提交；作业已结束/)
  assert.equal(homeworkTime('2026-10-20'), '2026-10-20（原站仅提供日期）')
  assert.equal(homeworkTime('2026-02-30'), '原站未说明')
  assert.equal(homeworkTime('2026-10-20T12:00:00'), '原站未说明')
  assert.equal(cleanHomework({ submissionStatus: 'completed', isClosed: 'true' }).submissionStatus, 'unknown')
  assert.equal(cleanHomework({ isClosed: 'true' }).isClosed, null)
})

test('homework detail escapes source text, rejects unsafe links, and offers no model controls', () => {
  const item = { ...row(), title: '<img src=x onerror=alert(1)>', kind: 'homework', homework: { courseName: '<script>evil</script>' } }
  const html = homeworkDetailHTML(item, {
    content: '先读 <script>alert(1)</script>\n再完成练习',
    attachments: [{ name: '<img src=x>', url: 'https://courses.zju.edu.cn/files/1' }, { name: 'bad', url: 'javascript:alert(1)' }],
  })
  assert.match(html, /&lt;script&gt;evil&lt;\/script&gt;/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<br>/)
  assert.match(html, /打开官方作业入口/)
  assert.doesNotMatch(html, /<script>|<img|javascript:|重新整理|api-key|data-api-settings/)
  const noBody = homeworkDetailHTML(item, { content: '', attachments: [] })
  assert.match(noBody, /原站未提供文字要求/)
  assert.doesNotMatch(noBody, /正文待补齐|无法整理|没有配置/)
})

test('empty homework requirements distinguish queued, inaccessible, failed and genuinely empty details', () => {
  const item = { ...row(), kind: 'homework' }
  const pending = homeworkDetailHTML(item, { state: 'pending', content: '' })
  assert.match(pending, /作业要求正在按队列采集中，可先打开官方入口/)
  assert.doesNotMatch(pending, /原站未提供文字要求/)
  const denied = homeworkDetailHTML(item, { state: 'failed', lastError: 'homework_access_denied', content: '' })
  assert.match(denied, /该作业详情暂不可访问/)
  assert.doesNotMatch(denied, /原站未提供文字要求/)
  const failed = homeworkDetailHTML(item, { state: 'failed', lastError: 'network_error', content: '' })
  assert.match(failed, /作业详情读取失败，请稍后重试/)
  assert.doesNotMatch(failed, /原站未提供文字要求/)
  for (const detail of [{ state: 'complete', content: '' }, { content: '' }]) {
    assert.match(homeworkDetailHTML(item, detail), /原站未提供文字要求/)
  }
  const retained = homeworkDetailHTML(item, { state: 'pending', content: '已保存的要求 <script>safe</script>' })
  assert.match(retained, /已保存的要求 &lt;script&gt;safe&lt;\/script&gt;/)
  assert.doesNotMatch(retained, /正在按队列采集/)
})
