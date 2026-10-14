# PigeonPal

桌面端的校园伙伴。它有一个固定身份（默认叫「小浙」），会盯着学校各个网站的消息，有新动态就主动告诉你，也能帮你记提醒。目标体验是**像在和一个真人聊天**，而不是在用 AI 工具。交互参考 [DS Bot](https://github.com/Fei2411/DeepSeek-Bot)。

## 快速开始

需要 Python 3.10+；`npm` 入口另需 Node 18+。首次安装认证模块的加密依赖，无需构建前端。

```sh
python -m pip install -r requirements.txt
npm run dev    # 本机 UI、认证服务和持续爬虫：http://127.0.0.1:4174
npm test       # 前端单元测试
```

- 无需 Node 的启动方式：`python scripts/serve.py`。按 Ctrl+C 停止。
- 绑定校园账号：左下角「我」→「身份认证」，或点击来源卡的「去认证」。在弹窗中自行输入 ZJUAM 账号密码；直接验证 ZJUAM 登录成功后加密保存，不访问其他网站作为验证条件。见 [身份认证说明](docs/authentication.md)。
- 形象实验室：http://127.0.0.1:4174/lab.html
- 重置演示界面：设置 → 关于 → 清空本地数据；校园绑定需在身份认证中单独解除，通知文件也不会由此删除。

### 本地爬虫

统一启动入口会每五分钟检查云峰、ITC；ITC 未绑定时等待认证，绑定后独立建立站点 SSO 会话再采集。站点访问失败只影响该来源状态。通知与正文保存在本机 JSON，不接 LLM。来源卡显示真实采集状态，聊天和频道消息仍是演示内容。

独立公开采集入口仅依赖 Python 标准库，默认不读取认证凭据。受保护来源请使用上面的统一服务，复用本机绑定并分别建立内存站点会话；不要同时启动两个进程写同一数据目录。

```sh
python scripts/pigeonpal_crawler.py run --once  # 单轮采集
python scripts/pigeonpal_crawler.py run         # 持续运行，每站约五分钟检查一次
python scripts/pigeonpal_crawler.py status      # 查看数据和采集状态
```

数据位置、便携目录和导出方法见 [本地爬虫说明](docs/crawling.md)，候选网站与侦查记录见 [来源记录](docs/crawl-sources.md)。

## 当前进度

**阶段：UI 原型、本地通知采集和身份认证已接入；聊天与通知消息流仍待接入。**

| 模块 | 状态 | 说明 |
|---|---|---|
| 整体 UI | ✅ 完成 | 侧栏、频道、对话、输入框、设置、深色模式、窄屏 |
| 头像动效 | ✅ 完成 | 呼吸、眨眼、跟随鼠标、思考、来消息跳一下、摸摸、转圈 |
| 提醒 | ✅ 可用 | 新建、到点消息、完成、稍后提醒；**只在页面打开时生效** |
| 对话 | 🟡 演示 | 关键词匹配的固定话术，**没有接任何 AI 模型** |
| 信息来源 | 🟡 部分接入 | 云峰、ITC 来源卡显示真实采集状态；频道消息仍是演示数据 |
| 身份认证 | 🟡 待本人验收 | 本机 ZJUAM 认证、加密绑定、自动续期与解绑已实现；本轮真实登录需用户在 UI 验收 |
| 正式形象 | ⬜ 待设计 | 现在是占位形象，另有两版鸽子草图可在设置里切换 |
| 后端 | 🟡 起步 | 本机 API、认证和持续爬虫已加入；模型调用、通知消息流、常驻提醒、系统通知待实现 |
| 桌面壳 | ⬜ 未开始 | Tauri 还是 Electron 待定 |

## 下一步

1. 在认证弹窗完成用户本人 ZJUAM 登录验收，再分别确认各来源的真实采集状态。
2. 将本地爬虫的通知正文和增量消息按 adapter 接口接入前端；模型暂不接入。
3. 正式形象设计完成后，按 [docs/avatar.md](docs/avatar.md) 接入。
4. 选定桌面壳，替换页面内的提醒调度。

## 代码结构

```
web/                 前端（浏览器直接运行）
  js/main.js         总装：把界面、状态、服务接起来
  js/store.js        状态与本地保存
  js/reminders.js    提醒规则（纯函数）
  js/ui/             界面组件
  js/mark/           头像组件与形象
  js/services/       对话 / 来源 / 调度 / 本机认证接口
  css/               tokens（主题变量）· mark（头像动效）· app（布局）
scripts/
  serve.py           本机 UI、API 和持续爬虫启动入口
  local_auth/        ZJUAM 认证、加密凭据和会话管理
  crawlers/          两站采集、初筛、增量队列和 JSON 存储
docs/
  design.md          设计说明与原则
  interfaces.md      后端接口约定（接模型、抓取前必读）
  avatar.md          自定义形象的接入方式
  authentication.md  本机认证、凭据保存和迁移
  crawling.md        采集命令和通知数据说明
tests/               单元测试
archive/ui-v0/       已废弃的第一版原型，仅留档
```

## 协作约定

- 不要直接推送到 `main`：新建分支，提 PR，至少一人看过再合并。
- 提交前跑一遍 `npm test`。
- 界面只通过 `services/` 的接口和后端打交道，接口约定见 [docs/interfaces.md](docs/interfaces.md)。如果要改接口，请先在 PR 里说明。
- **API key、校园凭据与本机密钥不要提交进仓库。** 校园绑定默认保存在仓库外的 `~/.pigeonpal/auth`，认证文件不得加入通知导出或日志。
