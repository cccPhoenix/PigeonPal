import { dialog, closeOverlay } from './overlays.js'
import { escapeHtml } from './format.js'
import { icon } from './icons.js'

const ERRORS = {
  invalid_input: '请填写完整的 ZJUAM 账号和密码。',
  invalid_credentials: '账号或密码不正确，请检查后重新认证。',
  auth_failed: '此次 ZJUAM 认证未完成，请重新尝试。',
  authentication_error: '此次认证未完成，请稍后重试。',
  network_error: '暂时无法连接 ZJUAM，请检查网络后重试。',
  network_unavailable: '本机服务暂时不可用，请确认程序正在运行后重试。',
  challenge_required: '学校要求验证码或额外验证。自动认证已暂停，请稍后重新认证。',
  busy: '已有认证正在进行，请等待或取消此次认证。',
  rate_limited: '认证尝试过于频繁，请稍后再试。',
  cancelled: '此次认证已取消。',
  storage_error: '无法保存本机登录配置，请检查目录权限后重试。',
  credential_store_error: '本机登录配置无法读取，请重新认证。',
  timeout: '此次连接超时，请稍后重试。',
  session_expired: '登录已失效，请重新认证。',
  csrf_invalid: '本机服务已重启，请重试。',
  unexpected_response: '本机服务返回异常，请稍后重试。',
  service_unavailable: '暂时无法完成认证，请稍后重试。',
  login_rejected: '本次登录未完成。可能是认证会话或额外验证问题，请重试。',
  campus_network_required: '当前网络无法连接 ZJUAM，请检查网络后重试。',
  invalid_cas_page: '学校认证页面暂时无法识别，请稍后重试。',
  unexpected_destination: '学校认证跳转异常，此次认证已停止。',
  auth_busy: '已有认证正在进行，请等待或取消此次认证。',
  auth_retry_later: '请稍后再尝试认证。',
  auth_storage_error: '无法保存本机登录配置，请检查目录权限后重试。',
  credential_corrupt: '本机登录配置损坏，请重新认证。',
  credential_unavailable: '本机登录配置无法读取，请重新认证。',
  credential_key_missing: '本机解密密钥缺失，请重新认证。',
}
const PHASES = { loading_login: '正在连接 ZJUAM…', loading_public_key: '正在准备认证…', submitting: '正在提交 ZJUAM 认证…', verifying_login: '正在确认登录结果…', ready_to_bind: '认证已通过，正在保存本机绑定…' }
const dateLabel = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '—' }

export function openIdentityAuth({ client, opener, onChange = () => {} }) {
  let closed = false
  let snapshot = null
  let loading = true
  let submitting = false
  let unbinding = false
  let confirmingRequestId = null
  let cancellingTimedOut = false
  let formMode = false
  let ownRequestId = null
  let timedOutRequestId = null
  let pollTimer = null
  let pollStartedAt = 0
  let retryTimer = null
  let sequence = 0
  let localError = null

  const box = dialog(`<div class="auth-heading"><div class="auth-symbol">${icon('key', 21)}</div><div><h3 id="identity-auth-title">身份认证</h3><p>ZJUAM · 本机绑定</p></div><button class="icon-btn flat" data-auth="close" aria-label="关闭身份认证">${icon('close')}</button></div>
<p class="auth-intro">验证校园账号，成功后加密保存在本机。</p>
<div class="auth-status" data-status role="status" aria-live="polite"></div>
<div data-bound hidden><dl class="auth-details"><dt>校园账号</dt><dd data-account></dd><dt>最近认证</dt><dd data-time></dd></dl><div class="btns"><button class="btn danger" data-auth="unbind">解除绑定</button><button class="btn" data-auth="reauth">重新认证</button><button class="btn primary" data-auth="close">完成</button></div></div>
<form data-auth-form autocomplete="off" hidden><div class="field"><label for="identity-user">ZJUAM 账号</label><input class="input" id="identity-user" type="text" inputmode="text" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="128" required placeholder="请输入校园账号"></div>
<div class="field"><label for="identity-password">密码</label><div class="auth-password"><input class="input" id="identity-password" type="password" autocomplete="new-password" maxlength="256" required placeholder="请输入密码"><button type="button" class="auth-reveal" data-auth="reveal" aria-label="显示密码" aria-pressed="false">显示</button></div></div>
<p class="help auth-help">账号密码仅提交给官方 ZJUAM；成功绑定后，正常启动无需重复输入。</p><div class="btns"><button type="button" class="btn" data-auth="close">取消</button><button type="submit" class="btn primary" data-submit>认证并绑定本机</button></div></form>
<div class="btns" data-wait-actions hidden><button class="btn" data-auth="close" data-wait-close>关闭</button></div>
<div class="btns" data-load-actions hidden><button class="btn" data-auth="retry">重新连接</button><button class="btn" data-auth="close">关闭</button></div>`, { opener, onClose: cleanup })
  box.classList.add('auth-dialog')
  box.setAttribute('aria-labelledby', 'identity-auth-title')
  const user = box.querySelector('#identity-user')
  const password = box.querySelector('#identity-password')
  const form = box.querySelector('[data-auth-form]')
  const submit = box.querySelector('[data-submit]')

  function clearInputs() { user.value = ''; password.value = ''; password.type = 'password'; const reveal = box.querySelector('[data-auth="reveal"]'); reveal.textContent = '显示'; reveal.setAttribute('aria-pressed', 'false'); reveal.setAttribute('aria-label', '显示密码') }
  function cleanup() {
    closed = true
    sequence++
    clearTimeout(pollTimer)
    clearTimeout(retryTimer)
    clearInputs()
    if (ownRequestId) {
      const id = ownRequestId
      ownRequestId = null
      client.cancel(id).then(() => onChange()).catch(() => {})
    }
  }

  function draw() {
    if (closed) return
    clearTimeout(retryTimer)
    const busy = submitting || snapshot?.state === 'authenticating'
    const error = localError || (!busy ? snapshot?.error || (snapshot?.state === 'challenge_required' ? 'challenge_required' : null) : null)
    const status = box.querySelector('[data-status]')
    let message = '尚未绑定校园账号'
    let tone = 'neutral'
    if (loading) message = '正在读取本机认证状态…'
    else if (error) { message = ERRORS[error] || ERRORS.service_unavailable; tone = 'error' }
    else if (busy) { message = unbinding ? '正在解除本机绑定…' : cancellingTimedOut ? '正在结束上次认证…' : PHASES[snapshot?.phase] || '正在认证，请稍等…'; tone = 'pending' }
    else if (snapshot?.state === 'authenticated') { message = 'ZJUAM 认证成功，已绑定本机'; tone = 'success' }
    else if (snapshot?.state === 'expired') { message = '登录已失效，需要重新认证'; tone = 'error' }
    else if (snapshot?.state === 'error') { message = ERRORS.service_unavailable; tone = 'error' }
    status.dataset.tone = tone
    status.innerHTML = `${loading || busy ? '<span class="auth-spinner" aria-hidden="true"></span>' : icon(tone === 'success' ? 'check' : 'key', 17)}<span>${escapeHtml(message)}</span>`
    box.setAttribute('aria-busy', String(loading || busy))
    const showForm = !loading && !!snapshot && !busy && (formMode || !snapshot.bound)
    form.hidden = !showForm
    box.querySelector('[data-bound]').hidden = loading || !snapshot?.bound || formMode || busy
    box.querySelector('[data-wait-actions]').hidden = !busy
    box.querySelector('[data-wait-close]').textContent = ownRequestId ? '取消认证' : '关闭'
    box.querySelector('[data-load-actions]').hidden = loading || !!snapshot
    box.querySelector('[data-account]').textContent = snapshot?.account || '—'
    box.querySelector('[data-time]').textContent = snapshot?.authenticatedAt ? dateLabel(snapshot.authenticatedAt) : '—'
    const retryAt = snapshot?.canRetryAt ? new Date(snapshot.canRetryAt).getTime() : NaN
    const canRetry = !Number.isFinite(retryAt) || retryAt <= Date.now()
    submit.disabled = loading || busy || !canRetry
    submit.textContent = canRetry ? '认证并绑定本机' : '请稍后再试'
    for (const button of box.querySelectorAll('[data-auth="reauth"], [data-auth="unbind"]')) button.disabled = loading || submitting
    if (!canRetry) retryTimer = setTimeout(draw, Math.min(1000, Math.max(100, retryAt - Date.now())))
  }

  function accept(value) {
    if (timedOutRequestId) return
    snapshot = value
    loading = false
    submitting = false
    if (value.state !== 'authenticating') {
      const ownAttemptFailed = !!ownRequestId && value.state !== 'authenticated'
      ownRequestId = null
      pollStartedAt = 0
      if (value.state === 'authenticated') formMode = false
      else if (ownAttemptFailed) formMode = true
    }
    draw()
    onChange()
    if (value.state === 'authenticating') {
      if (value.phase === 'ready_to_bind' && ownRequestId && ownRequestId === value.requestId && confirmingRequestId !== ownRequestId) confirmBinding(ownRequestId)
      else schedulePoll()
    }
  }

  async function confirmBinding(requestId) {
    if (closed || ownRequestId !== requestId || timedOutRequestId === requestId) return
    confirmingRequestId = requestId
    try {
      const value = await client.confirm(requestId)
      if (closed || ownRequestId !== requestId || timedOutRequestId === requestId) { await client.cancel(requestId).catch(() => {}); onChange(); return }
      localError = null
      accept(value)
    } catch (error) {
      if (!closed && ownRequestId === requestId && timedOutRequestId !== requestId) { localError = error.code; draw(); schedulePoll() }
    } finally { if (confirmingRequestId === requestId) confirmingRequestId = null }
  }

  async function cancelTimedOutAttempt(requestId) {
    const value = await client.cancel(requestId)
    if (closed || ownRequestId !== requestId || timedOutRequestId !== requestId) return false
    ownRequestId = null
    timedOutRequestId = null
    snapshot = value
    formMode = true
    return true
  }

  function schedulePoll() {
    if (closed) return
    clearTimeout(pollTimer)
    if (!pollStartedAt) pollStartedAt = Date.now()
    if (Date.now() - pollStartedAt > 90_000) {
      sequence++
      const requestId = ownRequestId
      timedOutRequestId = requestId
      localError = 'timeout'
      loading = false
      submitting = false
      snapshot = { ...(snapshot || {}), state: snapshot?.bound ? 'expired' : 'unbound', phase: null, requestId: null }
      formMode = true
      draw()
      if (requestId) cancelTimedOutAttempt(requestId).then(cancelled => {
        if (cancelled) { localError = 'timeout'; draw(); onChange() }
      }).catch(() => {})
      return
    }
    pollTimer = setTimeout(() => loadStatus(false), 1000)
  }

  async function loadStatus(initial = true) {
    const turn = ++sequence
    if (initial) { loading = true; localError = null; draw() }
    try {
      const value = await client.status()
      if (closed || turn !== sequence) return
      localError = null
      accept(value)
    } catch (error) {
      if (closed || turn !== sequence) return
      loading = false
      localError = error.code
      draw()
      if (ownRequestId || snapshot?.state === 'authenticating') schedulePoll()
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (loading || submitting || snapshot?.state === 'authenticating' || submit.disabled) return
    if (!form.reportValidity()) return
    if (timedOutRequestId) {
      const previousRequestId = timedOutRequestId
      sequence++
      submitting = true
      cancellingTimedOut = true
      localError = null
      draw()
      try {
        if (!await cancelTimedOutAttempt(previousRequestId)) return
      } catch (error) {
        if (!closed) { localError = error.code; formMode = true }
        return
      } finally {
        submitting = false
        cancellingTimedOut = false
        if (!closed) draw()
      }
      if (closed) return
    }
    const requestId = crypto.randomUUID()
    const values = { username: user.value.trim(), password: password.value, requestId }
    if (!values.username || !values.password) { localError = 'invalid_input'; draw(); return }
    ownRequestId = requestId
    sequence++
    submitting = true
    localError = null
    pollStartedAt = Date.now()
    clearInputs()
    draw()
    try {
      const value = await client.login(values)
      if (closed) { await client.cancel(requestId).catch(() => {}); onChange(); return }
      accept(value)
    } catch (error) {
      if (closed) { await client.cancel(requestId).catch(() => {}); return }
      submitting = false
      localError = error.code
      // A dropped response may still have created the job. Cancel its ID before retrying.
      await client.cancel(requestId).catch(() => {})
      if (closed) return
      ownRequestId = null
      snapshot = { ...(snapshot || {}), state: snapshot?.bound ? 'expired' : 'unbound' }
      formMode = true
      draw()
      onChange()
    } finally { values.username = ''; values.password = '' }
  })

  box.addEventListener('click', async event => {
    const action = event.target.closest('[data-auth]')?.dataset.auth
    if (action === 'close') return closeOverlay()
    if (action === 'retry') return loadStatus()
    if (action === 'reveal') {
      const visible = password.type === 'password'
      password.type = visible ? 'text' : 'password'
      const button = box.querySelector('[data-auth="reveal"]')
      button.textContent = visible ? '隐藏' : '显示'
      button.setAttribute('aria-pressed', String(visible))
      button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码')
    }
    if (action === 'reauth' && !submitting) { clearInputs(); formMode = true; localError = null; draw(); user.focus() }
    if (action === 'unbind' && !submitting) {
      if (!confirm('解除本机校园账号绑定，并删除本机保存的登录凭据？')) return
      sequence++
      submitting = true
      unbinding = true
      localError = null
      draw()
      try { const value = await client.unbind(); unbinding = false; if (!closed) { clearInputs(); formMode = false; accept(value) } else onChange() }
      catch (error) { if (!closed) { submitting = false; localError = error.code; draw() } }
      finally { unbinding = false }
    }
  })

  // Keep keyboard navigation inside the modal, including its close button.
  box.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const nodes = [...box.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(node => node.getClientRects().length)
    const first = nodes[0], last = nodes.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  })
  draw()
  loadStatus()
  return box
}
