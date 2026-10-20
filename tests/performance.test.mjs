import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../web/js/store.js'

globalThis.document = { addEventListener() {} }
const { createIconRail } = await import('../web/js/ui/dock.js')

// Keep stable button objects, as a real DOM does until innerHTML replaces them.
function railDOM() {
  let writes = 0
  const buttons = new Map()
  return {
    get writes() { return writes },
    set innerHTML(html) {
      writes++
      buttons.clear()
      for (const [, view] of html.matchAll(/data-view="([^"]+)"/g)) {
        const attrs = new Map()
        const button = { dataset: { view }, badge: null,
          setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
          getAttribute: key => attrs.get(key),
          insertAdjacentHTML(_where, value) {
            this.badge = { textContent: value.match(/>([^<]+)</)[1], remove: () => { this.badge = null } }
          },
        }
        buttons.set(view, button)
      }
    },
    addEventListener() {},
    querySelector(selector) {
      const button = buttons.get(selector.match(/data-view="([^"]+)"/)?.[1])
      return selector.endsWith(' .badge') ? button?.badge : button
    },
    querySelectorAll() { return [...buttons.values()] },
  }
}

test('badge polling and view switching preserve sidebar identity and animation', () => {
  const root = railDOM(), dock = createIconRail({ root, store: createStore(null) })
  dock.render()
  const companion = root.querySelector('[data-view="chat"]')
  for (let i = 0; i < 100; i++) {
    dock.setUnread(0)
    dock.setChatUnread(0)
    dock.setHomeworkUnread(0)
  }
  assert.equal(root.writes, 1, 'polls must not replace the whole sidebar')
  dock.setUnread(3)
  dock.setHomeworkUnread(1)
  dock.setView('calendar')
  assert.equal(root.writes, 1, 'badge changes and navigation must preserve the companion')
  assert.equal(root.querySelector('[data-view="chat"]'), companion)
  assert.equal(root.querySelector('[data-view="calendar"]').getAttribute('aria-current'), 'page')
  assert.equal(root.querySelector('[data-view="notice"] .badge').textContent, '3')
  assert.equal(root.querySelector('[data-view="chat"] .badge'), null)
})

const settle = () => new Promise(resolve => setTimeout(resolve, 260))
test('unchanged runtime polls do not rewrite the entire local history', async () => {
  const writes = []
  const store = createStore({ getItem: () => null, setItem: (_key, value) => writes.push(JSON.parse(value)) })
  const row = { id: 'rem-perf', title: '提醒', dueAt: 1900000000000, status: 'pending', updatedAt: 1 }
  store.syncReminders([row])
  store.setEventCursor(4)
  await settle()
  assert.equal(writes.length, 1)
  store.syncReminders([row])
  store.setEventCursor(4)
  await settle()
  assert.equal(writes.length, 1, 'idle poll must not serialize/write local history')
  store.syncReminders([{ ...row, status: 'done', updatedAt: 2 }])
  store.setEventCursor(5)
  await settle()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].reminders[0].status, 'done')
  assert.equal(writes[1].eventCursor, 5)
})
