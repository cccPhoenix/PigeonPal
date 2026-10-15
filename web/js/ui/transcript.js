import { markHTML, setMarkState } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml, richText, plain, clock, whenLabel } from './format.js'
import { eventPhrase, NOTICE_CATEGORIES } from '../services/sources.js'
import { activityHTML, animateActivity } from './activity.js'
import { visibleActivity } from '../services/activity.js'

const GROUP_GAP = 5 * 60_000
const DIVIDER_GAP = 30 * 60_000

// The conversation column. Renders a channel in full when you switch to it, then only
// appends, so marks keep animating and scroll position is never thrown around.
export function createTranscript({ root, jump, store, onAction }) {
  let channelId = null
  let inner = null
  let typingRow = null
  let unseen = 0

  const profile = () => store.state.profile
  const resolveActor = actor => store.botAppearance(actor)
  const mark = ({ botId = 'chief', ...opts } = {}) => {
    const actor = resolveActor({ id: botId })
    return markHTML({ look: actor.look, image: actor.look === 'image' ? actor.image : null, label: actor.name, size: 36, ...opts })
  }
  const nearBottom = () => root.scrollHeight - root.scrollTop - root.clientHeight < 96
  const toBottom = (smooth = false) => root.scrollTo({ top: root.scrollHeight,
    behavior: smooth && profile().motion === 'lively' && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' })

  function startsGroup(prev, m) {
    return !prev || prev.role !== m.role || (prev.botId || 'chief') !== (m.botId || 'chief')
      || m.at - prev.at > GROUP_GAP || m.kind === 'notice' || prev.kind === 'notice' || m.kind === 'reminder'
  }

  function noticeCard(m) {
    const item = m.item ?? {}
    const channel = store.channel(m.channelId)
    const reminder = store.state.reminders.find(r => (r.noticeId === m.id || r.noticeId === item.noticeId) && r.status === 'pending')
    const time = item.eventAt ? `${eventPhrase(item.eventAt)}${item.eventEnd ? ` – ${clock(item.eventEnd)}` : ''}` : ''
    return `<div class="card">
  <div class="card-src"><span>${escapeHtml(channel?.emoji ?? '🔔')}</span><span>${escapeHtml(channel?.title ?? '')}</span><span>·</span><span>${item.real ? (item.analysisState === 'ready' ? '已整理' : '原站通知') : '示例'}</span></div>
  <div class="card-title">${escapeHtml(item.title ?? '')}</div>
  ${NOTICE_CATEGORIES[item.category] ? `<div class="card-meta"><span>${escapeHtml(NOTICE_CATEGORIES[item.category])}</span></div>` : ''}
  ${item.real && !item.publishedDate ? '<div class="card-meta"><span>原站发布日期待补齐</span></div>' : ''}
  ${!item.eventAt && item.eventLabel ? `<div class="card-meta"><div>${icon('clock', 15)}<span>活动日期：${escapeHtml(item.eventLabel)}</span></div></div>` : ''}
  ${item.deadlineAt ? `<div class="card-meta"><div>${icon('clock', 15)}<span>截止：${escapeHtml(item.deadlineAt.replace('T', ' '))}</span></div></div>` : ''}
  ${time || item.where ? `<div class="card-meta">${time ? `<div>${icon('clock', 15)}<span>${escapeHtml(time)}</span></div>` : ''}${item.where ? `<div>${icon('pin', 15)}<span>${escapeHtml(item.where)}</span></div>` : ''}</div>` : ''}
  <div class="pills">
    <button class="pill" data-act="open-notice" data-id="${escapeHtml(m.id)}">${icon('link', 15)}查看原文</button>
    ${item.real || item.eventAt && item.eventAt > Date.now() || reminder
      ? `<button class="pill${reminder ? ' on' : ''}" data-act="remind-notice" data-id="${escapeHtml(m.id)}">${icon('bell', 15)}${reminder ? `已提醒 · ${escapeHtml(whenLabel(reminder.dueAt))}` : '提醒我'}</button>`
      : ''}
  </div>
</div>`
  }

  function reminderPills(m) {
    const r = store.state.reminders.find(x => x.id === m.reminderId)
    if (!r) return ''
    let inside
    if (r.status === 'done') inside = `<span class="pill done">${icon('check', 15)}已完成</span>`
    else if (r.status === 'cancelled') inside = '<span class="pill done">已取消</span>'
    else if (r.deliveredAt === null) inside = `<span class="pill done">${icon('clock', 15)}${escapeHtml(whenLabel(r.dueAt))} 再叫你</span>`
    else inside = `<button class="pill" data-act="reminder-done" data-id="${escapeHtml(r.id)}">${icon('check', 15)}完成</button><button class="pill" data-act="reminder-snooze" data-id="${escapeHtml(r.id)}">${icon('clock', 15)}10 分钟后</button>`
    return `<div class="pills under">${inside}</div>`
  }

  function rowHTML(m, { first, live, enter }) {
    if (m.kind === 'activity') return activityHTML(m, profile(), { fresh: Boolean(enter), resolveActor })
    const user = m.role === 'user'
    const quoted = m.quoteId && store.message(m.quoteId)
    const cls = ['row', user ? 'user' : 'bot', first ? 'first' : '', enter ? 'enter' : ''].filter(Boolean).join(' ')
    return `<div class="${cls}" data-id="${escapeHtml(m.id)}" data-role="${m.role}" data-bot-id="${escapeHtml(m.botId || 'chief')}">
${user ? '' : `<div class="gutter">${first ? mark({ botId: m.botId, live, state: 'idle' }) : ''}</div>`}
<div class="stack">
  ${!user && first && m.botId ? `<div class="sender-name">${escapeHtml(resolveActor({ id: m.botId }).name)}</div>` : ''}
  ${quoted ? `<button class="quote-ref" data-act="jump" data-id="${escapeHtml(quoted.id)}">${icon('reply', 14)}<span>${escapeHtml(plain(quoted.text, profile()))}</span></button>` : ''}
  <div class="line">
    <div class="bubble">${richText(m.text, profile())}</div>
    <div class="tools"><time>${clock(m.at)}</time><button class="tool" data-act="copy" data-id="${escapeHtml(m.id)}" aria-label="复制">${icon('copy', 16)}</button><button class="tool" data-act="reply" data-id="${escapeHtml(m.id)}" aria-label="引用回复">${icon('reply', 16)}</button></div>
  </div>
  ${m.kind === 'notice' ? noticeCard(m) : ''}
  ${m.kind === 'reminder' ? reminderPills(m) : ''}
</div>
</div>`
  }

  const dividerHTML = at => `<div class="divider">${escapeHtml(whenLabel(at))}</div>`
  const toNode = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content }

  function setLive(node) {
    for (const el of inner.querySelectorAll('.mk[data-live]')) if (el !== node) { el.removeAttribute('data-live'); el.dataset.state = 'idle' }
    node?.setAttribute('data-live', '')
  }

  function render(id) {
    channelId = id
    typingRow = null
    unseen = 0
    jump.hidden = true
    const list = (store.state.messages[id] ?? []).filter(m => m.kind !== 'activity' || visibleActivity(m.activity))
    let html = ''
    let prev = null
    list.forEach(m => {
      if (!prev || m.at - prev.at > DIVIDER_GAP) html += dividerHTML(m.at)
      const first = startsGroup(prev, m) || (prev && m.at - prev.at > DIVIDER_GAP)
      html += rowHTML(m, { first, live: false })
      prev = m
    })
    if (!list.length) html = `<div class="empty">${id === 'bot' ? '' : '这里还没有消息，有新动态我会第一时间告诉你'}</div>`
    root.innerHTML = `<div class="log-inner swap">${html}</div>`
    inner = root.firstElementChild
    const latest = [...inner.querySelectorAll('.row.first')].at(-1)
    if (latest?.dataset.role === 'bot') setLive(latest.querySelector('.mk'))
    toBottom()
  }

  function append(m) {
    if (m.channelId !== channelId || !inner) return
    settleHandoff(m)
    if (m.kind === 'activity' && !visibleActivity(m.activity)) return
    inner.querySelector('.empty')?.remove()
    const stick = nearBottom() || m.role === 'user'
    const rows = inner.querySelectorAll('.row, .activity-row')
    const prevRow = [...rows].filter(r => r !== typingRow).at(-1)
    const prev = prevRow && store.message(prevRow.dataset.id)
    const divider = !prev || m.at - prev.at > DIVIDER_GAP
    const first = divider || startsGroup(prev, m)

    let carried = null
    if (typingRow && m.role === 'bot') {
      // The typing row becomes the message: keep its mark so the motion does not restart.
      if (typingRow.dataset.botId === (m.botId || 'chief')) carried = typingRow.querySelector('.gutter .mk')
      typingRow.remove()
      typingRow = null
    }
    if (divider) inner.append(toNode(dividerHTML(m.at)))
    const frag = toNode(rowHTML(m, { first, live: true, enter: true }))
    const row = frag.firstElementChild
    inner.append(frag)
    if (m.kind === 'activity') animateActivity(row)
    if (m.role === 'bot' && first) {
      const fresh = row.querySelector('.gutter .mk')
      if (carried) { fresh.replaceWith(carried); setMarkState(carried, 'idle'); setLive(carried) }
      else { fresh.classList.add('mk-enter'); setLive(fresh) }
    } else if (m.role === 'bot') {
      const live = inner.querySelector('.mk[data-live]')
      if (live) setMarkState(live, 'idle')
    }
    if (stick) requestAnimationFrame(() => toBottom(true))
    else { unseen += 1; showJump() }
  }

  function showTyping(botId = 'chief') {
    if (!inner) return
    if (typingRow && typingRow.dataset.botId !== botId) {
      typingRow.remove()
      typingRow = null
    }
    if (typingRow) return
    const rows = [...inner.querySelectorAll('.row, .activity-row')]
    const last = rows.at(-1)
    const continues = last?.dataset.role === 'bot' && (last.dataset.botId || 'chief') === botId
      && Date.now() - (store.message(last.dataset.id)?.at ?? 0) < GROUP_GAP && store.message(last.dataset.id)?.kind !== 'notice'
    const stick = nearBottom()
    const html = `<div class="row bot typing enter${continues ? '' : ' first'}" data-role="typing" data-bot-id="${escapeHtml(botId)}"><div class="gutter">${continues ? '' : mark({ botId, live: true, state: 'thinking' })}</div><div class="stack"><div class="line"><div class="bubble" aria-label="正在输入"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div></div></div>`
    inner.append(toNode(html))
    typingRow = inner.lastElementChild
    if (continues) setMarkState(inner.querySelector('.mk[data-live]'), 'thinking')
    else { const m = typingRow.querySelector('.mk'); m.classList.add('mk-enter'); setLive(m) }
    if (stick) requestAnimationFrame(() => toBottom(true))
  }

  function hideTyping() {
    if (!typingRow) return
    const row = typingRow
    typingRow = null
    row.classList.add('leave')
    setTimeout(() => row.remove(), 180)
    const live = inner.querySelector('.mk[data-live]')
    if (live && live.dataset.state === 'thinking') setMarkState(live, 'idle')
  }

  function patch(messageId) {
    const row = inner?.querySelector(`.row[data-id="${CSS.escape(messageId)}"]`)
    const m = store.message(messageId)
    if (!row || !m) return
    const pills = row.querySelector('.card .pills, .pills.under')
    const fresh = toNode(m.kind === 'notice' ? noticeCard(m) : reminderPills(m)).firstElementChild
    const next = m.kind === 'notice' ? fresh?.querySelector('.pills') : fresh
    if (pills && next) pills.replaceWith(next)
  }

  function refreshNotice(message) {
    const row = inner?.querySelector(`.row[data-id="${CSS.escape(message.id)}"]`)
    if (!row) return
    row.querySelector('.bubble').innerHTML = richText(message.text, profile())
    const card = row.querySelector('.card')
    if (card) card.replaceWith(toNode(noticeCard(message)))
    if (row.dataset.botId !== (message.botId || 'chief')) {
      row.dataset.botId = message.botId || 'chief'
      refreshRowMark(row)
    }
  }

  function refreshRowMark(row) {
    const botId = row.dataset.botId || 'chief'
    const old = row.querySelector('.gutter .mk')
    if (old) old.replaceWith(toNode(mark({ botId, live: old.hasAttribute('data-live'), state: old.dataset.state || 'idle' })))
    const name = row.querySelector('.sender-name')
    if (name) name.textContent = resolveActor({ id: botId }).name
  }

  function refreshMarks() {
    if (!inner) return
    const top = root.scrollTop
    for (const row of inner.querySelectorAll('.row.bot, .row.typing')) refreshRowMark(row)
    for (const row of inner.querySelectorAll('.activity-row')) {
      const message = store.message(row.dataset.id)
      if (!message) continue
      const fresh = toNode(activityHTML(message, profile(), { resolveActor })).firstElementChild
      if (!fresh) { row.remove(); continue }
      row.querySelector('.activity-content')?.replaceWith(fresh.firstElementChild)
      clearTimeout(row._activityTimer)
      row.classList.remove('activity-enter')
      if (row.dataset.activity !== 'processing') delete row.dataset.fresh
      row.setAttribute('aria-live', 'off')
    }
    root.scrollTop = top
  }

  function flash(messageId) {
    const row = inner?.querySelector(`:is(.row, .activity-row)[data-id="${CSS.escape(messageId)}"]`)
    if (!row) return false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash')
    return true
  }

  function refreshActivity(message) {
    settleHandoff(message)
    const row = inner?.querySelector(`.activity-row[data-id="${CSS.escape(message.id)}"]`)
    if (!row) { append(message); return }
    const stick = nearBottom()
    const changed = row.dataset.activity !== message.activity.type
    const fresh = toNode(activityHTML(message, profile(), { fresh: changed, resolveActor })).firstElementChild
    clearTimeout(row._activityTimer)
    if (!fresh) { row.remove(); return }
    row.replaceWith(fresh)
    if (changed) animateActivity(fresh)
    if (stick) requestAnimationFrame(() => toBottom())
  }

  function settleHandoff(message) {
    if (message.kind !== 'activity' || !['completed', 'failed', 'unknown'].includes(message.activity?.type)
        || !message.id.startsWith('team-task-')) return
    const target = message.activity.actors[0].id
    if (!message.id.endsWith('-' + target)) return
    const request = message.id.slice('team-task-'.length, -(target.length + 1))
    const row = inner?.querySelector(`.activity-row[data-id="${CSS.escape('team-handoff-' + request)}"]`)
    // Keep the short avatar gesture, but stop claiming an already-finished task is waking.
    if (row) delete row.dataset.waking
  }

  function showJump() {
    jump.innerHTML = `${icon('down', 15)}${unseen > 1 ? `${unseen} 条新消息` : '新消息'}`
    jump.hidden = false
  }

  root.addEventListener('scroll', () => { if (!jump.hidden && nearBottom()) { jump.hidden = true; unseen = 0 } }, { passive: true })
  jump.addEventListener('click', () => { toBottom(true); jump.hidden = true; unseen = 0 })
  const touch = matchMedia('(hover: none)')
  root.addEventListener('click', e => {
    const bubble = touch.matches && e.target.closest('.bubble')
    if (bubble) {
      const line = bubble.closest('.line')
      for (const l of root.querySelectorAll('.line.show-tools')) if (l !== line) l.classList.remove('show-tools')
      line.classList.toggle('show-tools')
    }
    const el = e.target.closest('[data-act]')
    if (el && root.contains(el)) onAction(el.dataset.act, el.dataset.id, el)
  })

  return {
    render, append, patch, flash, showTyping, hideTyping, refreshNotice, refreshActivity,
    get channelId() { return channelId },
    refreshMarks,
  }
}
