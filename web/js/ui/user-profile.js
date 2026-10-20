import { dialog, closeOverlay, toast } from './overlays.js'
import { escapeHtml } from './format.js'
import { apiErrorText } from '../services/api.js'
import { icon } from './icons.js'

export const DEGREE_LABELS = { undergraduate: '本科生', master: '硕士生', doctor: '博士生', postgraduate: '研究生', staff: '教职工', other: '其他' }
export const preferenceLines = text => String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
export const preferenceError = values => values.length > 12 ? '每类偏好最多填写 12 条，请合并或减少一些。' : values.some(value => Array.from(value).length > 120) ? '每条偏好最多 120 字，请缩短后保存。' : ''

// The snapshot lives only in this dialog. It is never written into browser
// persistence or forwarded as conversation history.
export function openUserProfile({ client, opener, onChange = () => {} }) {
  let snapshot = null, busy = false, closed = false, sequence = 0
  const box = dialog(`<h3 id="user-profile-title">用户画像</h3><p class="note">告诉小浙你是谁、想关注什么。只排除明确不适用的通知，可能有用的继续保留。</p><div data-profile-body role="status">正在读取本地画像…</div><div class="btns"><button class="btn" data-profile="close">关闭</button></div>`, { opener, onClose() { closed = true; snapshot = null; sequence += 1; box.querySelectorAll('input, textarea').forEach(input => { input.value = '' }) } })
  box.classList.add('user-profile-dialog')
  box.setAttribute('aria-labelledby', 'user-profile-title')
  const body = box.querySelector('[data-profile-body]')
  const fact = key => snapshot?.facts?.[key] || {}
  const textFact = (key, label, placeholder) => `<div class="field"><label for="up-${key}">${label}</label><input class="input" id="up-${key}" data-fact="${key}" maxlength="120" value="${escapeHtml(fact(key).value || '')}" placeholder="${placeholder}"><label class="profile-confirm"><input type="checkbox" data-confirm="${key}" ${fact(key).confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label></div>`
  function draw(message = '') {
    if (closed || !snapshot) return
    const readOnly = Boolean(snapshot.storageError)
    body.innerHTML = `${message ? `<p class="note" role="alert">${escapeHtml(message)}</p>` : ''}${readOnly ? '<p class="note" role="alert">本地画像文件读取异常，当前为只读恢复内容。可清空画像后重新填写。</p>' : ''}
<form data-profile-form><fieldset ${readOnly ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">
<div class="profile-facts"><div class="field"><label for="up-degree">身份 / 学历</label><select class="input" id="up-degree" data-fact="degree"><option value="">暂不填写</option>${Object.entries(DEGREE_LABELS).map(([value, label]) => `<option value="${value}" ${fact('degree').value === value ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="profile-confirm"><input type="checkbox" data-confirm="degree" ${fact('degree').confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label></div>
<div class="field"><label for="up-admissionYear">入学年份</label><input class="input" id="up-admissionYear" data-fact="admissionYear" type="number" min="1980" max="2100" value="${escapeHtml(fact('admissionYear').value ?? '')}" placeholder="例如 2025"><label class="profile-confirm"><input type="checkbox" data-confirm="admissionYear" ${fact('admissionYear').confirmed ? 'checked' : ''}> 已确认，可用于判断资格</label><span class="help">${snapshot.grade ? `当前为第 ${snapshot.grade} 学年；年级随学年计算。` : '填写入学年份后按学年计算年级。'}休学等特殊情况请按实际情况调整。</span></div>
${textFact('college', '学院', '例如 计算机科学与技术学院')}${textFact('major', '专业', '例如 软件工程')}</div>
<div class="field"><label for="up-student">从学号推测（可选）</label><input class="input" id="up-student" data-student-number autocomplete="off" maxlength="32" placeholder="只用于本机推测入学年"><span class="help">保存时在本机推测入学年；学号不写入画像、不发送给模型。推测结果需你确认。</span></div>
<div class="field"><label for="up-interests">我希望多看到</label><textarea class="input profile-textarea" id="up-interests" data-preference="interests" rows="3" maxlength="6000" placeholder="每行一个想法，例如：有志愿时长的活动、奖学金机会">${escapeHtml((snapshot.preferences?.interests || []).join('\n'))}</textarea><span class="help">最多 12 条，每条 120 字。</span></div>
<div class="field"><label for="up-avoid">暂不关注（降低优先级）</label><textarea class="input profile-textarea" id="up-avoid" data-preference="avoid" rows="3" maxlength="6000" placeholder="每行一个想法，例如：暂时少看讲座消息">${escapeHtml((snapshot.preferences?.avoid || []).join('\n'))}</textarea><span class="help">最多 12 条，每条 120 字。兴趣不匹配只降低优先级，不会屏蔽可能有用的通知；只有明确的资格冲突才停止主动推送。你也可以在聊天里告诉小浙想关注什么。</span></div>
<p class="help">画像保存在本机。启用模型后，只发送推荐所需的学历、入学年、学院专业与偏好等字段给你配置的模型服务；不发送学号、密码或校园认证信息。全部原始通知仍可在「全部通知」查看。</p>
<div class="btns"><button class="btn primary" type="submit">${icon('check', 15)}保存画像</button></div></fieldset></form>
<div class="btns" style="margin-top:12px"><button class="btn" data-profile="reload">重新读取</button><button class="btn danger" data-profile="clear">清空画像</button></div>`
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
  function disable(on) { for (const button of box.querySelectorAll('button')) if (button.dataset.profile !== 'close') button.disabled = on }
  async function mutate(operation) {
    if (busy) return
    busy = true; disable(true)
    try { const value = await operation(); if (closed) return; snapshot = value; draw(); toast('画像已保存，正在更新推荐'); onChange() }
    catch (error) {
      if (closed) return
      if (error.code === 'profile_version_conflict') return await load('画像刚刚在其他位置更新，已重新读取。请确认后再修改。')
      toast(apiErrorText(error))
    } finally { busy = false; if (!closed) disable(false) }
  }
  box.addEventListener('submit', event => {
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
    mutate(() => client.saveUserProfile({ expectedVersion: snapshot.version, facts, preferences, ...(studentNumber ? { studentNumber } : {}) }))
  })
  box.addEventListener('click', event => {
    const button = event.target.closest('[data-profile]')
    if (!button) return
    if (button.dataset.profile === 'close') return closeOverlay()
    if (button.dataset.profile === 'reload' && !busy) return load()
    if (button.dataset.profile === 'clear' && !busy && confirm('清空本地画像和偏好？所有通知会恢复保留，原始通知与校园绑定不受影响。')) mutate(() => client.clearUserProfile(snapshot ? { expectedVersion: snapshot.version } : {}))
  })
  load()
  return box
}
