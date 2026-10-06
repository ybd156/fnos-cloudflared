# Cloudflare Tunnel for fnOS（飞牛 OS）

把 Cloudflare Tunnel（内网穿透）带到飞牛 OS 的应用。内置官方 `cloudflared`
客户端，可在**不开放任何路由器端口**的前提下，把 NAS 上的服务安全发布到公网，
并自动获得 HTTPS 证书。

## 功能

| 隧道类型 | 说明 | 是否需要 Cloudflare 账户 |
| --- | --- | --- |
| **Token 隧道** | 粘贴 Zero Trust 控制台生成的隧道 Token，由云端远程下发配置，适合生产环境 | 需要 |
| **快速隧道** | 一键获得 `*.trycloudflare.com` 临时公网地址 | 不需要 |
| **本地管理隧道** | 在应用内完成账户授权，创建/删除隧道、配置 ingress 路由、自动添加 DNS 记录 | 需要 |
| **自定义配置** | 直接使用您自己编写的 `config.yml` | 视配置而定 |

其他特性：

- 每个隧道一个独立 `cloudflared` 进程，互不影响
- 异常退出后按指数退避自动重启（5 秒起，最长 60 秒，最多 10 次；稳定运行 120 秒后重置计数）
- 实时日志查看（环形缓冲 600 行，同时落盘）
- 一键启停 / 重启 / 编辑 / 删除
- 隧道 Token 只保存在服务端（`0600` 权限），**永不回传浏览器**，界面仅显示掩码预览
- 界面支持浅色 / 深色模式自动切换
- 可一键从 GitHub 更新 `cloudflared` 二进制

## 目录结构

```
fnos-cloudflared/
├── cloudflared/              # fnpack 工程目录（目录名必须等于 appname）
│   ├── manifest              # 应用元信息
│   ├── ICON.PNG              # 64×64 图标
│   ├── ICON_256.PNG          # 256×256 图标
│   ├── app/                  # 应用载荷，安装后落到 /var/apps/cloudflared/target/
│   │   ├── bin/cloudflared   # 官方 cloudflared 二进制（不随仓库分发，见下）
│   │   ├── server/server.js  # Node 后端入口（零 npm 依赖，仅用内置模块）
│   │   ├── server/lib/       # 后端模块：paths/log/store/dns/cloudflared/runner/http
│   │   ├── www/              # 前端（原生 JS 单页，中文界面）
│   │   └── ui/config         # 应用入口与图标配置
│   ├── cmd/                  # 生命周期脚本（含共用库 _lib）
│   ├── config/               # privilege + resource
│   └── wizard/               # 安装 / 升级 / 卸载 / 设置向导
├── tools/make-icons.py       # 纯标准库图标生成器（无需 Pillow）
├── tools/fetch-cloudflared.py # 下载固定版本的 cloudflared 二进制并校验 SHA-256
├── tools/test-backend.mjs    # 后端回归测试（便携段 + 真机段，单一入口）
├── tools/test-lifecycle.sh   # 模拟安装：真实跑一遍生命周期脚本
├── tools/test-ui.mjs         # 前端回归测试（最小 DOM 桩）
├── tools/lint-requires.mjs   # 静态检查：模块用了却没用 require 引入的命名空间
├── tools/lint-ui.mjs         # 静态检查：UI 选择器 / 类名是否真的能解析到元素与样式
├── tools/lint-shell.mjs      # 静态检查：生命周期脚本（set -u、裸调 node、引号配平）
├── tools/normalize-fpk.py    # 打包后归一化归档内的权限位（并修正 checksum）
├── tools/verify-fpk.py       # 打包后校验产物与源码是否一致
├── tools/validate-json.py    # JSON 配置校验
├── build.sh                  # 构建脚本（Linux / NAS）
├── build.ps1                 # 构建脚本（Windows，等价于 build.sh）
└── dist/cloudflared.fpk      # 构建产物（本地产物，不随仓库分发）
```

## 构建

需要官方 `fnpack` 工具（本项目已在 `/usr/local/bin/fnpack`，版本 1.2.4）。
官方下载地址：<https://static2.fnnas.com/fnpack/>。

> **关于 `app/bin/cloudflared`。** 这个 38MB 的二进制**不在仓库里**（见 `.gitignore`）：
> 它是 Cloudflare 官方发布的构建产物，本仓库没有任何人修改它，提交进 Git 只会让每次
> 克隆都拖下 38MB，并让它永久留在提交历史中。取而代之的是
> `tools/fetch-cloudflared.py`：它按固定版本下载官方 release，**校验 SHA-256 后**才落盘。
> 打包好的 `.fpk`（其中当然包含该二进制）作为 GitHub Release 附件发布。
> 构建脚本会自动调用它，所以从干净克隆到打包不需要手工准备。

```bash
./build.sh              # 重新生成图标 → 校验 → 打包
./build.sh --no-icons   # 跳过图标生成
```

在 **Windows** 上（无 bash、无 fnpack on PATH）用等价的 PowerShell 脚本：

```powershell
pwsh -File build.ps1
pwsh -File build.ps1 -NoIcons -Fnpack C:\tools\fnpack-1.2.3.exe
```

脚本会依次完成：

1. 用 `tools/fetch-cloudflared.py` 确保存在固定版本的 `cloudflared` 二进制并校验其 SHA-256
2. 用 `tools/make-icons.py` 生成 6 个尺寸的图标
3. 归一化权限位（本机文件系统会把新建文件呈现为 `0000`，而 `.fpk` 也不保证保留权限位）
4. `bash -n` 校验全部生命周期脚本
5. 用 `tools/lint-requires.mjs` 检查后端有没有「用了却没 require」的模块命名空间
6. 用 `tools/lint-ui.mjs` 检查前端选择器与类名是否真的解析得到元素和样式
7. 用 `tools/lint-shell.mjs` 静态检查生命周期脚本（见下）
8. 校验全部 JSON 配置
9. 检查必需文件是否齐全
10. 调用 `fnpack build` 产出 `dist/cloudflared.fpk`
11. 用 `tools/normalize-fpk.py` 修正**归档内**的权限位（见下）
12. 用 `tools/verify-fpk.py` 复核产物与源码一致，然后打印大小与 SHA-256

> **为什么需要第 7、8 步。** `fnpack` 的权限位取自宿主文件系统的 `stat()`。Linux 上
> 第 2 步的 `chmod` 已经生效，所以归档里是 `0755`/`0644`；但 Windows 没有可执行位，
> 于是每个文件都变成 `0666`、目录变成 `0777` —— `cmd/main` 和 `app/bin/cloudflared`
> 到了 NAS 上是**不可执行**的，应用根本起不来。`normalize-fpk.py` 把两层 tar 的权限位
> 改写回 Linux 的正确值，并同步修正 manifest 里的 `checksum`（它是新 `app.tgz` 的 MD5）。
>
> 另外，`fnpack build` 只要必需文件存在就打印 "Packing successfully"，**不会**检查归档
> 内容是否等于当前源码树。所以从旧源码树打包、或漏掉权限修正，都会"成功"。`verify-fpk.py`
> 因此重新打开产物逐项断言：容器结构、manifest 与源码逐字节相同且版本一致、checksum 自洽、
> **遍历源码树自动发现的每个文件都与源码逐字节相同**（不再是一份手工维护的清单 —— 那种
> 写法会漏掉 fnOS 真正执行与渲染的 `cmd/*` 生命周期脚本和 `wizard/*` 描述文件）、
> 权限位、以及 1.3.1 / 1.4.0 / 1.4.1 各缺陷的回归探针。
>
> 那个不在仓库里的二进制也不会被放过：`verify-fpk.py` 会读
> `tools/fetch-cloudflared.py` 里的版本与 SHA-256 固定值，断言**包内二进制**的哈希与之相符、
> 且该版本号确实出现在二进制里。这样即便上游用同一版本号重新发布了不同的构建，也会被拦下。
>
> 拿它去查本仓库里那份陈旧的 1.3.0 产物可以确认这道门禁确实会拦人（会报 39 项失败）；
> 一个从不失败的检查等于没有检查。

> 构建**不是**字节级可复现的：`.fpk` 内 `app.tgz` 的 md5 会被写入 manifest 的
> `checksum` 字段，而 tar 时间戳每次构建都会变化。

## 测试

安装 `.fpk` 需要 root，因此项目自带一个**模拟安装**测试，在临时目录里复现应用中心
创建 `/var/apps/cloudflared/` 的布局，并用应用中心会导出的 `TRIM_*` 环境变量真实地
跑一遍全部生命周期脚本：

```bash
setsid ./tools/test-lifecycle.sh
```

覆盖内容：`install_init`/`install_callback` → `main start|status|restart|stop`
（含幂等性）→ 通过 `app.sock` 访问网关 API 与前缀注入 → `config_callback`
的读-改-写合并（验证隧道与 Token 不会被清掉、非法枚举值被拒绝）→
`uninstall_callback` 的保留/删除两种分支 → 载荷缺失时向 `$TRIM_TEMP_LOGFILE`
报错，以及**Token 不出现在子进程命令行、而是通过 `TUNNEL_TOKEN` 传递**这条安全回归。

用 `setsid` 运行是为了把测试放进独立会话，避免脚本里的进程组信号影响到外层 shell。

### 后端回归测试

```bash
node ./tools/test-backend.mjs
```

单一入口、两段覆盖，避免重复：

**便携段（任何开发机）** 在进程内加载真实的 `app/server/lib/http.js` 请求处理器，通过
loopback HTTP 驱动整套 API，**不需要 bash、`ps` 或符号链接**。100 项断言锁住了这些曾经让
「基本功能」直接失效的缺陷：

- 数据目录确实被创建（`ensureDirs` 曾经因为漏 `require('fs')` 而是空操作，导致首次
  安装后保存隧道、写 `config.yml`、登录账户、写日志全部失败）
- 「修复 DNS 路由」不再抛 `ReferenceError`（`lib/dns.js` 漏 `require('path')`）
- `DELETE /api/tunnels/:id` 返回 200 而不是 500，并且运行时记录与重启定时器被清理
- 只填名称、没有隧道 ID 的本地管理隧道**不会**去拿别的 `<uuid>.json` 顶替，而是明确报错
- cloudflared 子命令参数顺序正确（`--output` 跟在 `list`/`create` 之后）
- 目录穿越读不到 `www` 之外的兄弟目录
- 畸形百分号编码（`GET /%`、账户接口路径）返回 4xx 而不是 500
- 日志尾部读取**不会吐出未初始化内存**（`readTailLines` 曾忽略 `readSync` 的返回值；
  日志轮转把文件改名后，缓冲区里的堆垃圾会被当成日志内容送到界面）

**真机段（需 Linux）** 把真实的 `app/server/server.js` 连同 `lib/` 跑在一个临时
`TRIM_APPDEST`/`TRIM_PKGVAR` 里，用桩 `cloudflared`（会记录每次调用，并模拟真实
进程那样优雅退出 2 秒）演练整条 HTTP 接口链路。需要 Linux 环境（用到 bash、`ps`
与符号链接）；在 Windows 上会**打印提示并跳过**，而不是让整个文件跑不了。覆盖内容：
全局设置真正出现在 cloudflared 命令行（含曾经被忽略的「附加参数」）→ 本地管理隧道的
入站校验（域名格式、服务协议）→ 启停、`config.yml` 生成与 DNS 路由 → **保存正在运行的
隧道时的重启竞态**（状态不被旧进程覆盖、同一隧道始终只有一个 cloudflared）→ 未运行时
保存同样即时生效 → 重启按钮与关闭自动 DNS → **关停不留孤儿进程**（含 cloudflared 慢退出
场景）→ 账户登录/退出流程。每个小节结束时都会断言没有遗留的 cloudflared 进程。

前端另有一个回归测试，用最小 DOM 桩把 `app/www/app.js` 加载进 Node 并演练隧道列表渲染
与隧道弹窗：

```bash
node ./tools/test-ui.mjs
```

它锁住两类问题。**正确性**：账户页的「新建隧道配置」按钮原本把**预填对象**当成
「正在编辑的隧道」传给了 `openTunnelModal`，于是保存时发出
`PUT /api/tunnels/undefined`，界面报「隧道不存在」；测试断言该按钮进入的是**新建**模式、
保存走 `POST /api/tunnels`，并断言下拉框会把云端隧道的 UUID 一并提交（`tunnelId`），
好让 `cloudflared` 用 `<UUID>.json` 精确定位凭据文件。**性能与可用性**：轮询渲染必须是
「内容不变就不碰 DOM」（否则每 3 秒重建一次列表，展开的日志框会被反复拉回顶部）、
日志正文不得内联进卡片 HTML（运行中的隧道每秒都在输出，内联进去等于每次轮询都重建列表）、
日志框只在读者本来就在底部时才跟随最新行、以及状态筛选的分类计数归零后要自动退回
「全部」（否则列表整片空白且无法退出）。

UI 的选择器契约由 `tools/lint-ui.mjs` 静态把守：它检查 `app.js` 查询的每个 `#id` 都能在
`index.html` 或 `app.js` 自己生成的标记里找到、每个用到的类名在 `style.css` 里有规则、
以及 `index.html` 里的 id 不重复。这类错误**不会报错**——处理器绑到 `null` 上，按钮就是
没反应，控制台一片安静，所以值得在构建时就拦住。

生命周期脚本的静态契约由 `tools/lint-shell.mjs` 把守。它存在的原因是：这些脚本跑在 NAS
上，而开发机（尤其 Windows）**根本没有 bash 可以执行它们**——本仓库自带的 minGit 里虽然有
`sh.exe`，但它在沙箱下起不来（需要信号管道）。于是脚本改动长期只能靠肉眼审查，而这类改动
真正的错误恰好都是肉眼看不出来的：

- `set -u` 下裸用 `${TRIM_X}`：在作者机器上恰好导出过该变量所以正常，到了应用中心的环境
  里直接中止；
- 裸调 `node`：开发机有，NAS 上没有（依赖应用不进 PATH，这正是 `cmd/_lib` 探测绝对路径的
  原因）——这是最糟的失败形态，本地全绿、目标环境全挂；
- 引号不配平：会静默吞掉文件后半部分。

它是文本检查，**不能替代在 NAS 上真跑一遍** `tools/test-lifecycle.sh`，但能拦住上面这类
审查必然漏掉的问题。该工具本身也用「故意改坏 → 确认变红」验证过三类违例都会被抓住。

## 安装

应用需要 root 权限安装，请在**飞牛 OS 的「应用中心」中手动安装**：

1. 从本仓库的 [Releases](https://github.com/ybd156/fnos-cloudflared/releases)
   下载最新版 `cloudflared-<版本>.fpk`（`dist/` 只是本地构建目录，不在仓库中）
2. 打开「应用中心」→ 右上角「手动安装」→ 选择该 `.fpk`
3. 安装向导中确认是否「服务启动时自动运行已启用的隧道」
4. 安装会自动安装依赖应用 `nodejs_v24`

也可以在 NAS 的 root shell 中执行：

```bash
appcenter-cli install-fpk /path/to/cloudflared.fpk
```

安装完成后，飞牛 OS 桌面上会出现 **Cloudflare Tunnel** 图标。

## 使用

### 快速隧道（最快上手，无需账户）

1. 打开应用 → 「隧道」→「新建隧道」
2. 类型选「快速隧道」，填写本地服务地址，例如 `http://127.0.0.1:5000`
3. 保存后点「启动」，几秒后卡片上会出现 `https://xxx-xxx.trycloudflare.com` 地址

该地址每次重启都会变化，仅适合临时测试。

### Token 隧道（推荐用于生产）

1. 登录 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)
2. `Networks` → `Tunnels` → `Create a tunnel` → 选择 `Cloudflared`
3. 给隧道命名后，复制页面上给出的 **Token**（`eyJhIjoi...` 那一长串）
4. 在同一页面的 `Public Hostname` 标签中配置域名 → 服务地址（如 `http://localhost:5000`）
5. 回到本应用 → 「新建隧道」→ 类型选「Token 隧道」→ 粘贴 Token → 保存 → 启动

配置完全由 Cloudflare 云端下发，本机无需再维护 ingress 规则。

### 本地管理隧道（在应用内管理账户与路由）

1. 「账户」标签页 → 点「登录 Cloudflare」
2. 页面会给出一个授权链接，在浏览器中打开并授权您的域名
3. 授权完成后回到应用，即可：
   - 查看账户下已有的隧道
   - 创建 / 删除隧道
   - 为隧道配置 ingress 规则（主机名 → 本地服务）
   - 一键为规则添加 DNS 路由记录

凭据保存在 `$PKGVAR/.cloudflared/cert.pem`，权限为 `0700` 目录内的私有文件。

### 自定义 config.yml

在「新建隧道」中选择「自定义配置」，填入您自己编写的 `config.yml` 内容，
或指定已有的 `config.yml` 路径，应用会以 `--config` 方式启动。

## 数据与安全

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `$PKGVAR/config.json` | 隧道定义、设置、Token | `0600` |
| `$PKGVAR/.cloudflared/cert.pem` | Cloudflare 账户凭据 | 目录 `0700` |
| `$PKGVAR/tunnels/<id>/config.yml` | 每个本地管理隧道的配置 | `0750` |
| `$PKGVAR/logs/<id>.log` | 每个隧道的 cloudflared 日志 | — |
| `$PKGVAR/server.log` | 应用自身日志（自动轮转） | — |
| `$PKGVAR/main.log` | 生命周期脚本日志 | — |

其中 `$PKGVAR` 即 `/vol1/@appdata/cloudflared`。

安全设计：

- 应用以 `run-as: package` 模式运行，使用专属系统用户 `cloudflared`，不使用 root
- 管理界面**只通过 fnOS 统一网关**（`app.sock`）暴露，访问前由飞牛 OS 校验登录态，
  不对局域网开放任何端口
- 隧道 Token 在 API 中只返回 `hasToken` 与掩码预览（如 `eyJhIjoi…Zm9v`），
  明文永不离开服务端
- 启动隧道时 Token 通过 `TUNNEL_TOKEN` **环境变量**交给 `cloudflared`，而不是
  命令行参数——Linux 上任何本地用户都能读取 `/proc/<pid>/cmdline`，用参数传递
  等于把凭据泄露给同机的其他用户
- 日志文件（`server.log`、`logs/<id>.log`）以 `0640` 创建
- 网关会注入 `X-Trim-Userid` / `X-Trim-Username` / `X-Trim-Isadmin` 请求头

## 常见问题

**Q：启动失败，提示找不到 Node.js？**
A：应用依赖 `nodejs_v24`。请在应用中心确认该依赖已安装；生命周期脚本会在
`/var/apps/nodejs_v24/target/bin`、`/var/apps/nodejs_v22/target/bin` 等位置自动查找。

**Q：隧道一直处于「启动中」？**
A：打开该隧道的日志查看 cloudflared 输出。若 UDP 7844 被网络阻断，请在
「设置」中把传输协议改为 `http2`。

**Q：如何更新 cloudflared？**
A：「设置」→「更新 cloudflared 二进制」，会从 GitHub 拉取最新版并原子替换。

**Q：本地管理隧道启动时报「无法确定隧道的 UUID」？**
A：说明这条隧道只保存了名称、没有隧道 ID。请到「账户」页确认已登录，然后点该隧道
的「编辑」重新从下拉框选择一次并保存 —— 保存时会把 UUID 一并记下，之后
`cloudflared` 就能用 `<UUID>.json` 精确定位凭据文件。应用**不会**再去猜凭据文件：
账户下有多个隧道时，「随便挑一个」会让隧道看起来正常运行、实际却指向了另一个源站。

**Q：状态码含义？**
A：`cmd/main status` 返回 `0` = 运行中，`3` = 未运行，`1` = 失败。

## 卸载

在应用中心卸载即可。卸载向导会询问是否**同时删除隧道配置、Token 与账户凭据**；
默认保留，便于重新安装后继续使用。Cloudflare 控制台中已创建的隧道不会被删除。

## 技术说明

- 后端：Node.js 内置模块（`http` / `fs` / `path` / `crypto` / `child_process` / `https`），
  **零 npm 依赖**，因此安装时无需联网下载任何包
- 前端：原生 JavaScript 单页应用，无构建步骤
- 网关前缀由后端在返回 HTML 时把 `%%CF_BASE%%` 占位符替换为实际前缀，
  因此同一套代码在「网关访问」与「本地直连」两种入口下都能正确解析资源路径
- 生命周期脚本参考 `fn-deepseek-harness` 的健壮性写法：用 `/proc/<pid>/stat`
  识别僵尸进程、用 `/proc/<pid>/cmdline` 校验进程身份以避免误杀 PID 复用进程

