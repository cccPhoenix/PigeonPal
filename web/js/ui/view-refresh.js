// Data and reminder delivery stay synchronous. Only derived DOM work is grouped
// into a frame, so restoring a catalog does not rebuild the same panes per row.
export function connectViewRefresh({ store, rail, calendar, transcript, syncBadges, getView, getActive,
  requestFrame = callback => requestAnimationFrame(callback) }) {
  let scheduled = false
  let pending = empty()
  function empty() { return { notices: new Map(), reminders: new Map(), homework: new Set(), rail: false, calendar: false, badges: false, transcript: false } }
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestFrame(() => {
      scheduled = false
      const work = pending
      pending = empty()
      for (const channelId of work.homework) transcript.syncHomeworkSnapshot(channelId)
      // onNotices also invalidates a revised selected detail, even if another
      // event in this batch already requests a full rail refresh.
      if (work.notices.size) rail.onNotices([...work.notices.values()])
      if (work.homework.size) rail.render()
      else if (work.rail && (!work.notices.size || getView() === 'homework')) rail.renderList()
      if (work.calendar && getView() === 'calendar') calendar.render()
      const active = getActive()
      if (work.transcript) transcript.render(active)
      else if (work.reminders.size) {
        const reminders = [...work.reminders.values()]
        for (const message of store.state.messages[active] ?? []) {
          if (reminders.some(row => message.reminderId === row.id ||
            (row.noticeId && [message.id, message.noticeId, message.item?.noticeId].includes(row.noticeId)))) transcript.patch(message.id)
        }
      }
      if (work.reminders.size) rail.patchRemindPill()
      if (work.badges) syncBadges()
    })
  }
  store.on('homework-snapshot', ({ channelId }) => {
    pending.homework.add(channelId); pending.calendar = pending.badges = true; schedule()
  })
  store.on('unread', () => { pending.rail = pending.badges = true; schedule() })
  store.on('channels', () => { pending.rail = true; schedule() })
  store.on('notice', event => {
    const id = event.item.noticeId, previous = pending.notices.get(id)
    pending.notices.set(id, { ...event, revised: event.revised || previous?.revised })
    pending.calendar = pending.badges = true
    if (event.recommendationChanged && store.state.messages[getActive()]?.some(message => message.noticeHeadsUp && message.noticeId === id)) pending.transcript = true
    schedule()
  })
  store.on('reminders', row => {
    if (!row) return
    pending.reminders.set(row.id, row); pending.calendar = true; schedule()
  })
  // Calendar forms restore focus immediately after this event.
  store.on('calendar', () => { if (getView() === 'calendar') calendar.render() })
}
