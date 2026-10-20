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

test('a batched revision refreshes the selected notice detail without losing the latest row', async () => {
  const store = createStore(null), listRoot = pane(), detailRoot = pane(), fetched = []
  const first = item('selected', 'yunfeng', 5)
  store.upsertNotice('src-yunfeng', first)
  const rail = createRail({ listRoot, detailRoot, store, client: { notice: async id => {
    fetched.push(id)
    return { state: 'complete', content: `正文版本 ${fetched.length}`, url: first.url }
  } } })
  rail.openNotice('selected')
  await new Promise(resolve => setImmediate(resolve))
  const latest = { ...first, revision: 'r2', title: '新版标题' }
  store.upsertNotice('src-yunfeng', latest)
  store.upsertNotice('src-yunfeng', item('other', 'yunfeng', 6))
  rail.onNotices([{ item: store.notice('other'), revised: false }, { item: latest, revised: true }])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fetched, ['selected', 'selected'])
  assert.equal(rail.selected, 'selected')
  assert.match(listRoot.innerHTML, /新版标题/)
  assert.match(detailRoot.innerHTML, /正文版本 2/)
})

test('rail filter shows one source and marks the active chip', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', 5))
  store.upsertNotice('src-itc', item('b', 'itc', 6))
  const listRoot = pane()
  const read = []
  const rail = createRail({ listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) }, onRemind() {}, onRead: sourceId => read.push(sourceId) })
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
  assert.deepEqual(read, ['yunfeng', null])
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

test('viewing a source clears its unread marker, and viewing all clears the rest', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', 5), { unread: true })
  store.upsertNotice('src-itc', item('b', 'itc', 6), { unread: true })
  const listRoot = pane()
  const rail = createRail({
    listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) },
    onRead(sourceId) {
      for (const channel of store.state.channels.filter(c => c.kind === 'source' && c.sourceId !== 'xzzd')) {
        if (!sourceId || channel.sourceId === sourceId) store.markRead(channel.id)
      }
    },
  })
  store.on('unread', () => rail.renderList())
  rail.render()
  assert.match(listRoot.innerHTML, /<span class="badge">2<\/span>/)
  rail.setFilter('yunfeng')
  assert.equal(store.state.unread['src-yunfeng'], undefined)
  assert.equal(store.state.unread['src-itc'], 1)
  rail.setFilter(null)
  assert.equal(store.state.unread['src-itc'], undefined)
  assert.doesNotMatch(listRoot.innerHTML, /<span class="badge">/)
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
  const read = []
  const rail = createRail({ listRoot, detailRoot, store, client: { notice: async () => ({}) }, onRead: sourceId => read.push(sourceId) })
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
  assert.deepEqual(read, ['yunfeng', 'yunfeng'])
})

test('homework view shows the learning platform snapshot and switches back to campus notices', async () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('campus', 'yunfeng', 5))
  const homework = {
    id: 'xzzd:1', noticeId: 'xzzd:1', sourceId: 'xzzd', kind: 'homework', real: true,
    revision: '1', title: '实验报告', url: 'https://example.edu.cn/homework/1',
    publishedAt: Date.now(), homework: {
      courseName: '计算机导论', courseCode: '(2026-2027-1)-A',
      openAt: '2026-10-01T08:00:00+08:00', deadlineAt: '2026-10-30T20:00:00+08:00',
      submissionStatus: 'not_submitted', isClosed: false,
    },
  }
  store.syncHomeworkSnapshot([homework])
  const host = { dataset: {} }
  const listRoot = { ...pane(), parentElement: host }
  const detailRoot = pane()
  const rail = createRail({ listRoot, detailRoot, store, client: { notice: async () => ({ content: '完成报告并上传 PDF' }) } })
  rail.render()
  rail.setView('homework')
  assert.match(listRoot.innerHTML, /学在浙大 · 作业/)
  assert.match(listRoot.innerHTML, /实验报告/)
  assert.match(listRoot.innerHTML, /计算机导论/)
  assert.doesNotMatch(listRoot.innerHTML, /通知 campus/)
  rail.openHomework('xzzd:1')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(host.dataset.pane, 'detail')
  assert.match(detailRoot.innerHTML, /完成报告并上传 PDF/)
  store.syncHomeworkSnapshot([])
  rail.render()
  assert.equal(rail.selected, null)
  assert.equal(host.dataset.pane, 'list')
  store.syncHomeworkSnapshot([homework])
  rail.render()
  rail.back()
  assert.equal(host.dataset.pane, 'list')
  rail.setView('notice')
  assert.match(listRoot.innerHTML, /通知 campus/)
  assert.doesNotMatch(listRoot.innerHTML, /实验报告/)
})

test('homework course dropdown filters assignments and survives view changes and snapshots', () => {
  const store = createStore(null)
  const now = Date.parse('2026-10-19T12:00:00+08:00')
  const assignment = (id, courseId, courseName) => ({
    id: `xzzd:${id}`, noticeId: `xzzd:${id}`, sourceId: 'xzzd', kind: 'homework', real: true,
    revision: '1', title: `作业${id}`, publishedAt: now,
    homework: { courseId, courseName, openAt: '2026-10-01T08:00:00+08:00', deadlineAt: '2026-10-30T20:00:00+08:00', submissionStatus: 'not_submitted', isClosed: false },
  })
  const math = assignment('math', 'm1', '高等数学')
  const english = assignment('english', 'e1', '大学英语')
  store.syncHomeworkSnapshot([math, english], { now })
  const listeners = {}
  const host = { dataset: {} }
  const listRoot = { ...pane(), parentElement: host, addEventListener(type, handler) { listeners[type] = handler } }
  const rail = createRail({ listRoot, detailRoot: pane(), store, client: { notice: async () => ({}) } })
  rail.setView('homework')
  assert.match(listRoot.innerHTML, /按课程筛选/)
  assert.match(listRoot.innerHTML, /class="homework-option-name">全部课程</)
  assert.match(listRoot.innerHTML, /class="homework-option-name">高等数学</)
  assert.match(listRoot.innerHTML, /class="homework-option-name">大学英语</)
  const click = (selector, dataset = {}) => listeners.click({ target: {
    closest(candidate) { return candidate === selector ? { dataset } : null },
  } })
  click('[data-rail="homework-toggle"]')
  assert.match(listRoot.innerHTML, /aria-expanded="true"/)
  assert.doesNotMatch(listRoot.innerHTML, /role="listbox" aria-label="课程" hidden/)
  listeners.keydown({ key: 'Escape', target: { closest: () => null }, preventDefault() {} })
  assert.match(listRoot.innerHTML, /aria-expanded="false"/)
  assert.match(listRoot.innerHTML, /role="listbox" aria-label="课程" hidden/)
  click('[data-rail="homework-toggle"]')
  rail.openHomework(math.noticeId)
  click('[data-rail="homework-course"]', { course: 'id:e1' })
  assert.equal(rail.homeworkCourse, 'id:e1')
  assert.equal(rail.selected, null)
  assert.equal(host.dataset.pane, 'list')
  assert.match(listRoot.innerHTML, /作业english/)
  assert.doesNotMatch(listRoot.innerHTML, /作业math/)
  assert.match(listRoot.innerHTML, /data-course="id:e1" aria-selected="true"/)
  assert.match(listRoot.innerHTML, /class="homework-filter-name">大学英语</)
  rail.setView('notice')
  rail.setView('homework')
  assert.equal(rail.homeworkCourse, 'id:e1')
  assert.doesNotMatch(listRoot.innerHTML, /作业math/)
  store.syncHomeworkSnapshot([math], { now })
  rail.render()
  assert.equal(rail.homeworkCourse, null)
  assert.match(listRoot.innerHTML, /作业math/)
  assert.match(listRoot.innerHTML, /data-course="" aria-selected="true"/)
})
