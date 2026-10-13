// Popovers, sheets, small dialogs and the toast. One overlay at a time; Escape or a
// click outside closes it, and focus returns to whatever opened it.

const layer = () => document.getElementById('layer')
let current = null

export function closeOverlay() {
  if (!current) return
  const { nodes, opener, onClose } = current
  current = null
  for (const node of nodes) { node.classList.add('leave'); setTimeout(() => node.remove(), 170) }
  onClose?.()
  opener?.focus?.({ preventScroll: true })
}

function open(nodes, { opener, onClose } = {}) {
  closeOverlay()
  for (const node of nodes) layer().append(node)
  current = { nodes, opener, onClose }
  const focusable = nodes.at(-1).querySelector('input, textarea, button:not(.sheet-close), [tabindex]')
  setTimeout(() => focusable?.focus({ preventScroll: true }), 30)
}

const el = (cls, html, tag = 'div') => { const n = document.createElement(tag); n.className = cls; n.innerHTML = html; return n }

// A floating panel under (or above) an anchor element.
export function popover(anchor, html, { className = '', place = 'below', onClose } = {}) {
  const pop = el(`pop ${className}`, html)
  pop.setAttribute('role', 'dialog')
  open([pop], { opener: anchor, onClose })
  const a = anchor.getBoundingClientRect()
  const p = pop.getBoundingClientRect()
  const left = Math.max(12, Math.min(window.innerWidth - p.width - 12, place === 'right' ? a.left : a.left + a.width / 2 - p.width / 2))
  const top = place === 'above' ? a.top - p.height - 8 : place === 'right' ? a.top : a.bottom + 8
  pop.style.left = `${left}px`
  pop.style.top = `${Math.max(12, Math.min(window.innerHeight - p.height - 12, top))}px`
  if (place === 'above') pop.style.transformOrigin = 'bottom center'
  return pop
}

export function sheet(html, { opener, onClose } = {}) {
  const scrim = el('scrim', '')
  const box = el('sheet', html)
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  scrim.addEventListener('click', closeOverlay)
  open([scrim, box], { opener, onClose })
  return box
}

export function dialog(html, { opener, onClose } = {}) {
  const scrim = el('scrim', '')
  const box = el('dialog', html)
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  scrim.addEventListener('click', closeOverlay)
  open([scrim, box], { opener, onClose })
  return box
}

export const overlayOpen = () => Boolean(current)
export const overlayFor = anchor => Boolean(current && current.opener === anchor)

document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) { e.preventDefault(); closeOverlay() } })
document.addEventListener('pointerdown', e => {
  if (!current) return
  const pop = current.nodes.find(n => n.classList.contains('pop'))
  if (pop && !pop.contains(e.target) && !current.opener?.contains(e.target)) closeOverlay()
}, true)

let toastTimer = 0
export function toast(text) {
  const node = document.getElementById('toast')
  node.textContent = text
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800)
}
