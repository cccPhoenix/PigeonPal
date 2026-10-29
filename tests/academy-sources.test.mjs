import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_CHANNELS, localAdapters } from '../web/js/services/sources.js'
import { createStore, hydrate } from '../web/js/store.js'
import { noticeChannels, selectNotices } from '../web/js/services/notice-list.js'

test('existing users gain the new academy channels alongside all prior sources', () => {
  const state = hydrate({ version: 1, channels: [{ id: 'src-yunfeng', notify: 'mute' }] })
  assert.equal(state.channels.find(channel => channel.id === 'src-yunfeng').notify, 'mute')
  assert.deepEqual(LOCAL_CHANNELS.map(channel => channel.sourceId).sort(), ['bksy', 'danyang', 'itc', 'lantian', 'qsxy', 'xzzd', 'yunfeng'])
  for (const id of ['danyang', 'lantian']) {
    const channel = state.channels.find(channel => channel.sourceId === id)
    assert.equal(channel.id, `src-${id}`)
    assert.equal(channel.requiresAuth, false)
    assert.ok(noticeChannels(state).some(channel => channel.sourceId === id))
  }
})

test('new academy adapters use paged notice API and preserve AI recommendations and raw notices', async () => {
  const store = createStore(null), requested = []
  const client = { notices: async (sourceId, offset) => {
    requested.push([sourceId, offset])
    return { items: [{
      id: `${sourceId}:${offset}`, sourceId, title: `${sourceId} 通知`, state: 'complete', revision: 'r1',
      publishedAt: '2026-10-29', firstSeenAt: '2026-10-29T10:00:00Z',
      url: `https://${sourceId === 'danyang' ? 'dqxy' : 'lantian'}.zju.edu.cn/1/page.htm`,
      recommendation: { state: 'ready', decision: 'not_applicable', allowPush: false, reason: '其他学园', priority: 0 },
    }], nextOffset: offset === 0 ? 1 : null }
  } }
  for (const sourceId of ['danyang', 'lantian']) {
    const adapter = localAdapters(client).find(candidate => candidate.channelId === `src-${sourceId}`)
    const items = await adapter.fetch()
    assert.equal(items.length, 2)
    assert.equal(items[0].sourceId, sourceId)
    assert.equal(items[0].real, true)
    assert.equal(items[0].recommendation.allowPush, false)
    for (const item of items) store.upsertNotice(adapter.channelId, item)
    assert.equal(selectNotices(store.state, { sourceId, mode: 'all' }).length, 2)
    assert.equal(selectNotices(store.state, { sourceId, mode: 'recommended' }).length, 0)
  }
  assert.deepEqual(requested, [['danyang', 0], ['danyang', 1], ['lantian', 0], ['lantian', 1]])
  const homework = localAdapters(client).find(adapter => adapter.channelId === 'src-xzzd')
  assert.equal(homework.snapshot, true)
})
