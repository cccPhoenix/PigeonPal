import { markHTML } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'

// The centred pill at the top of the chat column. At narrow widths the column is a
// drawer, so it carries its own close button; opening it lives on the icon dock.
export function createHeader({ root, store, onWho, onCloseChat }) {
  function render(channelId, { animate = true } = {}) {
    const p = store.state.profile
    const c = store.channel(channelId)
    const face = c.kind === 'bot'
      ? `${markHTML({ look: p.look, image: p.look === 'image' ? p.image : null, label: p.botName, size: 30, live: true })}<span>${escapeHtml(p.botName)}</span>`
      : `<span class="ch-icon" style="--tint:${escapeHtml(c.tint)}" aria-hidden="true">${escapeHtml(c.emoji)}</span><span>${escapeHtml(c.title)}</span>`
    root.innerHTML = `<button class="who${animate ? ' swap' : ''}" data-head="who" aria-haspopup="dialog">${face}</button>
<button class="icon-btn flat chat-close" data-head="chat-close" aria-label="收起对话">${icon('close')}</button>`
  }

  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-head]')
    if (btn?.dataset.head === 'who') onWho(btn)
    if (btn?.dataset.head === 'chat-close') onCloseChat()
  })

  return { render, mark: () => root.querySelector('.who .mk') }
}
