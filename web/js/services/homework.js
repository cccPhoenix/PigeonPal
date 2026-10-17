import { escapeHtml } from '../ui/format.js'

// Homework uses official structured fields directly; it never needs an AI result.
export const isHomework = item => item?.sourceId === 'xzzd' || item?.kind === 'homework'

const cleanText = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : ''
const cleanId = value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value).slice(0, 80) : ''
const validDate = value => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}
const cleanTime = value => {
  if (typeof value !== 'string') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDate(value) ? value : null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  return validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? value : null
}

export function cleanHomework(value) {
  const row = value && typeof value === 'object' ? value : {}
  return {
    activityId: cleanId(row.activityId), courseId: cleanId(row.courseId),
    courseName: cleanText(row.courseName, 500), courseCode: cleanText(row.courseCode, 100),
    openAt: cleanTime(row.openAt), deadlineAt: cleanTime(row.deadlineAt),
    submissionStatus: ['not_submitted', 'submitted', 'unknown'].includes(row.submissionStatus) ? row.submissionStatus : 'unknown',
    isClosed: typeof row.isClosed === 'boolean' ? row.isClosed : null,
  }
}

export function homeworkTime(value) {
  const at = cleanTime(value)
  if (!at) return '原站未说明'
  if (!at.includes('T')) return `${at}（原站仅提供日期）`
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const part = name => parts.find(row => row.type === name)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}（北京时间）`
}

export function homeworkCopy(item) {
  const row = cleanHomework(item?.homework)
  const status = ({ submitted: '已提交', not_submitted: '未提交', unknown: '提交状态未知' })[row.submissionStatus]
  return `【作业】\n课程：${row.courseName || '原站未说明课程'}${row.courseCode ? `（${row.courseCode}）` : ''}\n任务：${item?.title || '原站未说明作业名称'}\n截止：${homeworkTime(row.deadlineAt)}\n状态：${status}${row.isClosed === true ? '；作业已结束' : ''}`
}

const safeLink = value => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function homeworkDetailHTML(item, detail = {}) {
  const current = { ...item, title: detail.title || item.title, homework: detail.homework || item.homework }
  const metadata = cleanHomework(current.homework)
  const url = safeLink(detail.url || item.url)
  const attachments = (Array.isArray(detail.attachments) ? detail.attachments : []).map(row => {
    const href = safeLink(row?.url)
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name || '附件')}</a>` : ''
  }).filter(Boolean)
  const emptyBody = detail.state === 'pending'
    ? '作业要求正在按队列采集中，可先打开官方入口。'
    : detail.state === 'failed'
      ? detail.lastError === 'homework_access_denied'
        ? '该作业详情暂不可访问，可先打开官方作业入口查看。'
        : '作业详情读取失败，请稍后重试，也可先打开官方作业入口查看。'
      : '原站未提供文字要求，请查看附件或打开官方作业入口。'
  const body = typeof detail.content === 'string' && detail.content.trim() ? detail.content : emptyBody
  return `<h3>作业详情</h3><div class="note">${escapeHtml(homeworkCopy(current)).replace(/\n/g, '<br>')}</div>
${metadata.openAt ? `<p>开放：${escapeHtml(homeworkTime(metadata.openAt))}</p>` : ''}
<details class="notice-body" open><summary>作业要求</summary><div>${escapeHtml(body).replace(/\n/g, '<br>')}</div></details>
${attachments.length ? `<div class="note">附件：${attachments.join('、')}</div>` : ''}
<div class="btns">${url ? `<a class="btn primary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-grid;place-items:center;text-decoration:none">打开官方作业入口</a>` : '<span class="muted">官方作业入口暂不可用</span>'}<button class="btn" data-x="close">好的</button></div>`
}
