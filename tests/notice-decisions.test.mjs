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
    const first = store.upsertNotice('src-yunfeng', item)
    const second = store.upsertNotice('src-yunfeng', item)
    assert.deepEqual([first.created, second.created, second.revised], [true, false, false])
    assert.equal(store.upsertNotice('src-yunfeng', { ...item, revision: 'v2' }).revised, true)
    assert.equal(Object.keys(store.state.notices).length, 1)
    const restored = hydrate(JSON.stringify(store.state)).notices[item.noticeId]
    assert.equal(restored.benefits, entry.expected.benefits)
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

test('rail detail table escapes the title and lists the full decision summary', async () => {
  const store = createStore(null)
  const entry = row(cases[4])
  const item = { real: true, title: '<img src=x onerror=alert(1)>', noticeId: entry.id, sourceId: 'yunfeng', ...analysisFields(entry.analysis) }
  store.upsertNotice('src-yunfeng', item)
  const listRoot = { innerHTML: '', addEventListener() {} }
  const detailRoot = { innerHTML: '', addEventListener() {} }
  globalThis.document = globalThis.document ?? { addEventListener() {} }
  const { createRail } = await import('../web/js/ui/rail.js')
  const rail = createRail({
    listRoot, detailRoot, store, onRemind() {},
    client: { notice: async () => ({ publisher: '<b>x</b>', state: 'complete', content: '正文', attachments: [] }) },
  })
  rail.render()
  rail.openNotice(entry.id)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.match(detailRoot.innerHTML, /class="kv-table"/)
  assert.match(detailRoot.innerHTML, /完成全部服务并审核通过后计入3小时/)
  assert.doesNotMatch(detailRoot.innerHTML, /<img src=x/)
  assert.match(detailRoot.innerHTML, /&lt;img/)
  assert.doesNotMatch(detailRoot.innerHTML, /<b>x<\/b>/)
  assert.match(detailRoot.innerHTML, /&lt;b&gt;x&lt;\/b&gt;/)
  assert.match(richText('<script>alert(1)</script>', {}), /&lt;script&gt;/)
})
