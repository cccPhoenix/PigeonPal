# 后端接口（预留）

UI 只通过下面三个契约和后端打交道。现在接的都是演示实现，换成真实实现后，界面不需要改动。三个服务在 `web/js/main.js` 顶部的 `services` 里组装。

## 1. 对话：`web/js/services/chat.js`

```js
chat.respond({ text, channelId, state }) // async generator
```

按顺序产出事件：

| 事件 | 含义 |
|---|---|
| `{ type: 'typing', ms }` | 显示"正在输入"的时长，头像同时进入思考状态 |
| `{ type: 'message', text, quoteId? }` | 发出一个气泡。正文里可以写 `{nickname}` 和 `{name}`，渲染时再替换 |
| `{ type: 'action', name: 'profile.update', args: { nickname } }` | 修改称呼 |
| `{ type: 'action', name: 'reminder.create', args: { title, dueAt } }` | 新建提醒 |

接入模型时：后端用 SSE 或流式 fetch 推送；模型的工具调用映射成 `action`；长回复按自然停顿拆成多条 `message`，中间插入 `typing`，读起来更像真人。用户连续发的几条短消息，会在 0.9 秒后合并成一次请求。

## 2. 信息来源：`web/js/services/sources.js`

每个侧栏频道对应一个 adapter：

```js
adapter = { id, channelId, fetch: async () => Item[] }
Item = { id, title, url, publishedAt, kind?, eventAt?, eventEnd?, where?, summary? }
```

- `startFeed` 定时轮询所有 adapter，按 `id` 去重（已见过的 id 存在 `state.seenItems`），新条目交给 `onItem`。
- `noticeCopy(item)` 决定 bot 怎么说这条通知。以后可以换成模型生成，但必须只用原文里有的信息。
- `kind`：`talk` 报告会、`deadline` 截止或开放时间、`club` 活动、`notice` 其他。
- 用户通过「添加信息来源」建的频道带 `pending: true`，等对应的 adapter 写好后接上即可。

真实抓取应该放在后端（定时任务加解析），前端的 `fetch()` 只调用自家 API，不在浏览器里直接爬网站。

## 3. 提醒调度：`web/js/services/scheduler.js`

```js
startScheduler({ due: now => Reminder[], deliver: reminder => void })
```

现在的实现是页面内每秒检查一次，**只在窗口打开时有效**。做成桌面应用后，换成常驻进程或系统级通知，契约保持不变。提醒的生命周期是纯函数，在 `web/js/reminders.js` 里：每条只触发一次；改时间会重新挂上；完成或取消后永久停止；同一条通知只保留一个有效提醒。

`systemNotify(title, body)` 只在窗口处于后台时弹系统通知。桌面壳接入后改用原生通知。

## 4. 数据

`web/js/store.js` 管理状态。现在保存在 localStorage（`pigeonpal.v1`），读取时会校验每个字段。接入账号或同步时，替换 `createStore(storage)` 里的 storage 即可。
