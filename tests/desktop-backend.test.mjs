import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
const require=createRequire(import.meta.url)
const {startBackend}=require('../desktop/backend.cjs')
test('desktop launcher owns the random-port backend and graceful close releases it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pigeonpal-launch-'))
 const service=startBackend({packaged:false,root:resolve('.'),userData:dir,offline:true})
 try {const url=await service.ready;assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);const response=await fetch(url+'/index.html');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html\b/);assert.match(await response.text(),/PigeonPal/)}finally{await service.close();rmSync(dir,{recursive:true})}
})
test('parallel desktop module fetches do not stall at the server listen backlog',async()=>{
 const {readdirSync}=require('node:fs')
 const files=readdirSync('web/js',{recursive:true}).filter(name=>name.endsWith('.js')).slice(0,40)
 const dir=mkdtempSync(join(tmpdir(),'pigeonpal-assets-'))
 const service=startBackend({packaged:false,root:resolve('.'),userData:dir,offline:true})
 try {const url=await service.ready;await Promise.all(files.map(async file=>{const response=await fetch(url+'/js/'+file.replaceAll('\\','/'),{signal:AbortSignal.timeout(4000)});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/javascript\b/);await response.arrayBuffer()}))}finally{await service.close();rmSync(dir,{recursive:true})}
})
test('a missing backend executable closes promptly after startup fails',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pigeonpal-missing-backend-'))
 const service=startBackend({packaged:true,resourcesPath:dir,root:resolve('.'),userData:dir,offline:true})
 try {
  await assert.rejects(service.ready,/backend_start_failed/)
  const started=performance.now()
  await service.close()
  assert.ok(performance.now()-started<1000,'failed spawn must not wait for the shutdown timeout')
 } finally {rmSync(dir,{recursive:true})}
})
