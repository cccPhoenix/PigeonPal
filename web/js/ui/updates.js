import { escapeHtml } from './format.js'
import { icon } from './icons.js'

export const UPDATE_ERRORS = {
  update_check_failed: '暂时无法检查更新，请检查网络后重试。',
  update_download_failed: '更新下载或校验未完成，请重试；当前版本仍可继续使用。',
  update_install_failed: '更新未能启动，请重新打开鸽友后重试。',
  update_preferences_unavailable: '更新偏好暂时无法读取，自动检查已暂停；仍可手动检查。',
  update_preferences_write_failed: '更新偏好未能保存，请重试。',
}
const PHASES = { idle: '尚未检查更新', checking: '正在检查更新…', current: '当前已是最新正式版本',
  available: '发现新版本', downloading: '正在下载更新…', downloaded: '更新已下载，可以重启安装',
  installing: '正在准备安装，鸽友即将退出…', error: '本次更新操作未完成' }

export function updatesPageHTML(state) {
  const busy = ['checking', 'downloading', 'installing'].includes(state.phase)
  const unavailable = ({ browser: '软件更新需要在安装版鸽友中使用。', development: '开发预览不检查或安装更新，请使用正式安装版。',
    offline: '离线验收模式已暂停网络更新检查。', platform: '当前系统暂不支持应用更新。' })[state.unavailableReason] || ''
  const version = state.currentVersion ? `v${state.currentVersion}` : '网页版'
  const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0
  const hasDownload = state.enabled && state.availableVersion && state.installSupported
    && ['available', 'error'].includes(state.phase)
  return `<h3>软件更新</h3>
<div class="update-version">当前版本 <strong>${escapeHtml(version)}</strong></div>
<div class="toggle-row"><div><div class="t">自动检查更新</div><div class="d">启动后及每 24 小时检查一次。下载和重启安装由你决定。</div></div><button class="switch" role="switch" data-update="automatic" aria-label="自动检查更新" aria-checked="${state.automaticCheck === true}"${!state.supported ? ' disabled' : ''}></button></div>
<div class="update-state" role="status" aria-live="polite"><p>${escapeHtml(unavailable || PHASES[state.phase] || PHASES.idle)}${state.availableVersion ? ` · v${escapeHtml(state.availableVersion)}` : ''}</p>
${state.lastCheckedAt ? `<span class="help">上次成功检查：${escapeHtml(new Date(state.lastCheckedAt).toLocaleString('zh-CN'))}</span>` : ''}
${state.error ? `<p class="update-error">${escapeHtml(UPDATE_ERRORS[state.error] || '操作未完成，请稍后重试。')}</p>` : ''}
${state.phase === 'downloading' ? `<progress class="update-progress" max="100" value="${progress}" aria-label="更新下载进度"></progress><span class="help">${Math.floor(progress)}%</span>` : ''}</div>
<div class="btns update-actions"><button class="btn" data-update="check"${!state.enabled || busy || state.phase === 'downloaded' ? ' disabled' : ''}>${icon('restore', 15)}手动检查更新</button>
${hasDownload ? `<button class="btn primary" data-update="download">${icon('down', 15)}下载更新</button>` : ''}
${state.phase === 'downloaded' ? '<button class="btn primary" data-update="install">重启并安装</button>' : ''}
${state.enabled ? '<button class="btn" data-update="release">查看官方更新说明</button>' : ''}
${state.enabled && state.availableVersion && !state.installSupported ? '<button class="btn primary" data-update="release">下载新版安装包</button>' : ''}</div>
${state.enabled && !state.installSupported ? '<p class="note">Mac 版目前需要下载 DMG 后手动替换应用，个人数据保留。</p>' : ''}
${state.releaseNotes && state.availableVersion ? `<h4 class="update-notes-title">v${escapeHtml(state.availableVersion)} 更新说明</h4><pre class="update-notes">${escapeHtml(state.releaseNotes)}</pre>` : ''}`
}

export function createUpdateBanner({ root, client, onOpen }) {
  let dismissed = null
  const render = state => {
    const show = state.enabled && state.availableVersion && state.availableVersion !== dismissed
      && ['available', 'downloaded'].includes(state.phase)
    root.hidden = !show
    if (!show) return
    root.innerHTML = `<span>${state.phase === 'downloaded' ? '更新已下载' : '鸽友有新版本'} · v${escapeHtml(state.availableVersion)}</span><button class="btn" data-update-banner="open">查看更新</button><button class="icon-btn flat" data-update-banner="dismiss" aria-label="稍后查看更新">${icon('close', 15)}</button>`
  }
  const off = client.subscribe(render)
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-update-banner]')
    if (!button) return
    if (button.dataset.updateBanner === 'dismiss') { dismissed = client.state.availableVersion; root.hidden = true }
    else onOpen(button)
  })
  render(client.state)
  return { destroy: off }
}
