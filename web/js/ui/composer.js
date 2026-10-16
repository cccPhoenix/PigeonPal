import { icon } from './icons.js'
import { escapeHtml, plain } from './format.js'

// The message box. Enter sends, Shift+Enter breaks a line, and IME composition (pinyin)
// never sends half a word.
export function createComposer({ root, store, onSend, onPlus }) {
  let quote = null

  root.innerHTML = `<div class="composer">
  <div class="compose-quote-slot"></div>
  <div class="compose-row">
    <button class="round ghost" data-cmp="plus" aria-label="更多">${icon('plus')}</button>
    <textarea rows="1" aria-label="消息"></textarea>
    <button class="round send" data-cmp="send" aria-label="发送">${icon('send')}</button>
  </div>
</div>`
  const area = root.querySelector('textarea')
  const send = root.querySelector('[data-cmp="send"]')
  const slot = root.querySelector('.compose-quote-slot')

  const fit = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 176)}px` }
  const sync = () => send.classList.toggle('ready', area.value.trim().length > 0)

  function submit() {
    const text = area.value.trim()
    if (!text) return
    onSend(text, quote)
    area.value = ''
    setQuote(null)
    fit(); sync()
  }

  function setQuote(message) {
    quote = message?.id ?? null
    slot.innerHTML = message ? `<div class="compose-quote">${icon('reply', 14)}<span>${escapeHtml(plain(message.text, store.state.profile))}</span><button class="tool" data-cmp="unquote" aria-label="取消引用">${icon('close', 14)}</button></div>` : ''
    if (message) area.focus()
  }

  area.addEventListener('input', () => { fit(); sync() })
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit() }
  })
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-cmp]')
    if (!btn) return
    if (btn.dataset.cmp === 'send') submit()
    if (btn.dataset.cmp === 'unquote') setQuote(null)
    if (btn.dataset.cmp === 'plus') onPlus(btn)
  })

  return {
    setQuote,
    focus: () => area.focus({ preventScroll: true }),
    setPlaceholder: text => { area.placeholder = text },
  }
}
