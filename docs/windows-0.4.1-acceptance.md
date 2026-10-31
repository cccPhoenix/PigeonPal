# PigeonPal v0.4.1 Windows 构建与验收记录

日期：2026-10-31（北京时间）。目标：Windows 10/11 x64；实际构建和自检主机为 Windows 11 x64，NT 10.0.26300。

**结论：安装包构建成功，冻结后端与桌面冒烟通过；原样 main 的 JavaScript 测试有 2 项失败，本轮尚未完整通过验收。**

> 本文对应本轮在本机重新构建的候选包。本次仅提交验收文档，未上传安装包或替换现有 v0.4.1 Release 附件；下列大小和校验和不代表现有 Release 中的 Windows 包。

## 产物与来源

- 安装包：`dist/PigeonPal-Setup-0.4.1-x64.exe`，**123,346,845 字节**。
- SHA256：`84d8c66a7b9504f78b76179ee39951fa4a0ed53b05be06c56ca05d2be404b749`。
- 构建源码：`b31edac32c5efefbc3ddeec5b4e9d015cb932bc7`。构建前已执行 `git fetch`、`git checkout main`、`git pull --ff-only`，确认 HEAD 与当时的 `origin/main` 一致。
- 包含学园来源（#11）、桌面同步/通知加固、分类栏与排序修复（`2197319`）以及 tip 的 loading bar 提交。
- `package.json`、`package-lock.json` 顶层与根包版本均为 **0.4.1**；未修改运行时代码、测试或依赖锁文件，未升版。
- 同时生成 `latest.yml`、`PigeonPal-Setup-0.4.1-x64.exe.blockmap` 和 `desktop-self-check-windows.json`。
- Windows 图标沿用仓库内 `build/windows-icon.ico`。未使用 Mac 冻结后端，未构建或修改 Mac 产物。

## 按顺序实际执行

| 命令 | 实际结果 |
| --- | --- |
| `npm ci` | 成功；锁文件未变 |
| `python -m pip install -r requirements-build.txt` | 成功；独立 Python 3.12.10 x64 环境 |
| `npm test` | **173 项：171 通过、2 失败、0 跳过**；2.642 s |
| `python -m unittest discover -s tests -p "test_*.py"` | **301 项：300 通过、0 失败、1 跳过**；30.971 s |
| `npm run dist:win` | 成功；设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，命令自带 `--publish never` |
| `python build/smoke_backend.py build/backend-dist/PigeonPalService/PigeonPalService.exe` | 通过；46 个网页资源与源码逐字节一致 |
| `python build/smoke_desktop.py dist/win-unpacked/PigeonPal.exe dist/desktop-self-check-windows.json` | 通过；`ok: true`，16 项检查 |

Python 跳过项为 `tests/test_cas_protocol.py` 中依赖仓库外旁置参考源码的 parity 检查；未将跳过项计作通过。

`npm ci` 本轮 audit 输出为 17 项（16 moderate、1 high）。未执行自动修复或依赖升级。

## JavaScript 失败定位

两项失败均保留原始结果，没有修改测试以取得通过状态。以下原因由失败输出与对应源码核对得出。

1. `tests/notice-rail.test.mjs:185`：`homework view shows the learning platform snapshot and switches back to campus notices`。
   - 夹具中的截止时间固定为 `2026-10-30T20:00:00+08:00`。10 月 31 日运行时，生产逻辑过滤了已过期作业，测试仍断言该作业可见。
   - 建议后续为该测试设置局部固定时钟，避免依赖真实日期；本轮没有调整系统时钟或修改测试。
2. `tests/user-profile.test.mjs:252`：`recommendation scope preserves the chosen sort and all view exposes excluded notices and reasons`。
   - 断言预期 `old`（priority 90）排在 `new`（priority 10）前；当前 store 默认 `noticeSort` 为 `newest`，实际先显示发布时间较新的 `new`。
   - 建议后续在该测试显式选择 `oldest`，验证推荐范围切换保留所选排序，再验证改为 `newest` 后顺序逆转；本轮未应用该修改。

## 冻结后端与桌面检查

所有冒烟使用全新临时目录和离线测试数据，未读取正式用户凭据、API Key 或用户数据，未调用真实模型或校园网络任务。

- 冻结后端：内置 CA、TLS 验证与主机名检查、空账号、测试 API 设置加密保存、画像与提醒跨后端进程重启持久化、离线到期和正常退出均通过。
- 桌面报告：`ok: true`、版本 `0.4.1`、平台 `win32`，16 项检查全部通过。覆盖空账号启动、学园菜单保存与来源筛选、画像/日历/提醒表单、隐藏窗口期间提醒到期、重新显示、重载持久化、页面导航、上下文隔离和更新设置。
- 首次界面就绪 946 ms；7 次切页为 4、18、47、14、7、14、7 ms。这是本机离线样本，不是跨设备性能保证。
- 批量渲染：100 条通知与 55 个提醒合并为 1 次列表渲染，隐藏日历 0 次渲染，伙伴节点保留；本机样本 33 ms。
- 图标：16、20、24、32、40、48、64、128、256 px 九帧像素全部不透明。安装器、解包主程序和两个冻结后端副本中的九帧资源均与源 ICO 逐字节一致。
- 架构：主程序、冻结后端和内置 `python312.dll` 的 PE Machine 均为 AMD64（0x8664）。NSIS 引导器本身为 0x14c，包内应用和服务为 x64。
- `app.asar` 中的 8 个桌面 CJS 和 2 个图标 PNG 与仓库逐字节一致，内置版本为 0.4.1；未发现 `auth`、`data`、`.env`、`.auth-key` 路径。
- 冒烟结束后未发现本轮解包应用或后端进程遗留。

## 发布前附加校验

- `npm run release:verify`：版本一致，存在对应发布说明。
- `python build/smoke_source.py`：源码后端冷启动、ready 握手和父管道关闭后退出通过。
- `npm run test:updates`：loopback 合成更新的 manifest 查询、显式下载、缓存与 SHA512 损坏拒绝通过；未执行安装器。
- `node build/release.cjs stage windows`：核验 manifest 的版本、安装包名、字节大小与 SHA512，通过后在本地 `dist/release-0.4.1-windows/` 暂存仓库白名单的四件附件和 `SHA256SUMS-windows.txt`。暂存副本与原件逐字节一致。

本地暂存校验仅检查对应产物与桌面报告，不能代替前述失败的 JavaScript 测试；本轮没有上传这些文件。

## 签名与未验证事项

`Get-AuthenticodeSignature` 实测安装包、Electron 主程序和冻结后端均为 **NotSigned**。构建日志中的 signing 步骤不代表已有发布者签名，未声称通过 SmartScreen 信誉检查。

本机不是一次性 VM/runner，未运行 `build/smoke_windows.ps1 -DisposableMachine`。以下内容仍需另行验收：

- 实际安装向导、静默安装、升级、卸载、快捷方式和开始菜单注册。
- 系统通知实际显示、点击返回和托盘鼠标操作；`nativeNotificationSupported: true` 仅表示 API 支持。
- 通知权限、免打扰、休眠/恢复、断网恢复，以及 Windows 10 和其他 Windows 版本的兼容性。
- 使用者真实校园账号的登录/同步，以及真实模型 API 请求。

本次仅提交并推送本验收文档；未创建 tag、上传附件或发布 Release，Mac 附件保持不变。

## 构建工具

- Node.js 24.14.0、npm 11.9.0、Python 3.12.10 x64、PyInstaller 6.22.3。
- Electron 44.9.0、electron-builder 26.15.3。
- cryptography 50.0.2、cffi 2.1.1、certifi 2026.7.22。
