// Drag-to-resize between the notice view and the chat column. One handle moves both,
// because the two share whatever width the dock leaves behind.

export const RAIL_W = 64
export const SPLIT_W = 6
export const CHAT_MIN = 300
export const CHAT_MAX = 640
export const NOTICE_MIN = 320
export const CHAT_DEFAULT = 380

// delta > 0 means the pointer moved right, which shrinks the chat column.
export function clampChatW(start, delta, avail = Number.POSITIVE_INFINITY) {
  const max = Math.max(CHAT_MIN, Math.min(CHAT_MAX, avail - RAIL_W - NOTICE_MIN - SPLIT_W))
  return Math.round(Math.min(max, Math.max(CHAT_MIN, start - delta)))
}

export function createSplitter({ handle, get, set }) {
  let dragging = false
  let startX = 0
  let startW = 0
  const root = globalThis.document?.documentElement

  const apply = px => set(Math.round(px))

  handle.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging = true
    startX = e.clientX
    startW = get()
    handle.setPointerCapture?.(e.pointerId)
    handle.dataset.dragging = '1'
    if (root) root.dataset.resizing = '1'
    e.preventDefault()
  })

  handle.addEventListener('pointermove', e => {
    if (!dragging) return
    apply(clampChatW(startW, e.clientX - startX, globalThis.innerWidth))
  })

  const stop = () => {
    if (!dragging) return
    dragging = false
    delete handle.dataset.dragging
    if (root) delete root.dataset.resizing
  }
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)

  handle.addEventListener('dblclick', () => apply(clampChatW(CHAT_DEFAULT, 0, globalThis.innerWidth)))

  // Keyboard parity: the handle is a focusable separator with arrow-key control.
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') apply(clampChatW(get(), -16, globalThis.innerWidth))
    else if (e.key === 'ArrowRight') apply(clampChatW(get(), 16, globalThis.innerWidth))
    else if (e.key === 'Home') apply(clampChatW(CHAT_DEFAULT, 0, globalThis.innerWidth))
    else return
    e.preventDefault()
  })

  return { apply }
}
