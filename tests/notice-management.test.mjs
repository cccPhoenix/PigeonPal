import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate, STORAGE_KEY } from '../web/js/store.js'
import { noticeUnreadCount, selectNotices } from '../web/js/services/notice-list.js'
import { localAdapters } from '../web/js/services/sources.js'

globalThis.document = { addEventListener() {}, getElementById: () => ({ textContent: '', classList: { add() {}, remove() {} } }) }
const { createRail } = await import('../web/js/ui/rail.js')
const { createIconRail } = await import('../web/js/ui/dock.js')

const item = (id, sourceId = 'yunfeng', extra = {}) => ({
  id, noticeId: id, title: `通知 ${id}`, sourceId, revision: 'r1', publishedAt: 100, ...extra,
})
const ids = (store, options) => selectNotices(store.state, options).map(n => n.noticeId)
const pane = () => {
  const handlers = {}
  return { innerHTML: '', handlers, addEventListener: (name, fn) => { handlers[name] = fn } }
}
const click = (root, selector, dataset) => root.handlers.click({ target: { closest: value => value === selector ? { dataset } : null } })

test('unread counts distinct notices across revisions and reading every source clears the bell total', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a'), { unread: true })
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', { revision: 'r2' }), { unread: true })
  store.upsertNotice('src-itc', item('b', 'itc'), { unread: true })
  store.addMessage('bot', { role: 'bot', text: '聊天未读' }, { unread: true })
  store.addMessage('src-xzzd', { role: 'bot', text: '作业未读' }, { unread: true })
  assert.equal(noticeUnreadCount(store.state), 2)
  assert.equal(noticeUnreadCount(store.state, 'yunfeng'), 1)
  store.markNoticesRead('yunfeng')
  assert.equal(noticeUnreadCount(store.state), 1)
  store.markNoticesRead('itc')
  assert.equal(noticeUnreadCount(store.state), 0)
  assert.equal(store.state.unread.bot, 1)
  assert.equal(store.state.unread['src-xzzd'], 1)
  const back = hydrate(JSON.stringify(store.state))
  assert.equal(noticeUnreadCount(back), 0)
})

test('legacy counters reconcile to distinct notices and malformed metadata cannot hide or star rows', () => {
  const notices = { a: item('a'), b: item('b') }
  const migrated = hydrate({ version: 1, notices, unread: { 'src-yunfeng': 9 } })
  assert.equal(noticeUnreadCount(migrated), 2)
  const state = hydrate({ version: 1, notices, noticeSort: 'invalid', noticeMeta: {
    a: { starred: 'true', deletedAt: 'today', unread: true, channelId: 'bot' },
    b: { starred: true, deletedAt: 42, unread: true, channelId: 'src-yunfeng' },
  } })
  assert.equal(state.noticeSort, 'newest')
  assert.equal(hydrate({ version: 1, noticeSort: 'recommended' }).noticeSort, 'newest')
  assert.equal(state.noticeMeta.a, undefined)
  assert.deepEqual(state.noticeMeta.b, { starred: true, deletedAt: 42 })
  assert.equal(noticeUnreadCount(state), 0)
})

test('a deferred recommendation can become unread without changing the notice revision', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('pending', 'yunfeng', { recommendation: { deferPush: true } }))
  assert.equal(noticeUnreadCount(store.state), 0)
  store.upsertNotice('src-yunfeng', item('pending', 'yunfeng', { recommendation: { decision: 'recommended' } }), { unread: true })
  assert.equal(noticeUnreadCount(store.state), 1)
  store.upsertNotice('src-yunfeng', item('pending', 'yunfeng', { recommendation: { decision: 'recommended' } }), { unread: true })
  assert.equal(noticeUnreadCount(store.state), 1)
})

test('deleting removes only that unread notice and feed revisions cannot resurrect trashed rows', () => {
  const store = createStore(null)
  for (const id of ['a', 'b']) store.upsertNotice('src-yunfeng', item(id), { unread: true })
  store.setNoticeStarred('a', true)
  store.trashNotice('a')
  store.trashNotice('a')
  assert.equal(noticeUnreadCount(store.state), 1)
  assert.deepEqual(ids(store), ['b'])
  assert.deepEqual(store.noticesOf('yunfeng').map(n => n.noticeId), ['b'])
  store.upsertNotice('src-yunfeng', item('a', 'yunfeng', { revision: 'r2', title: '更新后的标题' }), { unread: true })
  assert.deepEqual(ids(store), ['b'])
  assert.equal(noticeUnreadCount(store.state), 1)
  assert.deepEqual(ids(store, { trash: true }), ['a'])
  store.restoreNotice('a')
  assert.deepEqual(ids(store), ['a', 'b'])
  assert.equal(store.state.noticeMeta.a.starred, true)
  assert.equal(noticeUnreadCount(store.state), 1, 'restoring must not invent a new unread event')
  assert.equal(store.notice('a').title, '更新后的标题')
})

test('stars lead every sort; time uses both directions and unknown dates stay last; types group consistently', () => {
  const store = createStore(null)
  for (const n of [
    item('old', 'yunfeng', { publishedAt: 10, category: 'activity', recommendation: { priority: 90 } }),
    item('new', 'itc', { publishedAt: 30, category: 'service', recommendation: { priority: 10 } }),
    item('academic', 'yunfeng', { publishedAt: 20, category: 'academic' }),
    item('unknown', 'yunfeng', { publishedAt: null }),
    item('star', 'yunfeng', { publishedAt: 1, recommendation: { state: 'ready', decision: 'not_applicable', allowPush: false } }),
  ]) store.upsertNotice(`src-${n.sourceId}`, n)
  store.setNoticeStarred('star', true)
  assert.equal(store.state.noticeSort, 'newest')
  assert.deepEqual(ids(store), ['star', 'new', 'academic', 'old', 'unknown'])
  assert.deepEqual(ids(store, { sort: 'recommended' }), ['star', 'old', 'new', 'academic', 'unknown'])
  assert.deepEqual(ids(store, { sort: 'newest' }), ['star', 'new', 'academic', 'old', 'unknown'])
  assert.deepEqual(ids(store, { sort: 'oldest' }), ['star', 'old', 'academic', 'new', 'unknown'])
  assert.deepEqual(ids(store, { sort: 'type' }), ['star', 'academic', 'old', 'new', 'unknown'])
  assert.deepEqual(ids(store, { sourceId: 'itc', sort: 'oldest' }), ['new'])
  store.setNoticeStarred('star', false)
  assert.ok(!ids(store).includes('star'))
  assert.ok(ids(store, { mode: 'all' }).includes('star'))
})

test('stars, trash, unread markers and sorting survive restart beyond the warm cache cap', async () => {
  const data = new Map()
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }
  const store = createStore(storage)
  for (let i = 0; i < 55; i++) store.upsertNotice('src-yunfeng', item(`n${i}`, 'yunfeng', { publishedAt: i + 1 }))
  store.setNoticeStarred('n0', true)
  store.trashNotice('n1')
  store.upsertNotice('src-yunfeng', item('n2', 'yunfeng', { revision: 'r2', publishedAt: 3 }), { unread: true })
  store.setNoticeSort('oldest')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(data.get(STORAGE_KEY))
  const restarted = createStore(storage)
  assert.equal(restarted.state.noticeSort, 'oldest')
  assert.equal(ids(restarted)[0], 'n0')
  assert.deepEqual(ids(restarted, { trash: true }), ['n1'])
  assert.equal(noticeUnreadCount(restarted.state), 1)
  assert.equal(Object.keys(restarted.state.notices).length, 43)
  restarted.restoreNotice('n1')
  assert.ok(ids(restarted).includes('n1'))
})

test('list and detail actions share star/trash state, trash filters do not acknowledge active notices', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', item('a'), { unread: true })
  store.upsertNotice('src-itc', item('b', 'itc'), { unread: true })
  const listRoot = pane(), detailRoot = pane(), host = { dataset: {} }
  listRoot.parentElement = host
  const rail = createRail({ listRoot, detailRoot, store, client: {}, onRead: source => store.markNoticesRead(source) })
  store.on('unread', rail.renderList)
  rail.render()
  click(listRoot, '[data-notice-action]', { noticeAction: 'star', id: 'a' })
  assert.match(listRoot.innerHTML, /星标置顶/)
  rail.openNotice('a')
  assert.match(detailRoot.innerHTML, /取消星标/)
  assert.equal(noticeUnreadCount(store.state), 1)
  click(detailRoot, '[data-act]', { act: 'trash' })
  assert.equal(rail.selected, null)
  assert.equal(host.dataset.pane, 'list')
  assert.doesNotMatch(listRoot.innerHTML, /data-notice="a"/)
  rail.setTrash(true)
  assert.match(listRoot.innerHTML, /data-notice="a"/)
  assert.doesNotMatch(listRoot.innerHTML, /data-notice="b"/)
  rail.setFilter('itc')
  assert.equal(noticeUnreadCount(store.state), 1)
  rail.setFilter('yunfeng')
  rail.openNotice('a')
  assert.match(detailRoot.innerHTML, /恢复通知/)
  click(detailRoot, '[data-act]', { act: 'restore' })
  assert.equal(rail.selected, null)
  rail.setTrash(false)
  assert.match(listRoot.innerHTML, /data-notice="a"/)
  listRoot.handlers.change({ target: { closest: () => true, value: 'type' } })
  assert.equal(store.state.noticeSort, 'type')
  assert.match(listRoot.innerHTML, /value="type" selected/)
  rail.reveal('b')
  assert.equal(noticeUnreadCount(store.state), 0)
})

test('bell patches a live badge down to zero without recreating the companion or affecting homework/chat', () => {
  const store = createStore(null)
  const buttons = new Map(), root = pane()
  let renders = 0
  Object.defineProperty(root, 'innerHTML', {
    get: () => '', set(html) {
      renders++
      for (const id of ['notice', 'homework', 'chat']) {
        const section = html.match(new RegExp(`data-view="${id}"[^>]*>([\\s\\S]*?)</button>`))?.[1] || ''
        let badge = section.match(/class="badge">([^<]*)</)?.[1] || null
        buttons.set(id, {
          get badge() { return badge },
          querySelector: () => badge === null ? null : { remove() { badge = null }, set textContent(v) { badge = v } },
          insertAdjacentHTML: (_, value) => { badge = value.match(/class="badge">([^<]*)</)[1] },
        })
      }
    },
  })
  root.querySelector = selector => buttons.get(selector.match(/data-view="([^"]+)"/)?.[1])
  const dock = createIconRail({ root, store })
  dock.render()
  dock.setHomeworkUnread(4)
  dock.setChatUnread(2)
  store.upsertNotice('src-yunfeng', item('a'), { unread: true })
  store.upsertNotice('src-itc', item('b', 'itc'), { unread: true })
  assert.equal(buttons.get('notice').badge, '2')
  store.markNoticesRead('yunfeng')
  assert.equal(buttons.get('notice').badge, '1')
  store.markNoticesRead('itc')
  assert.equal(buttons.get('notice').badge, null)
  assert.equal(buttons.get('homework').badge, '4')
  assert.equal(buttons.get('chat').badge, '2')
  assert.equal(renders, 1)
})

test('adapter does not substitute crawl time for a missing publication date', async () => {
  const adapter = localAdapters({ notices: async () => ({ items: [
    { id: 'yunfeng:unknown', title: '无日期', sourceId: 'yunfeng', firstSeenAt: new Date().toISOString(), publishedAt: '' },
  ] }) })[0]
  assert.equal((await adapter.fetch())[0].publishedAt, null)
})
