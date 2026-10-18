import { icon } from './icons.js'
import { escapeHtml, plain } from './format.js'
import { NOTICE_DRAG_TYPE, parseDropPayload, isAttachable } from '../services/sources.js'
import { toast } from './overlays.js'

// The message box. Enter sends, Shift+Enter breaks a line, and IME composition (pinyin)
// never sends half a word. A notice dropped in from the notice view becomes an attachment:
// the chip names it, and its structured fields go to the model as context on send.
export function createComposer({ root, store, onSend, onPlus }) {
  let quoted = null
  let attached = null

  root.innerHTML = `<div class="composer">
  <div class="compose-slots" aria-live="polite"></div>
  <div class="compose-row">
    <button class="round ghost" data-cmp="plus" aria-label="更多">${icon('plus')}</button>
    <textarea rows="1" aria-label="消息"></textarea>
    <button class="round send" data-cmp="send" aria-label="发送">${icon('send')}</button>
  </div>
</div>`
  const box = root.querySelector('.composer')
  const area = root.querySelector('textarea')
  const send = root.querySelector('[data-cmp="send"]')
  const slots = root.querySelector('.compose-slots')

  const fit = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 176)}px` }
  const sync = () => send.classList.toggle('ready', area.value.trim().length > 0)

  function renderSlots() {
    slots.innerHTML = [
      quoted ? `<div class="compose-quote">${icon('reply', 14)}<span>${escapeHtml(plain(quoted.text, store.state.profile))}</span><button class="tool" data-cmp="unquote" aria-label="取消引用">${icon('close', 14)}</button></div>` : '',
      attached ? `<div class="compose-quote compose-attach">${icon('attach', 14)}<span><strong>通知附件</strong> · ${escapeHtml(store.notice(attached)?.title ?? '通知')}</span><button class="tool" data-cmp="detach" aria-label="移除通知附件">${icon('close', 14)}</button></div>` : '',
    ].join('')
  }

  function submit() {
    const text = area.value.trim()
    if (!text) return
    onSend(text, { quoteId: quoted?.id ?? null, noticeId: attached })
    area.value = ''
    quoted = null
    attached = null
    renderSlots()
    fit(); sync()
  }

  function setQuote(message) {
    quoted = message ?? null
    renderSlots()
    if (message) area.focus()
  }

  function attachNotice(noticeId) {
    const n = store.notice(noticeId)
    if (!n) { toast('这条通知已经不在本机缓存里，无法引用。'); return false }
    if (!isAttachable(n)) { toast('这条通知的正文还没采集完整，暂时不能引用。'); return false }
    attached = noticeId
    renderSlots()
    area.focus({ preventScroll: true })
    return true
  }

  function detachNotice() {
    attached = null
    renderSlots()
  }

  const hasNotice = data => [...(data?.types ?? [])].includes(NOTICE_DRAG_TYPE)
  const hasFiles = data => [...(data?.types ?? [])].includes('Files')
  const dropZone = root.closest?.('.chat') ?? box
  dropZone.addEventListener('dragover', e => {
    if (hasFiles(e.dataTransfer)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
      delete dropZone.dataset.drop
      return
    }
    if (!hasNotice(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    dropZone.dataset.drop = '1'
  })
  dropZone.addEventListener('dragleave', e => {
    if (!dropZone.contains?.(e.relatedTarget)) delete dropZone.dataset.drop
  })
  dropZone.addEventListener('drop', e => {
    delete dropZone.dataset.drop
    if (hasFiles(e.dataTransfer)) {
      e.preventDefault()
      toast('对话暂不支持本地文件，通知可以从左侧拖入。')
      return
    }
    const payload = parseDropPayload(e.dataTransfer?.getData(NOTICE_DRAG_TYPE))
    if (!payload) return
    e.preventDefault()
    attachNotice(payload.noticeId)
  })

  area.addEventListener('input', () => { fit(); sync() })
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit() }
  })
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-cmp]')
    if (!btn) return
    if (btn.dataset.cmp === 'send') submit()
    if (btn.dataset.cmp === 'unquote') setQuote(null)
    if (btn.dataset.cmp === 'detach') detachNotice()
    if (btn.dataset.cmp === 'plus') onPlus(btn)
  })

  return {
    setQuote, attachNotice, detachNotice,
    get attached() { return attached },
    focus: () => area.focus({ preventScroll: true }),
    setPlaceholder: text => { area.placeholder = text },
  }
}
