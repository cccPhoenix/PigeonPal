import { buildCalendarItems, shanghaiDate, shanghaiTime } from '../services/calendar.js'
import { cleanHomework, homeworkTime } from '../services/homework.js'
import { escapeHtml } from './format.js'
import { icon } from './icons.js'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const monthOf = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '') ? value : null

export function calendarDetailHTML(item, state) {
  const reminder = item.reminderId && state.reminders.find(row => row.id === item.reminderId)
  const kind = ({ homework: '作业', notice: '通知提醒', reminder: '提醒', personal: '我的待办' })[item.kind] || '日历事项'
  const line = (label, value) => value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : ''
  const dateLabel = item.kind === 'homework' ? item.calendarOverride ? '日历日期' : '截止日期'
    : item.kind === 'reminder' || reminder && item.date === shanghaiDate(reminder.dueAt) && item.time === shanghaiTime(reminder.dueAt)
      ? '提醒时间' : '事项日期'
  let lines = line(dateLabel, `${item.date}${item.time ? ` ${item.time}` : ''}`)
    + line('来源', item.source) + line(reminder ? '提醒状态' : '日历状态', reminder
      ? ({ pending: '待提醒', done: '已完成', cancelled: '已取消' })[reminder.status]
      : item.completed ? '已完成' : '待完成')
  let description = ''
  if (item.kind === 'homework') {
    const homework = cleanHomework(state.homeworkItems?.[item.noticeId]?.homework)
    lines += line('原截止日期', item.calendarOverride ? homeworkTime(homework.deadlineAt) : '')
      + line('提交状态', ({ submitted: '已提交', not_submitted: '未提交', unknown: '原站未说明' })[homework.submissionStatus])
      + line('开放时间', homework.openAt ? homeworkTime(homework.openAt) : '')
      + line('作业状态', homework.isClosed === true ? '已结束' : '')
  } else if (item.kind === 'notice') {
    const notice = state.notices?.[item.noticeId]
    lines += line('提醒时间', Number.isFinite(item.reminderAt) && (item.date !== shanghaiDate(item.reminderAt) || item.time !== shanghaiTime(item.reminderAt))
      ? `${shanghaiDate(item.reminderAt)} ${shanghaiTime(item.reminderAt)}` : '')
      + line('地点', notice?.where)
      + line('适用对象', notice?.audience?.join('、'))
    description = notice?.summary || notice?.notes?.join('；') || ''
  }
  return `<div class="calendar-detail-head"><h3>事项详情</h3><button class="icon-btn flat" type="button" data-x="close" aria-label="关闭事项详情">${icon('close', 18)}</button></div><span class="calendar-detail-kind">${escapeHtml(kind)}</span>
<h4 class="calendar-detail-title">${escapeHtml(item.title)}</h4>
<dl class="calendar-detail-list">${lines}</dl>
${description ? `<div class="note">${escapeHtml(description)}</div>` : ''}
<div class="btns calendar-detail-actions"><button class="btn" type="button" data-calendar-edit>修改</button><button class="btn primary" type="button" data-calendar-completion="${item.completed ? 'false' : 'true'}">${item.completed ? '标记未完成' : '标记完成'}</button>${reminder && reminder.status !== 'cancelled' ? '<button class="btn" type="button" data-calendar-cancel-reminder>取消提醒</button>' : ''}</div>`
}

export function localDateTime(at) {
  return `${shanghaiDate(at)}T${shanghaiTime(at)}`
}

export function calendarEditHTML(item, state) {
  const reminder = item.reminderId && state.reminders.find(row => row.id === item.reminderId)
  const help = item.kind === 'homework' ? '仅修改本机日历中的显示，课程原截止时间不会改变。'
    : item.kind === 'reminder' ? '修改提醒时间会重新开启提醒。'
      : reminder ? '日历日期和提醒时间可以分别调整。' : '修改后会同步更新日历与事项列表。'
  return `<h3>修改事项</h3><p>${help}</p>
<div class="field"><label for="calendar-edit-title">事项</label><input class="input" id="calendar-edit-title" data-edit="title" maxlength="80" value="${escapeHtml(item.title)}"></div>
<div class="field"><label for="calendar-edit-date">${item.kind === 'reminder' ? '提醒日期' : '日历日期'}</label><input class="input" id="calendar-edit-date" data-edit="date" type="date" value="${escapeHtml(item.date)}"></div>
<div class="field"><label for="calendar-edit-time">${item.kind === 'reminder' ? '提醒时间' : '时间（可选）'}</label><input class="input" id="calendar-edit-time" data-edit="time" type="time" value="${escapeHtml(item.time || '')}"></div>
${reminder && item.kind !== 'reminder' ? `<div class="field"><label for="calendar-edit-reminder">提醒时间</label><input class="input" id="calendar-edit-reminder" data-edit="reminder" type="datetime-local" value="${localDateTime(reminder.dueAt)}"></div>` : ''}
<div class="btns"><button class="btn" type="button" data-edit-action="cancel">取消</button><button class="btn primary" type="button" data-edit-action="save">保存修改</button></div>`
}

export function createCalendar({ root, store, onAdd, onOpen, onReminderStatus }) {
  let month = shanghaiDate(Date.now()).slice(0, 7)
  let remindersOpen = false
  let reminderHeight = 150
  const minReminderHeight = 88
  const maxReminderHeight = () => Math.max(minReminderHeight, (Number.isFinite(root.clientHeight) ? root.clientHeight : 700) - 260)
  const setReminderHeight = value => {
    reminderHeight = Math.max(minReminderHeight, Math.min(maxReminderHeight(), Math.round(value)))
    root.style?.setProperty('--calendar-reminder-height', `${reminderHeight}px`)
    const splitter = root.querySelector?.('[data-calendar-splitter]')
    splitter?.setAttribute('aria-valuemax', String(maxReminderHeight()))
    splitter?.setAttribute('aria-valuenow', String(reminderHeight))
  }

  function setRemindersOpen(open) {
    remindersOpen = Boolean(open)
    if (root.dataset) root.dataset.remindersOpen = String(remindersOpen)
    const toggle = root.querySelector?.('[data-calendar-reminders-toggle]')
    toggle?.setAttribute('aria-expanded', String(remindersOpen))
    const panel = root.querySelector?.('.calendar-reminder-panel')
    if (panel) { panel.inert = !remindersOpen; panel.setAttribute('aria-hidden', String(!remindersOpen)) }
    const splitter = root.querySelector?.('[data-calendar-splitter]')
    if (splitter) splitter.tabIndex = remindersOpen ? 0 : -1
    if (remindersOpen) setReminderHeight(reminderHeight)
  }

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
    const reminderScroll = root.querySelector?.('.calendar-reminder-list')?.scrollTop || 0
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
    const items = buildCalendarItems(store.state)
    for (const item of items) {
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
    const reminderRow = item => `<div class="calendar-reminder-row${item.completed ? ' completed' : ''}">
  <input type="checkbox" data-calendar-check="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.completed ? '标记未完成：' : '标记完成：')}${escapeHtml(item.title)}"${item.completed ? ' checked' : ''}>
  <button type="button" class="calendar-reminder-open" data-calendar-open="${escapeHtml(item.id)}"><span class="calendar-reminder-name">${escapeHtml(item.title)}</span><span class="calendar-reminder-when">${escapeHtml(item.date)}${item.time ? ` ${escapeHtml(item.time)}` : ''} · ${escapeHtml(item.source)}</span></button></div>`
    root.innerHTML = `<div class="calendar-top"><div><h2>日历</h2><p>作业截止、提醒与我的待办</p></div><div class="calendar-top-actions"><button class="calendar-reminder-toggle" type="button" data-calendar-reminders-toggle aria-controls="calendar-reminder-panel" aria-expanded="${remindersOpen}">${icon('itemList', 16)}事项列表</button><button class="calendar-add" type="button" data-calendar-add="${today}">${icon('plus', 16)}添加事项</button></div></div>
<div class="calendar-reminder-zone"><section class="calendar-reminder-panel" id="calendar-reminder-panel" aria-label="已添加的日历和提醒事项"><div class="calendar-reminder-head"><strong>已添加的事项</strong><span>${items.length} 项</span></div><div class="calendar-reminder-list">${items.length ? items.map(reminderRow).join('') : '<p class="muted">还没有添加到日历或提醒的事项</p>'}</div></section><div class="calendar-reminder-splitter" data-calendar-splitter role="separator" tabindex="${remindersOpen ? 0 : -1}" aria-label="调整提醒栏高度" aria-orientation="horizontal" aria-valuemin="${minReminderHeight}" aria-valuemax="${maxReminderHeight()}" aria-valuenow="${reminderHeight}"><span class="calendar-reminder-grip" aria-hidden="true"></span></div></div>
<div class="calendar-toolbar"><div class="calendar-month">${year} 年 ${index} 月</div><div class="calendar-controls"><button type="button" data-calendar-nav="-1" aria-label="上个月">${icon('chevron', 17)}</button><button type="button" data-calendar-nav="today">今天</button><button type="button" data-calendar-nav="1" aria-label="下个月">${icon('chevron', 17)}</button></div></div>
<div class="calendar-scroll"><table class="calendar-table"${page ? ` data-page="${page}"` : ''}><caption class="sr">${year} 年 ${index} 月日历</caption><thead><tr>${WEEKDAYS.map(day => `<th scope="col">周${day}</th>`).join('')}</tr></thead><tbody>${weeks}</tbody></table></div>`
    setRemindersOpen(remindersOpen)
    const nextReminderList = root.querySelector?.('.calendar-reminder-list')
    if (nextReminderList) nextReminderList.scrollTop = reminderScroll
    const nextScroll = root.querySelector?.('.calendar-scroll')
    if (nextScroll) { nextScroll.scrollLeft = scrollLeft; nextScroll.scrollTop = scrollTop }
    for (const cell of root.querySelectorAll?.('.calendar-day') || []) {
      const tasks = cell.querySelector?.('.calendar-tasks')
      if (tasks) tasks.scrollTop = dayScroll.get(cell.dataset.date) || 0
    }
  }

  root.addEventListener('click', event => {
    if (event.target.closest?.('[data-calendar-check]')) return
    const toggle = event.target.closest?.('[data-calendar-reminders-toggle]')
    if (toggle) return setRemindersOpen(!remindersOpen)
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
  root.addEventListener('change', async event => {
    const check = event.target.closest?.('[data-calendar-check]')
    if (!check) return
    const item = buildCalendarItems(store.state).find(row => row.id === check.dataset.calendarCheck)
    if (item?.reminderId) await onReminderStatus?.(item.reminderId, check.checked ? 'done' : 'pending')
    else store.setCalendarCompleted(check.dataset.calendarCheck, check.checked)
    const id = check.dataset.calendarCheck
    const next = [...root.querySelectorAll('[data-calendar-check]')].find(node => node.dataset.calendarCheck === id)
    next?.focus()
  })

  let drag = null
  root.addEventListener('pointerdown', event => {
    const splitter = event.target.closest?.('[data-calendar-splitter]')
    if (!splitter || !remindersOpen || event.pointerType === 'mouse' && event.button !== 0) return
    drag = { pointerId: event.pointerId, y: event.clientY, height: reminderHeight }
    splitter.setPointerCapture?.(event.pointerId)
    root.dataset.calendarResizing = 'true'
    event.preventDefault()
  })
  root.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    setReminderHeight(drag.height + event.clientY - drag.y)
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(type, event => {
    if (drag?.pointerId !== event.pointerId) return
    drag = null
    delete root.dataset.calendarResizing
  })
  root.addEventListener('dblclick', event => {
    if (event.target.closest?.('[data-calendar-splitter]')) setReminderHeight(150)
  })
  root.addEventListener('keydown', event => {
    if (!event.target.closest?.('[data-calendar-splitter]')) return
    const delta = { ArrowUp: -16, ArrowDown: 16 }[event.key]
    if (delta === undefined && event.key !== 'Home') return
    setReminderHeight(event.key === 'Home' ? 150 : reminderHeight + delta)
    event.preventDefault()
  })

  return { render, setMonth, setRemindersOpen, get month() { return month } }
}
