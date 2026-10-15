import { botFace } from './team.js'
import { popover, closeOverlay } from './overlays.js'
import { icon } from './icons.js'
import { escapeHtml, plain } from './format.js'

// The message box. Enter sends, Shift+Enter breaks a line, and IME composition (pinyin)
// never sends half a word.
export function createComposer({ root, store, onSend, onPlus }) {
  let quote = null
  let channelId = 'bot'

  root.innerHTML = `<div class="composer">
  <div class="compose-quote-slot"></div>
  <div class="compose-row">
    <button class="round ghost" data-cmp="plus" aria-label="更多">${icon('plus')}</button>
    <button class="round ghost" data-cmp="mention" aria-label="选择要 @ 的伙伴">@</button>
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
    if (btn.dataset.cmp === 'mention') {
      const ids = store.channel(channelId)?.memberIds || ['chief']
      const bots = ids.map(id => store.bot(id)).filter(Boolean)
      const pop = popover(btn, `<div class="pop-title">让谁回应？</div>${bots.map(bot => `<button class="mi" data-mention="${escapeHtml(bot.id)}">${botFace(store, bot, 28)}${escapeHtml(store.botAppearance(bot).name)}</button>`).join('') || '<p class="note">暂时没有可选择的成员，请等待本机服务同步。</p>'}`, { place: 'above' })
      pop.addEventListener('click', event => {
        const target = event.target.closest('[data-mention]')
        if (!target) return
        const bot = store.bot(target.dataset.mention)
        if (!bot) return
        const at = area.selectionStart
        const before = area.value.slice(0, at)
        const name = store.botAppearance(bot).name
        const ambiguous = store.state.bots.some(row => row.id !== bot.id && (row.name === name || store.botAppearance(row).name === name))
        const token = ambiguous || /[「」]/.test(name) ? bot.id : `「${name}」`
        const text = `${before && !/\s$/.test(before) ? ' ' : ''}@${token} `
        area.setRangeText(text, at, area.selectionEnd, 'end')
        closeOverlay(); area.focus(); fit(); sync()
      })
    }
  })

  return {
    setQuote,
    setChannel: id => { channelId = id },
    focus: () => area.focus({ preventScroll: true }),
    setPlaceholder: text => { area.placeholder = text },
  }
}
