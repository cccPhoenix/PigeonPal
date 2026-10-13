export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Bot copy can address the user: {nickname} and {name} are filled in at render time,
// so changing the nickname updates old messages too.
export function personalize(text, profile) {
  const nickname = profile.nickname?.trim() || '同学'
  return String(text ?? '').replaceAll('{nickname}', nickname).replaceAll('{name}', profile.botName)
}
export const richText = (text, profile) => escapeHtml(personalize(text, profile)).replace(/\n/g, '<br>')

const pad = n => String(n).padStart(2, '0')
export const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

function dayDiff(at, now = Date.now()) {
  const a = new Date(at); a.setHours(0, 0, 0, 0)
  const b = new Date(now); b.setHours(0, 0, 0, 0)
  return Math.round((a - b) / 86_400_000)
}

export function dayLabel(at, now = Date.now()) {
  const diff = dayDiff(at, now)
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === 1) return '明天'
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// "今天 07:18" for transcript dividers and reminders.
export const whenLabel = (at, now = Date.now()) => `${dayLabel(at, now)} ${clock(at)}`

// Sidebar: a time today, a day otherwise.
export function shortTime(at, now = Date.now()) {
  const diff = dayDiff(at, now)
  return diff === 0 ? clock(at) : diff === -1 ? '昨天' : dayLabel(at, now)
}

export const plain = (text, profile) => personalize(text, profile).replace(/\s+/g, ' ').trim()
