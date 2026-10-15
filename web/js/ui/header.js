import { markHTML } from '../mark/index.js'
import { botFace } from './team.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'

// The centred pill at the top: who you are talking to. Clicking it opens their card.
export function createHeader({ root, store, onWho, onToggleSide, onMembers }) {
  function render(channelId, { animate = true } = {}) {
    const p = store.state.profile
    const c = store.channel(channelId)
    if (!c) return
    const bot = c.kind === 'dm' ? store.bot(c.botId) : null
    const face = bot ? `${botFace(store, bot, 30)}<span>${escapeHtml(store.botAppearance(bot).name)}</span>` : c.kind === 'bot'
      ? `${markHTML({ look: p.look, image: p.look === 'image' ? p.image : null, label: p.botName, size: 30, live: true })}<span>${escapeHtml(p.botName)}</span>`
      : `<span class="ch-icon" style="--tint:${escapeHtml(c.tint || '#eef0f4')}" aria-hidden="true">${escapeHtml(c.emoji || '💬')}</span><span>${escapeHtml(c.title)}</span>`
    root.innerHTML = `<button class="icon-btn flat side-toggle" data-head="side" aria-label="打开侧栏">${icon('sidebar')}</button>
<button class="who${animate ? ' swap' : ''}" data-head="who" aria-haspopup="dialog">${face}</button>${c.kind !== 'dm' ? `<button class="channel-members" data-head="members" aria-label="管理频道成员" aria-haspopup="dialog">${(c.memberIds || ['chief']).map(id => store.bot(id)).filter(Boolean).slice(0, 5).map(bot => botFace(store, bot, 24)).join('')}<span>成员</span></button>` : ''}`
  }

  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-head]')
    if (btn?.dataset.head === 'members') onMembers?.(btn)
    if (btn?.dataset.head === 'who') onWho(btn)
    if (btn?.dataset.head === 'side') onToggleSide()
  })

  return { render, mark: () => root.querySelector('.who .mk') }
}
