import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate } from '../web/js/store.js'
import { headsUp } from '../web/js/services/sources.js'

// rail.js pulls in overlays.js, which binds document listeners at module scope.
globalThis.document = globalThis.document ?? { addEventListener() {} }
const { createRail } = await import('../web/js/ui/rail.js')

const item = (id, sourceId, publishedAt, extra = {}) => ({
  id, noticeId: id, sourceId, revision: 'r1', real: true,
  title: `通知 ${id}`, url: 'https://example.edu.cn/a.htm', publishedAt,
  analysisState: 'ready', ...extra,
})

test('legacy notice messages migrate into the rail collection and a heads-up line', () => {
  const stored = {
    version: 1,
    messages: {
      'src-yunfeng': [{ id: 'm1', role: 'bot', kind: 'notice', text: '【讲座｜自愿参加】', at: 1, item: item('n1', 'yunfeng', 100) }],
      'src-itc': [{ id: 'm2', role: 'bot', kind: 'notice', text: '🔔 示例', at: 2, item: { id: 'd1', noticeId: 'd1', title: '示例通知' } }],
      bot: [],
    },
  }
  const state = hydrate(JSON.stringify(stored))
  const migrated = state.messages['src-yunfeng'][0]
  assert.equal(migrated.kind, 'text')
  assert.equal(migrated.noticeId, 'n1')
  assert.equal(migrated.item, undefined)
  assert.match(migrated.text, /「通知 n1」/)
  assert.equal(state.notices.n1.sourceId, 'yunfeng')
  assert.equal(state.messages['src-itc'][0].kind, 'text')
  assert.equal(state.messages['src-itc'][0].noticeId, undefined)
  assert.equal(state.notices.d1, undefined)
})

test('malformed notice rows are dropped and each source keeps its newest 40', () => {
  const notices = { bad: { title: 'no id' }, alsobad: { id: 'x' }, noNoticeId: { id: 'z', title: 't' } }
  for (let i = 0; i < 45; i++) notices[`y${i}`] = item(`y${i}`, 'yunfeng', 1000 + i)
  const state = hydrate(JSON.stringify({ version: 1, notices }))
  assert.equal(state.notices.bad, undefined)
  assert.equal(state.notices.alsobad, undefined)
  assert.equal(state.notices.noNoticeId, undefined)
  assert.equal(Object.keys(state.notices).length, 40)
  assert.equal(state.notices.y0, undefined)
  assert.equal(state.notices.y44.title, '通知 y44')
})

const pane = () => ({ innerHTML: '', addEventListener() {} })

test('rail filter shows one source and marks the active chip', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', 5))
  store.upsertNotice('src-itc', item('b', 'itc', 6))
  const listRoot = pane()
  const rail = createRail({ listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) }, onRemind() {} })
  rail.render()
  assert.match(listRoot.innerHTML, /data-notice="a"/)
  assert.match(listRoot.innerHTML, /data-notice="b"/)
  rail.setFilter('yunfeng')
  assert.equal(rail.filter, 'yunfeng')
  assert.match(listRoot.innerHTML, /data-notice="a"/)
  assert.doesNotMatch(listRoot.innerHTML, /data-notice="b"/)
  assert.match(listRoot.innerHTML, /data-src="yunfeng" aria-pressed="true"/)
  rail.setFilter(null)
  assert.match(listRoot.innerHTML, /data-notice="b"/)
})

test('rail chips name every source and carry its unread count', () => {
  const store = createStore(null)
  store.upsertNotice('src-qsxy', item('q', 'qsxy', 5))
  store.setChannel('src-qsxy', { notify: 'all' })
  store.upsertNotice('src-qsxy', item('q2', 'qsxy', 6), { unread: true })
  const listRoot = pane()
  createRail({ listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) }, onRemind() {} }).renderList()
  assert.match(listRoot.innerHTML, /求是学院通知/)
  assert.match(listRoot.innerHTML, /本科生院通知/)
  assert.match(listRoot.innerHTML, /data-src="qsxy"[^>]*>[\s\S]*?<span class="badge">1<\/span>/)
})

test('headsUp is one line, quotes a shortened title and keeps the nickname placeholder', () => {
  const text = headsUp({ title: `关于举办${'长'.repeat(36)}补充说明` }, '云峰通知')
  assert.equal(text.split('\n').length, 1)
  assert.match(text, /云峰通知有新通知：「.{1,30}」/)
  assert.match(text, /\{nickname\}/)
  assert.ok(!text.includes('补充说明'))
})

test('the notice list shows each row title with its source', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('p1', 'yunfeng', 7, { title: '图书馆招募志愿者' }))
  const listRoot = pane()
  createRail({ listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) }, onRemind() {} }).renderList()
  assert.match(listRoot.innerHTML, /图书馆招募志愿者/)
  assert.match(listRoot.innerHTML, /云峰通知 ·/)
})

test('clicking the selected notice again closes its detail', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', 5))
  store.upsertNotice('src-yunfeng', item('b', 'yunfeng', 6))
  const listeners = {}
  const host = { dataset: {} }
  const listRoot = {
    ...pane(), parentElement: host,
    addEventListener(type, handler) { listeners[type] = handler },
  }
  const detailRoot = { ...pane(), classList: { remove() {}, add() {} } }
  const rail = createRail({ listRoot, detailRoot, store, client: { notice: async () => ({}) } })
  const clickNotice = noticeId => listeners.click({
    target: { closest(selector) { return selector === '[data-notice]' ? { dataset: { notice: noticeId } } : null } },
  })

  rail.render()
  clickNotice('a')
  assert.equal(rail.selected, 'a')
  assert.equal(host.dataset.pane, 'detail')
  clickNotice('b')
  assert.equal(rail.selected, 'b')
  assert.equal(host.dataset.pane, 'detail')
  clickNotice('b')
  assert.equal(rail.selected, null)
  assert.equal(host.dataset.pane, 'list')
  assert.doesNotMatch(listRoot.innerHTML, /正在查看/)
})
