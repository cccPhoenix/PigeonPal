import { markHTML } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'

// The centred pill at the top: who you are talking to. Clicking it opens their card.
export function createHeader({ root, store, onWho, onToggleSide }) {
  function render(channelId, { animate = true } = {}) {
    const p = store.state.profile
    const c = store.channel(channelId)
    const face = c.kind === 'bot'
      ? `${markHTML({ look: p.look, image: p.look === 'image' ? p.image : null, label: p.botName, size: 30, live: true })}<span>${escapeHtml(p.botName)}</span>`
      : `<span class="ch-icon" style="--tint:${escapeHtml(c.tint)}" aria-hidden="true">${escapeHtml(c.emoji)}</span><span>${escapeHtml(c.title)}</span>`
    root.innerHTML = `<button class="icon-btn flat side-toggle" data-head="side" aria-label="打开侧栏">${icon('sidebar')}</button>
<button class="who${animate ? ' swap' : ''}" data-head="who" aria-haspopup="dialog">${face}</button>`
  }

  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-head]')
    if (btn?.dataset.head === 'who') onWho(btn)
    if (btn?.dataset.head === 'side') onToggleSide()
  })

  return { render, mark: () => root.querySelector('.who .mk') }
}
