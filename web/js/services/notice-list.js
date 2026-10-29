import { NOTICE_CATEGORIES } from './sources.js'
import { noticeKept } from './recommendations.js'

export const NOTICE_SORTS = {
  recommended: '系统推荐程度', newest: '发布时间：从新到旧',
  oldest: '发布时间：从旧到新', type: '通知类型',
}

export const noticeChannels = state => state.channels.filter(c => c.kind === 'source' && c.sourceId && c.sourceId !== 'xzzd')
export const noticeUnreadCount = (state, sourceId = null) => noticeChannels(state)
  .filter(c => !sourceId || c.sourceId === sourceId)
  .reduce((sum, c) => sum + (state.unread[c.id] || 0), 0)
export const noticeDeleted = (state, id) => Boolean(state.noticeMeta?.[id]?.deletedAt)
export const noticeCategory = n => Object.hasOwn(NOTICE_CATEGORIES, n.category) ? n.category : 'other'

// Stars always lead the chosen order, including notices otherwise filtered out by
// recommendations. Undated notices stay last in either chronological direction.
export function selectNotices(state, { sourceId = null, mode = 'recommended', sort = state.noticeSort, trash = false } = {}) {
  const meta = id => state.noticeMeta?.[id] || {}
  const published = n => Number.isFinite(n.publishedAt) && n.publishedAt > 0 ? n.publishedAt : null
  const byDate = (a, b, ascending = false) => {
    const x = published(a), y = published(b)
    if (x === null || y === null) return Number(x === null) - Number(y === null)
    return ascending ? x - y : y - x
  }
  const types = Object.keys(NOTICE_CATEGORIES)
  return Object.values(state.notices).filter(n => (!sourceId || n.sourceId === sourceId)
    && noticeDeleted(state, n.noticeId) === trash
    && (trash || mode === 'all' || meta(n.noticeId).starred || noticeKept(n)))
    .sort((a, b) => {
      const stars = Number(Boolean(meta(b.noticeId).starred)) - Number(Boolean(meta(a.noticeId).starred))
      if (stars) return stars
      if (sort === 'oldest') return byDate(a, b, true) || a.noticeId.localeCompare(b.noticeId)
      if (sort === 'newest') return byDate(a, b) || a.noticeId.localeCompare(b.noticeId)
      if (sort === 'type') {
        const category = types.indexOf(noticeCategory(a)) - types.indexOf(noticeCategory(b))
        if (category) return category
      } else {
        const priority = (b.recommendation?.priority || 0) - (a.recommendation?.priority || 0)
        if (priority) return priority
      }
      return byDate(a, b) || a.noticeId.localeCompare(b.noticeId)
    })
}
