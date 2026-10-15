import { createStore } from './store.js'
import { newId, pendingReminders } from './reminders.js'
import { markHTML, setMarkState, startGaze } from './mark/index.js'
import { createAIChat, GREETING } from './services/chat.js'
import { startFeed, localAdapters, noticeCopy, eventPhrase, NOTICE_CATEGORIES, LOCAL_CHANNELS } from './services/sources.js'
import { analysisFields, decisionCopy } from './services/notice-summary.js'
import { systemNotify } from './services/scheduler.js'
import { createSidebar } from './ui/sidebar.js'
import { createHeader } from './ui/header.js'
import { createTranscript } from './ui/transcript.js'
import { createComposer } from './ui/composer.js'
import { openSettings } from './ui/settings.js'
import { syncTeamPatch, botFace, openCreateBot, openCreateGroup, openMembers } from './ui/team.js'
import { createAuthClient } from './services/auth.js'
import { openIdentityAuth as showIdentityAuth } from './ui/auth.js'
import { createApiClient, apiErrorText } from './services/api.js'
import { openApiSettings as showApiSettings } from './ui/api-settings.js'
import { popover, dialog, closeOverlay, overlayFor, toast } from './ui/overlays.js'
import { icon } from './ui/icons.js'
import { escapeHtml, plain, whenLabel, clock, personalize } from './ui/format.js'
import { chatHistory, reminderActivity } from './services/activity.js'

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

function sourceStateLabel(sourceId) {
  if (sourceStatusError) return '本机服务暂时不可用'
  const state = sourceStates.get(sourceId)?.state
  return ({ idle: '等待下次检查', ready: '正常采集', ok: '正常采集', success: '正常采集', active: '正常采集', running: '正在采集', crawling: '正在采集', partial: '部分正文待补齐', interrupted: '上次采集中断', auth_required: '待认证', auth_expired: '认证已失效', authenticating: '正在认证', error: '采集暂时异常', backoff: '稍后重试', paused: '已暂停', network_error: '网络暂时不可用' })[state] || (state ? '等待检查' : '正在读取状态…')
}

let active = sessionStorage.getItem('pp.active') || 'bot'
if (!store.channel(active)) active = 'bot'

// ------------------------------------------------------------------ chrome
function applyPrefs() {
  const p = store.state.profile
  if (p.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = p.theme
  document.documentElement.dataset.motion = p.motion
  document.title = `${p.botName} · PigeonPal`
}

const sidebar = createSidebar({
  root: $('side'), store,
  onSelect: id => select(id),
  onMe: openMeMenu,
  onAddSource: openAddSource,
  onSearch: openSearch,
  onAddBot: opener => openCreateBot(teamApi, opener),
  onAddGroup: opener => openCreateGroup(teamApi, opener),
  onBotDM: openBotDM,
})
const header = createHeader({ root: $('head'), store, onWho: openWho, onToggleSide: () => toggleSide(), onMembers: opener => openMembers(teamApi, active, opener) })
const transcript = createTranscript({ root: $('log'), jump: $('jump'), store, onAction })
const composer = createComposer({ root: $('dock'), store, onSend: send, onPlus: openPlusMenu })

function toggleSide(open = app.dataset.side !== 'open') {
  app.dataset.side = open ? 'open' : ''
  $('side-scrim').hidden = !open
}
$('side-scrim').addEventListener('click', () => toggleSide(false))

function select(id) {
  if (!store.channel(id)) return
  const changed = id !== active
  active = id
  sessionStorage.setItem('pp.active', id)
  sidebar.setActive(id)
  if (changed || !transcript.channelId) { header.render(id); transcript.render(id) }
  store.markRead(id)
  const c = store.channel(id)
  updateComposerChannel(c)
  if (pending.has(id)) transcript.showTyping(c.botId || 'chief')
  toggleSide(false)
}

function updateComposerChannel(channel = store.channel(active)) {
  if (!channel) return
  composer.setChannel(channel.id)
  const name = channel.kind === 'dm' ? store.botAppearance(store.bot(channel.botId) || { id: channel.botId }).name : store.state.profile.botName
  composer.setPlaceholder(['bot', 'dm'].includes(channel.kind) ? `给${name}发消息` : `聊聊「${channel.title}」里的消息`)
}

// -------------------------------------------------------------- reactions
store.on('message', m => {
  sidebar.update(m.channelId)
  transcript.append(m)
  if (m.channelId === active && pending.has(active) && m.activity?.type === 'handoff') {
    transcript.showTyping(m.activity.actors[1].id)
  }
  if (m.channelId === active && document.visibilityState === 'visible') store.markRead(m.channelId)
})
store.on('unread', id => sidebar.update(id))
store.on('message-updated', message => { sidebar.update(message.channelId); transcript.refreshNotice(message) })
store.on('activity-updated', message => { sidebar.update(message.channelId); transcript.refreshActivity(message) })
store.on('bot-appearance', () => {
  sidebar.render(); sidebar.setActive(active)
  header.render(active, { animate: false }); transcript.refreshMarks(); updateComposerChannel()
})
store.on('bots', () => {
  sidebar.render(); sidebar.setActive(active)
  header.render(active, { animate: false }); transcript.refreshMarks(); updateComposerChannel()
})
store.on('channels', () => sidebar.render())
store.on('profile', patch => {
  applyPrefs()
  if (['look', 'image', 'botName', 'nickname'].some(k => k in patch)) {
    sidebar.render(); sidebar.setActive(active)
    header.render(active, { animate: false })
    updateComposerChannel()
    if ('nickname' in patch) transcript.render(active)
    else transcript.refreshMarks()
  }
})
store.on('reminders', r => {
  if (!r) return
  for (const m of store.state.messages[active] ?? []) if (m.reminderId === r.id || m.id === r.noticeId || m.item?.noticeId === r.noticeId) transcript.patch(m.id)
})
store.on('save-failed', () => toast('本地存储不可用，刷新后记录会丢失'))
store.on('reset', () => { sessionStorage.removeItem('pp.active'); location.reload() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.markRead(active) })

// Something new somewhere: the bot hops in the sidebar and the row lights up.
function announce(channelId, title, body) {
  const c = store.channel(channelId)
  if (!store.state.profile.proactive || c?.notify === 'mute') return
  const p = store.state.profile
  const now = clock(Date.now())
  const quiet = p.quietStart === p.quietEnd ? false : p.quietStart < p.quietEnd
    ? now >= p.quietStart && now < p.quietEnd : now >= p.quietStart || now < p.quietEnd
  if (quiet) return
  setMarkState(sidebar.botMark(), 'alert')
  if (channelId !== 'bot') sidebar.bump(channelId)
  systemNotify(title, body)
}

// ------------------------------------------------------------------- chat
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pending = new Map() // channelId -> number of active reply streams
const queues = new Map()   // channelId -> { texts, quoteId, timer }
const flushing = new Set() // reserve a channel while metadata is being refreshed

// Short messages sent in a burst get one reply, the way a person reads them.
function send(text, quoteId) {
  const ch = active
  store.addMessage(ch, { role: 'user', text, ...(quoteId ? { quoteId } : {}) })
  const q = queues.get(ch) ?? { texts: [], timer: 0, requestId: newId('chat'), firstIndex: store.state.messages[ch].length - 1 }
  q.texts.push(text)
  if (quoteId) q.quoteId = quoteId
  clearTimeout(q.timer)
  q.timer = setTimeout(() => flush(ch), 900)
  queues.set(ch, q)
}

async function flush(ch) {
  const q = queues.get(ch)
  if (!q) return
  if (pending.has(ch) || flushing.has(ch)) { q.timer = setTimeout(() => flush(ch), 600); return }
  flushing.add(ch)
  queues.delete(ch)
  try {
    try { await refreshTeam() } catch { /* Older/offline local service retains its existing error path. */ }
    let budget = 18000
    const history = []
    for (const message of chatHistory(store.state.messages[ch].slice(0, q.firstIndex)).slice(-24).reverse()) {
      const content = personalize(message.text, store.state.profile).slice(0, 1800)
      if (content.length > budget) break
      budget -= content.length
      history.unshift({ role: message.role === 'bot' ? 'assistant' : 'user', content })
    }
    await run(ch, services.chat.respond({ text: q.texts.join('\n'), channelId: ch, state: store.state,
      requestId: q.requestId, quoteId: q.quoteId, history,
      ...(store.channel(ch)?.kind === 'dm' ? { botId: store.channel(ch).botId } : {}) }))
  } finally { flushing.delete(ch) }
}

// Plays a reply stream: typing, bubbles and actions, in order.
async function run(ch, stream) {
  pending.set(ch, (pending.get(ch) || 0) + 1)
  try {
    await sleep(350)
    for await (const event of stream) {
      if (event.type === 'typing') {
        if (ch === active) transcript.showTyping(event.botId || store.channel(ch)?.botId || 'chief')
        await sleep(event.ms)
      } else if (event.type === 'message') {
        appendBotText(ch, { ...event, botId: event.botId || store.channel(ch)?.botId || 'chief' })
        await sleep(260)
      } else if (event.type === 'action') {
        applyAction(ch, event)
      } else if (event.type === 'activity') {
        store.upsertActivity(ch, event)
      }
    }
  } catch (error) {
    store.addMessage(ch, { role: 'bot', botId: store.channel(ch)?.botId || 'chief', text: apiErrorText(error) }, { unread: ch !== active })
  } finally {
    const remaining = (pending.get(ch) || 1) - 1
    if (remaining) pending.set(ch, remaining)
    else pending.delete(ch)
    if (ch === active && !pending.has(ch)) transcript.hideTyping()
  }
}

function applyAction(ch, { name, args, operation, botId }) {
  if (name === 'bots.sync') store.syncBots(args)
  if (name === 'profile.update') store.setProfile({ nickname: args.nickname })
  if (name === 'reminder.upsert') acknowledgeReminder(args, ch, operation, botId)
}

// Only explicit successful API/tool receipts produce confirmations. Polling does not.
function acknowledgeReminder(reminder, fallback = 'bot', operation, botId) {
  if (!reminder || typeof reminder.id !== 'string' || !Number.isFinite(reminder.dueAt)
      || !['pending', 'done', 'cancelled'].includes(reminder.status)) return
  const previous = store.state.reminders.find(row => row.id === reminder.id)
  if (previous && (previous.updatedAt || 0) > (reminder.updatedAt || 0)) return
  const actorId = botId || reminder.botId || 'chief'
  const event = reminderActivity(reminder, previous, store.state.profile, operation, store.botAppearance(store.bot(actorId) || { id: actorId }))
  store.syncReminders([reminder])
  if (!event) return
  event.activity.detail = reminder.status === 'pending' ? whenLabel(reminder.dueAt) : reminder.title
  const channelId = store.channel(reminder.channelId) ? reminder.channelId : fallback
  store.upsertActivity(channelId, event)
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
    if (act === 'open-notice' && m) await openNotice(m, el)
    if (act === 'remind-notice' && m) openNoticeReminder(m, el)
    if (act === 'reminder-done') {
      const { reminder: r } = await apiClient.updateReminder(id, { status: 'done' })
      acknowledgeReminder(r)
      run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', botId: r.botId || 'chief', text: pickOne(['搞定！✌️', '棒～', '收到，辛苦啦 🎉']) } })())
    }
    if (act === 'reminder-snooze') {
      const { reminder: r } = await apiClient.updateReminder(id, { dueAt: Date.now() + 10 * 60_000 })
      acknowledgeReminder(r)
      run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', botId: r.botId || 'chief', text: `好，${clock(r.dueAt)} 再叫你` } })())
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

function openNoticeReminder(m, anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const item = m.item ?? {}
  const existing = store.state.reminders.find(r => (r.noticeId === m.id || r.noticeId === item.noticeId) && r.status === 'pending')
  const reference = item.eventAt || (typeof item.deadlineAt === 'string' && item.deadlineAt.includes('T') ? Date.parse(item.deadlineAt) : null)
  const before = item.eventAt ? '开始前' : '截止前'
  const options = [[15, `${before} 15 分钟`], [30, `${before} 30 分钟`], [60, `${before} 1 小时`], [24 * 60, '提前一天']]
    .map(([min, label]) => [reference - min * 60_000, label]).filter(([at]) => at > Date.now())
  const pop = popover(anchor, `<div class="pop-title">什么时候叫你？</div>
${options.map(([at, label]) => `<button class="mi" data-at="${at}">${icon('bell', 16)}${label}<span class="hint">${escapeHtml(whenLabel(at))}</span></button>`).join('')}
<button class="mi" data-at="custom">${icon('clock', 16)}自定义提醒时间</button>
${existing ? `<div class="pop-sep"></div><button class="mi danger" data-at="cancel">${icon('close', 16)}取消提醒</button>` : ''}`, { place: 'below' })
  pop.addEventListener('click', async e => {
    const b = e.target.closest('[data-at]')
    if (!b) return
    closeOverlay()
    if (b.dataset.at === 'custom') return openNewReminder(anchor, {
      title: `「${item.title.slice(0, 35)}」`, channelId: m.channelId, noticeId: item.noticeId || m.id,
    })
    if (b.dataset.at === 'cancel') {
      try { const result = await apiClient.updateReminder(existing.id, { status: 'cancelled' }); acknowledgeReminder(result.reminder) } catch (error) { return toast(apiErrorText(error)) }
      return toast('提醒已取消')
    }
    try {
      const { reminder: r } = await apiClient.createReminder({ title: `「${item.title.slice(0, 75)}」`, dueAt: Number(b.dataset.at), channelId: m.channelId, noticeId: item.noticeId || m.id })
      acknowledgeReminder(r, 'bot', 'create')
      run(m.channelId, (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', botId: r.botId || 'chief', text: `好嘞～${whenLabel(r.dueAt)} 叫你 ⏰`, quoteId: m.id } })())
    } catch (err) { toast(apiErrorText(err)) }
  })
}

// ------------------------------------------------------------------ menus
function openWho(anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const p = store.state.profile
  const c = store.channel(active)
  if (c.kind === 'dm') {
    const bot = store.bot(c.botId)
    if (!bot) return toast('伙伴信息尚未同步，请稍后重试')
    const appearance = store.botAppearance(bot)
    const pop = popover(anchor, `<div class="profile">${botFace(store, bot, 88)}<h3>${escapeHtml(appearance.name)}</h3><p>${escapeHtml(bot.style || bot.role || '伙伴')}</p>${bot.instructions ? `<p class="note">${escapeHtml(bot.instructions)}</p>` : ''}<div class="pills"><button class="pill" data-bot-settings>形象与称呼</button></div></div>`)
    pop.querySelector('[data-bot-settings]').onclick = () => openSettings(settingsApi, { botId: bot.id, opener: anchor })
  } else if (c.kind === 'group') {
    openMembers(teamApi, c.id, anchor)
  } else if (c.kind === 'bot') {
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
${c.sourceId ? '<dl class="kv"><dt>采集状态</dt><dd data-source-state></dd><dt>本机通知</dt><dd data-source-count></dd><dt>最近检查</dt><dd data-source-checked></dd><dt>通知整理</dt><dd data-ai-state></dd></dl>' : ''}
<div class="pills">${c.requiresAuth ? `<button class="pill" data-identity>${icon('key', 15)}<span data-auth-label>去认证</span></button>` : ''}${c.sourceId ? `<button class="pill" data-api-settings>${icon('settings', 15)}API 设置</button>` : ''}<button class="pill" data-mute>${icon('bell', 15)}${c.notify === 'mute' ? '取消静音' : '静音'}</button></div>
</div>`, { onClose: () => { stopped = true; clearTimeout(timer) } })
    if (c.sourceId) {
      const drawSource = () => {
        if (stopped) return
        const source = sourceStates.get(c.sourceId)
        pop.querySelector('[data-source-state]').textContent = sourceStateLabel(c.sourceId)
        const count = Number.isSafeInteger(source?.totalCount) ? source.totalCount : null
        const complete = Number.isSafeInteger(source?.completeCount) ? source.completeCount : null
        const skipped = Number.isSafeInteger(source?.skippedCount) ? source.skippedCount : 0
        pop.querySelector('[data-source-count]').textContent = count === null ? '—' : `${count} 条${complete === null ? '' : ` · ${complete} 篇正文`}${skipped ? ` · ${skipped} 条仅链接` : ''}`
        const checked = new Date(source?.lastCheckedAt)
        pop.querySelector('[data-source-checked]').textContent = source?.lastCheckedAt && Number.isFinite(checked.getTime()) ? checked.toLocaleString('zh-CN', { hour12: false }) : '—'
        pop.querySelector('[data-ai-state]').textContent = !aiStatus?.configured ? '等待配置 API' : aiStatus.error
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
    if (b?.dataset.x === 'reminder') openNewReminder(anchor, { channelId: active })
    if (b?.dataset.x === 'source') openAddSource(anchor)
  })
}

function openNewReminder(opener, { title = '', channelId = 'bot', noticeId } = {}) {
  const soon = [['10 分钟后', 10], ['1 小时后', 60], ['今晚 21:00', 'tonight'], ['明早 08:00', 'morning']]
  const members = store.channel(channelId)?.memberIds || ['chief']
  const actor = members.map(id => store.bot(id)).find(bot => bot?.role === 'reminder') || store.bot(store.channel(channelId)?.botId || 'chief')
  let closed = false
  const box = dialog(`<h3>设一个提醒</h3><p>到点了${escapeHtml(store.botAppearance(actor || { id: 'chief' }).name)}会来叫你。</p>
<div class="field"><input class="input" data-f="title" placeholder="要做什么？" maxlength="40" value="${escapeHtml(title)}"></div>
<div class="chips">${soon.map(([l, v]) => `<button class="pill" data-soon="${v}">${l}</button>`).join('')}</div>
<div class="field"><input class="input" type="datetime-local" data-f="at"></div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">好</button></div>`, { opener, onClose: () => { closed = true } })
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
        acknowledgeReminder(r, 'bot', 'create')
        if (closed) return
        closeOverlay()
        if (active !== channelId) select(channelId)
        run(channelId, (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', botId: r.botId || 'chief', text: `记下啦～${whenLabel(r.dueAt)} 叫你${r.title} ⏰` } })())
      } catch (err) { b.disabled = false; toast(apiErrorText(err)) }
    }
  })
}

function openAddSource(opener) {
  const box = dialog(`<h3>添加信息来源</h3><p>告诉${escapeHtml(store.state.profile.botName)}想关注哪个网站。抓取还在接入中，先建好频道，接通后消息会自动出现。</p>
<div class="field"><input class="input" data-f="title" placeholder="频道名，比如：计算机学院" maxlength="16"></div>
<div class="field"><input class="input" data-f="site" placeholder="网址，比如：https://example.edu.cn/news" maxlength="200"></div>
<div class="chips">${['📰', '🏫', '🧪', '🏀', '🎵', '💼'].map(e => `<button class="pill" data-emoji="${e}">${e}</button>`).join('')}</div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">建好频道</button></div>`, { opener })
  let emoji = '📰'
  box.querySelector('[data-emoji]').classList.add('on')
  box.addEventListener('click', async e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.emoji) { emoji = b.dataset.emoji; for (const x of box.querySelectorAll('[data-emoji]')) x.classList.toggle('on', x === b) }
    if (b.dataset.x === 'cancel') closeOverlay()
    if (b.dataset.x === 'ok') {
      const title = box.querySelector('[data-f="title"]').value.trim()
      const site = box.querySelector('[data-f="site"]').value.trim()
      if (!title) return toast('给频道起个名字吧')
      b.disabled = true
      try {
        const id = newId('src').slice(0, 40)
        await refreshTeam()
        const { channel } = await apiClient.createBotChannel({ id, title, kind: 'source', memberIds: defaultTeamMembers() })
        const c = store.addChannel({ ...channel, title, site, emoji, tint: '#eef3ee' })
        if (box.isConnected && !box.classList.contains('leave')) { closeOverlay(); select(c.id) }
      } catch (error) { toast(apiErrorText(error)) }
      finally { b.disabled = false }
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
    const hits = q ? all.filter(m => plain(m.text, store.state.profile).includes(q) || m.item?.title?.includes(q)).slice(-20).reverse() : []
    results.innerHTML = hits.map(m => { const c = store.channel(m.channelId); return `<button class="mi" data-id="${escapeHtml(m.id)}"><span>${escapeHtml(c.kind === 'bot' ? '💬' : c.emoji)}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(plain(m.text, store.state.profile))}</span></button>` }).join('') || (q ? '<div class="muted" style="padding:8px 10px">没有找到</div>' : '')
  }
  pop.querySelector('[data-q]').addEventListener('input', e => draw(e.target.value.trim()))
  results.addEventListener('click', e => {
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
  async updateBotConfig(id, patch) {
    const { bot } = await apiClient.updateBot(id, patch)
    syncTeamPatch(store, { bots: [bot] })
  },
  async updateBotName(id, name) {
    const { bot } = await apiClient.updateBot(id, { name })
    syncTeamPatch(store, { bots: [bot] })
    store.setBotAppearance(id, { name: bot.name })
  },
  openIdentityAuth,
  openApiSettings,
  async reminder(id, patch) {
    const { reminder } = await apiClient.updateReminder(id, patch)
    acknowledgeReminder(reminder)
  },
  async demoReminder() {
    const { reminder } = await apiClient.createReminder({ title: '完成数学作业', dueAt: Date.now() + 5000, channelId: 'bot' })
    acknowledgeReminder(reminder, 'bot', 'create')
  },
  reset: () => store.reset(),
}


// Bot metadata and task events have their own cursor and polling lifecycle.
// Text receipts share stable IDs with /chat; activity receipts update one row.
function appendBotText(channelId, event) {
  if (event.id && store.message(event.id)) return null
  return store.addMessage(channelId, { role: 'bot', text: event.text,
    ...(event.id ? { id: event.id } : {}), ...(event.botId ? { botId: event.botId } : {}),
    ...(Number.isFinite(event.at) ? { at: event.at } : {}),
    ...(event.quoteId ? { quoteId: event.quoteId } : {}) }, { unread: channelId !== active })
}
let teamRefreshing = null
function defaultTeamMembers() {
  return ['chief', ...['news', 'reminder'].map(role => store.state.bots.find(bot => bot.role === role && bot.id !== 'chief')?.id).filter(Boolean)]
}
async function refreshTeam() {
  if (teamRefreshing) return teamRefreshing
  teamRefreshing = (async () => {
    const data = await apiClient.bots()
    if (!store.syncBots(data)) throw new Error('Invalid team metadata')
    const registered = new Set(data.channels.map(channel => channel.id))
    for (const source of store.state.channels.filter(channel => channel.kind === 'source' && !registered.has(channel.id))) {
      const { channel } = await apiClient.createBotChannel({ id: source.id, title: source.title,
        kind: 'source', memberIds: defaultTeamMembers() })
      data.channels.push(channel)
      registered.add(channel.id)
    }
    store.syncBots(data)
  })().finally(() => { teamRefreshing = null })
  return teamRefreshing
}
const teamApi = { store, client: apiClient, refresh: refreshTeam, select }
async function openBotDM(botId, opener) {
  const existing = store.state.channels.find(channel => channel.kind === 'dm' && channel.botId === botId)
  if (existing) return select(existing.id)
  try {
    const bot = store.bot(botId)
    if (!bot) return toast('伙伴信息尚未同步，请稍后重试')
    if (opener) opener.disabled = true
    const { channel } = await apiClient.createBotChannel({ title: bot.name, memberIds: [botId],
      id: `src-dm-${botId}`, kind: 'dm' })
    syncTeamPatch(store, { channels: [channel] })
    select(channel.id)
  } catch (error) { toast(apiErrorText(error)) }
  finally { if (opener) opener.disabled = false }
}
let teamPolling = false
async function refreshTeamEvents() {
  if (teamPolling) return
  teamPolling = true
  try {
    await refreshTeam()
    const result = await apiClient.botEvents(store.state.teamCursor || 0)
    for (const event of result.events || []) {
      if (Number.isFinite(event.at) && event.at <= store.state.teamResetAt) continue
      // Never advance past a receipt whose channel has not arrived yet.
      if (!store.channel(event.channelId)) throw new Error('Unknown team channel')
      if (event.kind === 'activity') store.upsertActivity(event.channelId, event)
      if (event.kind === 'text' && typeof event.text === 'string') appendBotText(event.channelId, event)
    }
    if (Number.isSafeInteger(result.cursor) && result.cursor >= 0) store.setTeamCursor(result.cursor)
  } catch { /* Retry unchanged cursor when the local service returns. */ }
  finally { teamPolling = false }
}

// ------------------------------------------------------------- reminders
let runtimePolling = false
let runtimeInitialized = false
async function refreshRuntime() {
  if (runtimePolling) return
  runtimePolling = true
  try {
    await refreshTeam()
    if (!runtimeInitialized) {
      const legacy = store.state.reminders.filter(reminder => !reminder.id.startsWith('rem-ddl-') && !reminder.id.startsWith('rem-chat-'))
      for (let index = 0; index < legacy.length; index += 200) await apiClient.importReminders(legacy.slice(index, index + 200))
      runtimeInitialized = true
    }
    const [reminders, events] = await Promise.all([apiClient.reminders(), apiClient.events(store.state.eventCursor)])
    store.syncReminders(reminders.reminders || [])
    for (const event of events.events || []) {
      if (store.message(event.id)) continue
      if (!store.channel(event.channelId)) throw new Error('Unknown reminder channel')
      const channelId = event.channelId
      const reminder = store.state.reminders.find(row => row.id === event.reminderId)
      const botId = event.botId || reminder?.botId || 'chief'
      const message = store.addMessage(channelId, { id: event.id, role: 'bot', kind: 'reminder', botId, text: event.text,
        at: event.at, reminderId: event.reminderId }, { unread: channelId !== active })
      if (Date.now() - event.at < 60_000) announce(channelId, store.botAppearance({ id: botId }).name, plain(message.text, store.state.profile))
    }
    if (Number.isSafeInteger(events.cursor) && events.cursor >= 0) store.setEventCursor(events.cursor)
  } catch { /* Preserve local records and retry when the local service returns. */ }
  finally { runtimePolling = false }
}

// ------------------------------------------------------------------- boot
applyPrefs()
sidebar.render()
select(active)
startGaze(document)
refreshSourceStates()

startFeed({
  adapters: services.sources,
  intervalMs: services.feedInterval,
  seen: { has: id => store.state.seenItems.includes(id), add: id => { store.state.seenItems.push(id); store.save() } },
  onItem(channelId, item) {
    if (!store.channel(channelId)) return
    const live = Number.isFinite(item.receivedAt) && Date.now() - item.receivedAt < 60_000
    const botId = (store.channel(channelId).memberIds || []).find(id => store.bot(id)?.role === 'news') || 'chief'
    const { created, revised } = store.upsertNotice(channelId, { role: 'bot', botId, kind: 'notice', text: noticeCopy(item), item, at: item.publishedAt }, { unread: channelId !== active })
    if (live && (created || revised)) announce(channelId, store.channel(channelId).title, plain(noticeCopy(item), store.state.profile))
  },
})

refreshRuntime()
refreshTeamEvents()
setInterval(refreshRuntime, 2000)
setInterval(refreshTeamEvents, 2000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshRuntime(); refreshTeamEvents() } })

// First visit: the bot says hello and asks what to call you.
if (!store.state.messages.bot.length) {
  setTimeout(() => run('bot', (async function* () {
    for (const text of GREETING) { yield { type: 'typing', ms: 500 + text.length * 30 }; yield { type: 'message', text } }
  })()), 700)
}
