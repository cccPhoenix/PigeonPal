import { buildCalendarItems, shanghaiDate, shanghaiTime } from '../services/calendar.js'
import { cleanHomework, homeworkTime } from '../services/homework.js'
import { escapeHtml } from './format.js'
import { icon } from './icons.js'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const monthOf = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '') ? value : null

export function calendarDetailHTML(item, state) {
  const kind = ({ homework: '作业', notice: '通知提醒', reminder: '提醒', personal: '我的待办' })[item.kind] || '日历事项'
  const line = (label, value) => value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : ''
  const dateLabel = item.kind === 'homework' ? '截止日期' : item.kind === 'reminder' ? '提醒时间' : '事项日期'
  let lines = line(dateLabel, `${item.date}${item.time ? ` ${item.time}` : ''}`)
    + line('来源', item.source) + line('日历状态', item.completed ? '已完成' : '待完成')
  let description = ''
  if (item.kind === 'homework') {
    const homework = cleanHomework(state.homeworkItems?.[item.noticeId]?.homework)
    lines += line('提交状态', ({ submitted: '已提交', not_submitted: '未提交', unknown: '原站未说明' })[homework.submissionStatus])
      + line('开放时间', homework.openAt ? homeworkTime(homework.openAt) : '')
      + line('作业状态', homework.isClosed === true ? '已结束' : '')
  } else if (item.kind === 'notice') {
    const notice = state.notices?.[item.noticeId]
    lines += line('提醒时间', Number.isFinite(item.reminderAt) ? `${shanghaiDate(item.reminderAt)} ${shanghaiTime(item.reminderAt)}` : '')
      + line('地点', notice?.where)
      + line('适用对象', notice?.audience?.join('、'))
    description = notice?.summary || notice?.notes?.join('；') || ''
  }
  return `<div class="calendar-detail-head"><h3>事项详情</h3><button class="icon-btn flat" type="button" data-x="close" aria-label="关闭事项详情">${icon('close', 18)}</button></div><span class="calendar-detail-kind">${escapeHtml(kind)}</span>
<h4 class="calendar-detail-title">${escapeHtml(item.title)}</h4>
<dl class="calendar-detail-list">${lines}</dl>
${description ? `<div class="note">${escapeHtml(description)}</div>` : ''}`
}

export function createCalendar({ root, store, onAdd, onOpen }) {
  let month = shanghaiDate(Date.now()).slice(0, 7)

  function setMonth(value) {
    const next = monthOf(value?.slice(0, 7))
    if (!next) return
    const page = next > month ? 'next' : next < month ? 'previous' : ''
    month = next
    render(page)
  }

  function moveMonth(amount) {
    const [year, index] = month.split('-').map(Number)
    const next = new Date(Date.UTC(year, index - 1 + amount, 1))
    month = next.toISOString().slice(0, 7)
    render(amount > 0 ? 'next' : 'previous')
  }

  function render(page = '') {
    const previousScroll = root.querySelector?.('.calendar-scroll')
    const scrollLeft = previousScroll?.scrollLeft || 0
    const scrollTop = previousScroll?.scrollTop || 0
    const dayScroll = new Map([...(root.querySelectorAll?.('.calendar-day') || [])]
      .map(cell => [cell.dataset.date, cell.querySelector?.('.calendar-tasks')?.scrollTop || 0]))
    const [year, index] = month.split('-').map(Number)
    const first = new Date(Date.UTC(year, index - 1, 1))
    const offset = (first.getUTCDay() + 6) % 7
    const days = new Date(Date.UTC(year, index, 0)).getUTCDate()
    const count = Math.ceil((offset + days) / 7) * 7
    const today = shanghaiDate(Date.now())
    const byDate = new Map()
    for (const item of buildCalendarItems(store.state)) {
      if (!byDate.has(item.date)) byDate.set(item.date, [])
      byDate.get(item.date).push(item)
    }
    const cells = Array.from({ length: count }, (_, i) => {
      const date = new Date(Date.UTC(year, index - 1, i - offset + 1)).toISOString().slice(0, 10)
      const inMonth = date.startsWith(month)
      const day = Number(date.slice(-2))
    const tasks = (byDate.get(date) || []).map(item => `<div class="calendar-task${item.completed ? ' completed' : ''}" data-kind="${item.kind}" data-calendar-item="${escapeHtml(item.id)}">
  <input type="checkbox" data-calendar-check="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.completed ? '标记未完成：' : '标记完成：')}${escapeHtml(item.title)}"${item.completed ? ' checked' : ''}>
  <button type="button" class="calendar-task-open" data-calendar-open="${escapeHtml(item.id)}" title="${escapeHtml(`${item.source} · ${item.title}`)}" aria-label="查看${escapeHtml(item.title)}的详情"><span class="calendar-task-text">${item.time ? `<span class="calendar-task-time">${escapeHtml(item.time)}</span>` : ''}<span class="calendar-task-title">${escapeHtml(item.title)}</span></span></button>
</div>`).join('')
      return `<td class="calendar-day${inMonth ? '' : ' outside'}${date === today ? ' today' : ''}" data-date="${date}"><div class="calendar-day-head"><button type="button" class="calendar-day-number" data-calendar-day="${date}" aria-label="${escapeHtml(date)}，添加事项">${day}</button><button type="button" class="calendar-day-add" data-calendar-day="${date}" aria-label="在${escapeHtml(date)}添加事项" title="添加事项">${icon('plus', 14)}</button></div><div class="calendar-tasks">${tasks}</div></td>`
    })
    const weeks = Array.from({ length: count / 7 }, (_, i) => `<tr>${cells.slice(i * 7, i * 7 + 7).join('')}</tr>`).join('')
    root.innerHTML = `<div class="calendar-top"><div><h2>日历</h2><p>作业截止与我的待办</p></div><button class="calendar-add" type="button" data-calendar-add="${today}">${icon('plus', 16)}添加事项</button></div>
<div class="calendar-toolbar"><div class="calendar-month">${year} 年 ${index} 月</div><div class="calendar-controls"><button type="button" data-calendar-nav="-1" aria-label="上个月">${icon('chevron', 17)}</button><button type="button" data-calendar-nav="today">今天</button><button type="button" data-calendar-nav="1" aria-label="下个月">${icon('chevron', 17)}</button></div></div>
<div class="calendar-scroll"><table class="calendar-table"${page ? ` data-page="${page}"` : ''}><caption class="sr">${year} 年 ${index} 月日历</caption><thead><tr>${WEEKDAYS.map(day => `<th scope="col">周${day}</th>`).join('')}</tr></thead><tbody>${weeks}</tbody></table></div>`
    const nextScroll = root.querySelector?.('.calendar-scroll')
    if (nextScroll) { nextScroll.scrollLeft = scrollLeft; nextScroll.scrollTop = scrollTop }
    for (const cell of root.querySelectorAll?.('.calendar-day') || []) {
      const tasks = cell.querySelector?.('.calendar-tasks')
      if (tasks) tasks.scrollTop = dayScroll.get(cell.dataset.date) || 0
    }
  }

  root.addEventListener('click', event => {
    if (event.target.closest?.('[data-calendar-check]')) return
    const nav = event.target.closest?.('[data-calendar-nav]')
    if (nav) return nav.dataset.calendarNav === 'today' ? setMonth(shanghaiDate(Date.now())) : moveMonth(Number(nav.dataset.calendarNav))
    const open = event.target.closest?.('[data-calendar-open], [data-calendar-item]')
    if (open) {
      const item = buildCalendarItems(store.state).find(row => row.id === (open.dataset.calendarOpen || open.dataset.calendarItem))
      if (item) onOpen?.(item, open.querySelector?.('[data-calendar-open]') || open)
      return
    }
    const add = event.target.closest?.('[data-calendar-add], [data-calendar-day]')
    if (add) onAdd?.(add.dataset.calendarAdd || add.dataset.calendarDay, add)
  })
  root.addEventListener('change', event => {
    const check = event.target.closest?.('[data-calendar-check]')
    if (!check) return
    store.setCalendarCompleted(check.dataset.calendarCheck, check.checked)
    const id = check.dataset.calendarCheck
    const next = [...root.querySelectorAll('[data-calendar-check]')].find(node => node.dataset.calendarCheck === id)
    next?.focus()
  })

  return { render, setMonth, get month() { return month } }
}
