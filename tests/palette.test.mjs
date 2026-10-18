import test from 'node:test'
import assert from 'node:assert/strict'
import { lookHue, dominantHue } from '../web/js/ui/palette.js'

test('different companion looks select distinct accent hues', () => {
  assert.notEqual(lookHue('character0'), lookHue('character1'))
  assert.notEqual(lookHue('character1'), lookHue('character7'))
  assert.equal(lookHue('unknown'), lookHue('placeholder'))
})

test('uploaded art uses visible saturated pixels and ignores transparent or gray pixels', () => {
  assert.equal(dominantHue(new Uint8ClampedArray([255, 0, 0, 255])), 0)
  assert.equal(dominantHue(new Uint8ClampedArray([0, 0, 255, 255])), 240)
  assert.equal(dominantHue(new Uint8ClampedArray([255, 0, 0, 0, 128, 128, 128, 255])), null)
})
