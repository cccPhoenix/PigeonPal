import { Marked, Renderer } from '../vendor/marked/marked.esm.js'

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Bot copy can address the user: {nickname} and {name} are filled in at render time,
// so changing the nickname updates old messages too.
export function personalize(text, profile) {
  const nickname = profile.nickname?.trim() || '同学'
  return String(text ?? '').replaceAll('{nickname}', nickname).replaceAll('{name}', profile.botName)
}
function safeLink(href) {
  if (typeof href !== 'string' || /[\u0000-\u001f\u007f]/.test(href) || !/^(https?:\/\/|mailto:)/i.test(href.trim())) return null
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

// Only the parser's fixed Markdown tags become markup. Raw HTML stays text;
// links use approved schemes and images do not initiate background requests.
const markdown = new Marked({ gfm: true, breaks: true, async: false, renderer: {
  html({ text }) { return escapeHtml(text).replace(/\n/g, '<br>') },
  link({ href, title, tokens, text }) {
    const label = tokens ? this.parser.parseInline(tokens) : escapeHtml(text)
    const url = safeLink(href)
    if (!url) return label
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`
  },
  image({ href, text }) {
    const label = escapeHtml(`图片：${text || '查看图片'}`)
    const url = safeLink(href)
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label
  },
  code(token) { return Renderer.prototype.code.call(this, token).replace('<pre>', '<pre tabindex="0">') },
  table(token) { return `<div class="md-table" role="region" aria-label="表格" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>` },
} })

export function richText(text, profile = {}) {
  const source = personalize(text, profile)
  try { return markdown.parse(source) }
  catch { return escapeHtml(source).replace(/\n/g, '<br>') }
}

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
