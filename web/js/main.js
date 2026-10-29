import { connectDesktop } from './services/desktop.js'
import { createStore } from './store.js'
import { newId, pendingReminders } from './reminders.js'
import { markHTML, setMarkState, startGaze } from './mark/index.js'
import { createAIChat, buildChatHistory, GREETING } from './services/chat.js'
import { startFeed, localAdapters, headsUp, eventPhrase, NOTICE_CATEGORIES, LOCAL_CHANNELS } from './services/sources.js'
import { analysisFields, decisionCopy } from './services/notice-summary.js'
import { homeworkDetailHTML, isHomework, homeworkReminderMessage } from './services/homework.js'
import { systemNotify } from './services/scheduler.js'
import { createIconRail } from './ui/dock.js'
import { createHeader } from './ui/header.js'
import { createTranscript } from './ui/transcript.js'
import { createComposer } from './ui/composer.js'
import { createRail } from './ui/rail.js'
import { createCalendar, calendarDetailHTML } from './ui/calendar.js'
import { shanghaiDate, validCalendarDate, validCalendarTime } from './services/calendar.js'
import { createSplitter, watchNoticeWidth, NOTICE_MIN, CALENDAR_MIN } from './ui/splitter.js'
import { lookHue, imageHue } from './ui/palette.js'
import { openSettings } from './ui/settings.js'
import { createAuthClient } from './services/auth.js'
import { openIdentityAuth as showIdentityAuth } from './ui/auth.js'
import { createApiClient, apiErrorText } from './services/api.js'
import { openApiSettings as showApiSettings } from './ui/api-settings.js'
import { openUserProfile as showUserProfile } from './ui/user-profile.js'
import { noticePushable, deliveryTransition } from './services/recommendations.js'
import { noticeUnreadCount, noticeDeleted } from './services/notice-list.js'
import { popover, dialog, closeOverlay, overlayFor, toast } from './ui/overlays.js'
import { icon } from './ui/icons.js'
import { escapeHtml, plain, whenLabel, clock, personalize } from './ui/format.js'

// ---------------------------------------------------------------- services
const apiClient = createApiClient()
const services = {
  chat: createAIChat(apiClient),
  sources: localAdapters(apiClient),
  feedInterval: 5000,
}

const store = createStore()
const $ = id => document.getElementById(id)
const app = $('app')
const identityClient = createAuthClient()
const sourceStates = new Map()
const localSourceIds = new Set(LOCAL_CHANNELS.map(channel => channel.sourceId))
let aiStatus = null
let sourceStatusError = false
let sourceRefresh = null

async function refreshSourceStates() {
  if (sourceRefresh) return sourceRefresh
  sourceRefresh = Promise.all([identityClient.sources(), apiClient.status()]).then(([sources, ai]) => {
    aiStatus = ai
    sourceStatusError = false
    for (const source of sources) if (source && localSourceIds.has(source.id)) sourceStates.set(source.id, source)
  }).catch(() => { sourceStatusError = true }).finally(() => { sourceRefresh = null })
  return sourceRefresh
}

function openIdentityAuth(opener) {
  showIdentityAuth({ client: identityClient, opener, onChange: refreshSourceStates })
}

function openApiSettings(opener) {
  showApiSettings({ client: apiClient, opener, onChange: refreshSourceStates })
}

function refreshRecommendations() {
  sourcesFeed.refresh()
  // A profile update can finish while another source request is in flight.
  setTimeout(() => sourcesFeed.refresh(), 800)
}

function openUserProfile() {
  closeOverlay()
  setView('user-profile')
}

function sourceStateLabel(sourceId) {
  if (sourceStatusError) return '本机服务暂时不可用'
  const state = sourceStates.get(sourceId)?.state
  return ({ idle: '等待下次检查', ready: '正常采集', ok: '正常采集', success: '正常采集', active: '正常采集', running: '正在采集', crawling: '正在采集', partial: '部分正文待补齐', interrupted: '上次采集中断', auth_required: '待认证', auth_expired: '认证已失效', authenticating: '正在认证', error: '采集暂时异常', backoff: '稍后重试', paused: '已暂停', network_error: '网络暂时不可用' })[state] || (state ? '等待检查' : '正在读取状态…')
}

let active = 'bot'

// ------------------------------------------------------------------ chrome
let paletteLook = null
let paletteImage = null
let paletteRun = 0
function applyPrefs() {
  const p = store.state.profile
  if (p.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = p.theme
  document.documentElement.dataset.motion = p.motion
  document.documentElement.style.setProperty('--w-chat', `${p.chatW}px`)
  if (p.look !== paletteLook || p.image !== paletteImage) {
    paletteLook = p.look
    paletteImage = p.image
    const run = ++paletteRun
    document.documentElement.style.setProperty('--look-hue', String(lookHue(p.look)))
    if (p.look === 'image' && p.image) imageHue(p.image).then(hue => {
      if (run === paletteRun && hue !== null) document.documentElement.style.setProperty('--look-hue', String(hue))
    })
  }
  document.title = `${p.botName} · PigeonPal`
}

const noticeView = $('notice')
let profilePage = null

function setView(view, { acknowledge = true } = {}) {
  if (view !== 'user-profile' && profilePage) { profilePage.destroy(); profilePage = null }
  app.style.setProperty('--min-notice', `${view === 'calendar' ? CALENDAR_MIN : NOTICE_MIN}px`)
  noticeView.dataset.view = view
  noticeView.setAttribute('aria-label', view === 'homework' ? '学在浙大作业' : view === 'calendar' ? '日历' : view === 'user-profile' ? '用户画像' : '通知')
  $('pane-calendar').hidden = view !== 'calendar'
  $('pane-user-profile').hidden = view !== 'user-profile'
  if (view === 'calendar') calendar.render()
  if (view === 'user-profile' && !profilePage) profilePage = showUserProfile({ root: $('pane-user-profile'), client: apiClient, onChange: refreshRecommendations })
  if (view === 'notice' || view === 'homework') rail.setView(view)
  dock.setView(view)
  if (narrowChat()) toggleChat(false)
  if (view === 'notice' && acknowledge && !rail.trash) markNoticeRead(rail.filter)
  if (view === 'homework' && acknowledge) store.markRead('src-xzzd')
}

const dock = createIconRail({
  root: $('dock-nav'), store,
  onView: setView,
  onBot: () => { select('bot'); dock.setView('chat'); if (narrowChat()) toggleChat(true); else composer.focus() },
  onHomework: () => { select('src-xzzd'); setView('homework') },
  onMe: openMeMenu,
  onAddSource: openAddSource,
  onSearch: openSearch,
})
const header = createHeader({ root: $('head'), store, onWho: openWho, onCloseChat: () => toggleChat(false) })
const transcript = createTranscript({ root: $('log'), jump: $('jump'), store, onAction })
const composer = createComposer({ root: $('dock'), store, onSend: send, onPlus: openPlusMenu })
const rail = createRail({
  listRoot: $('pane-list'), detailRoot: $('pane-detail'), store, client: apiClient,
  onRemind: (item, anchor) => openNoticeReminder(item, anchor),
  onAttach: n => composer.attachNotice(n.noticeId),
  onRead: markNoticeRead,
})
const calendar = createCalendar({ root: $('pane-calendar'), store, onAdd: openNewCalendarItem, onOpen: openCalendarItem })

const narrowChat = () => window.matchMedia('(max-width: 1099px)').matches
function markNoticeRead(sourceId = null) {
  store.markNoticesRead(sourceId)
}

createSplitter({
  handle: $('split'),
  get: () => $('chat').getBoundingClientRect().width,
  set: px => store.setProfile({ chatW: px }),
  getNoticeMin: () => noticeView.dataset.view === 'calendar' ? CALENDAR_MIN : NOTICE_MIN,
})

function toggleChat(open = app.dataset.chat !== 'open') {
  app.dataset.chat = open ? 'open' : ''
  $('chat-scrim').hidden = !open
}
$('chat-scrim').addEventListener('click', () => toggleChat(false))

function syncBadges() {
  dock.setUnread(noticeUnreadCount(store.state))
  dock.setChatUnread(store.state.unread.bot ?? 0)
  dock.setHomeworkUnread(store.state.unread['src-xzzd'] ?? 0)
}

function revealNotice(noticeId) {
  if (!store.notice(noticeId)) return
  setView('notice')
  rail.reveal(noticeId)
}

function select(id) {
  const c = store.channel(id)
  if (!c || (c.kind !== 'bot' && id !== 'src-xzzd')) return
  const changed = id !== active
  active = id
  if (changed || !transcript.channelId) { header.render(id); transcript.render(id) }
  store.markRead(id)
  composer.setPlaceholder(`给${id === 'bot' ? store.state.profile.botName : c.title}发消息`)
  if (pending.has(id)) transcript.showTyping()
  syncBadges()
}

// -------------------------------------------------------------- reactions
store.on('message', m => {
  transcript.append(m)
  if (m.channelId === active && document.visibilityState === 'visible') store.markRead(m.channelId)
})
store.on('homework-snapshot', ({ channelId }) => { transcript.syncHomeworkSnapshot(channelId); rail.render(); calendar.render(); syncBadges() })
store.on('unread', () => { rail.renderList(); syncBadges() })
store.on('message-updated', message => { transcript.refreshNotice(message); syncBadges() })
store.on('notice', e => {
  rail.onNotice(e); calendar.render(); syncBadges()
  if (e.recommendationChanged && store.state.messages[active]?.some(message => message.noticeHeadsUp && message.noticeId === e.item.noticeId)) transcript.render(active)
})
store.on('calendar', () => calendar.render())
store.on('channels', () => rail.renderList())
store.on('profile', patch => {
  applyPrefs()
  if (['look', 'image', 'botName', 'nickname'].some(k => k in patch)) {
    dock.render(); syncBadges()
    header.render(active, { animate: false })
    transcript.render(active)
  }
})
store.on('reminders', r => {
  if (!r) return
  calendar.render()
  for (const m of store.state.messages[active] ?? []) if (m.reminderId === r.id || m.id === r.noticeId || m.noticeId === r.noticeId || m.item?.noticeId === r.noticeId) transcript.patch(m.id)
  rail.patchRemindPill(r)
})
store.on('save-failed', () => toast('本地存储不可用，刷新后记录会丢失'))
store.on('reset', () => location.reload())
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.markRead(active) })

// Something new somewhere: the bot hops in the dock and the notice view lights up.
function announce(channelId, title, body) {
  const c = store.channel(channelId)
  if (!store.state.profile.proactive || c?.notify === 'mute') return
  const p = store.state.profile
  const now = clock(Date.now())
  const quiet = p.quietStart === p.quietEnd ? false : p.quietStart < p.quietEnd
    ? now >= p.quietStart && now < p.quietEnd : now >= p.quietStart || now < p.quietEnd
  if (quiet) return
  setMarkState(dock.mark(), 'alert')
  if (channelId !== 'bot') dock.bump()
  systemNotify(title, body)
}

// ------------------------------------------------------------------- chat
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pending = new Map() // channelId -> number of active reply streams
const queues = new Map()   // channelId -> { texts, quoteId, timer }

// Short messages sent in a burst get one reply, the way a person reads them.
function send(text, { quoteId, noticeId } = {}) {
  const ch = active
  store.addMessage(ch, { role: 'user', text, ...(quoteId ? { quoteId } : {}), ...(noticeId ? { noticeId } : {}) })
  const q = queues.get(ch) ?? { texts: [], timer: 0, requestId: newId('chat'), firstIndex: store.state.messages[ch].length - 1 }
  q.texts.push(text)
  if (quoteId) q.quoteId = quoteId
  if (noticeId) q.noticeId = noticeId
  clearTimeout(q.timer)
  q.timer = setTimeout(() => flush(ch), 900)
  queues.set(ch, q)
}

async function flush(ch) {
  if (pending.has(ch)) { queues.get(ch).timer = setTimeout(() => flush(ch), 600); return }
  const q = queues.get(ch)
  if (!q) return
  queues.delete(ch)
  const history = buildChatHistory(store.state.messages[ch].slice(0, q.firstIndex), store.state.profile, store.state.reminders)
  await run(ch, services.chat.respond({ text: q.texts.join('\n'), channelId: ch, state: store.state,
    requestId: q.requestId, quoteId: q.quoteId, noticeId: q.noticeId, history }))
}

// Plays a reply stream: typing, bubbles and actions, in order.
async function run(ch, stream) {
  if (!store.channel(ch)) ch = 'bot'
  pending.set(ch, (pending.get(ch) || 0) + 1)
  try {
    await sleep(350)
    for await (const event of stream) {
      if (event.type === 'typing') {
        if (ch === active) transcript.showTyping()
        await sleep(event.ms)
      } else if (event.type === 'message') {
        store.addMessage(ch, { role: 'bot', text: event.text, ...(event.kind === 'notice' && event.queryResult === true && isHomework(event.item) ? { kind: 'notice', queryResult: true, item: event.item } : {}), ...(event.localOnly === true ? { localOnly: true } : {}), ...(event.quoteId ? { quoteId: event.quoteId } : {}) }, { unread: ch !== active })
        await sleep(260)
      } else if (event.type === 'action') {
        applyAction(ch, event)
      }
    }
  } catch (error) {
    store.addMessage(ch, { role: 'bot', text: apiErrorText(error) }, { unread: ch !== active })
  } finally {
    const remaining = (pending.get(ch) || 1) - 1
    if (remaining) pending.set(ch, remaining)
    else pending.delete(ch)
    if (ch === active && !pending.has(ch)) transcript.hideTyping()
  }
}

function applyAction(ch, { name, args }) {
  if (name === 'user-profile.updated') refreshRecommendations()
  if (name === 'profile.update') store.setProfile({ nickname: args.nickname })
  if (name === 'reminder.upsert') store.syncReminders([args])
  if (name === 'calendar.upsert') {
    const item = store.upsertCalendarItem(args)
    if (noticeView.dataset.view === 'calendar') calendar.setMonth(item.date)
  }
}

// ------------------------------------------------------------ transcript
async function onAction(act, id, el) {
  try {
    const m = store.message(id)
    if (act === 'copy' && m) {
      const text = personalize(m.text, store.state.profile)
      navigator.clipboard?.writeText(text).then(() => toast('已复制'), () => toast('复制失败，可以手动选中文字'))
        ?? toast('复制失败，可以手动选中文字')
    }
    if (act === 'reply' && m) composer.setQuote(m)
    if (act === 'jump' && m) { if (m.channelId !== active) select(m.channelId); requestAnimationFrame(() => transcript.flash(m.id)) }
    if (act === 'goto-notice' && m) revealNotice(m.noticeId)
    if (act === 'open-notice' && m) return openNotice(m, el)
    if (act === 'remind-notice' && m?.item) return openNoticeReminder(m.item, el)
    if (act === 'reminder-done') {
      const { reminder: r } = await apiClient.updateReminder(id, { status: 'done' })
      store.syncReminders([r])
      run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', text: pickOne(['搞定！✌️', '棒～', '收到，辛苦啦 🎉']) } })())
    }
    if (act === 'reminder-snooze') {
      const { reminder: r } = await apiClient.updateReminder(id, { dueAt: Date.now() + 10 * 60_000 })
      store.syncReminders([r])
      run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', text: `好，${clock(r.dueAt)} 再叫你` } })())
    }
  } catch (error) { toast(apiErrorText(error)) }
}
const pickOne = list => list[Math.floor(Math.random() * list.length)]

async function openNotice(m, opener) {
  const item = m.item ?? {}
  const c = store.channel(m.channelId)
  let detail = null
  if (item.real && item.noticeId) {
    try { detail = await apiClient.notice(item.noticeId) } catch (error) { toast(apiErrorText(error)); return }
  }
  if (isHomework(item)) {
    const box = dialog(homeworkDetailHTML(item, detail || {}), { opener })
    box.classList.add('notice-dialog')
    box.querySelector('[data-x="close"]').addEventListener('click', closeOverlay)
    return
  }
  const current = detail ? { ...item, ...analysisFields(detail.analysis) } : item
  const box = dialog(`<h3>${item.real ? '通知详情' : escapeHtml(item.title)}</h3>
<p>${escapeHtml(c.emoji)} ${escapeHtml(c.title)} · ${escapeHtml(c.site)}</p>
${item.real ? `<div class="note">${escapeHtml(decisionCopy(current)).replace(/\n/g, '<br>')}</div><p class="muted">${escapeHtml(current.notes?.join('；') || '')}</p><p>原标题：${escapeHtml(detail?.title || item.title)}</p>` : `
<div class="card-meta" style="margin-bottom:12px">${item.eventAt ? `<div>${icon('clock', 15)}<span>${escapeHtml(eventPhrase(item.eventAt))}${item.eventEnd ? ` – ${clock(item.eventEnd)}` : ''}</span></div>` : ''}${item.where ? `<div>${icon('pin', 15)}<span>${escapeHtml(item.where)}</span></div>` : ''}</div>
<p class="note">${escapeHtml(item.summary ?? '')}</p>
${NOTICE_CATEGORIES[item.category] ? `<p>分类：${escapeHtml(NOTICE_CATEGORIES[item.category])}</p>` : ''}
${!item.eventAt && item.eventLabel ? `<p>活动日期：${escapeHtml(item.eventLabel)}</p>` : ''}
${item.deadlineAt ? `<p>截止日期／时间：${escapeHtml(item.deadlineAt.replace('T', ' '))}</p>` : ''}
${item.audience?.length ? `<p>适用对象：${escapeHtml(item.audience.join('、'))}</p>` : ''}
${item.todos?.length ? `<div class="note">${item.todos.map(todo => `<div>• ${escapeHtml(todo.text)}${todo.dueAt ? `（${escapeHtml(todo.dueAt)}）` : ''}</div>`).join('')}</div>` : ''}
${item.notes?.length ? `<p class="muted">${escapeHtml(item.notes.join('；'))}</p>` : ''}`}
${detail ? `<details class="notice-body"><summary>网页正文</summary><div>${escapeHtml(detail.content || '本机暂时没有正文，可以打开原网页查看。').replace(/\n/g, '<br>')}</div></details>` : ''}
${detail?.attachments?.length ? `<div class="note">附件：${detail.attachments.map(attachment => `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${escapeHtml(attachment.name || '附件')}</a>`).join('、')}</div>` : ''}
<div class="btns">${item.url ? `<a class="btn primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" style="display:inline-grid;place-items:center;text-decoration:none">打开原网页</a>` : '<span class="muted" style="margin-right:auto;align-self:center">示例来源，没有原网页</span>'}<button class="btn" data-x="close">好的</button></div>`, { opener })
  box.querySelector('[data-x="close"]').addEventListener('click', closeOverlay)
  if (item.real) box.classList.add('notice-dialog')
  if (item.real && detail?.state === 'complete' && typeof detail.content === 'string' && detail.content.trim()) {
    const retry = document.createElement('button')
    retry.className = 'btn'
    retry.textContent = '重新整理'
    box.querySelector('.btns').prepend(retry)
    retry.addEventListener('click', async () => {
      try { await apiClient.process(item.noticeId); toast('已加入整理队列') }
      catch (error) { toast(apiErrorText(error)) }
    })
  }
}

function openNoticeReminder(item, anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const channelId = store.state.channels.find(c => c.sourceId === item.sourceId)?.id ?? 'bot'
  const existing = store.state.reminders.find(r => r.noticeId === item.noticeId && r.status === 'pending')
  const deadline = typeof item.deadlineAt === 'string' && item.deadlineAt.includes('T')
    ? Date.parse(item.deadlineAt)
    : validCalendarDate(item.deadlineAt) ? Date.parse(`${item.deadlineAt}T23:59:00+08:00`) : null
  const references = [
    [Number.isFinite(item.eventAt) ? item.eventAt : null, '开始前'],
    [Number.isFinite(deadline) ? deadline : null, '截止前'],
  ].filter(([at]) => at !== null)
  const options = references.flatMap(([reference, before]) => [[15, `${before} 15 分钟`], [30, `${before} 30 分钟`],
    [60, `${before} 1 小时`], [24 * 60, `${before}一天`]].map(([min, label]) => [reference - min * 60_000, label]))
    .filter(([at]) => at > Date.now())
    .filter(([at], index, all) => all.findIndex(([other]) => other === at) === index)
  const pop = popover(anchor, `<div class="pop-title">什么时候叫你？</div>
${options.map(([at, label]) => `<button class="mi" data-at="${at}">${icon('bell', 16)}${label}<span class="hint">${escapeHtml(whenLabel(at))}</span></button>`).join('')}
<button class="mi" data-at="custom">${icon('clock', 16)}自定义提醒时间</button>
${existing ? `<div class="pop-sep"></div><button class="mi danger" data-at="cancel">${icon('close', 16)}取消提醒</button>` : ''}`, { place: 'below' })
  pop.addEventListener('click', async e => {
    const b = e.target.closest('[data-at]')
    if (!b) return
    closeOverlay()
    if (b.dataset.at === 'custom') return openNewReminder(anchor, {
      title: `「${item.title.slice(0, 35)}」`, channelId, noticeId: item.noticeId,
    })
    if (b.dataset.at === 'cancel') {
      try { const result = await apiClient.updateReminder(existing.id, { status: 'cancelled' }); store.syncReminders([result.reminder]) } catch (error) { return toast(apiErrorText(error)) }
      return toast('提醒已取消')
    }
    try {
      const { reminder: r } = await apiClient.createReminder({ title: `「${item.title.slice(0, 75)}」`, dueAt: Number(b.dataset.at), channelId, noticeId: item.noticeId })
      store.syncReminders([r])
      run('bot', (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', text: `好嘞～${whenLabel(r.dueAt)} 叫你 ⏰` } })())
    } catch (err) { toast(apiErrorText(err)) }
  })
}

// ------------------------------------------------------------------ menus
function openWho(anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const p = store.state.profile
  const c = store.channel(active)
  if (c.kind === 'bot') {
    const count = pendingReminders(store.state).length
    const pop = popover(anchor, `<div class="profile">
${markHTML({ look: p.look, image: p.look === 'image' ? p.image : null, size: 88, live: true, gaze: true, poke: true, label: p.botName })}
<h3>${escapeHtml(p.botName)}</h3><p>你的校园伙伴</p>
<dl class="kv"><dt>叫你</dt><dd>${escapeHtml(p.nickname || '还没告诉我')}</dd><dt>待办提醒</dt><dd>${count ? `${count} 条` : '没有'}</dd><dt>主动消息</dt><dd>${p.proactive ? '开启' : '关闭'}</dd></dl>
<div class="pills"><button class="pill" data-go="bot">${icon('sparkle', 15)}形象与称呼</button><button class="pill" data-go="reminders">${icon('bell', 15)}提醒</button></div>
</div>`, { className: 'profile-pop' })
    pop.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) openSettings(settingsApi, { page: b.dataset.go }) })
  } else {
    let stopped = false
    let timer = null
    const pop = popover(anchor, `<div class="profile">
<div class="ch-icon" style="--tint:${escapeHtml(c.tint)};width:64px;height:64px;border-radius:20px;font-size:32px;margin:4px auto 10px">${escapeHtml(c.emoji)}</div>
<h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(p.botName)}帮你盯着这个来源</p>
<dl class="kv"><dt>来源</dt><dd>${escapeHtml(c.site || '—')}</dd><dt>检查</dt><dd>${escapeHtml(c.every)}</dd><dt>通知</dt><dd>${c.notify === 'mute' ? '静音' : '有新消息就叫我'}</dd></dl>
${c.sourceId ? `<dl class="kv"><dt>采集状态</dt><dd data-source-state></dd><dt>${c.sourceId === 'xzzd' ? '本机作业' : '本机通知'}</dt><dd data-source-count></dd><dt>最近检查</dt><dd data-source-checked></dd><dt>${c.sourceId === 'xzzd' ? '模型整理' : '通知整理'}</dt><dd data-ai-state></dd></dl>` : ''}
<div class="pills">${c.requiresAuth ? `<button class="pill" data-identity>${icon('key', 15)}<span data-auth-label>去认证</span></button>` : ''}${c.sourceId && c.allowAi !== false ? `<button class="pill" data-api-settings>${icon('settings', 15)}API 设置</button>` : ''}<button class="pill" data-mute>${icon('bell', 15)}${c.notify === 'mute' ? '取消静音' : '静音'}</button></div>
</div>`, { onClose: () => { stopped = true; clearTimeout(timer) } })
    if (c.sourceId) {
      const drawSource = () => {
        if (stopped) return
        const source = sourceStates.get(c.sourceId)
        pop.querySelector('[data-source-state]').textContent = sourceStateLabel(c.sourceId)
        const count = Number.isSafeInteger(source?.totalCount) ? source.totalCount : null
        const complete = Number.isSafeInteger(source?.completeCount) ? source.completeCount : null
        const skipped = Number.isSafeInteger(source?.skippedCount) ? source.skippedCount : 0
        pop.querySelector('[data-source-count]').textContent = count === null ? '—' : c.sourceId === 'xzzd' ? `${count} 项作业` : `${count} 条${complete === null ? '' : ` · ${complete} 篇正文`}${skipped ? ` · ${skipped} 条仅链接` : ''}`
        const checked = new Date(source?.lastCheckedAt)
        pop.querySelector('[data-source-checked]').textContent = source?.lastCheckedAt && Number.isFinite(checked.getTime()) ? checked.toLocaleString('zh-CN', { hour12: false }) : '—'
        pop.querySelector('[data-ai-state]').textContent = c.allowAi === false ? '本地作业信息，无需模型' : !aiStatus?.configured ? '等待配置 API' : aiStatus.error
          ? apiErrorText({ code: aiStatus.error }) : aiStatus.counts?.processing ? '正在整理通知' : aiStatus.automatic ? '自动整理已开启' : '仅手动整理'
        const label = pop.querySelector('[data-auth-label]')
        if (label) label.textContent = !source || ['auth_required', 'auth_expired'].includes(source.state) ? '去认证' : '身份认证'
      }
      const pollSource = async () => { await refreshSourceStates(); if (stopped) return; drawSource(); timer = setTimeout(pollSource, 10_000) }
      drawSource()
      pollSource()
    }
    pop.addEventListener('click', e => {
      if (e.target.closest('[data-identity]')) return openIdentityAuth(anchor)
      if (e.target.closest('[data-api-settings]')) return openApiSettings(anchor)
      if (!e.target.closest('[data-mute]')) return
      store.setChannel(c.id, { notify: c.notify === 'mute' ? 'all' : 'mute' })
      closeOverlay()
      toast(c.notify === 'mute' ? '已静音，新消息只会安静地出现' : '好，有新消息我会叫你')
    })
  }
}

function openMeMenu(anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const p = store.state.profile
  const count = pendingReminders(store.state).length
  const pop = popover(anchor, `<div class="pop-title">${escapeHtml(p.nickname || '你好')}</div>
<button class="mi" data-go="reminders">${icon('bell', 16)}提醒<span class="hint">${count || ''}</span></button>
<button class="mi" data-go="bot">${icon('sparkle', 16)}形象与称呼</button>
<button class="mi" data-go="user-profile">${icon('graduate', 16)}用户画像</button>
<button class="mi" data-go="notify">${icon('rss', 16)}主动消息</button>
<button class="mi" data-go="auth">${icon('key', 16)}身份认证</button>
<button class="mi" data-go="api">${icon('settings', 16)}API 设置</button>
<button class="mi" data-go="look">${icon('image', 16)}外观</button>
<div class="pop-sep"></div>
<button class="mi" data-go="about">${icon('settings', 16)}关于与重置</button>`, { place: 'above' })
  pop.style.left = `${anchor.getBoundingClientRect().left}px`
  pop.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) openSettings(settingsApi, { page: b.dataset.go, opener: anchor }) })
}

function openPlusMenu(anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const pop = popover(anchor, `<button class="mi" data-x="reminder">${icon('bell', 16)}设一个提醒</button>
<button class="mi" data-x="source">${icon('rss', 16)}添加信息来源</button>`, { place: 'above' })
  pop.style.left = `${anchor.getBoundingClientRect().left}px`
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-x]')
    if (b?.dataset.x === 'reminder') openNewReminder(anchor)
    if (b?.dataset.x === 'source') openAddSource(anchor)
  })
}

function openNewReminder(opener, { title = '', channelId = 'bot', noticeId } = {}) {
  const soon = [['10 分钟后', 10], ['1 小时后', 60], ['今晚 21:00', 'tonight'], ['明早 08:00', 'morning']]
  const box = dialog(`<h3>设一个提醒</h3><p>到点了${escapeHtml(store.state.profile.botName)}会来叫你。</p>
<div class="field"><input class="input" data-f="title" placeholder="要做什么？" maxlength="40" value="${escapeHtml(title)}"></div>
<div class="chips">${soon.map(([l, v]) => `<button class="pill" data-soon="${v}">${l}</button>`).join('')}</div>
<div class="field"><input class="input" type="datetime-local" data-f="at"></div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">好</button></div>`, { opener })
  const at = box.querySelector('[data-f="at"]')
  const setAt = t => { const d = new Date(t); const pad = n => String(n).padStart(2, '0'); at.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
  setAt(Date.now() + 60 * 60_000)
  box.addEventListener('click', async e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.soon) {
      const d = new Date()
      if (b.dataset.soon === 'tonight') { d.setHours(21, 0, 0, 0); if (d <= Date.now()) d.setDate(d.getDate() + 1) }
      else if (b.dataset.soon === 'morning') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0) }
      else d.setTime(Date.now() + Number(b.dataset.soon) * 60_000)
      setAt(d)
      for (const x of box.querySelectorAll('[data-soon]')) x.classList.toggle('on', x === b)
    }
    if (b.dataset.x === 'cancel') closeOverlay()
    if (b.dataset.x === 'ok') {
      try {
        const title = box.querySelector('[data-f="title"]').value
        b.disabled = true
        const { reminder: r } = await apiClient.createReminder({ title, dueAt: new Date(at.value).getTime(), channelId, ...(noticeId ? { noticeId } : {}) })
        store.syncReminders([r])
        closeOverlay()
        if (active !== channelId) select(channelId)
        run(channelId, (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', text: `记下啦～${whenLabel(r.dueAt)} 叫你${r.title} ⏰` } })())
      } catch (err) { b.disabled = false; toast(apiErrorText(err)) }
    }
  })
}

function openNewCalendarItem(date = shanghaiDate(Date.now()), opener) {
  const box = dialog(`<h3>添加日历事项</h3><p>放进日历后，可以直接勾选完成。</p>
<div class="field"><label for="calendar-new-title">事项</label><input class="input" id="calendar-new-title" data-f="title" placeholder="要做什么？" maxlength="80"></div>
<div class="field"><label for="calendar-new-date">日期</label><input class="input" id="calendar-new-date" type="date" data-f="date" value="${escapeHtml(date)}"></div>
<div class="field"><label for="calendar-new-time">时间（可选）</label><input class="input" id="calendar-new-time" type="time" data-f="time"></div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">添加</button></div>`, { opener })
  box.addEventListener('click', e => {
    const button = e.target.closest?.('[data-x]')
    if (!button) return
    if (button.dataset.x === 'cancel') return closeOverlay()
    if (button.dataset.x !== 'ok') return
    const title = box.querySelector('[data-f="title"]').value.trim()
    const day = box.querySelector('[data-f="date"]').value
    const time = box.querySelector('[data-f="time"]').value
    if (!title) return toast('先写下要做的事')
    if (!validCalendarDate(day) || time && !validCalendarTime(time)) return toast('请检查日期和时间')
    store.upsertCalendarItem({ id: newId('cal'), title, date: day, time, completed: false })
    closeOverlay()
    calendar.setMonth(day)
    toast('已加入日历')
  })
}

function openCalendarItem(item, opener) {
  const box = dialog(calendarDetailHTML(item, store.state), { opener })
  box.classList.add('calendar-dialog')
  box.querySelector('[data-x="close"]').addEventListener('click', closeOverlay)
}

function openAddSource(opener) {
  const box = dialog(`<h3>添加信息来源</h3><p>告诉${escapeHtml(store.state.profile.botName)}想关注哪个网站。抓取还在接入中，先建好频道，接通后消息会自动出现。</p>
<div class="field"><input class="input" data-f="title" placeholder="频道名，比如：计算机学院" maxlength="16"></div>
<div class="field"><input class="input" data-f="site" placeholder="网址，比如：https://example.edu.cn/news" maxlength="200"></div>
<div class="chips">${['📰', '🏫', '🧪', '🏀', '🎵', '💼'].map(e => `<button class="pill" data-emoji="${e}">${e}</button>`).join('')}</div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">建好频道</button></div>`, { opener })
  let emoji = '📰'
  box.querySelector('[data-emoji]').classList.add('on')
  box.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.emoji) { emoji = b.dataset.emoji; for (const x of box.querySelectorAll('[data-emoji]')) x.classList.toggle('on', x === b) }
    if (b.dataset.x === 'cancel') closeOverlay()
    if (b.dataset.x === 'ok') {
      const title = box.querySelector('[data-f="title"]').value.trim()
      const site = box.querySelector('[data-f="site"]').value.trim()
      if (!title) return toast('给频道起个名字吧')
      const c = store.addChannel({ title, site, emoji, tint: '#eef3ee' })
      closeOverlay()
      select(c.id)
    }
  })
}

function openSearch(anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const pop = popover(anchor, `<input class="input" data-q placeholder="搜索消息" style="width:100%;max-width:none;margin-bottom:6px"><div data-results></div>`, { place: 'right' })
  pop.style.width = '320px'
  const results = pop.querySelector('[data-results]')
  const draw = q => {
    const all = Object.values(store.state.messages).flat()
    const hits = q ? all.filter(m => plain(m.text, store.state.profile).includes(q)).slice(-20).reverse() : []
    const notices = q ? Object.values(store.state.notices).filter(n => !noticeDeleted(store.state, n.noticeId) && n.title.includes(q)).slice(0, 20) : []
    const clip = 'style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"'
    results.innerHTML = [
      ...notices.map(n => { const c = store.state.channels.find(x => x.sourceId === n.sourceId); return `<button class="mi" data-notice="${escapeHtml(n.noticeId)}"><span>${escapeHtml(c?.emoji ?? '🔔')}</span><span ${clip}>${escapeHtml(n.title)}</span></button>` }),
      ...hits.map(m => { const c = store.channel(m.channelId); return `<button class="mi" data-id="${escapeHtml(m.id)}"><span>${escapeHtml(c.kind === 'bot' ? '💬' : c.emoji)}</span><span ${clip}>${escapeHtml(plain(m.text, store.state.profile))}</span></button>` }),
    ].join('') || (q ? '<div class="muted" style="padding:8px 10px">没有找到</div>' : '')
  }
  pop.querySelector('[data-q]').addEventListener('input', e => draw(e.target.value.trim()))
  results.addEventListener('click', e => {
    const n = e.target.closest('[data-notice]')
    if (n) { closeOverlay(); return revealNotice(n.dataset.notice) }
    const b = e.target.closest('[data-id]')
    if (!b) return
    const m = store.message(b.dataset.id)
    closeOverlay()
    select(m.channelId)
    requestAnimationFrame(() => transcript.flash(m.id))
  })
}

const settingsApi = {
  store,
  openIdentityAuth,
  openApiSettings,
  openUserProfile,
  async reminder(id, patch) {
    const { reminder } = await apiClient.updateReminder(id, patch)
    store.syncReminders([reminder])
  },
  async demoReminder() {
    const { reminder } = await apiClient.createReminder({ title: '完成数学作业', dueAt: Date.now() + 5000, channelId: 'bot' })
    store.syncReminders([reminder])
  },
  reset: () => store.reset(),
}

// ------------------------------------------------------------- reminders
let runtimePolling = false
let runtimeInitialized = false
async function refreshRuntime() {
  if (runtimePolling) return
  runtimePolling = true
  try {
    if (!runtimeInitialized) {
      const legacy = store.state.reminders.filter(reminder => !reminder.id.startsWith('rem-ddl-') && !reminder.id.startsWith('rem-chat-') && !reminder.id.startsWith('rem-hw-'))
      for (let index = 0; index < legacy.length; index += 200) await apiClient.importReminders(legacy.slice(index, index + 200))
      runtimeInitialized = true
    }
    const [reminders, events] = await Promise.all([apiClient.reminders(), apiClient.events(store.state.eventCursor)])
    store.syncReminders(reminders.reminders || [])
    for (const event of events.events || []) {
      if (store.message(event.id)) continue
      const channelId = store.channel(event.channelId) ? event.channelId : 'bot'
      const fields = isHomework(event.item) ? homeworkReminderMessage(event) : { id: event.id, kind: 'reminder', text: event.text, at: event.at, reminderId: event.reminderId }
      const message = store.addMessage(channelId, { ...fields, role: 'bot' }, { unread: channelId !== active })
      if (Date.now() - event.at < 60_000) announce(channelId, store.state.profile.botName, plain(message.text, store.state.profile))
    }
    if (Number.isSafeInteger(events.cursor) && events.cursor >= 0) store.setEventCursor(events.cursor)
  } catch { /* Preserve local records and retry when the local service returns. */ }
  finally { runtimePolling = false }
}

// ------------------------------------------------------------------- boot
connectDesktop(store, select)
applyPrefs()
watchNoticeWidth(noticeView)
dock.render()
rail.render()
calendar.render()
setView('notice', { acknowledge: false })
select('bot')
syncBadges()
startGaze(document)
refreshSourceStates()

let homeworkSnapshotReady = false
function receiveNotice(channelId, item, alreadySeen = false) {
  if (!store.channel(channelId)) return
  const previous = store.state.noticeDelivery[item.noticeId]
  if (alreadySeen && previous !== 'pending' && store.notice(item.noticeId)) return
  const transition = deliveryTransition(previous, item)
  store.upsertNotice(channelId, item, { unread: transition.deliver })
  if (transition.state !== previous) store.setNoticeDelivery(item.noticeId, transition.state)
  if (!transition.deliver || !noticePushable(item) || noticeDeleted(store.state, item.noticeId)) return
  const text = headsUp(item, store.channel(channelId).title)
  store.addMessage('bot', { role: 'bot', kind: 'text', text, noticeId: item.noticeId, noticeHeadsUp: true }, { unread: active !== 'bot' })
  announce(channelId, store.channel(channelId).title, plain(text, store.state.profile))
}

const sourcesFeed = startFeed({
  adapters: services.sources,
  intervalMs: services.feedInterval,
  seen: { has: id => store.state.seenItems.includes(id), add: id => { store.state.seenItems.push(id); store.save() } },
  onSnapshot(channelId, items) {
    if (channelId !== 'src-xzzd') return
    const { added } = store.syncHomeworkSnapshot(items, { unread: channelId !== active })
    if (homeworkSnapshotReady && added.some(message => Date.now() - (items.find(item => item.noticeId === message.item.noticeId)?.receivedAt || 0) < 60_000)) {
      announce(channelId, '学在浙大·作业', `作业清单已更新，当前展示 ${store.state.messages[channelId].filter(message => message.kind === 'notice').length} 条。`)
    }
    homeworkSnapshotReady = true
  },
  onItem: receiveNotice,
  onSeenItem: (channelId, item) => receiveNotice(channelId, item, true),
})

refreshRuntime()
setInterval(refreshRuntime, 2000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshRuntime() })

// First visit: the bot says hello and asks what to call you.
if (!store.state.messages.bot.length) {
  setTimeout(() => run('bot', (async function* () {
    for (const text of GREETING) { yield { type: 'typing', ms: 500 + text.length * 30 }; yield { type: 'message', text } }
  })()), 700)
}
