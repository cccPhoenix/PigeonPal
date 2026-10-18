// Fixed, context-isolated desktop bridge; never exposes arbitrary IPC or file access.
export const isDesktop = () => Boolean(globalThis.pigeonpalDesktop)
let status = { supported: false, enabled: true }
export const desktopNotificationStatus = () => status
export async function setDesktopNotifications(enabled) {
  await globalThis.pigeonpalDesktop.preferences({ enabled })
  status = await globalThis.pigeonpalDesktop.notificationStatus()
  return status
}
export function connectDesktop(store, select) {
  const bridge=globalThis.pigeonpalDesktop
  if(!bridge) return
  const sync=()=>bridge.preferences({proactive:store.state.profile.proactive,botName:store.state.profile.botName,nickname:store.state.profile.nickname,
    quietStart:store.state.profile.quietStart,quietEnd:store.state.profile.quietEnd,
    muted:store.state.channels.filter(channel=>channel.notify==='mute').map(channel=>channel.id)}).catch(()=>{})
  sync()
  bridge.notificationStatus().then(value=>{status=value}).catch(()=>{})
  store.on('profile',sync);store.on('channels',sync);store.on('channel',sync)
  bridge.onOpenChannel(id=>{if(store.channel(id)) select(id)})
}
