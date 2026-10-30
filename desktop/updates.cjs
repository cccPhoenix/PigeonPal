// Update preferences are independent of campus notifications and contain no account data.
const semver = require('semver')
const REPOSITORY = 'cccPhoenix/PigeonPal'
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`
const CHECK_INTERVAL = 24 * 60 * 60 * 1000
const STARTUP_DELAY = 15 * 1000

function releaseInfo(info, currentVersion) {
  const version = typeof info?.version === 'string' ? semver.valid(info.version) : null
  if (!version || semver.prerelease(version) || !semver.gt(version, currentVersion)) return null
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map(row => typeof row?.note === 'string' ? row.note : '').join('\n\n') : info.releaseNotes
  return { version, releaseNotes: typeof notes === 'string' ? notes.slice(0, 16000) : '',
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate.slice(0, 40) : '',
    releaseUrl: `${RELEASES_URL}/tag/v${version}` }
}

async function latestRelease(fetcher = globalThis.fetch) {
  const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PigeonPal-Update-Check' },
    signal: AbortSignal.timeout(20000), redirect: 'error',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('update_check_failed')
  const value = await response.json()
  if (value.draft || value.prerelease || typeof value.tag_name !== 'string') return null
  return { version: value.tag_name, releaseNotes: value.body, releaseDate: value.published_at }
}

class UpdateManager {
  constructor({ updater, version, platform = process.platform, packaged = true, offline = false,
    load = () => null, save = () => {}, now = Date.now, fetchRelease = latestRelease,
    onChange = () => {}, onAvailable = () => {}, prepareInstall = async () => {},
    installFailed = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
    this.updater = updater
    this.save = save
    this.now = now
    this.fetchRelease = fetchRelease
    this.onChange = onChange
    this.onAvailable = onAvailable
    this.prepareInstall = prepareInstall
    this.installFailed = installFailed
    this.schedule = schedule
    this.cancel = cancel
    this.timer = null
    this.running = false
    this.inFlight = null
    this.downloadInFlight = null
    let stored, preferencesError = false
    try { stored = load() } catch { preferencesError = true }
    const supported = ['win32', 'darwin'].includes(platform)
    this.state = { currentVersion: version, platform, supported,
      enabled: packaged && !offline && supported,
      installSupported: packaged && !offline && platform === 'win32' && Boolean(updater),
      automaticCheck: preferencesError ? false : stored?.automaticCheck !== false,
      phase: packaged && !offline && supported ? 'idle' : 'unavailable',
      unavailableReason: !packaged ? 'development' : offline ? 'offline' : !supported ? 'platform' : '',
      lastCheckedAt: Number.isFinite(stored?.lastCheckedAt) && stored.lastCheckedAt >= 0 ? stored.lastCheckedAt : null,
      availableVersion: null, releaseNotes: '', releaseDate: '', releaseUrl: RELEASES_URL,
      progress: 0, error: preferencesError ? 'update_preferences_unavailable' : null }
    if (updater) {
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.autoRunAppAfterInstall = true
      updater.allowPrerelease = false
      updater.allowDowngrade = false
      updater.disableWebInstaller = true
      updater.logger = null // Never forward URLs, headers or raw transport errors to the UI/logs.
      updater.on('update-available', info => {
        const release = releaseInfo(info, version)
        if (!release) return this.set({ phase: 'current', availableVersion: null, releaseNotes: '', progress: 0 })
        this.set({ ...release, availableVersion: release.version, phase: 'available', progress: 0, error: null })
        this.onAvailable(this.snapshot())
      })
      updater.on('update-not-available', () => this.set({ phase: 'current', availableVersion: null, releaseNotes: '', progress: 0, error: null }))
      updater.on('download-progress', value => {
        if (this.state.phase !== 'downloading') return
        this.set({ progress: Number.isFinite(value?.percent) ? Math.max(0, Math.min(100, value.percent)) : 0 })
      })
      updater.on('update-downloaded', info => {
        if (releaseInfo(info, version)?.version !== this.state.availableVersion) return
        this.set({ phase: 'downloaded', progress: 100, error: null })
      })
      updater.on('error', () => this.set({ phase: 'error', error: this.state.phase === 'downloading'
        ? 'update_download_failed' : this.state.phase === 'installing' ? 'update_install_failed' : 'update_check_failed' }))
    }
  }

  snapshot() { return { ...this.state } }
  set(patch) { Object.assign(this.state, patch); this.onChange(this.snapshot()) }
  persist(patch = {}) {
    this.save({ schemaVersion: 1, automaticCheck: this.state.automaticCheck, lastCheckedAt: this.state.lastCheckedAt, ...patch })
  }
  start() { this.running = true; this.plan(STARTUP_DELAY) }
  stop() { this.running = false; if (this.timer !== null) this.cancel(this.timer); this.timer = null }
  plan(delay = CHECK_INTERVAL) {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    if (!this.running || !this.state.enabled || !this.state.automaticCheck) return
    this.timer = this.schedule(async () => {
      this.timer = null
      await this.check({ automatic: true })
      this.plan()
    }, delay)
    this.timer?.unref?.()
  }
  preferences(value) {
    if (typeof value !== 'boolean') throw new Error('invalid_update_preferences')
    // A failed disk write must not make the switch look saved.
    try { this.persist({ automaticCheck: value }) } catch { throw new Error('update_preferences_write_failed') }
    this.set({ automaticCheck: value, error: null })
    this.plan(STARTUP_DELAY)
    return this.snapshot()
  }
  check({ automatic = false } = {}) {
    if (!this.state.enabled || automatic && !this.state.automaticCheck) return Promise.resolve(this.snapshot())
    if (this.inFlight) return this.inFlight
    if (['downloading', 'downloaded', 'installing'].includes(this.state.phase)) return Promise.resolve(this.snapshot())
    this.set({ phase: 'checking', error: null })
    this.inFlight = (async () => {
      try {
        if (this.state.installSupported) {
          await this.updater.checkForUpdates()
        } else {
          const info = await this.fetchRelease()
          const release = releaseInfo(info, this.state.currentVersion)
          this.set(release ? { ...release, phase: 'available', availableVersion: release.version }
            : { phase: 'current', availableVersion: null, releaseNotes: '' })
          if (release) this.onAvailable(this.snapshot())
        }
        this.set({ lastCheckedAt: this.now() })
        try { this.persist() } catch { this.set({ error: 'update_preferences_write_failed' }) }
      } catch {
        this.set({ phase: 'error', error: 'update_check_failed' })
      }
      return this.snapshot()
    })().finally(() => { this.inFlight = null })
    return this.inFlight
  }
  download() {
    if (this.downloadInFlight) return this.downloadInFlight
    if (!this.state.enabled || !this.state.installSupported || !this.state.availableVersion
        || !['available', 'error'].includes(this.state.phase)) return Promise.resolve(this.snapshot())
    this.set({ phase: 'downloading', progress: 0, error: null })
    this.downloadInFlight = Promise.resolve().then(() => this.updater.downloadUpdate()).then(() => this.snapshot()).catch(() => {
      this.set({ phase: 'error', error: 'update_download_failed' })
      return this.snapshot()
    }).finally(() => { this.downloadInFlight = null })
    return this.downloadInFlight
  }
  async install() {
    if (!this.state.enabled || !this.state.installSupported || this.state.phase !== 'downloaded') return this.snapshot()
    this.set({ phase: 'installing', error: null })
    try {
      this.stop()
      await this.prepareInstall()
      this.updater.quitAndInstall(false, true)
      if (this.state.error) this.installFailed()
    } catch {
      this.set({ phase: 'error', error: 'update_install_failed' })
      this.installFailed()
    }
    return this.snapshot()
  }
}

module.exports = { UpdateManager, releaseInfo, latestRelease, REPOSITORY, RELEASES_URL, CHECK_INTERVAL, STARTUP_DELAY }
