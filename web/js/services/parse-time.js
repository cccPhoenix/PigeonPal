// A small Chinese time reader for the demo chat: "今晚九点提醒我写数学作业",
// "明天早上8点半", "十分钟后". The real model will take this over; until then the
// mock chat asks again whenever this returns null.

const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function cnNumber(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return NaN
  if (!text.includes('十')) return [...text].reduce((n, c) => n * 10 + DIGITS[c], 0)
  const [tens, ones] = text.split('十')
  return (tens ? DIGITS[tens] : 1) * 10 + (ones ? DIGITS[ones] : 0)
}

const NUM = '(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})'
const RELATIVE = new RegExp(`${NUM}\\s*(分钟|个?小时|个?钟头)\\s*(?:之后|以后|后)`)
const DAY = /(今天|今晚|明天|明早|明晚|后天)/
const PERIOD = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明早|明晚)/
const CLOCK = new RegExp(`${NUM}\\s*(?:点|:|：)\\s*(半|一刻|三刻|${NUM}\\s*分?)?`)

export function parseWhen(text, now = Date.now()) {
  const relative = text.match(RELATIVE)
  if (relative) {
    const n = cnNumber(relative[1])
    if (!Number.isFinite(n) || n <= 0) return null
    return { at: now + n * (relative[2].includes('分') ? 60_000 : 3_600_000), matched: [relative[0]] }
  }
  const clock = text.match(CLOCK)
  if (!clock) return null
  let hour = cnNumber(clock[1])
  let minute = 0
  if (clock[2] === '半') minute = 30
  else if (clock[2] === '一刻') minute = 15
  else if (clock[2] === '三刻') minute = 45
  else if (clock[3]) minute = cnNumber(clock[3])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 24 || minute > 59) return null

  const day = text.match(DAY)?.[1]
  const period = text.match(PERIOD)?.[1]
  const pm = period && /下午|傍晚|晚上|今晚|明晚/.test(period)
  if (pm && hour < 12) hour += 12
  if (period === '中午' && hour < 6) hour += 12

  const date = new Date(now)
  date.setSeconds(0, 0)
  const offset = day === '后天' ? 2 : /明/.test(day ?? '') ? 1 : 0
  date.setDate(date.getDate() + offset)
  date.setHours(hour % 24, minute)
  if (!day && date.getTime() <= now) {
    // "9点" said in the afternoon means tonight; otherwise it means tomorrow.
    if (!period && hour < 12) date.setHours(hour + 12)
    if (date.getTime() <= now) { date.setHours(hour % 24); date.setDate(date.getDate() + 1) }
  }
  return { at: date.getTime(), matched: [day, period, clock[0]].filter(Boolean) }
}

// "今晚九点提醒我完成数学作业" → "完成数学作业"
export function reminderTitle(text, matched = []) {
  let rest = text
  for (const part of matched) rest = rest.replace(part, ' ')
  rest = rest.replace(/(请|麻烦)?(你)?(到时候|帮我|记得)?(提醒我|叫我|喊我|提醒一下|提醒)(一下)?/g, ' ')
  if (/闹钟/.test(rest)) rest = rest.replace(/的?闹钟/g, ' ').replace(/(帮我|给我)?(定|设置|设|订)(一个|一下|个)?/g, ' ')
  rest = rest.replace(PERIOD, ' ').replace(DAY, ' ').replace(/^[\s,，。!！~～的要去]+|[\s,，。!！~～哦呀啊吧嘛呢]+$/g, '')
  return rest.replace(/\s+/g, '').slice(0, 40)
}
