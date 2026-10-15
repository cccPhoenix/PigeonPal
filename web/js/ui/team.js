import { markHTML } from '../mark/index.js'
import { LOOKS, LOOK_IDS } from '../mark/looks.js'
import { dialog, closeOverlay, toast } from './overlays.js'
import { escapeHtml } from './format.js'
import { apiErrorText } from '../services/api.js'

export function syncTeamPatch(store, { bots = [], channels = [] }) {
  const merged = (old, updates) => [...old.filter(row => !updates.some(update => update.id === row.id)), ...updates]
  return store.syncBots({ bots: merged(store.state.bots || [], bots.filter(Boolean)), channels: merged(store.state.channels, channels.filter(Boolean)) })
}
export const BOT_ROLES = { general: '通用伙伴', news: '通知整理', reminder: '提醒', writer: '写作', planner: '规划' }
export function botFace(store, bot, size = 32) {
  const appearance = store.botAppearance(bot)
  return markHTML({ ...appearance, image: appearance.look === 'image' ? appearance.image : null, label: appearance.name, size, live: true })
}
const choices = (store, selected = []) => (store.state.bots || []).map(bot => `<label class="member-choice">${botFace(store, bot)}<span>${escapeHtml(store.botAppearance(bot).name)}<small>${escapeHtml(BOT_ROLES[bot.role] || bot.role || '伙伴')}</small></span><input type="checkbox" value="${escapeHtml(bot.id)}" ${selected.includes(bot.id) ? 'checked' : ''}></label>`).join('')
const members = box => [...box.querySelectorAll('.member-choice input:checked')].map(input => input.value)

export function openCreateBot({ store, client, refresh, select }, opener) {
  let closed = false
  const box = dialog(`<h3>添加伙伴</h3><p>给它一个明确的职责，创建后可以私聊或邀请进频道。</p>
<form data-bot-form><div class="field"><label for="new-bot-name">名字</label><input id="new-bot-name" class="input" name="name" maxlength="32" required placeholder="比如：写作鸽"></div>
<div class="field"><label for="new-bot-role">职责</label><select class="input" id="new-bot-role" name="role">${Object.entries(BOT_ROLES).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></div>
<div class="field"><label for="new-bot-instructions">工作说明</label><textarea class="input" id="new-bot-instructions" name="instructions" maxlength="3000" rows="3" placeholder="希望它负责什么、遵循哪些要求"></textarea></div>
<div class="field"><label for="new-bot-style">说话风格</label><input class="input" id="new-bot-style" name="style" maxlength="1000" placeholder="比如：简短直接，保留原意"></div>
<div class="field"><label for="new-bot-look">初始形象</label><select class="input" id="new-bot-look" name="look">${LOOK_IDS.map(id => `<option value="${id}" ${id === 'pigeon' ? 'selected' : ''}>${escapeHtml(LOOKS[id].label)}</option>`).join('')}</select><span class="help">创建后可在设置里单独换形象或上传图片。</span></div>
<div class="team-error" role="alert"></div><div class="btns"><button type="button" class="btn" data-cancel>取消</button><button class="btn primary" type="submit">创建伙伴</button></div></form>`, { opener, onClose: () => { closed = true } })
  box.querySelector('[data-cancel]').onclick = closeOverlay
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault()
    const button = box.querySelector('[type="submit"]')
    button.disabled = true
    box.querySelector('.team-error').textContent = ''
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget))
      body.name = body.name.trim()
      if (!body.name) { box.querySelector('.team-error').textContent = '请填写伙伴的名字'; return }
      const result = await client.createBot(body)
      syncTeamPatch(store, { bots: [result.bot], channels: result.channel ? [result.channel] : [] })
      refresh().catch(() => {})
      if (closed) return
      closeOverlay()
      toast('伙伴已创建')
      const channel = store.state.channels.find(c => c.kind === 'dm' && c.botId === result.bot.id)
      if (channel) select(channel.id)
    } catch (error) { box.querySelector('.team-error').textContent = apiErrorText(error) }
    finally { button.disabled = false }
  }
}

export function openCreateGroup({ store, client, refresh, select }, opener) {
  let closed = false
  const box = dialog(`<h3>新建群频道</h3><form><div class="field"><label for="group-title">频道名</label><input class="input" id="group-title" name="title" maxlength="32" required placeholder="比如：期末复习"></div><p class="note">选择一起参与的伙伴；不 @ 时由 Chief 或首位成员回应。</p><div class="member-choices">${choices(store, ['chief'])}</div><div class="team-error" role="alert"></div><div class="btns"><button type="button" class="btn" data-cancel>取消</button><button class="btn primary" type="submit">创建频道</button></div></form>`, { opener, onClose: () => { closed = true } })
  box.querySelector('[data-cancel]').onclick = closeOverlay
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault()
    const button = box.querySelector('[type="submit"]')
    const memberIds = members(box)
    if (!memberIds.length) { box.querySelector('.team-error').textContent = '至少选择一位伙伴'; return }
    button.disabled = true
    try {
      const { channel } = await client.createBotChannel({ title: box.querySelector('[name="title"]').value.trim(), memberIds, kind: 'group' })
      syncTeamPatch(store, { bots: [], channels: [channel] })
      refresh().catch(() => {})
      if (!closed) { closeOverlay(); select(channel.id) }
    } catch (error) { box.querySelector('.team-error').textContent = apiErrorText(error) }
    finally { button.disabled = false }
  }
}

export function openMembers({ store, client, refresh }, channelId, opener) {
  const channel = store.channel(channelId)
  if (!channel) return
  const editable = channel.kind !== 'dm'
  let closed = false
  const box = dialog(`<h3>${escapeHtml(channel.title || '频道')}的伙伴</h3><p class="note">${editable ? '勾选邀请，取消勾选移除；保存成功后生效。' : '私聊固定由这位伙伴参与。'}</p><div class="member-choices">${choices(store, channel.memberIds || ['chief'])}</div><div class="team-error" role="alert"></div><div class="btns"><button class="btn" data-cancel>关闭</button>${editable ? '<button class="btn primary" data-save>保存成员</button>' : ''}</div>`, { opener, onClose: () => { closed = true } })
  box.querySelector('[data-cancel]').onclick = closeOverlay
  if (channelId === 'bot') box.querySelector('input[value="chief"]')?.setAttribute('disabled', '')
  if (!editable) for (const input of box.querySelectorAll('input')) input.disabled = true
  box.querySelector('[data-save]')?.addEventListener('click', async event => {
    const memberIds = members(box)
    if (!memberIds.length) { box.querySelector('.team-error').textContent = '至少保留一位伙伴'; return }
    event.currentTarget.disabled = true
    try {
      const { channel: updated } = await client.setBotMembers(channelId, memberIds)
      syncTeamPatch(store, { bots: [], channels: [updated] })
      refresh().catch(() => {})
      if (!closed) { closeOverlay(); toast('频道成员已保存') }
    } catch (error) { box.querySelector('.team-error').textContent = apiErrorText(error) }
    finally { event.target.disabled = false }
  })
}
