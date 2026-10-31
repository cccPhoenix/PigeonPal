import { icon } from './icons.js'

export function noticeProgressInfo(status) {
  const pending = Math.max(0, Number(status?.counts?.pending) || 0)
  const processing = Math.max(0, Number(status?.counts?.processing) || 0)
  const active = Boolean(status?.configured && (processing || (status.automatic && pending && !status.error)))
  const title = typeof status?.activeNotice?.title === 'string' ? status.activeNotice.title.trim() : ''
  return { active, title, text: processing ? `正在处理 ${processing} 条${pending ? ` · ${pending} 条排队` : ''}` : `还有 ${pending} 条等待整理` }
}

export function createNoticeProgress({ root, client }) {
  let dismissed = false
  let request = null
  root.innerHTML = `<span class="notice-progress-icon">${icon('sparkle', 17)}</span><span class="notice-progress-content"><strong>正在整理通知</strong><span class="notice-progress-title" data-progress-title hidden></span><span data-progress-detail></span><span class="notice-progress-bar" aria-hidden="true"></span></span><button class="icon-btn flat notice-progress-close" type="button" aria-label="关闭通知整理进度">${icon('close', 16)}</button>`
  const title = root.querySelector('[data-progress-title]')
  const detail = root.querySelector('[data-progress-detail]')
  const hide = () => { root.classList.remove('show'); root.setAttribute('aria-hidden', 'true'); root.inert = true }
  const show = () => { root.classList.add('show'); root.setAttribute('aria-hidden', 'false'); root.inert = false }
  hide()
  root.querySelector('.notice-progress-close').addEventListener('click', () => { dismissed = true; hide() })

  function update(status) {
    const info = noticeProgressInfo(status)
    if (!info.active) dismissed = false
    if (info.active && !dismissed) {
      if (title.textContent !== info.title) title.textContent = info.title
      title.title = info.title
      title.hidden = !info.title
      if (detail.textContent !== info.text) detail.textContent = info.text
      show()
    } else hide()
  }

  function refresh() {
    if (request) return request
    request = client.status().then(update).catch(hide).finally(() => { request = null })
    return request
  }

  return { update, refresh }
}
