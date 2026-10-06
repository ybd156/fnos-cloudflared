# Cloudflare Tunnel for fnOS — 设计说明

本文记录应用的结构、关键不变量，以及 1.3.1 / 1.4.0 修掉的缺陷，供后续维护参考。

## 运行形态

```
飞牛 OS 应用中心
  └── /var/apps/cloudflared/
      ├── target/            <- app/ 载荷（只读，升级会覆盖）
      │   ├── bin/cloudflared
      │   ├── server/server.js + server/lib/*.js
      │   ├── www/           <- 前端静态资源
      │   └── app.sock       <- 统一网关接入的 Unix socket
      ├── var/               <- $PKGVAR，持久数据
      │   ├── config.json        隧道定义 + 全局设置（0600）
      │   ├── .cloudflared/      cert.pem 与 <uuid>.json 凭据（0700）
      │   ├── tunnels/<id>/config.yml
      │   └── logs/<id>.log
      └── cmd/, wizard/, config/
```

生命周期脚本（`cmd/main`）只负责进程的启停与状态码；所有业务逻辑都在 Node 服务里。

## 后端模块

| 模块 | 职责 |
| --- | --- |
| `lib/paths.js` | 从 `TRIM_*` 推导全部路径与常量；`ensureDirs()` 是目录创建的唯一入口 |
| `lib/log.js` | 服务日志与 `0640` 的私有日志写入 |
| `lib/atomic.js` | 原子写文件（临时文件 + rename） |
| `lib/store.js` | `config.json` 的读写、隧道规范化与入参校验 |
| `lib/cloudflared.js` | 调用 cloudflared 二进制：一次性命令、argv/config.yml 生成、账户流程 |
| `lib/dns.js` | 本地管理隧道的 CNAME 路由检查与修复 |
| `lib/runner.js` | 每隧道一个 cloudflared 子进程的监督、重启退避与运行时记录 |
| `lib/http.js` | 静态资源与 REST API，任何请求都不得抛出到进程外 |

## 关键不变量

1. **`ensureDirs()` 必须在任何持久化之前成功。** 它是目录创建的唯一入口；一旦它是空操作，
   `config.json`、`config.yml`、`cert.pem` 与所有日志都会写进不存在的目录。
2. **运行时记录归 `runner.js` 所有。** 外部只能通过 `runtimeRecord()` / `forgetTunnel()`
   访问，不得直接操作注册表 —— 删除隧道时还要顺带清理自动重启定时器。
3. **凭据文件只按可证明的路径解析。** 显式路径，或 `<uuid>.json`。**不允许**“目录里第一个
   `<uuid>.json`”这种兜底：账户下有多个隧道时会静默跑起另一个隧道，症状是域名指向错误的源站，
   极难自查。只填名称时先经账户列表把名称解析成 UUID。
4. **`decodeURIComponent` 只允许经过 `safeDecodePath()`。** 畸形百分号编码会抛 `URIError`，
   过去曾因此让整个服务退出。
5. **cloudflared 的子命令参数要放在子命令之后。** `--output` 是 `list` / `create` 的子命令
   选项，写在 `tunnel` 之后会被当作未知的隧道级参数而失败。
6. **Token 永不离开服务端。** 只通过 `TUNNEL_TOKEN` 环境变量传给子进程（不用 argv，因为
   `/proc/<pid>/cmdline` 对同机用户可读），API 只返回 `hasToken` 与掩码预览。
7. **隧道 id 必须能安全地当路径片段用。** 它会被拼进 `tunnels/<id>/config.yml` 与
   `logs/<id>.log`，所以 `normalizeTunnel()` 只接受 `[A-Za-z0-9_-]{1,64}`，其余一律换成新
   id。API 本身总会覆盖 id，这条守的是**磁盘上的** `config.json`（可能被手工编辑或损坏）。
8. **日志只读有界的尾部窗口，且只解码真正读到的字节。** 两个日志接口都以
   `MAX_TAIL_BYTES` 为窗口；`readTailLines()` 必须使用 `readSync` 的返回值，因为日志每 30
   秒轮转一次，文件可能在 `stat` 与 `read` 之间缩小 —— 否则会把未初始化的堆内存当作日志
   正文送到界面。
9. **前端轮询渲染必须幂等。** `renderTunnels()` 只在生成的 HTML 真正变化时才写 DOM；日志
   正文不进入该 HTML 而是就地更新。否则每 3 秒一次的重建会清掉滚动位置、焦点与正在阅读的
   日志。

## 1.3.1 修复的缺陷

| # | 位置 | 缺陷 | 影响 |
| --- | --- | --- | --- |
| A | `lib/paths.js` | 用了 `fs` 但没 `require('fs')` | `ensureDirs()` 是空操作，`$PKGVAR` 从未创建；首次安装后保存隧道、写 config.yml、登录、写日志全部失败 |
| B | `lib/dns.js` | 用了 `path` 但没 `require('path')` | `resolveTunnelUuid()` 抛 `ReferenceError`；「修复 DNS 路由」返回 500，DNS 状态永远异常 |
| C | `lib/http.js` | 用了 `runtime` 但没引入注册表 | `DELETE /api/tunnels/:id` 抛 `ReferenceError` 返回 500（界面仍提示成功），并遗留重启定时器 |
| D | `lib/cloudflared.js` | 只给名称时猜凭据文件 | 多隧道账户下静默跑错隧道 |
| E | `lib/cloudflared.js` | `--output` 放在子命令之前 | 账户页列不出、也建不了隧道 |
| F | `lib/http.js` | 静态目录穿越用裸前缀比较 | `www-evil` 这类同前缀兄弟目录被当作 www 内部 |
| G | `lib/http.js` | 账户接口直接 `decodeURIComponent` | 畸形编码返回 500（与历史崩溃同一类） |

## 1.4.0 修复的缺陷与改动

| # | 位置 | 缺陷 | 影响 |
| --- | --- | --- | --- |
| L | `lib/log.js` | `readTailLines()` 忽略 `readSync` 的返回值 | 日志轮转后文件变小，缓冲区里未初始化的堆内存被解码成日志正文送到界面 |
| M | `lib/store.js` | 隧道 id 直接取自 `config.json` | 含 `..` 或路径分隔符的 id 会把 `config.yml` / 日志写到数据目录之外 |
| N | `lib/http.js` | 应用日志接口按 2MB 上限读窗口 | 每 3 秒一次轮询都拉 2MB 进内存并解码，与已修好的每隧道接口不一致 |
| O | `www/*` | 轮询每 3 秒重建整个列表 | 展开的日志框被反复拉回顶部；运行中的隧道因日志内联而持续重建 DOM |
| P | `www/app.js` | 选择器错误不会报错 | 处理器绑到 `null` 上，按钮静默失效；由 `tools/lint-ui.mjs` 在构建时拦住 |

界面同时做了整体重做（设计变量驱动的明暗主题、按状态着色的隧道卡片、可点击的状态汇总条、
分组表单、账户隧道筛选、键盘可达性与窄屏适配），详见 `README.md` 与 manifest 的 changelog。

## 测试

| 测试 | 命令 | 依赖 |
| --- | --- | --- |
| 后端（唯一入口） | `node tools/test-backend.mjs` | 便携部分仅需 Node；真机部分需 Linux（bash 桩 + `ps`） |
| 前端 | `node tools/test-ui.mjs` | 仅 Node |
| 模块绑定 lint | `node tools/lint-requires.mjs` | 仅 Node |
| UI 选择器 lint | `node tools/lint-ui.mjs` | 仅 Node |
| 生命周期脚本 | `setsid ./tools/test-lifecycle.sh` | 需 Linux + root 语义的 `/proc`、`curl` |

`tools/test-backend.mjs` 是一个文件里的两段：**便携部分**在进程内加载真实的请求处理器并用
loopback HTTP 驱动它，任何开发机都能跑；**真机部分**把 `server.js` 作为子进程拉起、配桩
`cloudflared`，用于断言命令行内容、`config.yml` 落盘与孤儿进程。真机部分在缺少 bash/`ps`
时**显式跳过并打印提示**，而不是让整个文件在 Windows 上不可用。两段共用同一个 HTTP 客户端
工厂，避免各写一套请求辅助函数。

历史上这两个后端套件是分开的文件且用例互相重叠，现已合并去重：便携段覆盖 A–G 与 L–N，
真机段覆盖 H–K。

`tools/lint-ui.mjs` 把守的是前端的选择器契约：`app.js` 查询的每个 `#id` 都必须能在
`index.html` 或 `app.js` 自己生成的标记里找到，用到的每个类名都要在 `style.css` 里有规则，
且 `index.html` 的 id 不得重复。这类错误**不会抛出任何异常** —— 处理器绑到 `null`，按钮
就是没反应 —— 所以只能在构建时静态拦住。

> 新增回归测试时必须验证它**真的能失败**：把缺陷改回去，确认测试变红（`exit=1`），再恢复。
> 本项目已有两次教训：一个测试因为窗口大于文件而永远命中不了目标代码，另一个因为断言取的是
> 行数（而响应本身有 300 行上限）而对窗口大小完全不敏感。写不出失败用例的测试等于没有测试。
