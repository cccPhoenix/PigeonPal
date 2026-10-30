const browserState = () => ({ enabled: false, supported: false, installSupported: false,
  currentVersion: '', automaticCheck: false, phase: 'unavailable', unavailableReason: 'browser',
  availableVersion: null, releaseNotes: '', lastCheckedAt: null, progress: 0, error: null })

export function createUpdateClient(bridge) {
  let state = browserState(), off = null
  const listeners = new Set()
  const accept = value => {
    if (!value || typeof value !== 'object' || typeof value.phase !== 'string') return state
    state = { ...state, ...value }
    for (const listener of listeners) listener({ ...state })
    return { ...state }
  }
  const call = async (method, value) => {
    if (!bridge?.[method]) return { ...state }
    return accept(await bridge[method](value))
  }
  return {
    get state() { return { ...state } },
    async connect() {
      if (!bridge?.updateStatus) return { ...state }
      if (!off) off = bridge.onUpdateStatus?.(accept)
      return call('updateStatus')
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    check: () => call('checkForUpdates'),
    automatic: value => call('setAutomaticUpdateCheck', value),
    download: () => call('downloadUpdate'),
    install: () => call('installUpdate'),
    openRelease: () => bridge?.openUpdateRelease?.(),
    disconnect() { off?.(); off = null; listeners.clear() },
  }
}

export const desktopUpdates = createUpdateClient(globalThis.pigeonpalDesktop)
