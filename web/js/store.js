// App state with local persistence and change events. The UI reads `store.state` and
// subscribes to events; everything that changes state goes through a method here.

import { newId } from './reminders.js'
import { hasLook } from './mark/looks.js'
import { LOCAL_CHANNELS, headsUp } from './services/sources.js'
import { DECISION_FIELDS } from './services/notice-summary.js'
import { cleanHomework, isHomework, isHomeworkCard, defaultHomeworkMessages, homeworkCopy } from './services/homework.js'
import { validCalendarDate, validCalendarTime } from './services/calendar.js'
import { cleanRecommendation } from './services/recommendations.js'
import { NOTICE_SORTS, noticeChannels, noticeDeleted } from './services/notice-list.js'

export const STORAGE_KEY = 'pigeonpal.v1'
// 'notice' is accepted only so legacy stored messages can be migrated into `notices`.
const redactStudentNumber = text => text.replace(/(?<!\d)3\d{7,12}(?!\d)/g, '[学号已脱敏]')
const KINDS = ['text', 'notice', 'reminder']
const NOTICE_CAP = 40

export function createInitialState() {
  return {
    version: 1,
    profile: {
      botName: '小浙',
      nickname: '',
      look: 'placeholder',
      image: null,
      theme: 'system',
      motion: 'lively',
      proactive: true,
      quietStart: '23:00',
      quietEnd: '07:30',
      chatW: 380,
    },
    channels: [{ id: 'bot', kind: 'bot' }, ...LOCAL_CHANNELS.map(c => ({ kind: 'source', notify: 'all', ...c }))],
    messages: Object.fromEntries(['bot', ...LOCAL_CHANNELS.map(c => c.id)].map(id => [id, []])),
    notices: {},
    noticeMeta: {},
    noticeSort: 'recommended',
    homeworkItems: {},
    calendarItems: {},
    calendarCompleted: {},
    reminders: [],
    unread: {},
    seenItems: [],
    noticeDelivery: {},
    eventCursor: 0,
  }
}

// Stored data is untrusted: keep only what has the right shape.
export function hydrate(raw) {
  const fresh = createInitialState()
  let stored
  try { stored = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return fresh }
  if (!stored || typeof stored !== 'object' || stored.version !== 1) return fresh
  const p = stored.profile ?? {}
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  if (str(p.botName, 12)) fresh.profile.botName = str(p.botName, 12)
  fresh.profile.nickname = str(p.nickname, 12)
  if (hasLook(p.look) || p.look === 'image') fresh.profile.look = p.look
  if (typeof p.image === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(p.image)) fresh.profile.image = p.image
  if (fresh.profile.look === 'image' && !fresh.profile.image) fresh.profile.look = 'placeholder'
  if (['system', 'light', 'dark'].includes(p.theme)) fresh.profile.theme = p.theme
  if (['lively', 'calm', 'off'].includes(p.motion)) fresh.profile.motion = p.motion
  if (typeof p.proactive === 'boolean') fresh.profile.proactive = p.proactive
  for (const key of ['quietStart', 'quietEnd']) if (/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key] ?? '')) fresh.profile[key] = p[key]
  if (Number.isSafeInteger(p.chatW) && p.chatW >= 280 && p.chatW <= 1200) fresh.profile.chatW = p.chatW

  // The notice rail's own collection: crawled rows, keyed by noticeId.
  if (stored.notices && typeof stored.notices === 'object' && !Array.isArray(stored.notices)) {
    for (const value of Object.values(stored.notices)) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.title !== 'string') continue
      const item = cleanItem(value)
      if (!item.noticeId) continue
      fresh.notices[item.noticeId] = item
    }
  }

  if (Object.hasOwn(NOTICE_SORTS, stored.noticeSort)) fresh.noticeSort = stored.noticeSort
  if (stored.noticeMeta && typeof stored.noticeMeta === 'object' && !Array.isArray(stored.noticeMeta)) {
    for (const [id, value] of Object.entries(stored.noticeMeta)) {
      if (!id || id.length > 1000 || !value || typeof value !== 'object') continue
      const channel = noticeChannels(fresh).find(c => c.id === value.channelId)
      const meta = {
        ...(value.starred === true ? { starred: true } : {}),
        ...(Number.isFinite(value.deletedAt) && value.deletedAt > 0 ? { deletedAt: value.deletedAt } : {}),
        ...(channel && value.unread === true ? { unread: true, channelId: channel.id } : {}),
      }
      if (meta.deletedAt) { delete meta.unread; delete meta.channelId }
      if (Object.keys(meta).length) Object.defineProperty(fresh.noticeMeta, id, { value: meta, enumerable: true, configurable: true, writable: true })
    }
  }

  // Sources the user added themselves (waiting for a real adapter).
  for (const c of Array.isArray(stored.channels) ? stored.channels : []) {
    if (!c || typeof c.id !== 'string' || !/^src-[\w-]{1,48}$/.test(c.id) || fresh.channels.some(x => x.id === c.id)) continue
    if (['group', 'dm'].includes(c.kind) || /^src-(?:group|dm)-/.test(c.id)) continue
    const title = str(c.title, 16)
    if (!title) continue
    fresh.channels.push({ id: c.id, kind: 'source', title, emoji: str(c.emoji, 4) || '🌐', tint: /^#[0-9a-f]{6}$/i.test(c.tint) ? c.tint : '#eef0f4', site: str(c.site, 200), every: '等待接入', notify: 'all', pending: true })
    fresh.messages[c.id] = []
  }

  for (const channel of fresh.channels) {
    const saved = stored.channels?.find?.(c => c?.id === channel.id)
    if (['all', 'mute'].includes(saved?.notify)) channel.notify = saved.notify
    const list = stored.messages?.[channel.id]
    if (!Array.isArray(list)) continue
    fresh.messages[channel.id] = list.filter(m => m && typeof m.id === 'string' && ['bot', 'user'].includes(m.role) && KINDS.includes(m.kind) && typeof m.text === 'string' && Number.isFinite(m.at))
      .map(m => {
        const message = { id: m.id, channelId: channel.id, role: m.role, kind: m.kind, text: m.role === 'bot' ? Array.from(m.text).slice(0, 20000).join('') : redactStudentNumber(m.text.slice(0, 4000)), at: m.at,
          ...(typeof m.quoteId === 'string' ? { quoteId: m.quoteId } : {}),
          ...(typeof m.reminderId === 'string' ? { reminderId: m.reminderId } : {}),
          ...(typeof m.noticeId === 'string' ? { noticeId: m.noticeId.slice(0, 1000) } : {}),
          ...(m.localOnly === true ? { localOnly: true } : {}),
          ...(m.noticeHeadsUp === true ? { noticeHeadsUp: true } : {}),
          ...(m.queryResult === true && isHomework(m.item) ? { queryResult: true } : {}),
          ...(['notice', 'reminder'].includes(m.kind) && m.item && typeof m.item === 'object' ? { item: cleanItem(m.item) } : {}) }
        // Legacy: notices used to live in the transcript as cards. Move them to the rail
        // and leave a short heads-up line that links back to the rail entry.
        if (message.kind === 'notice' && message.item && !isHomework(message.item)) {
          const item = message.item
          message.kind = 'text'
          delete message.item
          if (item.real && item.noticeId) {
            fresh.notices[item.noticeId] ??= item
            message.noticeId = item.noticeId
            message.text = headsUp(item, channel.title ?? '')
          }
        }
        return message
      })
    if (channel.id === 'src-xzzd') fresh.messages[channel.id] = defaultHomeworkMessages(fresh.messages[channel.id])
    const unread = stored.unread?.[channel.id]
    if (Number.isSafeInteger(unread) && unread > 0) fresh.unread[channel.id] = channel.id === 'src-xzzd' ? Math.min(unread, fresh.messages[channel.id].length) : unread
  }
  if (stored.homeworkItems && typeof stored.homeworkItems === 'object' && !Array.isArray(stored.homeworkItems)) {
    for (const value of Object.values(stored.homeworkItems).slice(0, 1000)) {
      if (!value || !isHomework(value) || typeof value.id !== 'string' || typeof value.title !== 'string') continue
      const item = cleanItem(value)
      if (item.noticeId) fresh.homeworkItems[item.noticeId] = item
    }
  } else {
    for (const message of fresh.messages['src-xzzd'].filter(isHomeworkCard)) fresh.homeworkItems[message.item.noticeId] = message.item
  }
  if (stored.calendarItems && typeof stored.calendarItems === 'object' && !Array.isArray(stored.calendarItems)) {
    for (const value of Object.values(stored.calendarItems).slice(0, 1000)) {
      const item = cleanCalendarItem(value)
      if (item) fresh.calendarItems[item.id] = item
    }
  }
  if (stored.calendarCompleted && typeof stored.calendarCompleted === 'object' && !Array.isArray(stored.calendarCompleted)) {
    for (const [id, completed] of Object.entries(stored.calendarCompleted).slice(0, 2000)) {
      if (/^(homework:|notice:|reminder:)/.test(id) && id.length <= 260 && typeof completed === 'boolean') fresh.calendarCompleted[id] = completed
    }
  }
  if (Array.isArray(stored.reminders)) {
    fresh.reminders = stored.reminders.filter(r => r && typeof r.id === 'string' && typeof r.title === 'string' && Number.isFinite(r.dueAt) && ['pending', 'done', 'cancelled'].includes(r.status))
      .map(r => ({ id: r.id, title: r.title.slice(0, 80), dueAt: r.dueAt, status: r.status, channelId: fresh.messages[r.channelId] ? r.channelId : 'bot', noticeId: typeof r.noticeId === 'string' ? r.noticeId : null, deliveredAt: Number.isFinite(r.deliveredAt) ? r.deliveredAt : null, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0, updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
        ...(typeof r.automatic === 'boolean' ? { automatic: r.automatic } : {}) }))
  }
  if (Array.isArray(stored.seenItems)) fresh.seenItems = stored.seenItems.filter(id => typeof id === 'string').slice(-2000)
  if (stored.noticeDelivery && typeof stored.noticeDelivery === 'object') {
    for (const [id, value] of Object.entries(stored.noticeDelivery).slice(-1000)) if (id.length <= 200 && ['pending', 'delivered', 'historical', 'filtered'].includes(value)) fresh.noticeDelivery[id] = value
  }
  for (const message of fresh.messages.bot) if (message.role === 'bot' && message.noticeId && (message.noticeHeadsUp || message.text.startsWith('🔔'))) {
    message.noticeHeadsUp = true
    fresh.noticeDelivery[message.noticeId] = 'delivered'
  }
  // Older versions counted revisions as separate unread notifications. Migrate
  // their counters to unique retained notices, then derive every source counter
  // from the same per-notice markers used by read/delete actions.
  for (const channel of noticeChannels(fresh)) {
    if (!stored.noticeMeta) {
      const rows = Object.values(fresh.notices).filter(n => n.sourceId === channel.sourceId)
        .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      const legacy = stored.unread?.[channel.id]
      const count = Number.isSafeInteger(legacy) && legacy > 0 ? legacy : 0
      for (const n of rows.slice(0, count)) fresh.noticeMeta[n.noticeId] = { unread: true, channelId: channel.id }
    }
    syncNoticeUnread(fresh, channel.id)
  }
  trimNotices(fresh.notices, fresh.noticeMeta)
  if (Number.isSafeInteger(stored.eventCursor) && stored.eventCursor >= 0) fresh.eventCursor = stored.eventCursor
  return fresh
}

function cleanCalendarItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^cal-[\w-]{1,150}$/.test(value.id)
      || typeof value.title !== 'string' || !value.title.trim() || !validCalendarDate(value.date)) return null
  if (value.time && !validCalendarTime(value.time)) return null
  return { id: value.id, title: value.title.trim().slice(0, 80), date: value.date,
    time: value.time || '', completed: value.completed === true,
    ...(typeof value.noticeId === 'string' && value.noticeId.length <= 200 ? { noticeId: value.noticeId } : {}) }
}

function cleanItem(item) {
  const out = {}
  for (const key of ['id', 'noticeId', 'sourceId', 'revision', 'kind', 'category', 'title', 'where', 'summary', 'url', 'deadlineAt', 'eventLabel', 'analysisState', 'publishedDate', 'state']) if (typeof item[key] === 'string') out[key] = item[key].slice(0, 1000)
  for (const key of DECISION_FIELDS) if (typeof item[key] === 'string') out[key] = item[key].slice(0, 600)
  if (typeof item.bodyStatus === 'string') out.bodyStatus = item.bodyStatus.slice(0, 600)
  if (item.real === true) out.real = true
  if (isHomework(out)) { out.homework = cleanHomework(item.homework); out.analysisState = 'local_only' }
  else if (item.recommendation) out.recommendation = cleanRecommendation(item.recommendation)
  if (typeof item.fetchable === 'boolean') out.fetchable = item.fetchable
  if (Number.isSafeInteger(item.contentVersion)) out.contentVersion = item.contentVersion
  for (const key of ['audience', 'notes']) if (Array.isArray(item[key])) out[key] = item[key].filter(value => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 300))
  if (Array.isArray(item.qualityFlags)) out.qualityFlags = item.qualityFlags.filter(value => typeof value === 'string').slice(0, 10)
  if (Array.isArray(item.todos)) out.todos = item.todos.filter(row => typeof row?.text === 'string').slice(0, 20).map(row => ({ text: row.text.slice(0, 300), dueAt: typeof row.dueAt === 'string' ? row.dueAt.slice(0, 40) : null }))
  for (const key of ['eventAt', 'eventEnd', 'publishedAt']) if (Number.isFinite(item[key])) out[key] = item[key]
  if (out.url && !/^https?:\/\//.test(out.url)) delete out.url
  return out
}

// Keep only the newest NOTICE_CAP rows per source so localStorage stays bounded.
function trimNotices(notices, meta = {}) {
  const bySource = new Map()
  for (const item of Object.values(notices)) {
    // User-managed rows and unread notices must survive a cold restart even if
    // they are older than the small feed cache or gone from the remote catalog.
    if (meta[item.noticeId]?.starred || meta[item.noticeId]?.deletedAt || meta[item.noticeId]?.unread) continue
    const key = item.sourceId ?? ''
    if (!bySource.has(key)) bySource.set(key, [])
    bySource.get(key).push(item)
  }
  for (const rows of bySource.values()) {
    if (rows.length <= NOTICE_CAP) continue
    rows.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    for (const drop of rows.slice(NOTICE_CAP)) delete notices[drop.noticeId]
  }
}

function syncNoticeUnread(state, channelId) {
  const count = Object.values(state.noticeMeta).filter(m => m.unread && !m.deletedAt && m.channelId === channelId).length
  if (count) state.unread[channelId] = count
  else delete state.unread[channelId]
}

export function createStore(storage = globalThis.localStorage) {
  let state
  try { state = hydrate(storage?.getItem(STORAGE_KEY)) } catch { state = createInitialState() }
  const listeners = new Map()
  let saveTimer = 0
  let saveFailed = false

  const emit = (event, detail) => { for (const fn of listeners.get(event) ?? []) fn(detail); for (const fn of listeners.get('*') ?? []) fn(event, detail) }
  const flush = () => {
    clearTimeout(saveTimer)
    // The live catalog contains all server metadata so filtered old notices
    // remain recoverable. Keep only a small warm cache in browser storage;
    // the next feed restores the complete catalog without loading any body.
    const notices = { ...state.notices }
    trimNotices(notices, state.noticeMeta)
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ ...state, notices })); saveFailed = false; return true }
    catch { if (!saveFailed) emit('save-failed'); saveFailed = true; return false }
  }
  const save = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 200)
  }

  return {
    get state() { return state },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn) },
    emit,
    save,
    flush,
    channel: id => state.channels.find(c => c.id === id),
    message: id => Object.values(state.messages).flat().find(m => m.id === id),
    lastMessage: id => state.messages[id]?.at(-1),
    notice: id => state.notices[id],
    noticesOf: sourceId => Object.values(state.notices).filter(n => n.sourceId === sourceId && !noticeDeleted(state, n.noticeId)).sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)),
    setNoticeSort(value) {
      if (!Object.hasOwn(NOTICE_SORTS, value) || state.noticeSort === value) return
      state.noticeSort = value
      save()
      emit('notice-meta', { sort: value })
    },
    setNoticeStarred(id, starred) {
      if (!state.notices[id] || typeof starred !== 'boolean') return
      const meta = state.noticeMeta[id] ||= {}
      if (starred) meta.starred = true
      else delete meta.starred
      if (!Object.keys(meta).length) delete state.noticeMeta[id]
      save()
      emit('notice-meta', { noticeId: id })
    },
    trashNotice(id) {
      if (!state.notices[id] || noticeDeleted(state, id)) return
      const meta = state.noticeMeta[id] ||= {}
      const channelId = meta.channelId
      meta.deletedAt = Date.now()
      delete meta.unread
      delete meta.channelId
      if (channelId) syncNoticeUnread(state, channelId)
      save()
      emit('notice-meta', { noticeId: id })
      emit('unread', channelId)
    },
    restoreNotice(id) {
      if (!state.notices[id] || !noticeDeleted(state, id)) return
      delete state.noticeMeta[id].deletedAt
      if (!Object.keys(state.noticeMeta[id]).length) delete state.noticeMeta[id]
      save()
      emit('notice-meta', { noticeId: id })
    },
    setNoticeDelivery(id, value) {
      if (!['pending', 'delivered', 'historical', 'filtered'].includes(value)) return
      state.noticeDelivery[id] = value
      for (const key of Object.keys(state.noticeDelivery).slice(0, -1000)) delete state.noticeDelivery[key]
      save()
    },

    addMessage(channelId, fields, { unread = false } = {}) {
      const message = { id: newId('msg'), channelId, at: Date.now(), kind: 'text', ...fields }
      if (message.role === 'user' && typeof message.text === 'string') message.text = redactStudentNumber(message.text)
      state.messages[channelId].push(message)
      if (unread) state.unread[channelId] = (state.unread[channelId] ?? 0) + 1
      save()
      emit('message', message)
      return message
    },
    upsertNotice(channelId, item, { unread = false } = {}) {
      // Homework cards still live in their source conversation; campus notices
      // live in the separate notice rail.
      if (item?.item && isHomework(item.item)) {
        const fields = item
        const existing = state.messages[channelId].find(message => message.kind === 'notice' && message.item?.noticeId === fields.item.noticeId)
        if (!existing) return { message: this.addMessage(channelId, fields, { unread }), created: true }
        const revised = existing.item.contentVersion !== fields.item.contentVersion || existing.item.revision !== fields.item.revision
        if (unread && revised) state.unread[channelId] = (state.unread[channelId] ?? 0) + 1
        Object.assign(existing, fields)
        save()
        emit('message-updated', existing)
        return { message: existing, created: false, revised }
      }
      const id = item.noticeId
      const existing = state.notices[id]
      const created = !existing
      const revised = !created && existing.revision !== item.revision
      const recommendationChanged = !created && JSON.stringify(existing.recommendation) !== JSON.stringify(item.recommendation)
      state.notices[id] = cleanItem(item)
      if (unread && !noticeDeleted(state, id)) {
        const meta = state.noticeMeta[id] ||= {}
        meta.unread = true
        meta.channelId = channelId
        syncNoticeUnread(state, channelId)
      }
      save()
      emit('notice', { channelId, item: state.notices[id], created, revised, recommendationChanged })
      return { created, revised }
    },
    syncHomeworkSnapshot(items, { now = Date.now(), unread = false } = {}) {
      const channelId = 'src-xzzd', previous = state.messages[channelId] || []
      const homeworkItems = Object.fromEntries(items.filter(isHomework).slice(0, 1000).map(item => [item.noticeId, cleanItem(item)]).filter(([id]) => id))
      const calendarChanged = JSON.stringify(homeworkItems) !== JSON.stringify(state.homeworkItems)
      const cards = previous.filter(isHomeworkCard)
      const byNotice = new Map(cards.map(message => [message.item.noticeId, message]))
      const incoming = items.map(item => ({ id: byNotice.get(item.noticeId)?.id || item.id || newId('msg'),
        role: 'bot', kind: 'notice', channelId, at: item.publishedAt || now, text: homeworkCopy(item), item: cleanItem(item) }))
      const selected = defaultHomeworkMessages(incoming, now)
      const next = [...selected, ...previous.filter(message => !isHomeworkCard(message))]
      if (JSON.stringify(next) === JSON.stringify(previous) && !calendarChanged) return { changed: false, added: [] }
      const added = selected.filter(message => !byNotice.has(message.item.noticeId))
      state.homeworkItems = homeworkItems
      state.messages[channelId] = next
      state.unread[channelId] = unread ? Math.min(8, (state.unread[channelId] || 0) + added.length) : 0
      save()
      emit('homework-snapshot', { channelId })
      return { changed: true, added }
    },
    syncReminders(rows) {
      let dirty = false
      for (const incoming of rows) {
        if (!incoming || typeof incoming.id !== 'string' || !Number.isFinite(incoming.dueAt)) continue
        const row = { ...incoming, channelId: state.channels.some(channel => channel.id === incoming.channelId) ? incoming.channelId : 'bot' }
        const existing = state.reminders.find(reminder => reminder.id === row.id)
        if (existing && (existing.updatedAt || 0) > (row.updatedAt || 0)) continue
        // The runtime polls every couple of seconds; only a real change may re-render listeners.
        const changed = !existing || ['title', 'dueAt', 'status', 'channelId', 'noticeId', 'deliveredAt', 'updatedAt', 'automatic']
          .some(key => existing[key] !== row[key])
        if (!existing || Object.keys(row).some(key => existing[key] !== row[key])) dirty = true
        if (existing) Object.assign(existing, row)
        else state.reminders.push({ ...row })
        if (changed) emit('reminders', row)
      }
      if (dirty) save()
    },
    setEventCursor(cursor) { if (state.eventCursor === cursor) return; state.eventCursor = cursor; save() },
    upsertCalendarItem(fields) {
      const item = cleanCalendarItem(fields)
      if (!item) throw new Error('日历事项需要标题和有效日期')
      if (state.calendarItems[item.id]) item.completed = state.calendarItems[item.id].completed
      state.calendarItems[item.id] = item
      save()
      emit('calendar', item)
      return item
    },
    setCalendarCompleted(id, completed) {
      if (typeof completed !== 'boolean') return
      if (state.calendarItems[id]) {
        const item = state.calendarItems[id]
        item.completed = completed
        // An explicit edit supersedes completion inherited from a notice reminder.
        if (item.noticeId) delete state.calendarCompleted[`notice:${item.noticeId}`]
      }
      else if (/^(homework:|notice:|reminder:)/.test(id) && id.length <= 260) state.calendarCompleted[id] = completed
      else return
      save()
      emit('calendar', { id, completed })
    },
    markRead(channelId) {
      if (!state.unread[channelId]) return
      for (const [id, meta] of Object.entries(state.noticeMeta)) {
        if (meta.channelId !== channelId) continue
        delete meta.unread
        delete meta.channelId
        if (!Object.keys(meta).length) delete state.noticeMeta[id]
      }
      delete state.unread[channelId]
      save()
      emit('unread', channelId)
    },
    markNoticesRead(sourceId = null) {
      for (const channel of noticeChannels(state)) {
        if (!sourceId || channel.sourceId === sourceId) this.markRead(channel.id)
      }
    },
    setProfile(patch) {
      Object.assign(state.profile, patch)
      save()
      emit('profile', patch)
    },
    addChannel(fields) {
      const channel = { id: newId('src').slice(0, 40), kind: 'source', emoji: '🌐', tint: '#eef0f4', every: '等待接入', notify: 'all', pending: true, ...fields }
      state.channels.push(channel)
      state.messages[channel.id] = []
      save()
      emit('channels', channel)
      return channel
    },
    setChannel(id, patch) {
      Object.assign(state.channels.find(c => c.id === id), patch)
      save()
      emit('channel', id)
    },
    // Reminder functions from reminders.js mutate state; call this afterwards.
    remindersChanged(reminder) {
      save()
      emit('reminders', reminder)
    },
    reset() {
      try { storage?.removeItem(STORAGE_KEY) } catch { /* ignore */ }
      state = createInitialState()
      emit('reset')
    },
  }
}
