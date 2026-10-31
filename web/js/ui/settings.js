import { isDesktop, desktopNotificationStatus, setDesktopNotifications } from '../services/desktop.js'
import { markHTML } from '../mark/index.js'
import { LOOKS, LOOK_IDS } from '../mark/looks.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'
import { sheet, closeOverlay, toast } from './overlays.js'
import { desktopUpdates } from '../services/desktop-updates.js'
import { updatesPageHTML } from './updates.js'

const PAGES = [
  ['bot', '形象与称呼', 'sparkle'],
  ['user-profile', '用户画像', 'graduate'],
  ['notify', '主动消息', 'rss'],
  ['auth', '身份认证', 'key'],
  ['api', 'API 设置', 'settings'],
  ['look', '外观', 'image'],
  ['updates', '软件更新', 'restore'],
  ['about', '关于', 'settings'],
]

// Settings sheet. `api` is what it may change: { store, reset() }
export function openSettings(api, { page = 'bot', opener } = {}) {
  if (page === 'auth') return api.openIdentityAuth?.(opener)
  if (page === 'api') return api.openApiSettings?.(opener)
  if (page === 'user-profile') return api.openUserProfile?.(opener)
  const { store } = api
  let offUpdates = null
  const box = sheet(`<nav class="sheet-nav"><h2>设置</h2>${PAGES.map(([id, label, ic]) => `<button class="nav-item" data-page="${id}">${icon(ic, 16)}${label}</button>`).join('')}</nav>
<div class="sheet-body"></div>
<button class="icon-btn flat sheet-close" data-set="close" aria-label="关闭">${icon('close')}</button>`, { opener, onClose: () => offUpdates?.() })
  const body = box.querySelector('.sheet-body')
  let currentPage = page

  const p = () => store.state.profile
  const seg = (key, options) => `<div class="seg" role="group">${options.map(([v, l]) => `<button data-seg="${key}" data-v="${v}" aria-pressed="${p()[key] === v}">${l}</button>`).join('')}</div>`
  const sw = (key, on) => `<button class="switch" role="switch" data-switch="${key}" aria-checked="${on}"></button>`

  const pages = {
    bot: () => `<h3>形象与称呼</h3>
<div class="field"><label for="f-bot">它的名字</label><input class="input" id="f-bot" data-field="botName" maxlength="12" value="${escapeHtml(p().botName)}"></div>
<div class="field"><label for="f-nick">它怎么叫你</label><input class="input" id="f-nick" data-field="nickname" maxlength="12" placeholder="同学" value="${escapeHtml(p().nickname)}"><span class="help">通知和提醒里的「{称呼}」都会换成这个</span></div>
<div class="field"><span class="label">形象</span>
<div class="looks">${LOOK_IDS.map(id => `<button class="look" data-look="${id}" aria-pressed="${p().look === id}">${markHTML({ look: id, size: 56, live: true })}<span>${escapeHtml(LOOKS[id].label)}</span><small>${escapeHtml(LOOKS[id].note)}</small></button>`).join('')}
<button class="look" data-look="image" aria-pressed="${p().look === 'image'}">${p().image ? markHTML({ image: p().image, size: 56, live: true }) : `<span class="mk" style="--mk-size:56px;display:grid;place-items:center;color:var(--ink-3)">${icon('image', 26)}</span>`}<span>上传图片</span><small>PNG / SVG / GIF</small></button>
</div><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-upload hidden>
<span class="help">新增 10 款参考角色。可以在 <a href="./lab.html" target="_blank">形象实验室</a> 对比大小和动作；选择后会同步到聊天头像。</span></div>`,

    notify: () => `<h3>主动消息</h3>
<div class="toggle-row"><div><div class="t">让${escapeHtml(p().botName)}主动找我</div><div class="d">有新通知或提醒到点时发消息</div></div>${sw('proactive', p().proactive)}</div>
${store.state.channels.filter(c => c.kind === 'source').map(c => `<div class="toggle-row"><div><div class="t">${escapeHtml(c.emoji)} ${escapeHtml(c.title)}</div><div class="d">${escapeHtml(c.site)} · ${escapeHtml(c.every)}</div></div>${sw(`ch:${c.id}`, c.notify !== 'mute')}</div>`).join('')}
<div class="field" style="margin-top:18px"><span class="label">安静时段</span><div class="inline"><input class="input" type="time" data-field="quietStart" value="${p().quietStart}" style="width:120px"><span class="muted">到</span><input class="input" type="time" data-field="quietEnd" value="${p().quietEnd}" style="width:120px"></div><span class="help">这段时间消息和提醒仍会保留，不弹出系统通知。</span></div>
<div class="btns"><button class="btn" data-set="system-notify">${isDesktop() ? (desktopNotificationStatus().enabled ? '系统通知已开启（点击关闭）' : '开启系统通知') : typeof Notification !== 'undefined' && Notification.permission === 'granted' ? '系统通知已开启' : '开启系统通知'}</button></div>`,

    look: () => `<h3>外观</h3>
<div class="field"><span class="label">主题</span>${seg('theme', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']])}</div>
<div class="field"><span class="label">动效</span>${seg('motion', [['lively', '灵动'], ['calm', '克制'], ['off', '关闭']])}<span class="help">克制：只保留眨眼；关闭：完全静止。系统开启「减少动态效果」时也会静止。</span></div>`,

    updates: () => updatesPageHTML(desktopUpdates.state),

    about: () => `<h3>关于</h3>
<p class="note">PigeonPal 校园伙伴${desktopUpdates.state.currentVersion ? ` · v${escapeHtml(desktopUpdates.state.currentVersion)}` : ''}。支持 DeepSeek 对话、云峰与 ITC 通知整理和本机提醒。保持本机服务运行即可持续采集与调度；API 和校园绑定在各自设置中管理。</p>
<div class="btns"><a class="btn" href="./lab.html" target="_blank" style="display:inline-grid;place-items:center;text-decoration:none">打开形象实验室</a><button class="btn danger" data-set="reset">重置界面记录</button></div>`,
  }

  function show(id) {
    if (id === 'auth') return api.openIdentityAuth?.(opener)
    if (id === 'api') return api.openApiSettings?.(opener)
    if (id === 'user-profile') return api.openUserProfile?.(opener)
    currentPage = id
    for (const n of box.querySelectorAll('[data-page]')) n.setAttribute('aria-current', String(n.dataset.page === id))
    body.innerHTML = `<section>${pages[id]()}</section>`
  }

  box.addEventListener('click', async e => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.page) return show(t.dataset.page)
    if (t.dataset.update) {
      try {
        if (t.dataset.update === 'automatic') await desktopUpdates.automatic(t.getAttribute('aria-checked') !== 'true')
        if (t.dataset.update === 'check') await desktopUpdates.check()
        if (t.dataset.update === 'download') await desktopUpdates.download()
        if (t.dataset.update === 'install') await desktopUpdates.install()
        if (t.dataset.update === 'release') await desktopUpdates.openRelease()
      } catch { toast('更新操作未完成，请稍后重试') }
      return
    }
    if (t.dataset.set === 'close') return closeOverlay()
    if (t.dataset.set === 'reset') { if (confirm('重置本页聊天记录和外观设置？本机通知、提醒、校园绑定和 API 配置会保留。')) { closeOverlay(); api.reset() } return }
    if (t.dataset.set === 'system-notify') {
      if (isDesktop()) {
        try { await setDesktopNotifications(!desktopNotificationStatus().enabled); show(currentPage) } catch { toast('系统通知设置保存失败，请重试') }
      } else if (typeof Notification !== 'undefined') Notification.requestPermission().then(() => show(currentPage))
      return
    }
    if (t.dataset.seg) { store.setProfile({ [t.dataset.seg]: t.dataset.v }); return show(currentPage) }
    if (t.dataset.switch) {
      const on = t.getAttribute('aria-checked') !== 'true'
      t.setAttribute('aria-checked', String(on))
      if (t.dataset.switch.startsWith('ch:')) store.setChannel(t.dataset.switch.slice(3), { notify: on ? 'all' : 'mute' })
      else store.setProfile({ [t.dataset.switch]: on })
      return
    }
    if (t.dataset.look) {
      if (t.dataset.look === 'image' && !p().image) return box.querySelector('[data-upload]').click()
      store.setProfile({ look: t.dataset.look })
      return show(currentPage)
    }
  })
  box.addEventListener('dblclick', e => { if (e.target.closest('[data-look="image"]')) box.querySelector('[data-upload]').click() })
  box.addEventListener('change', async e => {
    const t = e.target
    if (t.dataset.field) {
      const value = t.value.trim()
      if (t.dataset.field === 'botName' && !value) { t.value = p().botName; return }
      store.setProfile({ [t.dataset.field]: value })
      toast('已保存')
    }
    if (t.dataset.upload !== undefined && t.files?.[0]) {
      const file = t.files[0]
      if (file.size > 1_500_000) { toast('图片太大了，换一张 1.5MB 以内的吧'); return }
      const reader = new FileReader()
      reader.onload = () => { store.setProfile({ image: reader.result, look: 'image' }); show(currentPage) }
      reader.readAsDataURL(file)
    }
  })
  offUpdates = desktopUpdates.subscribe(() => { if (currentPage === 'updates') show('updates') })
  show(page)
  desktopUpdates.connect().catch(() => {})
}
