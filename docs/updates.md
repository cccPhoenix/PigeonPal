# 软件更新与发布

从 0.4.0 起，「设置 → 软件更新」提供自动检查开关、手动检查按钮、当前版本、检查结果和更新说明。也可从左下角设置菜单直接进入。

## 用户侧

- 默认启动 15 秒后检查一次，此后每 24 小时检查。关闭自动检查立即取消后续调度，偏好保存到 `desktop-updates.json`；不影响手动检查。
- 只查询 `cccPhoenix/PigeonPal` 的正式 GitHub Release，不接收分支提交、草稿、预发布或降级。
- 检测到新版后显示「查看更新」横幅。下载须用户点击，不会在后台自动下载；Windows 下载完成后须再点击「重启并安装」。普通关窗或退出不会自动安装。
- Windows 使用 `electron-updater` 的 NSIS 更新链路，校验更新清单中的 SHA512。安装前立即保存界面记录、刷新 Chromium 存储、结束 Python 后台，再启动安装器；安装目录和用户数据目录分离。
- macOS 当前使用临时签名，提供检查、更新说明和官方 Release 下载入口，下载 DMG 后手动替换应用；没有关闭签名验证或自制覆盖程序。完整自动安装需另行配置正式签名、公证及 ZIP 更新产物。
- 本地开发、`--offline` 和 `--self-check` 不访问更新源或执行安装。网页版显示安装版功能提示。
- 检查和下载失败不改变已安装版本。错误提示只含固定错误码；不展示传输 URL、凭据或本机路径。更新服务不接收校园账号、API Key、画像或通知正文。

实现入口：`desktop/updates.cjs`，固定 IPC 桥位于 `desktop/preload.cjs`；设置和横幅位于 `web/js/ui/updates.js`。渲染器不能指定更新源、下载路径、待安装文件或外部网址。

## 发布侧

日常提交到 main 不发布版本。正式发布需要：

1. 使用 `npm version <新版本> --no-git-tag-version` 同步 package.json 和 package-lock.json；在 `docs/releases/<新版本>.md` 写更新说明。
2. 运行 `npm run release:verify`、`npm test` 和 Python 测试。Windows 额外执行 `npm run test:updates`，验证真实 NSIS 下载器的清单读取、下载、缓存与篡改校验拒绝；此验收不会执行安装包。
3. 将代码提交到 main 后，创建同版本标签，例如 `git tag v0.4.1`，推送标签 `git push origin v0.4.1`。
4. `.github/workflows/release.yml` 在 Windows x64 和 Apple Silicon Mac 上分别构建、验收。Windows 在一次性 runner 中执行安装验收；Mac 检查 DMG、签名结构和实际应用首次启动。
5. `build/release.cjs stage windows|mac` 校验版本、桌面验收报告和 Windows 更新清单的文件名、大小、SHA512，只复制当前版本的明确文件清单，并生成 SHA256 校验文件。
6. 两个平台均通过后，发布任务创建 Release 草稿，逐个上传全部附件并核对数量、名称和大小，再转为正式最新版。构建失败不会更新正式发布源；上传中断可重试同一提交的未发布草稿。已正式发布或指向其他提交的同名版本不会被覆盖，需要先人工判断。

workflow_dispatch 默认只执行完整构建与验收并保存附件；显式勾选 publish_release 后，双平台通过时也会创建同版本标签并发布，适合首次发布。修改工作流需要相应 GitHub 凭据权限；发布任务使用仓库提供的 GITHUB_TOKEN，仅该任务取得 contents:write，不将 Token 打入安装包。

本地 Windows 构建：

```powershell
npm ci
python -m pip install -r requirements-build.txt
npm run dist:win
python build/smoke_backend.py build/backend-dist/PigeonPalService/PigeonPalService.exe
python build/smoke_desktop.py dist/win-unpacked/PigeonPal.exe dist/desktop-self-check-windows.json
node build/release.cjs stage windows
```

上述安装包和更新清单生成在 dist，已验证可上传的文件位于 `dist/release-<版本>-windows`。手动发布时必须一并上传该目录内的安装包、blockmap、latest.yml、验收报告和校验文件；只上传 Setup.exe 无法完成应用内更新。

## 验收边界

0.3.x 没有应用内更新入口，需要手动安装一次 0.4.0 才能使用后续检查功能。当前正式版的验证摘要见 README，详细改动与验证证据保留在对应 PR、CI 日志和 Release 附件中；普通 push 不新增验收记录文档。

单元测试覆盖版本过滤、偏好持久化、禁用调度、手动检查、操作去重、下载失败重试、安装前关闭后台顺序、IPC 客户端、横幅和更新说明转义。真实下载器验收使用隔离 loopback 源和不可执行合成字节，证明清单与下载校验流程，不代替 Windows 真实安装升级。

桌面首次启动自检使用新建临时用户目录，检查软件更新页的版本、离线手动按钮、自动检查开关和重载后的偏好；不接触正式账号。安装覆盖与系统提示的最终交互验收仍应在一次性 Windows VM 中完成。

Windows 当前未配置 Authenticode 发布者签名；SHA512 校验依赖可信 HTTPS 发布源与清单，不等同于发布者签名。保留现有发布者签名验证能力，后续有签名证书时在构建配置接入，不需要改变用户操作流程。
