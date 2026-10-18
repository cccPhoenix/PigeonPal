const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pigeonpalDesktop',{
  preferences: value=>ipcRenderer.invoke('desktop:preferences',value),
  notificationStatus: ()=>ipcRenderer.invoke('desktop:notification-status'),
  onOpenChannel: callback=>{
    const listener=(_event,id)=>{if(typeof id==='string') callback(id)}
    ipcRenderer.on('desktop:open-channel',listener)
    ipcRenderer.send('desktop:renderer-ready')
    return ()=>ipcRenderer.removeListener('desktop:open-channel',listener)
  }
})
