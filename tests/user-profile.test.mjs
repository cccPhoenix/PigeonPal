import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRecommendation, noticeKept, noticePushable, deliveryTransition, orderRecommended } from '../web/js/services/recommendations.js'
import { createStore, hydrate } from '../web/js/store.js'
import { createAcademySelection } from '../web/js/services/academy-selection.js'
import { localAdapters, startFeed } from '../web/js/services/sources.js'
import { createApiClient, ApiError } from '../web/js/services/api.js'
import { createAIChat, buildChatHistory } from '../web/js/services/chat.js'

globalThis.document = globalThis.document ?? { addEventListener() {} }
const { createRail } = await import('../web/js/ui/rail.js')
const { preferenceLines, preferenceError, openUserProfile } = await import('../web/js/ui/user-profile.js')
const row = (id, recommendation, extra = {}) => ({ id, noticeId: id, sourceId: 'yunfeng', title: `通知 ${id}`, real: true, revision: 'r1', publishedAt: 1, recommendation, ...extra })
const recommendation = (decision, priority = 0) => ({ state: 'ready', decision, allowPush: decision !== 'not_applicable', priority, reason: '按已确认身份判断', evidence: decision === 'not_applicable' ? ['仅限研究生'] : [], profileVersion: 1, override: null })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function profilePageDocument() {
  const nodes = [], body = { innerHTML: '' }, student = { value: '' }, academy = { value: '' }
  const inputs = ['degree', 'admissionYear', 'college', 'major'].map(key => ({ dataset: { fact: key }, value: '' }))
  const preferences = ['interests', 'avoid'].map(key => ({ dataset: { preference: key }, value: '' }))
  const node = () => ({ innerHTML: '', listeners: {}, classList: { add() {}, remove() {} }, remove() {}, append() {}, setAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn },
    removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name] },
    querySelector(selector) {
      if (selector === '[data-profile-body]') return body
      if (selector === '[data-student-number]') return student
      if (selector === '[data-academy]') return academy
      if (selector.startsWith('[data-confirm=')) return { checked: false }
      return null
    },
    querySelectorAll(selector) { return selector === '[data-fact]' ? inputs : selector === '[data-preference]' ? preferences : [] },
  })
  const toast = node(), layer = node()
  return { nodes, body, student, academy, inputs, preferences, root: node(), document: { addEventListener() {}, createElement() { const value = node(); nodes.push(value); return value }, getElementById(id) { return id === 'toast' ? toast : layer } } }
}

test('academy source choice is saved with the profile version and read back from the service', async () => {
  const originalDocument = globalThis.document
  let saved = { version: 4, academy: 'yunfeng', facts: {}, preferences: {} }
  const changes = []
  const requests = []
  const client = {
    userProfile: async () => saved,
    saveUserProfile: async patch => {
      requests.push(patch)
      saved = { ...saved, ...patch, version: saved.version + 1 }
      return saved
    },
  }
  const page = profilePageDocument()
  globalThis.document = page.document
  let mounted
  try {
    mounted = openUserProfile({ root: page.root, client, onChange: snapshot => changes.push(snapshot) })
    await tick()
    assert.match(page.body.innerHTML, /for="up-academy">所属学园<\/label>/)
    assert.match(page.body.innerHTML, /data-academy-option="yunfeng" aria-selected="true"/)
    assert.match(page.body.innerHTML, /data-academy-option="danyang"/)
    assert.match(page.body.innerHTML, /data-academy-option="lantian"/)
    assert.doesNotMatch(page.body.innerHTML, /data-confirm="academy"/)
    page.academy.value = 'danyang'
    page.root.listeners.submit({ target: { matches: () => true }, preventDefault() {} })
    await tick()
    assert.equal(requests[0].expectedVersion, 4)
    assert.equal(requests[0].academy, 'danyang')
    assert.equal(changes.length, 1)
    assert.equal(changes[0], saved)
    assert.equal(changes[0].academy, 'danyang')
    assert.equal(changes[0].version, 5)
    assert.match(page.body.innerHTML, /data-academy-option="danyang" aria-selected="true"/)
    mounted.destroy()
    mounted = openUserProfile({ root: page.root, client })
    await tick()
    assert.match(page.body.innerHTML, /data-academy-option="danyang" aria-selected="true"/)
    page.academy.value = ''
    page.root.listeners.submit({ target: { matches: () => true }, preventDefault() {} })
    await tick()
    assert.equal(requests[1].expectedVersion, 5)
    assert.equal(requests[1].academy, '')
    assert.match(page.body.innerHTML, /data-academy-option="" aria-selected="true"/)
  } finally { mounted?.destroy(); globalThis.document = originalDocument }
})

test('inline profile renders in its host and releases handlers and data on view change', async () => {
  const originalDocument = globalThis.document
  const page = profilePageDocument()
  globalThis.document = page.document
  try {
    const mounted = openUserProfile({ root: page.root, client: { userProfile: async () => ({ version: 0, facts: {}, preferences: {} }) } })
    await tick()
    assert.equal(page.nodes.length, 0)
    assert.match(page.root.innerHTML, /id="user-profile-title"/)
    assert.doesNotMatch(page.root.innerHTML, /profile-hero-icon|profile-eyebrow/)
    assert.match(page.body.innerHTML, /data-profile-form/)
    assert.doesNotMatch(page.body.innerHTML, /profile-summary|已确认身份|关注方向<\/span>/)
    assert.match(page.body.innerHTML, /class="profile-secondary-actions"/)
    assert.match(page.body.innerHTML, /class="btn primary profile-save"/)
    mounted.destroy()
    assert.equal(page.root.innerHTML, '')
    assert.equal(page.root.listeners.submit, undefined)
    assert.equal(page.root.listeners.click, undefined)
  } finally { globalThis.document = originalDocument }
})

for (const operation of ['save', 'clear']) test(`a late profile ${operation} still updates the app after leaving the profile view`, async () => {
  const originalDocument = globalThis.document, originalConfirm = globalThis.confirm
  const page = profilePageDocument(), changes = []
  const committed = { version: 9, academy: operation === 'save' ? 'danyang' : '', facts: {}, preferences: {} }
  let finish, mounted
  const pending = new Promise(resolve => { finish = resolve })
  const client = {
    userProfile: async () => ({ version: 8, academy: 'yunfeng', facts: {}, preferences: {} }),
    saveUserProfile: () => pending, clearUserProfile: () => pending,
  }
  globalThis.document = page.document; globalThis.confirm = () => true
  try {
    mounted = openUserProfile({ root: page.root, client, onChange: snapshot => changes.push(snapshot) })
    await tick()
    if (operation === 'save') {
      page.academy.value = 'danyang'
      page.root.listeners.submit({ target: { matches: () => true }, preventDefault() {} })
    } else page.root.listeners.click({ target: { closest: () => ({ dataset: { profile: 'clear' } }) } })
    mounted.destroy()
    page.root.innerHTML = '<p>新的通知视图</p>'
    page.body.innerHTML = '<p>新的页面内容</p>'
    const toast = page.document.getElementById('toast')
    toast.textContent = '原有提示'
    finish(committed)
    await tick()
    assert.deepEqual(changes, [committed])
    assert.equal(page.root.innerHTML, '<p>新的通知视图</p>')
    assert.equal(page.body.innerHTML, '<p>新的页面内容</p>')
    assert.equal(toast.textContent, '原有提示')
    assert.equal(page.root.listeners.submit, undefined)
  } finally { mounted?.destroy(); globalThis.document = originalDocument; globalThis.confirm = originalConfirm }
})

test('read-only profile keeps recovery controls enabled outside its disabled form', async () => {
  const originalDocument = globalThis.document
  const page = profilePageDocument()
  globalThis.document = page.document
  try {
    const mounted = openUserProfile({ root: page.root, client: { userProfile: async () => ({ version: 2, facts: {}, preferences: {}, storageError: 'profile_storage_error' }) } })
    await tick()
    assert.match(page.body.innerHTML, /<fieldset disabled/)
    assert.match(page.body.innerHTML, /<\/form><div class="profile-actions">/)
    assert.match(page.body.innerHTML, /data-profile="clear"/)
    mounted.destroy()
  } finally { globalThis.document = originalDocument }
})

test('a corrupt profile without a snapshot can be explicitly cleared and recreated', async () => {
  const originalDocument = globalThis.document, originalConfirm = globalThis.confirm
  const page = profilePageDocument(), calls = []
  globalThis.document = page.document; globalThis.confirm = () => true
  try {
    const mounted = openUserProfile({ root: page.root, client: { userProfile: async () => { throw new ApiError('profile_storage_error') }, clearUserProfile: async body => { calls.push(body); return { version: 1, facts: {}, preferences: {} } } } })
    await tick()
    assert.match(page.body.innerHTML, /清空并重建画像/)
    page.root.listeners.click({ target: { closest() { return { dataset: { profile: 'clear' } } } } })
    await tick()
    assert.deepEqual(calls, [{}])
    assert.match(page.body.innerHTML, /data-profile-form/)
    mounted.destroy()
  } finally { globalThis.document = originalDocument; globalThis.confirm = originalConfirm }
})

test('student-number inference omits an empty admission fact and clears the transient input', async () => {
  const originalDocument = globalThis.document
  const page = profilePageDocument(), calls = []
  globalThis.document = page.document
  try {
    const mounted = openUserProfile({ root: page.root, client: {
      userProfile: async () => ({ version: 0, facts: {}, preferences: {} }),
      saveUserProfile: async body => {
        calls.push(body)
        return { version: 1, facts: { admissionYear: { value: 2025, confirmed: false, source: 'student_number' } }, preferences: {} }
      },
    } })
    await tick()
    page.student.value = '3250000000'
    page.root.listeners.submit({ target: { matches: () => true }, preventDefault() {} })
    await tick()
    assert.equal(calls[0].studentNumber, '3250000000')
    assert.equal(calls[0].facts.admissionYear, undefined)
    assert.equal(page.student.value, '')
    assert.match(page.body.innerHTML, /value="2025"/)
    mounted.destroy()
  } finally { globalThis.document = originalDocument }
})

test('missing, uncertain and failed recommendations preserve notices; only explicit suppression filters', () => {
  for (const value of [null, {}, { state: 'failed' }, { state: 'failed', decision: 'not_applicable', allowPush: false }, { decision: 'uncertain' }]) assert.equal(noticeKept({ recommendation: cleanRecommendation(value) }), true)
  assert.equal(noticeKept({ recommendation: cleanRecommendation(recommendation('not_applicable')) }), false)
  const original = [row('excluded', recommendation('not_applicable')), row('uncertain', recommendation('uncertain', 20)), row('recommended', recommendation('recommended', 80))]
  assert.deepEqual(orderRecommended(original).map(item => item.id), ['recommended', 'uncertain'])
  assert.equal(original.length, 3)
})

test('analysis delay delivers once after resolution or timeout and never replays historical notices', () => {
  const item = row('live', { deferPush: true, allowPush: true }, { receivedAt: 1000 })
  assert.deepEqual(deliveryTransition(undefined, item, 2000), { state: 'pending', deliver: false })
  assert.equal(noticePushable(item), false)
  const resolved = { ...item, recommendation: recommendation('uncertain') }
  assert.deepEqual(deliveryTransition('pending', resolved, 200000), { state: 'delivered', deliver: true })
  assert.deepEqual(deliveryTransition('delivered', resolved, 200001), { state: 'delivered', deliver: false })
  assert.deepEqual(deliveryTransition('pending', { ...resolved, recommendation: recommendation('not_applicable') }, 200000), { state: 'filtered', deliver: false })
  assert.deepEqual(deliveryTransition(undefined, resolved, 200000), { state: 'historical', deliver: false })
})

test('recommendation and delivery survive UI persistence but profile snapshots never enter store', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', row('notice', recommendation('not_applicable')))
  store.setNoticeDelivery('notice', 'pending')
  const saved = JSON.stringify(store.state)
  const restored = hydrate(saved)
  assert.equal(restored.notices.notice.recommendation.allowPush, false)
  assert.equal(restored.noticeDelivery.notice, 'pending')
  assert.equal(restored.userProfile, undefined)
  assert.equal(restored.profile.facts, undefined)
})

test('the live all-notice catalog retains old filtered rows while the warm browser cache stays bounded', async () => {
  let raw
  const storage = { getItem: () => raw, setItem(key, value) { raw = value } }
  const store = createStore(storage)
  for (let index = 0; index < 45; index++) store.upsertNotice('src-yunfeng', row(`n${index}`, recommendation(index === 0 ? 'not_applicable' : 'uncertain'), { publishedAt: index }))
  assert.equal(Object.keys(store.state.notices).length, 45)
  assert.equal(store.notice('n0').recommendation.allowPush, false)
  await new Promise(resolve => setTimeout(resolve, 240))
  assert.equal(Object.keys(JSON.parse(raw).notices).length, 40)
  assert.equal(Object.keys(store.state.notices).length, 45)
  const restarted = createStore(storage)
  assert.equal(Object.keys(restarted.state.notices).length, 40)
  // A metadata refresh rehydrates even rows whose revisions were already seen.
  for (const item of Object.values(store.state.notices)) restarted.upsertNotice('src-yunfeng', item)
  assert.equal(Object.keys(restarted.state.notices).length, 45)
  assert.equal(restarted.notice('n0').title, '通知 n0')
  assert.equal(restarted.notice('n0').recommendation.allowPush, false)
})

test('adapter passes recommendation metadata and treats homework independently', async () => {
  const values = await localAdapters({ notices: async () => ({ items: [{ ...row('n', recommendation('not_applicable')), publishedAt: '2026-10-20', analysis: { state: 'ready' } }] }) })[0].fetch()
  assert.equal(values[0].recommendation.allowPush, false)
  assert.deepEqual(values[0].recommendation.evidence, ['仅限研究生'])
  let calls = 0
  const invalid = localAdapters({ notices: async () => { calls += 1; return { items: [], nextOffset: 1 } } })[0]
  await assert.rejects(invalid.fetch(), /Invalid notice pagination/)
  assert.equal(calls, 2)
})

test('recommendation scope preserves the chosen sort and all view exposes excluded notices and reasons', () => {
  const store = createStore(null)
  store.upsertNotice('src-yunfeng', row('old', recommendation('recommended', 90), { publishedAt: 1 }))
  store.upsertNotice('src-yunfeng', row('new', recommendation('uncertain', 10), { publishedAt: 3 }))
  store.upsertNotice('src-yunfeng', row('excluded', recommendation('not_applicable'), { publishedAt: 2 }))
  const listeners = {}, list = { innerHTML: '', addEventListener(name, fn) { listeners[name] = fn } }, detail = { innerHTML: '', addEventListener() {} }
  const rail = createRail({ listRoot: list, detailRoot: detail, store, client: { notice: async () => ({}) } })
  rail.renderList()
  assert.doesNotMatch(list.innerHTML, /data-notice="excluded"/)
  assert.ok(list.innerHTML.indexOf('data-notice="old"') < list.innerHTML.indexOf('data-notice="new"'))
  listeners.click({ target: { closest(selector) { return selector === '[data-rail="recommendation-mode"]' ? { dataset: { mode: 'all' } } : null } } })
  assert.match(list.innerHTML, /data-notice="excluded"/)
  assert.ok(list.innerHTML.indexOf('data-notice="old"') < list.innerHTML.indexOf('data-notice="new"'))
  store.setNoticeSort('newest')
  assert.ok(list.innerHTML.indexOf('data-notice="new"') < list.innerHTML.indexOf('data-notice="old"'))
  rail.openNotice('excluded')
  assert.match(detail.innerHTML, /仅限研究生/)
  assert.match(detail.innerHTML, /仍然推荐/)
})

test('profile API writes use local CSRF endpoint with expected version and no browser persistence', async () => {
  const calls = []
  const client = createApiClient(async (path, options) => {
    calls.push([path, options])
    return { ok: true, json: async () => path === '/api/bootstrap' ? { csrfToken: 'local-test-token' } : { version: 1 } }
  })
  await client.userProfile()
  await client.saveUserProfile({ expectedVersion: 0, academy: 'lantian', preferences: { interests: ['志愿活动'], avoid: [] } })
  await client.clearUserProfile({ expectedVersion: 1 })
  await client.setRecommendationOverride('notice', 'keep')
  assert.deepEqual(calls.map(([path]) => path), ['/api/bootstrap', '/api/user-profile', '/api/user-profile', '/api/user-profile/reset', '/api/recommendations/override'])
  assert.equal(JSON.parse(calls[2][1].body).expectedVersion, 0)
  assert.equal(JSON.parse(calls[2][1].body).academy, 'lantian')
  assert.equal(calls[2][1].headers['X-PigeonPal-Token'], 'local-test-token')
})

test('profile action carries only version and local profile feedback stays out of model history', async () => {
  const state = { profile: { botName: '小浙', nickname: '同学' }, messages: { bot: [] }, reminders: [] }
  let body
  const chat = createAIChat({ chat: async value => { body = value; return { events: [{ type: 'action', name: 'user-profile.updated', args: { version: 3, facts: { major: 'should-not-copy' } } }, { type: 'message', text: '已记住', localOnly: true }] } } })
  const events = []
  for await (const event of chat.respond({ text: '关注志愿活动', state, channelId: 'bot', history: [] })) events.push(event)
  assert.deepEqual(events.find(event => event.type === 'action').args, { version: 3 })
  assert.deepEqual(body.profile, { botName: '小浙', nickname: '同学' })
  assert.deepEqual(buildChatHistory([{ role: 'bot', kind: 'text', text: '画像内容', localOnly: true }], state.profile), [])
})

test('feed rechecks pending unchanged revisions without duplicating ordinary new-item delivery', async () => {
  const seen = new Set(), incoming = [], revisited = []
  const stop = startFeed({ adapters: [{ id: 'test', channelId: 'src-yunfeng', fetch: async () => [row('one', { deferPush: true })] }], seen, onItem: (channel, item) => incoming.push(item.id), onSeenItem: (channel, item) => revisited.push(item.id), intervalMs: 60000 })
  await tick()
  await stop.refresh()
  stop()
  assert.deepEqual(incoming, ['one'])
  assert.deepEqual(revisited, ['one'])
  assert.deepEqual(preferenceLines('  志愿活动\n\n奖学金  '), ['志愿活动', '奖学金'])
  const tooMany = preferenceLines(Array.from({ length: 13 }, (_, index) => `偏好 ${index}`).join('\n'))
  assert.equal(tooMany.length, 13)
  assert.match(preferenceError(tooMany), /最多填写 12 条/)
  assert.match(preferenceError(['字'.repeat(121)]), /最多 120 字/)
  assert.equal(preferenceError(['字'.repeat(120)]), '')
})

test('student numbers are redacted before chat storage and while restoring legacy chat', async () => {
  const number = '3250999999'; let written
  let complete; const saved = new Promise(resolve => { complete = resolve })
  const store = createStore({ getItem: () => null, setItem: (_key, value) => { written = value; complete() } })
  const message = store.addMessage('bot', { role: 'user', text: `我的学号是${number}` })
  await saved
  assert.equal(message.text.includes(number), false)
  assert.equal(written.includes(number), false)
  const legacy = JSON.parse(written); legacy.messages.bot[0].text = `我的学号是${number}`
  assert.equal(JSON.stringify(hydrate(legacy)).includes(number), false)
})


test('successful profile reads recover academy filtering after startup failure without saving', async () => {
  const originalDocument = globalThis.document, page = profilePageDocument()
  const store = createStore(null), list = { innerHTML: '', addEventListener() {} }
  for (const source of ['yunfeng', 'danyang', 'lantian']) store.upsertNotice(`src-${source}`, row(source, null, { sourceId: source, real: false }))
  const rail = createRail({ listRoot: list, detailRoot: { innerHTML: '', addEventListener() {} }, store, client: {} })
  let available = false, saved = { version: 3, academy: 'danyang', facts: {}, preferences: {} }, mutations = 0
  const client = { userProfile: async () => {
    if (!available) throw new ApiError('service_unavailable')
    return saved
  } }
  const selection = createAcademySelection({ client, onChange: rail.setAcademy })
  assert.equal(await selection.refresh(), false)
  assert.equal(selection.academy, '')
  available = true
  globalThis.document = page.document
  let mounted
  try {
    mounted = openUserProfile({ root: page.root, client,
      onLoad: snapshot => selection.refresh(snapshot), onChange: () => { mutations++ } })
    await tick()
    assert.equal(selection.academy, 'danyang')
    assert.match(list.innerHTML, /data-notice="danyang"/)
    assert.doesNotMatch(list.innerHTML, /data-notice="yunfeng"/)
    saved = { ...saved, version: 4, academy: 'lantian' }
    page.root.listeners.click({ target: { closest: () => ({ dataset: { profile: 'reload' } }) } })
    await tick()
    assert.equal(selection.academy, 'lantian')
    assert.match(list.innerHTML, /data-notice="lantian"/)
    assert.doesNotMatch(list.innerHTML, /data-notice="danyang"/)
    assert.equal(mutations, 0, 'reads must not trigger the save/recommendation-refresh callback')
  } finally { mounted?.destroy(); globalThis.document = originalDocument }
})
