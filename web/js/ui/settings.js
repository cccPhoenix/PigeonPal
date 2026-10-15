import { botFace, BOT_ROLES } from './team.js'
import { markHTML } from '../mark/index.js'
import { LOOKS, LOOK_IDS } from '../mark/looks.js'
import { pendingReminders } from '../reminders.js'
import { icon } from './icons.js'
import { escapeHtml, whenLabel } from './format.js'
import { sheet, closeOverlay, toast } from './overlays.js'
import { apiErrorText } from '../services/api.js'

const PAGES = [
  ['bot', '形象与称呼', 'sparkle'],
  ['reminders', '提醒', 'bell'],
  ['notify', '主动消息', 'rss'],
  ['auth', '身份认证', 'key'],
  ['api', 'API 设置', 'settings'],
  ['look', '外观', 'image'],
  ['about', '关于', 'settings'],
]

// Settings sheet. `api` is what it may change: { store, reminder(id, patch), demoReminder(), reset() }
export function openSettings(api, { page = 'bot', botId = 'chief', opener } = {}) {
  if (page === 'auth') return api.openIdentityAuth?.(opener)
  if (page === 'api') return api.openApiSettings?.(opener)
  const { store } = api
  let closed = false
  const box = sheet(`<nav class="sheet-nav"><h2>设置</h2>${PAGES.map(([id, label, ic]) => `<button class="nav-item" data-page="${id}">${icon(ic, 16)}${label}</button>`).join('')}</nav>
<div class="sheet-body"></div>
<button class="icon-btn flat sheet-close" data-set="close" aria-label="关闭">${icon('close')}</button>`, { opener, onClose: () => { closed = true } })
  const body = box.querySelector('.sheet-body')
  let currentPage = page
  let selectedBotId = (store.bot?.(botId) || botId === 'chief') ? botId : 'chief'
  const selectedBot = () => store.bot?.(selectedBotId) || { id: 'chief', name: store.state.profile.botName }
  const appearance = () => store.botAppearance(selectedBot())

  const p = () => store.state.profile
  const seg = (key, options) => `<div class="seg" role="group">${options.map(([v, l]) => `<button data-seg="${key}" data-v="${v}" aria-pressed="${p()[key] === v}">${l}</button>`).join('')}</div>`
  const sw = (key, on) => `<button class="switch" role="switch" data-switch="${key}" aria-checked="${on}"></button>`

  const pages = {
    bot: () => `<h3>形象与称呼</h3>
<div class="bot-picker" aria-label="选择伙伴">${(store.state.bots?.length ? store.state.bots : [{ id: 'chief', name: p().botName }]).map(bot => `<button class="bot-pick" data-bot-pick="${escapeHtml(bot.id)}" aria-pressed="${selectedBotId === bot.id}">${botFace(store, bot, 32)}<span>${escapeHtml(store.botAppearance(bot).name)}</span></button>`).join('')}</div>
<div class="field"><label for="f-bot">它的名字${selectedBotId === 'chief' ? ' · Chief' : ''}</label><input class="input" id="f-bot" data-bot-name maxlength="${selectedBotId === 'chief' ? 12 : 32}" value="${escapeHtml(appearance().name)}"><span class="help">修改名字需要本机服务保存。每位伙伴的形象分别保存在当前浏览器。</span></div>
${selectedBotId === 'chief' ? `<div class="field"><label for="f-nick">它怎么叫你</label><input class="input" id="f-nick" data-field="nickname" maxlength="12" placeholder="同学" value="${escapeHtml(p().nickname)}"><span class="help">通知和提醒里的「{称呼}」都会换成这个</span></div>` : ''}
${store.bot?.(selectedBotId) ? `<details class="bot-config"><summary>职责与说话方式</summary>
<div class="field"><label for="f-role">职责</label><select class="input" id="f-role" data-config="role">${Object.entries(BOT_ROLES).map(([id, label]) => `<option value="${id}" ${selectedBot().role === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
<div class="field"><label for="f-instructions">工作说明</label><textarea class="input" id="f-instructions" data-config="instructions" maxlength="3000" rows="4">${escapeHtml(selectedBot().instructions || '')}</textarea></div>
<div class="field"><label for="f-style">说话风格</label><input class="input" id="f-style" data-config="style" maxlength="1000" value="${escapeHtml(selectedBot().style || '')}"></div>
<div class="team-error" data-config-error role="alert"></div><div class="btns"><button class="btn" data-save-config>保存职责与风格</button></div></details>` : ''}
<div class="field"><span class="label">形象</span>
<div class="looks">${LOOK_IDS.map(id => `<button class="look" data-look="${id}" aria-pressed="${appearance().look === id}">${markHTML({ look: id, size: 56, live: true })}<span>${escapeHtml(LOOKS[id].label)}</span><small>${escapeHtml(LOOKS[id].note)}</small></button>`).join('')}
<button class="look" data-look="image" aria-pressed="${appearance().look === 'image'}">${appearance().image ? markHTML({ image: appearance().image, size: 56, live: true }) : `<span class="mk" style="--mk-size:56px;display:grid;place-items:center;color:var(--ink-3)">${icon('image', 26)}</span>`}<span>上传图片</span><small>PNG / SVG / GIF</small></button>
</div>${appearance().image ? '<button class="btn" data-replace-image style="margin-top:10px">更换图片</button>' : ''}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-upload hidden>
<span class="help">为当前伙伴选择内置形象或上传图片。可以在 <a href="./lab.html" target="_blank">形象实验室</a> 对比大小和动作；选择后会同步到聊天头像。</span></div>`,

    reminders: () => {
      const list = pendingReminders(store.state)
      const past = store.state.reminders.filter(r => r.status !== 'pending').sort((a, b) => b.dueAt - a.dueAt).slice(0, 8)
      const row = r => `<div class="rem ${r.status}" data-rem="${escapeHtml(r.id)}">
  <button class="rem-check" data-rem-act="${r.status === 'done' ? 'reopen' : 'done'}" aria-label="${r.status === 'done' ? '标记未完成' : '完成'}">${icon('check', 14)}</button>
  <div class="rem-text"><div class="rem-title">${escapeHtml(r.title)}</div><div class="rem-when">${escapeHtml(whenLabel(r.dueAt))}${r.status === 'cancelled' ? ' · 已取消' : ''}</div></div>
  ${r.status === 'pending' ? `<input class="input" type="datetime-local" data-rem-time value="${toLocalInput(r.dueAt)}" aria-label="修改时间"><button class="tool" data-rem-act="cancel" aria-label="取消提醒">${icon('trash', 16)}</button>` : ''}
</div>`
      return `<h3>提醒</h3>
<p class="note">直接在聊天里说「今晚九点提醒我写数学作业」就能新建提醒。保持本机服务运行，到点会记录提醒；重新打开页面也能收到。</p>
<div class="rem-list">${list.length ? list.map(row).join('') : '<p class="muted">暂时没有待办的提醒</p>'}</div>
${past.length ? `<div class="pop-title" style="padding:18px 0 4px">已结束</div><div class="rem-list">${past.map(row).join('')}</div>` : ''}
<div class="btns" style="margin-top:18px"><button class="btn" data-set="demo-reminder">演示：5 秒后来一条提醒</button></div>`
    },

    notify: () => `<h3>主动消息</h3>
<div class="toggle-row"><div><div class="t">让${escapeHtml(p().botName)}主动找我</div><div class="d">有新通知或提醒到点时发消息</div></div>${sw('proactive', p().proactive)}</div>
${store.state.channels.filter(c => c.kind === 'source').map(c => `<div class="toggle-row"><div><div class="t">${escapeHtml(c.emoji)} ${escapeHtml(c.title)}</div><div class="d">${escapeHtml(c.site)} · ${escapeHtml(c.every)}</div></div>${sw(`ch:${c.id}`, c.notify !== 'mute')}</div>`).join('')}
<div class="field" style="margin-top:18px"><span class="label">安静时段</span><div class="inline"><input class="input" type="time" data-field="quietStart" value="${p().quietStart}" style="width:120px"><span class="muted">到</span><input class="input" type="time" data-field="quietEnd" value="${p().quietEnd}" style="width:120px"></div><span class="help">这段时间消息和提醒仍会保留，不弹出系统通知。</span></div>
<div class="btns"><button class="btn" data-set="system-notify">${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? '系统通知已开启' : '开启系统通知'}</button></div>`,

    look: () => `<h3>外观</h3>
<div class="field"><span class="label">主题</span>${seg('theme', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']])}</div>
<div class="field"><span class="label">动效</span>${seg('motion', [['lively', '灵动'], ['calm', '克制'], ['off', '关闭']])}<span class="help">克制：只保留眨眼；关闭：完全静止。系统开启「减少动态效果」时也会静止。</span></div>`,

    about: () => `<h3>关于</h3>
<p class="note">PigeonPal 校园伙伴。支持 DeepSeek 对话、云峰与 ITC 通知整理和本机提醒。保持本机服务运行即可持续采集与调度；API 和校园绑定在各自设置中管理。</p>
<div class="btns"><a class="btn" href="./lab.html" target="_blank" style="display:inline-grid;place-items:center;text-decoration:none">打开形象实验室</a><button class="btn danger" data-set="reset">重置界面记录</button></div>`,
  }

  function show(id) {
    if (id === 'auth') return api.openIdentityAuth?.(opener)
    if (id === 'api') return api.openApiSettings?.(opener)
    currentPage = id
    for (const n of box.querySelectorAll('[data-page]')) n.setAttribute('aria-current', String(n.dataset.page === id))
    body.innerHTML = `<section>${pages[id]()}</section>`
  }

  box.addEventListener('click', async e => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.page) return show(t.dataset.page)
    if (t.dataset.replaceImage !== undefined) { box.querySelector('[data-upload]').value = ''; return box.querySelector('[data-upload]').click() }
    if (t.dataset.saveConfig !== undefined) {
      const targetId = selectedBotId
      const patch = Object.fromEntries([...box.querySelectorAll('[data-config]')].map(field => [field.dataset.config, field.value.trim()]))
      const errorNode = box.querySelector('[data-config-error]')
      t.disabled = true; errorNode.textContent = ''
      try {
        await api.updateBotConfig(targetId, patch)
        if (!closed && currentPage === 'bot' && selectedBotId === targetId) { show('bot'); toast('职责与风格已保存') }
      } catch (error) { if (!closed) errorNode.textContent = apiErrorText(error) }
      finally { t.disabled = false }
      return
    }
    if (t.dataset.botPick) { selectedBotId = t.dataset.botPick; return show('bot') }
    if (t.dataset.set === 'close') return closeOverlay()
    if (t.dataset.set === 'reset') { if (confirm('重置本页聊天记录和外观设置？本机通知、提醒、校园绑定和 API 配置会保留。')) { closeOverlay(); api.reset() } return }
    if (t.dataset.set === 'demo-reminder') { try { await api.demoReminder(); if (!closed) { toast('5 秒后见'); closeOverlay() } } catch (error) { toast(apiErrorText(error)) } return }
    if (t.dataset.set === 'system-notify') { if (typeof Notification !== 'undefined') Notification.requestPermission().then(() => show(currentPage)); return }
    if (t.dataset.seg) { store.setProfile({ [t.dataset.seg]: t.dataset.v }); return show(currentPage) }
    if (t.dataset.switch) {
      const on = t.getAttribute('aria-checked') !== 'true'
      t.setAttribute('aria-checked', String(on))
      if (t.dataset.switch.startsWith('ch:')) store.setChannel(t.dataset.switch.slice(3), { notify: on ? 'all' : 'mute' })
      else store.setProfile({ [t.dataset.switch]: on })
      return
    }
    if (t.dataset.look) {
      if (t.dataset.look === 'image' && !appearance().image) return box.querySelector('[data-upload]').click()
      store.setBotAppearance(selectedBotId, { look: t.dataset.look })
      return show(currentPage)
    }
    if (t.dataset.remAct) {
      const id = t.closest('[data-rem]').dataset.rem
      const status = { done: 'done', reopen: 'pending', cancel: 'cancelled' }[t.dataset.remAct]
      try { await api.reminder(id, { status }); show(currentPage) } catch (error) { toast(apiErrorText(error)) }
      return
    }
  })
  box.addEventListener('change', async e => {
    const t = e.target
    if (t.dataset.botName !== undefined) {
      const targetId = selectedBotId
      const name = t.value.trim()
      const previous = appearance().name
      if (!name || name === previous) { t.value = previous; return }
      t.disabled = true
      try {
        await api.updateBotName(targetId, name)
        toast('名字已保存')
      } catch (error) { t.value = previous; toast(apiErrorText(error)) }
      finally { t.disabled = false; if (!closed && box.isConnected && currentPage === 'bot' && selectedBotId === targetId) show('bot') }
      return
    }
    if (t.dataset.field) {
      const value = t.value.trim()
      if (t.dataset.field === 'botName' && !value) { t.value = p().botName; return }
      store.setProfile({ [t.dataset.field]: value })
      toast('已保存')
    }
    if (t.dataset.remTime !== undefined) {
      try { await api.reminder(t.closest('[data-rem]').dataset.rem, { dueAt: new Date(t.value).getTime() }); toast('时间改好了'); show(currentPage) } catch (err) { toast(apiErrorText(err)) }
    }
    if (t.dataset.upload !== undefined && t.files?.[0]) {
      const file = t.files[0]
      const targetId = selectedBotId
      if (file.size > 1_500_000) { toast('图片太大了，换一张 1.5MB 以内的吧'); return }
      const reader = new FileReader()
      reader.onload = () => {
        if (!store.setBotAppearance(targetId, { image: reader.result, look: 'image' })) return toast('图片未能保存，请换一张图片')
        if (!closed && box.isConnected && currentPage === 'bot' && selectedBotId === targetId) show('bot')
      }
      reader.onerror = () => toast('图片读取失败，请重试')
      reader.readAsDataURL(file)
    }
  })
  show(page)
}

function toLocalInput(at) {
  const d = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
