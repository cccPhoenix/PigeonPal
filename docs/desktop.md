# 桌面版：构建与验收

目标系统：Windows 10/11 x64。安装包自带 Electron、Python 后端和加密依赖，同学无需安装开发工具。每个人在自己的电脑绑定 ZJUAM、填写自己的模型 API key；安装包不包含开发者的账号、Key、通知数据或会话。

## 使用

安装 `PigeonPal-Setup-<版本>-x64.exe` 后从开始菜单打开鸽友。首次绑定校园账号后，ITC 和学在浙大分别建立官方站点会话；三个公开来源不要求登录。模型 Key 未设置时仍可查看原始通知和本机作业、使用表单设置提醒；自然语言对话/提醒理解需要配置模型。

关闭窗口会收进系统托盘，抓取和提醒继续运行。双击托盘图标或点击通知恢复窗口；右键托盘选择“退出鸽友”才停止。关机、休眠、断网或彻底退出期间不能保证实时抓取/弹窗，重新运行后补收仍待处理的到期提醒。默认不修改开机启动设置。

“设置 → 主动消息”可以关闭系统通知、单独静音某个来源或设安静时段。安静时段按北京时间判断；消息仍保留，安静期间不弹通知，也不在结束时集中补弹。首次成功同步的历史通知只导入界面；之后新到达的通知会弹窗。模型整理同一通知的状态变化不会重复弹窗。提醒的弹窗独立于网页计时器，失败可重试；系统免打扰/通知权限仍可能屏蔽 OS 弹窗，应用无法保证绕过它。

点击弹窗进入对应频道；作业信息保持本机处理，模型不会收到自动作业清单或作业提醒内容。桌面窗口使用固定 `pigeonpal://app` 来源保存界面记录，后台每次使用随机 loopback 端口，不会占用开发网页版的 4174 端口。

## 数据与更新

桌面数据根目录：Windows 为 `%APPDATA%\PigeonPal`，macOS 为 `~/Library/Application Support/PigeonPal`。
- `data/`：通知、提醒、模型整理缓存。
- `auth/`：本机加密校园凭据与 API 配置，不可向他人分发。
- `desktop-notifications.json`：通知去重 ID 和免打扰偏好，不保存通知正文。
- `Partitions/pigeonpal/`：界面记录和偏好（Chromium 持久 session）。

升级安装不会删除数据；卸载默认也保留用户数据。如需换电脑，请分别管理凭据与普通数据，勿将整个用户目录加入仓库或公开备份。Windows 桌面版与开发网页版默认数据目录不同；macOS 的通知/提醒 data 目录可能与原网页服务共用，写入锁会阻止它们同时运行。桌面认证目录为上述根目录下的 auth，旧网页版的 ~/.pigeonpal/auth 不会自动复制，首次桌面使用可能需重新绑定。界面记录属于新的固定来源，安装包始终不携带任何开发者私有数据。

## 开发与构建

网页开发入口保持 `npm run dev`。桌面开发需要 Node 22.12+、Python 3.12，运行：

```sh
npm ci
python -m pip install -r requirements-build.txt
npm run desktop
```

`npm run desktop -- --offline` 不启动抓取/模型后台任务，本地提醒调度仍运行。开发验收可以设置 `PIGEONPAL_USER_DATA` 为临时目录，正式安装包不接受这个路径覆盖。

在 **Windows x64** 上构建：

```sh
npm run dist:win
python build/smoke_backend.py build/backend-dist/PigeonPalService/PigeonPalService.exe
```

产物在 `dist/`。冻结后端和解包应用可安全使用临时数据验收：

```powershell
python build/smoke_desktop.py dist/win-unpacked/PigeonPal.exe dist/desktop-self-check-windows.json
```

`build/smoke_windows.ps1` 会静默安装并修改该用户的应用注册，只在一次性 Windows VM / runner 执行。本机非 runner 必须显式传入 `-DisposableMachine`；不要在有个人旧版安装的电脑上无提示运行此安装脚本。

PyInstaller 在当前操作系统冻结 Python，macOS 产物不能作为 Windows exe；Windows workflow 必须真正运行并通过，不能只靠配置文件宣称安装包完成。本版由 Windows 同学在本机运行 `npm ci`、`python -m pip install -r requirements-build.txt`、离线测试与 `npm run dist:win`，再运行下方 smoke。`build/windows-workflow.yml` 保留为未启用模板；当前没有活动 Windows Actions 工作流，不需要为了本机打包补充 workflow 权限。Windows exe 在真实构建、检查成功后再上传，不能把模板或 Mac 检查作为 Windows 产物。

Windows 构建暂未接入发布者代码签名证书；第一版按内部试用包分发，不宣称已签名或已通过系统信誉检查。为同学大规模发布前，需完成下面实际验收。

## 验收边界

自动检查覆盖：离线来源解析/增量/认证边界、提醒队列和持久化、取消/延后/恢复、原生通知基线/去重/静音/积压、私有子服务生命周期、冻结资源、Windows 安装/启动。它们不证明真实校园账号登录成功，也不证明 Windows 的实际通知已显示。

Windows 交互验收：安装后的开始菜单/图标、首次登录与正常五分钟同步、新通知系统弹窗、5 秒演示提醒、点击跳回频道、关窗托盘继续提醒、完全退出再启动补收、修改/取消提醒不误发、安静时段和系统通知开关。Windows runner 的窗口 smoke 不代替真实登录桌面上的通知展示与点击。

## macOS Apple Silicon

在 Apple Silicon Mac 上运行 `npm run dist:mac`，产出 `PigeonPal-<版本>-mac-arm64.dmg`，包括本机架构的冻结 Python 后端。此版使用 ad-hoc 本机签名，没有 Apple Developer ID 或公证，不宣称已获 Apple 公证；正式广泛分发仍需开发者签名/公证。Windows 验收仍必须独立进行。

2026-10-18 当前验证：macOS arm64 DMG 已通过 `hdiutil verify`、`codesign --verify --deep --strict` 和冻结后端 smoke（包括外部证书路径无效时使用打包 CA roots），并已从挂载镜像启动实际界面和显示到期提醒。仍未宣称 Windows 安装或实际系统 toast 已通过。


## v0.3.1（2026-10-20）发布验收

纳入三栏界面、日历、侧栏用户画像、通知推荐与列表对齐。版本号由 package.json / package-lock.json 统一维护。

`--self-check` 是显式离线验收模式：自动创建空的临时用户目录，忽略任何现有数据路径，既不读取正式账号也不启动校园/模型网络任务。检查界面首次启动、身份和 Key 为空、画像表单、提醒表单、关窗后提醒到期、恢复窗口、重载保存和页面切换，随后退出。此模式关闭系统弹窗，仅确认本地事件生成；不宣称操作系统显示了 toast。

```sh
python build/smoke_backend.py build/backend-dist/PigeonPalService/PigeonPalService
python build/smoke_desktop.py 'dist/mac-arm64/PigeonPal.app/Contents/MacOS/PigeonPal' dist/desktop-self-check-mac.json
```

Windows 由 `build/smoke_windows.ps1` 检查静默安装，并使用同一 smoke_desktop.py 检查安装后的 PigeonPal.exe；强制父进程退出检查额外传入 `--self-check --self-check-hold` 保持隔离窗口，避免自检自动退出造成竞态；脚本对临时目录做严格清理，正式数据不被覆盖。冻结后端检查还核对全部网页资源与当前源码一致、无外部证书路径时的 CA 信任，以及画像/提醒在重启后的持久化。

安装包、SHA256SUMS 与具体平台验收报告放在对应 GitHub Release。没有 Developer ID / Windows 发布者证书；真实校园账号、模型效果、系统免打扰和 Windows 交互弹窗仍由本人在目标环境核对。源码检查和离线计时不代表所有机器与网络环境。

### 本轮已确认的 macOS 结果

Apple Silicon 本机的冻结服务检查通过：39 个网页资源与源码逐字节一致，空账号、加密 API 配置保存/重启读取、画像/提醒持久化、离线到期和正常退出均通过。DMG 校验及应用深层签名结构检查通过；从镜像复制到包含中文和空格的临时安装路径后，应用的 10 项首次启动检查通过。

计时是本机离线样本，不是跨设备性能保证。系统通知权限/实际弹窗、真实校园数据和真实模型仍需使用者验证；Windows 尚未构建，本轮不能标记为通过。
