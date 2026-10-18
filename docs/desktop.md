# Windows 桌面版

目标系统：Windows 10/11 x64。安装包自带 Electron、Python 后端和加密依赖，同学无需安装开发工具。每个人在自己的电脑绑定 ZJUAM、填写自己的模型 API key；安装包不包含开发者的账号、Key、通知数据或会话。

## 使用

安装 `PigeonPal-Setup-<版本>-x64.exe` 后从开始菜单打开鸽友。首次绑定校园账号后，ITC 和学在浙大分别建立官方站点会话；三个公开来源不要求登录。模型 Key 未设置时仍可查看原始通知和本机作业、使用表单设置提醒；自然语言对话/提醒理解需要配置模型。

关闭窗口会收进系统托盘，抓取和提醒继续运行。双击托盘图标或点击通知恢复窗口；右键托盘选择“退出鸽友”才停止。关机、休眠、断网或彻底退出期间不能保证实时抓取/弹窗，重新运行后补收仍待处理的到期提醒。默认不修改开机启动设置。

“设置 → 主动消息”可以关闭系统通知、单独静音某个来源或设安静时段。安静时段按北京时间判断；消息仍保留，安静期间不弹通知，也不在结束时集中补弹。首次成功同步的历史通知只导入界面；之后新到达的通知会弹窗。模型整理同一通知的状态变化不会重复弹窗。提醒的弹窗独立于网页计时器，失败可重试；系统免打扰/通知权限仍可能屏蔽 OS 弹窗，应用无法保证绕过它。

点击弹窗进入对应频道；作业信息保持本机处理，模型不会收到自动作业清单或作业提醒内容。桌面窗口使用固定 `pigeonpal://app` 来源保存界面记录，后台每次使用随机 loopback 端口，不会占用开发网页版的 4174 端口。

## 数据与更新

Windows 桌面数据根目录：`%APPDATA%\PigeonPal`。
- `data/`：通知、提醒、模型整理缓存。
- `auth/`：本机加密校园凭据与 API 配置，不可向他人分发。
- `desktop-notifications.json`：通知去重 ID 和免打扰偏好，不保存通知正文。
- `Partitions/pigeonpal/`：界面记录和偏好（Chromium 持久 session）。

升级安装不会删除数据；卸载默认也保留用户数据。如需换电脑，请分别管理凭据与普通数据，勿将整个用户目录加入仓库或公开备份。开发网页版默认目录和桌面目录不同，不会自动复制开发者私有数据给安装包。

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

产物在 `dist/`。PyInstaller 在当前操作系统冻结 Python，macOS 产物不能作为 Windows exe；Windows workflow 必须真正运行并通过，不能只靠配置文件宣称安装包完成。当前凭据缺少 workflow 权限，GitHub 拒绝推送活动 workflow。因此 `build/windows-workflow.yml` 仅为模板，尚未启用、未运行，Windows exe 仍未生成。取得 workflow 权限后移到 `.github/workflows/windows.yml`，配置对应分支触发，在 Windows runner 编译、离线回归、冻结后端 smoke、静默安装/窗口启动/父进程强制退出 smoke，通过后上传 exe 与 SHA256SUMS。

Windows 构建暂未接入发布者代码签名证书；第一版按内部试用包分发，不宣称已签名或已通过系统信誉检查。为同学大规模发布前，需完成下面实际验收。

## 验收边界

自动检查覆盖：离线来源解析/增量/认证边界、提醒队列和持久化、取消/延后/恢复、原生通知基线/去重/静音/积压、私有子服务生命周期、冻结资源、Windows 安装/启动。它们不证明真实校园账号登录成功，也不证明 Windows 的实际通知已显示。

Windows 交互验收：安装后的开始菜单/图标、首次登录与正常五分钟同步、新通知系统弹窗、5 秒演示提醒、点击跳回频道、关窗托盘继续提醒、完全退出再启动补收、修改/取消提醒不误发、安静时段和系统通知开关。Windows runner 的窗口 smoke 不代替真实登录桌面上的通知展示与点击。

## macOS Apple Silicon

用户新增要求：同时提供 `.dmg`。在 Apple Silicon Mac 上运行 `npm run dist:mac`，产出 `PigeonPal-<版本>-mac-arm64.dmg`，包括本机架构的冻结 Python 后端。此版使用 ad-hoc 本机签名，没有 Apple Developer ID 或公证，不宣称已获 Apple 公证；正式广泛分发仍需开发者签名/公证。Windows 验收仍必须独立进行。

2026-10-18 当前验证：macOS arm64 DMG 已通过 `hdiutil verify`、`codesign --verify --deep --strict` 和冻结后端 smoke（包括外部证书路径无效时使用打包 CA roots），并已从挂载镜像启动实际界面和显示到期提醒。仍未宣称 Windows 安装或实际系统 toast 已通过。
