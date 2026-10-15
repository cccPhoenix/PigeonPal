import { createStore } from '../store.js'
import { createTranscript } from './transcript.js'

// An isolated, explicitly labelled preview: no fetch, localStorage or real tasks.
const root = document.querySelector('[data-activity-preview]')
const jump = document.querySelector('[data-activity-jump]')
const controls = document.querySelector('[data-activity-controls]')
const store = createStore(null)
Object.assign(store.state.profile, { botName: 'Chief', look: 'pigeon' })
const chief = { id: 'chief', name: 'Chief', look: 'pigeon' }
const writer = { id: 'writer', name: '写作鸽', look: 'courier' }
const reminder = { id: 'reminder', name: '提醒鸽', look: 'pigeon' }
const transcript = createTranscript({ root, jump, store, onAction() {} })
store.on('message', message => transcript.append(message))
store.on('activity-updated', message => transcript.refreshActivity(message))
let replay = 0
let timer = 0
const make = (id, type, actors, detail = '') => ({ id, activity: { type, actors, detail } })
const samples = [
  make('preview-join', 'joined', [writer]),
  make('preview-handoff', 'handoff', [chief, writer], '润色一段文字'),
  make('preview-task', 'processing', [writer], '润色一段文字'),
  make('preview-task', 'completed', [writer], '文字润色'),
  make('preview-reminder', 'reminder_saved', [reminder], '今晚 21:00'),
  make('preview-failed', 'failed', [writer]),
]

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
  let index = 0
  const next = () => {
    if (generation !== replay || index >= samples.length) return
    store.upsertActivity('bot', samples[index++])
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
    for (const sample of samples) store.upsertActivity('bot', sample)
    transcript.render('bot')
  }
  if (button.dataset.motion) {
    document.documentElement.dataset.motion = button.dataset.motion
    for (const option of controls.querySelectorAll('[data-motion]')) option.setAttribute('aria-pressed', String(option === button))
  }
})

transcript.render('bot')
