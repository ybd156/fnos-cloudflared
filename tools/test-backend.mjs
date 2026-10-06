/*
 * Backend regression suite for Cloudflare Tunnel for fnOS.
 *
 * ONE suite in two parts, so there is a single entry point and no duplicated
 * coverage:
 *
 *   Part 1 (portable)   loads the real request handler in-process and drives it
 *                       over loopback HTTP. Needs only Node, so it runs on any
 *                       development machine. Static/traversal handling,
 *                       malformed requests, settings, tunnel CRUD, token
 *                       handling and the account/logs endpoints live here.
 *
 *   Part 2 (real host)  spawns cloudflared/app/server/server.js as a child
 *                       process against a stub cloudflared binary, so it can
 *                       assert what actually reaches the command line, what
 *                       lands in config.yml, and that no cloudflared process is
 *                       orphaned. It needs bash, ps and a POSIX process model,
 *                       so it is skipped with an explicit notice where those are
 *                       absent (e.g. Windows). Run it on the NAS for full
 *                       coverage.
 *
 * The defects this suite pins, in one list (the letters were previously split
 * across two files with overlapping meanings):
 *
 *   [A] lib/paths.js called fs.mkdirSync without requiring 'fs' -- ensureDirs()
 *       was a no-op, so $PKGVAR never existed. config.json, per-tunnel
 *       config.yml, cert.pem and every log write landed in a missing directory.
 *   [B] lib/dns.js called path.basename without requiring 'path', so
 *       resolveTunnelUuid() threw ReferenceError and every "repair DNS route"
 *       action answered 500.
 *   [C] lib/http.js called runtime.get/runtime.delete without importing the
 *       registry, so DELETE /api/tunnels/:id threw ReferenceError, answered 500
 *       to the UI, and left a restart timer armed for a deleted tunnel.
 *   [D] resolveCredentials() fell back to "the first <uuid>.json in the
 *       directory", so a tunnel identified only by name silently ran a
 *       different tunnel when the account had more than one.
 *   [E] the account tunnel list/create commands passed --output before the
 *       subcommand, where cloudflared does not accept it.
 *   [F] the static-file guard compared a raw path prefix, so a sibling
 *       directory such as www-evil passed as "inside www".
 *   [G] a malformed percent-encoded request (GET /%) made decodeURIComponent
 *       throw URIError out of serveStatic; requestHandler had no guard, so the
 *       whole backend process exited and every running cloudflared was orphaned.
 *   [H] saving a running tunnel started the new process before the old one had
 *       exited, and the old process's late exit event overwrote the run record:
 *       the card showed "stopped" while the process was alive, it was counted as
 *       a crash and a second cloudflared was spawned; later saves never
 *       restarted, so new hostnames reached neither config.yml nor DNS.
 *   [I] saving a stopped tunnel left config.yml and the DNS routes at their
 *       last-started state while the UI reported success.
 *   [J] the global "extra arguments" setting was written to config.json but
 *       globalArgs never read it.
 *   [K] stop/upgrade did not wait for the child to exit, so cloudflared was
 *       abandoned on the system.
 *
 * Run: node tools/test-backend.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'cloudflared', 'app');
const LIB = path.join(APP, 'server', 'lib');
const SERVER_JS = process.env.CF_SERVER_JS || path.join(APP, 'server', 'server.js');
const WWW_DIR = path.join(APP, 'www');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${label}${extra ? `  \u2192 ${extra}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const section = (title) => console.log(`\n[${title}]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Shared HTTP client factory: both parts drive the API the same way the web UI
 * does, they just talk to a different server on a different port. */
function makeClient(port) {
  function raw(reqPath, options = {}) {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: reqPath, method: options.method || 'GET', headers: options.headers || {} },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        },
      );
      req.on('error', (err) => resolve({ status: 0, body: '', error: err.code || err.message }));
      if (options.body) req.write(options.body);
      req.end();
    });
  }
  async function api(method, apiPath, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await raw('/api' + apiPath, {
      method,
      body: payload,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
    });
    let json = null;
    try { json = JSON.parse(res.body); } catch (err) { json = null; }
    return { status: res.status, json, body: res.body, error: res.error };
  }
  return { raw, api };
}

/* ==========================================================================
 * Part 1 -- portable: real request handler loaded in-process.
 * ========================================================================== */

const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-server-'));
const APPDEST1 = path.join(TMP1, 'target');
const PKGVAR1 = path.join(TMP1, 'var');
const UUID = '11111111-2222-3333-4444-555555555555';
const UUID2 = '99999999-8888-7777-6666-555555555555';

async function runPortableSuite() {
  fs.mkdirSync(APPDEST1, { recursive: true });
  fs.cpSync(WWW_DIR, path.join(APPDEST1, 'www'), { recursive: true });
  /* A sibling directory that shares the www prefix: the traversal guard must not
     mistake it for a path inside www. */
  fs.mkdirSync(path.join(APPDEST1, 'www-evil'), { recursive: true });
  fs.writeFileSync(path.join(APPDEST1, 'www-evil', 'secret.txt'), 'should never be served\n');
  /* No cloudflared binary on purpose: start must fail cleanly, not crash. */

  process.env.TRIM_APPNAME = 'cloudflared';
  process.env.TRIM_APPDEST = APPDEST1;
  process.env.TRIM_PKGVAR = PKGVAR1;
  process.env.TRIM_PKGTMP = path.join(TMP1, 'tmp');
  process.env.TRIM_PKGETC = path.join(TMP1, 'etc');
  process.env.TRIM_SERVICE_PORT = '0';

  const paths = require(path.join(LIB, 'paths.js'));

  section('0 lib/paths.js ensureDirs() 真的创建目录  [A]');
  ok(!fs.existsSync(PKGVAR1), '起始时 $PKGVAR 不存在');
  paths.ensureDirs();
  ok(fs.existsSync(paths.PKGVAR), '$PKGVAR 已创建', paths.PKGVAR);
  ok(fs.existsSync(paths.CF_DIR), '凭据目录已创建', paths.CF_DIR);
  ok(fs.existsSync(paths.TUNNELS_DIR), '隧道配置目录已创建', paths.TUNNELS_DIR);
  ok(fs.existsSync(paths.LOGS_DIR), '日志目录已创建', paths.LOGS_DIR);

  const { requestHandler } = require(path.join(LIB, 'http.js'));
  const { loadConfig } = require(path.join(LIB, 'store.js'));
  const { resolveCredentials, splitArgs, globalArgs, buildArgs } = require(path.join(LIB, 'cloudflared.js'));
  const dnsLib = require(path.join(LIB, 'dns.js'));
  const { forgetTunnel, runtimeRecord } = require(path.join(LIB, 'runner.js'));

  section('1 lib/dns.js resolveTunnelUuid() 不再抛 ReferenceError  [B]');
  fs.writeFileSync(path.join(PKGVAR1, '.cloudflared', `${UUID}.json`), JSON.stringify({ TunnelID: UUID }));
  eq(dnsLib.resolveTunnelUuid({ tunnelId: UUID }), UUID, '已知 UUID 时按 <uuid>.json 解析');
  eq(dnsLib.resolveTunnelUuid({ tunnelName: 'nas' }), '', '只给名字时明确返回空串（不再瞎猜）');

  section('2 resolveCredentials() 不再猜凭据文件  [D]');
  eq(resolveCredentials({ tunnelName: 'nas' }), null, '只给名字且无凭据时返回 null');
  eq(resolveCredentials({ tunnelId: UUID }), path.join(PKGVAR1, '.cloudflared', `${UUID}.json`), '已知 UUID 时返回精确路径');
  eq(resolveCredentials({ credentialsFile: '/nope/x.json' }), null, '显式路径不存在时返回 null');
  fs.writeFileSync(path.join(PKGVAR1, '.cloudflared', `${UUID2}.json`), JSON.stringify({ TunnelID: UUID2 }));
  eq(resolveCredentials({ tunnelId: UUID2 }), path.join(PKGVAR1, '.cloudflared', `${UUID2}.json`), '两个凭据文件时仍按 UUID 精确匹配');

  section('3 cloudflared 子命令参数位置  [E]');
  ok(splitArgs('--retries 5').join('|') === '--retries|5', 'splitArgs 拆分普通参数');
  ok(splitArgs('--tag "a b"').join('|') === '--tag|a b', 'splitArgs 保留引号内的空格');
  ok(globalArgs({ protocol: 'http2' }).includes('--no-autoupdate'), 'globalArgs 带 --no-autoupdate');
  {
    const src = fs.readFileSync(path.join(LIB, 'cloudflared.js'), 'utf8');
    ok(!/tunnel',\s*'--output'/.test(src), '--output 不再出现在 list/create 子命令之前');
    ok(/'tunnel',\s*'list',\s*'--output',\s*'json'/.test(src), 'tunnel list --output json 顺序正确');
    ok(/'tunnel',\s*'create',\s*'--output',\s*'json'/.test(src), 'tunnel create --output json 顺序正确');
  }

  section('3b readTailLines() 不得读未初始化内存  [L]');
  {
    /* The tail reader stats the file, then reads a window of that size with
     * Buffer.allocUnsafe. rotate() renames the log away every 30 seconds and a
     * fresh log starts empty, so the file can shrink between the two calls and
     * read() returns fewer bytes than requested. Decoding the whole buffer
     * anyway emits uninitialized heap memory straight into the UI.
     *
     * The race is made deterministic by reporting the pre-rotation size from
     * statSync while the file on disk is already the small fresh one -- which is
     * precisely the state rotate() creates. */
    const { readTailLines } = require(path.join(LIB, 'log.js'));
    const logFile = path.join(PKGVAR1, 'logs', 'tail-probe.log');
    fs.writeFileSync(logFile, 'real-1\nreal-2\n');

    const realStat = fs.statSync;
    const FAKE = 64 * 1024;
    /* Churn the heap so allocUnsafe is handed dirty memory rather than a fresh
     * zero page; the assertions below must hold regardless. */
    for (let i = 0; i < 40; i += 1) Buffer.allocUnsafe(FAKE).fill(0x41);

    let raced;
    try {
      fs.statSync = (p, ...rest) => {
        if (String(p) === logFile) return { isFile: () => true, size: FAKE };
        return realStat(p, ...rest);
      };
      raced = readTailLines(logFile, FAKE, 10);
    } finally {
      fs.statSync = realStat;
    }

    const realLines = ['real-1', 'real-2'];
    /* Compared with ok() rather than eq(): on failure the leaked bytes are
     * kilobytes of NUL characters, and dumping them buries the actual result. */
    ok(
      raced.join('|') === 'real-1|real-2',
      '文件在 stat 与 read 之间缩小时，只返回真实内容',
      `${raced.length} 行，首行 ${JSON.stringify(String(raced[0] || '').slice(0, 60))}`,
    );
    ok(
      raced.every((l) => realLines.includes(l)),
      '返回的每一行都来自文件本身（没有未初始化内存）',
      `越界行数 ${raced.filter((l) => !realLines.includes(l)).length}`,
    );

    /* The ordinary cases must keep working. */
    fs.writeFileSync(logFile, '');
    eq(readTailLines(logFile, 64 * 1024, 10).length, 0, '空文件返回空数组，不吐垃圾');

    fs.writeFileSync(logFile, 'short\n');
    eq(readTailLines(logFile, 64 * 1024, 10).join('|'), 'short', '窗口大于文件时只返回文件内容');

    /* Trim to a tail window: the first partial line must be dropped, and the
     * retained lines must still be the real ones. */
    const big = [];
    for (let i = 1; i <= 500; i += 1) big.push(`entry-${String(i).padStart(4, '0')}`);
    fs.writeFileSync(logFile, big.join('\n') + '\n');
    const tail = readTailLines(logFile, 200, 5);
    eq(tail.length, 5, '限制行数时只返回最后 5 行');
    eq(tail[tail.length - 1], 'entry-0500', '最后一行是最新的那条');
    ok(
      tail.every((l) => /^entry-\d{4}$/.test(l)),
      '窗口边界处的半行被丢弃，没有残缺内容',
      JSON.stringify(tail),
    );

    fs.rmSync(logFile, { force: true });
  }

  section('3c 隧道 id 不得逃出数据目录  [M]');
  {
    /* A tunnel id becomes a path component: TUNNELS_DIR/<id>/config.yml and
     * LOGS_DIR/<id>.log. config.json is read back from disk on every start, so
     * an id containing ".." or a separator would write outside the app's data
     * directories. The API always assigns a fresh id, so this only defends the
     * persisted state -- which is exactly the case that has no other check. */
    const { normalizeTunnel } = require(path.join(LIB, 'store.js'));
    const TUNNELS = paths.TUNNELS_DIR;

    const hostile = [
      '../../../../tmp/ESCAPED',
      '..\\..\\windows\\ESCAPED',
      'a/b',
      'a\\b',
      '/abs/path',
      'C:\\abs',
      '',
      '.',
      '..',
      'x'.repeat(200),
      'has space',
      'semi;colon',
    ];
    for (const bad of hostile) {
      const t = normalizeTunnel({ name: 'x', type: 'config', id: bad });
      const rel = path.relative(TUNNELS, path.join(TUNNELS, t.id, 'config.yml'));
      const escaped = rel.startsWith('..') || path.isAbsolute(rel);
      ok(!escaped, `id ${JSON.stringify(bad)} 被替换为安全值`, `得到 ${JSON.stringify(t.id)}`);
      ok(/^[A-Za-z0-9_-]{1,64}$/.test(t.id), `替换后的 id 形如 t_xxxx`, t.id);
    }

    /* Legitimate ids must survive untouched, or every existing tunnel is
     * rewritten on the next load and its config.yml/logs are orphaned. */
    for (const good of ['t_abc123', 't_fe08d81ca285', 'local-1', 'A_b-9']) {
      eq(normalizeTunnel({ name: 'x', id: good }).id, good, `正常 id ${good} 原样保留`);
    }
  }

  const PORT1 = 42000 + Math.floor(Math.random() * 3000);
  const { raw, api } = makeClient(PORT1);
  const readConfigJson = () => JSON.parse(fs.readFileSync(path.join(PKGVAR1, 'config.json'), 'utf8'));

  const server = http.createServer(requestHandler);
  await new Promise((r) => server.listen(PORT1, '127.0.0.1', r));
  loadConfig();
  console.log(`\n便携沙箱: ${TMP1}`);
  console.log(`监听    : http://127.0.0.1:${PORT1}`);

  try {
    section('4 静态资源与网关前缀');
    const index = await raw('/');
    ok(index.status === 200 && index.body.includes('<!doctype html>'), 'GET / 返回页面', `status=${index.status}`);
    ok(index.body.includes('window.__CF_BASE__ = ""'), '直连时 %%CF_BASE%% 替换为空串');
    eq((await raw('/style.css')).status, 200, 'GET /style.css 返回 200');
    eq((await raw('/nope.js')).status, 404, '未知静态资源返回 404');
    const spa = await raw('/some/deep/route');
    ok(spa.status === 200 && spa.body.includes('<!doctype html>'), '未知非资源路径回退到 index.html');
    const gw = await raw('/app/cloudflared/');
    ok(gw.status === 200 && gw.body.includes('window.__CF_BASE__ = "/app/cloudflared"'), '网关前缀注入到页面');
    const gwApi = await raw('/app/cloudflared/api/meta');
    eq(gwApi.status, 200, '带网关前缀访问 /api/meta 返回 200');

    /* The page is a template: %%CF_BASE%% must never reach the browser. A
     * missed placeholder silently breaks asset and API URLs, and the failure
     * looks like "the page loads but nothing works". */
    ok(!index.body.includes('%%CF_BASE%%'), '直连页面里没有残留 %%CF_BASE%%');
    ok(!gw.body.includes('%%CF_BASE%%'), '网关页面里没有残留 %%CF_BASE%%');
    /* Every asset the page actually references must be served. The references
     * are parsed out of the served HTML rather than hard-coded: a hard-coded
     * list would still pass if the page pointed at a file that does not exist,
     * which is precisely the failure this is meant to catch. */
    const refs = new Set();
    for (const m of index.body.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
      /* In-page anchors (#main, the skip link) are not assets. */
      if (url.startsWith('#')) continue;
      refs.add(url.split('?')[0]);
    }
    ok(refs.size >= 3, '页面里有若干本地资源引用', `${refs.size} 个`);
    for (const url of refs) {
      const r = await raw(url);
      eq(r.status, 200, `页面引用的 ${url} 可访问`);
    }
    /* The redesigned shell carries these landmarks; losing one breaks the UI
     * silently because the handlers bind to them by id. */
    for (const id of ['view-tunnels', 'view-account', 'view-settings', 'view-logs', 'tunnel-list', 'tunnel-summary', 'modal-backdrop']) {
      ok(index.body.includes(`id="${id}"`), `页面包含 #${id}`);
    }
    ok((index.body.match(/id="view-/g) || []).length === 4, '恰好 4 个视图区块');
    eq((await raw('/style.css')).body.includes('prefers-color-scheme'), true, '样式表包含明暗主题支持');

    section('5 目录穿越不能读到 www 之外  [F]');
    const sibling = await raw('/../www-evil/secret.txt');
    ok(sibling.status !== 200, 'GET /../www-evil/secret.txt 不被服务', `status=${sibling.status}`);
    ok(!String(sibling.body).includes('should never be served'), '没有泄漏 www 之外的文件内容');
    const encoded = await raw('/%2e%2e/www-evil/secret.txt');
    ok(encoded.status !== 200, 'GET /%2e%2e/www-evil/secret.txt 不被服务', `status=${encoded.status}`);
    const deep = await raw('/..%2f..%2fwww-evil%2fsecret.txt');
    ok(deep.status !== 200, 'GET /..%2f..%2fwww-evil 不被服务', `status=${deep.status}`);

    section('6 畸形请求不能拖垮后端  [G]');
    const pct = await raw('/%');
    ok(pct.status === 400 || pct.status === 404, 'GET /% 返回 4xx 而不是断连', `status=${pct.status} ${pct.error || ''}`);
    const nul = await raw('/%00');
    ok(nul.status === 400 || nul.status === 404, 'GET /%00 返回 4xx', `status=${nul.status}`);
    const health = await raw('/healthz');
    eq(health.status, 200, '畸形请求之后 /healthz 仍然可用');
    const big = await raw('/api/tunnels', {
      method: 'POST',
      body: 'x'.repeat(1050 * 1024),
      headers: { 'Content-Type': 'application/json' },
    });
    eq(big.status, 413, '超过 1MB 的请求体返回 413');
    eq((await raw('/healthz')).status, 200, '超大请求体之后后端仍然活着');

    section('7 meta 与设置');
    const meta = await api('GET', '/meta');
    ok(meta.status === 200 && meta.json.app === 'cloudflared', 'GET /api/meta 返回应用信息', meta.body.slice(0, 120));
    eq(meta.json.binaryExists, false, '报告内置 cloudflared 缺失（沙箱里确实没有）');
    eq(meta.json.loggedIn, false, '未登录时 loggedIn 为 false');
    const badProto = await api('PUT', '/settings', { protocol: 'ftp' });
    eq(badProto.status, 400, '拒绝非法 protocol');
    const badLevel = await api('PUT', '/settings', { logLevel: 'verbose' });
    eq(badLevel.status, 400, '拒绝非法 logLevel');
    const badPort = await api('PUT', '/settings', { metricsPort: 70000 });
    eq(badPort.status, 400, '拒绝超范围的 metrics 端口');
    const savedSettings = await api('PUT', '/settings', {
      protocol: 'http2', edgeIpVersion: '4', logLevel: 'warn', metricsPort: 20241, extraArgs: '--retries 5',
    });
    eq(savedSettings.status, 200, '保存合法设置');
    eq(readConfigJson().settings.protocol, 'http2', 'protocol 落盘到 config.json');
    eq(readConfigJson().settings.extraArgs, '--retries 5', '附加参数落盘');

    section('8 隧道增删改查');
    const created = await api('POST', '/tunnels', {
      name: 'quick-test', type: 'quick', target: 'http://127.0.0.1:5000', autoStart: false,
    });
    eq(created.status, 200, 'POST /api/tunnels 创建快速隧道', created.body.slice(0, 160));
    const id = created.json?.tunnel?.id;
    ok(!!id, '返回隧道 id', String(id));
    ok(fs.existsSync(path.join(PKGVAR1, 'config.json')), 'config.json 已落盘（依赖 ensureDirs 修复）');

    const list = await api('GET', '/tunnels');
    ok(list.status === 200 && list.json.tunnels.length === 1, 'GET /api/tunnels 返回 1 条');
    eq((await api('GET', `/tunnels/${id}`)).status, 200, 'GET /api/tunnels/:id 返回该隧道');
    eq((await api('GET', '/tunnels/t_missing')).status, 404, '不存在的隧道返回 404');

    const noName = await api('POST', '/tunnels', { name: '   ', type: 'quick', target: 'http://127.0.0.1:80' });
    eq(noName.status, 400, '拒绝空名称');
    const noToken = await api('POST', '/tunnels', { name: 'tk', type: 'token' });
    eq(noToken.status, 400, '拒绝缺少 Token 的 Token 隧道');
    const badTarget = await api('POST', '/tunnels', { name: 'q2', type: 'quick', target: '127.0.0.1:80' });
    eq(badTarget.status, 400, '拒绝不以 http(s):// 开头的服务地址');
    const traversal = await api('POST', '/tunnels', { name: 'cf', type: 'config', configFile: '/etc/../../etc/passwd' });
    eq(traversal.status, 400, '拒绝带 .. 的配置文件路径');

    const edited = await api('PUT', `/tunnels/${id}`, {
      name: 'quick-renamed', type: 'quick', target: 'http://127.0.0.1:6000', autoStart: false,
    });
    eq(edited.status, 200, 'PUT /api/tunnels/:id 保存成功');
    eq((await api('GET', `/tunnels/${id}`)).json.name, 'quick-renamed', '编辑后的名称已生效');

    section('9 启动：二进制缺失时优雅报错，不返回 500');
    const started = await api('POST', `/tunnels/${id}/start`);
    eq(started.status, 400, '缺少二进制时启动返回 400', started.body.slice(0, 160));
    ok(String(started.json?.error || '').includes('cloudflared'), '错误信息说明是 cloudflared 可执行文件缺失', String(started.json?.error));
    eq((await raw('/healthz')).status, 200, '启动失败之后后端仍然活着');

    section('10 删除隧道：曾经抛 ReferenceError 并留下重启定时器  [C]');
    runtimeRecord(id).restartTimer = setTimeout(() => {}, 60_000);
    const del = await api('DELETE', `/tunnels/${id}`);
    eq(del.status, 200, 'DELETE /api/tunnels/:id 返回 200（曾经是 500）', del.body.slice(0, 160));
    ok(!String(del.body).includes('is not defined'), '响应里没有 ReferenceError', del.body.slice(0, 160));
    const after = await api('GET', '/tunnels');
    ok(after.status === 200 && after.json.tunnels.length === 0, '删除后列表为空');
    eq((await api('GET', `/tunnels/${id}`)).status, 404, '删除后查询返回 404');
    eq(forgetTunnel(id), false, '运行时记录已移除（forgetTunnel 幂等）');

    section('11 本地管理隧道：不再拿别的凭据文件顶替  [D]');
    const localNoId = await api('POST', '/tunnels', {
      name: 'local-no-id', type: 'local', tunnelName: 'nas', autoStart: false, autoDns: true,
      ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }],
    });
    eq(localNoId.status, 200, '创建无 tunnelId 的本地管理隧道');
    const lid = localNoId.json?.tunnel?.id;
    eq(localNoId.json?.tunnel?.tunnelId, '', '未登录时 tunnelId 保持为空（没有凭据文件可解析）');

    const startLocal = await api('POST', `/tunnels/${lid}/start`);
    eq(startLocal.status, 400, '无 UUID 时启动被拒绝而不是跑错隧道', startLocal.body.slice(0, 200));
    /* 沙箱里没有二进制，所以 start 先报二进制缺失；真正要锁的是 buildArgs 不会
       拿别的凭据文件顶替。 */
    const built = buildArgs(
      { type: 'local', tunnelName: 'nas', tunnelId: '', ingress: [], catchAll: 'http_status:404' },
      {},
    );
    ok(!built.args, '只给名字时 buildArgs 拒绝启动', JSON.stringify(built));
    ok(String(built.error).includes('UUID'), '错误信息说明缺少 UUID', String(built.error));
    const builtMissing = buildArgs(
      { type: 'local', tunnelName: 'nas', tunnelId: UUID2 + 'f', ingress: [], catchAll: 'http_status:404' },
      {},
    );
    ok(!builtMissing.args, 'UUID 无对应凭据文件时拒绝启动', JSON.stringify(builtMissing));
    ok(String(builtMissing.error).includes('凭据文件'), '错误信息指出缺少凭据文件', String(builtMissing.error));

    const dnsLocal = await api('POST', `/tunnels/${lid}/dns`);
    ok(dnsLocal.status !== 500, 'DNS 路由接口不再返回 500', `${dnsLocal.status} ${dnsLocal.body.slice(0, 200)}`);
    ok(!String(dnsLocal.body).includes('is not defined'), 'DNS 接口没有 ReferenceError 泄漏');

    const dnsMissing = await api('POST', '/tunnels/t_missing/dns');
    eq(dnsMissing.status, 404, '对不存在的隧道修 DNS 返回 404');

    await api('DELETE', `/tunnels/${lid}`);

    section('12 Token 永不回传浏览器');
    const TOKEN = Buffer.from(JSON.stringify({
      a: '00000000000000000000000000000000',
      t: '00000000-0000-0000-0000-000000000000',
      s: 'SECRETTOKENMARKER',
    })).toString('base64');
    const tokenTunnel = await api('POST', '/tunnels', { name: 'argv-test', type: 'token', token: TOKEN, autoStart: false });
    eq(tokenTunnel.status, 200, '创建 Token 隧道');
    eq(tokenTunnel.json?.tunnel?.hasToken, true, '报告 hasToken');
    ok(!tokenTunnel.body.includes(TOKEN), '创建响应不含 Token 明文');
    ok(!tokenTunnel.body.includes('SECRETTOKENMARKER'), '创建响应不含 Token 内容');
    const tokenList = await api('GET', '/tunnels');
    ok(!tokenList.body.includes(TOKEN) && !tokenList.body.includes('SECRETTOKENMARKER'), '列表接口不含 Token 明文');
    ok(readConfigJson().tunnels.some((t) => t.token === TOKEN), 'Token 确实保存在服务端 config.json');
    /* POSIX 上 saveConfig 以 0600 落盘；Windows 的 chmod 只切换只读位，不体现
       POSIX 权限，所以这里只在类 Unix 平台断言。 */
    if (process.platform !== 'win32') {
      eq(fs.statSync(path.join(PKGVAR1, 'config.json')).mode & 0o777, 0o600, 'config.json 权限为 0600');
    } else {
      ok(true, 'config.json 权限断言在 Windows 上跳过（chmod 不体现 POSIX 位）');
    }

    section('13 账户接口');
    const account = await api('GET', '/account');
    eq(account.status, 200, 'GET /api/account 返回 200');
    eq(account.json.loggedIn, false, '未登录时报告未登录');
    const listTunnels = await api('GET', '/account/tunnels');
    eq(listTunnels.status, 400, '未登录时列出云端隧道返回 400');
    ok(String(listTunnels.json?.error || '').includes('登录'), '错误信息提示需要登录', String(listTunnels.json?.error));
    /* 畸形百分号编码曾让 decodeURIComponent 抛 URIError → 500；应与 GET /% 同一处理。 */
    const badName = await raw('/api/account/tunnels/%', { method: 'DELETE' });
    eq(badName.status, 400, 'DELETE /account/tunnels/% 返回 400 而不是 500', `${badName.status} ${badName.body.slice(0, 120)}`);
    ok(!String(badName.body).includes('URI malformed'), '响应里没有 URIError 泄漏');
    const badName2 = await raw('/api/account/tunnels/%zz', { method: 'DELETE' });
    eq(badName2.status, 400, 'DELETE /account/tunnels/%zz 返回 400');
    const badDns = await raw('/api/account/tunnels/%/dns', { method: 'POST' });
    eq(badDns.status, 400, 'POST /account/tunnels/%/dns 返回 400', `${badDns.status} ${badDns.body.slice(0, 120)}`);
    eq((await raw('/healthz')).status, 200, '畸形账户路径之后后端仍然活着');
    eq((await api('GET', '/account/unknown')).status, 404, '未知账户接口返回 404');
    eq((await api('GET', '/nope')).status, 404, '未知 API 返回 404');
    eq((await api('DELETE', '/settings')).status, 405, '不支持的方法返回 405');

    section('14 应用日志接口');
    const logs = await api('GET', '/logs');
    eq(logs.status, 200, 'GET /api/logs 返回 200');
    ok(Array.isArray(logs.json?.lines), '返回 lines 数组');

    /* The endpoint must read a bounded window. It used to pass the 2MB rotation
     * cap as the read window, so every 3-second poll pulled 2MB into memory and
     * decoded it -- the same unbounded read the per-tunnel endpoint was already
     * fixed for.
     *
     * The response is capped at 300 lines, so the window only becomes visible
     * when those 300 lines are themselves larger than the window: a 64KB read
     * then yields only the lines inside the final 64KB, while a 2MB read
     * returns all 300. Lines are made long enough (and numerous enough) that
     * the two differ, and the assertion is on the returned byte count. */
    {
      const { APP_LOG, MAX_TAIL_BYTES } = paths;
      const marker = 'APP-LOG-TAIL-MARKER';
      const lineLen = 400;
      const filler = 'f' + 'x'.repeat(lineLen - 1);
      const lines300 = lineLen * 300; // bytes of the final 300 lines
      ok(
        lines300 > MAX_TAIL_BYTES,
        '测试前提：最后 300 行本身大于读取窗口（否则测不出窗口大小）',
        `${lines300} vs ${MAX_TAIL_BYTES}`,
      );
      /* Enough lines that the file comfortably exceeds the window. */
      const count = Math.ceil((MAX_TAIL_BYTES * 3) / lineLen) + 300;
      const chunk = new Array(count).fill(filler);
      chunk.push(marker);
      fs.writeFileSync(APP_LOG, chunk.join('\n') + '\n');

      const big = await api('GET', '/logs');
      eq(big.status, 200, '大日志下 GET /api/logs 仍返回 200');
      const got = big.json?.lines || [];
      ok(got.length > 0, '返回了日志行');
      ok(got[got.length - 1] === marker, '返回的是文件尾部（含最后一行）', String(got[got.length - 1]).slice(0, 60));
      const bytes = got.reduce((n, l) => n + l.length + 1, 0);
      ok(
        bytes <= MAX_TAIL_BYTES + 4096,
        '响应体量受窗口上限约束（没有按 2MB 上限整段读入）',
        `${bytes} bytes，窗口 ${MAX_TAIL_BYTES}，行数 ${got.length}`,
      );
      fs.rmSync(APP_LOG, { force: true });
    }

    /* ------------------------------------------------------------------
     * The App Center settings page is a DIFFERENT process: cmd/config_callback
     * rewrites config.json while this service holds its own copy in memory. If
     * saveConfig() wrote the in-memory object wholesale, every later tunnel edit
     * would silently revert that change -- both pages report success, and the
     * user only notices the setting is back the way it was.
     * ------------------------------------------------------------------ */
    section('14b 外部进程改写的设置不得被隧道编辑回滚  [O]');
    {
      const cfgPath = path.join(PKGVAR1, 'config.json');
      const editTarget = await api('POST', '/tunnels', {
        name: 'lost-update', type: 'quick', target: 'http://127.0.0.1:7000', autoStart: false,
      });
      eq(editTarget.status, 200, '创建用于验证的隧道');
      const editId = editTarget.json?.tunnel?.id;

      /* Simulate cmd/config_callback: change settings on disk, behind the
       * service's back, exactly as the App Center settings page does. */
      const disk = readConfigJson();
      disk.settings.autoRestart = false;
      disk.settings.logLevel = 'debug';
      fs.writeFileSync(cfgPath, JSON.stringify(disk, null, 2) + '\n');

      /* Any tunnel edit calls saveConfig(). Before the fix this rewrote the
       * whole in-memory object and reverted both settings above. */
      const editedAfterExternal = await api('PUT', `/tunnels/${editId}`, {
        name: 'lost-update-renamed', type: 'quick', target: 'http://127.0.0.1:7100', autoStart: false,
      });
      eq(editedAfterExternal.status, 200, '外部改动之后编辑隧道仍然成功');

      const after = readConfigJson();
      eq(after.settings.autoRestart, false, '外部写入的 autoRestart 没有被隧道编辑回滚');
      eq(after.settings.logLevel, 'debug', '外部写入的 logLevel 没有被隧道编辑回滚');
      eq(after.tunnels.find((t) => t.id === editId)?.name, 'lost-update-renamed',
        '隧道编辑本身仍然落盘（合并没有丢掉自己的改动）');

      /* The reverse direction: when THIS process is the newer writer, its value
       * must win over whatever is on disk. */
      const disk2 = readConfigJson();
      disk2.settings.logLevel = 'debug';
      fs.writeFileSync(cfgPath, JSON.stringify(disk2, null, 2) + '\n');
      const putSettings = await api('PUT', '/settings', { logLevel: 'error' });
      eq(putSettings.status, 200, '设置页保存成功');
      eq(readConfigJson().settings.logLevel, 'error',
        '设置页的写入优先于并发的外部写入（不会被磁盘上的旧值盖掉）');

      await api('DELETE', `/tunnels/${editId}`);
    }

    /* ------------------------------------------------------------------
     * runtimeRecord() is a get-or-CREATE keyed on the raw URL segment, and
     * nothing ever reaps the entries it invents (DELETE 404s on unknown ids
     * first). Any :id route that reaches it without checking the tunnel exists
     * therefore lets an unauthenticated caller grow the Map without bound.
     * ------------------------------------------------------------------ */
    section('14c 未知隧道 id 不得在 runtime Map 里留下记录  [P]');
    {
      const bogus = 't_does_not_exist_at_all';
      eq(forgetTunnel(bogus), false, '前置：该 id 尚无运行时记录');

      eq((await api('GET', `/tunnels/${bogus}/logs`)).status, 404,
        'GET /tunnels/:id/logs 对未知 id 返回 404（曾经是 200 并创建记录）');
      eq(forgetTunnel(bogus), false, 'logs 路由没有为未知 id 创建运行时记录');

      eq((await api('POST', `/tunnels/${bogus}/stop`)).status, 404, 'stop 对未知 id 返回 404');
      eq(forgetTunnel(bogus), false, 'stop 路由没有为未知 id 创建运行时记录');

      eq((await api('POST', `/tunnels/${bogus}/restart`)).status, 404, 'restart 对未知 id 返回 404');
      eq(forgetTunnel(bogus), false, 'restart 路由没有为未知 id 创建运行时记录');

      /* A burst must not accumulate entries either. */
      for (let i = 0; i < 200; i += 1) await api('GET', `/tunnels/t_flood_${i}/logs`);
      const leaked = [];
      for (let i = 0; i < 200; i += 1) if (forgetTunnel(`t_flood_${i}`)) leaked.push(i);
      eq(leaked.length, 0, '200 个不同未知 id 之后 runtime Map 仍然没有新增记录',
        `泄漏了 ${leaked.length} 条`);

      /* And a REAL tunnel's logs route must still work. */
      const real = await api('POST', '/tunnels', {
        name: 'logs-real', type: 'quick', target: 'http://127.0.0.1:7200', autoStart: false,
      });
      const realId = real.json?.tunnel?.id;
      const realLogs = await api('GET', `/tunnels/${realId}/logs`);
      eq(realLogs.status, 200, '真实隧道的 logs 路由仍然返回 200');
      ok(Array.isArray(realLogs.json?.lines), '真实隧道的 logs 仍然返回 lines 数组');
      await api('DELETE', `/tunnels/${realId}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* ==========================================================================
 * Part 2 -- real host: the actual server.js process against a stub binary.
 * Needs bash (the stub is a shell script) and ps (orphan detection).
 * ========================================================================== */

function probe(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    /* A non-zero exit still proves the command exists; only ENOENT means absent. */
    return !(err && (err.code === 'ENOENT' || err.errno === -4058));
  }
}

const LINUX_OK =
  process.platform !== 'win32' && probe('bash', ['-c', 'true']) && probe('ps', ['-eo', 'pid,args']);

/* Only create the host sandbox when the host part can actually run: an eager
 * mkdtempSync would leave an empty directory behind on every Windows run, since
 * the code that removes it only executes on the Linux path. */
const TMP2 = LINUX_OK ? fs.mkdtempSync(path.join(os.tmpdir(), 'cf-backend-')) : '';
const APPDEST2 = TMP2 ? path.join(TMP2, 'target') : '';
const PKGVAR2 = TMP2 ? path.join(TMP2, 'var') : '';
const STUB_LOG = TMP2 ? path.join(PKGVAR2, 'stub.log') : '';
const PORT2 = 39000 + Math.floor(Math.random() * 2000);
const TUNNEL_UUID = UUID;

let server = null;

function writeStub() {
  const stub = `#!/bin/bash
# Stub cloudflared: records every invocation, emulates a graceful 2s shutdown.
LOG="\${TRIM_PKGVAR}/stub.log"
printf '%s\\n' "$*" >>"$LOG"
case " $* " in
  *" --version "*) echo "cloudflared version 2026.9.3 (built 2026-09-03)"; exit 0 ;;
  *" tunnel login "*) echo "Please open the following URL and log in: https://dash.cloudflare.com/argotunnel?callback=stub"; sleep 30; exit 0 ;;
  *" route dns "*) echo "INF Added CNAME which will route to this tunnel"; exit 0 ;;
  *" list "*) echo '[{"id":"${TUNNEL_UUID}","name":"nas","connections":[]}]'; exit 0 ;;
  *" create "*) echo "INF Created tunnel nas with id ${TUNNEL_UUID}"; exit 0 ;;
  *" delete "*) echo "INF Deleted tunnel"; exit 0 ;;
esac
case " $* " in
  *" tunnel run "*)
    trap 'if [ -f "\${TRIM_PKGVAR}/SLOW_EXIT" ]; then sleep 6; else sleep 2; fi; exit 0' TERM
    echo "INF Registered tunnel connection connIndex=0"
    while true; do sleep 1; done
    ;;
esac
exit 0
`;
  const bin = path.join(APPDEST2, 'bin', 'cloudflared');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, stub, { mode: 0o755 });
}

function setupHost() {
  fs.mkdirSync(path.join(PKGVAR2, '.cloudflared'), { recursive: true });
  /* 整个 server/ 目录（含 lib/ 模块）都要复制过去，只复制 server.js 会找不到模块。 */
  fs.cpSync(path.dirname(SERVER_JS), path.join(APPDEST2, 'server'), { recursive: true });
  fs.symlinkSync(WWW_DIR, path.join(APPDEST2, 'www'));
  writeStub();
  fs.writeFileSync(path.join(PKGVAR2, '.cloudflared', 'cert.pem'), 'stub-cert\n');
  fs.writeFileSync(
    path.join(PKGVAR2, '.cloudflared', `${TUNNEL_UUID}.json`),
    JSON.stringify({ AccountTunnelID: TUNNEL_UUID }),
  );
}

const serverEnv = () => ({
  ...process.env,
  TRIM_APPNAME: 'cloudflared',
  TRIM_APPDEST: APPDEST2,
  TRIM_PKGVAR: PKGVAR2,
  TRIM_PKGTMP: path.join(TMP2, 'tmp'),
  TRIM_PKGETC: path.join(TMP2, 'etc'),
  TRIM_SERVICE_PORT: String(PORT2),
});

async function startServer() {
  server = spawn(NODE, [path.join(APPDEST2, 'server', 'server.js')], {
    cwd: APPDEST2,
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.resume();
  for (let i = 0; i < 60; i += 1) {
    const r = await raw2('/healthz');
    if (r.status === 200) return true;
    await sleep(100);
  }
  return false;
}

function serverAlive() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return false;
  try {
    process.kill(server.pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

async function stopServer(signal = 'SIGTERM') {
  if (!serverAlive()) return;
  server.kill(signal);
  for (let i = 0; i < 100; i += 1) {
    if (!serverAlive()) return;
    await sleep(100);
  }
  server.kill('SIGKILL');
}

/* A crashed backend would make every later suite fail with ECONNREFUSED and
 * hide the real results, so each host suite makes sure the service is up first. */
async function ensureServer(label) {
  if (serverAlive()) return true;
  console.log(`  ! 后端已退出，为继续测试而重启（${label}）`);
  const okRestart = await startServer();
  if (!okRestart) fail += 1;
  return okRestart;
}

const { raw: raw2, api: api2 } = makeClient(PORT2);

/* ------------------------------------------------------------ state readers */

const stubCalls = () => {
  try {
    return fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    return [];
  }
};
const stubReset = () => fs.writeFileSync(STUB_LOG, '');
const routedHostnames = () =>
  stubCalls()
    .filter((l) => l.includes('route dns'))
    .map((l) => l.trim().split(/\s+/).pop());
const runInvocations = () => stubCalls().filter((l) => l.includes('tunnel run'));

const readConfigJson2 = () => JSON.parse(fs.readFileSync(path.join(PKGVAR2, 'config.json'), 'utf8'));
const configYml = (id) => {
  try {
    return fs.readFileSync(path.join(PKGVAR2, 'tunnels', id, 'config.yml'), 'utf8');
  } catch (err) {
    return '';
  }
};
const ymlHostnames = (id) => (configYml(id).match(/hostname: (\S+)/g) || []).map((s) => s.split(' ')[1]);

function stubProcessLines() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes(path.join(APPDEST2, 'bin', 'cloudflared')) && l.includes('tunnel run'))
      .map((l) => l.trim());
  } catch (err) {
    return [];
  }
}
const stubProcessCount = () => stubProcessLines().length;
const stubDump = () => stubProcessLines().map((l) => l.slice(0, 110)).join(' || ') || '(无)';

/* 泄漏定位：每个小节结束时报告仍然存活的桩进程 */
function leakCheck(label) {
  const n = stubProcessCount();
  ok(n === 0, `${label} 结束后没有遗留 cloudflared 进程`, stubDump());
  return n;
}

function killStubProcesses() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (line.includes(path.join(APPDEST2, 'bin', 'cloudflared')) && line.includes('tunnel run')) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (err) {
            /* already gone */
          }
        }
      }
    }
  } catch (err) {
    /* ignore */
  }
}

/* ------------------------------------------------------------ tunnel helpers */

const localTunnel = (over = {}) =>
  Object.assign(
    {
      name: 'nas',
      type: 'local',
      autoStart: false,
      autoRestart: false,
      tunnelName: 'nas',
      tunnelId: TUNNEL_UUID,
      catchAll: 'http_status:404',
      autoDns: true,
      ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }],
    },
    over,
  );

async function createTunnel(over) {
  const res = await api2('POST', '/tunnels', localTunnel(over));
  return { res, id: res.json && res.json.tunnel ? res.json.tunnel.id : null };
}

async function testHostMetaAndCommandLine() {
  section('15 真机：cloudflared 版本、登录状态与全局设置进入命令行  [J]');
  await ensureServer('15');
  const meta = await api2('GET', '/meta');
  ok(meta.status === 200 && meta.json.cloudflared === '2026.9.3', 'GET /api/meta 读出 cloudflared 版本', JSON.stringify(meta.json));
  ok(meta.json.loggedIn === true, 'GET /api/meta 报告已登录（cert.pem 存在）');

  const settings = await api2('GET', '/settings');
  ok(settings.status === 200 && settings.json.protocol === 'auto', 'GET /api/settings 返回默认值');

  const saved = await api2('PUT', '/settings', {
    protocol: 'http2',
    edgeIpVersion: '4',
    logLevel: 'warn',
    metricsPort: 20241,
    region: '',
    extraArgs: '--retries 5',
    autoStart: true,
    autoRestart: true,
  });
  ok(saved.status === 200, 'PUT /api/settings 保存合法设置（后续断言的前提）', `status=${saved.status}`);

  const { id } = await createTunnel({ ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] });
  stubReset();
  const started = await api2('POST', `/tunnels/${id}/start`);
  ok(started.status === 200, '启动隧道成功', `status=${started.status}`);
  await sleep(1200);
  const runLine = runInvocations()[0] || '';
  ok(runLine.includes('--protocol http2'), '全局 protocol 出现在命令行', runLine);
  ok(runLine.includes('--edge-ip-version 4'), '全局 edge-ip-version 出现在命令行', runLine);
  ok(runLine.includes('--loglevel warn'), '全局 loglevel 出现在命令行', runLine);
  ok(runLine.includes('--metrics 127.0.0.1:20241'), '全局 metrics 端口出现在命令行', runLine);
  ok(runLine.includes('--retries 5'), '全局「附加参数」生效（原来被忽略）', runLine);
  ok(runLine.includes('--no-autoupdate'), '命令行带 --no-autoupdate', runLine);
  await api2('POST', `/tunnels/${id}/stop`);
  await sleep(3500);
  await api2('DELETE', `/tunnels/${id}`);
  await api2('PUT', '/settings', { protocol: 'auto', edgeIpVersion: '', logLevel: 'info', metricsPort: 0, extraArgs: '' });
}

async function testHostValidation() {
  section('16 真机：本地管理隧道的入站校验');
  await ensureServer('16');
  leakCheck('第15节 meta/命令行');

  const noTunnel = await api2('POST', '/tunnels', { name: 'lc', type: 'local' });
  ok(noTunnel.status === 400 && noTunnel.json.error.includes('隧道'), '拒绝未选择隧道的本地管理隧道', noTunnel.body);

  const emptyHost = await api2('POST', '/tunnels', localTunnel({ name: 'h1', ingress: [{ hostname: '', service: 'http://127.0.0.1:80' }] }));
  ok(emptyHost.status === 400 && emptyHost.json.error.includes('缺少域名'), '拒绝缺少域名的入站规则', emptyHost.body);

  const schemeInHost = await api2('POST', '/tunnels', localTunnel({ name: 'h2', ingress: [{ hostname: 'https://nas.example.com', service: 'http://127.0.0.1:80' }] }));
  ok(schemeInHost.status === 400 && schemeInHost.json.error.includes('不合法'), '拒绝带协议的域名', schemeInHost.body);

  const portInHost = await api2('POST', '/tunnels', localTunnel({ name: 'h3', ingress: [{ hostname: 'nas.example.com:443', service: 'http://127.0.0.1:80' }] }));
  ok(portInHost.status === 400, '拒绝带端口的域名', portInHost.body);

  const wildcard = await api2('POST', '/tunnels', localTunnel({ name: 'h4', ingress: [{ hostname: '*.wild.example.com', service: 'http://127.0.0.1:80' }] }));
  ok(wildcard.status === 200, '接受通配域名', wildcard.body);
  if (wildcard.json && wildcard.json.tunnel) await api2('DELETE', `/tunnels/${wildcard.json.tunnel.id}`);

  const badService = await api2('POST', '/tunnels', localTunnel({ name: 'h5', ingress: [{ hostname: 'a.example.com', service: '127.0.0.1:80' }] }));
  ok(badService.status === 400 && badService.json.error.includes('http://'), '拒绝不以 http(s):// 开头的服务地址', badService.body);

  const missingFile = await api2('POST', '/tunnels', { name: 'cf2', type: 'config', configFile: '/nope/config.yml' });
  ok(missingFile.status === 200, '保存不存在的 config.yml 路径时先通过校验（启动时才报错）', missingFile.body);
  if (missingFile.json && missingFile.json.tunnel) {
    const start = await api2('POST', `/tunnels/${missingFile.json.tunnel.id}/start`);
    ok(start.status === 400 && String(start.json.error).includes('配置文件'), '启动时报告配置文件不存在', start.body);
    await api2('DELETE', `/tunnels/${missingFile.json.tunnel.id}`);
  }
}

async function testHostLifecycleAndDns() {
  section('17 真机：启停、config.yml 与 DNS 路由');
  await ensureServer('17');
  leakCheck('第16节 入参校验');
  const { id } = await createTunnel({ ingress: [
    { hostname: 'a.example.com', service: 'http://127.0.0.1:8080' },
    { hostname: 'b.example.com', service: 'https://127.0.0.1:9443' },
  ] });
  stubReset();
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);

  let view = (await api2('GET', `/tunnels/${id}`)).json;
  ok(view.status === 'running', '启动后状态为运行中', view.status);
  ok(view.pid > 0, '启动后带 PID', String(view.pid));
  ok(view.dnsStatus === 'ok', 'DNS 路由检查通过', `${view.dnsStatus} ${view.dnsMessage}`);
  ok(routedHostnames().includes('a.example.com') && routedHostnames().includes('b.example.com'), '两条域名都执行了 route dns', routedHostnames().join(','));
  ok(ymlHostnames(id).join(',') === 'a.example.com,b.example.com', 'config.yml 写入两条域名', ymlHostnames(id).join(','));
  ok(configYml(id).includes('service: https://127.0.0.1:9443'), 'config.yml 保留 https 服务地址');
  ok(configYml(id).includes('service: http_status:404'), 'config.yml 带兜底规则');
  ok(configYml(id).includes(`credentials-file: ${path.join(PKGVAR2, '.cloudflared', `${TUNNEL_UUID}.json`)}`), 'config.yml 指向凭据文件');

  const again = await api2('POST', `/tunnels/${id}/start`);
  ok(again.status === 200 && again.json.already === true, '重复启动不产生第二个进程', JSON.stringify(again.json));
  ok(stubProcessCount() === 1, '同一隧道只有一个 cloudflared 进程', stubDump());

  await api2('POST', `/tunnels/${id}/stop`);
  await sleep(3500);
  view = (await api2('GET', `/tunnels/${id}`)).json;
  ok(view.status === 'stopped', '停止后状态为已停止', view.status);
  ok(view.pid === null, '停止后 PID 清空', String(view.pid));
  ok(stubProcessCount() === 0, '停止后没有残留 cloudflared 进程', stubDump());

  await api2('DELETE', `/tunnels/${id}`);
  const gone = await api2('GET', `/tunnels/${id}`);
  ok(gone.status === 404, '删除后查询返回 404', String(gone.status));
}

async function testHostEditWhileRunning() {
  section('18 真机：运行中新增域名（重启竞态）  [H]');
  await ensureServer('18');
  leakCheck('第17节 启停/DNS');
  const { id } = await createTunnel({ ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] });
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);
  stubReset();

  const updated = await api2('PUT', `/tunnels/${id}`, localTunnel({ ingress: [
    { hostname: 'a.example.com', service: 'http://127.0.0.1:8080' },
    { hostname: 'c.example.com', service: 'http://127.0.0.1:7070' },
  ] }));
  ok(updated.status === 200, '保存返回 200', updated.body.slice(0, 120));

  let sawStopped = false;
  for (let i = 0; i < 12; i += 1) {
    await sleep(1000);
    const v = (await api2('GET', `/tunnels/${id}`)).json;
    if (v.status === 'stopped') sawStopped = true;
    if (v.status === 'running' && i >= 3) break;
  }
  const view = (await api2('GET', `/tunnels/${id}`)).json;
  ok(!sawStopped, '重启过程中从未出现「已停止」（旧进程的 exit 不会覆盖新进程）');
  ok(view.status === 'running', '重启后状态为运行中', `${view.status} err=${view.error}`);
  ok(view.pid > 0, '重启后 PID 有效', String(view.pid));
  ok(stubProcessCount() === 1, '重启后只有一个 cloudflared 进程', stubDump());
  ok(runInvocations().length === 1, '整个重启只启动了一次 cloudflared（没有重复拉起）', `启动次数=${runInvocations().length}`);
  ok(routedHostnames().includes('c.example.com'), '新增域名补建了 DNS 路由', routedHostnames().join(','));
  ok(ymlHostnames(id).includes('c.example.com'), 'config.yml 包含新增域名', ymlHostnames(id).join(','));

  await api2('POST', `/tunnels/${id}/stop`);
  await sleep(3500);
  await api2('DELETE', `/tunnels/${id}`);
}

async function testHostSaveWhileStopped() {
  section('19 真机：未运行时保存新域名  [I]');
  await ensureServer('19');
  leakCheck('第18节 运行中新增域名');
  const { id } = await createTunnel({ ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] });
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);
  await api2('POST', `/tunnels/${id}/stop`);
  await sleep(3500);
  stubReset();

  const saved = await api2('PUT', `/tunnels/${id}`, localTunnel({ ingress: [
    { hostname: 'a.example.com', service: 'http://127.0.0.1:8080' },
    { hostname: 'd.example.com', service: 'http://127.0.0.1:6060' },
  ] }));
  ok(saved.status === 200, '保存返回 200', saved.body.slice(0, 120));
  await sleep(2500);

  ok(ymlHostnames(id).includes('d.example.com'), '未运行时保存也会更新 config.yml', ymlHostnames(id).join(','));
  ok(routedHostnames().includes('d.example.com'), '未运行时保存也会补建 DNS 路由', routedHostnames().join(','));
  ok(stubProcessCount() === 0, '未运行时保存不会擅自启动进程', stubDump());

  const view = (await api2('GET', `/tunnels/${id}`)).json;
  ok(view.status === 'stopped', '状态仍为已停止', view.status);
  await api2('DELETE', `/tunnels/${id}`);
}

async function testHostRestartAndAutoDnsOff() {
  section('20 真机：重启按钮与关闭自动 DNS 路由');
  await ensureServer('20');
  leakCheck('第19节 未运行保存');
  const { id } = await createTunnel({ ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] });
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);
  stubReset();
  await api2('POST', `/tunnels/${id}/restart`);
  await sleep(6000);
  const view = (await api2('GET', `/tunnels/${id}`)).json;
  ok(view.status === 'running', '重启按钮后状态为运行中', `${view.status} err=${view.error}`);
  ok(stubProcessCount() === 1, '重启按钮后只有一个进程', stubDump());
  ok(runInvocations().length === 1, '重启按钮只启动一次 cloudflared', `启动次数=${runInvocations().length}`);
  await api2('POST', `/tunnels/${id}/stop`);
  await sleep(3500);

  stubReset();
  await api2('PUT', `/tunnels/${id}`, localTunnel({ autoDns: false, ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] }));
  await sleep(2000);
  ok(routedHostnames().length === 0, '关闭自动 DNS 路由后不调用 route dns', routedHostnames().join(','));
  await api2('DELETE', `/tunnels/${id}`);
}

async function testHostShutdownLeavesNoOrphans() {
  section('21 真机：服务关停不留孤儿进程  [K]');
  await ensureServer('21');
  leakCheck('第20节 重启/关闭自动DNS');
  const { id } = await createTunnel({ ingress: [{ hostname: 'a.example.com', service: 'http://127.0.0.1:8080' }] });
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);
  ok(stubProcessCount() === 1, '关停前有一个 cloudflared 进程', stubDump());

  await stopServer('SIGTERM');
  await sleep(4000);
  ok(stubProcessCount() === 0, 'SIGTERM 关停后没有残留 cloudflared 进程', stubDump());
  leakCheck('第21节 SIGTERM 之后');
  ok(await startServer(), '服务可以重新启动');

  /* 慢退出场景：真实 cloudflared 优雅退出可能超过 2.5 秒。如果服务先退出，子进程
   * 会被交给 init 变成孤儿，仍然占着隧道连接，而应用再也看不到、停不掉它。 */
  fs.writeFileSync(path.join(PKGVAR2, 'SLOW_EXIT'), '1');
  await api2('POST', `/tunnels/${id}/start`);
  await sleep(3000);
  ok(stubProcessCount() === 1, '慢退出场景下隧道已启动', stubDump());
  const t0 = Date.now();
  server.kill('SIGTERM');
  let leftEarly = false;
  while (stubProcessCount() > 0 && Date.now() - t0 < 20000) {
    if (!serverAlive()) {
      leftEarly = true;
      break;
    }
    await sleep(200);
  }
  ok(!leftEarly, '关停时后端会等 cloudflared 退出，不会先把子进程丢成孤儿');
  ok(stubProcessCount() === 0, `慢退出场景下关停后没有孤儿 cloudflared（等待 ${Date.now() - t0}ms）`, stubDump());
  for (let i = 0; i < 40 && serverAlive(); i += 1) await sleep(250);
  ok(!serverAlive(), '子进程退出后后端才退出');
  try {
    fs.unlinkSync(path.join(PKGVAR2, 'SLOW_EXIT'));
  } catch (err) {
    /* ignore */
  }
  ok(await startServer(), '慢退出场景后服务仍可启动');
  const list = await api2('GET', '/tunnels');
  ok(list.status === 200, '重启后 API 可用', String(list.status));
  await api2('DELETE', `/tunnels/${id}`);
}

async function testHostAccountLogin() {
  section('22 真机：账户登录流程');
  await ensureServer('22');
  leakCheck('第21节 关停');
  const login = await api2('POST', '/account/login');
  ok(login.status === 200 && login.json.ok === true, 'POST /account/login 返回 ok', login.body.slice(0, 120));
  await sleep(800);
  const st = await api2('GET', '/account');
  /* 登录流程会先清掉旧的 cert.pem，再以「cert.pem 出现」作为成功信号，
     所以此刻正确的状态是 waiting + 已捕获授权链接，而不是已登录。 */
  ok(st.status === 200 && st.json.loggedIn === false, '登录进行中时报告未登录', JSON.stringify(st.json).slice(0, 140));
  ok(st.json.status === 'waiting', '登录状态为 waiting', st.json.status);
  ok(String(st.json.url).includes('https://'), '捕获到授权链接', String(st.json.url).slice(0, 80));
  ok(typeof st.json.certPath === 'string' && st.json.certPath.includes('.cloudflared'), '报告 cert.pem 路径', st.json.certPath);
  const out = await api2('POST', '/account/logout');
  ok(out.status === 200, 'POST /account/logout 返回 200', out.body.slice(0, 120));
  const after = await api2('GET', '/account');
  ok(after.json.loggedIn === false, '退出登录后报告未登录', JSON.stringify(after.json).slice(0, 120));
  fs.writeFileSync(path.join(PKGVAR2, '.cloudflared', 'cert.pem'), 'stub-cert\n');
  const restored = await api2('GET', '/account');
  ok(restored.json.loggedIn === true, '恢复 cert.pem 后再次报告已登录');
}

async function runHostSuite() {
  console.log(`\n真机后端: ${SERVER_JS}`);
  console.log(`真机沙箱: ${TMP2}`);
  setupHost();
  if (!(await startServer())) {
    fail += 1;
    console.log('  \u2717 后端未能启动，真机部分中止');
    return;
  }
  try {
    await testHostMetaAndCommandLine();
    await testHostValidation();
    await testHostLifecycleAndDns();
    await testHostEditWhileRunning();
    await testHostSaveWhileStopped();
    await testHostRestartAndAutoDnsOff();
    await testHostShutdownLeavesNoOrphans();
    await testHostAccountLogin();
  } catch (err) {
    fail += 1;
    console.log(`\n  \u2717 真机部分抛出异常: ${err && err.stack ? err.stack : err}`);
  } finally {
    await stopServer('SIGTERM');
    await sleep(1500);
    killStubProcesses();
  }
}

/* -------------------------------------------------------------------- main */

(async () => {
  try {
    await runPortableSuite();
  } catch (err) {
    fail += 1;
    console.log(`\n  \u2717 便携部分抛出异常: ${err && err.stack ? err.stack : err}`);
  }

  if (LINUX_OK) {
    try {
      await runHostSuite();
    } finally {
      try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  } else {
    console.log('\n[15-22 真机部分已跳过]');
    console.log('  需要 bash、ps 与 POSIX 进程模型（Windows 上不可用）。');
    console.log('  请在 NAS 上运行同一命令以获得全链路覆盖：node tools/test-backend.mjs');
  }

  try { fs.rmSync(TMP1, { recursive: true, force: true }); } catch (err) { /* ignore */ }

  console.log(`\n全部结果：${pass} 项通过，${fail} 项失败`);
  if (fail > 0) process.exitCode = 1;
})();
