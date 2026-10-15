import { hasLook } from '../mark/looks.js'

const TYPES = new Set(['joined', 'handoff', 'processing', 'completed', 'failed', 'unknown',
  'reminder_saved', 'reminder_updated', 'reminder_done', 'reminder_cancelled'])
const ID = /^[\w:.-]{1,180}$/
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : ''

// Only trusted operation producers call this contract. Model prose is not an event.
export function cleanActivity(value, { restoring = false } = {}) {
  if (!value || !TYPES.has(value.type) || !Array.isArray(value.actors)
      || value.actors.length < 1 || value.actors.length > 2) return null
  const actors = value.actors.map(actor => {
    if (!actor || typeof actor.id !== 'string' || !ID.test(actor.id) || !text(actor.name, 32)) return null
    return { id: actor.id, name: text(actor.name, 32), look: hasLook(actor.look) ? actor.look : 'placeholder' }
  })
  if (actors.some(actor => !actor) || value.type === 'handoff'
      && (actors.length !== 2 || actors[0].id === actors[1].id)) return null
  return { type: restoring && value.type === 'processing' ? 'unknown' : value.type,
    actors, detail: text(value.detail, 160) }
}

export function chiefActor(profile) {
  return { id: 'chief', name: profile.botName, look: profile.look }
}

// Parts keep names/avatars together while the same wording is used in storage/search.
export function activityParts(activity) {
  const [actor, target] = activity.actors
  const detail = activity.detail ? ` · ${activity.detail}` : ''
  switch (activity.type) {
    case 'joined': return [actor, ' 加入了频道']
    case 'handoff': return [actor, ' 将任务交给了 ', target, detail]
    case 'processing': return [actor, activity.detail === '本次回复' ? ' 正在等待回复…' : ` 正在处理${detail}…`]
    case 'completed': return [actor, ` 已完成${detail}`]
    case 'failed': return [actor, ' 请求未完成']
    case 'unknown': return [actor, ' 上次请求状态待确认']
    case 'reminder_saved': return [actor, ` 已设置提醒${detail}`]
    case 'reminder_updated': return [actor, ` 已更新提醒${detail}`]
    case 'reminder_done': return [actor, ` 已完成提醒事项${detail}`]
    case 'reminder_cancelled': return [actor, ` 已取消提醒${detail}`]
    default: return []
  }
}

export const activityText = activity => activityParts(activity).map(part => typeof part === 'string' ? part : part.name).join('')

// Exclude UI status records rather than relaying them to the model as user text.
export function chatHistory(messages) {
  return messages.filter(message => ['user', 'bot'].includes(message.role) && message.kind !== 'activity')
}

export function reminderActivity(reminder, previous, profile, operation, actor) {
  if (!reminder || typeof reminder.id !== 'string' || !Number.isFinite(reminder.dueAt)
      || !['pending', 'done', 'cancelled'].includes(reminder.status)) return null
  const type = reminder.status === 'done' ? 'reminder_done' : reminder.status === 'cancelled'
    ? 'reminder_cancelled' : operation === 'create' || !previous ? 'reminder_saved' : 'reminder_updated'
  // The record revision and effective state make retried receipts idempotent.
  const revision = `${Number(reminder.updatedAt) || 0}:${reminder.dueAt}:${reminder.status}`
  return { id: `activity:${reminder.id}:${revision}`,
    activity: { type, actors: [actor || chiefActor(profile)], detail: '' } }
}
