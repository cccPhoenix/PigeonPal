import { markHTML } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml, plain, shortTime } from './format.js'

// Sidebar, after DS Bot: brand row, the bot's card (your 1:1 chat), one row per source
// channel, and two buttons at the foot. Rows update in place so nothing jumps.
export function createSidebar({ root, store, onSelect, onMe, onAddSource, onSearch }) {
  let active = 'bot'

  const look = () => { const p = store.state.profile; return { look: p.look, image: p.look === 'image' ? p.image : null, label: p.botName } }

  function preview(channelId) {
    const last = store.lastMessage(channelId)
    if (!last) return { text: channelId === 'bot' ? '' : '暂时没有新消息', time: '' }
    const text = plain(last.kind === 'notice' && last.item?.title ? `${last.text.split('\n')[0]}` : last.text, store.state.profile)
    return { text: last.role === 'user' ? `你：${text}` : text, time: shortTime(last.at) }
  }

  const badge = id => (store.state.unread[id] ? `<span class="badge">${store.state.unread[id] > 99 ? '99+' : store.state.unread[id]}</span>` : '')

  function rowHTML(c) {
    const p = preview(c.id)
    return `<button class="ch" data-ch="${escapeHtml(c.id)}" aria-current="${c.id === active}">
  <span class="ch-icon" style="--tint:${escapeHtml(c.tint ?? '#eef0f4')}" aria-hidden="true">${escapeHtml(c.emoji ?? '🔔')}</span>
  <span class="ch-text">
    <span class="ch-line"><span class="ch-title">${escapeHtml(c.title)}</span><span class="ch-time">${escapeHtml(p.time)}</span></span>
    <span class="ch-line"><span class="ch-preview">${escapeHtml(p.text)}</span>${badge(c.id)}</span>
  </span>
</button>`
  }

  function render() {
    const p = store.state.profile
    const nick = (p.nickname || '我').slice(0, 1)
    root.innerHTML = `
<div class="side-top">
  <div class="brand"><img class="brand-icon" src="./assets/icon.png" width="32" height="32" alt="" draggable="false"><span>PigeonPal</span></div>
  <button class="icon-btn" data-side="search" aria-label="搜索消息">${icon('search')}</button>
</div>
<button class="bot-card" data-ch="bot" aria-current="${active === 'bot'}" aria-label="和${escapeHtml(p.botName)}聊天">
  ${markHTML({ ...look(), size: 68, live: true, gaze: true, poke: true })}
  <span class="bot-name">${escapeHtml(p.botName)}</span>
  <span class="bot-tag">校园伙伴</span>
  ${badge('bot')}
</button>
<nav class="rows" aria-label="信息频道">${store.state.channels.filter(c => c.kind === 'source').map(rowHTML).join('')}</nav>
<div class="side-foot">
  <button class="me" data-side="me" aria-label="我的设置">${escapeHtml(nick)}</button>
  <button class="add-src" data-side="add">${icon('plus', 16)}添加信息来源</button>
</div>`
  }

  function update(channelId) {
    if (channelId === 'bot') {
      const card = root.querySelector('.bot-card')
      card.querySelector('.badge')?.remove()
      if (store.state.unread.bot) card.insertAdjacentHTML('beforeend', badge('bot'))
      return
    }
    const row = root.querySelector(`.ch[data-ch="${CSS.escape(channelId)}"]`)
    const c = store.channel(channelId)
    if (!row || !c) return
    const t = document.createElement('template')
    t.innerHTML = rowHTML(c).trim()
    row.replaceWith(t.content)
  }

  function setActive(id) {
    active = id
    for (const node of root.querySelectorAll('[data-ch]')) node.setAttribute('aria-current', String(node.dataset.ch === id))
  }

  function bump(id) {
    const row = root.querySelector(`.ch[data-ch="${CSS.escape(id)}"]`)
    if (!row) return
    row.classList.remove('bump'); void row.offsetWidth; row.classList.add('bump')
  }

  root.addEventListener('click', e => {
    const ch = e.target.closest('[data-ch]')
    if (ch) { if (!e.target.closest('.mk[data-poke]') || ch.dataset.ch !== active) onSelect(ch.dataset.ch); return }
    const btn = e.target.closest('[data-side]')
    if (!btn) return
    if (btn.dataset.side === 'me') onMe(btn)
    else if (btn.dataset.side === 'add') onAddSource(btn)
    else if (btn.dataset.side === 'search') onSearch(btn)
  })

  return { render, update, setActive, bump, botMark: () => root.querySelector('.bot-card .mk') }
}
