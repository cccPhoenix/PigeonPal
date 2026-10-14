# 本地爬虫

使用 Python 3.10+，通知数据存为 JSON，不调用 LLM。统一服务连接前端、ZJUAM 认证和两站爬虫；独立公开采集命令仍只依赖标准库。

认证、站点 SSO 和正文采集统一使用直连，不自动继承系统或环境变量中的 HTTP/HTTPS 代理。这样避免认证成功、采集却走另一条代理线路而超时。

ITC 按分页区定位主通知列表，不固定窗口编号。列表缺少可识别的完整日期时，仍保留标题和链接，`publishedAt` 留空并标记 `publication_date_missing`；正文中的日期可在后续采集时补齐，不根据当前年份猜填。

2026-10-14 本机真实采集记录：ITC 保存 14 条通知元信息，首次读取 3 篇完整正文、2 个附件链接；该轮共 7 次 HTML 请求，正文失败数为 0，来源状态为 `ready`。这次没有运行测试脚本，结果来自正常服务的实际采集。其余正文仍在待处理队列中；附件只保存链接，没有下载文件。

## 运行

在仓库目录执行：

```sh
python -m pip install -r requirements.txt
python scripts/serve.py
```

也可用 `npm run dev` 启动同一个服务。打开 http://127.0.0.1:4174，在「我 → 身份认证」或 ITC 来源卡的「去认证」绑定校园账号；绑定前云峰正常采集，ITC 等待认证。服务仅监听本机，持续运行需保持电脑联网，按 Ctrl+C 停止。不会安装开机服务或创建云端任务。

需要指定目录或端口时：

```sh
python scripts/serve.py --data-dir "D:\PigeonPal-data" --auth-dir "D:\PigeonPal-auth" 4174
```

`--auth-dir` 必须在本仓库外。默认认证目录为跨平台的 `~/.pigeonpal/auth`，通知目录见下表。认证用法和迁移见 [身份认证说明](authentication.md)。同一通知目录、认证目录只允许一个写入服务，不要同时运行统一服务和独立采集进程。

独立命令用于公开采集、查看状态和导出：

```sh
python scripts/pigeonpal_crawler.py run --once
python scripts/pigeonpal_crawler.py run
python scripts/pigeonpal_crawler.py status
python scripts/pigeonpal_crawler.py export --output data/notices.json
```

独立 `run` 默认使用 `NoAuthProvider`，不读取保存的校园凭据；ITC 会显示 `auth_required`。已绑定校园账号的受保护来源采集须用统一服务，由认证模块提供内存会话。`--once` 只处理已到检查时间的来源，完成单轮后退出；它同样遵守已有检查时间和失败退避，刚爬过再运行可能显示 `not_due`，不立即重复请求。

- `run --source yunfeng`：只运行云峰；也可指定 `itc` 或 `all`，默认 `all`。
- `run --detail-limit 0`：只检查列表；每轮正文上限可设为 0–3，默认 3。
- `export --source yunfeng --output data/yunfeng.json`：导出一个来源；默认导出全部。示例放在 Git 已忽略的 `data/` 中。

`status` 只显示来源、队列和近期运行状态；`export` 导出本地通知及正文，不发网络请求。输出时间使用 ISO 8601 UTC。

全局 `--data-dir` 必须放在子命令前，例如：

```sh
python scripts/pigeonpal_crawler.py --data-dir "D:\PigeonPal-data" run
python scripts/pigeonpal_crawler.py --data-dir "D:\PigeonPal-data" status
```

## 本地数据和迁移

数据使用 JSON，不需要数据库。默认目录：

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\PigeonPal\data` |
| macOS | `~/Library/Application Support/PigeonPal/data` |
| Linux | `$XDG_DATA_HOME/pigeonpal/data`，未设置时为 `~/.local/share/pigeonpal/data` |

`crawler-state.json` 保存通知、待处理队列、来源状态和近期运行记录，并带有 `schemaVersion`。程序原子写入，`crawler-state.json.bak` 保留上一个有效快照；`crawler.lock` 的系统进程锁防止同一数据目录被多个采集进程同时修改。主文件损坏时尝试读取有效备份，仅仅读取不会写回主文件；不能恢复时保留文件并报错。

迁移前停止程序，复制整个数据目录，在另一台电脑用 `--data-dir` 指向它，即可继续已有队列。目标电脑仍需 Python 3.10+；本阶段不提供打包运行时。通知导出不包含认证文件；如需迁移绑定，另行复制认证目录中的 `.env` 和 `.auth-key`，在新机用 `--auth-dir` 指向该目录。Cookie 不保存，启动后会重新向学校认证。

## 采集和初筛

- 每站以 300 秒为列表检查间隔目标；同站请求串行，间隔随机 15–30 秒。超时或上一轮尚未结束时不重叠补跑，遇到 429、503 或网络失败延后重试。
- 首次只读取首页。新通知和缺失正文进入持久队列，每轮最多处理三篇；失败项保留，重启后可继续。已抓正文每天少量轮换复查，识别网站更新。
- 使用来源和文章 ID 去重，分别保存列表元信息与正文；正文内容哈希和版本用于识别修改，避免每轮重抓全部正文。
- 去掉导航、页脚、脚本等噪声，保留段落、表格内容和来源链接。标记正文待处理、解析失败及含附件状态，不根据未知的用户偏好删除通知。
- 附件仅保存名称和链接，不下载附件或图片，不遍历历史分页。

## ITC 和认证边界

ITC 需要 ZJUAM 认证。统一服务通过 `scripts/local_auth/` 实现直接 ZJUAM 登录、本地加密绑定、受控续期和解绑。校园账号验证只访问 ZJUAM；确认登录成功即保存绑定，不检查 ITC 列表或访问权限。认证请求连续执行，不套用采集的 15–30 秒间隔。

绑定成功后，ITC 的采集流程单独用 ZJUAM 内存会话建立该站 SSO 会话，再按原有限速读取列表和正文。站点网络故障、无访问权限和解析失败只影响该来源状态，不把已通过的校园账号验证标为失败。未绑定或没有有效会话时，ITC 来源为待认证；云峰继续正常采集。绑定后重启服务会自动认证；ZJUAM 会话失效时进行受控重认证，密码错误或需要额外验证会暂停自动尝试。

此前已在用户本机通过临时认证确认 ITC 列表和正文可访问，临时会话已结束。2026-10-14 用户在本机 UI 完成认证，正常服务完成上述真实采集；本轮按用户要求未运行自动测试。账号、密码、Cookie 和带票据的认证 URL 不写入通知数据或日志。

认证接口仍在 `scripts/crawlers/auth.py`：`session_for(source_id)` 返回包含内存 `CookieJar` 的 `AuthSession` 或 `None`，`invalidate(source_id)` 丢弃该来源的过期会话。统一服务提供站点会话，独立 CLI 使用 `NoAuthProvider`。爬虫自身不接收账号密码。新增受保护来源需接入自己的 SSO 会话和解析规则，复用独立的校园账号绑定。ITC 的 SSO 建立流程先尝试 Cookie 复用；若官方 CAS 要求该站的表单，再由认证管理器提供一次加密提交，不因该站登录失败清空校园身份。来源卡展示真实采集状态，但聊天和频道消息仍是演示内容，通知正文尚未接入消息流或 LLM。

旧的 `scripts/crawl_yunfeng.py` 是首次试抓工具，每次读取首页与最新三篇正文并输出 `data/yunfeng-notices.json`。持续采集请使用上述新入口。
