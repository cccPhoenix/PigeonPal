import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const require=createRequire(import.meta.url)
const {localURL,externalURL,proxyURL}=require('../desktop/navigation.cjs')
const {stateFile}=require('../desktop/state.cjs')
test('stable desktop origin proxies only to the owned backend, external navigation is scheme restricted',()=>{
 assert.equal(localURL('pigeonpal://app/index.html'),true)
 for(const url of ['https://app/','pigeonpal://evil/','pigeonpal://user@app/','file:///etc/passwd']) assert.equal(localURL(url),false)
 assert.equal(proxyURL('pigeonpal://app/api/sources','http://127.0.0.1:12345'),'http://127.0.0.1:12345/api/sources')
 for(const url of ['javascript:alert(1)','file:///a','data:text/html,hi','https://user:secret@example.com']) assert.equal(externalURL(url),null)
})
test('desktop preferences and dedupe state survive atomic restart without depending on backend port',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pigeonpal-state-'))
 try {const storage=stateFile(join(dir,'desktop.json'));assert.equal(storage.load(),null);storage.save({test:1});assert.deepEqual(stateFile(join(dir,'desktop.json')).load(),{test:1});storage.save({test:2});assert.deepEqual(storage.load(),{test:2})}finally{rmSync(dir,{recursive:true})}
})
test('only trusted main-frame sanitized clipboard writes are granted',()=>{
 const {clipboardAllowed}=require('../desktop/navigation.cjs')
 assert.equal(clipboardAllowed('clipboard-sanitized-write',{isMainFrame:true,requestingUrl:'pigeonpal://app/index.html'}),true)
 assert.equal(clipboardAllowed('clipboard-read',{isMainFrame:true,requestingUrl:'pigeonpal://app/index.html'}),false)
 assert.equal(clipboardAllowed('clipboard-sanitized-write',{isMainFrame:false,requestingUrl:'pigeonpal://app/index.html'}),false)
 assert.equal(clipboardAllowed('clipboard-sanitized-write',{isMainFrame:true,requestingUrl:'https://evil.example/'}),false)
})
