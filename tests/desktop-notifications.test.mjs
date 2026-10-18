import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { NotificationMonitor, defaults, allowedNow } = require('../desktop/notifications.cjs')
const now = Date.parse('2026-10-18T12:00:00+08:00')
function fixture(state = defaults()) {
  let saved = structuredClone(state)
  const sent = [], data = { sources: [{ id:'yunfeng', title:'云峰通知', state:'ready' }], items:[], reminders:[] }
  const monitor = new NotificationMonitor({ load:()=>structuredClone(saved), save:s=>{saved=structuredClone(s)}, now:()=>now,
    api:async path=>path==='/api/sources'?{sources:data.sources}:path==='/api/reminders'?{reminders:data.reminders}:{items:data.items,nextOffset:null},
    notify:async n=>{sent.push(n);return true} })
  return {monitor,sent,data,state:()=>saved}
}
test('source baseline waits for first successful sync and enrichment never re-notifies', async()=>{
  const f=fixture(); f.data.sources[0].state='running'; await f.monitor.poll()
  f.data.items=[{id:'yunfeng:1',title:'旧通知',revision:'pending'}]; f.data.sources[0].state='ready'; await f.monitor.poll()
  assert.equal(f.sent.length,0)
  f.data.items[0].revision='ready'; await f.monitor.poll(); assert.equal(f.sent.length,0)
  f.data.items.push({id:'yunfeng:2',title:'新通知'}); await f.monitor.poll(); await f.monitor.poll()
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].channelId,'src-yunfeng')
})
test('reminders catch up without the bounded event stream and stay deduped after restart', async()=>{
  const f=fixture(); f.data.reminders=[{id:'rem-1',title:'交作业',status:'pending',dueAt:now-120000,deliveredAt:now-61000,channelId:'bot'}]
  await f.monitor.poll(); assert.equal(f.sent.length,1)
  const second=fixture(f.state()); second.data.reminders=f.data.reminders
  await second.monitor.poll(); assert.equal(second.sent.length,0)
  second.data.reminders[0].deliveredAt=now; await second.monitor.poll(); assert.equal(second.sent.length,1)
})
test('quiet hours use Shanghai time, muted/cancelled reminders are consumed without later floods', async()=>{
  assert.equal(allowedNow({...defaults().preferences,quietStart:'23:00',quietEnd:'07:30'},'bot',Date.parse('2026-10-18T23:30:00+08:00')),false)
  const f=fixture(); f.monitor.preferences({enabled:false}); f.data.reminders=[{id:'r',title:'静音',status:'pending',dueAt:now-10,deliveredAt:now,channelId:'bot'}]
  await f.monitor.poll(); f.monitor.preferences({enabled:true}); await f.monitor.poll(); assert.equal(f.sent.length,0)
  f.data.reminders.push({id:'cancel',title:'取消',status:'cancelled',dueAt:now-10,deliveredAt:now,channelId:'bot'})
  await f.monitor.poll(); assert.equal(f.sent.length,0)
})
test('toast failure leaves reminders retryable and large backlogs use a single summary', async()=>{
  const f=fixture(); f.data.reminders=Array.from({length:2101},(_,i)=>({id:`r${i}`,title:'提醒',status:'pending',dueAt:now-1,deliveredAt:now,channelId:'bot'}))
  f.monitor.notify=async()=>false; await f.monitor.poll(); assert.equal(Object.keys(f.state().reminders).length,0)
  f.monitor.notify=async n=>{f.sent.push(n);return true}; await f.monitor.poll(); await f.monitor.poll()
  assert.equal(f.sent.length,1); assert.match(f.sent[0].body,/2101/)
})
test('offline errors do not consume a source baseline or lose arrived records',async()=>{
 const f=fixture(); f.monitor.api=async()=>{throw new Error('offline')}; await assert.rejects(f.monitor.poll())
 assert.deepEqual(f.state().sources,{})
})
test('a reminder cancelled while an earlier channel toast is queued is not delivered',async()=>{
 const f=fixture();f.data.reminders=[{id:'a',title:'first',status:'pending',dueAt:now-1,deliveredAt:now,channelId:'bot'},{id:'b',title:'cancelled',status:'pending',dueAt:now-1,deliveredAt:now,channelId:'src-yunfeng'}]
 f.monitor.notify=async message=>{f.sent.push(message);if(f.sent.length===1)f.data.reminders[1].status='cancelled';return true}
 await f.monitor.poll();assert.equal(f.sent.length,1)
})
test('notification baseline uses a complete source index rather than the bounded UI digest',async()=>{
 const f=fixture(),api=f.monitor.api,paths=[];f.monitor.api=async path=>{paths.push(path);return api(path)}
 await f.monitor.poll();assert.ok(paths.some(path=>path.startsWith('/api/notification-candidates?source=')))
})
