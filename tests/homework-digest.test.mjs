import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, hydrate, createInitialState } from '../web/js/store.js'
import { defaultHomeworkMessages } from '../web/js/services/homework.js'
import { buildChatHistory, createAIChat } from '../web/js/services/chat.js'
const NOW=Date.parse('2026-10-18T12:00:00+08:00')
const item=(id,day,opened=1,status='not_submitted',term='2026-2027-1')=>({id:`xzzd:${id}`,noticeId:`xzzd:${id}`,sourceId:'xzzd',kind:'homework',real:true,title:`练习${id}`,publishedAt:NOW,revision:'1',homework:{activityId:String(id),courseId:'1',courseName:'测试课',courseCode:`(${term})-TEST`,openAt:`2026-10-${String(opened).padStart(2,'0')}T08:00:00+08:00`,deadlineAt:`2026-10-${day}T20:00:00+08:00`,submissionStatus:status,isClosed:false}})
const card=i=>({id:i.id,kind:'notice',role:'bot',channelId:'src-xzzd',text:'作业',item:i,at:NOW})
const rows=()=>[...Array.from({length:5},(_,i)=>item(i+1,26+i,11+i)),item(10,18),item(11,19),item(12,20),item(20,30,1,'submitted'),item(21,30,1,'not_submitted','2025-2026-2')]
test('old cache shrinks to 5+3 current cards in ascending order while preserving chat',()=>{
 const messages=[...rows().map(card),{id:'chat',kind:'text',role:'user',text:'我的问题',channelId:'src-xzzd',at:NOW}]
 const selected=defaultHomeworkMessages(messages,NOW)
 assert.deepEqual(selected.filter(m=>m.kind==='notice').map(m=>m.id),['xzzd:10','xzzd:11','xzzd:12','xzzd:1','xzzd:2','xzzd:3','xzzd:4','xzzd:5'])
 assert.equal(selected.at(-1).id,'chat')
 const raw=createInitialState();raw.messages['src-xzzd']=messages
 const old=Date.now;Date.now=()=>NOW
 try {assert.equal(hydrate(raw).messages['src-xzzd'].filter(m=>m.kind==='notice').length,8)} finally {Date.now=old}
})
test('snapshots replace ordinary cards, preserve reminders, and do not accumulate on polling',()=>{
 const store=createStore(null);store.addMessage('src-xzzd',{id:'user',kind:'text',role:'user',text:'你好'})
 store.addMessage('src-xzzd',{id:'event',kind:'reminder',role:'bot',text:'六小时提醒',item:item(10,18)})
 store.syncHomeworkSnapshot(rows(),{now:NOW})
 store.syncHomeworkSnapshot(rows(),{now:NOW})
 assert.equal(store.state.messages['src-xzzd'].filter(m=>m.kind==='notice').length,8)
 store.syncHomeworkSnapshot([item(1,26)],{now:NOW})
 assert.deepEqual(store.state.messages['src-xzzd'].map(m=>m.id),['xzzd:1','user','event'])
})
test('local query response remains private across reload and quotes',async()=>{
 const state=createInitialState();state.messages.bot=[{id:'local',role:'bot',kind:'text',localOnly:true,text:'私人作业清单',at:NOW}]
 assert.deepEqual(buildChatHistory(hydrate(state).messages.bot,state.profile),[])
 const calls=[];const service=createAIChat({chat:async body=>{calls.push(body);return{events:[{type:'message',text:'本地回答',localOnly:true}]}}})
 const events=[];for await(const e of service.respond({text:'看看这条',channelId:'bot',state,requestId:'query1',quoteId:'local',history:[]}))events.push(e)
 assert.equal(calls[0].quotedText,undefined)
 assert.equal(events.find(e=>e.type==='message').localOnly,true)
})

test('frontend cache migration matches the backend selection contract',async()=>{
 const {readFile}=await import('node:fs/promises')
 const cases=JSON.parse(await readFile(new URL('./homework-selection-fixtures.json',import.meta.url),'utf8'))
 for(const c of cases){
  const messages=c.rows.map(row=>card({...row,noticeId:row.id,kind:'homework',real:true,publishedAt:Date.parse(row.firstSeenAt)}))
  assert.deepEqual(defaultHomeworkMessages(messages,c.now*1000).map(m=>m.item.noticeId),c.expected,c.name)
 }
})
