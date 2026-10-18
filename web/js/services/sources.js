// Information sources. Each channel in the sidebar is fed by one source adapter:
//
//   adapter = {
//     id, channelId,
//     fetch(): Promise<Item[]>      newest items from the site
//   }
//   Item = { id, title, url, publishedAt, kind?, eventAt?, eventEnd?, where?, summary? }
//
// The feed polls local crawler adapters and delivers new notice revisions to `onItem`.
// Structured AI results come from the local service; legacy demo helpers remain below.

import { clock, dayLabel } from '../ui/format.js'
import { analysisFields, decisionCopy } from './notice-summary.js'

export const NOTICE_CATEGORIES = {
  academic: '学术报告', teaching: '教学教务', activity: '校园活动',
  deadline: '申请／报名', service: '校园服务', other: '其他通知',
}

export function startFeed({ adapters, seen, onItem, intervalMs = 60_000 }) {
  let stopped = false
  let polling = false
  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      for (const adapter of adapters) {
        try {
          const items = await adapter.fetch()
          for (const item of items.sort((a, b) => a.publishedAt - b.publishedAt)) {
            const key = item.revision ? `${item.id}:${item.revision}` : item.id
            if (stopped || seen.has(key)) continue
            onItem(adapter.channelId, item)
            seen.add(key)
          }
        } catch (error) {
          console.warn(`[feed] ${adapter.id} failed`, error)
        }
      }
    } finally { polling = false }
  }
  poll()
  const timer = setInterval(poll, intervalMs)
  return () => { stopped = true; clearInterval(timer) }
}

// How the bot announces an item: one short line with an emoji, then a friendly nudge.
export function eventPhrase(at, now = Date.now()) {
  const day = dayLabel(at, now)
  const evening = new Date(at).getHours() >= 18
  return `${evening && day === '今天' ? '今晚' : evening && day === '明天' ? '明晚' : day} ${clock(at)}`
}

export function noticeCopy(item, now = Date.now()) {
  if (item.real) return decisionCopy(item)
  const day = item.eventAt ? eventPhrase(item.eventAt, now) : ''
  switch (item.kind) {
    case 'talk': return `🎤 ${day} 有一场报告会！\n{nickname}，在${item.where}，感兴趣可以去听听～`
    case 'deadline': return `📌 ${item.title}\n{nickname}，${day} 开放，别错过哦`
    case 'club': return `📷 ${item.title}\n${day} ${item.where}集合，{nickname}要不要一起？`
    default: return `🔔 ${item.title}\n{nickname}，我先帮你记下来啦～`
  }
}

// One line in the companion chat pointing at the rail entry; never carries the full copy,
// so a later revision of the notice cannot leave stale text behind.
export function headsUp(item, channelTitle) {
  const title = Array.from(item.title ?? '').slice(0, 30).join('')
  return `🔔 {nickname}，${channelTitle}有新通知：「${title}」，我放到通知栏了～`
}

export const NOTICE_DRAG_TYPE = 'application/x-pp-notice'

// /api/chat resolves noticeId server-side and hard-fails when the record is pruned or has
// no body, so only complete notices may leave the notice view.
export function isAttachable(item) {
  if (!item?.real || item.fetchable === false) return false
  return item.state ? item.state === 'complete' : item.analysisState === 'ready'
}

export function parseDropPayload(text) {
  if (typeof text !== 'string' || !text) return null
  let data
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object' || typeof data.noticeId !== 'string') return null
  return { noticeId: data.noticeId.slice(0, 200), title: typeof data.title === 'string' ? data.title.slice(0, 200) : '' }
}

export function localAdapters(client) {
  return LOCAL_CHANNELS.map(channel => ({
    id: `local-${channel.sourceId}`, channelId: channel.id,
    async fetch() {
      const rows = []
      let offset = 0
      do {
        const data = await client.notices(channel.sourceId, offset)
        if (!Array.isArray(data.items)) throw new Error('Invalid notice list')
        rows.push(...data.items)
        offset = data.nextOffset
      } while (Number.isSafeInteger(offset) && offset > 0)
      return rows.map(row => {
        const result = row.analysis?.state === 'ready' ? row.analysis.result : null
        const linkOnly = row.state === 'skipped' || row.fetchable === false
        const flags = Array.isArray(row.qualityFlags) ? row.qualityFlags : []
        const linkSummary = !linkOnly ? '' : flags.includes('external_link')
          ? '这条通知链接到其他网站，当前只保存标题和原文链接，正文未采集。'
          : flags.includes('attachment_only')
            ? '这条通知直接指向附件，当前只保存标题和原文链接，附件未下载。'
            : '这条通知当前仅保存标题和原文链接，正文未采集。'
        const exactTime = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
        return {
          id: row.id, noticeId: row.id, revision: row.revision, sourceId: row.sourceId, real: true,
          // Completeness decides whether a notice can be attached to a question.
          state: typeof row.state === 'string' ? row.state : '',
          ...(row.fetchable === false ? { fetchable: false } : {}),
          title: row.title, url: row.url, contentVersion: row.version,
          publishedDate: row.publishedAt || '',
          publishedAt: Date.parse(`${row.publishedAt}T00:00:00+08:00`) || Date.parse(row.firstSeenAt) || Date.now(),
          receivedAt: Date.parse(row.lastChangedAt || row.firstSeenAt),
          kind: ({ academic: 'talk', activity: 'club', deadline: 'deadline' })[result?.category] || 'notice',
          category: result?.category || '',
          eventAt: exactTime(result?.eventAt), eventEnd: exactTime(result?.eventEnd),
          deadlineAt: result?.deadlineAt || null, eventLabel: result?.eventAt || null,
          todos: result?.todos || [],
          ...analysisFields(row.analysis),
          ...(linkOnly ? { analysisState: 'waiting_body', bodyStatus: linkSummary, summary: linkSummary } : {}),
        }
      })
    },
  }))
}

// Stable channels for the local crawler; these are never fed by demo adapters.
export const LOCAL_CHANNELS = [
  { id: 'src-yunfeng', sourceId: 'yunfeng', title: '云峰通知', emoji: '🏫', tint: '#eef3ee', site: 'yunfeng.zju.edu.cn', url: 'https://yunfeng.zju.edu.cn/on/53544/list.psp', every: '每 5 分钟', requiresAuth: false },
  { id: 'src-itc', sourceId: 'itc', title: 'ITC 通知', emoji: '💻', tint: '#eaf2ff', site: 'itc.zju.edu.cn', url: 'https://itc.zju.edu.cn/90618/list.psp', every: '每 5 分钟', requiresAuth: true },
  { id: 'src-qsxy', sourceId: 'qsxy', title: '求是学院通知', emoji: '🎓', tint: '#fff1e5', site: 'qsxy.zju.edu.cn', url: 'http://qsxy.zju.edu.cn/30845/list.psp', every: '每 5 分钟', requiresAuth: false },
  { id: 'src-bksy', sourceId: 'bksy', title: '本科生院通知', emoji: '📚', tint: '#f0ecff', site: 'bksy.zju.edu.cn', url: 'https://bksy.zju.edu.cn/28418/list.htm', every: '每 5 分钟', requiresAuth: false },
]

// ---------------------------------------------------------------------------
// Legacy demo sources (not used by the application)

export const DEMO_CHANNELS = [
  { id: 'talks', title: '学术报告', emoji: '🎤', tint: '#fff1e5', site: '示例 · 学术报告页', every: '每 30 分钟' },
  { id: 'academic', title: '教务通知', emoji: '📌', tint: '#eaf2ff', site: '示例 · 教务处通知', every: '每 1 小时' },
  { id: 'clubs', title: '社团活动', emoji: '🎈', tint: '#f0ecff', site: '示例 · 社团联合会', every: '每 2 小时' },
]

function at(dayOffset, hour, minute = 0, now = Date.now()) {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

// Items published "earlier" show up at once; ones with `arrivesIn` land while you watch.
export function demoItems(now = Date.now()) {
  const tonight = at(0, 19, 0, now) > now ? 0 : 1
  return {
    talks: [
      { id: 'demo-talk-1', kind: 'talk', title: '从大模型到具身智能', eventAt: at(tonight, 19, 0, now), eventEnd: at(tonight, 20, 30, now), where: '图书馆报告厅', publishedAt: now - 2.5 * 3_600_000, summary: '报告将介绍大模型如何走向真实世界中的机器人，并留出 30 分钟交流。示例数据，不对应真实活动。' },
      { id: 'demo-talk-2', kind: 'talk', title: '城市里的鸟：鸽子怎么认路', eventAt: at(1, 14, 0, now), eventEnd: at(1, 15, 30, now), where: '生科楼 201', publishedAt: now, arrivesIn: 9000, summary: '从磁场、气味到地标，聊聊信鸽的导航本领。示例数据，不对应真实活动。' },
    ],
    academic: [
      { id: 'demo-acad-1', kind: 'deadline', title: '下学期选课即将开放', eventAt: at(2, 9, 0, now), publishedAt: now - 26 * 3_600_000, summary: '选课系统开放后先到先得，建议提前确认培养方案。示例数据。' },
      { id: 'demo-acad-2', kind: 'notice', title: '期中考试安排已经发布', publishedAt: now - 40 * 60_000, summary: '各课程考试时间与考场以教务系统为准。示例数据。' },
    ],
    clubs: [
      { id: 'demo-club-1', kind: 'club', title: '摄影社秋季外拍开始报名', eventAt: at(3, 9, 30, now), where: '东门', publishedAt: now - 30 * 3_600_000, summary: '路线：东门 → 湖边 → 银杏大道，自带相机或手机都可以。示例数据。' },
    ],
  }
}

export function demoAdapters(now = Date.now()) {
  const items = demoItems(now)
  const born = Date.now()
  return DEMO_CHANNELS.map(channel => ({
    id: `demo-${channel.id}`,
    channelId: channel.id,
    fetch: async () => items[channel.id]
      .filter(item => !item.arrivesIn || Date.now() - born >= item.arrivesIn)
      .map(item => (item.arrivesIn ? { ...item, publishedAt: Date.now() } : item)),
  }))
}
