import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { localAdapters, noticeCopy } from '../web/js/services/sources.js'
import { analysisFields, decisionCopy } from '../web/js/services/notice-summary.js'
import { createStore, hydrate } from '../web/js/store.js'
import { createTranscript } from '../web/js/ui/transcript.js'
import { richText } from '../web/js/ui/format.js'

const cases = JSON.parse(await readFile(new URL('./notice-decision-fixtures.json', import.meta.url), 'utf8'))
const row = (entry, index = 0) => ({
  id: `yunfeng:${index}`, sourceId: 'yunfeng', title: entry.title,
  state: 'complete', revision: 'ready', version: 1, url: 'https://yunfeng.zju.edu.cn/1/page.htm',
  publishedAt: '', firstSeenAt: '2026-10-15T00:00:00Z',
  analysis: { state: 'ready', result: { ...entry.expected, notes: [], todos: [] } },
})

test('six examples reach channel copy, details and browser persistence with precise conditions', async () => {
  const rows = cases.map(row)
  const adapter = localAdapters({ notices: async () => ({ items: rows }) })[0]
  const items = await adapter.fetch()
  for (let index = 0; index < cases.length; index++) {
    const item = items[index], entry = cases[index]
    const copy = noticeCopy(item)
    assert.ok(copy.startsWith(`【${entry.expected.noticeType}｜${entry.expected.participation}】`))
    for (const label of ['面向：', '要点：', '时间：', '截止：', '收益：']) assert.ok(copy.includes(label))
    for (const key of ['benefits', 'eventTime', 'deadlineText']) assert.ok(copy.includes(entry.expected[key]))
    assert.ok(!copy.includes(entry.title))
    assert.equal(decisionCopy({ ...item, ...analysisFields(rows[index].analysis) }), copy)
    const store = createStore(null)
    store.upsertNotice('src-yunfeng', { role: 'bot', kind: 'notice', text: copy, item })
    store.upsertNotice('src-yunfeng', { role: 'bot', kind: 'notice', text: copy, item })
    assert.equal(store.state.messages['src-yunfeng'].length, 1)
    const restored = hydrate(JSON.stringify(store.state)).messages['src-yunfeng'][0]
    assert.equal(restored.text, copy)
    assert.equal(restored.item.benefits, entry.expected.benefits)
  }
  assert.doesNotMatch(noticeCopy(items[2]), /2026|00:00|23:59/)
  assert.match(noticeCopy(items[4]), /完成全部服务并审核通过后计入3小时/)
  assert.doesNotMatch(noticeCopy(items[5]), /2学分|10月30日|全校学生/)
})

test('pending, processing, failed and body/key failures never display stale inferred results', async () => {
  const expected = { pending: '等待整理', processing: '正在整理', failed: '整理失败',
    waiting_body: '正文未抓到', unconfigured: '没有配置api-key，数据整理暂不可用', blocked: '整理未获授权' }
  for (const [state, label] of Object.entries(expected)) {
    const data = row(cases[0]); data.analysis.state = state
    const [item] = await localAdapters({ notices: async () => ({ items: [data] }) })[0].fetch()
    assert.ok(noticeCopy(item).includes(label))
    assert.doesNotMatch(noticeCopy(item), /5000|开放申请/)
    assert.equal(item.summary, '')
  }
  assert.match(noticeCopy({ real: true, analysisState: 'ready', summary: '旧摘要' }), /旧版整理结果待更新/)
})

test('real notice title is collapsed; main copy is escaped and full decision summary remains visible', () => {
  const store = createStore(null)
  const entry = row(cases[4])
  const item = { real: true, title: '<img src=x onerror=alert(1)>', noticeId: entry.id, ...analysisFields(entry.analysis) }
  store.addMessage('src-yunfeng', { role: 'bot', kind: 'notice', text: noticeCopy(item), item })
  const root = { innerHTML: '', firstElementChild: { querySelectorAll: () => [] }, addEventListener() {}, scrollTo() {} }
  const jump = { addEventListener() {} }
  globalThis.matchMedia = () => ({ matches: false })
  const transcript = createTranscript({ root, jump, store, onAction() {} })
  transcript.render('src-yunfeng')
  assert.match(root.innerHTML, /<details><summary>原标题<\/summary>/)
  assert.match(root.innerHTML, /完成全部服务并审核通过后计入3小时/)
  assert.doesNotMatch(root.innerHTML, /<img src=x/)
  assert.match(root.innerHTML, /&lt;img/)
  assert.match(richText('<script>alert(1)</script>', {}), /&lt;script&gt;/)
})
