import test from 'node:test'
import assert from 'node:assert/strict'
import {createStore} from '../web/js/store.js'
import {connectDesktop} from '../web/js/services/desktop.js'
test('channel mute changes are immediately synchronized to the desktop owner', async()=>{
 const sent=[];globalThis.pigeonpalDesktop={preferences:async p=>{sent.push(p)},notificationStatus:async()=>({enabled:true}),onOpenChannel:()=>{}}
 try {const store=createStore(null);connectDesktop(store,()=>{});store.setChannel('src-yunfeng',{notify:'mute'});assert.equal(sent.length,2);assert.deepEqual(sent[1].muted,['src-yunfeng'])}finally{delete globalThis.pigeonpalDesktop}
})
