import { markHTML, setMarkState } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml, richText, plain, clock, whenLabel, personalize } from './format.js'
import { eventPhrase, NOTICE_CATEGORIES } from '../services/sources.js'
import { isHomework, isHomeworkCard, orderHomeworkMessages, reorderHomeworkNodes } from '../services/homework.js'

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
  const mark = (opts = {}) => markHTML({ look: profile().look, image: profile().look === 'image' ? profile().image : null, label: profile().botName, size: 36, ...opts })
  const nearBottom = () => root.scrollHeight - root.scrollTop - root.clientHeight < 96
  const toBottom = (smooth = false) => root.scrollTo({ top: root.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })

  function startsGroup(prev, m) {
    return !prev || prev.role !== m.role || m.at - prev.at > GROUP_GAP || m.kind === 'notice' || prev.kind === 'notice' || m.kind === 'reminder'
  }

  function noticeCard(m) {
    const item = m.item ?? {}
    const homework = isHomework(item)
    const channel = store.channel(homework ? 'src-xzzd' : m.channelId)
    const reminder = store.state.reminders.find(r => (r.noticeId === m.id || r.noticeId === item.noticeId) && r.status === 'pending')
    const time = item.eventAt ? `${eventPhrase(item.eventAt)}${item.eventEnd ? ` – ${clock(item.eventEnd)}` : ''}` : ''
    return `<div class="card">
  <div class="card-src"><span>${escapeHtml(channel?.emoji ?? '🔔')}</span><span>${escapeHtml(channel?.title ?? '')}</span><span>·</span><span>${homework ? (m.kind === 'reminder' ? '作业截止提醒' : m.queryResult ? '作业查询结果' : '本地作业信息') : item.real ? (item.analysisState === 'ready' ? '已整理' : '原站通知') : '示例'}</span></div>
  ${homework ? '' : item.real ? `<details><summary>原标题</summary><div>${escapeHtml(item.title ?? '')}</div></details>` : `<div class="card-title">${escapeHtml(item.title ?? '')}</div>`}
  ${!item.real && NOTICE_CATEGORIES[item.category] ? `<div class="card-meta"><span>${escapeHtml(NOTICE_CATEGORIES[item.category])}</span></div>` : ''}
  ${!homework && item.real && !item.publishedDate ? '<div class="card-meta"><span>原站发布日期待补齐</span></div>' : ''}
  ${!item.real && (time || item.where) ? `<div class="card-meta">${time ? `<div>${icon('clock', 15)}<span>${escapeHtml(time)}</span></div>` : ''}${item.where ? `<div>${icon('pin', 15)}<span>${escapeHtml(item.where)}</span></div>` : ''}</div>` : ''}
  <div class="pills">
    <button class="pill" data-act="open-notice" data-id="${escapeHtml(m.id)}">${icon('link', 15)}${homework ? '查看作业' : '查看原文'}</button>
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
    const user = m.role === 'user'
    const quoted = m.quoteId && store.message(m.quoteId)
    const noticeRef = m.noticeId && store.notice(m.noticeId)
    const cls = ['row', user ? 'user' : 'bot', (m.kind === 'notice' || isHomework(m.item)) && m.item?.real ? 'notice-row' : '', first ? 'first' : '', enter ? 'enter' : ''].filter(Boolean).join(' ')
    return `<div class="${cls}"${isHomeworkCard(m) ? ' data-homework-card="true"' : ''} data-id="${escapeHtml(m.id)}" data-role="${m.role}">
${user ? '' : `<div class="gutter">${first ? mark({ live, state: 'idle' }) : ''}</div>`}
<div class="stack">
  ${quoted ? `<button class="quote-ref" data-act="jump" data-id="${escapeHtml(quoted.id)}">${icon('reply', 14)}<span>${escapeHtml(plain(quoted.text, profile()))}</span></button>` : ''}
  <div class="line">
    <div class="bubble">${isHomework(m.item) ? escapeHtml(personalize(m.text, profile())).replace(/\n/g, '<br>') : richText(m.text, profile())}</div>
    <div class="tools"><time>${clock(m.at)}</time><button class="tool" data-act="copy" data-id="${escapeHtml(m.id)}" aria-label="复制">${icon('copy', 16)}</button><button class="tool" data-act="reply" data-id="${escapeHtml(m.id)}" aria-label="引用回复">${icon('reply', 16)}</button></div>
  </div>
  ${m.kind === 'notice' || isHomework(m.item) ? noticeCard(m) : ''}
  ${noticeRef ? `<button class="quote-ref" data-act="goto-notice" data-id="${escapeHtml(m.id)}">${icon(user ? 'attach' : 'bell', 14)}<span>${user ? `通知附件 · ${escapeHtml(noticeRef.title)}` : '查看这条通知'}</span></button>` : ''}
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
    const list = orderHomeworkMessages(store.state.messages[id] ?? [])
    let html = ''
    let prev = null
    list.forEach(m => {
      if (!isHomeworkCard(m) && (!prev || m.at - prev.at > DIVIDER_GAP)) html += dividerHTML(m.at)
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
    inner.querySelector('.empty')?.remove()
    const stick = nearBottom() || m.role === 'user'
    const rows = inner.querySelectorAll('.row')
    const prevRow = [...rows].filter(r => r !== typingRow).at(-1)
    const prev = prevRow && store.message(prevRow.dataset.id)
    const divider = !isHomeworkCard(m) && (!prev || m.at - prev.at > DIVIDER_GAP)
    const first = divider || startsGroup(prev, m)

    let carried = null
    if (typingRow && m.role === 'bot') {
      // The typing row becomes the message: keep its mark so the motion does not restart.
      carried = typingRow.querySelector('.gutter .mk')
      typingRow.remove()
      typingRow = null
    }
    if (divider) inner.append(toNode(dividerHTML(m.at)))
    const frag = toNode(rowHTML(m, { first, live: true, enter: true }))
    const row = frag.firstElementChild
    inner.append(frag)
    if (m.role === 'bot' && first) {
      const fresh = row.querySelector('.gutter .mk')
      if (carried) { fresh.replaceWith(carried); setMarkState(carried, 'idle'); setLive(carried) }
      else { fresh.classList.add('mk-enter'); setLive(fresh) }
    } else if (m.role === 'bot') {
      const live = inner.querySelector('.mk[data-live]')
      if (live) setMarkState(live, 'idle')
    }
    if (isHomeworkCard(m)) reorderHomeworkNodes(inner, id => store.message(id))
    if (stick) requestAnimationFrame(() => toBottom(true))
    else { unseen += 1; showJump() }
  }

  function syncHomeworkSnapshot(id) {
    if (id !== channelId || !inner) return
    const stick = nearBottom()
    const cards = orderHomeworkMessages(store.state.messages[id] || []).filter(isHomeworkCard)
    const wanted = new Set(cards.map(message => message.id))
    for (const node of inner.querySelectorAll('[data-homework-card]')) if (!wanted.has(node.dataset.id)) node.remove()
    if (cards.length) inner.querySelector('.empty')?.remove()
    let cursor = inner.firstChild
    for (const message of cards) {
      let node = inner.querySelector(`.row[data-id="${CSS.escape(message.id)}"]`)
      if (!node) node = toNode(rowHTML(message, { first: true, live: false })).firstElementChild
      else refreshNotice(message)
      if (node !== cursor) {
        if (node.parentNode === inner && inner.moveBefore) inner.moveBefore(node, cursor)
        else inner.insertBefore(node, cursor)
      }
      cursor = node.nextSibling
    }
    if (!inner.querySelector('.row')) inner.innerHTML = '<div class="empty">当前没有符合条件的作业，稍后会继续更新</div>'
    if (stick) toBottom()
  }

  function showTyping() {
    if (!inner || typingRow) return
    const rows = [...inner.querySelectorAll('.row')]
    const last = rows.at(-1)
    const continues = last?.dataset.role === 'bot' && Date.now() - (store.message(last.dataset.id)?.at ?? 0) < GROUP_GAP
    const stick = nearBottom()
    const html = `<div class="row bot typing enter${continues ? '' : ' first'}" data-role="typing"><div class="gutter">${continues ? '' : mark({ live: true, state: 'thinking' })}</div><div class="stack"><div class="line"><div class="bubble" aria-label="正在输入"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div></div></div>`
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
    const pills = row.querySelector(m.kind === 'notice' ? '.card .pills' : '.pills.under')
    const fresh = toNode(m.kind === 'notice' ? noticeCard(m) : reminderPills(m)).firstElementChild
    const next = m.kind === 'notice' ? fresh?.querySelector('.pills') : fresh
    if (pills && next) pills.replaceWith(next)
  }

  function refreshNotice(message) {
    const row = inner?.querySelector(`.row[data-id="${CSS.escape(message.id)}"]`)
    if (!row) return
    row.querySelector('.bubble').innerHTML = isHomework(message.item) ? escapeHtml(personalize(message.text, profile())).replace(/\n/g, '<br>') : richText(message.text, profile())
    const card = row.querySelector('.card')
    if (card) card.replaceWith(toNode(noticeCard(message)))
    if (isHomeworkCard(message)) reorderHomeworkNodes(inner, id => store.message(id))
  }

  function flash(messageId) {
    const row = inner?.querySelector(`.row[data-id="${CSS.escape(messageId)}"]`)
    if (!row) return false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash')
    return true
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
    render, append, syncHomeworkSnapshot, patch, flash, showTyping, hideTyping, refreshNotice,
    get channelId() { return channelId },
    refreshMarks() { if (channelId) render(channelId) },
  }
}
