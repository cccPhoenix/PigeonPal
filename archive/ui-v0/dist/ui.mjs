export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const paths = {
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.5-.7L4 20l1.2-4.5A8.5 8.5 0 1 1 20 11.5Z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  bookmark: '<path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  settings: '<path d="m10 3-.8 2.1-2.2.7-2.2-.4-2 3.4 1.5 1.8v2.8L2.8 15l2 3.4 2.2-.4 2.2.7L10 21h4l.8-2.3 2.2-.7 2.2.4 2-3.4-1.5-1.6v-2.8l1.5-1.8-2-3.4-2.2.4-2.2-.7L14 3Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m6 12 6-6 6 6M12 6v13"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  quote: '<path d="m9 7-5 5 5 5M4 12h9c5 0 7 3 7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h5"/>',
  link: '<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/>',
  spark: '<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8ZM20 2v4m-2-2h4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${escapeHtml(className)}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.chat}</svg>`;
}

// Original pigeon artwork. No gradient/mask IDs, so many avatars can coexist safely.
export const pigeonMarkup = `<svg viewBox="0 0 100 100" fill="none" aria-hidden="true" class="pigeon-art">
<rect width="100" height="100" rx="30" fill="#E8ECFF"/>
<ellipse cx="49" cy="82" rx="25" ry="4" fill="#BBC6F5" opacity=".35"/>
<g class="pigeon-body"><path d="M27 62 13 58c1 9 7 17 18 18l8-8" fill="#8292DC"/><path d="M28 58c0-15 12-26 29-24 10 1 18 12 18 25 0 14-11 22-25 22-13 0-22-9-22-23Z" fill="#91A2EF"/>
<g class="pigeon-wing"><path d="M47 42c-10 2-18 11-17 21 1 9 10 14 20 12 8-2 16-10 17-18-10 2-13-10-20-15Z" fill="#647ED7"/><path d="M39 53c-4 4-5 9-2 12 4 4 11 3 17-2" stroke="#AEBFF9" stroke-width="2.5" stroke-linecap="round"/></g>
<path d="M60 21c-11 0-18 8-18 19 0 12 8 20 18 20s19-8 19-20c0-11-7-19-19-19Z" fill="#C4D1FF"/><path d="m78 37 10 5-10 5" fill="#EAB680"/><path d="M57 22c-2-8-6-10-8-8-2 3 2 7 5 9M61 21c1-7 5-9 7-7 2 2-2 6-5 8" fill="#91A2EF"/>
<g class="pigeon-eye"><ellipse cx="67" cy="36" rx="2.8" ry="3.5" fill="#283B6A"/><circle cx="68" cy="35" r=".8" fill="#fff"/></g><ellipse cx="69" cy="46" rx="4.5" ry="2.8" fill="#F0BEC4" opacity=".75"/></g>
<path d="M46 79v6m-4 0h8m8-6v6m-4 0h8" stroke="#D3A678" stroke-width="3" stroke-linecap="round"/>
</svg>`;

export function avatar(state, { size = 36, live = false, mood = 'idle', extra = '' } = {}) {
  const image = state.profile.avatar;
  return `<span class="avatar ${extra}" style="--avatar-size:${Number(size)}px" data-live="${live}" data-mood="${escapeHtml(mood)}" role="img" aria-label="${escapeHtml(state.profile.name)}的头像">${image ? `<img src="${escapeHtml(image)}" alt="" draggable="false">` : pigeonMarkup}</span>`;
}

export const personalize = (text, state) => String(text ?? '').replaceAll('{nickname}', state.profile.nickname).replaceAll('{name}', state.profile.name);
export const displayText = (text, state) => escapeHtml(personalize(text, state)).replaceAll('\n', '<br>');
export const messageText = (message, state) => personalize(message.body ?? message.text, state);

export function timeLabel(at) { return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); }
export function dateLabel(at) { return new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }); }
export function dueLabel(at) {
  const today = new Date().toDateString();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = new Date(at).toDateString();
  return `${day === today ? '今天' : day === tomorrow.toDateString() ? '明天' : dateLabel(at)} ${timeLabel(at)}`;
}

export function messageMarkup(message, state, { continuation = false, expanded = false } = {}) {
  const saved = state.favorites.includes(message.id);
  const eId = escapeHtml(message.id);
  const isUser = message.role === 'user';
  let body = `<div class="bubble">${displayText(message.text, state)}</div>`;
  if (message.kind === 'notice') {
    body += `<div class="notice-card"><div class="card-eyebrow">${icon('globe')}<span>${escapeHtml(message.source)}</span><span class="example-tag">示例</span></div><h3>${escapeHtml(message.title)}</h3>${message.eventAt ? `<div class="notice-meta"><span>${icon('clock')}${dueLabel(message.eventAt)}</span><span>${icon('calendar')}校园报告厅 · 示例</span></div>` : '<p class="notice-description">一条值得留意的校园动态</p>'}<button class="source-link" data-action="original" data-id="${eId}">查看原通知 ${icon('arrow')}</button><div class="card-actions"><button class="soft-button" data-action="favorite" data-id="${eId}" aria-pressed="${saved}">${icon('bookmark')}${saved ? '已收藏' : '收藏'}</button><button class="soft-button primary-soft" data-action="remind" data-id="${eId}">${icon('bell')}提醒我</button></div></div>`;
  }
  if (message.kind === 'writing') {
    body += `<section class="writing-card ${expanded ? 'is-expanded' : ''}"><div class="writing-heading"><span class="document-icon">${icon('file')}</span><div><h3>${escapeHtml(message.title ?? '文字草稿')}</h3><span class="muted">预设示例 · 可继续修改</span></div></div><div class="writing-body">${displayText(message.body, state)}</div><button class="expand-button" data-action="expand" data-id="${eId}" aria-expanded="${expanded}">${expanded ? '收起正文' : '展开全文'} ${icon('chevron')}</button><div class="writing-actions"><button data-action="copy" data-id="${eId}">${icon('copy')}复制全文</button><button data-action="modify" data-id="${eId}">${icon('edit')}继续修改</button><button class="writing-save ${saved ? 'is-saved' : ''}" data-action="favorite" data-id="${eId}" aria-label="${saved ? '取消收藏' : '收藏文字'}" aria-pressed="${saved}">${icon('bookmark')}</button></div></section>`;
  }
  if (message.kind === 'reminder') {
    const reminder = state.reminders.find(r => r.id === message.reminderId);
    body += `<div class="reminder-actions">${reminder?.status === 'pending' ? `<button class="soft-button" data-action="complete-reminder" data-id="${escapeHtml(reminder.id)}">${icon('check')}完成</button><button class="soft-button" data-action="snooze" data-id="${escapeHtml(reminder.id)}">${icon('clock')}稍后提醒</button>` : `<span class="completed-inline">${icon('check')}${reminder?.status === 'cancelled' ? '已取消' : '已完成'}</span>`}</div>`;
  }
  const quote = message.quoteId ? Object.values(state.messages).flat().find(m => m.id === message.quoteId) : null;
  return `<article class="message ${isUser ? 'user-message' : 'bot-message'} ${continuation ? 'continuation' : ''}" id="message-${eId}" data-message-id="${eId}" tabindex="-1">
${isUser ? '' : `<div class="message-avatar">${continuation ? '<span class="avatar-spacer"></span>' : avatar(state)}</div>`}
<div class="message-content">${quote ? `<button class="message-quote" data-action="jump" data-id="${escapeHtml(quote.id)}">${icon('quote')}${escapeHtml(messageText(quote, state).slice(0, 70))}</button>` : ''}${body}
<div class="message-tools" aria-label="消息操作"><time>${timeLabel(message.createdAt)}</time><button data-action="copy" data-id="${eId}" aria-label="复制消息" title="复制">${icon('copy')}</button><button data-action="favorite" data-id="${eId}" class="${saved ? 'is-saved' : ''}" aria-label="${saved ? '取消收藏' : '收藏消息'}" title="${saved ? '取消收藏' : '收藏'}" aria-pressed="${saved}">${icon('bookmark')}</button><button data-action="more" data-id="${eId}" aria-label="更多消息操作" aria-haspopup="menu">${icon('more')}</button></div></div></article>`;
}
