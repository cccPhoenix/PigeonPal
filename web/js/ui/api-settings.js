import { dialog, closeOverlay } from './overlays.js'
import { icon } from './icons.js'
import { apiErrorText } from '../services/api.js'

export function openApiSettings({ client, opener, onChange }) {
  let closed = false
  let busy = false
  let saved = null
  const box = dialog(`<div class="api-heading"><div><h3>API 设置</h3><p>连接 DeepSeek，开始聊天、整理校园通知。</p></div><button class="icon-btn flat" data-api="close" aria-label="关闭">${icon('close')}</button></div>
<form autocomplete="off">
  <div class="field"><label for="api-key">API key</label><input class="input" id="api-key" type="password" maxlength="3000" autocomplete="new-password" placeholder="填写 DeepSeek API key" disabled></div>
  <div class="api-grid"><div class="field"><label for="api-model">模型 ID</label><input class="input" id="api-model" maxlength="128" disabled></div><div class="field"><label for="api-url">API 基础地址</label><input class="input" id="api-url" type="url" maxlength="500" disabled></div></div>
  <label class="api-option"><input type="checkbox" id="api-auto" disabled><span>自动整理新抓取的通知</span></label>
  <label class="api-option"><input type="checkbox" id="api-itc" disabled><span>允许将 ITC 正文交给 DeepSeek 整理</span></label>
  <label class="api-option"><input type="checkbox" id="api-ddl" disabled><span>自动设置通知中的 DDL 提醒</span></label>
  <p class="api-help">Key 加密保存在本机。校园账号、密码和 Cookie 不会发送给模型。仅有截止日期的通知，默认在当天 09:00 提醒。</p>
  <p class="api-status" role="status" aria-live="polite">正在读取配置…</p>
  <div class="btns"><button type="button" class="btn danger" data-api="clear" disabled>清除配置</button><span class="api-spacer"></span><button type="button" class="btn" data-api="check" disabled>验证连接</button><button type="submit" class="btn primary" data-api="save" disabled>保存</button></div>
</form>`, { opener, onClose: () => { closed = true; box.querySelector('#api-key').value = '' } })
  box.classList.add('api-dialog')
  const key = box.querySelector('#api-key')
  const status = box.querySelector('.api-status')
  const controls = () => [...box.querySelectorAll('form input, form button')]
  function enable() {
    for (const control of controls()) control.disabled = busy || !saved
    box.querySelector('[data-api="clear"]').disabled = busy || !(saved?.hasKey || saved?.error)
    box.querySelector('[data-api="check"]').disabled = busy || !saved?.configured
  }
  function draw(value) {
    saved = value
    key.value = ''
    key.placeholder = value.hasKey ? '已保存，留空保留当前 key' : '填写 DeepSeek API key'
    box.querySelector('#api-model').value = value.model
    box.querySelector('#api-url').value = value.baseUrl
    box.querySelector('#api-auto').checked = value.automatic
    box.querySelector('#api-itc').checked = value.allowProtected
    box.querySelector('#api-ddl').checked = value.automaticDeadlines
    enable()
  }
  async function act(action) {
    if (busy || closed) return
    busy = true
    enable()
    status.classList.remove('error')
    try {
      if (action === 'save') {
        status.textContent = '正在保存…'
        const result = await client.saveSettings({ apiKey: key.value.trim(),
          model: box.querySelector('#api-model').value.trim(), baseUrl: box.querySelector('#api-url').value.trim(),
          automatic: box.querySelector('#api-auto').checked, allowProtected: box.querySelector('#api-itc').checked,
          automaticDeadlines: box.querySelector('#api-ddl').checked })
        if (closed) return
        draw(result)
        status.textContent = '已保存，可以开始聊天了。'
        onChange?.()
      } else if (action === 'check') {
        status.textContent = '正在验证已保存的配置…'
        await client.check()
        if (!closed) status.textContent = '连接正常，模型可用。'
      } else if (action === 'clear') {
        const result = await client.clearSettings()
        if (closed) return
        draw(result)
        status.textContent = 'API 配置已清除。'
        onChange?.()
      }
    } catch (error) {
      if (!closed) { status.textContent = apiErrorText(error); status.classList.add('error') }
    } finally { busy = false; if (!closed) enable() }
  }
  box.querySelector('form').addEventListener('submit', event => { event.preventDefault(); act('save') })
  box.addEventListener('click', event => {
    const action = event.target.closest('[data-api]')?.dataset.api
    if (action === 'close') closeOverlay()
    else if (action && action !== 'save') act(action)
  })
  client.settings().then(value => {
    if (closed) return
    draw(value)
    status.textContent = value.error ? apiErrorText({ code: value.error }) : value.configured ? '已配置 DeepSeek。' : '保存 API key 后即可使用。'
  }).catch(error => { if (!closed) { status.textContent = apiErrorText(error); status.classList.add('error') } })
}
