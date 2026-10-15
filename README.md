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
- 配置模型：左下角「我」→「API 设置」→「添加 API」，为 DeepSeek Key 命名并保存；在「已添加 API」查看、验证和切换当前使用的配置。已有 Key 自动保留。见 [AI 与提醒说明](docs/ai.md)。
- 重置界面：设置 → 关于 → 重置界面记录；校园绑定、API 配置、服务端通知与提醒分别管理，不由界面重置删除。

### 本地爬虫

统一启动入口会每五分钟检查云峰、ITC；ITC 未绑定时等待认证，绑定后独立建立站点 SSO 会话再采集。站点访问失败只影响该来源状态。通知与正文保存在本机 JSON；配置 DeepSeek 后，独立工作线程整理通知并更新真实来源频道。聊天调用真实模型，本机服务负责提醒调度。

独立公开采集入口仅依赖 Python 标准库，默认不读取认证凭据。受保护来源请使用上面的统一服务，复用本机绑定并分别建立内存站点会话；不要同时启动两个进程写同一数据目录。

```sh
python scripts/pigeonpal_crawler.py run --once  # 单轮采集
python scripts/pigeonpal_crawler.py run         # 持续运行，每站约五分钟检查一次
python scripts/pigeonpal_crawler.py status      # 查看数据和采集状态
```

数据位置、便携目录和导出方法见 [本地爬虫说明](docs/crawling.md)，候选网站与侦查记录见 [来源记录](docs/crawl-sources.md)。

## 当前进度

**阶段：已实现本机认证、持续采集、DeepSeek 对话、通知整理和提醒；多 API 配置管理已由用户完成本机验证，其他流程继续按验收清单核对。**

| 模块 | 状态 | 说明 |
|---|---|---|
| 整体 UI | ✅ 完成 | 侧栏、频道、对话、输入框、设置、深色模式、窄屏 |
| 头像动效 | ✅ 完成 | 呼吸、眨眼、跟随鼠标、思考、来消息跳一下、摸摸、转圈 |
| 提醒 | 🟡 待本机验收 | 模型／表单创建、DDL 自动提醒、完成、延后、取消；保持服务运行即可后台记录与补收 |
| 对话 | 🟡 待本机验收 | DeepSeek、上下文和受控工具；左下角 API 设置，配置即时生效 |
| API 配置管理 | ✅ 已完成本机验证 | 已添加／添加独立页签、脱敏 Key 列表、即时切换、编辑、验证、删除及旧配置兼容 |
| 信息来源 | 🟡 待本机验收 | 云峰、ITC 真实通知与摘要进入各自频道，版本缓存和消息去重 |
| 身份认证 | 🟡 已接入 | 沿用队友最新 ZJUAM／SSO 修复；队友已完成本机真实登录和首次 ITC 采集 |
| 候选形象 | ✅ 已接入 | 保留 10 款参考角色的分层 SVG、占位形象和原有草图；最终形象待选定 |
| 后端 | 🟡 待本机验收 | 本机 API、认证、爬虫、模型处理、提醒持久化；原生系统通知和开机服务尚未实现 |
| 桌面壳 | ⬜ 未开始 | Tauri 还是 Electron 待定 |

## 下一步

1. 持续观察各来源采集状态与正文补齐情况。
2. 按 [本机验收清单](docs/ai.md) 验证真实 API、ITC 整理、提醒和异常处理。本次不执行完整测试。
3. 正式形象设计完成后，按 [docs/avatar.md](docs/avatar.md) 接入。
4. 选定桌面壳，接入系统通知和开机运行。

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
  notice_ai/         DeepSeek、加密 API 设置、通知整理、对话工具和本机提醒
docs/
  design.md          设计说明与原则
  interfaces.md      后端接口约定（接模型、抓取前必读）
  avatar.md          自定义形象的接入方式
  authentication.md  本机认证、凭据保存和迁移
  crawling.md        采集命令和通知数据说明
  ai.md              API 设置、对话、DDL 规则和本机验收步骤
tests/               单元测试
archive/ui-v0/       已废弃的第一版原型，仅留档
```

## 协作约定

- 不要直接推送到 `main`：新建分支，提 PR，至少一人看过再合并。
- 提交前跑一遍 `npm test`。
- 界面只通过 `services/` 的接口和后端打交道，接口约定见 [docs/interfaces.md](docs/interfaces.md)。如果要改接口，请先在 PR 里说明。
- **API key、校园凭据与本机密钥不要提交进仓库。** 校园绑定默认保存在仓库外的 `~/.pigeonpal/auth`，认证文件不得加入通知导出或日志。
