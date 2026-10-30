import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createUpdateClient } from '../web/js/services/desktop-updates.js'
import { updatesPageHTML, createUpdateBanner } from '../web/js/ui/updates.js'
import { createStore, STORAGE_KEY } from '../web/js/store.js'
const require = createRequire(import.meta.url)
const { UpdateManager, releaseInfo, latestRelease, STARTUP_DELAY, CHECK_INTERVAL } = require('../desktop/updates.cjs')

function fixture(options = {}) {
  const updater = new EventEmitter(), events = [], scheduled = new Map()
  let saved = options.stored || null, checks = 0, downloads = 0, installs = 0, prepared = false
  updater.checkForUpdates = async () => { checks++; updater.emit('update-available', { version: '0.5.0', releaseNotes: '新功能' }) }
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 50 }); updater.emit('update-downloaded', { version: '0.5.0' }); return [] }
  updater.quitAndInstall = (silent, restart) => { assert.equal(prepared, true); assert.equal(silent, false); assert.equal(restart, true); installs++ }
  const manager = new UpdateManager({ updater, version: '0.4.0', platform: 'win32',
    load: () => saved, save: value => { saved = structuredClone(value) }, now: () => 123456,
    onChange: value => events.push(value), prepareInstall: async () => { prepared = true },
    schedule: (fn, delay) => { const key = {}; scheduled.set(key, { fn, delay }); return key },
    cancel: key => scheduled.delete(key), ...options })
  return { updater, manager, events, scheduled, saved: () => saved, checks: () => checks, downloads: () => downloads, installs: () => installs }
}

test('only newer stable versions produce release links; notes and URLs cannot introduce another origin', () => {
  for (const version of ['0.4.0', '0.3.1', '0.5.0-beta.1', 'bad', 'https://evil.example']) assert.equal(releaseInfo({ version }, '0.4.0'), null)
  const value = releaseInfo({ version: 'v0.5.0', releaseNotes: [{ note: '<script>test</script>' }], releaseUrl: 'https://evil.example' }, '0.4.0')
  assert.equal(value.releaseUrl, 'https://github.com/cccPhoenix/PigeonPal/releases/tag/v0.5.0')
  assert.equal(value.releaseNotes, '<script>test</script>')
})

test('disabling automatic checks persists, cancels timers and still permits manual checks', async () => {
  const f = fixture()
  f.manager.start()
  assert.equal([...f.scheduled.values()][0].delay, STARTUP_DELAY)
  f.manager.preferences(false)
  assert.equal(f.scheduled.size, 0)
  assert.equal(f.saved().automaticCheck, false)
  await f.manager.check({ automatic: true })
  assert.equal(f.checks(), 0)
  await f.manager.check()
  assert.equal(f.checks(), 1)
  assert.equal(f.manager.snapshot().phase, 'available')
  assert.equal(f.downloads(), 0, 'checking never downloads or installs')
  assert.equal(f.installs(), 0)
  const next = fixture({ stored: f.saved() })
  next.manager.start()
  assert.equal(next.scheduled.size, 0)
  f.manager.preferences(true)
  assert.equal([...f.scheduled.values()][0].delay, STARTUP_DELAY)
  const task = [...f.scheduled.values()][0]
  await task.fn()
  assert.equal([...f.scheduled.values()].at(-1).delay, CHECK_INTERVAL)
})

test('preference write failures leave the previous value visible and corrupt storage pauses automatic checking', () => {
  const f = fixture({ save: () => { throw new Error('disk') } })
  assert.throws(() => f.manager.preferences(false), /update_preferences_write_failed/)
  assert.equal(f.manager.snapshot().automaticCheck, true)
  const damaged = fixture({ load: () => { throw new Error('private path') } })
  assert.equal(damaged.manager.snapshot().automaticCheck, false)
  assert.equal(damaged.manager.snapshot().error, 'update_preferences_unavailable')
})

test('checks are single-flight; download requires consent and backend preparation finishes before install', async () => {
  const f = fixture()
  const check = f.manager.check()
  assert.equal(f.manager.check(), check)
  await check
  await f.manager.install()
  assert.equal(f.installs(), 0)
  const download = f.manager.download()
  assert.equal(f.manager.download(), download)
  await download
  assert.ok(f.events.some(value => value.phase === 'downloading' && value.progress === 50))
  assert.equal(f.manager.snapshot().phase, 'downloaded')
  assert.equal(f.updater.autoDownload, false)
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  assert.equal(f.updater.allowDowngrade, false)
  await f.manager.install()
  assert.equal(f.installs(), 1)
  await f.manager.install()
  assert.equal(f.installs(), 1)
})

test('failed check/download never leak transport details and remain retryable', async () => {
  const f = fixture()
  f.updater.checkForUpdates = async () => { throw new Error('https://secret@example.com') }
  await f.manager.check()
  assert.equal(f.manager.snapshot().error, 'update_check_failed')
  f.updater.checkForUpdates = async () => f.updater.emit('update-available', { version: '0.5.0' })
  await f.manager.check()
  f.updater.downloadUpdate = () => { throw new Error('credential') }
  await f.manager.download()
  assert.equal(f.manager.snapshot().phase, 'error')
  assert.equal(f.manager.snapshot().error, 'update_download_failed')
  assert.equal(f.manager.snapshot().availableVersion, '0.5.0')
  assert.doesNotMatch(JSON.stringify(f.events), /secret|credential/)
  f.updater.downloadUpdate = async () => f.updater.emit('update-downloaded', { version: '0.5.0' })
  await f.manager.download()
  assert.equal(f.manager.snapshot().phase, 'downloaded')
})

test('Mac checks published releases and offers manual download; offline/dev modes never request updates', async () => {
  const f = fixture({ platform: 'darwin', fetchRelease: async () => ({ version: '0.5.0', releaseNotes: 'Mac 更新' }) })
  await f.manager.check()
  assert.equal(f.manager.snapshot().phase, 'available')
  assert.equal(f.manager.snapshot().installSupported, false)
  await f.manager.download()
  assert.equal(f.downloads(), 0)
  for (const options of [{ offline: true }, { packaged: false }, { platform: 'linux' }]) {
    const disabled = fixture(options)
    disabled.manager.start()
    await disabled.manager.check()
    assert.equal(disabled.checks(), 0)
    assert.equal(disabled.scheduled.size, 0)
  }
})

test('GitHub lookup uses a fixed public endpoint, ignores drafts/prereleases and handles an empty release catalog', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/cccPhoenix/PigeonPal/releases/latest')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, undefined)
    return { ok: true, json: async () => ({ tag_name: 'v0.5.0', body: '发布说明', published_at: '2026-11-01' }) }
  }
  assert.equal((await latestRelease(fetcher)).version, 'v0.5.0')
  assert.equal(await latestRelease(async () => ({ status: 404 })), null)
  assert.equal(await latestRelease(async () => ({ ok: true, json: async () => ({ tag_name: 'v0.5.0', prerelease: true }) })), null)
})

test('renderer bridge receives live status, exposes only fixed actions and releases listeners', async () => {
  let listener, unsubscribed = false
  const calls = [], client = createUpdateClient({ updateStatus: async () => ({ phase: 'idle', enabled: true }),
    onUpdateStatus: fn => { listener = fn; return () => { unsubscribed = true } },
    setAutomaticUpdateCheck: async value => { calls.push(value); return { phase: 'idle', automaticCheck: value } } })
  const values = [], off = client.subscribe(value => values.push(value))
  await client.connect()
  await client.automatic(false)
  listener({ phase: 'downloaded', availableVersion: '0.5.0' })
  assert.equal(client.state.phase, 'downloaded')
  assert.deepEqual(calls, [false])
  off(); client.disconnect()
  assert.equal(unsubscribed, true)
  assert.equal((await createUpdateClient().connect()).unavailableReason, 'browser')
})

test('update UI escapes release notes and banner opens settings without starting a download', () => {
  const f = fixture(), state = { ...f.manager.snapshot(), phase: 'available', availableVersion: '0.5.0', releaseNotes: '<img src=x onerror=alert(1)>' }
  const html = updatesPageHTML(state)
  assert.match(html, /data-update="check"/)
  assert.match(html, /data-update="download"/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(updatesPageHTML({ ...state, installSupported: false }), /data-update="install"/)
  assert.match(updatesPageHTML({ ...state, phase: 'downloaded' }), /data-update="install"/)
  let listener, click, opened = 0
  const client = { state, subscribe: fn => { listener = fn; return () => {} } }
  const root = { hidden: true, innerHTML: '', addEventListener: (_, fn) => { click = fn } }
  createUpdateBanner({ root, client, onOpen: () => { opened++ } })
  assert.equal(root.hidden, false)
  click({ target: { closest: () => ({ dataset: { updateBanner: 'open' } }) } })
  assert.equal(opened, 1)
  click({ target: { closest: () => ({ dataset: { updateBanner: 'dismiss' } }) } })
  listener(state)
  assert.equal(root.hidden, true)
  assert.equal(f.downloads(), 0)
})

test('explicit flush saves a just-edited state before the 200ms debounce can run', () => {
  const memory = new Map(), store = createStore({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) })
  store.setProfile({ nickname: '更新保存验收' })
  assert.equal(memory.has(STORAGE_KEY), false)
  store.flush()
  assert.equal(JSON.parse(memory.get(STORAGE_KEY)).profile.nickname, '更新保存验收')
  const broken = createStore({ getItem: () => null, setItem: () => { throw new Error('disk full') } })
  assert.equal(broken.flush(), false)
})
