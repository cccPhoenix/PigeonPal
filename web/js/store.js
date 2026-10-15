// App state with local persistence and change events. The UI reads `store.state` and
// subscribes to events; everything that changes state goes through a method here.

import { newId } from './reminders.js'
import { hasLook } from './mark/looks.js'
import { LOCAL_CHANNELS } from './services/sources.js'
import { cleanActivity, activityText } from './services/activity.js'

export const STORAGE_KEY = 'pigeonpal.v1'
const KINDS = ['text', 'notice', 'reminder', 'activity']

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
    },
    channels: [{ id: 'bot', kind: 'bot' }, ...LOCAL_CHANNELS.map(c => ({ kind: 'source', notify: 'all', ...c }))],
    messages: Object.fromEntries(['bot', ...LOCAL_CHANNELS.map(c => c.id)].map(id => [id, []])),
    reminders: [],
    unread: {},
    seenItems: [],
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

  // Sources the user added themselves (waiting for a real adapter).
  for (const c of Array.isArray(stored.channels) ? stored.channels : []) {
    if (!c || typeof c.id !== 'string' || !/^src-[\w-]{1,48}$/.test(c.id) || fresh.channels.some(x => x.id === c.id)) continue
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
    fresh.messages[channel.id] = list.filter(m => m && typeof m.id === 'string' && KINDS.includes(m.kind)
      && (m.kind === 'activity' ? m.role === 'system' && cleanActivity(m.activity) : ['bot', 'user'].includes(m.role))
      && typeof m.text === 'string' && Number.isFinite(m.at))
      .map(m => ({ id: m.id, channelId: channel.id, role: m.role, kind: m.kind, text: m.text.slice(0, 4000), at: m.at,
        ...(m.kind === 'activity' ? { activity: cleanActivity(m.activity, { restoring: true }),
          text: activityText(cleanActivity(m.activity, { restoring: true })) } : {}),
        ...(typeof m.quoteId === 'string' ? { quoteId: m.quoteId } : {}),
        ...(typeof m.reminderId === 'string' ? { reminderId: m.reminderId } : {}),
        ...(m.kind === 'notice' && m.item && typeof m.item === 'object' ? { item: cleanItem(m.item) } : {}) }))
    const unread = stored.unread?.[channel.id]
    if (Number.isSafeInteger(unread) && unread > 0) fresh.unread[channel.id] = unread
  }
  if (Array.isArray(stored.reminders)) {
    fresh.reminders = stored.reminders.filter(r => r && typeof r.id === 'string' && typeof r.title === 'string' && Number.isFinite(r.dueAt) && ['pending', 'done', 'cancelled'].includes(r.status))
      .map(r => ({ id: r.id, title: r.title.slice(0, 80), dueAt: r.dueAt, status: r.status, channelId: fresh.messages[r.channelId] ? r.channelId : 'bot', noticeId: typeof r.noticeId === 'string' ? r.noticeId : null, deliveredAt: Number.isFinite(r.deliveredAt) ? r.deliveredAt : null, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0, updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0 }))
  }
  if (Array.isArray(stored.seenItems)) fresh.seenItems = stored.seenItems.filter(id => typeof id === 'string').slice(-500)
  if (Number.isSafeInteger(stored.eventCursor) && stored.eventCursor >= 0) fresh.eventCursor = stored.eventCursor
  return fresh
}

function cleanItem(item) {
  const out = {}
  for (const key of ['id', 'noticeId', 'sourceId', 'revision', 'kind', 'category', 'title', 'where', 'summary', 'url', 'deadlineAt', 'eventLabel', 'analysisState', 'publishedDate']) if (typeof item[key] === 'string') out[key] = item[key].slice(0, 1000)
  if (item.real === true) out.real = true
  if (Number.isSafeInteger(item.contentVersion)) out.contentVersion = item.contentVersion
  for (const key of ['audience', 'notes']) if (Array.isArray(item[key])) out[key] = item[key].filter(value => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 300))
  if (Array.isArray(item.todos)) out.todos = item.todos.filter(row => typeof row?.text === 'string').slice(0, 20).map(row => ({ text: row.text.slice(0, 300), dueAt: typeof row.dueAt === 'string' ? row.dueAt.slice(0, 40) : null }))
  for (const key of ['eventAt', 'eventEnd', 'publishedAt']) if (Number.isFinite(item[key])) out[key] = item[key]
  if (out.url && !/^https?:\/\//.test(out.url)) delete out.url
  return out
}

export function createStore(storage = globalThis.localStorage) {
  let state
  try { state = hydrate(storage?.getItem(STORAGE_KEY)) } catch { state = createInitialState() }
  const listeners = new Map()
  let saveTimer = 0
  let saveFailed = false

  const emit = (event, detail) => { for (const fn of listeners.get(event) ?? []) fn(detail); for (const fn of listeners.get('*') ?? []) fn(event, detail) }
  const save = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); saveFailed = false } catch { if (!saveFailed) emit('save-failed'); saveFailed = true }
    }, 200)
  }

  return {
    get state() { return state },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn) },
    emit,
    save,
    channel: id => state.channels.find(c => c.id === id),
    message: id => Object.values(state.messages).flat().find(m => m.id === id),
    lastMessage: id => state.messages[id]?.at(-1),

    addMessage(channelId, fields, { unread = false } = {}) {
      const message = { id: newId('msg'), channelId, at: Date.now(), kind: 'text', ...fields }
      state.messages[channelId].push(message)
      if (unread) state.unread[channelId] = (state.unread[channelId] ?? 0) + 1
      save()
      emit('message', message)
      return message
    },
    upsertActivity(channelId, fields) {
      const activity = cleanActivity(fields?.activity)
      if (!state.messages[channelId] || !activity || typeof fields.id !== 'string'
          || !/^[\w:.-]{1,180}$/.test(fields.id)) return null
      const existing = this.message(fields.id)
      if (existing) {
        if (existing.channelId !== channelId || existing.kind !== 'activity') return null
        if (activity.type === 'processing' && existing.activity.type !== 'processing') return existing
        if (existing.activity.type === 'completed' && activity.type === 'failed') return existing
        if (JSON.stringify(existing.activity) === JSON.stringify(activity)) return existing
        Object.assign(existing, { activity, text: activityText(activity) })
        save()
        emit('activity-updated', existing)
        return existing
      }
      return this.addMessage(channelId, { id: fields.id, role: 'system', kind: 'activity',
        activity, text: activityText(activity), ...(Number.isFinite(fields.at) ? { at: fields.at } : {}) })
    },
    upsertNotice(channelId, fields, { unread = false } = {}) {
      const existing = state.messages[channelId].find(message => message.kind === 'notice' && message.item?.noticeId === fields.item.noticeId)
      if (!existing) return { message: this.addMessage(channelId, fields, { unread }), created: true }
      const revised = existing.item.contentVersion !== fields.item.contentVersion
      if (unread && existing.item.revision !== fields.item.revision) state.unread[channelId] = (state.unread[channelId] ?? 0) + 1
      Object.assign(existing, fields)
      save()
      emit('message-updated', existing)
      return { message: existing, created: false, revised }
    },
    syncReminders(rows) {
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || !Number.isFinite(row.dueAt)) continue
        const existing = state.reminders.find(reminder => reminder.id === row.id)
        if (existing && (existing.updatedAt || 0) > (row.updatedAt || 0)) continue
        if (existing) Object.assign(existing, row)
        else state.reminders.push({ ...row })
        emit('reminders', row)
      }
      save()
    },
    setEventCursor(cursor) { state.eventCursor = cursor; save() },
    markRead(channelId) {
      if (!state.unread[channelId]) return
      delete state.unread[channelId]
      save()
      emit('unread', channelId)
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
