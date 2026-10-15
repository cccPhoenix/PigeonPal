import { createStore, STORAGE_KEY } from '../store.js'
import { createTranscript } from './transcript.js'
import { readAppearancePreferences } from '../mark/bot-appearances.js'

// An isolated preview: read visual preferences only, never write real app data.
const root = document.querySelector('[data-activity-preview]')
const jump = document.querySelector('[data-activity-jump]')
const controls = document.querySelector('[data-activity-controls]')
const store = createStore(null)
Object.assign(store.state.profile, { botName: 'Chief', look: 'pigeon' })
function loadAppearances() {
  try {
    const saved = readAppearancePreferences(localStorage.getItem(STORAGE_KEY))
    if (saved) {
      Object.assign(store.state.profile, saved.profile)
      store.state.botAppearances = saved.botAppearances
      if (saved.bots.length) store.state.bots = saved.bots
    }
  } catch { /* Preview remains available without browser storage. */ }
}
loadAppearances()
const transcript = createTranscript({ root, jump, store, onAction() {} })
store.on('message', message => transcript.append(message))
store.on('activity-updated', message => transcript.refreshActivity(message))
let replay = 0
let timer = 0
const make = (id, type, actors, detail = '') => ({ id, activity: { type, actors, detail } })
function samples() {
  const chief = { id: 'chief', name: store.state.profile.botName, look: store.state.profile.look }
  const news = store.state.bots.find(bot => bot.role === 'news' && bot.id !== 'chief')
    || { id: 'news', name: '通知鸽', look: 'courier' }
  const reminder = store.state.bots.find(bot => bot.role === 'reminder') || { id: 'reminder', name: '提醒鸽', look: 'pigeon' }
  return [
  make('preview-join', 'joined', [news]),
  make('preview-handoff', 'handoff', [chief, news], '整理校园通知'),
  make('preview-task', 'processing', [news], '整理校园通知'),
  make('preview-task', 'completed', [news], '通知整理'),
  make('preview-reminder', 'reminder_saved', [reminder], '今晚 21:00'),
  make('preview-failed', 'failed', [news]),
  ]
}

function reset() {
  replay += 1
  clearTimeout(timer)
  for (const row of root.querySelectorAll('.activity-row')) clearTimeout(row._activityTimer)
  store.state.messages.bot = []
  transcript.render('bot')
}

function play() {
  reset()
  const generation = replay
  const steps = samples()
  let index = 0
  const next = () => {
    if (generation !== replay || index >= steps.length) return
    store.upsertActivity('bot', steps[index++])
    timer = setTimeout(next, 1650)
  }
  next()
}

controls.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.preview === 'play') play()
  if (button.dataset.preview === 'history') {
    reset()
    for (const sample of samples()) store.upsertActivity('bot', sample)
    transcript.render('bot')
  }
  if (button.dataset.motion) {
    document.documentElement.dataset.motion = button.dataset.motion
    for (const option of controls.querySelectorAll('[data-motion]')) option.setAttribute('aria-pressed', String(option === button))
  }
})

transcript.render('bot')
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  loadAppearances()
  transcript.refreshMarks()
})
window.addEventListener('focus', () => { loadAppearances(); transcript.refreshMarks() })
