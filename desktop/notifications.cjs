// Native delivery is independent of renderer timers. Only IDs and preferences persist.
const defaults = () => ({ version:1, preferences:{ enabled:true, proactive:true, botName:'小浙', nickname:'同学', quietStart:'23:00', quietEnd:'07:30', muted:[] }, sources:{}, reminders:{} })
const sourceIds = new Set(['yunfeng','danyang','lantian','itc','qsxy','bksy','xzzd'])
function cleanPreferences(p, before=defaults().preferences) {
  const out={...before}
  for(const k of ['enabled','proactive']) if(typeof p?.[k]==='boolean') out[k]=p[k]
  for(const k of ['botName','nickname']) if(typeof p?.[k]==='string') out[k]=Array.from(p[k]).slice(0,12).join('')
  for(const k of ['quietStart','quietEnd']) if(/^([01]\d|2[0-3]):[0-5]\d$/.test(p?.[k]??'')) out[k]=p[k]
  if(Array.isArray(p?.muted)) out.muted=p.muted.filter(v=>typeof v==='string' && /^src-[\w-]{1,48}$/.test(v)).slice(0,100)
  return out
}
function allowedNow(p, channelId, now) {
  if(!p.enabled || !p.proactive || p.muted.includes(channelId)) return false
  const clock=new Date(now+8*3600000).toISOString().slice(11,16)
  const {quietStart:a,quietEnd:b}=p
  return a===b || !(a<b ? clock>=a&&clock<b : clock>=a||clock<b)
}
class NotificationMonitor {
  constructor({load,save,api,notify,now=Date.now}) {
    const raw=load(); this.state=raw?.version===1&&raw.sources&&raw.reminders?raw:defaults()
    this.state.preferences=cleanPreferences(raw?.preferences)
    this.save=save; this.api=api; this.notify=notify; this.now=now; this.polling=false
  }
  preferences(patch) {
    const next={...this.state, preferences:cleanPreferences(patch,this.state.preferences)}
    this.save(next); this.state=next
    return {...next.preferences}
  }
  commit(next) { next.preferences=this.state.preferences; this.save(next); this.state=next }
  async send(rows, title, channelId, refresh=null, consumed=new Set()) {
    if(!rows.length) return true
    const groups=rows.length>3?[rows]:rows.map(row=>[row])
    for(let group of groups) {
      if(refresh) group=await refresh(group)
      if(!group.length) continue
      if(!allowedNow(this.state.preferences,channelId,this.now())) { for(const row of group) consumed.add(row.id); continue }
      const chunks=group.length>3?[group]:group.map(row=>[row])
      for(const chunk of chunks) {
        const body=chunk.length>3?`有 ${chunk.length} 条新消息，点击打开鸽友查看。`:Array.from(chunk[0].title||'有一条新消息').slice(0,160).join('')
        if(!await this.notify({title,channelId,body})) return false
        for(const row of chunk) consumed.add(row.id)
      }
    }
    return true
  }
  async poll() {
    if(this.polling) return
    this.polling=true
    try {
      // Reminders are retained in runtime-state, unlike its bounded event log.
      // deliveredAt also distinguishes snoozes. Completed/cancelled are never toasted.
      const {reminders}=await this.api('/api/reminders')
      if(!Array.isArray(reminders)) throw new Error('invalid_reminders')
      const next=structuredClone(this.state), groups=new Map()
      for(const r of reminders) {
        if(typeof r.id!=='string' || !Number.isFinite(r.deliveredAt) || r.status!=='pending' || r.notifyEligible===false || next.reminders[r.id]===r.deliveredAt) continue
        const channelId=/^(bot|src-[\w-]{1,48})$/.test(r.channelId)?r.channelId:'bot'
        if(!groups.has(channelId)) groups.set(channelId,[])
        groups.get(channelId).push(r)
      }
      for(const [channelId,rows] of groups) {
        const consumed=new Set()
        try { await this.send(rows,`${this.state.preferences.botName} · 提醒到时间了`,channelId,async queued=>{
          const fresh=(await this.api('/api/reminders')).reminders
          return queued.filter(old=>fresh.some(r=>r.id===old.id&&r.status==='pending'&&r.notifyEligible!==false&&r.deliveredAt===old.deliveredAt))
        },consumed) } finally {
          for(const r of rows) if(consumed.has(r.id)) next.reminders[r.id]=r.deliveredAt
          this.commit(next)
        }
      }
      const {sources}=await this.api('/api/sources')
      for(const source of sources??[]) {
        if(!sourceIds.has(source.id) || !['ready','partial'].includes(source.state)) continue
        try {
          const items=[], offsets=new Set(); let offset=0
          do {
            if(offsets.has(offset)) throw new Error('invalid_pagination')
            offsets.add(offset)
            const page=await this.api(`/api/notification-candidates?source=${source.id}&offset=${offset}`)
            if(!Array.isArray(page.items)) throw new Error('invalid_notices')
            items.push(...page.items); offset=page.nextOffset
          } while(Number.isSafeInteger(offset)&&offset>0)
          const next=structuredClone(this.state), before=next.sources[source.id]
          const ids=items.filter(row=>typeof row.id==='string'&&row.id.startsWith(source.id+':'))
          // Per-source first successful snapshot, not an empty pre-login response.
          if(!before) {
            next.sources[source.id]=Object.fromEntries(ids.map(row=>[row.id,true]))
            this.commit(next)
          }
          else {
            const fresh=ids.filter(row=>!before[row.id])
            const consumed=new Set(fresh.filter(row=>row.notifyEligible===false&&!row.deferPush).map(row=>row.id))
            try { await this.send(fresh.filter(row=>row.notifyEligible!==false&&!row.deferPush),source.title||'校园新通知',`src-${source.id}`,async queued=>{
              const eligible=new Set(); let nextOffset=0
              do {
                const page=await this.api(`/api/notification-candidates?source=${source.id}&offset=${nextOffset}`)
                for(const item of page.items??[]) {
                  if(item.notifyEligible!==false&&!item.deferPush) eligible.add(item.id)
                  else if(!item.deferPush) consumed.add(item.id)
                }
                nextOffset=page.nextOffset
              } while(Number.isSafeInteger(nextOffset)&&nextOffset>0)
              return queued.filter(row=>eligible.has(row.id))
            },consumed) } finally {
              for(const row of fresh) if(consumed.has(row.id)) before[row.id]=true
              this.commit(next)
            }
          }
        } catch { /* One inaccessible source must not block others or reminders. */ }
      }
    } finally { this.polling=false }
  }
}
module.exports={NotificationMonitor,defaults,allowedNow,cleanPreferences}
