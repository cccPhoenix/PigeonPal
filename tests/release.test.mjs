import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const { versionForRelease, stageRelease } = require('../build/release.cjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pigeonpal-release-tests-'))
  mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.4.0', packages: { '': { version: '0.4.0' } } }))
  writeFileSync(join(root, 'docs', 'releases', '0.4.0.md'), 'Release notes')
  const payload = Buffer.from('Synthetic installer - never executed'), name = 'PigeonPal-Setup-0.4.0-x64.exe'
  writeFileSync(join(root, 'dist', name), payload)
  writeFileSync(join(root, 'dist', `${name}.blockmap`), 'block map')
  writeFileSync(join(root, 'dist', 'latest.yml'), `version: 0.4.0\nfiles:\n  - url: ${name}\n    size: ${payload.length}\n    sha512: ${createHash('sha512').update(payload).digest('base64')}\n`)
  writeFileSync(join(root, 'dist', 'desktop-self-check-windows.json'), JSON.stringify({ ok: true, version: '0.4.0', checks: ['update-settings'] }))
  return { root, name, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('release requires matching stable versions and an exact version tag', () => {
  const f = fixture()
  try {
    assert.equal(versionForRelease(f.root, 'v0.4.0'), '0.4.0')
    assert.throws(() => versionForRelease(f.root, 'v0.4.1'), /Tag must match/)
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '0.4.1' }))
    assert.throws(() => versionForRelease(f.root), /versions must match/)
  } finally { f.dispose() }
})

test('staging only copies validated version artifacts and hashes; old installers and private files stay out', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'dist', 'PigeonPal-Setup-0.3.1-x64.exe'), 'old')
    writeFileSync(join(f.root, 'dist', 'private.json'), 'private data placeholder')
    const folder = stageRelease('windows', f.root)
    assert.deepEqual(readdirSync(folder).sort(), [f.name, `${f.name}.blockmap`, 'desktop-self-check-windows.json', 'latest.yml', 'SHA256SUMS-windows.txt'].sort())
    assert.match(readFileSync(join(folder, 'SHA256SUMS-windows.txt'), 'utf8'), /[a-f0-9]{64}  PigeonPal-Setup-0.4.0-x64.exe/)
  } finally { f.dispose() }
})

test('staging rejects corrupted payloads, unmatched manifests and missing update UI acceptance', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'dist', f.name), 'tampered bytes')
    assert.throws(() => stageRelease('windows', f.root), /digest or size mismatch/)
    writeFileSync(join(f.root, 'dist', 'desktop-self-check-windows.json'), JSON.stringify({ ok: true, version: '0.3.1', checks: ['update-settings'] }))
    assert.throws(() => stageRelease('windows', f.root), /Matching desktop acceptance/)
  } finally { f.dispose() }
})
