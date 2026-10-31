import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoticeProgress, noticeProgressInfo } from '../web/js/ui/notice-progress.js'

const status = (pending, processing, extra = {}) => ({ configured: true, automatic: true, counts: { pending, processing }, ...extra })

test('progress reflects active AI work without inventing a percentage', () => {
  assert.deepEqual(noticeProgressInfo(status(3, 1, { activeNotice: { title: '讲座通知' } })), { active: true, title: '讲座通知', text: '正在处理 1 条 · 3 条排队' })
  assert.deepEqual(noticeProgressInfo(status(2, 0)), { active: true, title: '', text: '还有 2 条等待整理' })
  assert.equal(noticeProgressInfo(status(2, 0, { automatic: false })).active, false)
  assert.equal(noticeProgressInfo(status(0, 0)).active, false)
})

test('closing progress hides the current batch and a later batch can appear', () => {
  const classes = new Set(), detail = { textContent: '' }, title = { textContent: '', hidden: true }, button = { addEventListener(_name, fn) { this.click = fn } }
  const root = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    querySelector: selector => selector === '[data-progress-detail]' ? detail : selector === '[data-progress-title]' ? title : button,
    setAttribute(name, value) { this[name] = value },
  }
  const progress = createNoticeProgress({ root, client: {} })
  progress.update(status(1, 1, { activeNotice: { title: '很长的通知标题' } }))
  assert.equal(classes.has('show'), true)
  assert.equal(detail.textContent, '正在处理 1 条 · 1 条排队')
  assert.equal(title.textContent, '很长的通知标题')
  assert.equal(title.hidden, false)
  button.click()
  assert.equal(classes.has('show'), false)
  progress.update(status(0, 1))
  assert.equal(classes.has('show'), false)
  progress.update(status(0, 0))
  progress.update(status(2, 0))
  assert.equal(classes.has('show'), true)
  assert.equal(title.hidden, true)
})
