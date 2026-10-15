import { markHTML } from '../mark/index.js'
import { activityParts } from '../services/activity.js'
import { escapeHtml } from './format.js'

export function activityHTML(message, profile, { fresh = false } = {}) {
  const { activity } = message
  let actorIndex = 0
  const parts = activityParts(activity).map(part => {
    if (typeof part === 'string') return `<span class="activity-copy">${escapeHtml(part)}</span>`
    const chief = part.id === 'chief'
    const look = chief ? profile.look : part.look
    return `<span class="activity-actor" data-actor-index="${actorIndex++}"><span class="activity-avatar" aria-hidden="true">${markHTML({
      look, image: chief && look === 'image' ? profile.image : null, size: 28,
    })}</span><span class="activity-name">${escapeHtml(chief ? profile.botName : part.name)}</span></span>`
  }).join('')
  return `<div class="activity-row${fresh ? ' activity-enter' : ''}" data-id="${escapeHtml(message.id)}" data-activity="${activity.type}"${fresh ? ' data-fresh' : ''} role="status" aria-live="${fresh ? 'polite' : 'off'}" aria-atomic="true"><div class="activity-content">${parts}</div></div>`
}

// No persistent data-live: a terminal event returns to a fully still avatar.
export function animateActivity(row) {
  const type = row.dataset.activity
  row.dataset.fresh = ''
  row.setAttribute('aria-live', 'polite')
  clearTimeout(row._activityTimer)
  if (type !== 'processing') row._activityTimer = setTimeout(() => {
    delete row.dataset.fresh
    row.classList.remove('activity-enter')
  }, 1450)
}
