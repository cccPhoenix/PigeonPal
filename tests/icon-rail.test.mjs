import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../web/js/store.js'

// dock.js pulls in the mark component, which binds listeners on import.
globalThis.document = { addEventListener() {} }
const { createIconRail } = await import('../web/js/ui/dock.js')

const build = store => {
  const root = { innerHTML: '', addEventListener() {} }
  const seen = []
  const dock = createIconRail({
    root, store,
    onView: v => seen.push(v), onBot: () => seen.push('chat'), onMe: () => {}, onAddSource: () => {}, onSearch: () => {},
  })
  dock.render()
  return { root, dock, seen }
}

test('the icon rail carries the companion, both views and a hover label each', () => {
  const { root, dock } = build(createStore(null))
  assert.match(root.innerHTML, /data-view="chat"/)
  assert.match(root.innerHTML, /class="rail-lbl">通知</)
  assert.match(root.innerHTML, /class="rail-lbl">日历</)
  assert.match(root.innerHTML, /data-gaze/)
  assert.match(root.innerHTML, /aria-current="page"/)
  assert.equal(dock.view, 'notice')
})

test('switching views moves the current marker, and the badge updates without a re-render of the mark', () => {
  const { root, dock } = build(createStore(null))
  dock.setView('calendar')
  assert.equal(dock.view, 'calendar')
  assert.match(root.innerHTML, /data-view="calendar"[^>]*aria-current="page"/)
  dock.setUnread(3)
  assert.match(root.innerHTML, /<span class="badge">3<\/span>/)
  dock.setUnread(0)
  assert.doesNotMatch(root.innerHTML, /<span class="badge">/)
})
