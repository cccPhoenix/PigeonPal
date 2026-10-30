// Real electron-updater transport/cache/checksum acceptance. Synthetic bytes are
// downloaded only into a fresh temp directory; an installer is never executed.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeonpal-update-transport-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename, dir], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  process.exit(result.status === 0 ? 0 : 1)
} else {
  const { app } = require('electron')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const http = require('node:http')
  const crypto = require('node:crypto')
  const assert = require('node:assert/strict')
  const { NsisUpdater } = require('electron-updater')
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
  const { UpdateManager } = require('../desktop/updates.cjs')
  const dir = process.argv[2]
  app.setPath('userData', path.join(dir, 'electron'))
  app.whenReady().then(async () => {
    const bytes = Buffer.concat([Buffer.from('MZ-SYNTHETIC-NOT-EXECUTABLE\n'), Buffer.alloc(256000, 71)])
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
    let version = '0.4.1', corrupt = false, downloads = 0
    const server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url.split('?')[0] === '/latest.yml') {
        const digest = corrupt ? crypto.createHash('sha512').update(Buffer.alloc(bytes.length, 73)).digest('base64') : sha512
        response.end(`version: ${version}\nfiles:\n  - url: PigeonPal-Setup-${version}-x64.exe\n    size: ${bytes.length}\n    sha512: ${digest}\n`)
      } else if (request.url.endsWith('.exe')) {
        downloads++
        response.setHeader('Content-Length', bytes.length)
        response.end(corrupt ? Buffer.alloc(bytes.length, 72) : bytes)
      } else { response.writeHead(404); response.end() }
    })
    let code = 0
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const configPath = path.join(dir, 'app-update.yml')
      fs.writeFileSync(configPath, 'updaterCacheDirName: pigeonpal-smoke-updater\n')
      const adapter = { version: '0.4.0', name: 'PigeonPal update smoke', isPackaged: true,
        userDataPath: path.join(dir, 'user'), baseCachePath: path.join(dir, 'cache'), appUpdateConfigPath: configPath,
        whenReady: () => Promise.resolve(), onQuit: () => {}, quit: () => { throw new Error('Installer must never run') } }
      const updater = new NsisUpdater(null, adapter)
      updater.httpExecutor = new ElectronHttpExecutor(() => {})
      updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` })
      updater.disableDifferentialDownload = true
      const manager = new UpdateManager({ updater, version: '0.4.0', platform: 'win32' })
      updater.on('error', error => console.error('Synthetic update transport:', error.message))
      await manager.check()
      assert.equal(manager.snapshot().phase, 'available')
      assert.equal(downloads, 0)
      await manager.download()
      assert.equal(manager.snapshot().phase, 'downloaded')
      assert.equal(downloads, 1)
      assert.deepEqual(fs.readFileSync(updater.installerPath), bytes)
      version = '0.4.2'; corrupt = true
      const second = new NsisUpdater(null, adapter)
      second.httpExecutor = new ElectronHttpExecutor(() => {})
      second.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` })
      second.disableDifferentialDownload = true
      const failed = new UpdateManager({ updater: second, version: '0.4.0', platform: 'win32' })
      await failed.check()
      await failed.download()
      assert.equal(failed.snapshot().phase, 'error')
      assert.equal(failed.snapshot().error, 'update_download_failed')
      assert.equal(second.installerPath, null, 'corrupted payload must not become installable')
      console.log('Update transport: real NSIS manifest lookup, explicit download, cache, SHA512 rejection passed; no installer executed.')
    } catch (error) { code = 1; console.error(error) }
    finally {
      server.closeAllConnections(); server.close()
      app.exit(code)
    }
  }).catch(() => app.exit(1))
}
