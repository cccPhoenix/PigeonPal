import { createStore } from './store.js'
import { addReminder, updateReminder, dueReminders, markDelivered, pendingReminders } from './reminders.js'
import { markHTML, setMarkState, startGaze } from './mark/index.js'
import { createDemoChat, GREETING, ALARM } from './services/chat.js'
import { startFeed, demoAdapters, noticeCopy, eventPhrase } from './services/sources.js'
import { startScheduler, systemNotify } from './services/scheduler.js'
import { createSidebar } from './ui/sidebar.js'
import { createHeader } from './ui/header.js'
import { createTranscript } from './ui/transcript.js'
import { createComposer } from './ui/composer.js'
import { openSettings } from './ui/settings.js'
import { popover, dialog, closeOverlay, overlayFor, toast } from './ui/overlays.js'
import { icon } from './ui/icons.js'
import { escapeHtml, plain, whenLabel, clock, personalize } from './ui/format.js'

// ---------------------------------------------------------------- services
// Swap these three for real backends; the UI only knows their contracts.
const services = {
  chat: createDemoChat(),
  sources: demoAdapters(),
  feedInterval: 3000,
}

const store = createStore()
const $ = id => document.getElementById(id)
const app = $('app')
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
})
const header = createHeader({ root: $('head'), store, onWho: openWho, onToggleSide: () => toggleSide() })
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
  composer.setPlaceholder(c.kind === 'bot' ? `给${store.state.profile.botName}发消息` : `聊聊「${c.title}」里的消息`)
  if (pending.has(id)) transcript.showTyping()
  toggleSide(false)
}

// -------------------------------------------------------------- reactions
store.on('message', m => {
  sidebar.update(m.channelId)
  transcript.append(m)
  if (m.channelId === active && document.visibilityState === 'visible') store.markRead(m.channelId)
})
store.on('unread', id => sidebar.update(id))
store.on('channels', () => sidebar.render())
store.on('profile', patch => {
  applyPrefs()
  if (['look', 'image', 'botName', 'nickname'].some(k => k in patch)) {
    sidebar.render(); sidebar.setActive(active)
    header.render(active, { animate: false })
    transcript.render(active)
  }
})
store.on('reminders', r => {
  if (!r) return
  for (const m of store.state.messages[active] ?? []) if (m.reminderId === r.id || m.id === r.noticeId) transcript.patch(m.id)
})
store.on('save-failed', () => toast('本地存储不可用，刷新后记录会丢失'))
store.on('reset', () => { sessionStorage.removeItem('pp.active'); location.reload() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.markRead(active) })

// Something new somewhere: the bot hops in the sidebar and the row lights up.
function announce(channelId, title, body) {
  const c = store.channel(channelId)
  if (!store.state.profile.proactive || c?.notify === 'mute') return
  setMarkState(sidebar.botMark(), 'alert')
  if (channelId !== 'bot') sidebar.bump(channelId)
  systemNotify(title, body)
}

// ------------------------------------------------------------------- chat
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pending = new Set() // channels with a reply on the way
const queues = new Map()   // channelId -> { texts, quoteId, timer }

// Short messages sent in a burst get one reply, the way a person reads them.
function send(text, quoteId) {
  const ch = active
  store.addMessage(ch, { role: 'user', text, ...(quoteId ? { quoteId } : {}) })
  const q = queues.get(ch) ?? { texts: [], timer: 0 }
  q.texts.push(text)
  clearTimeout(q.timer)
  q.timer = setTimeout(() => flush(ch), 900)
  queues.set(ch, q)
}

async function flush(ch) {
  if (pending.has(ch)) { queues.get(ch).timer = setTimeout(() => flush(ch), 600); return }
  const q = queues.get(ch)
  queues.delete(ch)
  await run(ch, services.chat.respond({ text: q.texts.join('\n'), channelId: ch, state: store.state }))
}

// Plays a reply stream: typing, bubbles and actions, in order.
async function run(ch, stream) {
  pending.add(ch)
  try {
    await sleep(350)
    for await (const event of stream) {
      if (event.type === 'typing') {
        if (ch === active) transcript.showTyping()
        await sleep(event.ms)
      } else if (event.type === 'message') {
        store.addMessage(ch, { role: 'bot', text: event.text, ...(event.quoteId ? { quoteId: event.quoteId } : {}) }, { unread: ch !== active })
        await sleep(260)
      } else if (event.type === 'action') {
        applyAction(ch, event)
      }
    }
  } catch (error) {
    console.error(error)
    store.addMessage(ch, { role: 'bot', text: '哎呀，我这边卡了一下，再说一次好吗？' }, { unread: ch !== active })
  } finally {
    pending.delete(ch)
    if (ch === active) transcript.hideTyping()
  }
}

function applyAction(ch, { name, args }) {
  if (name === 'profile.update') store.setProfile({ nickname: args.nickname })
  if (name === 'reminder.create') {
    const r = addReminder(store.state, { title: args.title, dueAt: args.dueAt, channelId: ch }, Date.now())
    store.remindersChanged(r)
  }
}

// ------------------------------------------------------------ transcript
function onAction(act, id, el) {
  const m = store.message(id)
  if (act === 'copy' && m) {
    const text = personalize(m.text, store.state.profile)
    navigator.clipboard?.writeText(text).then(() => toast('已复制'), () => toast('复制失败，可以手动选中文字'))
      ?? toast('复制失败，可以手动选中文字')
  }
  if (act === 'reply' && m) composer.setQuote(m)
  if (act === 'jump' && m) { if (m.channelId !== active) select(m.channelId); requestAnimationFrame(() => transcript.flash(m.id)) }
  if (act === 'open-notice' && m) openNotice(m, el)
  if (act === 'remind-notice' && m) openNoticeReminder(m, el)
  if (act === 'reminder-done') {
    const r = updateReminder(store.state, id, { status: 'done' })
    store.remindersChanged(r)
    run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', text: pickOne(['搞定！✌️', '棒～', '收到，辛苦啦 🎉']) } })())
  }
  if (act === 'reminder-snooze') {
    const r = updateReminder(store.state, id, { dueAt: Date.now() + 10 * 60_000 })
    store.remindersChanged(r)
    run(r.channelId, (async function* () { yield { type: 'typing', ms: 500 }; yield { type: 'message', text: `好，${clock(r.dueAt)} 再叫你` } })())
  }
}
const pickOne = list => list[Math.floor(Math.random() * list.length)]

function openNotice(m, opener) {
  const item = m.item ?? {}
  const c = store.channel(m.channelId)
  const box = dialog(`<h3>${escapeHtml(item.title)}</h3>
<p>${escapeHtml(c.emoji)} ${escapeHtml(c.title)} · ${escapeHtml(c.site)}</p>
<div class="card-meta" style="margin-bottom:12px">${item.eventAt ? `<div>${icon('clock', 15)}<span>${escapeHtml(eventPhrase(item.eventAt))}${item.eventEnd ? ` – ${clock(item.eventEnd)}` : ''}</span></div>` : ''}${item.where ? `<div>${icon('pin', 15)}<span>${escapeHtml(item.where)}</span></div>` : ''}</div>
<p class="note">${escapeHtml(item.summary ?? '')}</p>
<div class="btns">${item.url ? `<a class="btn primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" style="display:inline-grid;place-items:center;text-decoration:none">打开原网页</a>` : '<span class="muted" style="margin-right:auto;align-self:center">示例来源，没有原网页</span>'}<button class="btn" data-x="close">好的</button></div>`, { opener })
  box.querySelector('[data-x="close"]').addEventListener('click', closeOverlay)
}

function openNoticeReminder(m, anchor) {
  if (overlayFor(anchor)) return closeOverlay()
  const item = m.item ?? {}
  const existing = store.state.reminders.find(r => r.noticeId === m.id && r.status === 'pending')
  const options = [[15, '开始前 15 分钟'], [30, '开始前 30 分钟'], [60, '开始前 1 小时'], [24 * 60, '提前一天']]
    .map(([min, label]) => [item.eventAt - min * 60_000, label]).filter(([at]) => at > Date.now())
  const pop = popover(anchor, `<div class="pop-title">什么时候叫你？</div>
${options.map(([at, label]) => `<button class="mi" data-at="${at}">${icon('bell', 16)}${label}<span class="hint">${escapeHtml(whenLabel(at))}</span></button>`).join('') || '<div class="muted" style="padding:8px 10px">马上就开始啦</div>'}
${existing ? `<div class="pop-sep"></div><button class="mi danger" data-at="cancel">${icon('close', 16)}取消提醒</button>` : ''}`, { place: 'below' })
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-at]')
    if (!b) return
    closeOverlay()
    if (b.dataset.at === 'cancel') {
      store.remindersChanged(updateReminder(store.state, existing.id, { status: 'cancelled' }))
      return toast('提醒已取消')
    }
    try {
      const r = addReminder(store.state, { title: `「${item.title}」`, dueAt: Number(b.dataset.at), channelId: m.channelId, noticeId: m.id })
      store.remindersChanged(r)
      run(m.channelId, (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', text: `好嘞～${whenLabel(r.dueAt)} 叫你 ⏰`, quoteId: m.id } })())
    } catch (err) { toast(err.message) }
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
    const pop = popover(anchor, `<div class="profile">
<div class="ch-icon" style="--tint:${escapeHtml(c.tint)};width:64px;height:64px;border-radius:20px;font-size:32px;margin:4px auto 10px">${escapeHtml(c.emoji)}</div>
<h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(p.botName)}帮你盯着这个来源</p>
<dl class="kv"><dt>来源</dt><dd>${escapeHtml(c.site || '—')}</dd><dt>检查</dt><dd>${escapeHtml(c.every)}</dd><dt>通知</dt><dd>${c.notify === 'mute' ? '静音' : '有新消息就叫我'}</dd></dl>
<div class="pills"><button class="pill" data-mute>${icon('bell', 15)}${c.notify === 'mute' ? '取消静音' : '静音'}</button></div>
</div>`)
    pop.addEventListener('click', e => {
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

function openNewReminder(opener) {
  const soon = [['10 分钟后', 10], ['1 小时后', 60], ['今晚 21:00', 'tonight'], ['明早 08:00', 'morning']]
  const box = dialog(`<h3>设一个提醒</h3><p>到点了${escapeHtml(store.state.profile.botName)}会来叫你。</p>
<div class="field"><input class="input" data-f="title" placeholder="要做什么？" maxlength="40"></div>
<div class="chips">${soon.map(([l, v]) => `<button class="pill" data-soon="${v}">${l}</button>`).join('')}</div>
<div class="field"><input class="input" type="datetime-local" data-f="at"></div>
<div class="btns"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">好</button></div>`, { opener })
  const at = box.querySelector('[data-f="at"]')
  const setAt = t => { const d = new Date(t); const pad = n => String(n).padStart(2, '0'); at.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
  setAt(Date.now() + 60 * 60_000)
  box.addEventListener('click', e => {
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
        const r = addReminder(store.state, { title, dueAt: new Date(at.value).getTime(), channelId: 'bot' })
        store.remindersChanged(r)
        closeOverlay()
        if (active !== 'bot') select('bot')
        run('bot', (async function* () { yield { type: 'typing', ms: 600 }; yield { type: 'message', text: `记下啦～${whenLabel(r.dueAt)} 叫你${r.title} ⏰` } })())
      } catch (err) { toast(err.message) }
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
  reminder(id, patch) { store.remindersChanged(updateReminder(store.state, id, patch)) },
  demoReminder() {
    const r = addReminder(store.state, { title: '完成数学作业', dueAt: Date.now() + 5000, channelId: 'bot' })
    store.remindersChanged(r)
  },
  reset: () => store.reset(),
}

// ------------------------------------------------------------- reminders
function deliver(r) {
  if (!markDelivered(store.state, r.id)) return
  store.remindersChanged(r)
  const notice = r.noticeId && store.message(r.noticeId)
  let text
  if (notice?.item?.eventAt) {
    const mins = Math.max(0, Math.round((notice.item.eventAt - Date.now()) / 60_000))
    text = `⏰ {nickname}，${r.title}${mins > 0 ? `还有 ${mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`}开始` : '开始啦'}！\n${notice.item.where ? `在${notice.item.where}，` : ''}不要忘记哦～`
  } else {
    text = r.title === ALARM ? `{nickname}，${clock(r.dueAt)} 啦 ⏰\n你定的闹钟到点咯～` : `{nickname}，${clock(r.dueAt)} 啦 ⏰\n该${r.title}了～`
  }
  const m = store.addMessage(r.channelId, { role: 'bot', kind: 'reminder', text, reminderId: r.id }, { unread: r.channelId !== active })
  announce(r.channelId, store.state.profile.botName, plain(m.text, store.state.profile))
}

// ------------------------------------------------------------------- boot
applyPrefs()
sidebar.render()
select(active)
startGaze(document)

startFeed({
  adapters: services.sources,
  intervalMs: services.feedInterval,
  seen: { has: id => store.state.seenItems.includes(id), add: id => { store.state.seenItems.push(id); store.save() } },
  onItem(channelId, item) {
    if (!store.channel(channelId)) return
    const live = Date.now() - item.publishedAt < 60_000
    store.addMessage(channelId, { role: 'bot', kind: 'notice', text: noticeCopy(item), item, at: item.publishedAt }, { unread: channelId !== active })
    if (live) announce(channelId, store.channel(channelId).title, plain(noticeCopy(item), store.state.profile))
  },
})

startScheduler({ due: now => dueReminders(store.state, now), deliver, intervalMs: 1000 })

// First visit: the bot says hello and asks what to call you.
if (!store.state.messages.bot.length) {
  setTimeout(() => run('bot', (async function* () {
    for (const text of GREETING) { yield { type: 'typing', ms: 500 + text.length * 30 }; yield { type: 'message', text } }
  })()), 700)
}
