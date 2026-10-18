import { icon } from './icons.js'
import { escapeHtml, shortTime, dayLabel, whenLabel } from './format.js'
import { NOTICE_CATEGORIES, NOTICE_DRAG_TYPE, isAttachable } from '../services/sources.js'
import { apiErrorText } from '../services/api.js'
import { toast } from './overlays.js'

// The notice view: crawled notices, typeset rather than chatted. The list pane groups by
// day and filters by source; the detail pane is a key/value table fed by the list plus the
// single-notice endpoint (body, publisher, attachments), cached per revision.

const ANALYSIS_STATE = {
  ready: '已整理', pending: '等待整理', processing: '正在整理', failed: '整理失败',
  waiting_body: '正文未采集', unconfigured: '未配置整理', blocked: '未授权整理',
}
const FETCH_STATE = { complete: '正文已采集', pending: '正文排队中', skipped: '仅保存链接', failed: '采集失败' }

const cacheKey = n => `${n.noticeId}:${n.revision ?? ''}`
const SOURCE_ICONS = { yunfeng: 'school', itc: 'computer', qsxy: 'graduate', bksy: 'book' }
const sourceIcon = sourceId => icon(SOURCE_ICONS[sourceId] ?? 'bell', 17)
// Detail-endpoint URLs are not run through store.cleanItem, so pin the scheme here.
const safeHref = url => (/^https?:\/\//.test(url ?? '') ? escapeHtml(url) : '')

export function createRail({ listRoot, detailRoot, store, client, onRemind, onAttach }) {
  let filter = null
  let selected = null
  const detailCache = new Map()

  const channelOf = n => store.state.channels.find(c => c.sourceId === n.sourceId)
  const row = (label, value) => (value ? `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>` : '')

  // Re-rendering replaces a subtree, so each pane's scroll offset is carried over.
  function repaint(root, html) {
    const pane = root.querySelector?.('.pane-scroll')
    const y = pane?.scrollTop ?? 0
    root.innerHTML = html
    const next = root.querySelector?.('.pane-scroll')
    if (next && y) next.scrollTop = y
  }

  function chipsHTML() {
    const chip = (src, label, on, unread) => `<button class="pill${on ? ' on' : ''}" data-rail="filter" data-src="${escapeHtml(src)}" aria-pressed="${on}">${label}${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`
    const sources = store.state.channels.filter(c => c.kind === 'source' && c.sourceId !== 'xzzd')
    const total = sources.reduce((sum, c) => sum + (store.state.unread[c.id] ?? 0), 0)
    return [chip('', '全部', !filter, total),
      ...sources.map(c => chip(
        c.sourceId, `${sourceIcon(c.sourceId)}${escapeHtml(c.title)}`, filter === c.sourceId, store.state.unread[c.id] ?? 0,
      ))].join('')
  }

  function itemHTML(n) {
    const c = channelOf(n)
    const current = selected === n.noticeId
    return `<button class="rail-item" data-notice="${escapeHtml(n.noticeId)}" aria-current="${current}"${isAttachable(n) ? ' draggable="true"' : ''}>
  <span class="rail-ico" aria-hidden="true">${sourceIcon(n.sourceId)}</span>
  <span class="rail-text">
    <span class="rail-title">${escapeHtml(n.title)}</span>
    <span class="rail-sub">${escapeHtml(c?.title ?? '')} · ${escapeHtml(shortTime(n.publishedAt))}</span>
  </span>
  ${current ? '<span class="rail-current">正在查看</span>' : ''}
</button>`
  }

  function renderList() {
    const all = Object.values(store.state.notices)
      .filter(n => !filter || n.sourceId === filter)
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    const rows = []
    let lastDay = null
    for (const n of all) {
      const day = dayLabel(n.publishedAt ?? Date.now())
      if (day !== lastDay) { rows.push(`<div class="divider">${escapeHtml(day)}</div>`); lastDay = day }
      rows.push(itemHTML(n))
    }
    repaint(listRoot, `<div class="rail-top">
  <span class="rail-head">通知</span>
</div>
<div class="chips rail-chips">${chipsHTML()}</div>
<div class="rail-list pane-scroll">${rows.join('') || `<div class="empty">${filter ? '这个来源还没有通知' : '还没有通知，爬虫每五分钟看一次'}</div>`}</div>`)
  }

  function detailRows(n, cached) {
    const ready = n.analysisState === 'ready'
    let rows = row('发布日期', escapeHtml(n.publishedDate || '原站发布日期待补齐'))
      + row('整理状态', escapeHtml(ANALYSIS_STATE[n.analysisState] ?? n.analysisState ?? ''))
    if (ready) {
      rows += row('通知类型', escapeHtml(n.noticeType))
        + row('参与方式', escapeHtml(n.participation))
        + row('面向', escapeHtml(n.audience?.length ? n.audience.join('、') : '原文未说明'))
        + row('要点', escapeHtml(n.summary))
        + row('时间', escapeHtml([n.eventTime, n.eventAt ? whenLabel(n.eventAt) : ''].filter(Boolean).join('　')))
        + row('地点', escapeHtml(n.where))
        + row('截止', escapeHtml(n.deadlineText))
        + row('收益', escapeHtml(n.benefits))
        + row('分类', escapeHtml(NOTICE_CATEGORIES[n.category]))
      if (n.todos?.length) rows += row('待办', n.todos.map(t => `<div>${escapeHtml(t.text)}${t.dueAt ? `（${escapeHtml(t.dueAt)}）` : ''}</div>`).join(''))
      if (n.notes?.length) rows += row('备注', escapeHtml(n.notes.join('；')))
    }
    if (cached instanceof Error) {
      rows += row('详情', `<span class="muted">${escapeHtml(apiErrorText(cached))}</span> <button class="btn" data-act="retry">重试</button>`)
    } else if (cached) {
      rows += row('发布者', escapeHtml(cached.publisher || '—'))
        + row('采集状态', escapeHtml(FETCH_STATE[cached.state] ?? cached.state ?? ''))
      if (cached.attachments?.length) {
        const links = cached.attachments.map(a => ({ href: safeHref(a.url), name: a.name })).filter(a => a.href)
          .map(a => `<a href="${a.href}" target="_blank" rel="noopener">${escapeHtml(a.name || '附件')}</a>`)
        if (links.length) rows += row('附件', links.join('、'))
      }
    } else if (n.real) {
      rows += row('详情', '<span class="muted">正在读取详情…</span>')
    }
    return rows
  }

  function renderDetail() {
    const n = selected ? store.notice(selected) : null
    if (!n) {
      repaint(detailRoot, `<div class="rail-top"><span class="rail-head">详情</span></div>
<div class="pane-scroll"><div class="empty">左边选一条通知看看</div></div>`)
      return
    }
    const c = channelOf(n)
    const cached = detailCache.get(cacheKey(n))
    const reminder = store.state.reminders.find(r => r.noticeId === n.noticeId && r.status === 'pending')
    const canReprocess = cached && !(cached instanceof Error) && cached.state === 'complete' && typeof cached.content === 'string' && cached.content.trim()
    const body = canReprocess ? `<details class="notice-body"><summary>网页正文</summary><div>${escapeHtml(cached.content).replace(/\n/g, '<br>')}</div></details>` : ''
    repaint(detailRoot, `<div class="rail-top">
  <button class="icon-btn flat detail-back" data-rail="back" aria-label="返回通知列表">${icon('chevron', 16)}</button>
  <span class="rail-head">通知详情</span>
  <button class="icon-btn flat detail-close" data-rail="back" aria-label="关闭详情">${icon('close', 18)}</button>
</div>
<div class="rail-detail pane-scroll">
  <div class="detail-intro"><span class="detail-source">${sourceIcon(n.sourceId)}${escapeHtml(c?.title ?? n.sourceId ?? '通知')}</span><h2>${escapeHtml(n.title)}</h2></div>
  <div class="panel">
    <table class="kv-table"><tbody>${detailRows(n, cached)}</tbody></table>
    ${body}
  </div>
  <div class="pills under">
    ${n.url ? `<a class="pill" href="${safeHref(n.url)}" target="_blank" rel="noopener">${icon('link', 15)}打开原网页</a>` : ''}
    <button class="pill${reminder ? ' on' : ''}" data-act="remind">${icon('bell', 15)}${reminder ? `已提醒 · ${escapeHtml(whenLabel(reminder.dueAt))}` : '提醒我'}</button>
    ${onAttach ? `<button class="pill" data-act="attach">${icon('attach', 15)}添加到对话</button>` : ''}
    ${canReprocess ? `<button class="pill" data-act="reprocess">${icon('sparkle', 15)}重新整理</button>` : ''}
  </div>
</div>`)
  }

  function render() {
    renderList()
    renderDetail()
    syncPaneAttr()
  }

  function syncPaneAttr() {
    const host = listRoot.parentElement
    if (host?.dataset) host.dataset.pane = selected ? 'detail' : 'list'
  }

  function setFilter(sourceId) {
    filter = sourceId || null
    renderList()
    syncPaneAttr()
  }

  function openNotice(noticeId) {
    const n = store.notice(noticeId)
    if (!n) { selected = null; renderList(); renderDetail(); return syncPaneAttr() }
    const switching = Boolean(selected && selected !== noticeId)
    selected = noticeId
    renderList()
    if (n.real && !detailCache.has(cacheKey(n))) {
      renderDetail()
      client.notice(n.noticeId)
        .then(detail => detailCache.set(cacheKey(n), detail))
        .catch(error => detailCache.set(cacheKey(n), error))
        .then(() => { if (selected === noticeId) renderDetail() })
    } else {
      renderDetail()
    }
    syncPaneAttr()
    if (switching && detailRoot.classList) {
      detailRoot.classList.remove('detail-switching')
      void detailRoot.offsetWidth
      detailRoot.classList.add('detail-switching')
    }
  }

  function back() {
    selected = null
    detailRoot.classList?.remove('detail-switching')
    renderList()
    renderDetail()
    syncPaneAttr()
  }

  function reveal(noticeId) {
    const n = store.notice(noticeId)
    if (!n) return
    filter = n.sourceId || null
    renderList()
    openNotice(noticeId)
  }

  function onNotice({ item, revised }) {
    renderList()
    if (revised && selected === item.noticeId) {
      detailCache.delete(cacheKey(item))
      openNotice(item.noticeId)
    }
  }

  function patchRemindPill(reminder) {
    if (!selected || (reminder && reminder.noticeId !== selected)) return
    const pill = detailRoot.querySelector?.('.rail-detail [data-act="remind"]')
    if (!pill) return
    const pending = store.state.reminders.find(r => r.noticeId === selected && r.status === 'pending')
    pill.classList.toggle('on', Boolean(pending))
    pill.innerHTML = `${icon('bell', 15)}${pending ? `已提醒 · ${escapeHtml(whenLabel(pending.dueAt))}` : '提醒我'}`
  }

  function bind(root) {
    root.addEventListener('click', e => {
      const picked = e.target.closest?.('[data-notice]')
      if (picked) return selected === picked.dataset.notice ? back() : openNotice(picked.dataset.notice)
      const chip = e.target.closest?.('[data-rail="filter"]')
      if (chip) return setFilter(chip.dataset.src || null)
      if (e.target.closest?.('[data-rail="back"]')) return back()
      const act = e.target.closest?.('[data-act]')
      if (!act) return
      const n = selected ? store.notice(selected) : null
      if (act.dataset.act === 'remind' && n) return onRemind?.(n, act)
      if (act.dataset.act === 'attach' && n) return onAttach?.(n)
      if (act.dataset.act === 'retry' && n) { detailCache.delete(cacheKey(n)); return openNotice(n.noticeId) }
      if (act.dataset.act === 'reprocess' && n) {
        client.process(n.noticeId).then(() => toast('已加入整理队列')).catch(error => toast(apiErrorText(error)))
      }
    })
  }

  bind(listRoot)
  bind(detailRoot)

  // Dragging a row onto the composer attaches it as the question's context.
  listRoot.addEventListener('dragstart', e => {
    const row = e.target.closest?.('[data-notice]')
    const n = row ? store.notice(row.dataset.notice) : null
    if (!n || !isAttachable(n)) { e.preventDefault?.(); return }
    const payload = JSON.stringify({ noticeId: n.noticeId, title: n.title })
    e.dataTransfer?.setData(NOTICE_DRAG_TYPE, payload)
    e.dataTransfer?.setData('text/plain', n.title)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  })

  return {
    render, renderList, renderDetail, setFilter, openNotice, back, reveal, onNotice, patchRemindPill,
    get filter() { return filter },
    get selected() { return selected },
  }
}
