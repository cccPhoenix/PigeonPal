import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIChat, buildChatHistory } from '../web/js/services/chat.js'
import { createStore, hydrate } from '../web/js/store.js'
import { isHomeworkCard } from '../web/js/services/homework.js'

const item = { id:'xzzd:12',noticeId:'xzzd:12',sourceId:'xzzd',kind:'homework',real:true,title:'独立卡片测试',url:'https://courses.zju.edu.cn/course/3/learning-activity#/12',
 homework:{activityId:'12',courseId:'3',courseName:'测试课程',courseCode:'(2026-2027-1)-TEST',deadlineAt:'2026-10-25T20:00:00+08:00',submissionStatus:'not_submitted',isClosed:false} }

test('chat decoder keeps a structured card with course, deadline and actions metadata',async()=>{
 const store=createStore(null)
 const chat=createAIChat({chat:async()=>({events:[{type:'message',text:'找到1条',localOnly:true},
  {type:'message',text:'作业信息',kind:'notice',queryResult:true,localOnly:true,item}]})})
 const events=[]
 for await(const e of chat.respond({text:'列出作业一条',channelId:'bot',state:store.state,history:[]}))events.push(e)
 const message=events.find(e=>e.queryResult)
 assert.ok(message)
 assert.equal(message.kind,'notice')
 assert.equal(message.item.homework.activityId,'12')
 assert.equal(message.localOnly,true)
})

test('each explicit result remains a separate card after refresh and default snapshots',()=>{
 const store=createStore(null)
 const result=store.addMessage('src-xzzd',{kind:'notice',queryResult:true,localOnly:true,role:'bot',text:'作业信息',item})
 assert.equal(isHomeworkCard(result),false)
 store.syncHomeworkSnapshot([])
 assert.equal(store.state.messages['src-xzzd'].length,1)
 const restored=hydrate(store.state)
 assert.equal(restored.messages['src-xzzd'][0].queryResult,true)
 assert.deepEqual(buildChatHistory(restored.messages['src-xzzd'],restored.profile),[])
})
