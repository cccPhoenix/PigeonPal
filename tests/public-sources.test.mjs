import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_CHANNELS, localAdapters, noticeCopy } from '../web/js/services/sources.js'
import { createInitialState, hydrate } from '../web/js/store.js'

test('new public sources appear when upgrading an existing two-source UI', () => {
  const old = createInitialState()
  old.channels = old.channels.filter(channel => !['qsxy', 'bksy'].includes(channel.sourceId))
  old.channels.find(channel => channel.id === 'src-itc').notify = 'mute'
  const upgraded = hydrate(JSON.stringify(old))
  for (const sourceId of ['qsxy', 'bksy']) {
    const channel = upgraded.channels.find(channel => channel.sourceId === sourceId)
    assert.ok(channel, `${sourceId} is available in the sidebar`)
    assert.equal(channel.requiresAuth, false)
    assert.equal(channel.pending, undefined)
    assert.deepEqual(upgraded.messages[channel.id], [])
  }
  assert.equal(upgraded.channels.find(channel => channel.id === 'src-itc').notify, 'mute')
  assert.equal(LOCAL_CHANNELS.find(channel => channel.sourceId === 'qsxy').url, 'http://qsxy.zju.edu.cn/30845/list.psp')
  assert.equal(LOCAL_CHANNELS.find(channel => channel.sourceId === 'bksy').url, 'https://bksy.zju.edu.cn/28418/list.htm')
})

test('source adapters keep paginated public notices and explain metadata-only links', async () => {
  const requested = []
  const row = (id, state = 'complete', qualityFlags = []) => ({
    id: `bksy:${id}`, sourceId: 'bksy', title: `通知 ${id}`, url: `https://bksy.zju.edu.cn/${id}/page.htm`,
    publishedAt: '2026-10-15', version: 1, revision: `${id}:1`, state, qualityFlags,
    fetchable: state !== 'skipped',
  })
  const client = { async notices(sourceId, offset) {
    requested.push([sourceId, offset])
    return offset === 0
      ? { items: [row('article')], nextOffset: 1 }
      : { items: [row('crosssite', 'skipped', ['external_link']), row('file', 'skipped', ['attachment_only'])], nextOffset: null }
  } }
  const adapter = localAdapters(client).find(candidate => candidate.channelId === 'src-bksy')
  const notices = await adapter.fetch()
  assert.deepEqual(requested, [['bksy', 0], ['bksy', 1]])
  assert.equal(notices.length, 3)
  assert.match(noticeCopy(notices[1]), /其他网站.*正文未采集/)
  assert.match(noticeCopy(notices[2]), /附件未下载/)
  assert.equal(notices[1].eventAt, null)
  assert.equal(notices[1].summary.includes('通知 crosssite'), false)
})
