import { toast } from './overlays.js'
import { escapeHtml } from './format.js'
import { apiErrorText } from '../services/api.js'
import { icon } from './icons.js'

export const DEGREE_LABELS = { undergraduate: '本科生', master: '硕士生', doctor: '博士生', postgraduate: '研究生', staff: '教职工', other: '其他' }
export const ACADEMY_LABELS = { yunfeng: '云峰学园', danyang: '丹阳青溪学园', lantian: '蓝田学园' }
const ACADEMY_CHOICES = [
  { value: '', label: '全部学园', note: '保留三个学园的消息', mark: 'graduate' },
  { value: 'yunfeng', label: ACADEMY_LABELS.yunfeng, note: '紫云 · 碧峰', mark: 'school' },
  { value: 'danyang', label: ACADEMY_LABELS.danyang, note: '丹阳 · 青溪', mark: 'school' },
  { value: 'lantian', label: ACADEMY_LABELS.lantian, note: '蓝田', mark: 'school' },
]

export function academyPickerHTML(value = '') {
  const selected = ACADEMY_CHOICES.find(choice => choice.value === value) || ACADEMY_CHOICES[0]
  return `<div class="field profile-academy-field"><label id="up-academy-label" for="up-academy">所属学园</label>
<div class="academy-picker" data-academy-picker><input type="hidden" data-academy value="${selected.value}">
<button type="button" class="academy-trigger" id="up-academy" data-academy-trigger role="combobox" aria-haspopup="listbox" aria-controls="up-academy-menu" aria-expanded="false" aria-labelledby="up-academy-label up-academy-name" aria-describedby="up-academy-help">
<span class="academy-mark" aria-hidden="true" data-academy-mark>${icon(selected.mark, 19)}</span><span class="academy-copy"><span class="academy-name" id="up-academy-name" data-academy-name>${selected.label}</span><span class="academy-note" data-academy-note>${selected.note}</span></span><span class="academy-chevron">${icon('chevron', 15)}</span></button>
<div class="academy-menu" id="up-academy-menu" role="listbox" aria-labelledby="up-academy-label" hidden>${ACADEMY_CHOICES.map((choice, index) => `<button type="button" class="academy-option" id="up-academy-option-${choice.value || 'all'}" role="option" tabindex="-1" data-academy-option="${choice.value}" aria-selected="${choice.value === selected.value}"><span class="academy-option-mark" aria-hidden="true">${icon(choice.mark, 17)}</span><span class="academy-copy"><span class="academy-name">${choice.label}</span><span class="academy-note">${choice.note}</span></span><span class="academy-check" aria-hidden="true">${icon('check', 16)}</span></button>`).join('')}</div></div>
<span class="help" id="up-academy-help">选择后通知栏只显示所属学园，公共来源照常保留。选择「全部学园」可恢复其他学园消息。</span></div>`
}

// A select-only combobox keeps focus on its trigger while the active option
// moves through the list. Choosing changes the draft; 保存画像 commits it.
export function bindAcademyPicker(picker) {
  if (!picker) return { destroy() {} }
  const trigger = picker.querySelector('[data-academy-trigger]'), input = picker.querySelector('[data-academy]')
  const menu = picker.querySelector('[role="listbox"]'), options = [...picker.querySelectorAll('[data-academy-option]')]
  const owner = picker.ownerDocument || document
  let open = false, active = 0
  const unavailable = () => trigger.disabled || trigger.matches?.(':disabled')
  function highlight(index) {
    active = Math.max(0, Math.min(options.length - 1, index))
    options.forEach((option, i) => option.classList.toggle('is-active', open && i === active))
    if (open) {
      trigger.setAttribute('aria-activedescendant', options[active].id)
      options[active].scrollIntoView?.({ block: 'nearest' })
    }
  }
  function close(focus = false) {
    open = false; menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-activedescendant')
    highlight(active)
    if (focus) trigger.focus({ preventScroll: true })
  }
  function show() {
    if (unavailable()) return
    open = true; menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    highlight(Math.max(0, options.findIndex(option => option.dataset.academyOption === input.value)))
  }
  function choose(option) {
    const choice = ACADEMY_CHOICES.find(choice => choice.value === option?.dataset.academyOption)
    if (!choice || unavailable()) return
    input.value = choice.value
    picker.querySelector('[data-academy-name]').textContent = choice.label
    picker.querySelector('[data-academy-note]').textContent = choice.note
    picker.querySelector('[data-academy-mark]').innerHTML = icon(choice.mark, 19)
    options.forEach(option => option.setAttribute('aria-selected', String(option.dataset.academyOption === choice.value)))
    close(true)
  }
  function onClick(event) {
    if (trigger.contains(event.target)) { if (open) close(); else show(); return }
    const option = event.target.closest?.('[data-academy-option]')
    if (option && picker.contains(option)) choose(option)
  }
  function onKeydown(event) {
    if (unavailable()) return
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); close(true) } return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Enter' || event.key === ' ') { if (open) choose(options[active]); else show(); return }
    if (!open) { show(); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return }
    highlight(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1))
  }
  function onOutside(event) { if (open && !picker.contains(event.target)) close() }
  function onFocusout(event) { if (open && !picker.contains(event.relatedTarget)) close() }
  picker.addEventListener('click', onClick)
  picker.addEventListener('keydown', onKeydown)
  picker.addEventListener('focusout', onFocusout)
  owner.addEventListener('pointerdown', onOutside, true)
  return { destroy() {
    close()
    picker.removeEventListener('click', onClick)
    picker.removeEventListener('keydown', onKeydown)
    picker.removeEventListener('focusout', onFocusout)
    owner.removeEventListener('pointerdown', onOutside, true)
  } }
}
export const preferenceLines = text => String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
export const preferenceError = values => values.length > 12 ? '每类偏好最多填写 12 条，请合并或减少一些。' : values.some(value => Array.from(value).length > 120) ? '每条偏好最多 120 字，请缩短后保存。' : ''

// The snapshot stays in this view and is discarded when the view closes.
// It is never written into browser persistence or conversation history.
export function openUserProfile({ client, root, onChange = () => {} }) {
  let snapshot = null, busy = false, closed = false, sequence = 0, academyPicker = null
  const initial = `<div class="profile-page-scroll"><div class="profile-page-inner"><header class="profile-page-header"><h1 id="user-profile-title">用户画像</h1><p>告诉小浙你的身份和关注方向，方便推荐更合适的校园消息。</p></header><div data-profile-body>正在读取本地画像…</div></div></div>`
  const dispose = () => {
    closed = true; snapshot = null; sequence += 1
    academyPicker?.destroy(); academyPicker = null
    box.removeEventListener?.('submit', onSubmit)
    box.removeEventListener?.('click', onClick)
    box.querySelectorAll('input, textarea').forEach(input => { input.value = '' })
  }
  const box = root
  box.innerHTML = initial
  const body = box.querySelector('[data-profile-body]')
  const fact = key => snapshot?.facts?.[key] || {}
  const textFact = (key, label, placeholder) => `<div class="field"><label for="up-${key}">${label}</label><input class="input" id="up-${key}" data-fact="${key}" maxlength="120" value="${escapeHtml(fact(key).value || '')}" placeholder="${placeholder}"><label class="profile-confirm"><input type="checkbox" data-confirm="${key}" ${fact(key).confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label></div>`
  function draw(message = '') {
    if (closed || !snapshot) return
    academyPicker?.destroy()
    const readOnly = Boolean(snapshot.storageError)
    body.innerHTML = `${message ? `<p class="profile-alert" role="alert">${escapeHtml(message)}</p>` : ''}${readOnly ? '<p class="profile-alert" role="alert">本地画像文件读取异常，当前为只读恢复内容。可清空画像后重新填写。</p>' : ''}
<form id="user-profile-form" data-profile-form><fieldset ${readOnly ? 'disabled' : ''} class="profile-fieldset">
<section class="profile-card"><div class="profile-section-head"><h2>我的身份</h2><p>确认后的信息可用于判断通知资格。</p></div>
${academyPickerHTML(snapshot.academy)}
<div class="profile-facts"><div class="field"><label for="up-degree">身份 / 学历</label><select class="input" id="up-degree" data-fact="degree"><option value="">暂不填写</option>${Object.entries(DEGREE_LABELS).map(([value, label]) => `<option value="${value}" ${fact('degree').value === value ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="profile-confirm"><input type="checkbox" data-confirm="degree" ${fact('degree').confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label></div>
<div class="field"><label for="up-admissionYear">入学年份</label><input class="input" id="up-admissionYear" data-fact="admissionYear" type="number" min="1980" max="2100" value="${escapeHtml(fact('admissionYear').value ?? '')}" placeholder="例如 2025"><label class="profile-confirm"><input type="checkbox" data-confirm="admissionYear" ${fact('admissionYear').confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label><span class="help">${snapshot.grade ? `当前为第 ${snapshot.grade} 学年；年级随学年计算。` : '填写入学年份后按学年计算年级。'}休学等特殊情况请按实际情况调整。</span></div>
${textFact('college', '学院', '例如 计算机科学与技术学院')}${textFact('major', '专业', '例如 软件工程')}</div>
<div class="profile-inference"><div class="field"><label for="up-student">从学号推测入学年 <span class="profile-optional">可选</span></label><input class="input" id="up-student" data-student-number autocomplete="off" maxlength="32" placeholder="只在本机使用"><span class="help">保存时在本机推测；学号不写入画像，也不发送给模型。请核对并确认推测结果。</span></div></div></section>
<section class="profile-card"><div class="profile-section-head"><h2>我的关注</h2><p>用自己的话填写，每行一个想法。</p></div>
<div class="field"><label for="up-interests">我希望多看到</label><textarea class="input profile-textarea" id="up-interests" data-preference="interests" rows="3" maxlength="6000" placeholder="每行一个想法，例如：有志愿时长的活动、奖学金机会">${escapeHtml((snapshot.preferences?.interests || []).join('\n'))}</textarea><span class="help">最多 12 条，每条 120 字。</span></div>
<div class="field"><label for="up-avoid">暂不关注（降低优先级）</label><textarea class="input profile-textarea" id="up-avoid" data-preference="avoid" rows="3" maxlength="6000" placeholder="每行一个想法，例如：暂时少看讲座消息">${escapeHtml((snapshot.preferences?.avoid || []).join('\n'))}</textarea><span class="help">最多 12 条，每条 120 字。兴趣不匹配只降低优先级，不会屏蔽可能有用的通知；只有明确的资格冲突才停止主动推送。你也可以在聊天里告诉小浙想关注什么。</span></div>
</section><p class="profile-privacy">画像保存在本机。启用模型后，只发送推荐所需的身份与偏好；不发送学号、密码或校园认证信息。学园选择只改变通知栏的显示，原始数据保留在本机。</p>
</fieldset></form><div class="profile-actions"><div class="profile-secondary-actions"><button class="profile-action-link" type="button" data-profile="reload">重新读取</button><button class="profile-action-link danger" type="button" data-profile="clear">清空画像</button></div><button class="btn primary profile-save" type="submit" form="user-profile-form" ${readOnly ? 'disabled' : ''}>保存画像</button></div>`
    academyPicker = bindAcademyPicker(box.querySelector('[data-academy-picker]'))
  }
  async function load(message = '') {
    const current = ++sequence
    busy = true
    try { const value = await client.userProfile(); if (closed || current !== sequence) return; snapshot = value; draw(message) }
    catch (error) {
      if (!closed && current === sequence) {
        if (error.code === 'profile_storage_error') snapshot = null
        body.innerHTML = `<p class="note" role="alert">${escapeHtml(apiErrorText(error))}</p><div class="btns"><button class="btn" data-profile="reload">重试</button>${error.code === 'profile_storage_error' ? '<button class="btn danger" data-profile="clear">清空并重建画像</button>' : ''}</div>`
      }
    }
    finally { if (current === sequence) busy = false }
  }
  function disable(on) { for (const button of box.querySelectorAll('button')) button.disabled = on || (button.type === 'submit' && Boolean(snapshot?.storageError)) }
  async function mutate(operation) {
    if (busy) return
    busy = true; disable(true)
    try {
      const value = await operation()
      // Persistence outlives this view: the active notice rail still needs the
      // committed profile even if the user navigated away while saving.
      onChange(value)
      if (closed) return
      snapshot = value; draw(); toast('画像已保存，正在更新推荐')
    }
    catch (error) {
      if (closed) return
      if (error.code === 'profile_version_conflict') return await load('画像刚刚在其他位置更新，已重新读取。请确认后再修改。')
      toast(apiErrorText(error))
    } finally { busy = false; if (!closed) disable(false) }
  }
  function onSubmit(event) {
    if (!event.target.matches('[data-profile-form]')) return
    event.preventDefault()
    if (busy || snapshot?.storageError) return
    const facts = {}
    for (const input of box.querySelectorAll('[data-fact]')) {
      const key = input.dataset.fact, raw = input.value.trim()
      facts[key] = { value: key === 'admissionYear' ? raw ? Number(raw) : null : raw || null, confirmed: box.querySelector(`[data-confirm="${key}"]`).checked }
    }
    const student = box.querySelector('[data-student-number]')
    const studentNumber = student.value.trim()
    const preferences = Object.fromEntries([...box.querySelectorAll('[data-preference]')].map(input => [input.dataset.preference, preferenceLines(input.value)]))
    const error = preferenceError(preferences.interests) || preferenceError(preferences.avoid)
    if (error) return toast(error)
    student.value = ''
    if (studentNumber && !fact('admissionYear').confirmed && (!facts.admissionYear.value || !facts.admissionYear.confirmed && String(facts.admissionYear.value) === String(fact('admissionYear').value))) delete facts.admissionYear
    const academy = box.querySelector('[data-academy]').value
    mutate(() => client.saveUserProfile({ expectedVersion: snapshot.version, academy, facts, preferences, ...(studentNumber ? { studentNumber } : {}) }))
  }
  function onClick(event) {
    const button = event.target.closest('[data-profile]')
    if (!button) return
    if (button.dataset.profile === 'reload' && !busy) return load()
    if (button.dataset.profile === 'clear' && !busy && confirm('清空本地画像和偏好？所有通知会恢复保留，原始通知与校园绑定不受影响。')) mutate(() => client.clearUserProfile(snapshot ? { expectedVersion: snapshot.version } : {}))
  }
  box.addEventListener('submit', onSubmit)
  box.addEventListener('click', onClick)
  load()
  return { destroy() { dispose(); box.innerHTML = '' } }
}
