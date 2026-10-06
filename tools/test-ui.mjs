/*
 * Front-end regression test for Cloudflare Tunnel for fnOS.
 *
 * Loads app/www/app.js into a vm context with a minimal DOM stub and exercises
 * the tunnel list rendering and the tunnel modal.
 *
 * Bugs and behaviours it guards against:
 *
 *   [1] 账户页的「新建隧道配置」按钮把预填对象当成「正在编辑的隧道」传给了
 *       openTunnelModal，于是 state.editing 被设成一个没有 id 的对象，保存时
 *       发出 PUT /api/tunnels/undefined，后端回 404「隧道不存在」。
 *   [2] 表单收集：手动输入隧道名时不能沿用下拉项携带的 UUID（会指错隧道）。
 *   [3] 端口留空时按协议补 80/443。
 *   [4] 轮询渲染必须是「内容不变就不碰 DOM」：3 秒一次的刷新若每次都重建
 *       innerHTML，展开的日志框会被反复拉回顶部，焦点和滚动位置也会丢。
 *   [5] 日志文本不能进入卡片 HTML：运行中的隧道每秒都在输出，一旦内联进去，
 *       每次轮询都会重建整个列表。
 *   [6] 日志框只在用户本来就在底部时才跟随最新行。
 *   [7] 状态筛选：分类计数归零后要退回「全部」，否则列表会整片空白且无法退出。
 *
 * Run: node tools/test-ui.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CF_APP_JS || path.resolve(HERE, '..', 'cloudflared', 'app', 'www', 'app.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ── minimal DOM ─────────────────────────────────────────────────────────── */

const els = new Map();

function makeLogbox() {
  return {
    _sel: '.logbox',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/* A tunnel card parsed out of the list markup. Enough shape for
 * logBoxFor()/captureLogScroll() to walk it the way a browser would. */
function makeCard(id, hasLogbox) {
  const box = hasLogbox ? makeLogbox() : null;
  return {
    _sel: '.tunnel-card',
    dataset: { id },
    querySelector: (sel) => (String(sel).includes('logbox') ? box : null),
    querySelectorAll: () => [],
  };
}

function parseCards(html) {
  const cards = [];
  const re = /<article class="card tunnel-card is-([a-z]+)" data-id="([^"]+)">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    cards.push(makeCard(m[2], m[3].includes('logbox tunnel-log')));
  }
  return cards;
}

function makeEl(sel) {
  const e = {
    _sel: sel,
    _html: '',
    _writes: 0,
    value: '',
    checked: false,
    textContent: '',
    className: '',
    title: '',
    disabled: false,
    dataset: {},
    selectedOptions: [],
    style: {},
    classList: {
      _s: new Set(['hidden']),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
    },
    _h: {},
    addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
    setAttribute() {},
    focus() {},
    select() {},
    remove() {},
    insertAdjacentHTML() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  /* innerHTML is a setter so the tests can count DOM writes -- the whole point
   * of the incremental render is that a quiet poll performs none. */
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._html; },
    set(v) {
      e._html = String(v);
      e._writes += 1;
    },
  });
  if (sel === '#tunnel-list') {
    /* A real DOM returns the *same* nodes for repeated queries against unchanged
     * markup. Re-parsing on every call would hand out fresh objects, so any
     * mutation a test made to a log box would silently vanish. */
    let cachedFor = null;
    let cached = [];
    e.querySelectorAll = (s) => {
      if (!String(s).includes('tunnel-card')) return [];
      if (cachedFor !== e._html) {
        cached = parseCards(e._html);
        cachedFor = e._html;
      }
      return cached;
    };
  }
  els.set(sel, e);
  return e;
}
function $(sel) {
  if (!els.has(sel)) makeEl(sel);
  return els.get(sel);
}

const requests = [];
let responder = async () => ({ ok: true, status: 200, text: async () => '{}' });

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  prompt: () => null,
  confirm: () => true,
  fetch: async (url, opts) => {
    requests.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    return responder(url, opts);
  },
  window: { __CF_BASE__: '/app/cloudflared' },
  document: {
    activeElement: null,
    visibilityState: 'visible',
    querySelector: $,
    querySelectorAll: (sel) => {
      if (String(sel).includes('tunnel-card')) return $('#tunnel-list').querySelectorAll('.tunnel-card');
      return [];
    },
    addEventListener: () => {},
    createElement: () => makeEl('created'),
    body: { appendChild() {} },
  },
};
sandbox.globalThis = sandbox;

process.on('unhandledRejection', () => {});

/* ── load app.js ─────────────────────────────────────────────────────────── */

let src = fs.readFileSync(APP, 'utf8');
src += `\n;globalThis.__T = { state, openTunnelModal, collectTunnelForm, saveTunnelModal, splitService,`
  + ` renderTunnels, tunnelCardHtml, logBoxFor, updateLogBox, switchView, eachCardBox };\n`;

const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'app.js' });
const T = sandbox.__T;

/* ── test 1: 账户页「新建隧道配置」必须走新建，而不是编辑 ────────────────── */

console.log('\n[1] 账户页「新建隧道配置」→ 新建模式');
T.state.accountTunnels = [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'nas', connections: 0, createdAt: '' }];
T.state.tunnels = [];
T.state.editing = { bogus: true }; // 先污染，确保 openTunnelModal 会覆盖它

const accountClick = $('#account-tunnel-list')._h.click[0];
await accountClick({
  target: { closest: () => ({ dataset: { accountAct: 'use', name: 'nas' } }) },
});

ok(T.state.editing === null, 'state.editing 为 null（不再被预填对象污染）', `got ${JSON.stringify(T.state.editing)}`);
eq($('#modal-title').textContent, '新建隧道', '弹窗标题为「新建隧道」');

/* ── test 2: 表单收集到隧道 ID（用于精确定位凭据文件） ───────────────────── */

console.log('\n[2] 表单收集');
$('#f-name').value = 'nas';
$('#f-type').value = 'local';
$('#f-autostart').checked = true;
$('#f-note').value = '';
$('#f-extra').value = '';
$('#f-catchall').value = 'http_status:404';
$('#f-tunnel-name-manual').value = 'nas';
const sel = $('#f-tunnel-name');
sel.value = 'nas';
sel.selectedOptions = [{ value: 'nas', dataset: { id: 'aaaaaaaa-1111-2222-3333-444444444444' } }];

let payload = T.collectTunnelForm();
eq(payload.type, 'local', 'type = local');
eq(payload.tunnelName, 'nas', 'tunnelName = nas');
eq(payload.tunnelId, 'aaaaaaaa-1111-2222-3333-444444444444', 'tunnelId 取自下拉项 data-id');
eq(payload.catchAll, 'http_status:404', 'catchAll 保留');

// 手动输入了别的名字 → 不能沿用下拉项的 ID
$('#f-tunnel-name-manual').value = 'other-tunnel';
payload = T.collectTunnelForm();
eq(payload.tunnelName, 'other-tunnel', '手动输入优先');
eq(payload.tunnelId, '', '名字不匹配时不沿用下拉项的 ID');

// 恢复成用户截图里的状态
$('#f-tunnel-name-manual').value = 'nas';

/* ── test 3: 保存必须发 POST /api/tunnels（不是 PUT /undefined） ─────────── */

console.log('\n[3] 保存请求');
responder = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, tunnel: { id: 't1' } }) });
requests.length = 0;
await T.saveTunnelModal();

const save = requests.find((r) => r.method === 'POST' || r.method === 'PUT');
ok(!!save, '发出了一次写入请求');
if (save) {
  eq(save.method, 'POST', 'HTTP 方法是 POST');
  eq(save.url, '/app/cloudflared/api/tunnels', 'URL 是 /api/tunnels（没有 /undefined）');
  const sent = JSON.parse(save.body || '{}');
  eq(sent.tunnelName, 'nas', '请求体 tunnelName = nas');
  eq(sent.tunnelId, 'aaaaaaaa-1111-2222-3333-444444444444', '请求体带上了 tunnelId');
}
ok(!requests.some((r) => String(r.url).includes('undefined')), '没有任何请求 URL 含 undefined');

/* ── test 4: 已有本地配置时，点「新建隧道配置」应进入编辑 ────────────────── */

console.log('\n[4] 已存在本地配置 → 编辑模式');
T.state.tunnels = [{ id: 'local-1', type: 'local', name: 'nas', tunnelName: 'nas', ingress: [] }];
await accountClick({
  target: { closest: () => ({ dataset: { accountAct: 'use', name: 'nas' } }) },
});
ok(T.state.editing && T.state.editing.id === 'local-1', 'state.editing 指向已有的本地配置', JSON.stringify(T.state.editing));
eq($('#modal-title').textContent, '编辑隧道', '弹窗标题为「编辑隧道」');

/* ── test 5: 本地服务拆成 协议 / 地址 / 端口，端口留空按协议补默认 ────────── */

console.log('\n[5] 本地服务地址拆分与端口默认值');

eq(T.splitService('http://127.0.0.1:5666').host, '127.0.0.1', '解析出主机');
eq(T.splitService('http://127.0.0.1:5666').port, '5666', '解析出端口');
eq(T.splitService('https://example.com').protocol, 'https', '解析出协议 https');
eq(T.splitService('https://example.com').port, '', '未写端口时端口为空');
eq(T.splitService('').host, '', '空值不炸');

// 表单侧：模拟一行入站规则，端口留空。
const rowHost = { value: '127.0.0.1' };
const rowPort = { value: '' };
const rowProto = { value: 'https' };
const rowHostname = { value: 'nas.example.com' };
const ruleRow = {
  querySelector(sel) {
    if (sel.includes('hostname')) return rowHostname;
    if (sel.includes('protocol')) return rowProto;
    if (sel.includes('host')) return rowHost;
    if (sel.includes('port')) return rowPort;
    if (sel.includes('noTLSVerify')) return { checked: false };
    return null;
  },
};
sandbox.document.querySelectorAll = (sel) => {
  if (String(sel).includes('#rule-list')) return [ruleRow];
  if (String(sel).includes('tunnel-card')) return $('#tunnel-list').querySelectorAll('.tunnel-card');
  return [];
};

$('#f-type').value = 'local';
$('#f-name').value = 'nas';
$('#f-autostart').checked = true;
$('#f-note').value = '';
$('#f-extra').value = '';
$('#f-catchall').value = 'http_status:404';
$('#f-tunnel-name-manual').value = 'nas';
$('#f-tunnel-name').value = 'nas';
$('#f-tunnel-name').selectedOptions = [{ value: 'nas', dataset: { id: 'aaaaaaaa-1111-2222-3333-444444444444' } }];

const p5 = T.collectTunnelForm();
eq(p5.ingress.length, 1, '收集到 1 条入站规则');
eq(p5.ingress[0].service, 'https://127.0.0.1:443', 'https 且端口留空 → 补 443');

rowProto.value = 'http';
const p5b = T.collectTunnelForm();
eq(p5b.ingress[0].service, 'http://127.0.0.1:80', 'http 且端口留空 → 补 80');

rowPort.value = '5666';
const p5c = T.collectTunnelForm();
eq(p5c.ingress[0].service, 'http://127.0.0.1:5666', '填了端口就按填的走');

sandbox.document.querySelectorAll = (sel) => {
  if (String(sel).includes('tunnel-card')) return $('#tunnel-list').querySelectorAll('.tunnel-card');
  return [];
};

/* ── test 6: 轮询渲染必须内容不变就不碰 DOM ──────────────────────────────── */

console.log('\n[6] 增量渲染（性能）');

const list = $('#tunnel-list');
T.state.openLogs = {};
T.state.logs = {};
T.state.filter = 'all';
T.state.tunnels = [
  { id: 't1', name: 'nas', type: 'token', status: 'running', hasToken: true, tokenPreview: 'eyJh…abcd', autoStart: true, ingress: [] },
  { id: 't2', name: 'web', type: 'quick', status: 'stopped', target: 'http://127.0.0.1:8080', autoStart: false, ingress: [] },
];

list._writes = 0;
T.renderTunnels();
const afterFirst = list._writes;
ok(afterFirst === 1, '首次渲染写入一次 innerHTML', `writes=${afterFirst}`);

// 同一份数据再来两次 —— 模拟 3 秒一次的轮询，状态没有变化。
T.renderTunnels();
T.renderTunnels();
eq(list._writes, afterFirst, '数据未变化时后续轮询不再写 DOM');

// 状态真的变了 → 必须重绘
T.state.tunnels[0].status = 'error';
T.renderTunnels();
eq(list._writes, afterFirst + 1, '状态变化时才重绘');
ok(list.innerHTML.includes('is-error'), '重绘后的卡片带上了新的状态类');

/* ── test 7: 日志文本不得内联进卡片 HTML ─────────────────────────────────── */

console.log('\n[7] 日志不进列表 HTML');

T.state.openLogs = { t1: true };
T.state.logs = { t1: ['MARKER-UNIQUE-LINE-1', 'MARKER-UNIQUE-LINE-2'] };
T.renderTunnels();
ok(list.innerHTML.includes('logbox tunnel-log'), '展开日志时卡片里有日志框占位');
ok(!list.innerHTML.includes('MARKER-UNIQUE-LINE'), '日志正文没有被写进列表 HTML（否则每次轮询都会重建列表）');

const box = T.logBoxFor('t1');
ok(!!box, 'logBoxFor 能找到该隧道的日志框');
ok(box && box.textContent.includes('MARKER-UNIQUE-LINE-1'), '日志正文通过就地更新写入日志框');

/* ── test 8: 日志框只在底部时跟随最新行 ─────────────────────────────────── */

console.log('\n[8] 日志跟随策略');

const b1 = T.logBoxFor('t1');
b1.scrollTop = 100;
b1.scrollHeight = 200;
b1.clientHeight = 100; // 正好在底部
T.updateLogBox(b1, ['A', 'B', 'C']);
eq(b1.scrollTop, 200, '本来就在底部 → 跟随到最新行');

const b2 = T.logBoxFor('t1');
b2.scrollTop = 0;
b2.scrollHeight = 200;
b2.clientHeight = 100; // 用户滚上去看历史了
T.updateLogBox(b2, ['A', 'B', 'C', 'D']);
eq(b2.scrollTop, 0, '用户滚上去看历史 → 不被拉回底部');

const b3 = T.logBoxFor('t1');
b3.textContent = 'SAME';
b3.scrollTop = 5;
b3.scrollHeight = 200;
b3.clientHeight = 100;
T.updateLogBox(b3, ['SAME']);
eq(b3.scrollTop, 5, '文本没变时完全不碰日志框');

/* ── test 9: 状态筛选 ────────────────────────────────────────────────────── */

console.log('\n[9] 状态筛选');

T.state.openLogs = {};
T.state.filter = 'error';
T.renderTunnels();
ok(list.innerHTML.includes('is-error'), '筛选「异常」只渲染异常隧道');
ok(!list.innerHTML.includes('data-id="t2"'), '非异常隧道被过滤掉');

// 最后一条异常隧道恢复正常 → 筛选分类归零，必须退回「全部」，否则整片空白
T.state.tunnels[0].status = 'running';
T.renderTunnels();
eq(T.state.filter, 'all', '分类归零后自动退回「全部」');
ok(list.innerHTML.includes('data-id="t1"') && list.innerHTML.includes('data-id="t2"'), '退回后两条隧道都可见');

// 汇总栏计数
const summaryHtml = $('#tunnel-summary').innerHTML;
ok(summaryHtml.includes('全部'), '汇总栏有「全部」计数');
ok(summaryHtml.includes('>2<'), '汇总栏「全部」计数为 2', summaryHtml.slice(0, 200));

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
