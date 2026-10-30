import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.document = globalThis.document ?? { addEventListener() {} }
const { academyPickerHTML, bindAcademyPicker } = await import('../web/js/ui/user-profile.js')

function pickerDocument(value = '') {
  function node(parent = null) {
    const attributes = new Map(), classes = new Set()
    return {
      parent, dataset: {}, listeners: {}, hidden: false, disabled: false,
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name) } },
      setAttribute(name, value) { attributes.set(name, value) }, getAttribute(name) { return attributes.get(name) }, removeAttribute(name) { attributes.delete(name) },
      addEventListener(name, fn) { this.listeners[name] = fn }, removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name] },
      contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false },
      matches() { return false }, focus() { owner.activeElement = this },
      closest(selector) { return selector === '[data-academy-option]' && 'academyOption' in this.dataset ? this : this.parent?.closest?.(selector) },
    }
  }
  const owner = node(), root = node(), trigger = node(root), input = { value }, menu = node(root)
  const name = node(trigger), note = node(trigger), mark = node(trigger)
  const options = ['', 'yunfeng', 'danyang', 'lantian'].map(value => {
    const option = node(menu)
    option.dataset.academyOption = value
    option.id = `up-academy-option-${value || 'all'}`
    return option
  })
  root.ownerDocument = owner
  root.querySelector = selector => ({ '[data-academy-trigger]': trigger, '[data-academy]': input, '[role="listbox"]': menu, '[data-academy-name]': name, '[data-academy-note]': note, '[data-academy-mark]': mark })[selector]
  root.querySelectorAll = () => options
  const mounted = bindAcademyPicker(root)
  const click = target => root.listeners.click({ target })
  const press = key => {
    const event = { key, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
    root.listeners.keydown(event)
    return event
  }
  return { root, owner, trigger, input, menu, name, note, options, mounted, click, press }
}

test('academy control renders a labelled combobox and four selected-state options', () => {
  const html = academyPickerHTML('danyang')
  assert.match(html, /type="hidden" data-academy value="danyang"/)
  assert.match(html, /id="up-academy"[^>]*role="combobox"[^>]*aria-controls="up-academy-menu"/)
  assert.match(html, /id="up-academy-menu" role="listbox"/)
  assert.equal((html.match(/role="option"/g) || []).length, 4)
  assert.match(html, /data-academy-option="danyang" aria-selected="true"/)
  assert.doesNotMatch(html, /<select|data-confirm="academy"/)
  assert.match(html, /选择「全部学园」可恢复其他学园消息/)
  assert.match(academyPickerHTML('unknown'), /type="hidden" data-academy value=""/)
})

test('pointer selection updates the draft, current label and check, then returns focus', () => {
  const p = pickerDocument()
  try {
    p.click(p.trigger)
    assert.equal(p.trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(p.menu.hidden, false)
    p.click(p.options[2])
    assert.equal(p.input.value, 'danyang')
    assert.equal(p.name.textContent, '丹阳青溪学园')
    assert.equal(p.note.textContent, '丹阳 · 青溪')
    assert.deepEqual(p.options.map(option => option.getAttribute('aria-selected')), ['false', 'false', 'true', 'false'])
    assert.equal(p.menu.hidden, true)
    assert.equal(p.trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(p.owner.activeElement, p.trigger)
  } finally { p.mounted.destroy() }
})

test('keyboard navigation commits with Enter or Space and Escape cancels the pending choice', () => {
  const p = pickerDocument('yunfeng')
  try {
    p.press('ArrowDown')
    assert.equal(p.trigger.getAttribute('aria-activedescendant'), p.options[1].id)
    p.press('ArrowDown')
    assert.equal(p.input.value, 'yunfeng')
    p.press('Escape')
    assert.equal(p.input.value, 'yunfeng')
    assert.equal(p.trigger.getAttribute('aria-activedescendant'), undefined)
    p.press('Enter'); p.press('End'); p.press('Enter')
    assert.equal(p.input.value, 'lantian')
    p.press(' '); p.press('Home'); p.press('ArrowDown'); p.press('ArrowDown'); p.press('ArrowUp'); p.press(' ')
    assert.equal(p.input.value, 'yunfeng')
    p.press('Enter')
    assert.equal(p.press('Tab').prevented, false)
    assert.equal(p.menu.hidden, true)
  } finally { p.mounted.destroy() }
})

test('outside pointer, focus leaving and view disposal close the menu without stealing focus', () => {
  const p = pickerDocument()
  p.click(p.trigger)
  p.owner.listeners.pointerdown({ target: {} })
  assert.equal(p.menu.hidden, true)
  assert.equal(p.owner.activeElement, undefined)
  p.click(p.trigger)
  p.root.listeners.focusout({ relatedTarget: p.options[1] })
  assert.equal(p.menu.hidden, false)
  p.root.listeners.focusout({ relatedTarget: null })
  assert.equal(p.menu.hidden, true)
  p.trigger.disabled = true
  p.click(p.trigger)
  assert.equal(p.menu.hidden, true)
  p.mounted.destroy()
  assert.deepEqual(p.root.listeners, {})
  assert.deepEqual(p.owner.listeners, {})
})
