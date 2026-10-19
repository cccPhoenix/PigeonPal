import test from 'node:test'
import assert from 'node:assert/strict'
import { clampChatW, watchNoticeWidth, CHAT_MIN, CHAT_MAX, NOTICE_MIN, CALENDAR_MIN, NOTICE_STACK_AT, RAIL_W, SPLIT_W } from '../web/js/ui/splitter.js'
import { hydrate, createInitialState } from '../web/js/store.js'

test('the chat column stays inside its own bounds however far the handle is dragged', () => {
  assert.equal(clampChatW(380, 0, 1440), 380)
  assert.equal(clampChatW(380, -2000, 1440), 1440 - RAIL_W - NOTICE_MIN - SPLIT_W)
  assert.equal(clampChatW(380, -2000, 1920), CHAT_MAX)
  assert.equal(clampChatW(380, 5000, 1440), CHAT_MIN)
})

test('the notice view is never squeezed below its minimum width', () => {
  const tightest = RAIL_W + NOTICE_MIN + SPLIT_W + CHAT_MIN
  assert.equal(clampChatW(380, 0, tightest), CHAT_MIN)
  assert.ok(clampChatW(380, 0, tightest) <= tightest - RAIL_W - NOTICE_MIN - SPLIT_W)
  assert.ok(clampChatW(380, -100, 1100) <= 1100 - RAIL_W - NOTICE_MIN - SPLIT_W)
})

test('calendar view keeps room for all seven day columns when the divider is dragged', () => {
  const available = 1100
  const chat = clampChatW(380, -2000, available, CALENDAR_MIN)
  assert.equal(chat, available - RAIL_W - CALENDAR_MIN - SPLIT_W)
  assert.equal(available - RAIL_W - SPLIT_W - chat, CALENDAR_MIN)
})

test('a dragged narrow notice column switches its detail into a second page', () => {
  let publish
  class FakeObserver {
    constructor(callback) { publish = callback }
    observe(node) { assert.equal(node, host) }
  }
  const host = { dataset: {}, getBoundingClientRect: () => ({ width: NOTICE_STACK_AT + 20 }) }
  watchNoticeWidth(host, FakeObserver)
  assert.equal(host.dataset.compact, undefined)
  publish([{ target: host, contentRect: { width: NOTICE_STACK_AT - 1 } }])
  assert.equal(host.dataset.compact, '1')
  assert.equal(host.dataset.layoutMotion, 'stack')
  publish([{ target: host, contentRect: { width: NOTICE_STACK_AT + 1 } }])
  assert.equal(host.dataset.compact, undefined)
  assert.equal(host.dataset.layoutMotion, 'split')
})

test('a wider chat setting survives a reload', () => {
  const state = createInitialState()
  state.profile.chatW = 900
  assert.equal(hydrate(state).profile.chatW, 900)
})
