import { dialog, closeOverlay } from './overlays.js'
import { icon } from './icons.js'
import { escapeHtml } from './format.js'
import { ApiError, apiErrorText } from '../services/api.js'

export function openApiSettings({ client, opener, onChange }) {
  let closed = false
  let busy = false
  let saved = null
  let page = 'list'
  let editingId = null
  let confirming = null
  let highlightId = null
  const fields = prefix => `
    <div class="field"><label for="${prefix}-name">配置名称</label><input class="input" id="${prefix}-name" maxlength="40" placeholder="例如：日常使用、备用 Key" required></div>
    <div class="field"><label for="${prefix}-key">DeepSeek API key</label><input class="input" id="${prefix}-key" type="password" maxlength="3000" autocomplete="new-password" placeholder="填写 API key" ${prefix === 'api-add' ? 'required' : ''}></div>
    <div class="api-grid"><div class="field"><label for="${prefix}-model">模型 ID</label><input class="input" id="${prefix}-model" maxlength="128" required></div><div class="field"><label for="${prefix}-url">API 基础地址</label><input class="input" id="${prefix}-url" type="url" maxlength="500" required></div></div>`
  const box = dialog(`<div class="api-heading"><div><h3 id="api-heading">API 设置</h3><p>保存多份配置，为聊天和通知整理选择当前使用的 API。</p></div><button class="icon-btn flat" data-api="close" aria-label="关闭">${icon('close')}</button></div>
<div class="api-tabs" role="tablist" aria-label="API 配置管理">
  <button type="button" id="api-tab-list" role="tab" aria-controls="api-panel-list" data-page="list">已添加 API <span data-count>0</span></button>
  <button type="button" id="api-tab-add" role="tab" aria-controls="api-panel-add" data-page="add">${icon('plus', 14)} 添加 API</button>
</div>
<div class="api-status" role="status" aria-live="polite">正在读取已保存的配置…</div>
<button type="button" class="btn" data-api="reload" hidden>重新读取配置</button>
<section id="api-panel-list" role="tabpanel" aria-labelledby="api-tab-list">
  <div class="api-current" data-current></div>
  <div class="api-list" data-list></div>
  <form class="api-editor" data-edit hidden autocomplete="off"><h4>编辑已添加的配置</h4>${fields('api-edit')}
    <p class="api-help">Key 留空保留原值。更换 Key、模型或地址后需要重新验证连接。</p>
    <div class="btns"><button type="button" class="btn" data-api="cancel-edit">取消</button><button type="submit" class="btn primary">保存修改</button></div>
  </form>
  <div class="api-confirm" data-confirm hidden><p></p><div class="btns"><button type="button" class="btn" data-api="cancel-confirm">取消</button><button type="button" class="btn danger" data-api="confirm">确认删除</button></div></div>
  <details class="api-preferences"><summary>自动处理与隐私</summary><form data-preferences>
    <label class="api-option"><input type="checkbox" id="api-auto"><span>自动整理新抓取的通知</span></label>
    <label class="api-option"><input type="checkbox" id="api-itc"><span>允许将 ITC 正文交给 DeepSeek 整理</span></label>
    <label class="api-option"><input type="checkbox" id="api-ddl"><span>自动设置通知中的 DDL 提醒</span></label>
    <p class="api-help">这些偏好对所有配置生效。仅有截止日期时，默认在当天 09:00 提醒。</p>
    <div class="btns"><button type="submit" class="btn">保存处理偏好</button></div>
  </form></details>
  <div class="api-footer"><span>Key 加密保存在本机，列表仅展示脱敏标识。</span><button type="button" class="btn danger" data-api="clear">清除全部配置</button></div>
</section>
<section id="api-panel-add" role="tabpanel" aria-labelledby="api-tab-add" hidden>
  <div class="api-section-heading"><h4>添加新的 API 配置</h4><p>为每份 Key 起个名字，之后可以在已添加列表中切换。</p></div>
  <form data-add autocomplete="off">${fields('api-add')}
    <p class="api-help" data-add-help></p>
    <p class="api-help">Key 不会存入浏览器。校园账号、密码和 Cookie 不会发送给模型。</p>
    <div class="btns"><button type="button" class="btn" data-page="list">返回已添加 API</button><button type="submit" class="btn primary">${icon('plus', 14)} 添加 API</button></div>
  </form>
</section>`, { opener, onClose: () => {
    closed = true
    for (const input of box.querySelectorAll('input[type="password"]')) input.value = ''
  } })
  box.classList.add('api-dialog')
  box.setAttribute('aria-labelledby', 'api-heading')
  const $ = selector => box.querySelector(selector)
  const value = id => $(`#${id}`).value.trim()
  const status = $('.api-status')
  const editForm = $('[data-edit]')

  function message(title, detail = '', tone = 'info') {
    status.dataset.tone = tone
    status.innerHTML = `${tone === 'success' ? icon('check', 18) : ''}<div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div>`
    box.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function enable() {
    for (const control of box.querySelectorAll('button, input')) {
      const action = control.dataset.api
      if (action === 'close') continue
      control.disabled = busy || !saved || Boolean(saved?.error)
      if (action === 'reload') control.disabled = busy
      if (saved?.error && ['clear', 'confirm', 'cancel-confirm'].includes(action)) control.disabled = busy
      if (control.dataset.page === 'list' && saved) control.disabled = busy
      if (control.dataset.current === 'true') control.disabled = true
    }
    $('[data-api="clear"]').hidden = !saved?.profiles?.length && !saved?.error
  }

  function cancelEdit() {
    editingId = null
    editForm.hidden = true
    $('#api-edit-key').value = ''
  }

  function setPage(next, focus = false) {
    page = next
    for (const tab of box.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.page === page
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      if (selected && focus) tab.focus()
    }
    $('#api-panel-list').hidden = page !== 'list'
    $('#api-panel-add').hidden = page !== 'add'
    if (page === 'list') $('#api-add-key').value = ''
    else { cancelEdit(); confirming = null; $('[data-confirm]').hidden = true }
  }

  function draw(settings, initial = false) {
    if (!Array.isArray(settings?.profiles)) throw new ApiError('not_found')
    saved = settings
    const active = saved.profiles.find(row => row.id === saved.activeProfileId)
    $('[data-count]').textContent = saved.profiles.length
    $('[data-current]').innerHTML = active
      ? `${icon('check', 18)}<div><span>当前使用</span><strong>${escapeHtml(active.name)}</strong><small>${escapeHtml(active.model)} · 聊天与自动整理共用</small></div>`
      : `${icon('key', 18)}<div><strong>${saved.profiles.length ? '尚未选择使用的 API' : '还没有添加 API'}</strong><small>${saved.profiles.length ? '选择下方一份配置，即可恢复聊天和自动整理。' : '切换到「添加 API」保存你的第一份配置。'}</small></div>`
    $('[data-list]').innerHTML = saved.profiles.map(row => `<article class="api-profile${row.active ? ' active' : ''}${row.id === highlightId ? ' just-added' : ''}" aria-label="${escapeHtml(row.name)}">
      <div class="api-profile-heading"><strong>${escapeHtml(row.name)}</strong>${row.active ? '<span class="api-badge">当前使用</span>' : ''}${row.id === highlightId ? '<span class="api-badge">刚刚添加</span>' : ''}</div>
      <div class="api-profile-meta"><span>DeepSeek · ${escapeHtml(row.model)}</span><code>${escapeHtml(row.keyHint)}</code></div>
      <p class="api-profile-url">${escapeHtml(row.baseUrl)}</p>
      <div class="api-profile-bottom"><span class="api-verification${row.verifiedAt ? ' verified' : ''}">${row.verifiedAt ? `${icon('check', 13)} 连接已验证` : '尚未验证连接'}</span>
        <div class="api-profile-actions"><button type="button" class="btn${row.active ? '' : ' primary'}" data-api="select" data-id="${escapeHtml(row.id)}" data-current="${row.active}">${row.active ? '使用中' : '使用此配置'}</button><button type="button" class="btn" data-api="check" data-id="${escapeHtml(row.id)}">验证连接</button><button type="button" class="btn" data-api="edit" data-id="${escapeHtml(row.id)}">编辑</button><button type="button" class="icon-btn flat" data-api="delete" data-id="${escapeHtml(row.id)}" aria-label="删除 ${escapeHtml(row.name)}">${icon('trash', 16)}</button></div>
      </div></article>`).join('') || '<div class="api-empty">已添加的配置会显示在这里，可以随时查看和切换。</div>'
    $('#api-auto').checked = saved.automatic
    $('#api-itc').checked = saved.allowProtected
    $('#api-ddl').checked = saved.automaticDeadlines
    $('[data-add-help]').textContent = saved.profiles.length
      ? '添加成功后会保留当前选择。到「已添加 API」点击「使用此配置」即可切换。'
      : '第一份配置添加成功后会自动设为当前使用。保存后可单独验证连接。'
    $('[data-api="clear"]').textContent = saved.error ? '清除损坏配置' : '清除全部配置'
    if (initial) {
      page = saved.profiles.length || saved.error ? 'list' : 'add'
      $('#api-add-model').value = saved.model
      $('#api-add-url').value = saved.baseUrl
    }
    setPage(page)
    enable()
  }

  async function run(operation) {
    if (busy || closed) return
    busy = true
    enable()
    try { await operation() }
    catch (error) { if (!closed) message('操作未完成', apiErrorText(error), 'error') }
    finally { busy = false; if (!closed) enable() }
  }

  async function load() {
    await run(async () => {
      message('正在读取已保存的配置…')
      const result = await client.settings()
      if (closed) return
      draw(result, true)
      $('[data-api="reload"]').hidden = true
      if (result.error) message('配置暂时无法读取', '请清除损坏配置后重新添加。', 'error')
      else message(result.profiles.length ? `已保存 ${result.profiles.length} 份 API 配置` : '开始添加你的 API', '保存的 Key 仅在本机加密使用。')
    })
    if (!closed && !saved) $('[data-api="reload"]').hidden = false
  }

  const formValue = prefix => ({ name: value(`${prefix}-name`), apiKey: value(`${prefix}-key`),
    model: value(`${prefix}-model`), baseUrl: value(`${prefix}-url`) })

  $('[data-add]').addEventListener('submit', event => {
    event.preventDefault()
    run(async () => {
      message('正在添加 API 配置…')
      const result = await client.addProfile(formValue('api-add'))
      if (closed) return
      highlightId = result.createdProfileId
      const row = result.profiles.find(item => item.id === highlightId)
      $('#api-add-name').value = ''
      $('#api-add-key').value = ''
      page = 'list'
      draw(result)
      message(`添加成功：${row.name}`, row.active
        ? '已加密保存，并设为当前使用。你可以点击「验证连接」确认 Key 与模型可用。'
        : '已加密保存。点击这份配置的「使用此配置」后，聊天和通知整理就会切换到它。', 'success')
      onChange?.()
    })
  })

  editForm.addEventListener('submit', event => {
    event.preventDefault()
    const id = editingId
    run(async () => {
      message('正在保存修改…')
      const result = await client.updateProfile({ id, ...formValue('api-edit') })
      if (closed) return
      cancelEdit()
      draw(result)
      message('修改已保存', '当前使用的配置有变化时会立即生效。', 'success')
      onChange?.()
    })
  })

  $('[data-preferences]').addEventListener('submit', event => {
    event.preventDefault()
    run(async () => {
      const result = await client.saveSettings({ automatic: $('#api-auto').checked,
        allowProtected: $('#api-itc').checked, automaticDeadlines: $('#api-ddl').checked })
      if (closed) return
      draw(result)
      message('处理偏好已保存', '切换 API 配置时会保留这些偏好。', 'success')
      onChange?.()
    })
  })

  box.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    if (button.dataset.page) return setPage(button.dataset.page, true)
    const action = button.dataset.api
    const id = button.dataset.id
    if (action === 'close') return closeOverlay()
    if (action === 'reload') return load()
    if (action === 'cancel-edit') return cancelEdit()
    if (action === 'cancel-confirm') { confirming = null; $('[data-confirm]').hidden = true; return }
    if (action === 'edit') {
      const row = saved.profiles.find(item => item.id === id)
      editingId = id
      editForm.hidden = false
      for (const [field, item] of Object.entries({ name: row.name, model: row.model, url: row.baseUrl, key: '' })) $(`#api-edit-${field}`).value = item
      $('#api-edit-key').placeholder = `留空保留原 Key（${row.keyHint}）`
      editForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      $('#api-edit-name').focus()
      return
    }
    if (action === 'delete' || action === 'clear') {
      cancelEdit()
      confirming = action === 'clear' ? 'all' : id
      const row = saved.profiles.find(item => item.id === id)
      $('[data-confirm] p').textContent = action === 'clear'
        ? '确定清除全部 API 配置？聊天和自动整理将暂停，校园绑定与已保存的提醒会保留。'
        : `确定删除「${row.name}」？${row.active ? '它是当前使用的配置，删除后聊天和自动整理将暂停，需要手动选择其他配置。' : '当前使用的配置不受影响。'}`
      $('[data-confirm]').hidden = false
      $('[data-confirm]').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    if (!['select', 'check', 'confirm'].includes(action)) return
    const target = confirming
    run(async () => {
      if (action === 'check') {
        message('正在验证连接…', '此操作只读取模型列表，不切换当前使用的 API。')
        let result
        try { result = await client.check(id) }
        catch (error) {
          try { const latest = await client.settings(); if (!closed) draw(latest) } catch { /* Keep the original connection error. */ }
          throw error
        }
        if (closed) return
        draw(result.settings)
        message('连接验证成功', `「${saved.profiles.find(row => row.id === id).name}」的 Key 和模型可用。`, 'success')
        return
      }
      message(action === 'select' ? '正在切换 API…' : '正在删除配置…')
      const result = action === 'select' ? await client.selectProfile(id)
        : target === 'all' ? await client.clearSettings() : await client.deleteProfile(target)
      if (closed) return
      confirming = null
      $('[data-confirm]').hidden = true
      draw(result)
      const active = saved.profiles.find(row => row.active)
      message(action === 'select' ? `已切换为：${active.name}` : '配置已删除', active
        ? `聊天和通知整理当前使用「${active.name}」。` : '当前没有启用的 API。添加或选择一份配置后即可恢复。', 'success')
      onChange?.()
    })
  })

  $('.api-tabs').addEventListener('keydown', event => {
    if (busy || !saved || saved.error || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setPage(event.key === 'Home' ? 'list' : event.key === 'End' ? 'add' : page === 'list' ? 'add' : 'list', true)
  })
  setPage(page)
  enable()
  load()
}
