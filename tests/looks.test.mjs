import test from 'node:test'
import assert from 'node:assert/strict'
import { LOOKS, LOOK_IDS } from '../web/js/mark/looks.js'
import { createInitialState, hydrate } from '../web/js/store.js'
import { markHTML } from '../web/js/mark/index.js'

// Every delivered reference must remain selectable after reopening the app.
test('all ten reference characters are registered and survive storage hydration', () => {
  for (let n = 0; n < 10; n++) {
    const id = `character${n}`
    assert.ok(LOOK_IDS.includes(id), `missing ${id}`)
    const state = createInitialState()
    state.profile.look = id
    assert.equal(hydrate(JSON.stringify(state)).profile.look, id)
  }
  assert.equal(new Set(LOOK_IDS).size, LOOK_IDS.length)
})

test('reference avatars expose independently animated parts without shared SVG ids', () => {
  for (let n = 0; n < 10; n++) {
    const id = `character${n}`
    const svg = LOOKS[id]?.svg()
    assert.equal(typeof svg, 'string', id)
    for (const part of ['mk-body', 'mk-eyes', 'mk-eye', 'mk-happy', 'mk-wing-l', 'mk-shadow']) {
      assert.ok(svg.includes(`class="${part}"`), `${id}: ${part}`)
    }
    assert.doesNotMatch(svg, /\bid\s*=/)
    assert.doesNotMatch(svg, /<image|<script|<foreignObject/i)
    const html = markHTML({ look: id, live: true, state: 'thinking', label: LOOKS[id].label })
    assert.ok(html.includes('data-state="thinking"'))
    assert.ok(html.includes(svg))
  }
})

test('gaze has a separate pupil layer in every built-in look', () => {
  for (const id of LOOK_IDS) {
    const svg = LOOKS[id].svg()
    assert.match(svg, /class="mk-pupils"/, `${id} needs a pupil-only gaze layer`)
    for (const group of svg.matchAll(/<g class="mk-pupils"[^>]*>([\s\S]*?)<\/g>/g)) {
      assert.doesNotMatch(group[1], /fill="#fffdf7"/, `${id}: eye whites must stay outside the moving layer`)
    }
  }
})
