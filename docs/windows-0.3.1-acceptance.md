# PigeonPal v0.3.1 Windows 构建与验收记录

> 本文记录 2026-10-20 的原始构建。2026-10-21 不透明图标修订后的安装包与摘要见 [Windows 图标修订记录](windows-0.3.1-icon-update.md)。

日期：2026-10-20（北京时间）。目标：Windows 10/11 x64 试用包。

## 产物与来源

- 安装包：`PigeonPal-Setup-0.3.1-x64.exe`，122,335,730 字节。
- SHA256：`f78af8f26db689af58b575a32fc42b37ec343f4dcda88b8ab4493d9513944ff5`。
- 应用源码：最新 main `8c5b5b2b6ac654a0a4405a3644ae4f30befcf60b`，版本 0.3.1。本次未修改运行时代码或依赖锁文件；文档通过独立 PR 提交。
- 构建主机：Windows x64，NT 10.0.26300.9711。没有使用 Mac 冻结后端，也没有使用 Windows Actions runner。
- 工具：Node.js 24.14.0、npm 11.9.0、Python 3.12.10 x64、PyInstaller 6.22.3、electron-builder 26.15.3。
- 内置 Electron 44.9.0、Python 3.12.10、cryptography 50.0.2、cffi 2.1.1、certifi 2026.7.22。使用者无需另装 Python、Node.js 或开发环境。
- `PigeonPal.exe`、`PigeonPalService.exe`、内置 `python312.dll` 的 PE 架构均为 AMD64（0x8664）。

## 按顺序实际执行

| 命令 | 实际结果 |
| --- | --- |
| `npm ci` | 成功；保持锁文件不变 |
| `python -m pip install -r requirements-build.txt` | 成功；使用独立 Python 3.12 x64 环境 |
| `npm test` | 116/116 通过 |
| `python -m unittest discover -s tests -p "test_*.py"` | 276 项，275 通过、1 跳过；28.490 s |
| `npm run dist:win` | 成功生成 Windows 冻结后端、Electron 解包应用及 NSIS 安装包 |
| `python build/smoke_backend.py build/backend-dist/PigeonPalService/PigeonPalService.exe` | 通过 |
| `python build/smoke_desktop.py dist/win-unpacked/PigeonPal.exe dist/desktop-self-check-windows.json` | 10 项通过，`ok: true` |

跳过项为 `test_cas_protocol.py` 中需要旁置参考项目源码的 parity 检查；该参考源码不在本仓库。

`npm audit` 报告 8 项中危问题，位于 electron-builder 等构建依赖链；没有自动升级或回退依赖。该结果不构成对所有内置运行时漏洞的保证。

## 首次启动与持久化

使用自检自动生成的全新临时目录，未读取开发者校园凭据、API Key 或正式用户数据。后端加密读写使用固定的离线测试占位 Key；没有调用真实模型，也没有启动校园网络任务。

| 检查 | 证据与边界 |
| --- | --- |
| 空账号、空 API 设置、空画像 | 后端与应用自检通过；桌面窗口显示正常 |
| 渲染器启动与页面切换 | 通过；通知、作业、日历、画像内容及当前导航一致 |
| 画像表单保存 | 通过；页面重载后可读；冻结后端跨进程重启后仍保留 |
| 日历表单保存 | 通过；页面重载后保留；附加检查确认同一临时目录跨整个 Electron 进程重启后保留并可见 |
| 无 API 的表单提醒 | 创建与保存通过，离线到期事件通过 |
| 关窗后台运行、恢复窗口 | 自检确认窗口隐藏而未销毁，隐藏期间提醒到期，重新显示成功 |
| 上下文隔离 | 渲染器 `window.require` 不可用 |
| 冻结资源与证书 | 39 个网页资源逐字节匹配源码；外部证书路径无效时使用内置 CA，TLS 验证与主机名检查保持开启 |
| 后端退出与重启 | 正常关闭父管道后退出，重新启动后解密测试设置并读回画像/提醒 |

首次界面就绪 810 ms，7 次页面切换为 5、14、36、26、9、11、7 ms。这是本机离线样本，不是跨设备性能保证。`nativeNotificationSupported: true` 仅表示平台支持 API，不表示系统实际显示了通知。

附加检查在解包应用上执行：

- 从子进程 PATH 移除 Node/Python 开发环境，清除 `PYTHONHOME`、`PYTHONPATH`、`ELECTRON_RUN_AS_NODE` 和开发路径覆盖后，隔离应用仍可启动。
- Windows 桌面实际观察到空账号应用界面和画像表单；未输入个人信息。
- 通过仅绑定 loopback 的临时主进程调试连接调用正常 `app.quit()`，退出码为 0，后端退出。
- 从该进程的子进程句柄确认其唯一专属冻结后端，然后强制停止本次测试自己启动的 Electron 父进程；后端随私有管道 EOF 退出，无遗留后端。
- 强制退出后重新运行全新临时目录的首次启动 smoke：10 项通过，界面就绪 1,155 ms。此项验证再次启动，不验证同一 Electron 用户目录的数据恢复。
- 另用正常 `--offline` 启动，在主脚本运行前通过 loopback 调试连接将 appData 指向同一个新建临时目录。通过真实表单写入画像、日历和提醒，正常退出整个 Electron 进程后重新启动；画像和提醒 ID 保留，日历事项在 localStorage 和日历页面中均可读，两次退出码均为 0。没有修改打包代码或使用正式用户目录，子进程 PATH 中也没有开发运行时。结果见 `desktop-restart-check-windows.json`。
- 安装包内嵌归档完整性检查通过（7-Zip 报告附加尾部数据警告）；未将该检查当作安装测试。
- `app.asar` 仅包含桌面代码、package.json 和应用图标，没有 auth、data、`.env` 或 node_modules；后端资源来自显式打包清单。

## 签名与未验证事项

`Get-AuthenticodeSignature` 实测安装包、Electron 主程序和冻结后端均为 **NotSigned**，没有发布者签名证书。未声称通过 SmartScreen 信誉检查。

本机不是一次性 VM/runner，未运行 `build/smoke_windows.ps1`，也没有添加 `-DisposableMachine` 假装一次性环境。以下事项仍需另行验收：

- 一次性 Windows VM 中的安装向导、静默安装、开始菜单/快捷方式、升级、卸载及安装后启动。
- 真实登录桌面的系统通知显示、点击返回对应频道、托盘双击/右键打开与退出。
- 系统通知权限、免打扰、休眠/唤醒、断网恢复，以及不同 Windows 10/11 稳定版上的兼容性。
- 使用者本人校园账号的真实登录/同步，以及自己的模型 Key 和实际模型效果。

现有 v0.3.1 Release 的 Mac DMG、Mac 首次启动报告、`release-info.json` 与原始 `SHA256SUMS.txt` 均保留。Windows 使用独立的 `SHA256SUMS-windows.txt`、`release-info-windows.json`、`desktop-self-check-windows.json` 和本报告。
