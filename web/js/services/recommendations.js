// Only an explicit server decision may suppress a notice. Missing, failed or
// incomplete recommendations always stay visible.
export function cleanRecommendation(value) {
  if (!value || typeof value !== 'object') return null
  const decision = ['recommended', 'uncertain', 'not_applicable'].includes(value.decision) ? value.decision : 'uncertain'
  return {
    state: typeof value.state === 'string' ? value.state.slice(0, 50) : 'pending', decision,
    allowPush: !(value.state === 'ready' && decision === 'not_applicable' && value.override !== 'keep' && value.allowPush === false), deferPush: value.deferPush === true,
    priority: Number.isFinite(value.priority) ? Math.max(-100, Math.min(100, value.priority)) : 0,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 1500) : '',
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(0, 8).map(entry => {
      if (typeof entry === 'string') return entry.slice(0, 1500)
      if (!entry || typeof entry !== 'object') return ''
      return Object.fromEntries(['quote', 'profileFact', 'field', 'value', 'fact', 'condition', 'profileValue'].filter(key => typeof entry[key] === 'string').map(key => [key, entry[key].slice(0, 1500)]))
    }).filter(entry => typeof entry === 'string' ? entry : Object.keys(entry).length),
    profileVersion: Number.isSafeInteger(value.profileVersion) ? value.profileVersion : 0,
    override: value.override === 'keep' ? 'keep' : null,
  }
}

export const noticeKept = item => item?.recommendation?.allowPush !== false
export const noticePushable = item => noticeKept(item) && item?.recommendation?.deferPush !== true

export function recommendationLabel(value) {
  const recommendation = cleanRecommendation(value)
  if (!recommendation) return '暂未判断 · 保留'
  if (recommendation.override === 'keep') return '你已选择保留'
  if (recommendation.decision === 'not_applicable' && !recommendation.allowPush) return '明确不适用'
  if (recommendation.decision === 'recommended') return '推荐'
  return '可能相关 · 保留'
}

export function evidenceText(entry) {
  if (typeof entry === 'string') return entry
  return [entry?.quote || entry?.condition, entry?.profileFact || entry?.fact || entry?.profileValue || entry?.value].filter(Boolean).join('；画像：')
}

export function orderRecommended(items) {
  return items.filter(noticeKept).slice().sort((a, b) => (b.recommendation?.priority || 0) - (a.recommendation?.priority || 0) || (b.publishedAt || 0) - (a.publishedAt || 0))
}

// Per-notice delivery state is separate from revision de-duplication: a pending
// analysis can finish without creating another heads-up for an old notice.
export function deliveryTransition(previous, item, now = Date.now()) {
  if (previous === 'delivered') return { state: previous, deliver: false }
  const live = Number.isFinite(item.receivedAt) && now - item.receivedAt >= 0 && now - item.receivedAt < 60_000
  if (previous !== 'pending' && !live) return { state: 'historical', deliver: false }
  if (!noticeKept(item)) return { state: 'filtered', deliver: false }
  if (!noticePushable(item)) return { state: 'pending', deliver: false }
  return { state: 'delivered', deliver: true }
}
