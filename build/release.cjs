// The release folder is an explicit allowlist, never an upload of dist/ or user data.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const semver = require('semver')
const yaml = require('js-yaml')
const ROOT = path.join(__dirname, '..')

function versionForRelease(root = ROOT, tag) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const version = pkg.version
  if (!semver.valid(version) || semver.prerelease(version) || lock.version !== version || lock.packages[''].version !== version) throw new Error('Release versions must match and be stable')
  if (tag && tag !== `v${version}`) throw new Error('Tag must match package.json version')
  if (!fs.existsSync(path.join(root, 'docs', 'releases', `${version}.md`))) throw new Error('Versioned release notes are missing')
  return version
}

function stageRelease(platform, root = ROOT) {
  const version = versionForRelease(root)
  if (!['windows', 'mac'].includes(platform)) throw new Error('Unsupported release platform')
  const dist = path.join(root, 'dist')
  const folder = path.join(dist, `release-${version}-${platform}`)
  const installer = platform === 'windows' ? `PigeonPal-Setup-${version}-x64.exe` : `PigeonPal-${version}-mac-arm64.dmg`
  const files = [installer, `desktop-self-check-${platform}.json`]
  const report = JSON.parse(fs.readFileSync(path.join(dist, files[1]), 'utf8'))
  if (report.ok !== true || report.version !== version || !report.checks?.includes('update-settings')) throw new Error('Matching desktop acceptance report is required')
  if (platform === 'windows') {
    const manifest = yaml.load(fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'))
    if (manifest.version !== version || manifest.files?.length !== 1 || manifest.files[0].url !== installer) throw new Error('Update manifest must reference this release installer')
    const bytes = fs.readFileSync(path.join(dist, installer))
    if (manifest.files[0].size !== bytes.length || manifest.files[0].sha512 !== crypto.createHash('sha512').update(bytes).digest('base64')) throw new Error('Update manifest digest or size mismatch')
    files.push(`${installer}.blockmap`, 'latest.yml')
  }
  const checksum = `SHA256SUMS-${platform}.txt`
  const allowed = new Set([...files, checksum])
  if (fs.existsSync(folder) && fs.readdirSync(folder).some(name => !allowed.has(name))) throw new Error('Unexpected files in release staging folder')
  fs.mkdirSync(folder, { recursive: true })
  const hashes = []
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(dist, name))
    fs.writeFileSync(path.join(folder, name), bytes)
    hashes.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`)
  }
  fs.writeFileSync(path.join(folder, checksum), hashes.join('\n') + '\n')
  return folder
}

if (require.main === module) {
  const [command, value] = process.argv.slice(2)
  if (command === 'verify') console.log(versionForRelease(ROOT, value))
  else if (command === 'stage') console.log(stageRelease(value))
  else throw new Error('Use: node build/release.cjs verify [vVERSION] | stage windows|mac')
}
module.exports = { versionForRelease, stageRelease }
