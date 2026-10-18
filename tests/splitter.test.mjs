import test from 'node:test'
import assert from 'node:assert/strict'
import { clampChatW, CHAT_MIN, CHAT_MAX, NOTICE_MIN, RAIL_W, SPLIT_W } from '../web/js/ui/splitter.js'

test('the chat column stays inside its own bounds however far the handle is dragged', () => {
  assert.equal(clampChatW(380, 0, 1440), 380)
  assert.equal(clampChatW(380, -2000, 1440), CHAT_MAX)
  assert.equal(clampChatW(380, 5000, 1440), CHAT_MIN)
})

test('the notice view is never squeezed below its minimum width', () => {
  const tightest = RAIL_W + NOTICE_MIN + SPLIT_W + CHAT_MIN
  assert.equal(clampChatW(380, 0, tightest), CHAT_MIN)
  assert.ok(clampChatW(380, 0, tightest) <= tightest - RAIL_W - NOTICE_MIN - SPLIT_W)
  assert.ok(clampChatW(380, -100, 1100) <= 1100 - RAIL_W - NOTICE_MIN - SPLIT_W)
})
