// Information sources. Each channel in the sidebar is fed by one source adapter:
//
//   adapter = {
//     id, channelId,
//     fetch(): Promise<Item[]>      newest items from the site
//   }
//   Item = { id, title, url, publishedAt, kind?, eventAt?, eventEnd?, where?, summary? }
//
// The feed polls every adapter, drops items it has already delivered (by id) and hands
// new ones to `onItem`. The bot's wording for an item comes from `noticeCopy`, which the
// model replaces later. Everything below the line is demo data, not a real school.

import { clock, dayLabel } from '../ui/format.js'

export function startFeed({ adapters, seen, onItem, intervalMs = 60_000 }) {
  let stopped = false
  const poll = async () => {
    for (const adapter of adapters) {
      try {
        const items = await adapter.fetch()
        for (const item of items.sort((a, b) => a.publishedAt - b.publishedAt)) {
          if (stopped || seen.has(item.id)) continue
          seen.add(item.id)
          onItem(adapter.channelId, item)
        }
      } catch (error) {
        console.warn(`[feed] ${adapter.id} failed`, error)
      }
    }
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
  const day = item.eventAt ? eventPhrase(item.eventAt, now) : ''
  switch (item.kind) {
    case 'talk': return `🎤 ${day} 有一场报告会！\n{nickname}，在${item.where}，感兴趣可以去听听～`
    case 'deadline': return `📌 ${item.title}\n{nickname}，${day} 开放，别错过哦`
    case 'club': return `📷 ${item.title}\n${day} ${item.where}集合，{nickname}要不要一起？`
    default: return `🔔 ${item.title}\n{nickname}，我先帮你记下来啦～`
  }
}

// ---------------------------------------------------------------------------
// Demo sources

// Stable channels for the local crawler; these are never fed by demo adapters.
export const LOCAL_CHANNELS = [
  { id: 'src-yunfeng', sourceId: 'yunfeng', title: '云峰通知', emoji: '🏫', tint: '#eef3ee', site: 'yunfeng.zju.edu.cn', url: 'https://yunfeng.zju.edu.cn/on/53544/list.psp', every: '每 5 分钟', requiresAuth: false },
  { id: 'src-itc', sourceId: 'itc', title: 'ITC 通知', emoji: '💻', tint: '#eaf2ff', site: 'itc.zju.edu.cn', url: 'https://itc.zju.edu.cn/90618/list.psp', every: '每 5 分钟', requiresAuth: true },
]

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
