import { LOOKS, hasLook } from './looks.js'
import { escapeHtml } from '../ui/format.js'

// The mark is the bot's face. One component everywhere: sidebar card, header pill,
// transcript, settings. What it is doing picks the motion:
//   idle      breathes and blinks (only when `live`)
//   thinking  tilts and looks up while a reply is on its way
//   alert     hops and flaps once when something new arrives
//   happy     leans into the pointer with closed eyes (petting)
// `live: false` keeps it perfectly still, which is what older transcript rows use.

export const STATES = ['idle', 'thinking', 'alert', 'happy']
const ONE_SHOT = { alert: 1300, poke: 800 }

export function markHTML({ look = 'placeholder', image = null, size = 36, state = 'idle', live = false, gaze = false, poke = false, label = '' } = {}) {
  const art = image
    ? `<img class="mk-img" src="${escapeHtml(image)}" alt="" draggable="false">`
    : `<svg class="mk-svg" viewBox="0 0 100 100" aria-hidden="true">${LOOKS[hasLook(look) ? look : 'placeholder'].svg()}</svg>`
  const delay = (Math.random() * -5).toFixed(2)
  return `<span class="mk" style="--mk-size:${Number(size)}px;--mk-blink-delay:${delay}s" data-state="${escapeHtml(state)}"${live ? ' data-live' : ''}${gaze ? ' data-gaze' : ''}${poke ? ' data-poke' : ''}${image ? ' data-image' : ''} role="img" aria-label="${escapeHtml(label)}">${art}</span>`
}

// Swap the motion of a mark already on the page. One-shot states fall back to idle.
export function setMarkState(node, state) {
  if (!node) return
  clearTimeout(node._mkTimer)
  node.dataset.state = 'idle'
  void node.offsetWidth // restart the animation if the same one-shot repeats
  node.dataset.state = state
  if (ONE_SHOT[state]) node._mkTimer = setTimeout(() => { node.dataset.state = 'idle' }, ONE_SHOT[state])
}

// Eyes follow the pointer on marks that opt in with data-gaze (the large ones).
let gazeStarted = false
export function startGaze(root = document) {
  if (gazeStarted) return
  gazeStarted = true
  let point = null
  let frame = 0
  const clamp = v => Math.max(-1, Math.min(1, v))
  const place = () => {
    frame = 0
    for (const node of root.querySelectorAll('.mk[data-gaze]')) {
      if (!point) { node.style.setProperty('--gx', 0); node.style.setProperty('--gy', 0); continue }
      const box = node.getBoundingClientRect()
      if (!box.width) continue
      node.style.setProperty('--gx', clamp((point.x - box.left - box.width / 2) / 240).toFixed(3))
      node.style.setProperty('--gy', clamp((point.y - box.top - box.height / 2) / 240).toFixed(3))
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
  window.addEventListener('pointermove', e => { point = { x: e.clientX, y: e.clientY }; schedule() }, { passive: true })
  document.documentElement.addEventListener('pointerleave', () => { point = null; schedule() })

  // Petting: hovering a pokeable mark makes it lean in, a click makes it spin.
  root.addEventListener('pointerover', e => {
    const node = e.target.closest?.('.mk[data-poke]')
    if (node && node.dataset.state === 'idle') node.dataset.state = 'happy'
  })
  root.addEventListener('pointerout', e => {
    const node = e.target.closest?.('.mk[data-poke]')
    if (node && !node.contains(e.relatedTarget) && node.dataset.state === 'happy') node.dataset.state = 'idle'
  })
  root.addEventListener('click', e => {
    const node = e.target.closest?.('.mk[data-poke]')
    if (!node) return
    node.classList.remove('mk-poke')
    void node.offsetWidth
    node.classList.add('mk-poke')
    setTimeout(() => node.classList.remove('mk-poke'), ONE_SHOT.poke)
  })
}
