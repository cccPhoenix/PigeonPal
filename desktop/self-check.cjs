// Explicit, offline acceptance mode. It can never select an existing user directory.
const fs=require('node:fs')
const {join}=require('node:path')
const {tmpdir}=require('node:os')
const assert=require('node:assert/strict')
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function selfCheckSetup(argv) {
  if(!argv.includes('--self-check')) return null
  return {userData:fs.mkdtempSync(join(tmpdir(),`pigeonpal-self-check-${process.pid}-`)),
    report:join(tmpdir(),`pigeonpal-self-check-${process.pid}.json`)}
}
async function runSelfCheck({win,api,monitor,show,startedAt,isReady}) {
  const until=async predicate=>{
    const deadline=Date.now()+12000
    do {if(await predicate()) return;await delay(100)} while(Date.now()<deadline)
    throw new Error('self_check_timeout')
  }
  const js=source=>win.webContents.executeJavaScript(source)
  await until(()=>isReady())
  await until(()=>js("Boolean(document.querySelector('#dock textarea') && document.querySelector('[data-view=calendar]'))"))
  const startupMs=Math.round(performance.now()-startedAt)
  assert.equal((await api('/api/auth/status')).bound,false)
  assert.equal((await api('/api/reminders')).reminders.length,0)
  assert.equal((await api('/api/ai/settings')).configured,false)
  await js("document.querySelector('[data-view=me]').click();document.querySelector('[data-go=updates]').click()")
  await until(()=>js("Boolean(document.querySelector('[data-update=automatic]'))"))
  assert.equal(await js("document.querySelector('[data-update=check]').disabled"),true)
  const updateStatus=await js("window.pigeonpalDesktop.updateStatus()")
  assert.equal(await js("document.querySelector('.update-version strong').textContent"),'v'+updateStatus.currentVersion)
  await js("document.querySelector('[data-update=automatic]').click()")
  await until(()=>js("document.querySelector('[data-update=automatic]').getAttribute('aria-checked')==='false'"))
  await js("document.querySelector('[data-set=close]').click()")
  const initial=await api('/api/user-profile')
  assert.equal(initial.version,0)
  // System notification presentation is intentionally excluded from unattended checks.
  monitor.preferences({enabled:false})
  await js("document.querySelector('[data-view=user-profile]').click()")
  await until(()=>js("Boolean(document.querySelector('#user-profile-form'))"))
  await js("document.querySelector('#up-academy').click()")
  await until(()=>js("Boolean(document.querySelector('[data-academy-option=\"danyang\"]'))"))
  await js("document.querySelector('[data-academy-option=\"danyang\"]').click()")
  await js(`document.querySelector('#up-degree').value='undergraduate';
    document.querySelector('[data-confirm=degree]').checked=true;
    document.querySelector('#user-profile-form').requestSubmit()`)
  await until(async()=>{const profile=await api('/api/user-profile');return profile.facts.degree.value==='undergraduate'&&profile.academy==='danyang'})
  await js("document.querySelector('[data-view=notice]').click()")
  await until(()=>js(`Boolean(document.querySelector('[data-rail="filter"][data-src="danyang"]'))
    && !document.querySelector('[data-rail="filter"][data-src="yunfeng"]')
    && !document.querySelector('[data-rail="filter"][data-src="lantian"]')
    && Boolean(document.querySelector('[data-rail="filter"][data-src="itc"]'))
    && Boolean(document.querySelector('[data-rail="filter"][data-src="qsxy"]'))
    && Boolean(document.querySelector('[data-rail="filter"][data-src="bksy"]'))`))
  await js(`document.querySelector('[data-view=calendar]').click();
    document.querySelector('.calendar-day.today [data-calendar-day]').click();
    document.querySelector('#calendar-new-title').value='安装验收日历';
    document.querySelector('[data-x=ok]').click()`)
  await until(()=>js(`Object.values(JSON.parse(localStorage.getItem('pigeonpal.v1')||'{}').calendarItems||{}).some(item=>item.title==='安装验收日历')`))
  await js(`document.querySelector('[data-cmp=plus]').click();document.querySelector('[data-x=reminder]').click();
    document.querySelector('[data-f=title]').value='安装验收提醒';document.querySelector('[data-x=ok]').click()`)
  await until(async()=>(await api('/api/reminders')).reminders.length===1)
  const reminder=(await api('/api/reminders')).reminders[0]
  await api('/api/reminders/update',{id:reminder.id,patch:{dueAt:Date.now()+1200}})
  win.close()
  assert.equal(win.isDestroyed(),false)
  assert.equal(win.isVisible(),false)
  await until(async()=>(await api('/api/events?after=0')).events.some(event=>event.reminderId===reminder.id))
  show()
  assert.equal(win.isVisible(),true)
  await until(()=>js("Boolean(localStorage.getItem('pigeonpal.v1'))"))
  await new Promise((resolve,reject)=>{
    win.webContents.once('did-finish-load',resolve);win.webContents.once('did-fail-load',reject);win.reload()
  })
  await until(()=>isReady())
  await until(()=>js("Boolean(document.querySelector('[data-view=user-profile]'))"))
  assert.equal(await js("window.pigeonpalDesktop.updateStatus().then(value=>value.automaticCheck)"),false)
  await js("document.querySelector('[data-view=user-profile]').click()")
  await until(()=>js("document.querySelector('#up-degree')?.value === 'undergraduate'"))
  await until(()=>js("document.querySelector('[data-academy]')?.value === 'danyang'"))
  const frames=await js(`(async()=>{
    const times=[];
    for(const view of ['notice','calendar','homework','user-profile','notice','calendar','notice']) {
      const start=performance.now();document.querySelector('[data-view="'+view+'"]').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(document.querySelector('#notice').dataset.view!==view)throw new Error('view_not_active:'+view);
      if(document.querySelector('#dock-nav [data-view="'+view+'"]').getAttribute('aria-current')!=='page')throw new Error('view_not_selected:'+view);
      const selectors={notice:'.rail-chips',calendar:'.calendar-day.today',homework:'.homework-filter', 'user-profile':'#user-profile-form'};
      const pane=document.querySelector(view==='calendar'?'#pane-calendar':view==='user-profile'?'#pane-user-profile':'#pane-list');
      if(pane.hidden||!pane.querySelector(selectors[view]))throw new Error('view_content_missing:'+view);
      if(view==='calendar'&&!pane.textContent.includes('安装验收日历'))throw new Error('calendar_reload_missing');
      times.push(performance.now()-start);
    }
    return times;
  })()`)
  assert.equal((await api('/api/reminders')).reminders[0].id,reminder.id)
  assert.equal(await js("typeof window.require"),'undefined')
  // Exercise the DOM work that grows with a returning student's cached data,
  // separately from the empty-install acceptance flow above.
  const rendering=await js(`(async()=>{
    const [{createStore},{createIconRail},{createRail},{createCalendar},{connectViewRefresh}]=await Promise.all([
      import('./js/store.js'),import('./js/ui/dock.js'),import('./js/ui/rail.js'),
      import('./js/ui/calendar.js'),import('./js/ui/view-refresh.js')]);
    const host=document.createElement('section');
    host.style.cssText='position:fixed;left:-10000px;top:0;width:1200px';
    host.innerHTML='<nav></nav><main><aside></aside><article></article></main><footer></footer>';
    document.body.append(host);
    try {
      const store=createStore(null),dockRoot=host.querySelector('nav'),listRoot=host.querySelector('aside');
      const calendarRoot=host.querySelector('footer'),frames=[];
      const dock=createIconRail({root:dockRoot,store});dock.render();
      const companion=dockRoot.querySelector('.mk');
      const rail=createRail({listRoot,detailRoot:host.querySelector('article'),store,client:{}});
      const calendar=createCalendar({root:calendarRoot,store});
      const syncBadges=()=>{dock.setUnread(0);dock.setChatUnread(0);dock.setHomeworkUnread(0)};
      connectViewRefresh({store,rail,calendar,syncBadges,getView:()=> 'notice',getActive:()=> 'bot',
        transcript:{patch(){},render(){},syncHomeworkSnapshot(){}},requestFrame:callback=>frames.push(callback)});
      const start=performance.now();
      for(let i=0;i<100;i++){
        syncBadges();store.upsertNotice('src-yunfeng',{id:'perf'+i,noticeId:'perf'+i,sourceId:'yunfeng',
          title:'离线性能验收 '+i,revision:'r1',publishedAt:Date.now()-i*60000,analysisState:'ready',summary:'测试通知'});
      }
      store.syncReminders(Array.from({length:55},(_,i)=>({id:'perf-r'+i,title:'测试提醒',dueAt:Date.now()+86400000+i,status:'pending'})));
      if(frames.length!==1)throw new Error('bulk_render_not_coalesced');
      let listRenders=0;
      const observer=new MutationObserver(records=>{listRenders+=records.filter(row=>row.target===listRoot).length});
      observer.observe(listRoot,{childList:true});
      frames.shift()();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      observer.disconnect();
      if(dockRoot.querySelector('.mk')!==companion)throw new Error('companion_replaced_by_poll');
      if(calendarRoot.childElementCount!==0)throw new Error('hidden_calendar_rebuilt');
      if(listRenders!==1)throw new Error('notice_list_rebuilt_per_row');
      if(!listRoot.textContent.includes('离线性能验收'))throw new Error('notice_list_missing');
      return {noticeCount:100,reminderCount:55,listRenders,hiddenCalendarRenders:0,
        companionPreserved:true,batchMs:Math.round(performance.now()-start)};
    } finally {host.remove()}
  })()`)
  return {startupMs,viewSwitchMs:frames.map(Math.round),
    rendering,
    checks:['empty-profile-and-account','renderer-bootstrap','profile-form-save','academy-dropdown-save','academy-source-filter','reminder-form-save',
      'offline-reminder-while-window-hidden','reopen','calendar-form-save','reload-persistence','view-navigation','context-isolation','update-settings',
      'bulk-notice-reminder-render','stable-companion-on-poll','hidden-calendar-deferred'],
    nativeNotificationSupported:await js('window.pigeonpalDesktop.notificationStatus().then(value=>value.supported)')}
}
module.exports={selfCheckSetup,runSelfCheck}
