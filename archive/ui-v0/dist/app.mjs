import { STORAGE_KEY, newId, createInitialState, hydrateState, findMessage, toggleFavorite, addReminder, updateReminder, emitReminder, todayAt } from './state.mjs';
import { icon, avatar, escapeHtml as esc, personalize, displayText, messageText, messageMarkup, dueLabel, dateLabel, timeLabel } from './ui.mjs';

const $ = selector => document.querySelector(selector);
const sidebar = $('#sidebar');
const viewport = $('#viewport');
const dialog = $('#dialog');
const menu = $('#message-menu');
let state;
let storageWarning = false;
try { state = hydrateState(localStorage.getItem(STORAGE_KEY)); } catch { state = createInitialState(); storageWarning = true; }

const ui = {
  view: 'main', filter: 'all', expanded: new Set(),
  drafts: { main: '', campus: '' }, quotes: { main: null, campus: null },
  busy: new Set(), batches: new Map(), timers: new Map(),
  scroll: { main: 0, campus: 0 }, hasNew: { main: false, campus: false },
};
let toastTimer;
let menuTrigger = null;
let settingsAvatar = state.profile.avatar;

function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
  catch { toast('本地保存失败，当前内容仍可使用；刷新后可能无法恢复。'); return false; }
}

function liveMood() { return ui.busy.size ? 'thinking' : 'idle'; }
function isChat() { return ['main', 'campus'].includes(ui.view); }
function atBottom() { return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80; }
function setMood(mood) { document.querySelectorAll('.avatar[data-live="true"]').forEach(node => { node.dataset.mood = mood; }); }

function renderSidebar() {
  const pending = state.reminders.filter(r => r.status === 'pending').sort((a, b) => a.dueAt - b.dueAt);
  const nav = (view, title, glyph, count = 0, source = false) => `<button class="nav-row ${ui.view === view ? 'is-active' : ''} ${source ? 'source-row' : ''}" data-action="navigate" data-view="${view}" ${ui.view === view ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(glyph)}</span>${source ? `<span class="source-name"><span class="nav-label">${title}</span><span class="source-description">一个来源，一条消息流</span></span>` : `<span class="nav-label">${title}</span>`}${count ? `<span class="nav-count">${count}</span>` : ''}</button>`;
  const wasOpen = sidebar.classList.contains('is-open');
  sidebar.innerHTML = `<div class="brand"><span class="brand-symbol">${icon('spark')}</span><span>PigeonPal</span><button class="icon-button brand-tools" data-action="search" aria-label="搜索消息" title="搜索消息 · ⌘K">${icon('search')}</button></div>
<button class="bot-profile" data-action="settings" aria-label="查看 ${esc(state.profile.name)} 的资料">${avatar(state, { size: 87, live: true, mood: liveMood() })}<span class="profile-name">${esc(state.profile.name)}</span><span class="profile-role">你的校园伙伴</span><span class="profile-mood"><span class="mood-dot"></span>${ui.busy.size ? '正在组织语言' : '陪你把日子过从容'}</span></button>
<nav aria-label="频道与功能"><div class="nav-section-label first">日常</div>${nav('main', `和${esc(state.profile.name)}聊天`, 'chat', state.unread.main)}<div class="nav-section-label">消息频道</div>${nav('campus', '校园通知', 'globe', state.unread.campus, true)}<div class="nav-section-label">留给以后</div>${nav('favorites', '收藏', 'bookmark', state.favorites.length)}${nav('reminders', '提醒', 'bell', pending.length)}</nav>
<div class="sidebar-bottom">${pending[0] ? `<button class="next-reminder" data-action="navigate" data-view="reminders">${icon('clock')}<div><span class="next-label">下一件小事 · ${dueLabel(pending[0].dueAt)}</span><span class="next-title">${esc(pending[0].title)}</span></div></button>` : ''}<div class="sidebar-footer"><span class="user-monogram">${esc(state.profile.nickname[0])}</span><span class="user-caption">${esc(state.profile.nickname)}<small>LOCAL COMPANION</small></span><button class="icon-button" data-action="settings" aria-label="设置">${icon('settings')}</button></div></div>`;
  sidebar.classList.toggle('is-open', wasOpen);
}

function renderHeader() {
  const labels = { main: '日常 / 聊天', campus: '消息频道 / 校园通知', favorites: '留给以后 / 收藏', reminders: '留给以后 / 提醒' };
  $('#header').innerHTML = `<div class="header-left"><button class="icon-button menu-toggle" data-action="sidebar" aria-label="打开侧栏">${icon('menu')}</button><span class="header-location">${labels[ui.view]}</span></div><button class="header-bot" data-action="settings" aria-label="查看 bot 资料">${avatar(state, { size: 24, live: true, mood: liveMood() })}${esc(state.profile.name)}</button><div class="header-right"><button class="preview-badge" data-action="about">UI 预览</button><button class="icon-button" data-action="search" aria-label="搜索消息">${icon('search')}</button></div>`;
}

function renderTranscript() {
  const messages = state.messages[ui.view];
  let previous = null;
  const html = messages.map(message => {
    const sameDay = previous && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
    const continuation = sameDay && previous.role === 'bot' && message.role === 'bot' && message.createdAt - previous.createdAt < 120_000;
    const divider = !sameDay ? `<div class="day-divider">${dateLabel(message.createdAt)} · ${new Date(message.createdAt).toDateString() === new Date().toDateString() ? '今天' : '日常记录'}</div>` : '';
    previous = message;
    return divider + messageMarkup(message, state, { continuation, expanded: ui.expanded.has(message.id) });
  }).join('');
  const typing = ui.busy.has(ui.view) ? `<div class="typing-row" role="status" aria-label="${esc(state.profile.name)}正在回复">${avatar(state, { mood: 'thinking' })}<span class="typing-dots"><span></span><span></span><span></span></span></div>` : '';
  return `<div class="transcript">${html}${typing}</div>`;
}

function renderFavorites() {
  const messages = state.favorites.map(id => findMessage(state, id)).filter(Boolean).reverse();
  const filtered = messages.filter(m => ui.filter === 'all' || m.kind === ui.filter);
  const cards = filtered.map(message => `<article class="saved-card"><div class="card-eyebrow">${icon(message.kind === 'writing' ? 'file' : message.kind === 'notice' ? 'globe' : 'chat')}<span>${message.channel === 'campus' ? '校园通知' : `和${esc(state.profile.name)}聊天`}</span><span class="example-tag">${dateLabel(message.createdAt)}</span></div><h2>${esc(message.title ?? personalize(message.text, state).slice(0, 26))}</h2><p>${esc(messageText(message, state).slice(0, 115))}${messageText(message, state).length > 115 ? '…' : ''}</p><div class="saved-footer"><button class="source-link" data-action="jump" data-id="${esc(message.id)}">回到消息 ${icon('arrow')}</button><button class="icon-button" data-action="favorite" data-id="${esc(message.id)}" aria-label="取消收藏">${icon('bookmark')}</button></div></article>`).join('');
  return `<section class="utility-page"><div class="page-heading"><div><div class="page-eyebrow">SAVED FOR LATER</div><h1>收藏</h1><p>值得留住的话，放在这里慢慢看。</p></div></div><div class="filter-tabs" aria-label="筛选收藏">${[['all', '全部'], ['notice', '通知'], ['writing', '文字']].map(([key, title]) => `<button data-action="filter" data-filter="${key}" class="${ui.filter === key ? 'is-active' : ''}" aria-pressed="${ui.filter === key}">${title}</button>`).join('')}</div>${cards ? `<div class="saved-list">${cards}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('bookmark')}</span><h2>${messages.length ? '这里还没有这一类收藏' : '把喜欢的消息留下来'}</h2><p>在消息旁点一下收藏，<br>下次就不必翻很久。</p><button class="soft-button" data-action="navigate" data-view="campus">看看校园通知 ${icon('arrow')}</button></div>`}</section>`;
}

function renderReminderRow(reminder) {
  const pending = reminder.status === 'pending';
  return `<article class="reminder-row ${pending ? '' : 'done'}"><button class="reminder-checkbox" data-action="complete-reminder" data-id="${esc(reminder.id)}" aria-label="${pending ? '完成提醒' : '已结束'}：${esc(reminder.title)}" ${pending ? '' : 'disabled'}>${pending ? '' : icon('check')}</button><div class="reminder-text"><div class="reminder-title">${esc(reminder.title)}</div><div class="reminder-time">${icon('clock')}${dueLabel(reminder.dueAt)}${reminder.deliveredAt && pending ? ' · 已发送预览' : ''}${!pending ? ` · ${reminder.status === 'cancelled' ? '已取消' : '已完成'}` : ''}</div></div>${pending ? `<button class="icon-button" data-action="preview-reminder" data-id="${esc(reminder.id)}" aria-label="预览到点消息" title="预览到点消息">${icon('play')}</button><button class="icon-button" data-action="edit-reminder" data-id="${esc(reminder.id)}" aria-label="修改提醒" title="修改提醒">${icon('edit')}</button><button class="icon-button" data-action="cancel-reminder" data-id="${esc(reminder.id)}" aria-label="取消提醒" title="取消提醒">${icon('close')}</button>` : ''}</article>`;
}

function renderReminders() {
  const pending = state.reminders.filter(r => r.status === 'pending').sort((a, b) => a.dueAt - b.dueAt);
  const finished = state.reminders.filter(r => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
  return `<section class="utility-page"><div class="page-heading"><div><div class="page-eyebrow">A LITTLE LESS TO REMEMBER</div><h1>提醒</h1><p>记下小事，把脑袋放轻松一点。</p></div><button class="primary-button" data-action="new-reminder">${icon('plus')}新建提醒</button></div><div class="reminder-banner">${avatar(state, { size: 47, live: true })}<div><h2>${pending.length ? `有 ${pending.length} 件事情，我帮你记着。` : '暂时没有要惦记的小事。'}</h2><p>也可以在聊天里告诉我，比如“今晚九点提醒我完成数学作业”。</p></div></div>${pending.length ? `<h2 class="section-heading">待处理 · ${pending.length}</h2><div class="reminder-list">${pending.map(renderReminderRow).join('')}</div>` : `<div class="empty-state"><span class="empty-icon">${icon('bell')}</span><h2>今天可以从容一点</h2><p>有想记住的事情，随时告诉我。</p></div>`}${finished.length ? `<h2 class="section-heading">已结束 · ${finished.length}</h2><div class="reminder-list">${finished.map(renderReminderRow).join('')}</div>` : ''}<p class="list-note">点 ${icon('play')} 可预览到点消息。当前为本地 UI 原型，持续后台提醒尚未接入。</p></section>`;
}

function renderViewport({ scroll = 'preserve', arriving = [] } = {}) {
  const oldTop = viewport.scrollTop;
  viewport.innerHTML = isChat() ? renderTranscript() : ui.view === 'favorites' ? renderFavorites() : renderReminders();
  viewport.scrollTop = scroll === 'bottom' ? viewport.scrollHeight : scroll === 'top' ? 0 : oldTop;
  for (const id of arriving) document.getElementById(`message-${id}`)?.classList.add('arriving');
}

function renderComposer() {
  const zone = $('#composer-zone');
  zone.hidden = !isChat();
  if (!isChat()) return;
  const quote = findMessage(state, ui.quotes[ui.view]);
  zone.innerHTML = `<div class="composer-inner"><button class="new-message-button" data-action="new-messages" ${ui.hasNew[ui.view] ? '' : 'hidden'}>有新消息 ${icon('arrow')}</button>${quote ? `<div class="composer-quote">${icon('quote')}<span>${esc(messageText(quote, state).slice(0, 110))}</span><button class="icon-button" data-action="cancel-quote" aria-label="取消引用">${icon('close')}</button></div>` : ''}<div class="composer-suggestions"><button class="suggestion" data-action="summary">${icon('file')}个人总结</button><button class="suggestion" data-action="polish">${icon('edit')}润色文字</button><button class="suggestion" data-action="new-reminder">${icon('bell')}记一件事</button></div><form id="composer-form" class="composer"><button type="button" class="icon-button composer-plus" data-action="compose-menu" aria-label="更多输入操作" aria-haspopup="menu">${icon('plus')}</button><textarea id="message-input" rows="1" maxlength="16000" aria-label="给${esc(state.profile.name)}发消息" placeholder="和${esc(state.profile.name)}说点什么…">${esc(ui.drafts[ui.view])}</textarea><button type="submit" id="send-button" class="send-button" aria-label="发送消息" ${ui.drafts[ui.view].trim() ? '' : 'disabled'}>${icon('send')}</button></form><div class="composer-caption">Enter 发送 · Shift + Enter 换行 · 当前回复为预设演示</div></div>`;
  resizeInput();
}

function resizeInput() {
  const input = $('#message-input');
  if (!input) return;
  input.style.height = '38px';
  input.style.height = `${Math.min(150, Math.max(38, input.scrollHeight))}px`;
}

function render({ scroll = 'preserve', arriving = [] } = {}) {
  document.documentElement.dataset.motion = state.profile.motion;
  renderSidebar(); renderHeader(); renderViewport({ scroll, arriving }); renderComposer();
}

function closeSidebar() { sidebar.classList.remove('is-open'); $('#sidebar-scrim').hidden = true; }
function navigate(view) {
  if (!['main', 'campus', 'favorites', 'reminders'].includes(view)) return;
  if (isChat()) ui.scroll[ui.view] = viewport.scrollTop;
  ui.view = view;
  if (isChat()) { state.unread[view] = 0; persist(); }
  hideMenu(); closeSidebar();
  render({ scroll: 'top' });
  if (isChat()) viewport.scrollTop = ui.scroll[view];
}

function jumpToMessage(id) {
  const message = findMessage(state, id);
  if (!message) return toast('这条消息已经不在记录里了');
  if (dialog.open) dialog.close();
  navigate(message.channel);
  const target = document.getElementById(`message-${id}`);
  target?.scrollIntoView({ block: 'center', behavior: 'auto' });
  target?.focus({ preventScroll: true });
  target?.classList.add('is-highlighted');
  setTimeout(() => target?.classList.remove('is-highlighted'), 1800);
}

function receiveMessages(channel, messages) {
  const follow = ui.view === channel && atBottom();
  state.messages[channel].push(...messages);
  if (ui.view !== channel) state.unread[channel] += messages.length;
  else if (!follow) ui.hasNew[channel] = true;
  persist();
  renderSidebar(); renderHeader();
  if (ui.view === channel) {
    renderViewport({ scroll: follow ? 'bottom' : 'preserve', arriving: messages.map(m => m.id) });
    const button = $('.new-message-button'); if (button) button.hidden = !ui.hasNew[channel];
  }
}

function numberOf(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (text.includes('十')) { const [tens, ones] = text.split('十'); return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0); }
  return digits[text];
}

function parseDemoReminder(text) {
  const match = /(今晚|今天|明天)?\s*(下午|晚上|上午|早上)?\s*(\d{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:点|时)(?:\s*(半|(\d{1,2})分?))?.*?提醒我(?:去)?\s*(.+)/.exec(text);
  if (!match) return null;
  let hour = numberOf(match[3]);
  const minute = match[4] === '半' ? 30 : Number(match[5] ?? 0);
  if ((match[1] === '今晚' || ['下午', '晚上'].includes(match[2])) && hour < 12) hour += 12;
  if (!Number.isInteger(hour) || hour > 23 || hour < 0 || minute > 59) return { error: '这个时间我还没看明白。可以点“记一件事”，选一下具体时间吗？' };
  if (!match[1] && !match[2]) return { error: `你指的是上午还是晚上 ${match[3]} 点？点“记一件事”可以选具体时间。` };
  const date = new Date(); date.setHours(hour, minute, 0, 0);
  if (match[1] === '明天') date.setDate(date.getDate() + 1);
  if (date.getTime() <= Date.now()) return { error: '这个时间今天已经过了。是想设在明天吗？点“记一件事”可以确认一下。' };
  return { title: match[6].replace(/[。！!～~]+$/, '').trim(), dueAt: date.getTime() };
}

function demoReplies(text, channel, quoteId) {
  const make = (kind, content, extra = {}) => ({ id: newId(), role: 'bot', kind, channel, text: content, createdAt: Date.now(), ...extra });
  if (/提醒我/.test(text)) {
    const parsed = parseDemoReminder(text);
    if (parsed?.error) return [make('chat', parsed.error)];
    if (parsed) {
      const reminder = addReminder(state, parsed);
      return [make('chat', `记下啦 ⏰\n${dueLabel(reminder.dueAt)}，${reminder.title}。你可以在“提醒”里修改或预览。`)];
    }
    return [make('chat', '好呀，点一下“记一件事”，把事项和时间填好，我帮你记下来。')];
  }
  if (/(总结|润色|朴实|改写|修改|改得|第二段|自然一点|优化)/.test(text) || quoteId) {
    const reference = findMessage(state, quoteId);
    const summary = /总结/.test(text) && !reference;
    const body = summary ? state.messages.main.find(m => m.id === 'writing-example')?.body ?? '可以按“做过什么—遇到的问题—下一步安排”整理真实经历。' : '写这段总结时，我希望把做过的事情说清楚，也把还需要改进的地方留下来。\n\n与其把经历写得很满，不如选一两件具体的事，说明自己的投入、遇到的问题和实际变化。这样的表达更朴实，也更容易让人理解。\n\n接下来，我会继续调整时间安排，让想做的事逐步变成能落实的小步骤。';
    return [make('writing', summary ? '先给你一个结构参考。具体经历可以再发给我，我们接着改 ✍️' : '可以，我先展示一个更朴实的表达版本。你可以继续针对段落提出修改要求。', { title: summary ? '个人总结 · 结构参考' : '润色结果 · 表达示例', body, ...(quoteId ? { quoteId } : {}) })];
  }
  if (/(累|忙|烦)/.test(text)) return [make('chat', '{nickname}，先缓一缓也没关系。'), make('chat', '今天最让你费神的是哪件事？')];
  if (/(谢谢|好的|知道了|收到|嗯)/.test(text)) return [make('chat', '好～有需要再叫我就行。')];
  return [make('chat', '{nickname}，我在呢 🌿\n现在可以试试写一份总结、润色一段文字，或者让我记下一件事。')];
}

function sendMessage() {
  if (!isChat()) return;
  const channel = ui.view;
  const text = ui.drafts[channel].trim();
  if (!text) return;
  const quoteId = ui.quotes[channel];
  const message = { id: newId(), role: 'user', kind: 'chat', channel, text, createdAt: Date.now(), ...(quoteId ? { quoteId } : {}) };
  state.messages[channel].push(message);
  ui.drafts[channel] = ''; ui.quotes[channel] = null;
  const batch = ui.batches.get(channel) ?? [];
  batch.push({ text, quoteId }); ui.batches.set(channel, batch);
  ui.busy.add(channel);
  clearTimeout(ui.timers.get(channel));
  persist(); render({ scroll: 'bottom', arriving: [message.id] }); $('#message-input')?.focus();
  ui.timers.set(channel, setTimeout(() => {
    const pending = ui.batches.get(channel) ?? [];
    ui.batches.delete(channel); ui.timers.delete(channel); ui.busy.delete(channel);
    let replies;
    try { replies = demoReplies(pending.map(item => item.text).join('\n'), channel, pending.findLast(item => item.quoteId)?.quoteId); }
    catch (error) { replies = [{ id: newId(), role: 'bot', kind: 'chat', channel, text: `这条提醒没有设好：${error.message}`, createdAt: Date.now() }]; }
    receiveMessages(channel, replies);
    setMood(liveMood());
  }, 950));
}

function setQuote(id, modify = false) {
  const message = findMessage(state, id);
  if (!message) return;
  if (ui.view !== message.channel) navigate(message.channel);
  ui.quotes[ui.view] = id;
  renderComposer();
  $('#message-input')?.focus();
  if (modify) toast('写下想修改的地方，原文会一起带上。');
}

function showDialog(title, body) {
  hideMenu();
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;
  dialog.showModal();
  requestAnimationFrame(() => { dialog.querySelector('[autofocus]')?.focus(); });
}

function localDatetime(at) {
  const date = new Date(at);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reminderDialog({ reminder = null, message = null, snooze = false } = {}) {
  const defaultDue = snooze ? Date.now() + 15 * 60_000 : reminder ? Math.max(reminder.dueAt, Date.now() + 60_000) : message?.eventAt ? Math.max(message.eventAt - 15 * 60_000, Date.now() + 60_000) : Date.now() + 60 * 60_000;
  const title = reminder?.title ?? message?.title ?? '';
  showDialog(snooze ? '稍后提醒' : reminder ? '修改提醒' : '记一件事', `<p class="dialog-description">${snooze ? '不用再建一条，选一个更合适的时间就好。' : '事项和时间写清楚，之后也可以随时调整。'}</p><form id="reminder-form" data-reminder-id="${esc(reminder?.id ?? '')}" data-message-id="${esc(message?.id ?? '')}"><label class="field"><span>提醒事项</span><input name="title" value="${esc(title)}" placeholder="比如：完成数学作业" required maxlength="120" autofocus></label><label class="field"><span>什么时候</span><input name="dueAt" type="datetime-local" value="${localDatetime(defaultDue)}" min="${localDatetime(Date.now() + 60_000)}" required></label><p class="form-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="soft-button" data-action="close-dialog">取消</button><button type="submit" class="primary-button">${snooze ? '稍后叫我' : '保存提醒'}</button></div></form>`);
}

function saveReminder(form) {
  try {
    const input = { title: form.elements.title.value, dueAt: new Date(form.elements.dueAt.value).getTime(), messageId: form.dataset.messageId };
    const reminder = form.dataset.reminderId ? updateReminder(state, form.dataset.reminderId, { title: input.title, dueAt: input.dueAt }) : addReminder(state, input);
    persist(); dialog.close();
    if (!form.dataset.reminderId) {
      receiveMessages(reminder.channel, [{ id: newId(), role: 'bot', kind: 'chat', channel: reminder.channel, text: `记下啦 ⏰\n${dueLabel(reminder.dueAt)}，${reminder.title}。`, createdAt: Date.now() }]);
    }
    if (!isChat()) renderViewport(); else renderViewport({ scroll: 'preserve' });
    renderSidebar();
    toast(`${form.dataset.reminderId ? '已调整' : '已记下'} · ${dueLabel(reminder.dueAt)}`);
  } catch (error) {
    const feedback = form.querySelector('.form-error'); feedback.hidden = false; feedback.textContent = error.message;
  }
}

function previewReminder(id) {
  const reminder = state.reminders.find(r => r.id === id);
  if (!reminder || reminder.status !== 'pending') return toast('这条提醒已结束');
  const follow = ui.view === reminder.channel && atBottom();
  const message = emitReminder(state, id);
  if (message) {
    if (ui.view !== reminder.channel) state.unread[reminder.channel]++;
    else if (!follow) ui.hasNew[reminder.channel] = true;
    persist(); render({ scroll: follow ? 'bottom' : 'preserve' });
  }
  const existing = message ?? state.messages[reminder.channel].findLast(m => m.reminderId === id);
  if (existing) jumpToMessage(existing.id);
  setMood('notifying'); setTimeout(() => setMood(liveMood()), 1400);
  toast(message ? '到点消息预览 · 实际提醒时间未改变' : '这条提醒的预览已经在这里了');
}

function settingsDialog() {
  settingsAvatar = state.profile.avatar;
  showDialog('和你熟悉一点', `<p class="dialog-description">名字、称呼和小习惯，都可以慢慢调整。</p><form id="settings-form"><div class="settings-avatar"><span id="settings-avatar-preview">${avatar(state, { size: 66, live: true })}</span><div><label class="soft-button avatar-upload-label" for="avatar-file">${icon('edit')}换张头像</label><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="text-button" data-action="reset-avatar">恢复占位头像</button></div></div><div class="field-grid"><label class="field"><span>bot 的名字</span><input name="botName" maxlength="30" value="${esc(state.profile.name)}" required></label><label class="field"><span>它怎么称呼你</span><input name="nickname" maxlength="30" value="${esc(state.profile.nickname)}" required></label></div><div class="setting-row"><div><strong>轻柔动效</strong><small>头像眨眼、图标悬停反馈。聊天头像保持安静。</small></div><label class="switch"><input type="checkbox" name="motion" aria-label="轻柔动效" ${state.profile.motion === 'soft' ? 'checked' : ''}><span class="switch-track"></span></label></div><div class="setting-row"><div><strong>允许主动消息</strong><small>保存你的偏好，后续接入通知时沿用。</small></div><label class="switch"><input type="checkbox" name="proactive" aria-label="允许主动消息" ${state.profile.proactive ? 'checked' : ''}><span class="switch-track"></span></label></div><div class="field-grid"><label class="field"><span>安静时段 · 开始</span><input type="time" name="quietStart" value="${esc(state.profile.quietStart)}" required></label><label class="field"><span>安静时段 · 结束</span><input type="time" name="quietEnd" value="${esc(state.profile.quietEnd)}" required></label></div><p class="form-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="soft-button" data-action="close-dialog">取消</button><button type="submit" class="primary-button">保存设置</button></div></form>`);
}

function saveSettings(form) {
  const name = form.elements.botName.value.trim();
  const nickname = form.elements.nickname.value.trim();
  if (!name || !nickname) {
    const feedback = form.querySelector('.form-error'); feedback.hidden = false; feedback.textContent = '名字和称呼不能只留空格哦。'; return;
  }
  state.profile = { name, nickname, avatar: settingsAvatar, motion: form.elements.motion.checked ? 'soft' : 'off', proactive: form.elements.proactive.checked, quietStart: form.elements.quietStart.value, quietEnd: form.elements.quietEnd.value };
  const saved = persist(); dialog.close(); render();
  if (saved) toast('记住啦，之后就这样称呼你。');
}

function updateAvatarPreview() { $('#settings-avatar-preview').innerHTML = avatar({ profile: { ...state.profile, avatar: settingsAvatar } }, { size: 66, live: true }); }

async function uploadAvatar(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024) return toast('请选择 2 MB 以内的 PNG、JPG、WebP 或 GIF 图片。');
  try {
    const result = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    if ($('#settings-avatar-preview')) { settingsAvatar = result; updateAvatarPreview(); }
  } catch { toast('这张图片没有读成功，换一张试试。'); }
}

async function copyMessage(id) {
  const message = findMessage(state, id);
  if (!message) return;
  const text = messageText(message, state);
  try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(text); toast('已复制'); }
  catch {
    showDialog('复制这段文字', `<p class="dialog-description">当前浏览器未允许直接复制，可以选中下面的完整文字手动复制。</p><textarea class="manual-copy" readonly autofocus>${esc(text)}</textarea>`);
    requestAnimationFrame(() => dialog.querySelector('textarea')?.select());
  }
}

function searchDialog() {
  showDialog('找一条消息', `<label class="field"><span>搜索聊天、通知和写作内容</span><input id="search-input" type="search" placeholder="想找哪句话？" autocomplete="off" autofocus></label><div id="search-results" class="search-results"></div>`);
  renderSearchResults('');
}

function renderSearchResults(query) {
  const all = Object.values(state.messages).flat().sort((a, b) => b.createdAt - a.createdAt);
  const result = all.filter(m => `${messageText(m, state)} ${personalize(m.text, state)} ${m.title ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 20);
  $('#search-results').innerHTML = result.length ? result.map(m => `<button class="search-result" data-action="jump" data-id="${esc(m.id)}"><strong>${esc(m.title ?? (m.role === 'bot' ? state.profile.name : state.profile.nickname))} · ${m.channel === 'campus' ? '校园通知' : '日常聊天'}</strong><span>${esc(messageText(m, state).slice(0, 95))}</span></button>`).join('') : '<p class="dialog-description">暂时没有找到，可以换个词试试。</p>';
}

function hideMenu({ focus = false } = {}) { menu.hidden = true; if (focus) menuTrigger?.focus(); menuTrigger = null; }
function showMenu(trigger, id, compose = false) {
  if (!menu.hidden && menuTrigger === trigger) { hideMenu({ focus: true }); return; }
  menuTrigger = trigger;
  const item = (action, glyph, label) => `<button role="menuitem" data-action="${action}" data-id="${esc(id ?? '')}">${icon(glyph)}${label}</button>`;
  menu.innerHTML = compose ? item('summary', 'file', '个人总结') + item('polish', 'edit', '润色文字') + item('new-reminder', 'bell', '记一件事') : item('quote', 'quote', '引用回复') + item('remind', 'bell', '创建提醒') + item('copy', 'copy', '复制消息');
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - box.height - 12))}px`;
  menu.querySelector('button')?.focus();
}

function composerPreset(kind) {
  if (!isChat()) navigate('main');
  ui.drafts[ui.view] = kind === 'summary' ? '我想写一份个人总结，可以先给我一个朴实的结构参考吗？' : '帮我润色这段话：这段时间我做了一些学习和活动，想认真总结实际的收获，也想看看之后怎么改进。';
  renderComposer(); $('#message-input')?.focus();
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) { if (!menu.contains(event.target)) hideMenu(); return; }
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (!['more', 'compose-menu'].includes(action)) hideMenu();
  switch (action) {
    case 'navigate': navigate(button.dataset.view); break;
    case 'settings': settingsDialog(); break;
    case 'search': searchDialog(); break;
    case 'sidebar': sidebar.classList.toggle('is-open'); $('#sidebar-scrim').hidden = !sidebar.classList.contains('is-open'); break;
    case 'close-dialog': dialog.close(); break;
    case 'favorite': {
      try { const saved = toggleFavorite(state, id); persist(); renderSidebar(); renderViewport(); toast(saved ? '已放进收藏，之后慢慢看。' : '已取消收藏'); } catch (error) { toast(error.message); } break;
    }
    case 'copy': void copyMessage(id); break;
    case 'expand': ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); renderViewport(); document.querySelector(`[data-action="expand"][data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); break;
    case 'more': showMenu(button, id); break;
    case 'compose-menu': showMenu(button, null, true); break;
    case 'quote': setQuote(id); break;
    case 'modify': setQuote(id, true); break;
    case 'cancel-quote': ui.quotes[ui.view] = null; renderComposer(); $('#message-input')?.focus(); break;
    case 'jump': jumpToMessage(id); break;
    case 'original': {
      const message = findMessage(state, id);
      if (message) showDialog(message.title, `<span class="original-label">原通知 · 演示内容</span><div class="original-notice">${esc(message.detail)}</div>`); break;
    }
    case 'remind': reminderDialog({ message: findMessage(state, id) }); break;
    case 'new-reminder': reminderDialog(); break;
    case 'edit-reminder': reminderDialog({ reminder: state.reminders.find(r => r.id === id) }); break;
    case 'snooze': reminderDialog({ reminder: state.reminders.find(r => r.id === id), snooze: true }); break;
    case 'preview-reminder': previewReminder(id); break;
    case 'complete-reminder':
    case 'cancel-reminder': {
      try { updateReminder(state, id, { status: action === 'complete-reminder' ? 'done' : 'cancelled' }); persist(); renderSidebar(); renderViewport(); toast(action === 'complete-reminder' ? '完成啦，少一件惦记的事。' : '已取消这条提醒'); } catch (error) { toast(error.message); } break;
    }
    case 'summary': composerPreset('summary'); break;
    case 'polish': composerPreset('polish'); break;
    case 'filter': ui.filter = button.dataset.filter; renderViewport({ scroll: 'top' }); break;
    case 'reset-avatar': settingsAvatar = null; updateAvatarPreview(); break;
    case 'new-messages': ui.hasNew[ui.view] = false; viewport.scrollTop = viewport.scrollHeight; button.hidden = true; break;
    case 'about': showDialog('PigeonPal · 第一版', `<div style="display:flex;justify-content:center;margin:6px 0 23px">${avatar(state, { size: 76, live: true })}</div><p class="dialog-description">一个能聊天、记小事，也能帮你整理文字的校园伙伴。</p><p class="dialog-description">现在可以体验界面、复制、收藏、提醒管理和资料设置。聊天与写作回复是预设示例，校园通知也是演示内容；真实模型、网站来源和持续后台提醒会在后续接入。</p><p class="dialog-description" style="margin-bottom:0">头像、名字与记录保存在当前浏览器，原型不向外发送你的内容。</p>`); break;
  }
});

document.addEventListener('submit', event => {
  if (!['composer-form', 'reminder-form', 'settings-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === 'composer-form') sendMessage();
  else if (event.target.id === 'reminder-form') saveReminder(event.target);
  else saveSettings(event.target);
});

document.addEventListener('input', event => {
  if (event.target.id === 'message-input') { ui.drafts[ui.view] = event.target.value; $('#send-button').disabled = !event.target.value.trim(); resizeInput(); }
  else if (event.target.id === 'search-input') renderSearchResults(event.target.value);
});
document.addEventListener('change', event => { if (event.target.id === 'avatar-file') void uploadAvatar(event.target.files[0]); });

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchDialog(); }
  if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const items = [...menu.querySelectorAll('button')]; const index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
  if (event.key === 'Escape') { if (!menu.hidden) { event.preventDefault(); hideMenu({ focus: true }); } closeSidebar(); }
});

$('#sidebar-scrim').addEventListener('click', closeSidebar);
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
viewport.addEventListener('scroll', () => { if (isChat() && atBottom() && ui.hasNew[ui.view]) { ui.hasNew[ui.view] = false; const button = $('.new-message-button'); if (button) button.hidden = true; } }, { passive: true });
window.addEventListener('resize', () => { hideMenu(); if (window.innerWidth > 760) closeSidebar(); });

render({ scroll: 'top' });
if (storageWarning) toast('本地存储不可用，当前记录将在本页暂存。');
