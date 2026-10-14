// All authentication data stays in this module's memory and the local service.
// Do not put credentials, cookies, API tokens or auth snapshots into the UI store.
const SAFE_ERRORS = new Set(['invalid_input', 'invalid_credentials', 'network_error', 'network_unavailable', 'challenge_required', 'busy', 'auth_busy', 'rate_limited', 'cancelled', 'storage_error', 'service_unavailable', 'timeout', 'csrf_invalid', 'auth_failed', 'authentication_error', 'unexpected_response', 'session_expired', 'credential_store_error', 'login_rejected', 'campus_network_required', 'invalid_cas_page', 'unexpected_destination', 'auth_retry_later', 'auth_storage_error', 'credential_corrupt', 'credential_unavailable', 'credential_key_missing'])
const STATES = new Set(['unbound', 'authenticating', 'authenticated', 'expired', 'error', 'challenge_required'])
const PHASES = new Set(['loading_login', 'loading_public_key', 'submitting', 'verifying_login', 'ready_to_bind'])

export class LocalApiError extends Error {
  constructor(code = 'service_unavailable') { super(code); this.name = 'LocalApiError'; this.code = SAFE_ERRORS.has(code) ? code : 'service_unavailable' }
}

export function createAuthClient(fetcher = globalThis.fetch?.bind(globalThis)) {
  let token = null
  let bootstrap = null

  async function read(path, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetcher(path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })
      let data
      try { data = await response.json() } catch { throw new LocalApiError('unexpected_response') }
      if (!response.ok) throw new LocalApiError(data?.error)
      return data
    } catch (error) {
      if (error instanceof LocalApiError) throw error
      throw new LocalApiError(error?.name === 'AbortError' ? 'timeout' : 'network_unavailable')
    } finally { clearTimeout(timer) }
  }

  async function ensureToken() {
    if (token) return token
    if (!bootstrap) bootstrap = read('/api/bootstrap').then(data => {
      if (typeof data?.csrfToken !== 'string' || !data.csrfToken) throw new LocalApiError('unexpected_response')
      token = data.csrfToken
      return token
    }).finally(() => { bootstrap = null })
    return bootstrap
  }

  async function request(path, body) {
    const csrf = await ensureToken()
    try {
      return await read(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-PigeonPal-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (error) {
      if (error.code === 'csrf_invalid') token = null
      throw error
    }
  }

  const snapshot = data => {
    if (!data || !STATES.has(data.state) || typeof data.bound !== 'boolean') throw new LocalApiError('unexpected_response')
    return { state: data.state, bound: data.bound, account: typeof data.account === 'string' ? data.account : null,
      phase: PHASES.has(data.phase) ? data.phase : null, error: SAFE_ERRORS.has(data.error) ? data.error : null,
      requestId: typeof data.requestId === 'string' ? data.requestId : null,
      authenticatedAt: typeof data.authenticatedAt === 'string' ? data.authenticatedAt : null,
      canRetryAt: typeof data.canRetryAt === 'string' ? data.canRetryAt : null }
  }

  return {
    status: async () => snapshot(await request('/api/auth/status')),
    login: async ({ username, password, requestId }) => snapshot(await request('/api/auth/login', { username, password, requestId })),
    confirm: async requestId => snapshot(await request('/api/auth/confirm', { requestId })),
    cancel: async requestId => snapshot(await request('/api/auth/cancel', { requestId })),
    unbind: async () => snapshot(await request('/api/auth/unbind', {})),
    sources: async () => { const data = await request('/api/sources'); if (!Array.isArray(data?.sources)) throw new LocalApiError('unexpected_response'); return data.sources },
  }
}
