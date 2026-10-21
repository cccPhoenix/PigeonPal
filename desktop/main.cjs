const {app,BrowserWindow,Notification,Tray,Menu,ipcMain,protocol,session,shell,dialog,nativeImage}=require('electron')
const {join}=require('node:path')
const fs=require('node:fs')
const {startBackend}=require('./backend.cjs')
const {NotificationMonitor}=require('./notifications.cjs')
const {stateFile}=require('./state.cjs')
const {ORIGIN,localURL,externalURL,proxyURL,clipboardAllowed}=require('./navigation.cjs')
const {selfCheckSetup,runSelfCheck}=require('./self-check.cjs')
const selfCheck=selfCheckSetup(process.argv)
const startedAt=performance.now()
const APP_ID='cn.pigeonpal.desktop'
app.setName('PigeonPal')
const desktopPath=selfCheck?.userData||(!app.isPackaged&&process.env.PIGEONPAL_USER_DATA?process.env.PIGEONPAL_USER_DATA:join(app.getPath('appData'),'PigeonPal'))
fs.mkdirSync(desktopPath,{recursive:true})
app.setPath('userData',fs.realpathSync(desktopPath))
app.setPath('sessionData',fs.realpathSync(desktopPath))
app.setAppUserModelId(APP_ID)
protocol.registerSchemesAsPrivileged([{scheme:'pigeonpal',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}])
if(!app.requestSingleInstanceLock()) app.quit()
else {
  let win,tray,backend,monitor,timer,quitting=false,closed=false,ready=false,pendingChannel=null
  const root=join(__dirname,'..')
  const show=(channelId)=>{
    if(!win || win.isDestroyed()) return
    if(win.isMinimized()) win.restore()
    win.show();win.focus()
    if(channelId) {
      if(ready) win.webContents.send('desktop:open-channel',channelId)
      else pendingChannel=channelId
    }
  }
  const trusted=event=>win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&localURL(event.senderFrame.url)
  app.on('second-instance',()=>show())
  app.on('activate',()=>show())
  app.on('before-quit',event=>{
    if(closed) return
    event.preventDefault(); if(quitting) return
    quitting=true;clearInterval(timer)
    Promise.resolve(backend?.close()).finally(()=>{closed=true;app.quit()})
  })
  app.whenReady().then(async()=>{
    const userData=app.getPath('userData')
    backend=startBackend({packaged:app.isPackaged,resourcesPath:process.resourcesPath,root,userData,
      offline:Boolean(selfCheck)||process.argv.includes('--offline'),onExit:()=>{if(!quitting){dialog.showErrorBox('鸽友后台已停止','抓取和提醒当前已停止，请退出后重新打开鸽友。');app.quit()}}})
    const url=await backend.ready
    let token
    async function api(path,body) {
      if(!token) {const response=await fetch(url+'/api/bootstrap',{signal:AbortSignal.timeout(5000)});token=(await response.json()).csrfToken}
      const response=await fetch(url+path,{headers:{'X-PigeonPal-Token':token,...(body?{'Content-Type':'application/json',Origin:url}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)})
      if(!response.ok) throw new Error('local_service_unavailable')
      return response.json()
    }
    const desktopSession=session.fromPartition('persist:pigeonpal')
    desktopSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===win?.webContents&&clipboardAllowed(permission,details)))
    desktopSession.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===win?.webContents&&clipboardAllowed(permission,details))
    desktopSession.on('will-download',event=>event.preventDefault())
    desktopSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!localURL(details.url)&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:')&&!(details.url.startsWith('devtools:')&&!app.isPackaged)}))
    desktopSession.protocol.handle('pigeonpal',async request=>{
      if(!['GET','HEAD','POST'].includes(request.method)||!localURL(request.url)) return new Response('Forbidden',{status:403})
      const headers={}
      for(const key of ['content-type','x-pigeonpal-token']) if(request.headers.has(key)) headers[key]=request.headers.get(key)
      if(request.method==='POST') headers.Origin=url
      try {
        const response=await fetch(proxyURL(request.url,url),{method:request.method,headers,
          ...(request.method==='POST'?{body:await request.arrayBuffer()}:{}),redirect:'error',signal:AbortSignal.timeout(310000)})
        const outHeaders=new Headers(response.headers)
        outHeaders.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'")
        return new Response(await response.arrayBuffer(),{status:response.status,headers:outHeaders})
      } catch {return new Response('本地服务暂时不可用，请重新打开鸽友。',{status:503})}
    })
    const image=nativeImage.createFromPath(join(root,'web','assets','icon.png'))
    const windowIcon=process.platform==='win32'?nativeImage.createFromPath(join(root,'web','assets','icon-windows.png')):image
    win=new BrowserWindow({width:1240,height:820,minWidth:760,minHeight:540,title:'鸽友 PigeonPal',icon:windowIcon,show:false,autoHideMenuBar:true,
      webPreferences:{preload:join(__dirname,'preload.cjs'),session:desktopSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}})
    Menu.setApplicationMenu(null)
    win.on('close',event=>{if(!quitting){event.preventDefault();win.hide()}})
    win.webContents.on('will-navigate',(event,address)=>{if(!localURL(address)){event.preventDefault();const target=externalURL(address);if(target) shell.openExternal(target)}})
    win.webContents.on('will-frame-navigate',event=>{if(!localURL(event.url)) event.preventDefault()})
    win.webContents.on('will-redirect',(event,address)=>{if(!localURL(address)) event.preventDefault()})
    win.webContents.setWindowOpenHandler(({url:address})=>{const target=externalURL(address);if(target) shell.openExternal(target);return {action:'deny'}})
    win.webContents.on('did-start-loading',()=>{ready=false})
    win.once('ready-to-show',()=>show())
    tray=new Tray(image.resize({width:20,height:20}))
    tray.setToolTip('鸽友 · 关闭窗口后继续抓取与提醒')
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开鸽友',click:()=>show()},{type:'separator'},{label:'退出鸽友',click:()=>app.quit()}]))
    tray.on('double-click',()=>show())
    const notifications=new Set()
    const storage=stateFile(join(userData,'desktop-notifications.json'))
    monitor=new NotificationMonitor({...storage,api,notify:async message=>{
      if(!Notification.isSupported()) return false
      return new Promise(resolve=>{
        const notification=new Notification({title:message.title,body:message.body,icon:image,silent:false})
        notifications.add(notification)
        const timeout=setTimeout(()=>finish(false),7000)
        let done=false
        function finish(ok){if(done)return;done=true;clearTimeout(timeout);resolve(ok)}
        notification.once('show',()=>finish(true))
        notification.once('failed',()=>{notifications.delete(notification);finish(false)})
        notification.once('close',()=>notifications.delete(notification))
        notification.once('click',()=>{show(message.channelId);notifications.delete(notification)})
        try{notification.show()}catch{finish(false)}
      })
    }})
    ipcMain.handle('desktop:preferences',(event,value)=>{if(!trusted(event)) throw new Error('invalid_sender');return monitor.preferences(value)})
    ipcMain.handle('desktop:notification-status',event=>{if(!trusted(event)) throw new Error('invalid_sender');return {supported:Notification.isSupported(),enabled:monitor.state.preferences.enabled}})
    ipcMain.on('desktop:renderer-ready',event=>{if(trusted(event)){ready=true;if(pendingChannel){win.webContents.send('desktop:open-channel',pendingChannel);pendingChannel=null}}})
    await win.loadURL(ORIGIN+'/index.html')
    const poll=()=>monitor.poll().catch(()=>{})
    await poll();timer=setInterval(poll,5000)
    if(selfCheck && !process.argv.includes('--self-check-hold')) {
      let report,code=0
      const errors=[]
      win.webContents.on('render-process-gone',()=>errors.push('renderer_process_gone'))
      try {report={ok:true,...await runSelfCheck({win,api,monitor,show,startedAt,isReady:()=>ready})};if(errors.length)throw new Error(errors[0])}
      catch(error){code=1;report={ok:false,error:String(error.message).slice(0,200)}}
      quitting=true;clearInterval(timer);await backend.close();closed=true
      fs.writeFileSync(selfCheck.report,JSON.stringify({...report,version:app.getVersion(),platform:process.platform,temporaryDataDir:selfCheck.userData}))
      app.exit(code)
    }
  }).catch(error=>{if(selfCheck){fs.writeFileSync(selfCheck.report,JSON.stringify({ok:false,error:'desktop_start_failed',version:app.getVersion(),temporaryDataDir:selfCheck.userData}));app.exit(1);return}dialog.showErrorBox('鸽友无法启动','请确认没有另一个鸽友在运行，并检查用户数据目录是否可写。');app.quit()})
}
