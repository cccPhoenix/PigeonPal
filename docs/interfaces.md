# 本机 API 与前端服务契约

本机服务由 `scripts/local_service.py` 提供，监听 `127.0.0.1`。前端用 `web/js/services/api.js` 调用模型、通知和提醒接口，认证仍用原有 `services/auth.js`。真实聊天与通知适配器在 `main.js` 的 `services` 中组装；旧演示函数仅保留给历史测试，不参与主界面运行。

## 1. 对话：`web/js/services/chat.js`

```js
chat.respond({ text, channelId, state, requestId, quoteId, history, botId? }) // async generator
```

按顺序产出事件：

| 事件 | 含义 |
|---|---|
| `{ type: 'typing', ms }` | 显示"正在输入"的时长，头像同时进入思考状态 |
| `{ type: 'activity', id, activity: { type, actors, detail? } }` | 后端真实执行状态（旧服务保留客户端请求确认），按 ID 更新同一条轻量提示；不来自模型自由文本 |
| `{ type: 'message', id?, botId?, text, quoteId? }` | 发出一个气泡；稳定 ID 与后台事件去重，botId 决定头像。正文里可以写 `{nickname}` 和 `{name}`，渲染时再替换 |
| `{ type: 'action', name: 'profile.update', args: { nickname } }` | 修改称呼 |
| `{ type: 'action', name: 'reminder.upsert', operation: 'create' / 'update', args: Reminder }` | 同步后端已经保存的提醒，再显示真实确认；兼容没有 operation 的旧回执 |
| `{ type: 'action', name: 'bots.sync', args: { bots, channels } }` | 同步已保存的角色和成员，不执行模型提供的任意前端动作 |

当前使用 JSON 请求／响应，不做 token 流式输出。前端先显示正在输入，后端调用 DeepSeek，校验并执行受控工具，再返回消息与已完成操作。长回复保留全文并拆成多个气泡。用户在 0.9 秒内连续发送的短消息会合并为一次请求。API key 不由前端聊天参数携带，后端从独立加密配置取得。

## 2. 信息来源：`web/js/services/sources.js`

每个侧栏频道对应一个 adapter：

```js
adapter = { id, channelId, fetch: async () => Item[] }
Item = { id, title, url, publishedAt, kind?, eventAt?, eventEnd?, where?, summary? }
```

- `localAdapters(client)` 读取云峰／ITC 的本机通知 API。`startFeed` 每五秒检查，避免轮询重叠。
- 按 `id + revision` 识别正文或整理结果更新；消息按 `noticeId` 原位更新，避免重复追加同一通知。
- `noticeCopy(item)` 使用已校验摘要，暂无摘要时只提示收录信息；未知发布日期保留为空，不推测年份。
- `kind`：`talk` 报告会、`deadline` 截止或开放时间、`club` 活动、`notice` 其他。
- 用户通过「添加信息来源」建的频道带 `pending: true`，等对应的 adapter 写好后接上即可。

真实抓取应该放在后端（定时任务加解析），前端的 `fetch()` 只调用自家 API，不在浏览器里直接爬网站。

## 3. 本机提醒调度

```js
client.createReminder({ title, dueAt, channelId, noticeId? })
client.updateReminder(id, { title?, dueAt?, status? })
client.reminders()
client.events(cursor)
```

`scripts/notice_ai/runtime.py` 持久化提醒和交付事件，服务每秒检查按到期时间排序的内存最小堆；调度及到点发送不调用模型。前端每两秒同步，并在重新可见时立即同步。提醒保存实际作者 botId，完成／取消后停止，改时间重新挂起；一条通知只保留一个有效提醒。旧 `reminders.js` 的纯函数供旧版测试保留，主界面不再启用页面内调度器。

`systemNotify(title, body)` 仍负责浏览器后台通知，需用户授权；频道静音、主动消息开关和安静时段生效。浏览器关闭时，本机服务记录事件供重新打开补收。原生桌面通知和开机常驻尚未实现。

## 4. 数据

`web/js/store.js` 用 localStorage（`pigeonpal.v1`）保存聊天、界面偏好、通知去重标记及事件游标。提醒权威数据在本机 `runtime-state.json`；旧版浏览器提醒首次连接时按 ID 导入。原通知在 `crawler-state.json`，整理缓存在 `notice-ai.json`。认证与 API 密钥均在仓库外的独立加密目录，不进入 localStorage 或通知导出。

## 5. HTTP 接口

先 `GET /api/bootstrap` 取得 `csrfToken`，其余 API 必须带 `X-PigeonPal-Token`。POST 要求同源 `Origin` 和 `Content-Type: application/json`；前端客户端自动处理。服务不开放跨域访问，不记录请求正文。错误只返回固定错误码。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/ai/settings` | 无 | 当前配置、全局开关、`activeProfileId`、`profiles` 列表；仅返回脱敏 `keyHint` |
| `POST /api/ai/profiles` | `name`, `apiKey`, `model?`, `baseUrl?` | 201，完整设置快照与 `createdProfileId`；首份自动启用，后续保留当前选择 |
| `POST /api/ai/profiles/update` | `id`, `name?`, `apiKey?`, `model?`, `baseUrl?` | 修改指定配置，空 Key 保留旧值；连接参数变化后重置验证状态 |
| `POST /api/ai/profiles/select` | `id` | 切换当前使用配置并即时应用 |
| `POST /api/ai/profiles/delete` | `id` | 删除指定配置；删除当前项后暂停 AI，其他项保留 |
| `POST /api/ai/settings` | `automatic?`, `allowProtected?`, `automaticDeadlines?`；兼容 `apiKey?`, `model?`, `baseUrl?` | 保存全局偏好；旧调用方式修改当前配置，留空 Key 保留旧值 |
| `POST /api/ai/clear` | `{}` | 清除全部 API 配置和偏好，不影响校园绑定、通知及提醒 |
| `POST /api/ai/check` | `profileId?` | 验证指定或当前配置，返回 `{ok, model, profileId, settings}`；不切换使用项 |
| `GET /api/ai/status` | 无 | 处理状态计数、固定错误码和退避时间 |
| `POST /api/chat` | `requestId`, `text`, `channelId`, `history`, `profile`, `noticeId?`, `quotedText?`, `botId?` | `{ events: [...] }`；botId / @ 必须是本频道成员 |
| `GET /api/bots` | 无 | `{ bots, channels }` |
| `GET /api/bots/events` | `after` | `{ events, cursor }`，独立于提醒游标，事件稳定 id 可更新状态 |
| `POST /api/bots/create` | `name`, `role`, `instructions?`, `style?`, `look?`, `channelId?` | 201，`{ bot, channel? }` |
| `POST /api/bots/update` | `id`, `patch` | `{ bot }`，仅允许名字／职责／说明／风格／内置形象 |
| `POST /api/bots/channels/create` | `title`, `memberIds`, `id?`, `kind?` | 201，`{ channel }` |
| `POST /api/bots/channels/members` | `channelId`, `memberIds` | `{ channel }`，主入口保留 Chief |
| `GET /api/notices` | `source?`, `limit`（1–100）, `offset` | `{ items, total, nextOffset }`；不包含全文 |
| `GET /api/notices/detail` | `noticeId` | 正文、附件链接、质量标记和整理结果 |
| `POST /api/ai/process` | `noticeId`, `force?` | 缓存命中返回 200，否则 202 排队 |
| `GET /api/reminders` | 无 | `{ reminders }` |
| `POST /api/reminders/create` | `title`, `dueAt`, `channelId?`, `noticeId?`, `botId?` | 201 和 `{ reminder }`；未指定作者时优先本频道提醒角色 |
| `POST /api/reminders/update` | `id`, `patch` | `{ reminder }` |
| `POST /api/reminders/import` | `reminders`（每批最多 200） | 按 ID 去重导入，不覆盖已有记录 |
| `GET /api/events` | `after`（事件序号，默认 0） | `{ events, cursor }`，每页最多 100 个 |

提醒时间字段为 Unix 毫秒；创建／修改接口也接受带时区的 ISO 8601。通知原站发布日期为日期字符串，可为空；模型提取时间为带时区的 ISO 8601 或仅日期字符串，缺失写 null。事件游标不是时间戳。

API 目录以 schemaVersion 2 加密保存，旧单 Key 配置在读取时兼容迁移，最多 20 份。配置切换和偏好保存即时生效；更换当前配置时丢弃旧通知处理中返回的结果。未启用项的增改与验证不重置模型工作线程。通知整理缓存同时检查正文／版本、模型、地址和提示词版本。遇到损坏缓存先读有效备份，无法恢复时保留文件并暂停处理，不清空原通知。

完整运行条件、DDL 默认规则和本机验收清单见 [ai.md](ai.md)。

多 bot 职责、频道共享历史／私聊隔离、一次交接上限、独立形象及持久化边界见 [multi-bot.md](multi-bot.md)。
