// App state with local persistence and change events. The UI reads `store.state` and
// subscribes to events; everything that changes state goes through a method here.

import { newId } from './reminders.js'
import { hasLook } from './mark/looks.js'
import { LOCAL_CHANNELS } from './services/sources.js'
import { cleanActivity, activityText } from './services/activity.js'
import { cleanBotAppearances, resolveBotAppearance, validBotId, validAvatarImage, cleanBotAppearance } from './mark/bot-appearances.js'
import { DECISION_FIELDS, decisionCopy } from './services/notice-summary.js'

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
    botAppearances: {},
    bots: [{ id: 'chief', name: '小浙', role: 'general', isChief: true, look: 'placeholder', instructions: '', style: '' }],
    teamCursor: 0,
    teamResetAt: 0,
    teamReady: false,
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
  fresh.botAppearances = cleanBotAppearances(stored.botAppearances)
  const bots = cleanBots(stored.bots)
  if (bots.some(bot => bot.id === 'chief')) fresh.bots = bots
  if (Number.isSafeInteger(stored.teamCursor) && stored.teamCursor >= 0) fresh.teamCursor = stored.teamCursor
  if (Number.isSafeInteger(stored.teamResetAt) && stored.teamResetAt > 0) fresh.teamResetAt = stored.teamResetAt

  // Sources the user added themselves (waiting for a real adapter).
  for (const c of Array.isArray(stored.channels) ? stored.channels : []) {
    if (!c || typeof c.id !== 'string' || !/^src-[\w-]{1,48}$/.test(c.id) || fresh.channels.some(x => x.id === c.id)) continue
    const title = str(c.title, ['group', 'dm'].includes(c.kind) ? 32 : 16)
    if (!title) continue
    const kind = ['group', 'dm'].includes(c.kind) ? c.kind : 'source'
    fresh.channels.push({ id: c.id, kind, title, emoji: str(c.emoji, 4) || (kind === 'group' ? '💬' : '🌐'), tint: /^#[0-9a-f]{6}$/i.test(c.tint) ? c.tint : '#eef0f4',
      ...(kind === 'source' ? { site: str(c.site, 200), every: '等待接入', pending: true } : {}),
      ...(kind === 'dm' && validBotId(c.botId) ? { botId: c.botId } : {}), notify: 'all' })
    fresh.messages[c.id] = []
  }

  for (const channel of fresh.channels) {
    const saved = stored.channels?.find?.(c => c?.id === channel.id)
    if (['all', 'mute'].includes(saved?.notify)) channel.notify = saved.notify
    if (Array.isArray(saved?.memberIds)) channel.memberIds = [...new Set(saved.memberIds.filter(id => fresh.bots.some(bot => bot.id === id)))].slice(0, 50)
    const list = stored.messages?.[channel.id]
    if (!Array.isArray(list)) continue
    fresh.messages[channel.id] = list.filter(m => m && typeof m.id === 'string' && KINDS.includes(m.kind)
      && (m.kind === 'activity' ? m.role === 'system' && cleanActivity(m.activity) : ['bot', 'user'].includes(m.role))
      && typeof m.text === 'string' && Number.isFinite(m.at))
      .map(m => ({ id: m.id, channelId: channel.id, role: m.role, kind: m.kind, text: m.text.slice(0, 4000), at: m.at,
        ...(validBotId(m.botId) ? { botId: m.botId } : {}),
        ...(m.kind === 'activity' ? { activity: cleanActivity(m.activity, { restoring: true }),
          text: activityText(cleanActivity(m.activity, { restoring: true })) } : {}),
        ...(typeof m.quoteId === 'string' ? { quoteId: m.quoteId } : {}),
        ...(typeof m.reminderId === 'string' ? { reminderId: m.reminderId } : {}),
        ...(m.kind === 'notice' && m.item && typeof m.item === 'object' ? { item: cleanItem(m.item) } : {}) }))
    for (const message of fresh.messages[channel.id]) {
      if (message.kind === 'notice' && message.item?.real) message.text = decisionCopy(message.item)
    }
    const unread = stored.unread?.[channel.id]
    if (Number.isSafeInteger(unread) && unread > 0) fresh.unread[channel.id] = unread
  }
  if (Array.isArray(stored.reminders)) {
    fresh.reminders = stored.reminders.filter(r => r && typeof r.id === 'string' && typeof r.title === 'string' && Number.isFinite(r.dueAt) && ['pending', 'done', 'cancelled'].includes(r.status))
      .map(r => ({ id: r.id, title: r.title.slice(0, 80), dueAt: r.dueAt, status: r.status, botId: validBotId(r.botId) ? r.botId : 'chief', channelId: fresh.messages[r.channelId] ? r.channelId : 'bot', noticeId: typeof r.noticeId === 'string' ? r.noticeId : null, deliveredAt: Number.isFinite(r.deliveredAt) ? r.deliveredAt : null, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0, updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0 }))
  }
  if (Array.isArray(stored.seenItems)) fresh.seenItems = stored.seenItems.filter(id => typeof id === 'string').slice(-500)
  if (Number.isSafeInteger(stored.eventCursor) && stored.eventCursor >= 0) fresh.eventCursor = stored.eventCursor
  return fresh
}

function cleanBots(rows) {
  if (!Array.isArray(rows)) return []
  const seen = new Set()
  return rows.filter(bot => bot && validBotId(bot.id) && !seen.has(bot.id) && typeof bot.name === 'string'
    && bot.name.trim() && (seen.add(bot.id) || true)).slice(0, 50).map(bot => ({
    id: bot.id, name: bot.name.trim().slice(0, 32), isChief: bot.id === 'chief',
    role: ['general', 'news', 'writer', 'reminder', 'planner'].includes(bot.role) ? bot.role : 'general',
    instructions: typeof bot.instructions === 'string' ? bot.instructions.slice(0, 3000) : '',
    style: typeof bot.style === 'string' ? bot.style.slice(0, 1000) : '',
    look: hasLook(bot.look) ? bot.look : 'placeholder', createdAt: Number.isFinite(bot.createdAt) ? bot.createdAt : 0,
  }))
}

function cleanItem(item) {
  const out = {}
  for (const key of ['id', 'noticeId', 'sourceId', 'revision', 'kind', 'category', 'title', 'where', 'summary', 'url', 'deadlineAt', 'eventLabel', 'analysisState', 'publishedDate']) if (typeof item[key] === 'string') out[key] = item[key].slice(0, 1000)
  for (const key of DECISION_FIELDS) if (typeof item[key] === 'string') out[key] = item[key].slice(0, 600)
  if (typeof item.bodyStatus === 'string') out.bodyStatus = item.bodyStatus.slice(0, 600)
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
    bot: id => state.bots.find(bot => bot.id === id),
    syncBots(data) {
      const bots = cleanBots(data?.bots)
      if (!bots.some(bot => bot.id === 'chief') || !Array.isArray(data?.channels)) return false
      state.teamReady = true
      const before = JSON.stringify({ bots: state.bots, channels: state.channels })
      state.bots = bots
      for (const value of data.channels) {
        if (!value || typeof value.id !== 'string' || !/^(?:bot|src-[\w-]{1,48})$/.test(value.id)
            || !['source', 'group', 'dm', 'bot'].includes(value.kind) || !Array.isArray(value.memberIds)) continue
        const memberIds = [...new Set(value.memberIds.filter(id => bots.some(bot => bot.id === id)))].slice(0, 50)
        let channel = state.channels.find(row => row.id === value.id)
        if (!channel) {
          channel = { id: value.id, kind: value.kind, title: typeof value.title === 'string' ? value.title.slice(0, 32) : '频道',
            emoji: '💬', tint: '#eef0f4', notify: 'all' }
          state.channels.push(channel)
          state.messages[channel.id] = []
        }
        channel.memberIds = value.id === 'bot' ? [...new Set(['chief', ...memberIds])] : memberIds
        if (validBotId(value.botId)) channel.botId = value.botId
        if (['group', 'dm'].includes(channel.kind) && typeof value.title === 'string') channel.title = value.title.slice(0, 32)
      }
      if (before === JSON.stringify({ bots: state.bots, channels: state.channels })) return true
      save()
      emit('bots', data)
      return true
    },
    setTeamCursor(cursor) { if (Number.isSafeInteger(cursor) && cursor >= 0) { state.teamCursor = cursor; save() } },
    botAppearance: actor => resolveBotAppearance(state, actor),
    setBotAppearance(id, patch) {
      if (!validBotId(id) || !patch || typeof patch !== 'object'
          || 'image' in patch && patch.image !== null && !validAvatarImage(patch.image)
          || 'look' in patch && !hasLook(patch.look) && patch.look !== 'image'
          || 'name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) return false
      const previous = resolveBotAppearance(state, { id })
      const value = cleanBotAppearance({ ...previous, ...patch })
      if (patch.look === 'image' && value.look !== 'image') return false
      if (id === 'chief') this.setProfile({ look: value.look, image: value.image, botName: value.name.slice(0, 12) })
      else {
        state.botAppearances[id] = value
        save()
        emit('bot-appearance', { id, ...value })
      }
      return true
    },

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
      let channel = fields?.id && state.channels.find(row => row.id === fields.id)
      if (channel) Object.assign(channel, { every: '等待接入', pending: true, ...fields })
      else {
        channel = { id: newId('src').slice(0, 40), kind: 'source', emoji: '🌐', tint: '#eef0f4', every: '等待接入', notify: 'all', pending: true, ...fields }
        state.channels.push(channel)
      }
      state.messages[channel.id] ??= []
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
      clearTimeout(saveTimer)
      const cursor = state.teamCursor
      state = createInitialState()
      state.teamCursor = cursor
      state.teamResetAt = Date.now()
      // Persist synchronously: the reset listener reloads the page immediately.
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { emit('save-failed'); return }
      emit('reset')
    },
  }
}
