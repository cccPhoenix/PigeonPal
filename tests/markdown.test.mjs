import test from 'node:test'
import assert from 'node:assert/strict'
import { richText } from '../web/js/ui/format.js'
import { createStore, hydrate } from '../web/js/store.js'
import { createAIChat } from '../web/js/services/chat.js'
const profile = { botName: 'Alex', nickname: '同学' }

test('chat renders headings, emphasis, inline code and intentional line breaks', () => {
  const html = richText('## 作业安排\n\n**先复习**，再做 *练习*。\n使用 `sum()`，~~旧计划~~。', profile)
  assert.match(html, /<h2>作业安排<\/h2>/)
  assert.match(html, /<strong>先复习<\/strong>/)
  assert.match(html, /<em>练习<\/em>/)
  assert.match(html, /<code>sum\(\)<\/code>/)
  assert.match(html, /<del>旧计划<\/del>/)
  assert.match(html, /<br>/)
})

test('lists, quotes, task lists and tables retain real structured markup', () => {
  const html = richText('1. 第一项\n2. 第二项\n\n- [x] 已做\n- [ ] 待做\n\n> 留意截止时间\n\n| 事项 | 时间 |\n| --- | --- |\n| 作业 | 九点 |', profile)
  assert.match(html, /<ol>/)
  assert.match(html, /<li>第一项<\/li>/)
  assert.match(html, /<blockquote>/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /disabled/)
  assert.match(html, /<table>/)
  assert.match(html, /<td>九点<\/td>/)
})

test('fenced code stays literal, including backticks, HTML and markdown-looking text', () => {
  const html = richText('```js\nconst x = "<script>bad()</script>";\n// **literal**\n```', profile)
  assert.match(html, /<pre[^>]*><code class="language-js">/)
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.ok(html.includes('**literal**'))
  assert.ok(!html.includes('<strong>literal'))
})

test('links render formatted labels and open externally without granting script navigation', () => {
  const html = richText('[**学校**](https://www.zju.edu.cn/?x=1&y=2) 和 [邮箱](mailto:test@example.edu)', profile)
  assert.match(html, /href="https:\/\/www.zju.edu.cn\/\?x=1&amp;y=2"/)
  assert.match(html, /<strong>学校<\/strong>/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /href="mailto:test@example.edu"/)
  for (const url of ['javascript:alert', 'JaVaScRiPt:alert', 'data:text/html,evil', 'file:///etc/passwd', 'javascript&#58;alert', 'java\tscript:alert']) {
    assert.ok(!richText(`[打开](<${url}>)`, profile).includes('<a '), url)
  }
})

test('raw HTML and remote images never introduce executable tags or automatic image requests', () => {
  const html = richText('<script>bad()</script>\n\n<svg onload="bad()"></svg>\n\n<img src=x onerror="bad()">\n\n![图](https://example.edu/tracker.png)', profile)
  for (const tag of ['<script', '<svg', '<img']) assert.ok(!html.includes(tag), tag)
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('图'))
})

test('nickname substitution remains supported without injecting raw HTML', () => {
  const html = richText('**{name}**：{nickname}，记得交作业。', { botName: 'Alex', nickname: '<img src=x>' })
  assert.match(html, /<strong>Alex<\/strong>/)
  assert.ok(!html.includes('<img '))
  assert.ok(html.includes('&lt;img'))
})

test('a long markdown message survives browser reload without losing its closing fence', () => {
  const text = '```text\n' + '完整内容\n'.repeat(1100) + '```\n\n**末尾**'
  const store = createStore(null)
  store.addMessage('bot', { role: 'bot', botId: 'chief', text })
  const state = hydrate(JSON.stringify(store.state))
  assert.equal(state.messages.bot[0].text, text)
  assert.match(richText(state.messages.bot[0].text, state.profile), /<strong>末尾<\/strong>/)
})

test('legacy chat responses do not cut fenced code into arbitrary 1800-character bubbles', async () => {
  const store = createStore(null)
  const text = '```js\n' + '// long code\n'.repeat(300) + '```'
  const messages = []
  const chat = createAIChat({ chat: async () => ({ events: [{ type: 'message', text }] }) })
  for await (const event of chat.respond({ text: '写代码', channelId: 'bot', state: store.state, requestId: 'markdown-legacy-001', history: [] })) {
    if (event.type === 'message') messages.push(event)
  }
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, text)
})

test('valid Unicode replies keep their closing fence when restored', () => {
  const text = '```text\n' + '😀'.repeat(10000) + '\n```\n\n**末尾**'
  const store = createStore(null)
  store.addMessage('bot', { role: 'bot', text })
  const restored = hydrate(JSON.stringify(store.state)).messages.bot[0].text
  assert.equal(restored.length, text.length, 'UTF-16 length must not truncate a valid code-point-bounded reply')
  assert.ok(restored.endsWith('**末尾**'))
})

test('complete bubbles retain their full tail in bounded legacy model history', async () => {
  const { buildChatHistory } = await import('../web/js/services/chat.js')
  assert.equal(typeof buildChatHistory, 'function')
  const text = '代码'.repeat(2400) + '这里是末尾逻辑'
  const history = buildChatHistory([{ role: 'system', kind: 'activity', text: '不发给模型' },
    { role: 'bot', kind: 'text', text }], profile)
  assert.equal(history.map(row => row.content).join(''), text)
  assert.ok(history.every(row => row.role === 'assistant'))
  const bounded = buildChatHistory(Array.from({ length: 40 }, (_, index) => ({ role: 'bot', kind: 'text', text: '😀'.repeat(1000) + index })), profile)
  assert.ok(bounded.length <= 24)
  assert.ok(bounded.reduce((total, row) => total + Array.from(row.content).length, 0) <= 18000)
  assert.ok(bounded.at(-1).content.endsWith('39'))
})
