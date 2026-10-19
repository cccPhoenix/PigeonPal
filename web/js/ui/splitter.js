// Drag-to-resize between the notice view and the chat column. One handle moves both,
// because the two share whatever width the dock leaves behind.

export const RAIL_W = 64
export const SPLIT_W = 6
export const CHAT_MIN = 300
export const CHAT_MAX = 1200
export const NOTICE_MIN = 240
export const CALENDAR_MIN = 700
export const CHAT_DEFAULT = 380
export const NOTICE_STACK_AT = 640

// delta > 0 means the pointer moved right, which shrinks the chat column.
export function clampChatW(start, delta, avail = Number.POSITIVE_INFINITY, noticeMin = NOTICE_MIN) {
  const max = Math.max(CHAT_MIN, Math.min(CHAT_MAX, avail - RAIL_W - noticeMin - SPLIT_W))
  return Math.round(Math.min(max, Math.max(CHAT_MIN, start - delta)))
}

export function watchNoticeWidth(host, Observer = globalThis.ResizeObserver) {
  let compact = null
  const update = width => {
    const next = width < NOTICE_STACK_AT
    if (next === compact) return
    const changed = compact !== null
    compact = next
    if (next) host.dataset.compact = '1'
    else delete host.dataset.compact
    if (changed) {
      host.dataset.layoutMotion = next ? 'stack' : 'split'
    }
  }
  update(host.getBoundingClientRect().width)
  if (!Observer) return { disconnect() {} }
  const observer = new Observer(entries => {
    for (const entry of entries) if (entry.target === host) update(entry.contentRect.width)
  })
  observer.observe(host)
  return observer
}

export function createSplitter({ handle, get, set, getNoticeMin = () => NOTICE_MIN }) {
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
    apply(clampChatW(startW, e.clientX - startX, globalThis.innerWidth, getNoticeMin()))
  })

  const stop = () => {
    if (!dragging) return
    dragging = false
    delete handle.dataset.dragging
    if (root) delete root.dataset.resizing
  }
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)

  handle.addEventListener('dblclick', () => apply(clampChatW(CHAT_DEFAULT, 0, globalThis.innerWidth, getNoticeMin())))

  // Keyboard parity: the handle is a focusable separator with arrow-key control.
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') apply(clampChatW(get(), -16, globalThis.innerWidth, getNoticeMin()))
    else if (e.key === 'ArrowRight') apply(clampChatW(get(), 16, globalThis.innerWidth, getNoticeMin()))
    else if (e.key === 'Home') apply(clampChatW(CHAT_DEFAULT, 0, globalThis.innerWidth, getNoticeMin()))
    else return
    e.preventDefault()
  })

  return { apply }
}
