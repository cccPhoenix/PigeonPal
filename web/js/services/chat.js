// Chat service. The app talks to the bot only through `respond`, an async generator
// that yields events in order:
//
//   { type: 'typing', ms }                      show the typing state for ms
//   { type: 'message', text }                   one bubble from the bot
//   { type: 'action', name, args }              ask the app to change state
//       'profile.update'  { nickname }
//       'reminder.upsert' { id, title, dueAt, ... }
//
// The app uses createAIChat. The old demo remains only for the legacy unit tests.

import { parseWhen, reminderTitle } from './parse-time.js'
import { whenLabel, personalize } from '../ui/format.js'
import { chiefActor, chatHistory } from './activity.js'

// Model history is bounded independently of visible Markdown documents.
export function buildChatHistory(messages, profile) {
  const history = []
  let budget = 18000
  for (const message of chatHistory(messages).slice().reverse()) {
    const text = Array.from(personalize(message.text, profile))
    for (let end = text.length; end > 0; end -= 1800) {
      const chunk = text.slice(Math.max(0, end - 1800), end)
      if (history.length >= 24 || chunk.length > budget) return history
      budget -= chunk.length
      history.unshift({ role: message.role === 'bot' ? 'assistant' : 'user', content: chunk.join('') })
    }
  }
  return history
}

const pick = list => list[Math.floor(Math.random() * list.length)]
// Roughly how long a person takes to type a line.
const typingFor = text => Math.min(2200, 450 + text.length * 38)

function* say(...lines) {
  for (const text of lines) {
    yield { type: 'typing', ms: typingFor(text) }
    yield { type: 'message', text }
  }
}

// A bare "set an alarm" has no task; the reminder is just the time.
export const ALARM = '闹钟'

export const GREETING = ['嗨～我是{name} 👋', '以后学校里有什么新鲜事，我会第一时间来告诉你。', '对了，我该怎么称呼你呀？']

export function createAIChat(client) {
  return {
    async *respond({ text, channelId, state, requestId, quoteId, history, botId }) {
      const legacy = !state.teamReady
      const status = type => ({ type: 'activity', id: `activity:${requestId}`,
        activity: { type, actors: [chiefActor(state.profile)], detail: '本次回复' } })
      if (legacy) yield status('processing')
      yield { type: 'typing', ms: 0, ...(botId ? { botId } : {}) }
      const quoted = quoteId && Object.values(state.messages).flat().find(message => message.id === quoteId)
      try {
        const result = await client.chat({ text, channelId, requestId,
          ...(botId ? { botId } : {}),
          profile: { botName: state.profile.botName, nickname: state.profile.nickname },
          history, ...(quoted ? { quotedText: String(quoted.text).slice(0, 4000) } : {}),
          ...(quoted?.item?.noticeId ? { noticeId: quoted.item.noticeId } : {}) })
        if (!Array.isArray(result.events) || !result.events.some(event => event?.type === 'message'
          && typeof event.text === 'string' && event.text.trim())) throw new Error('Invalid chat events')
        for (const event of result.events) {
          if (!event || typeof event !== 'object') continue
          if (event.type === 'action' && ['profile.update', 'reminder.upsert', 'bots.sync'].includes(event.name)) yield event
          else if (event.type === 'activity' && typeof event.id === 'string') yield event
          else if (event.type === 'message' && typeof event.text === 'string') {
            if (typeof event.id === 'string') {
              yield { type: 'message', id: event.id, text: event.text, ...(event.botId ? { botId: event.botId } : {}) }
              continue
            }
            yield { type: 'message', text: event.text, ...(event.botId ? { botId: event.botId } : {}) }
          }
        }
        if (legacy) yield status('completed')
      } catch (error) {
        if (legacy) yield status('failed')
        throw error
      }
    },
  }
}

export function createDemoChat() {
  return {
    async *respond({ text, state }) {
      const now = Date.now()
      const input = text.trim()

      if (!state.profile.nickname) {
        // Only take it as a name when it looks like one; otherwise answer and ask again.
        const named = input.match(/^(?:叫我|我叫|我是|你可以叫我|就叫我|喊我)\s*(.+)$/)
        const nickname = (named ? named[1] : input).replace(/[。.!！~～吧呀啊]+$/, '').trim()
        if (!nickname || nickname.length > 8 || (!named && /[，,？?。！!\s]|你|吗|什么|怎么/.test(nickname))) {
          yield* say('哈哈先等等～', '还没告诉我该怎么称呼你呢？比如「叫我阿俊」')
          return
        }
        yield { type: 'action', name: 'profile.update', args: { nickname } }
        yield* say(`好嘞，${nickname}！记住啦 ✌️`, '左边那几个频道我会帮你盯着，有新消息就来叫你。想让我提醒你什么，直接跟我说就行～')
        return
      }

      if (/提醒|叫我|喊我|闹钟/.test(input)) {
        const when = parseWhen(input, now)
        const alarm = /闹钟/.test(input)
        const title = reminderTitle(input, when?.matched) || (alarm ? ALARM : '')
        if (!when) { yield* say('好呀，几点提醒你？⏰'); return }
        if (!title) { yield* say('收到时间啦，要提醒你做什么呢？'); return }
        yield { type: 'action', name: 'reminder.create', args: { title, dueAt: when.at } }
        yield* say(title === ALARM ? `好～${whenLabel(when.at, now)} 准时叫你 ⏰` : `好～${whenLabel(when.at, now)} 叫你${title} ⏰`)
        return
      }

      if (/^(你好|嗨|hi|hello|在吗|在不在|哈喽)/i.test(input)) { yield* say(pick(['在呢～', '来啦 👀', '嗨嗨']), '今天过得怎么样？'); return }
      if (/累|烦|难过|压力|焦虑|不开心/.test(input)) { yield* say('抱抱 🫂', '要不要说说发生了什么？不想说也没关系，先歇一会儿。'); return }
      if (/谢|thx|thanks/i.test(input)) { yield* say(pick(['不客气～', '小事一桩 😎', '随时找我！'])); return }
      if (/报告|讲座|活动|通知/.test(input)) { yield* say('左边频道里都是我帮你收集的～', '看到感兴趣的点「提醒我」，到时候我来叫你。'); return }

      yield* say(pick([
        '嗯嗯，我在听～',
        '哈哈，这个我记下了',
        '有意思！然后呢？',
      ]), pick(['（现在还是演示模式，我只会说几句固定的话。接上模型后就能好好聊啦）', '（演示模式：真正的回复要等接上模型～）']))
    },
  }
}
