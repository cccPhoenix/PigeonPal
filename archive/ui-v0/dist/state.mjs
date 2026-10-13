export const STORAGE_KEY = 'pigeonpal.ui.v1';

export const newId = () => globalThis.crypto?.randomUUID?.() ?? `pp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const findMessage = (state, id) => Object.values(state.messages).flat().find(message => message.id === id);

export function todayAt(hour, minute = 0, now = Date.now()) {
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function createInitialState(now = Date.now()) {
  const message = (id, role, kind, text, offset, extra = {}) => ({ id, role, kind, text, channel: 'main', createdAt: now + offset, ...extra });
  return {
    version: 1,
    profile: { name: '小浙', nickname: '同学', avatar: null, motion: 'soft', proactive: true, quietStart: '22:00', quietEnd: '08:00' },
    messages: {
      main: [
        message('hello-1', 'bot', 'chat', '{nickname}，今天也一起慢慢来 ☀️', -360_000),
        message('hello-2', 'bot', 'chat', '想聊一聊，还是有一段文字想让我帮忙看看？', -355_000),
        message('writing-request', 'user', 'chat', '我想写一份个人总结，语气朴实一点，可以先给我一个结构参考吗？', -300_000),
        message('writing-example', 'bot', 'writing', '可以呀。我先给你一个结构，把具体经历补进去就能继续润色。', -280_000, {
          title: '个人总结 · 结构参考',
          body: '这段时间，我主要围绕学习和日常活动，逐步调整自己的安排。总结时，我希望把实际做过的事情写清楚，也认真看看还有哪些地方需要改进。\n\n学习方面，可以选取一门课程或一个项目，说明自己做了什么、遇到什么问题，以及如何解决。比起笼统地说“收获很多”，具体的过程更能体现变化。\n\n活动与生活方面，可以挑一两件真实经历，写清承担的工作、与他人的配合，以及从中得到的认识。不必把每件事都写进去，也不需要刻意夸大成果。\n\n接下来，我希望把这些认识落实为可执行的安排，保留已经有效的习惯，并逐步改善时间分配和任务推进的方式。',
        }),
      ],
      campus: [
        message('notice-talk', 'bot', 'notice', '{nickname}，今晚七点有一场报告会 🎤\n主题是大模型与具身智能，感兴趣的话可以看看～', -180_000, {
          channel: 'campus', title: '从大模型到具身智能', source: '校园通知 · 演示来源',
          detail: '时间：今晚 19:00—20:30\n地点：校园报告厅（示例地点）\n主题：从大模型到具身智能\n\n这是一条用于体验界面和提醒流程的虚构通知，不对应真实报告会。后续接入信息来源后，这里会展示原通知正文和原始链接。',
          eventAt: todayAt(19, 0, now),
        }),
        message('notice-reading', 'bot', 'notice', '还有一个轻松一点的消息 📚\n校园读书分享会开始征集主题了，可以先收藏，之后再慢慢看。', -120_000, {
          channel: 'campus', title: '读书分享会 · 主题征集', source: '校园通知 · 演示来源',
          detail: '内容：校园读书分享会主题征集\n参与方式：提交书目与想分享的内容\n\n这是一条虚构的界面演示通知，不对应真实活动或报名渠道。',
        }),
      ],
    },
    favorites: [],
    reminders: [{ id: 'math-reminder', title: '完成数学作业', dueAt: todayAt(21, 0, now), channel: 'main', status: 'pending', messageId: null, deliveredAt: null, createdAt: now }],
    unread: { campus: 2, main: 0 },
  };
}

export function hydrateState(raw, now = Date.now()) {
  const fresh = createInitialState(now);
  let stored;
  try { stored = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fresh; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fresh;
  const profile = stored.profile;
  if (profile && typeof profile === 'object') {
    for (const key of ['name', 'nickname']) if (typeof profile[key] === 'string' && profile[key].trim()) fresh.profile[key] = profile[key].trim().slice(0, 30);
    if (typeof profile.avatar === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(profile.avatar)) fresh.profile.avatar = profile.avatar;
    if (['soft', 'off'].includes(profile.motion)) fresh.profile.motion = profile.motion;
    if (typeof profile.proactive === 'boolean') fresh.profile.proactive = profile.proactive;
    for (const key of ['quietStart', 'quietEnd']) if (/^([01]\d|2[0-3]):[0-5]\d$/.test(profile[key] ?? '')) fresh.profile[key] = profile[key];
  }
  const ids = new Set();
  for (const channel of ['main', 'campus']) {
    if (!Array.isArray(stored.messages?.[channel])) continue;
    fresh.messages[channel] = stored.messages[channel].filter(m => m && typeof m.id === 'string' && !ids.has(m.id) && typeof m.text === 'string' && ['bot', 'user'].includes(m.role) && ['chat', 'writing', 'notice', 'reminder'].includes(m.kind)).map(m => {
      ids.add(m.id);
      const result = { id: m.id, channel, role: m.role, kind: m.kind, text: m.text, createdAt: Number.isFinite(m.createdAt) ? m.createdAt : now };
      for (const key of ['title', 'body', 'source', 'detail', 'reminderId', 'quoteId']) if (typeof m[key] === 'string') result[key] = m[key];
      if (Number.isFinite(m.eventAt)) result.eventAt = m.eventAt;
      return result;
    });
  }
  fresh.favorites = Array.isArray(stored.favorites) ? [...new Set(stored.favorites.filter(id => typeof id === 'string' && findMessage(fresh, id)))] : [];
  if (Array.isArray(stored.reminders)) {
    const reminderIds = new Set();
    fresh.reminders = stored.reminders.filter(r => r && typeof r.id === 'string' && !reminderIds.has(r.id) && typeof r.title === 'string' && r.title.trim() && Number.isFinite(r.dueAt) && ['pending', 'done', 'cancelled'].includes(r.status)).map(r => {
      reminderIds.add(r.id);
      return { id: r.id, title: r.title.slice(0, 120), dueAt: r.dueAt, status: r.status, channel: r.channel === 'campus' ? 'campus' : 'main', messageId: findMessage(fresh, r.messageId)?.id ?? null, deliveredAt: Number.isFinite(r.deliveredAt) ? r.deliveredAt : null, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : now };
    });
  }
  for (const channel of ['main', 'campus']) fresh.unread[channel] = Number.isSafeInteger(stored.unread?.[channel]) && stored.unread[channel] > 0 ? stored.unread[channel] : 0;
  return fresh;
}

export function toggleFavorite(state, messageId) {
  if (!findMessage(state, messageId)) throw new Error('这条消息已经不在记录里了');
  if (state.favorites.includes(messageId)) state.favorites = state.favorites.filter(id => id !== messageId);
  else state.favorites.push(messageId);
  return state.favorites.includes(messageId);
}

function reminderValues(title, dueAt, now) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('先写下想提醒的事情吧');
  const time = typeof dueAt === 'number' ? dueAt : new Date(dueAt).getTime();
  if (!Number.isFinite(time) || time <= now) throw new Error('请选择一个未来的时间');
  return { title: title.trim().slice(0, 120), dueAt: time };
}

export function addReminder(state, input, now = Date.now()) {
  const values = reminderValues(input.title, input.dueAt, now);
  const message = findMessage(state, input.messageId);
  const existing = message && state.reminders.find(r => r.messageId === message.id && r.status === 'pending');
  if (existing) return updateReminder(state, existing.id, values, now);
  const reminder = { id: newId(), ...values, channel: message?.channel ?? 'main', messageId: message?.id ?? null, status: 'pending', deliveredAt: null, createdAt: now };
  state.reminders.push(reminder);
  return reminder;
}

export function updateReminder(state, id, patch, now = Date.now()) {
  const reminder = state.reminders.find(r => r.id === id);
  if (!reminder) throw new Error('没有找到这条提醒');
  if (patch.dueAt !== undefined || patch.title !== undefined) {
    Object.assign(reminder, reminderValues(patch.title ?? reminder.title, patch.dueAt ?? reminder.dueAt, now));
    if (patch.dueAt !== undefined) { reminder.deliveredAt = null; reminder.status = 'pending'; }
  }
  if (patch.status !== undefined) {
    if (!['pending', 'done', 'cancelled'].includes(patch.status)) throw new Error('提醒状态无效');
    reminder.status = patch.status;
  }
  return reminder;
}

export function emitReminder(state, id, now = Date.now()) {
  const reminder = state.reminders.find(r => r.id === id);
  if (!reminder || reminder.status !== 'pending' || reminder.deliveredAt !== null) return null;
  const message = { id: newId(), channel: reminder.channel, role: 'bot', kind: 'reminder', title: reminder.title, reminderId: id, createdAt: now, text: `{nickname}，该${reminder.title}啦 ⏰\n记得给自己留一点从容的时间～` };
  state.messages[reminder.channel].push(message);
  reminder.deliveredAt = now;
  return message;
}
