const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
function startBackend({ packaged, resourcesPath, root, userData, offline=false, onExit=()=>{} }) {
  const command=packaged?join(resourcesPath,'backend','PigeonPalService',process.platform==='win32'?'PigeonPalService.exe':'PigeonPalService'):(process.env.PIGEONPAL_PYTHON||'python')
  const args=[...(packaged?[]:[join(root,'scripts','desktop_service.py')]),'--data-dir',join(userData,'data'),'--auth-dir',join(userData,'auth'),...(offline?['--offline']:[])]
  const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,cwd:packaged?resourcesPath:root,env:{...process.env,PYTHONUNBUFFERED:'1'}})
  let settled=false, closing=false, stopped=false
  const closed=new Promise(resolve=>child.once('exit',()=>{stopped=true;resolve()}))
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>fail('backend_start_timeout'),30000)
    function fail(code) {if(!settled){settled=true;clearTimeout(timer);reject(new Error(code));child.stdin.destroy();child.kill()}}
    child.once('error',()=>fail('backend_start_failed'))
    child.once('exit',()=>{if(!settled) fail('backend_start_failed'); else if(!closing) onExit()})
    const lines=createInterface({input:child.stdout})
    lines.on('line',line=>{
      if(settled) return
      try {
        const data=JSON.parse(line)
        if(data.type==='ready' && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(data.url) && new URL(data.url).port<=65535) {
          settled=true;clearTimeout(timer);resolve(data.url)
        }
      } catch { /* Only a valid private-pipe handshake can select the server. */ }
    })
  })
  // Drain, never forward raw service output into UI dialogs or packaged logs.
  child.stderr.on('data',()=>{})
  return { ready, child, async close() {
    closing=true
    if(stopped) return
    child.stdin.end()
    let timer
    await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve()},12000)})])
    clearTimeout(timer)
  } }
}
module.exports={startBackend}
