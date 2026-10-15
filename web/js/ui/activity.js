import { markHTML } from '../mark/index.js'
import { activityParts, visibleActivity } from '../services/activity.js'
import { escapeHtml } from './format.js'

export function activityHTML(message, profile, { fresh = false, resolveActor } = {}) {
  const { activity } = message
  if (!visibleActivity(activity)) return ''
  let actorIndex = 0
  const parts = activityParts(activity).map(part => {
    if (typeof part === 'string') {
      if (fresh && activity.type === 'handoff' && part === ' 叫来了 ') return '<span class="activity-copy activity-live-copy">正在唤醒</span><span class="activity-copy activity-history-copy">叫来了</span>'
      return `<span class="activity-copy">${escapeHtml(part)}</span>`
    }
    const appearance = resolveActor ? resolveActor(part) : part.id === 'chief'
      ? { name: profile.botName, look: profile.look, image: profile.image } : part
    const { look, name, image } = appearance
    return `<span class="activity-actor" data-actor-index="${actorIndex++}"><span class="activity-avatar" aria-hidden="true">${markHTML({
      look, image: look === 'image' ? image : null, size: 28,
    })}</span><span class="activity-name">${escapeHtml(name)}</span></span>`
  }).join('')
  return `<div class="activity-row${fresh ? ' activity-enter' : ''}" data-id="${escapeHtml(message.id)}" data-activity="${activity.type}"${fresh ? ' data-fresh' : ''}${fresh && activity.type === 'handoff' ? ' data-waking' : ''} role="status" aria-live="${fresh ? 'polite' : 'off'}" aria-atomic="true"><div class="activity-content">${parts}</div></div>`
}

// No persistent data-live: a terminal event returns to a fully still avatar.
export function animateActivity(row) {
  const type = row.dataset.activity
  row.dataset.fresh = ''
  row.setAttribute('aria-live', 'polite')
  clearTimeout(row._activityTimer)
  if (type !== 'processing') row._activityTimer = setTimeout(() => {
    delete row.dataset.fresh
    delete row.dataset.waking
    row.classList.remove('activity-enter')
  }, 1450)
}
