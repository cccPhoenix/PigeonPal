// Model keys stay in the password field and the encrypted local service vault.
// This client never writes configuration or credentials into browser storage.
export class ApiError extends Error {
  constructor(code) {
    super('Local API request failed')
    this.code = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'service_unavailable'
  }
}

export function apiErrorText(error) {
  return ({
    ai_not_configured: '先在左下角的「API 设置」保存 DeepSeek API key，我们就能开始聊了。',
    ai_auth_failed: 'API key 无效或没有访问权限，请检查 API 设置。',
    ai_configuration_changed: 'API 配置刚刚更新，请重新发送这条消息。',
    ai_model_unavailable: '这个模型 ID 暂不可用，请检查 API 设置中的模型名。',
    ai_rate_limited: '模型服务暂时限流，稍等一会儿再试。',
    ai_upstream_unavailable: '模型服务暂时不可用，请稍后重试。',
    ai_timeout: '模型回复超时了。已经保存的提醒不会丢失，可以去提醒设置查看。',
    ai_network_error: '暂时连接不到 DeepSeek，请检查网络和 API 地址。',
    ai_request_rejected: '模型服务拒绝了请求，请核对模型和 API 地址。',
    ai_settings_unavailable: '本机 API 配置无法读取，请重新配置。',
    notice_not_found: '这条通知已经不在本机缓存里，无法引用。',
    notice_body_unavailable: '这条通知的正文还没采集完整，暂时不能引用。',
    notice_too_large: '这条通知正文过长，无法作为引用发送。',
    ai_settings_write_failed: 'API 配置保存失败，请检查本机目录权限。',
    ai_result_invalid: '通知整理结果格式不正确，可以稍后重试。',
    ai_response_invalid: '模型没有返回有效回复，请重试。',
    ai_output_incomplete: '模型回复没有生成完整，请重试。',
    ai_tool_limit: '模型连续查询通知后仍未完成回复，请换个更具体的问题重试。',
    chat_context_too_large: '对话上下文过长，请开始一段新对话后重试。',
    local_service_error: '本机服务处理请求时出错，请重启 PigeonPal 后重试。',
    invalid_input: '发送的数据格式不正确，请刷新页面后重试。',
    protected_source_not_allowed: 'API 设置里尚未允许整理 ITC 通知。',
    api_key_required: '请填写 API key。', invalid_api_key: 'API key 格式不正确。',
    invalid_model: '请填写有效的模型 ID。', invalid_api_url: '请填写 HTTPS API 基础地址，不包含 /chat/completions。',
    invalid_profile_name: '请为这份 API 配置填写一个 40 字以内的名称。',
    ai_profile_not_found: '这份 API 配置已被删除，请重新打开 API 设置。',
    ai_profile_duplicate: '相同 Key、模型和地址的配置已经添加，可以在「已添加 API」中选择使用。',
    ai_profiles_full: '最多可保存 20 份 API 配置，请先删除不再使用的配置。',
    chat_busy: '另一条回复还在生成，稍等一下再发。',
    reminder_time_in_past: '这个提醒时间已经过去了，请换一个未来的时间。',
    reminder_time_required: '还需要一个具体的提醒时间。',
    invalid_reminder_time: '提醒时间格式不正确，请重新设置。',
    reminder_storage_error: '提醒保存失败，请检查本机目录权限。',
    network_unavailable: '本机服务暂时不可用，请确认 PigeonPal 已启动。',
    not_found: '本机服务可能仍在运行旧版本，请重启 PigeonPal 后重试。',
    timeout: '请求超时，请稍后重试。',
  })[error?.code] || '这次请求没有完成，请稍后重试。'
}

export function createApiClient(fetcher = globalThis.fetch?.bind(globalThis)) {
  let token = null
  let bootstrap = null
  async function read(path, options = {}, timeout = 15_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetcher(path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })
      let data
      try { data = await response.json() } catch { throw new ApiError('unexpected_response') }
      if (!response.ok) throw new ApiError(data?.error)
      return data
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(error?.name === 'AbortError' ? 'timeout' : 'network_unavailable')
    } finally { clearTimeout(timer) }
  }
  async function ensureToken() {
    if (token) return token
    if (!bootstrap) bootstrap = read('/api/bootstrap').then(data => {
      if (typeof data?.csrfToken !== 'string' || !data.csrfToken) throw new ApiError('unexpected_response')
      token = data.csrfToken
      return token
    }).finally(() => { bootstrap = null })
    return bootstrap
  }
  async function request(path, body, timeout, retry = true) {
    const csrf = await ensureToken()
    try {
      return await read(path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-PigeonPal-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, timeout)
    } catch (error) {
      if (error.code === 'csrf_invalid') {
        token = null
        if (retry) return request(path, body, timeout, false)
      }
      throw error
    }
  }
  return {
    settings: () => request('/api/ai/settings'),
    saveSettings: body => request('/api/ai/settings', body),
    addProfile: body => request('/api/ai/profiles', body),
    updateProfile: body => request('/api/ai/profiles/update', body),
    selectProfile: id => request('/api/ai/profiles/select', { id }),
    deleteProfile: id => request('/api/ai/profiles/delete', { id }),
    clearSettings: () => request('/api/ai/clear', {}),
    check: profileId => request('/api/ai/check', profileId ? { profileId } : {}, 25_000),
    status: () => request('/api/ai/status'),
    notices: (source, offset = 0) => request(`/api/notices?source=${encodeURIComponent(source)}&offset=${offset}`),
    notice: id => request(`/api/notices/detail?noticeId=${encodeURIComponent(id)}`),
    process: noticeId => request('/api/ai/process', { noticeId, force: true }),
    chat: body => request('/api/chat', body, 300_000),
    reminders: () => request('/api/reminders'),
    createReminder: body => request('/api/reminders/create', body),
    updateReminder: (id, patch) => request('/api/reminders/update', { id, patch }),
    importReminders: reminders => request('/api/reminders/import', { reminders }),
    events: after => request(`/api/events?after=${after}`),
  }
}
