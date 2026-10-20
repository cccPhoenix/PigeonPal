import { markHTML } from '../mark/index.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'
import { noticeUnreadCount } from '../services/notice-list.js'

// The icon rail: 小浙's identity plus the view switcher. Labels expand on hover so the
// rail can stay narrow without turning into a strip of anonymous glyphs.
export function createIconRail({ root, store, onView, onBot, onHomework, onMe, onAddSource, onSearch, academy = () => '' }) {
  let view = 'notice'
  let unread = 0
  let chatUnread = 0
  let homeworkUnread = 0
  const badgeHTML = n => (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '')

  const VIEWS = [['notice', '通知', 'bell'], ['homework', '作业', 'book'], ['calendar', '日历', 'calendar'], ['user-profile', '用户画像', 'graduate']]

  const btn = ({ id, label, iconName, html, current = false, badge = '' }) =>
    `<button class="rail-btn" data-view="${escapeHtml(id)}" aria-label="${escapeHtml(label)}"${current ? ' aria-current="page"' : ''}>
  ${html ?? icon(iconName, 20)}${badge}<span class="rail-lbl">${escapeHtml(label)}</span>
</button>`

  function render() {
    const p = store.state.profile
    const nick = (p.nickname || '我').slice(0, 1)
    root.innerHTML = `
<img class="dock-brand" src="./assets/icon.png" width="32" height="32" alt="" draggable="false">
${btn({ id: 'chat', label: `和${p.botName}说话`, current: view === 'chat', badge: badgeHTML(chatUnread), html: markHTML({ look: p.look, image: p.look === 'image' ? p.image : null, label: p.botName, size: 40, live: true, gaze: true, poke: true }) })}
<div class="dock-views" role="group" aria-label="视图">
  ${VIEWS.filter(([id]) => id !== 'homework' || store.channel('src-xzzd')).map(([id, label, name]) => btn({
      id, label, iconName: name, current: view === id,
      badge: id === 'notice' ? badgeHTML(unread) : id === 'homework' ? badgeHTML(homeworkUnread) : '',
    })).join('')}
</div>
<div class="dock-spacer"></div>
${btn({ id: 'search', label: '搜索消息', iconName: 'search' })}
${btn({ id: 'add', label: '添加信息来源', iconName: 'plus' })}
${btn({ id: 'me', label: '我的设置', html: `<span class="dock-me">${escapeHtml(nick)}</span>` })}`
  }

  function setView(next) {
    if (view === next) return
    view = next
    const buttons = root.querySelectorAll?.('[data-view]')
    if (!buttons?.length) return render()
    for (const button of buttons) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }

  // Badge-only update: re-rendering would restart the mark's animation and drop the gaze.
  function patchBadge(selector, n) {
    if (!root.querySelector) return false
    const button = root.querySelector(selector)
    if (!button) return true // Optional source entry is absent.
    const el = button.querySelector('.badge')
    if (!n) el?.remove()
    else if (el) {
      const text = n > 99 ? '99+' : String(n)
      if (el.textContent !== text) el.textContent = text
    } else button.insertAdjacentHTML('beforeend', badgeHTML(n))
    return true
  }

  function setUnread(n) {
    unread = Math.max(0, Number(n) || 0)
    if (!patchBadge('.rail-btn[data-view="notice"]', unread)) render()
  }

  function setChatUnread(n) {
    chatUnread = Math.max(0, Number(n) || 0)
    if (!patchBadge('.rail-btn[data-view="chat"]', chatUnread)) render()
  }

  function setHomeworkUnread(n) {
    homeworkUnread = Math.max(0, Number(n) || 0)
    if (!patchBadge('.rail-btn[data-view="homework"]', homeworkUnread)) render()
  }

  function bump() {
    const b = root.querySelector?.('.rail-btn[data-view="notice"]')
    if (!b) return
    b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump')
  }

  // Source reads, feed updates and trash actions all update the bell directly;
  // it must not depend on a later view change or transcript render.
  const syncNoticeBadge = () => setUnread(noticeUnreadCount(store.state, null, academy()))
  store.on('unread', syncNoticeBadge)
  store.on('notice', syncNoticeBadge)
  store.on('notice-meta', syncNoticeBadge)
  unread = noticeUnreadCount(store.state, null, academy())

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-view]')
    if (!b) return
    const id = b.dataset.view
    if (id === 'chat') return onBot(b)
    if (id === 'homework') return onHomework?.(b)
    if (id === 'search') return onSearch(b)
    if (id === 'add') return onAddSource(b)
    if (id === 'me') return onMe(b)
    onView(id)
  })

  return { render, setView, setUnread, setChatUnread, setHomeworkUnread, bump, mark: () => root.querySelector('.mk'), get view() { return view } }
}
