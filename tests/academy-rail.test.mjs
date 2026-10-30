import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../web/js/store.js'
import { noticeChannels, noticeUnreadCount, selectNotices } from '../web/js/services/notice-list.js'
import { createAcademySelection, academySourceVisible } from '../web/js/services/academy-selection.js'

globalThis.document = { addEventListener() {} }
const { createRail } = await import('../web/js/ui/rail.js')
const { createIconRail } = await import('../web/js/ui/dock.js')

const pane = () => {
  const handlers = {}
  return { innerHTML: '', handlers, addEventListener: (name, fn) => { handlers[name] = fn } }
}
const click = (root, selector, dataset) => root.handlers.click({ target: { closest: value => value === selector ? { dataset } : null } })
const sources = ['yunfeng', 'danyang', 'lantian', 'qsxy', 'bksy', 'itc']
function seeded() {
  const store = createStore(null)
  for (const sourceId of sources) store.upsertNotice(`src-${sourceId}`, {
    id: `${sourceId}:1`, noticeId: `${sourceId}:1`, sourceId, title: `${sourceId} notice`, publishedAt: 1,
  }, { unread: true })
  const listRoot = pane(), detailRoot = pane(), host = { dataset: {} }
  listRoot.parentElement = host
  const rail = createRail({ store, listRoot, detailRoot, client: {} })
  return { store, rail, listRoot, detailRoot, host }
}
const visible = (state, options) => selectNotices(state, options).map(item => item.sourceId).sort()
const tick = () => new Promise(resolve => setImmediate(resolve))

test('academy selection hides other chips and list rows in recommended, all, and trash without deleting records', () => {
  const { store, rail, listRoot } = seeded()
  rail.render()
  for (const source of sources) assert.match(listRoot.innerHTML, new RegExp(`data-src="${source}"`))
  rail.setAcademy('danyang')
  for (const source of ['danyang', 'qsxy', 'bksy', 'itc']) {
    assert.match(listRoot.innerHTML, new RegExp(`data-src="${source}"`))
    assert.match(listRoot.innerHTML, new RegExp(`data-notice="${source}:1"`))
  }
  for (const source of ['yunfeng', 'lantian']) {
    assert.doesNotMatch(listRoot.innerHTML, new RegExp(`data-src="${source}"`))
    assert.doesNotMatch(listRoot.innerHTML, new RegExp(`data-notice="${source}:1"`))
  }
  assert.match(listRoot.innerHTML, /data-src=""[^>]*>全部<span class="badge">4<\/span>/)
  click(listRoot, '[data-rail="recommendation-mode"]', { mode: 'all' })
  assert.doesNotMatch(listRoot.innerHTML, /data-notice="yunfeng:1"/)
  store.trashNotice('yunfeng:1')
  store.trashNotice('danyang:1')
  rail.setTrash(true)
  assert.match(listRoot.innerHTML, /data-notice="danyang:1"/)
  assert.doesNotMatch(listRoot.innerHTML, /data-notice="yunfeng:1"/)
  assert.equal(Object.keys(store.state.notices).length, 6)
  rail.setAcademy('')
  assert.match(listRoot.innerHTML, /data-notice="yunfeng:1"/)
  rail.setTrash(false)
  assert.match(listRoot.innerHTML, /data-src="lantian"/)
  assert.match(listRoot.innerHTML, /data-notice="lantian:1"/)
})

test('changing academy clears a hidden active source and detail while public filters survive', () => {
  const { rail, listRoot, detailRoot, host } = seeded()
  rail.setFilter('yunfeng')
  rail.openNotice('yunfeng:1')
  assert.equal(rail.selected, 'yunfeng:1')
  rail.setAcademy('lantian')
  assert.equal(rail.filter, null)
  assert.equal(rail.selected, null)
  assert.equal(host.dataset.pane, 'list')
  assert.doesNotMatch(detailRoot.innerHTML, /yunfeng notice/)
  assert.match(listRoot.innerHTML, /data-src="" aria-pressed="true"/)
  rail.reveal('danyang:1')
  assert.equal(rail.filter, null)
  assert.equal(rail.selected, null)
  rail.openNotice('yunfeng:1')
  assert.equal(rail.selected, null)
  rail.setFilter('itc')
  rail.openNotice('itc:1')
  rail.setAcademy('danyang')
  assert.equal(rail.filter, 'itc')
  assert.equal(rail.selected, 'itc:1')
})

test('local visibility applies to starred manual keeps and counts but never changes the store or homework', () => {
  const { store } = seeded()
  store.setNoticeStarred('yunfeng:1', true)
  store.notice('yunfeng:1').recommendation = { override: 'keep', allowPush: true }
  const before = JSON.stringify(store.state)
  assert.deepEqual(visible(store.state, { academy: 'lantian', mode: 'all' }), ['bksy', 'itc', 'lantian', 'qsxy'])
  assert.deepEqual(visible(store.state, { academy: 'lantian' }), ['bksy', 'itc', 'lantian', 'qsxy'])
  assert.equal(noticeUnreadCount(store.state, null, 'lantian'), 4)
  assert.equal(noticeUnreadCount(store.state, 'yunfeng', 'lantian'), 0)
  assert.equal(noticeUnreadCount(store.state), 6)
  assert.deepEqual(noticeChannels(store.state, 'lantian').map(c => c.sourceId).sort(), ['bksy', 'itc', 'lantian', 'qsxy'])
  for (const source of ['qsxy', 'bksy', 'itc', 'xzzd']) assert.equal(academySourceVisible(source, 'lantian'), true)
  assert.equal(JSON.stringify(store.state), before)
})

test('startup profile, saved profile callback and clear all update the same live rail', async () => {
  const { rail, listRoot } = seeded()
  const selection = createAcademySelection({ client: { userProfile: async () => ({ version: 2, academy: 'lantian' }) }, onChange: rail.setAcademy })
  await selection.refresh()
  assert.equal(rail.academy, 'lantian')
  assert.doesNotMatch(listRoot.innerHTML, /data-src="yunfeng"/)
  await selection.refresh({ version: 3, academy: 'danyang' })
  assert.equal(rail.academy, 'danyang')
  assert.match(listRoot.innerHTML, /data-src="danyang"/)
  assert.doesNotMatch(listRoot.innerHTML, /data-src="lantian"/)
  await selection.refresh({ version: 4, academy: '' })
  for (const source of sources) assert.match(listRoot.innerHTML, new RegExp(`data-src="${source}"`))
})

test('late startup or older profile responses cannot undo a saved academy choice', async () => {
  const { rail } = seeded()
  let finish
  const selection = createAcademySelection({ client: { userProfile: () => new Promise(resolve => { finish = resolve }) }, onChange: rail.setAcademy })
  const initial = selection.refresh()
  await selection.refresh({ version: 3, academy: 'danyang' })
  finish({ version: 1, academy: '' })
  assert.equal(await initial, false)
  assert.equal(rail.academy, 'danyang')
  assert.equal(await selection.refresh({ version: 2, academy: 'yunfeng' }), false)
  assert.equal(rail.academy, 'danyang')
  const oldRefresh = selection.refresh()
  await selection.refresh({ version: 4, academy: '' })
  finish({ version: 3, academy: 'danyang' })
  await oldRefresh
  assert.equal(rail.academy, '')
  await tick()
})

test('the dock keeps the visible-source unread total after later store events', () => {
  const { store } = seeded(), root = pane()
  const dock = createIconRail({ root, store, academy: () => 'danyang' })
  dock.render()
  assert.match(root.innerHTML, /data-view="notice"[\s\S]*?<span class="badge">4<\/span>/)
  store.upsertNotice('src-yunfeng', { id: 'yunfeng:2', noticeId: 'yunfeng:2', sourceId: 'yunfeng', title: 'hidden new notice' }, { unread: true })
  assert.match(root.innerHTML, /data-view="notice"[\s\S]*?<span class="badge">4<\/span>/)
  store.markRead('src-danyang')
  assert.match(root.innerHTML, /data-view="notice"[\s\S]*?<span class="badge">3<\/span>/)
})
