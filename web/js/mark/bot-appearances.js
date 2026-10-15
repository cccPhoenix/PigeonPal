import { hasLook } from './looks.js'

// Visual presets are not executable bots or channel memberships.
export const BOT_PRESETS = [
  { id: 'chief', name: 'Chief', look: 'pigeon', description: '主伙伴' },
  { id: 'news', name: '通知鸽', look: 'courier', description: '通知角色预设' },
  { id: 'writer', name: '写作鸽', look: 'courier', description: '写作角色预设' },
  { id: 'reminder', name: '提醒鸽', look: 'pigeon', description: '提醒角色预设' },
]
const SAFE_ID = /^[a-z][\w-]{0,63}$/
export const validBotId = id => typeof id === 'string' && SAFE_ID.test(id)
  && !['__proto__', 'constructor', 'prototype'].includes(id)
export const validAvatarImage = image => typeof image === 'string' && image.length <= 2_000_128
  && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)

export function cleanBotAppearance(value = {}) {
  const image = validAvatarImage(value.image) ? value.image : null
  const look = hasLook(value.look) ? value.look : value.look === 'image' && image ? 'image' : 'placeholder'
  return { ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim().slice(0, 32) } : {}), look, image }
}

export function cleanBotAppearances(value) {
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [id, appearance] of Object.entries(value).slice(0, 50)) {
    if (id === 'chief' || !validBotId(id) || !appearance || typeof appearance !== 'object') continue
    result[id] = cleanBotAppearance(appearance)
  }
  return result
}

export function resolveBotAppearance(state, actor = {}) {
  if (actor.id === 'chief') return { id: 'chief', name: state.profile.botName,
    look: state.profile.look, image: state.profile.image }
  const preset = BOT_PRESETS.find(bot => bot.id === actor.id)
  const registered = state.bots?.find(bot => bot.id === actor.id)
  const override = Object.hasOwn(state.botAppearances || {}, actor.id) ? state.botAppearances[actor.id] : null
  const appearance = cleanBotAppearance(override || { ...preset, ...registered, ...actor })
  return { ...appearance, id: actor.id, name: registered?.name || appearance.name || preset?.name || actor.name || 'Bot' }
}

export function botAppearanceChoices(state) {
  const choices = (state.bots?.length ? state.bots : BOT_PRESETS).map(bot => ({ ...bot, ...resolveBotAppearance(state, bot) }))
  for (const id of Object.keys(state.botAppearances || {})) {
    if (!choices.some(bot => bot.id === id)) choices.push({ ...resolveBotAppearance(state, { id }), description: '角色形象' })
  }
  return choices
}

// The lab reads visual preferences only, and never hydrates or saves real messages.
export function readAppearancePreferences(raw) {
  let value
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  if (!value || value.version !== 1) return null
  const profile = value.profile || {}
  const appearance = cleanBotAppearance({ name: profile.botName, look: profile.look, image: profile.image })
  return { profile: { ...(appearance.name ? { botName: appearance.name.slice(0, 12) } : {}),
    look: appearance.look, image: appearance.image }, botAppearances: cleanBotAppearances(value.botAppearances),
    bots: Array.isArray(value.bots) ? value.bots.filter(bot => validBotId(bot?.id) && typeof bot.name === 'string')
      .slice(0, 50).map(bot => ({ id: bot.id, name: bot.name.slice(0, 32), look: hasLook(bot.look) ? bot.look : 'placeholder',
        role: ['general', 'news', 'writer', 'reminder', 'planner'].includes(bot.role) ? bot.role : 'general', isChief: bot.id === 'chief' })) : [] }
}
