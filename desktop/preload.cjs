const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pigeonpalDesktop',{
  preferences: value=>ipcRenderer.invoke('desktop:preferences',value),
  notificationStatus: ()=>ipcRenderer.invoke('desktop:notification-status'),
  updateStatus: ()=>ipcRenderer.invoke('desktop:updates-status'),
  checkForUpdates: ()=>ipcRenderer.invoke('desktop:updates-check'),
  setAutomaticUpdateCheck: value=>ipcRenderer.invoke('desktop:updates-preferences',value),
  downloadUpdate: ()=>ipcRenderer.invoke('desktop:updates-download'),
  installUpdate: ()=>ipcRenderer.invoke('desktop:updates-install'),
  openUpdateRelease: ()=>ipcRenderer.invoke('desktop:updates-release'),
  onUpdateStatus: callback=>{
    const listener=(_event,value)=>callback(value)
    ipcRenderer.on('desktop:update-status',listener)
    return ()=>ipcRenderer.removeListener('desktop:update-status',listener)
  },
  onOpenChannel: callback=>{
    const listener=(_event,id)=>{if(typeof id==='string') callback(id)}
    ipcRenderer.on('desktop:open-channel',listener)
    ipcRenderer.send('desktop:renderer-ready')
    return ()=>ipcRenderer.removeListener('desktop:open-channel',listener)
  }
})
