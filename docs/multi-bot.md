# Chief 与频道协作

用户已确认：默认团队是 Chief、通知鸽和提醒鸽；也可按需求添加其他职责的 bot。同一频道可以邀请多个 bot，支持 @ 指定、简单交接、真实轻量状态提示，以及每个 bot 独立更换形象。沿用现有 DeepSeek 配置和本地服务，不引入第三方依赖。最终真实效果由用户验收，不运行完整测试或真实模型请求。

## 默认分工

- Chief：日常聊天、详细解答、总结和写作润色，统筹创建／邀请／交接；普通请求只有一位回应，不让三个 bot 轮流重复回答。
- 通知鸽（news）：整理和推送抓取到的校园通知，保留来源链接；爬虫和通知整理工作线程统一运行，角色数量不会增加抓取次数。
- 提醒鸽（reminder）：设置、修改和发送提醒。表单和自动 DDL 优先归给频道内的提醒角色；既有提醒保留原作者。
- 新安装默认创建上述三位及专职私聊；旧状态只补缺少的默认职责及必要频道成员，不重置已有 bot、形象或历史。三个角色共享当前选中的 API 配置；切换 API 仍使用队友的多 Key 管理。

## 责任与范围

- 后端维护真实 bot 名字、职责、风格、频道成员、每 bot/channel 历史和任务状态；创建、成员变更和任务事件持久化在本机 bots-state.json。
- 前端本机保存每个 bot 的形象覆盖配置（内置分层 SVG 或上传图片），按稳定 bot ID 解析，在气泡、侧栏、成员展示和协作提示中一致更新。Chief 复用原 profile 的名字和形象；不重置旧聊天、昵称、提醒或密钥配置。
- Chief 可调用受控工具创建 bot、把 bot 加入当前频道、向频道中的专职 bot 委派任务。用户也能通过界面配置或 @。不赋予任意代码、文件或网站访问能力。
- 同一请求默认仅一位回应；有 @ 按目标路由，否则私聊对应 bot／频道 Chief／首位成员回应。最多一个直接交接、共三轮工具调用，避免递归讨论。专职 bot 不能再委派或创建其他 bot。
- Chief 收到未 @ 的明确提醒事项或通知查询，会先按本地意图规则交接给频道内的 reminder／news 成员，由子 bot 最终回答，无需先让 Chief 调用一次模型。提醒过程中的简短确认和补充时间继续交给刚才的提醒角色。明确 @／botId 和私聊优先；写作、功能说明、角色管理和难以明确分类的任务保留给 Chief 判断。角色不在频道时不擅自加人。
- 来源频道中的提醒事项可使用当前来源的有限通知事实快照，仍不授予提醒角色通知查询工具；找不到事项或日期不确定时追问。资料快照来自本机已抓取的数据，不增加抓取或模型请求。
- 成功事件来自实际配置保存、成员加入、模型有效回复或提醒持久化。模型文字不产生成功状态。重试按 requestId 幂等；部分失败保留已保存操作并标明失败。任务中断恢复显示待确认，不虚构完成。
- 既有爬虫仍统一运行。通知作者按频道中 news 角色成员选择，否则 Chief；不让每个 bot 重复抓同一网站。

## 前后端契约

Bot: `{ id, name, role, instructions, style, look, isChief, createdAt }`。id 为 `chief` 或 `bot-` 加短标识；role 为 `general/news/reminder/writer/planner`。图像数据仅在本机前端形象配置中，不发给模型。

Channel: `{ id, kind: 'group'|'dm'|'source'|'bot', title, memberIds, botId? }`。保留 `bot`、`src-itc`、`src-yunfeng`，新增 `src-qsxy`、`src-bksy`。新群使用 `src-group-...`，私聊使用 `src-dm-<botId>`，兼容已有提醒渠道验证。bot 主入口始终含 Chief；成员必须对应实际存在的 bot。来源扩展时只补缺失频道及默认成员，不重置已有频道成员；后端启动即补齐，自动提醒不依赖先打开页面。

- `GET /api/bots` → `{ bots, channels }`
- `POST /api/bots/create` body `{ name, role, instructions?, style?, look?, channelId? }` → `{ bot, channel? }`
- `POST /api/bots/update` body `{ id, patch: { name?, role?, instructions?, style?, look? } }` → `{ bot }`
- `POST /api/bots/channels/create` body `{ title, memberIds, id?, kind? }` → `{ channel }`
- `POST /api/bots/channels/members` body `{ channelId, memberIds }` → `{ channel }`
- `GET /api/bots/events?after=N` → `{ events, cursor }`，独立于提醒 eventCursor。

Team event: `{ id, sequence, channelId, at, kind:'activity'|'text', activity?, text?, botId? }`。activity 沿用 `{ type, actors:[{id,name,look}], detail? }`，同 id 的 processing/completed/failed 更新同一行。joined/handoff 只在操作实际成立后写入。

界面不再显示普通回复的 processing／completed「本次回复」状态，底层回执仍保留以防重复执行；失败／中断仍可见。真实交接短暂显示「Chief 正在唤醒 子 bot」和双方形象动作，随后收为静态交接记录。实际提醒保存确认保留具体时间，不把模型的追问标为提醒已设置。

`POST /api/chat` 增加 `botId?`，仅允许当前频道成员。响应继续 `{ events }`，message/action/activity 事件可以带 `botId`，不允许模型伪造。真实任务处理和交接事件写 team event 流，前端边轮询边显示；bot 回复同样写 team text 事件并返回稳定 id，以便响应和轮询去重。

## 前端内部契约

- `store.syncBots({ bots, channels })`：合并真实 bot/频道元数据，保留来源卡设置和已有消息；新增消息容器；发 `bots` 事件。
- `store.bot(id)` 返回 bot，`state.bots` 为数组，`state.teamCursor` 独立保存。
- `store.botAppearance(actor)`：按 id 读取当前名字与本机形象覆盖；Chief 优先兼容原 profile。
- `store.setBotAppearance(id, {name?,look?,image?})`：仅改变本机形象；真实名字由 UI 同步 backend。
- `store.setTeamCursor(cursor)`；普通消息携带可选 `botId`。系统提示不进入模型历史。
- ApiClient 增加 `bots/createBot/updateBot/createBotChannel/setBotMembers/botEvents`，参数对应上述 HTTP body。
- `createAIChat.respond` 允许 `botId`；后端 activity/message id/botId 原样转发，兼容旧服务；不要再重复生成一份客户端任务状态。

## 验收

离线定向检查覆盖真实创建和成员校验、失败无成功事件、@ 成员验证、委派上限、请求幂等、角色历史隔离、头像独立持久化和旧配置迁移。源码/语法/差异检查后，用户启动本机服务验收 Chief 创建写作鸽、邀请进频道、@ 润色、提醒、失败提示、刷新去重和分别换头像。

## 提醒与调用成本

提醒记录以 `runtime-state.json` 为持久化依据，内存最小堆按 `dueAt` 排序；重启从文件重建。创建、改时间、延后、完成和取消会更新调度，到期只取队首符合条件的记录。交付事件保存成功才标记已发送，写入失败可以重试。这里的优先级就是到期时间，不额外实现任务重要性排序。

到点提醒直接使用程序模板和用户称呼，不调用模型。界面表单设置提醒也不调用模型。直接发给提醒角色（私聊或 @）的严格单项指令如「10分钟后提醒我喝水」「1小时后提醒我交作业」，整数且间隔不超过七天，也可在本地保存后模板确认，无需配置模型。模糊时间、多项任务或其他自然语言仍交模型理解；Chief 的真实交接也可能多一次请求。小堆优化的是无效扫描，API 成本取决于实际模型请求、上下文长度和输出量，不能把堆本身说成节省 token。

提醒仍需要本机服务运行；电脑关机或休眠期间无法准时推送，恢复后补处理。后台消息／交付事件持久化不等于关闭浏览器后能弹出原生通知。

## 存储边界

- 数据目录默认 macOS `~/Library/Application Support/PigeonPal/data`（其他系统和自定义目录见 [本地爬虫说明](crawling.md)）。`bots-state.json` 保存角色、频道、共享／私聊上下文、协作事件和请求回执；`runtime-state.json` 保存提醒和交付事件，原子保存并保留备份。
- 形象覆盖和上传图片留在当前浏览器 `pigeonpal.v1`，按 bot id 独立保存，不发送给模型；换浏览器不会自动同步上传图片。
- 已结束的协作请求回执限制为最近 500 条，清理时一并删除关联操作记录，进行中的请求保留。超过保留窗口的旧请求 id 不再保证重试幂等。
- 重置界面记录保留团队事件读取位置和重置时间，防止服务端旧回复重新补入已清空界面；后端角色、上下文、提醒和 API 配置仍保留。
