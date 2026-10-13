// Reminder delivery. This in-page ticker only runs while the window is open; a desktop
// shell or server scheduler replaces it later with the same contract:
//   startScheduler({ due: now => Reminder[], deliver: reminder => void })
// `due` must stop returning a reminder once `deliver` has marked it delivered.

export function startScheduler({ due, deliver, intervalMs = 5000 }) {
  const tick = () => { for (const reminder of due(Date.now())) deliver(reminder) }
  tick()
  const timer = setInterval(tick, intervalMs)
  const onVisible = () => { if (document.visibilityState === 'visible') tick() }
  document.addEventListener('visibilitychange', onVisible)
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
}

// System notifications, used only when the window is in the background. The desktop
// shell will swap this for native notifications.
export function systemNotify(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') return
  try { new Notification(title, { body, silent: false }) } catch { /* not supported here */ }
}
