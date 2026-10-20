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
- 个性化推荐：「我 → 用户画像」保存已确认身份和通知偏好，也可通过聊天表达。只停止主动推送有明确排除证据的通知，不确定时保留；「全部通知」可回查并选择「仍然推荐」。画像和推荐缓存保存在本机，见 [画像说明](docs/user-profile.md)。
- 重置界面：设置 → 关于 → 重置界面记录；校园绑定、API 配置、服务端通知与提醒分别管理，不由界面重置删除。

### 桌面版 v0.3.0（2026-10-18）

- **macOS Apple Silicon：已生成 `.dmg`**，通过镜像校验、应用签名结构检查、冻结后端页面/API/退出重启检查；已从镜像启动并显示会话与到期提醒。仅采用 ad-hoc 签名，**尚无 Apple Developer ID 和公证**。
- **Windows x64：尚未产出 `.exe`**。已写好内含 Python 后端的 NSIS 安装包配置与 Windows 构建/安装 smoke 脚本。当前 GitHub OAuth 凭据缺少 `workflow` 权限，因此构建配置先放在 `build/windows-workflow.yml`，它是待启用模板，**目前不会自动运行**。
- **桌面提醒：已接入**。关窗留在托盘；新通知、到期提醒由主进程独立投递，尊重静音和安静时段。点击提醒打开对应频道；取消/延后会在投递前重新核对。Windows 真实弹窗及托盘交互仍待目标系统验收。
- **本轮检查：62 项 JavaScript 检查通过；222 项 Python 检查无失败、其中 1 项因缺少参考仓库而跳过**。均不等同于每位用户的真实校园登录/真实 Windows 运行验收。

安装包不包含开发者的校园凭据、API Key 或私有数据，也不放进 Git 源码历史。构建、数据目录和验收边界见 [桌面版说明](docs/desktop.md)。

### 本地爬虫

统一启动入口会每五分钟检查云峰、ITC、求是学院、本科生院和学在浙大作业。云峰、求是学院、本科生院为公开来源；ITC 与学在浙大复用已绑定的校园账号，分别建立站点 SSO 会话。站点访问失败只影响该来源状态。数据保存在本机 JSON；普通通知可按现有配置交给 DeepSeek 整理，学在浙大作业只在本机直接展示课程、任务、截止和提交状态，不进入模型整理或自动聊天上下文。见 [作业采集说明](docs/homework.md)。聊天调用真实模型，本机服务用本地优先队列调度提醒，到期发送不调用模型。

同一主机请求间隔为 15–30 秒，首轮只检查栏目首页，每轮最多补齐 3 篇正文，不扫描历史分页。求是学院当前使用公开 HTTP 页面，不发送认证 Cookie；跨站链接和直接指向附件的通知仅保存标题、日期和链接，不跟抓或下载。详见 [采集边界](docs/crawling.md)。

2026-10-15 已用正式 CLI 实抓两个新增来源：首页各保存 14 条元信息、各读取 1 篇完整正文，正文失败均为 0；本科生院其中 1 条仅保存链接。剩余正文继续排队，具体请求数见 [验收记录](docs/crawling.md)。

独立公开采集入口仅依赖 Python 标准库，默认不读取认证凭据。受保护来源请使用上面的统一服务，复用本机绑定并分别建立内存站点会话；不要同时启动两个进程写同一数据目录。

```sh
python scripts/pigeonpal_crawler.py run --once  # 单轮采集
python scripts/pigeonpal_crawler.py run         # 持续运行，每站约五分钟检查一次
python scripts/pigeonpal_crawler.py status      # 查看数据和采集状态
```

数据位置、便携目录和导出方法见 [本地爬虫说明](docs/crawling.md)，候选网站与侦查记录见 [来源记录](docs/crawl-sources.md)。

## 当前进度

| 模块 | 当前状态 | 验证边界 |
|---|---|---|
| 单伙伴 UI 与 Markdown | 已实现 | 图标栏、通知列表与详情、可调宽对话栏、形象选择与完整 Markdown；无多 bot 团队界面 |
| 通知与作业抓取 | 已实现，持续核对真实来源 | 云峰、ITC、求是学院、本科生院、学在浙大；临时异常不会永久终止抓取线程 |
| ZJUAM 与站点 SSO | 已修复兼容问题，离线回归通过 | 合法学校 service 回跳只触发官方 CAS 确认；登录成功仍需真实证据，各人账号需自行验证 |
| 作业展示 | 已实现 | 当前学期筛选、默认 5+3 去重清单、自然语言本机查询与独立提示卡；不上传给模型 |
| 提醒调度 | 已实现并离线验证 | 本地优先队列、持久化、修改/取消/延后、重启补收、作业截止前 6 小时复发；到期无需模型 |
| 桌面壳与通知 | 已实现，平台验收进行中 | 托盘后台、单实例、固定界面存储、私有子服务、消息去重、静音；Windows 交互待验证 |
| macOS 安装包 | 已生成 arm64 DMG | 镜像/签名结构/冻结后端检查及镜像内启动；未做 Developer ID 签名与公证 |
| Windows 安装包 | 构建配置就绪，未生成 exe | GitHub workflow 权限受限，模板尚未启用，未声称 Windows 安装通过 |
| API 配置管理 | 已有本机验证 | 多份命名配置、切换、编辑、验证、删除；Key 由本机加密服务保存 |

## 下一步

1. 授予推送凭据所需 `workflow` 权限后，将 `build/windows-workflow.yml` 启用到 `.github/workflows/windows.yml`，在 Windows runner 生成并检查 exe。
2. 用实际 Windows 桌面验证安装、系统弹窗、点击跳转、关窗托盘继续提醒与彻底退出补收。
3. 按 [桌面验收说明](docs/desktop.md) 验证各自校园账号、真实站点和 API；Mac 试用继续核对系统通知权限。
4. 面向更广范围分发前，完成发布者签名与 Mac 公证；当前为内部试用版本。

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
desktop/             Electron 桌面壳、托盘、通知监视与私有后端管理
build/               PyInstaller、安装包 smoke、证书 hook 与待启用 Windows workflow
scripts/
  serve.py           本机 UI、API 和持续爬虫启动入口
  local_auth/        ZJUAM 认证、加密凭据和会话管理
  crawlers/          通知与学在浙大作业采集、初筛、增量队列和 JSON 存储
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
