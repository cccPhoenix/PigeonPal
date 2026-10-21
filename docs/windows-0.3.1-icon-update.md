# v0.3.1 Windows 不透明图标修订（2026-10-21）

Windows 安装包、应用窗口以及安装后快捷方式改用用户提供的浅色不透明底板图标。直接将原图转换为 PNG 和 ICO，保留原有鸽子图案及圆角造型，没有采用自动抠角产生的图像。macOS、网页、托盘和通知图标保持原样。

图源：`web/assets/icon-windows.png`，710 × 710。Windows 资源：`build/windows-icon.ico`，含 16、20、24、32、40、48、64、128、256 px 九个尺寸。构建时直接使用已提交的 ICO，不再由旧透明图标生成；冻结后端也使用同一资源。

## 本轮实际检查

- JavaScript：116/116 通过。
- Python：276 项，275 通过、1 因缺少旁置参考源码跳过。修正了作业集成测试依赖真实日期的问题：只固定该测试的时钟，没有修改业务逻辑。
- `npm run dist:win`：Windows x64 原生构建成功，使用 Python 3.12.10、PyInstaller 6.22.3、Electron 44.9.0 和 electron-builder 26.15.3。
- 冻结后端 smoke：40 个网页资源与源码一致；内置证书、空账号、测试设置加密保存、画像/提醒持久化与重启、离线到期和退出通过。
- 打包应用 smoke：10 项首次启动检查通过，界面就绪 1,013 ms；包括画像/日历/提醒表单保存、窗口隐藏期间提醒到期、恢复窗口、重载保存和页面切换。
- PNG/ICO 像素检查：原图和九个图标尺寸的所有像素均不透明。
- EXE 资源检查：安装器、Electron 主程序和冻结后端均包含与源 ICO 逐字节一致的九个图标帧。机器检查结果见 Release 的 `windows-icon-check.json`。

## 当前安装包

文件：`PigeonPal-Setup-0.3.1-x64.exe`，122,981,110 字节。

SHA256：`0bde1e26615a3f4302cf314ad8f3fe6635b793c3773d098909d23d23aa8ef458`。

安装包、主程序和后端仍未签名（Authenticode: `NotSigned`）。本机不是一次性 VM/runner，未执行安装 smoke；安装后桌面/开始菜单的实际显示、系统通知显示/点击、托盘鼠标操作仍需在目标桌面确认。资源核对不代替实际安装。原始构建的完整进程重启附加记录作为历史结果保留，本轮没有重复该调试流程。

现有 v0.3.1 Release 的 Windows 正式文件以本次摘要及 `SHA256SUMS-windows.txt` 为准；旧透明图标构建归档为 `PigeonPal-Setup-0.3.1-x64-original-icon.exe`。Mac 附件、Mac 报告和原始 `SHA256SUMS.txt` 保留不变。
