/*
 * Cloudflare Tunnel for fnOS — web UI.
 *
 * Plain ES2020, no build step, no dependencies. The gateway prefix is injected
 * by the backend through window.__CF_BASE__ so the same code works both behind
 * the fnOS unified gateway (/app/cloudflared/...) and on a direct port.
 *
 * Rendering contract, because it drives both performance and behaviour:
 *
 *   1. renderTunnels() builds the whole list as one HTML string and writes it
 *      only when that string actually changed. Polling every few seconds is the
 *      normal case, and most polls change nothing -- with the string compare a
 *      quiet poll costs no DOM work at all, so open log boxes keep their scroll
 *      position, focus is not stolen, and no animation restarts.
 *   2. Tunnel log text is deliberately NOT part of that string. A running tunnel
 *      prints lines constantly; if the text were inlined, every poll would
 *      rebuild the list. Instead each open log box is updated in place.
 *   3. An updated log box follows the tail only when the user was already at the
 *      bottom, so scrolling back to read an error is not yanked away.
 */
'use strict';

const BASE = window.__CF_BASE__ || '';
const API = BASE + '/api';

const TYPE_LABEL = {
  token: 'Token 隧道',
  quick: '快速隧道',
  local: '本地管理隧道',
  config: '自定义配置',
};

const TYPE_HELP = {
  token: '在 Cloudflare Zero Trust → Networks → Tunnels 创建隧道，复制 Token 粘贴到下面。最省事的方式。',
  quick: '无需账户，启动后得到一个随机的 trycloudflare.com 临时域名，适合临时演示。',
  local: '需要先登录 Cloudflare 账户，并创建一条命名隧道。可以自动写入 DNS 路由。',
  config: '直接使用你自己写的 config.yml，应用只负责拉起进程。',
};

const STATUS_LABEL = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  error: '异常',
};

const state = {
  meta: null,
  settings: null,
  tunnels: [],
  account: null,
  accountTunnels: [],
  accountQuery: '',
  editing: null,
  filter: 'all',
  logs: {},
  openLogs: {},
  busy: {},
};

/* ── helpers ──────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + (kind || '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'err' ? 6000 : 2800);
}

function setBusy(key, value) {
  state.busy[key] = value;
}

function isBusy(key) {
  return !!state.busy[key];
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/* True while the tab is hidden. Polling is skipped then: a background tab has
   no one reading it, and on a NAS the wakeups are pure waste. */
function isHidden() {
  return document.visibilityState === 'hidden';
}

/* ── top bar ──────────────────────────────────────────────────────────── */

function renderMeta() {
  const meta = state.meta;
  if (!meta) return;
  const cf = $('#pill-cf');
  cf.textContent = meta.cloudflared ? `cloudflared ${meta.cloudflared}` : 'cloudflared 缺失';
  cf.className = 'pill ' + (meta.binaryExists ? 'ok' : 'err');
  cf.title = meta.binaryExists ? `程序路径：${meta.binary}` : `未找到可执行文件：${meta.binary}`;

  const acc = $('#pill-account');
  acc.textContent = meta.loggedIn ? '账户已登录' : '账户未登录';
  acc.className = 'pill ' + (meta.loggedIn ? 'ok' : '');

  $('#bin-version').textContent = meta.cloudflared || '未知';
  $('#bin-path').textContent = meta.binary || '—';
  $('#brand-sub').textContent = `飞牛 fnOS 内网穿透 · Node ${meta.node} · ${meta.arch}`;
}

/* ── tunnels view ─────────────────────────────────────────────────────── */

function tunnelSummary(t) {
  if (t.type === 'token') return t.hasToken ? `Token ${esc(t.tokenPreview)}` : '未配置 Token';
  if (t.type === 'quick') return `本地服务 ${esc(t.target || '未配置')}`;
  if (t.type === 'local') {
    const rules = (t.ingress || []).filter((r) => r.hostname).length;
    return `隧道 ${esc(t.tunnelName || t.tunnelId || '未选择')} · ${rules} 条入站规则`;
  }
  return `配置文件 ${esc(t.configFile || '未配置')}`;
}

// 只有本地管理隧道才有 DNS 路由可言（需要 CNAME 到 <UUID>.cfargotunnel.com）。
// 没有状态时返回空串，卡片上就不显示这一行。
function dnsRowHtml(t) {
  if (t.type !== 'local') return '';
  const enabled = t.autoDns !== false;
  const status = t.dnsStatus || '';
  let value = enabled ? '已开启（未检查）' : '已关闭';
  if (status === 'checking') value = '检查中…';
  else if (status === 'ok') value = '正常';
  else if (status === 'error') value = '异常';
  else if (status === 'skipped') value = '已跳过';
  const msg = t.dnsMessage ? `<span class="hint">${esc(t.dnsMessage)}</span>` : '';
  return `
      <div><span class="label">DNS 路由</span><span class="value">${esc(value)}${msg}</span></div>`;
}

/* One card's markup. Log text is intentionally absent -- see the file header. */
function tunnelCardHtml(t) {
  const status = t.status || 'stopped';
  const busyKey = `tunnel:${t.id}`;
  const busy = isBusy(busyKey);
  const canStart = status === 'stopped' || status === 'error';
  const canStop = status === 'running' || status === 'starting' || status === 'stopping';
  const logOpen = !!state.openLogs[t.id];
  return `
<article class="card tunnel-card is-${esc(status)}" data-id="${esc(t.id)}">
  <div class="card-head">
    <div class="tunnel-title">
      <h3>${esc(t.name)}</h3>
      <span class="badge">${esc(TYPE_LABEL[t.type] || t.type)}</span>
      <span class="status ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>
      ${t.pid ? `<span class="badge mono">PID ${esc(t.pid)}</span>` : ''}
    </div>
    <div class="card-actions">
      ${canStart ? `<button class="btn btn-sm" data-act="start" ${busy ? 'disabled' : ''}>启动</button>` : ''}
      ${canStop ? `<button class="btn btn-sm" data-act="stop" ${busy ? 'disabled' : ''}>停止</button>` : ''}
      <button class="btn btn-sm" data-act="restart" ${busy ? 'disabled' : ''}>重启</button>
      <button class="btn btn-sm" data-act="logs" aria-expanded="${logOpen}">${logOpen ? '收起日志' : '查看日志'}</button>
      <button class="btn btn-sm" data-act="edit">编辑</button>
      ${t.type === 'local' ? `<button class="btn btn-sm" data-act="dns" ${busy ? 'disabled' : ''}>修复 DNS 路由</button>` : ''}
      <button class="btn btn-sm btn-danger" data-act="delete" ${busy ? 'disabled' : ''}>删除</button>
    </div>
  </div>
  <div class="card-body">
    ${t.error ? `<div class="alert err"><span class="alert-body">${esc(t.error)}</span></div>` : ''}
    ${t.url ? `<div class="alert ok"><span class="alert-body">公网地址：<a class="link" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a></span></div>` : ''}
    <div class="meta-grid">
      <div><span class="label">类型</span><span class="value">${esc(TYPE_LABEL[t.type] || t.type)}</span></div>
      <div><span class="label">配置</span><span class="value">${tunnelSummary(t)}</span></div>
      <div><span class="label">开机自启</span><span class="value">${t.autoStart ? '是' : '否'}</span></div>
      <div><span class="label">启动于</span><span class="value">${t.startedAt ? esc(relTime(t.startedAt)) : '—'}</span></div>
      <div><span class="label">上次退出</span><span class="value">${t.lastExitAt ? `${esc(relTime(t.lastExitAt))}（退出码 ${esc(t.lastExitCode)}）` : '—'}</span></div>
      ${t.attempts ? `<div><span class="label">重试次数</span><span class="value">${esc(t.attempts)}</span></div>` : ''}
      ${t.note ? `<div><span class="label">备注</span><span class="value">${esc(t.note)}</span></div>` : ''}
      ${dnsRowHtml(t)}
    </div>
    ${logOpen ? '<pre class="logbox tunnel-log" tabindex="0">暂无日志</pre>' : ''}
  </div>
</article>`;
}

function matchesFilter(t) {
  const f = state.filter;
  if (!f || f === 'all') return true;
  return (t.status || 'stopped') === f;
}

const FILTER_DEFS = [
  { key: 'running', label: '运行中', dot: 'running' },
  { key: 'starting', label: '启动中', dot: 'starting' },
  { key: 'stopping', label: '停止中', dot: 'stopping' },
  { key: 'error', label: '异常', dot: 'error' },
  { key: 'stopped', label: '已停止', dot: 'stopped' },
];

function renderSummary(tunnels) {
  const box = $('#tunnel-summary');
  if (!tunnels.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const counts = {};
  for (const t of tunnels) {
    const s = t.status || 'stopped';
    counts[s] = (counts[s] || 0) + 1;
  }
  /* A filter whose last member just left would hide the whole list with no way
     back, so fall back to "all" as soon as its category empties. */
  if (state.filter !== 'all' && !counts[state.filter]) state.filter = 'all';

  const chips = [
    `<button class="summary-chip ${state.filter === 'all' ? 'is-active' : ''}" data-filter="all" aria-pressed="${state.filter === 'all'}">全部<span class="count">${tunnels.length}</span></button>`,
  ];
  for (const def of FILTER_DEFS) {
    const n = counts[def.key] || 0;
    if (!n) continue;
    const active = state.filter === def.key;
    chips.push(
      `<button class="summary-chip ${active ? 'is-active' : ''}" data-filter="${def.key}" aria-pressed="${active}">` +
        `<span class="dot ${def.dot}"></span>${def.label}<span class="count">${n}</span></button>`,
    );
  }
  const html = chips.join('');
  if (box.innerHTML !== html) box.innerHTML = html;
  box.classList.remove('hidden');
}

/* Remembers the last list markup so an unchanged poll skips the DOM entirely. */
let lastListHtml = null;

function renderTunnels() {
  const list = $('#tunnel-list');
  const empty = $('#tunnel-empty');
  const all = state.tunnels || [];
  renderSummary(all);

  if (!all.length) {
    if (lastListHtml !== '') {
      list.innerHTML = '';
      lastListHtml = '';
    }
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');

  const shown = all.filter(matchesFilter);
  const html = shown.length
    ? shown.map(tunnelCardHtml).join('')
    : '<div class="empty"><h3>没有符合条件的隧道</h3><p>换一个状态筛选，或点击「全部」。</p></div>';

  if (html !== lastListHtml) {
    const savedScroll = captureLogScroll();
    list.innerHTML = html;
    lastListHtml = html;
    /* The rebuild replaced every log box, so refill them and put the scroll
     * positions back in the same pass. */
    applyLogBoxes(shown, savedScroll);
    return;
  }

  /* Unchanged markup: the boxes survived, so only their text needs refreshing. */
  applyLogBoxes(shown, null);
}

/* One pass over the rendered cards, handing each caller the log box that
 * belongs to a tunnel id. Everything that touches log boxes goes through this:
 * looking each box up separately would rescan the whole list once per tunnel. */
function eachCardBox(fn) {
  const list = $('#tunnel-list');
  if (!list || !list.querySelectorAll) return;
  for (const card of list.querySelectorAll('.tunnel-card')) {
    const id = card.dataset && card.dataset.id;
    if (!id) continue;
    fn(id, card.querySelector('.logbox'));
  }
}

function logBoxFor(id) {
  let found = null;
  eachCardBox((cardId, box) => {
    if (cardId === id && box) found = box;
  });
  return found;
}

/* Update a log box in place. Follows the tail only when the reader was already
   at the bottom, so scrolling up to inspect an error is not undone by the next
   poll. */
function updateLogBox(box, lines) {
  const text = lines.length ? lines.join('\n') : '暂无日志';
  if (box.textContent === text) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = text;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* Refresh every open log box after the list markup was (re)built, restoring the
 * scroll position captured before the rebuild in the same pass. */
function applyLogBoxes(shown, savedScroll) {
  const wanted = new Map();
  for (const t of shown) {
    if (state.openLogs[t.id]) wanted.set(t.id, state.logs[t.id] || []);
  }
  if (!wanted.size && !savedScroll) return;
  eachCardBox((id, box) => {
    if (!box) return;
    if (savedScroll && savedScroll[id] !== undefined) box.scrollTop = savedScroll[id];
    if (wanted.has(id)) updateLogBox(box, wanted.get(id));
  });
}

async function refreshTunnels() {
  const data = await api('GET', '/tunnels');
  state.tunnels = data.tunnels || [];
  renderTunnels();
}

async function loadTunnelLog(id) {
  const data = await api('GET', `/tunnels/${encodeURIComponent(id)}/logs?lines=300`);
  state.logs[id] = data.lines || [];
}

async function tunnelAction(id, act) {
  const tunnel = state.tunnels.find((t) => t.id === id);
  if (!tunnel) return;
  const key = `tunnel:${id}`;

  if (act === 'delete') {
    if (!confirm(`确定删除隧道「${tunnel.name}」吗？此操作只移除本地配置，不会删除 Cloudflare 上的隧道。`)) return;
    setBusy(key, true);
    try {
      await api('DELETE', `/tunnels/${encodeURIComponent(id)}`);
      delete state.openLogs[id];
      delete state.logs[id];
      toast('已删除');
      await refreshTunnels();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(key, false);
    }
    return;
  }

  if (act === 'logs') {
    state.openLogs[id] = !state.openLogs[id];
    if (state.openLogs[id]) {
      try {
        await loadTunnelLog(id);
      } catch (err) {
        toast(err.message, 'err');
      }
    }
    renderTunnels();
    /* A freshly opened box should show the newest lines, not the oldest. */
    const box = logBoxFor(id);
    if (box) box.scrollTop = box.scrollHeight;
    return;
  }

  if (act === 'edit') {
    openTunnelModal(tunnel);
    return;
  }

  setBusy(key, true);
  renderTunnels();
  try {
    const data = await api('POST', `/tunnels/${encodeURIComponent(id)}/${act}`);
    if (act === 'dns') toast(data.message || 'DNS 路由已检查');
    else if (act === 'start') toast('已发送启动指令');
    else if (act === 'stop') toast('已发送停止指令');
    else toast('正在重启');
    await new Promise((r) => setTimeout(r, 900));
    await refreshTunnels();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setBusy(key, false);
    renderTunnels();
  }
}

$('#tunnel-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.tunnel-card');
  if (!card) return;
  tunnelAction(card.dataset.id, btn.dataset.act);
});

$('#tunnel-summary').addEventListener('click', (ev) => {
  const chip = ev.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  renderTunnels();
});

/* ── tunnel modal ─────────────────────────────────────────────────────── */

function splitService(service) {
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?/i.exec(String(service || ''));
  if (!m) return { protocol: 'http', host: '', port: '' };
  return { protocol: m[1].toLowerCase(), host: m[2], port: m[3] || '' };
}

function ingressRowHtml(rule) {
  const r = rule || { hostname: '', service: '', noTLSVerify: false, path: '' };
  const svc = splitService(r.service);
  return `
<div class="rule" data-rule>
  <label class="field">
    <span>公网域名</span>
    <input type="text" data-k="hostname" value="${esc(r.hostname)}" placeholder="nas.example.com">
  </label>
  <label class="field">
    <span>本地服务</span>
    <span class="service-row">
      <select data-k="protocol" aria-label="协议">
        <option value="http" ${svc.protocol === 'http' ? 'selected' : ''}>http://</option>
        <option value="https" ${svc.protocol === 'https' ? 'selected' : ''}>https://</option>
      </select>
      <input type="text" data-k="host" value="${esc(svc.host)}" placeholder="127.0.0.1" aria-label="地址">
      <input type="text" data-k="port" value="${esc(svc.port)}" placeholder="80" inputmode="numeric" aria-label="端口">
    </span>
  </label>
  <label class="field switch">
    <input type="checkbox" data-k="noTLSVerify" ${r.noTLSVerify ? 'checked' : ''}>
    <span>跳过 TLS 校验</span>
  </label>
  <button class="btn btn-sm btn-danger" data-remove-rule type="button" aria-label="移除这条入站规则">移除</button>
</div>`;
}

function tunnelFormHtml(t) {
  const tunnel = t || { type: 'token', name: '', autoStart: true, ingress: [], catchAll: 'http_status:404' };
  const accountOptions = state.accountTunnels
    .map((at) => `<option value="${esc(at.name)}" data-id="${esc(at.id || '')}" ${at.name === tunnel.tunnelName ? 'selected' : ''}>${esc(at.name)}</option>`)
    .join('');

  return `
<div class="form-grid">
  <div class="form-section">
    <p class="section-title">基本信息</p>
    <div class="form-row">
      <label class="field">
        <span>名称</span>
        <input type="text" id="f-name" value="${esc(tunnel.name)}" placeholder="例如 我的 NAS">
        <small class="field-help">只是给你自己看的标识。</small>
      </label>
      <label class="field">
        <span>隧道类型</span>
        <select id="f-type">
          <option value="token" ${tunnel.type === 'token' ? 'selected' : ''}>Token 隧道（Cloudflare 控制台管理）</option>
          <option value="quick" ${tunnel.type === 'quick' ? 'selected' : ''}>快速隧道（TryCloudflare 临时域名）</option>
          <option value="local" ${tunnel.type === 'local' ? 'selected' : ''}>本地管理隧道（需登录账户）</option>
          <option value="config" ${tunnel.type === 'config' ? 'selected' : ''}>自定义配置文件</option>
        </select>
        <small class="field-help" id="f-type-help">${esc(TYPE_HELP[tunnel.type] || '')}</small>
      </label>
    </div>
  </div>

  <div class="form-section" data-type-block="token">
    <p class="section-title">Token</p>
    <label class="field">
      <span>隧道 Token ${tunnel.hasToken ? `（已保存：${esc(tunnel.tokenPreview)}，留空表示不修改）` : ''}</span>
      <textarea id="f-token" placeholder="eyJhIjoi... （在 Cloudflare Zero Trust → Networks → Tunnels 中复制）"></textarea>
      <small class="field-help">Token 只保存在飞牛本机（$TRIM_PKGVAR/config.json，权限 0600），不会回传到浏览器。</small>
    </label>
  </div>

  <div class="form-section" data-type-block="quick">
    <p class="section-title">本地服务</p>
    <label class="field">
      <span>转发到</span>
      <span class="service-row" id="f-target-row">
        <select data-target-k="protocol" aria-label="协议">
          <option value="http" ${splitService(tunnel.target).protocol === 'http' ? 'selected' : ''}>http://</option>
          <option value="https" ${splitService(tunnel.target).protocol === 'https' ? 'selected' : ''}>https://</option>
        </select>
        <input type="text" data-target-k="host" value="${esc(splitService(tunnel.target).host)}" placeholder="127.0.0.1" aria-label="地址">
        <input type="text" data-target-k="port" value="${esc(splitService(tunnel.target).port)}" placeholder="80" inputmode="numeric" aria-label="端口">
      </span>
      <small class="field-help">端口留空时按协议自动补 80 / 443。</small>
    </label>
    <label class="field">
      <span>自定义主机名（可选，需账户）</span>
      <input type="text" id="f-quick-hostname" value="${esc(tunnel.quickHostname)}" placeholder="留空则使用随机 trycloudflare.com 域名">
    </label>
  </div>

  <div class="form-section" data-type-block="local">
    <p class="section-title">隧道</p>
    <div class="form-row">
      <label class="field">
        <span>选择已创建的隧道</span>
        <select id="f-tunnel-name">
          <option value="">— 请先在「账户」页创建 —</option>
          ${accountOptions}
        </select>
      </label>
      <label class="field">
        <span>或手动填写隧道名称 / ID</span>
        <input type="text" id="f-tunnel-name-manual" value="${esc(tunnel.tunnelName)}" placeholder="my-nas">
      </label>
    </div>

    <p class="section-title">入站规则（ingress）</p>
    <div class="rule-list" id="rule-list">${(tunnel.ingress || []).map(ingressRowHtml).join('')}</div>
    <div>
      <button class="btn btn-sm" id="btn-add-rule" type="button">+ 添加规则</button>
    </div>

    <div class="form-row">
      <label class="field">
        <span>兜底规则</span>
        <input type="text" id="f-catchall" value="${esc(tunnel.catchAll || 'http_status:404')}">
        <small class="field-help">没有匹配到上面任何域名时返回的内容。</small>
      </label>
    </div>

    <label class="field switch">
      <input type="checkbox" id="f-autodns" ${tunnel.autoDns !== false ? 'checked' : ''}>
      <span>
        启动时自动配置 DNS 路由（CNAME 指向隧道）
        <small class="field-help">开启后每次启动都会检查域名是否已 CNAME 到本隧道，不对就自动执行
          cloudflared tunnel route dns。少了这一步域名会返回 Cloudflare 边缘错误 1033，
          而隧道本身仍显示「运行中」，很难自查。</small>
      </span>
    </label>
  </div>

  <div class="form-section" data-type-block="config">
    <p class="section-title">配置文件</p>
    <label class="field">
      <span>config.yml 绝对路径</span>
      <input type="text" id="f-configfile" value="${esc(tunnel.configFile)}" placeholder="/vol1/@appdata/cloudflared/my-config.yml">
    </label>
  </div>

  <div class="form-section">
    <p class="section-title">其它</p>
    <div class="form-row">
      <label class="field switch">
        <input type="checkbox" id="f-autostart" ${tunnel.autoStart !== false ? 'checked' : ''}>
        <span>应用启动时自动启动此隧道</span>
      </label>
      <label class="field">
        <span>备注（可选）</span>
        <input type="text" id="f-note" value="${esc(tunnel.note)}" placeholder="">
      </label>
    </div>
    <label class="field">
      <span>附加参数（仅此隧道生效，高级）</span>
      <input type="text" id="f-extra" value="${esc(tunnel.extraArgs)}" placeholder="例如 --retries 5">
    </label>
  </div>
</div>`;
}

function syncTypeBlocks() {
  const type = $('#f-type').value;
  document.querySelectorAll('[data-type-block]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.typeBlock !== type);
  });
  const help = $('#f-type-help');
  if (help) help.textContent = TYPE_HELP[type] || '';
}

/* Focus is returned to whatever opened the modal, so keyboard users are not
   dropped back at the top of the page after saving. */
let lastFocused = null;

function openTunnelModal(tunnel, prefill) {
  state.editing = tunnel || null;
  const form = tunnel || prefill || null;
  lastFocused = document.activeElement || null;
  $('#modal-title').textContent = tunnel ? '编辑隧道' : '新建隧道';
  $('#modal-body').innerHTML = tunnelFormHtml(form);
  $('#modal-backdrop').classList.remove('hidden');

  $('#f-type').addEventListener('change', syncTypeBlocks);
  syncTypeBlocks();

  const addRule = $('#btn-add-rule');
  if (addRule) {
    addRule.addEventListener('click', () => {
      const list = $('#rule-list');
      if (list) list.insertAdjacentHTML('beforeend', ingressRowHtml(null));
    });
  }
  const ruleList = $('#rule-list');
  if (ruleList) {
    ruleList.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-remove-rule]');
      if (btn) btn.closest('[data-rule]').remove();
    });
  }
  $('#f-name').focus();
}

function closeTunnelModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  state.editing = null;
  pendingModalSave = null;
  const restore = lastFocused;
  lastFocused = null;
  if (restore && typeof restore.focus === 'function') {
    try {
      restore.focus();
    } catch (err) {
      /* the element may be gone after a re-render */
    }
  }
}

/* 应用内输入弹窗：复用隧道弹窗的外壳。
   面板跑在 fnOS 的 iframe 里，浏览器原生 prompt 常被拦截（要么不弹、
   要么看不见输入框），所以凡是需要用户输入的场景都走这个。 */
let pendingModalSave = null;

function openPromptModal(opts) {
  const o = opts || {};
  pendingModalSave = o.onSave || null;
  lastFocused = document.activeElement || null;
  $('#modal-title').textContent = o.title || '请输入';
  $('#modal-body').innerHTML = `
    <label class="field">
      <span>${esc(o.label || '')}</span>
      <input type="text" id="modal-prompt-input" value="${esc(o.value || '')}"
             placeholder="${esc(o.placeholder || '')}" autocomplete="off">
    </label>
    ${o.hint ? `<p class="hint">${esc(o.hint)}</p>` : ''}`;
  $('#modal-backdrop').classList.remove('hidden');
  const input = $('#modal-prompt-input');
  if (input) {
    input.focus();
    input.select();
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        $('#modal-save').click();
      }
    });
  }
}

function readPromptValue() {
  const input = $('#modal-prompt-input');
  return input ? input.value : '';
}

function collectTunnelForm() {
  const type = $('#f-type').value;
  const payload = {
    name: $('#f-name').value.trim(),
    type,
    autoStart: $('#f-autostart').checked,
    note: $('#f-note').value.trim(),
    extraArgs: $('#f-extra').value.trim(),
  };
  if (type === 'token') {
    const token = $('#f-token').value.trim();
    if (token) payload.token = token;
  } else if (type === 'quick') {
    const tp = (document.querySelector('#f-target-row [data-target-k="protocol"]') || {}).value || 'http';
    const th = ((document.querySelector('#f-target-row [data-target-k="host"]') || {}).value || '').trim();
    const tport = ((document.querySelector('#f-target-row [data-target-k="port"]') || {}).value || '').trim();
    payload.target = th ? `${tp}://${th}:${tport || (tp === 'https' ? '443' : '80')}` : '';
    payload.quickHostname = $('#f-quick-hostname').value.trim();
  } else if (type === 'local') {
    const manual = $('#f-tunnel-name-manual').value.trim();
    const sel = $('#f-tunnel-name');
    const picked = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
    const pickedName = picked ? picked.value : '';
    const pickedId = picked ? picked.dataset.id || '' : '';
    // 手动输入优先；若手动输入与下拉所选同名，则沿用下拉项携带的隧道 ID，
    // 这样 cloudflared 能用 <ID>.json 精确定位凭据文件，避免多隧道时选错。
    const sameAsPick = !!manual && manual === pickedName;
    payload.tunnelName = manual || pickedName;
    payload.tunnelId = !manual || sameAsPick ? pickedId : '';
    const autoDnsBox = $('#f-autodns');
    payload.autoDns = autoDnsBox ? autoDnsBox.checked : true;
    payload.catchAll = $('#f-catchall').value.trim() || 'http_status:404';
    payload.ingress = Array.from(document.querySelectorAll('#rule-list [data-rule]')).map((row) => {
      const protocol = (row.querySelector('[data-k="protocol"]') || {}).value || 'http';
      const host = ((row.querySelector('[data-k="host"]') || {}).value || '').trim();
      const port = ((row.querySelector('[data-k="port"]') || {}).value || '').trim();
      // 端口留空时按协议补默认值，避免手填还要记 80/443。
      const service = host ? `${protocol}://${host}:${port || (protocol === 'https' ? '443' : '80')}` : '';
      return {
        hostname: ((row.querySelector('[data-k="hostname"]') || {}).value || '').trim(),
        service,
        noTLSVerify: !!(row.querySelector('[data-k="noTLSVerify"]') || {}).checked,
      };
    }).filter((r) => r.hostname || r.service);
  } else if (type === 'config') {
    payload.configFile = $('#f-configfile').value.trim();
  }
  return payload;
}

async function saveTunnelModal() {
  const payload = collectTunnelForm();
  if (!payload.name) return toast('请填写名称', 'err');
  if (payload.type === 'token' && !payload.token && !(state.editing && state.editing.hasToken)) {
    return toast('请填写隧道 Token', 'err');
  }
  const btn = $('#modal-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    if (state.editing) {
      await api('PUT', `/tunnels/${encodeURIComponent(state.editing.id)}`, payload);
      toast('已保存');
    } else {
      await api('POST', '/tunnels', payload);
      toast('已创建');
    }
    closeTunnelModal();
    await refreshTunnels();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

$('#modal-save').addEventListener('click', () => {
  if (typeof pendingModalSave === 'function') {
    const fn = pendingModalSave;
    pendingModalSave = null;
    fn(readPromptValue());
    return;
  }
  saveTunnelModal();
});
$('#modal-cancel').addEventListener('click', closeTunnelModal);
$('#modal-close').addEventListener('click', closeTunnelModal);
$('#modal-backdrop').addEventListener('click', (ev) => {
  if (ev.target === $('#modal-backdrop')) closeTunnelModal();
});

/* Keep Tab inside the dialog while it is open: without this, tabbing walks into
   the page behind the backdrop, which is invisible and unreachable by mouse. */
$('#modal-backdrop').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Tab') return;
  const focusables = document.querySelectorAll(
    '#modal-backdrop button, #modal-backdrop input, #modal-backdrop select, #modal-backdrop textarea, #modal-backdrop a[href]',
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
});

/* ── account view ─────────────────────────────────────────────────────── */

function renderAccount() {
  const body = $('#account-body');
  const card = $('#account-tunnels-card');
  const acc = state.account;

  if (!acc) {
    body.innerHTML = '<p class="hint"><span class="spin"></span> 正在读取账户状态…</p>';
    return;
  }

  if (!acc.loggedIn) {
    card.classList.add('hidden');
    const waiting = acc.status === 'waiting' && acc.url;
    body.innerHTML = `
      <div class="alert info"><span class="alert-body">本地管理隧道需要先在 Cloudflare 账户上授权。授权文件保存在 ${esc(acc.certPath)}。</span></div>
      ${waiting
        ? `<p>请复制下面的链接到浏览器完成授权（选择一个域名）：</p>
           <p style="margin:10px 0"><a class="link" href="${esc(acc.url)}" target="_blank" rel="noreferrer">${esc(acc.url)}</a></p>
           <p class="hint"><span class="spin"></span> 等待授权完成… 授权成功后本页会自动刷新。</p>`
        : `<button class="btn btn-primary" id="btn-login">登录 Cloudflare</button>`}
      ${acc.error ? `<div class="alert err" style="margin-top:12px"><span class="alert-body">${esc(acc.error)}</span></div>` : ''}`;

    const loginBtn = $('#btn-login');
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        try {
          await api('POST', '/account/login');
          toast('已生成授权链接');
          await pollAccount();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    }
    return;
  }

  card.classList.remove('hidden');
  body.innerHTML = `
    <div class="alert ok"><span class="alert-body">已登录，授权文件：${esc(acc.certPath)}</span></div>
    <button class="btn btn-danger" id="btn-logout">退出登录（删除 cert.pem）</button>`;
  const logoutBtn = $('#btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!confirm('退出登录会删除本机的 cert.pem，已运行的隧道不受影响。确定继续？')) return;
      try {
        await api('POST', '/account/logout');
        toast('已退出登录');
        state.accountTunnels = [];
        await pollAccount();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  renderAccountTunnels();
}

function renderAccountTunnels() {
  const list = $('#account-tunnel-list');
  const q = state.accountQuery.trim().toLowerCase();
  const all = state.accountTunnels;
  const tunnels = q ? all.filter((t) => String(t.name || '').toLowerCase().includes(q)) : all;

  if (!all.length) {
    list.innerHTML = '<p class="hint">还没有命名隧道，点击右上角「+ 新建隧道」创建一个。</p>';
    return;
  }
  if (!tunnels.length) {
    list.innerHTML = `<p class="hint">没有匹配「${esc(state.accountQuery)}」的隧道。</p>`;
    return;
  }
  list.innerHTML = tunnels
    .map((t) => `
<div class="row">
  <div class="row-main">
    <strong>${esc(t.name)}</strong>
    <span>${esc(t.id)} · ${t.connections} 个活动连接${t.createdAt ? ` · 创建于 ${esc(String(t.createdAt).slice(0, 10))}` : ''}</span>
  </div>
  <div class="row-actions">
    <button class="btn btn-sm" data-account-act="use" data-name="${esc(t.name)}">配置隧道</button>
    <button class="btn btn-sm btn-danger" data-account-act="delete" data-name="${esc(t.name)}">删除</button>
  </div>
</div>`)
    .join('');
}

$('#account-tunnel-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-account-act]');
  if (!btn) return;
  const name = btn.dataset.name;
  const act = btn.dataset.accountAct;

  if (act === 'delete') {
    if (!confirm(`确定删除 Cloudflare 上的隧道「${name}」吗？该操作不可恢复。`)) return;
    try {
      await api('DELETE', `/account/tunnels/${encodeURIComponent(name)}`);
      toast('已删除');
      await refreshAccountTunnels();
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  if (act === 'use') {
    // 该云端隧道若已有本地配置，直接进入编辑；否则新建并预填。
    // 注意：必须把预填对象作为第二个参数传入，否则 openTunnelModal 会把它
    // 当成「正在编辑的隧道」（没有 id），保存时会 PUT /tunnels/undefined。
    const existing = (state.tunnels || []).find((t) => t.type === 'local' && t.tunnelName === name);
    if (existing) {
      openTunnelModal(existing);
      return;
    }
    openTunnelModal(null, {
      type: 'local',
      name,
      tunnelName: name,
      autoStart: true,
      ingress: [{ hostname: '', service: '', noTLSVerify: false }],
      catchAll: 'http_status:404',
    });
  }
});

const accountSearch = $('#account-search');
if (accountSearch) {
  accountSearch.addEventListener('input', () => {
    state.accountQuery = accountSearch.value;
    renderAccountTunnels();
  });
}

async function refreshAccountTunnels() {
  try {
    const data = await api('GET', '/account/tunnels');
    state.accountTunnels = data.tunnels || [];
  } catch (err) {
    state.accountTunnels = [];
  }
  renderAccountTunnels();
}

async function pollAccount() {
  try {
    state.account = await api('GET', '/account');
  } catch (err) {
    state.account = { loggedIn: false, status: 'error', error: err.message, certPath: '' };
  }
  renderAccount();
  if (state.account.loggedIn && !state.accountTunnels.length) await refreshAccountTunnels();
  return state.account;
}

$('#btn-account-refresh').addEventListener('click', async () => {
  await pollAccount();
  if (state.account && state.account.loggedIn) await refreshAccountTunnels();
  toast('已刷新');
});

// 点按钮才弹窗问名字：常驻输入框占地方，而创建隧道是低频操作。
$('#btn-create-tunnel').addEventListener('click', () => {
  openPromptModal({
    title: '新建隧道',
    label: '隧道名称',
    placeholder: 'nas',
    hint: '只能用字母、数字、点、下划线、短横线。创建后会显示在上方列表里。',
    onSave: async (raw) => {
      const name = (raw || '').trim();
      if (!name) {
        toast('请填写隧道名称', 'err');
        return;
      }
      const btn = $('#btn-create-tunnel');
      btn.disabled = true;
      btn.textContent = '创建中…';
      try {
        await api('POST', '/account/tunnels', { name });
        closeTunnelModal();
        toast('隧道已创建');
        await refreshAccountTunnels();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '+ 新建隧道';
      }
    },
  });
});

/* ── settings view ────────────────────────────────────────────────────── */

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#set-protocol').value = s.protocol || 'auto';
  $('#set-edge').value = s.edgeIpVersion || '';
  $('#set-loglevel').value = s.logLevel || 'info';
  $('#set-metrics').value = s.metricsPort || 0;
  $('#set-region').value = s.region || '';
  $('#set-extra').value = s.extraArgs || '';
  $('#set-autostart').checked = s.autoStart !== false;
  $('#set-autorestart').checked = s.autoRestart !== false;
}

$('#btn-save-settings').addEventListener('click', async () => {
  const payload = {
    protocol: $('#set-protocol').value,
    edgeIpVersion: $('#set-edge').value,
    logLevel: $('#set-loglevel').value,
    metricsPort: parseInt($('#set-metrics').value, 10) || 0,
    region: $('#set-region').value.trim(),
    extraArgs: $('#set-extra').value.trim(),
    autoStart: $('#set-autostart').checked,
    autoRestart: $('#set-autorestart').checked,
  };
  try {
    const data = await api('PUT', '/settings', payload);
    state.settings = data.settings;
    toast('设置已保存');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-update-bin').addEventListener('click', async () => {
  const btn = $('#btn-update-bin');
  if (!confirm('将从 GitHub 下载最新的 cloudflared 并替换当前程序，确定继续？')) return;
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const data = await api('POST', '/binary/update');
    toast(`已更新到 ${data.version}`);
    await refreshMeta();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '检查并更新到最新版';
  }
});

/* ── app log view ─────────────────────────────────────────────────────── */

let lastAppLogText = null;

async function refreshAppLog() {
  const box = $('#app-log');
  try {
    const data = await api('GET', '/logs');
    const lines = data.lines || [];
    const text = lines.length ? lines.join('\n') : '暂无日志';
    if (text !== lastAppLogText) {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.textContent = text;
      lastAppLogText = text;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    const meta = $('#applog-meta');
    if (meta) meta.textContent = `共 ${lines.length} 行 · 更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  } catch (err) {
    box.textContent = `读取失败：${err.message}`;
    lastAppLogText = null;
  }
}

$('#btn-refresh-applog').addEventListener('click', refreshAppLog);

$('#btn-copy-applog').addEventListener('click', async () => {
  const text = $('#app-log').textContent || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('日志已复制');
  } catch (err) {
    toast('复制失败，请手动选中日志内容', 'err');
  }
});

/* ── bootstrap ────────────────────────────────────────────────────────── */

async function refreshMeta() {
  state.meta = await api('GET', '/meta');
  renderMeta();
}

const VIEW_LOADERS = {
  tunnels: refreshTunnels,
  account: async () => {
    await pollAccount();
    if (state.account && state.account.loggedIn) await refreshAccountTunnels();
  },
  settings: async () => {
    state.settings = await api('GET', '/settings');
    renderSettings();
  },
  logs: refreshAppLog,
};

function switchView(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('is-active', view.id === `view-${name}`));
  const loader = VIEW_LOADERS[name];
  if (loader) loader().catch((err) => toast(err.message, 'err'));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

function openNewTunnelModal() {
  if (state.account && state.account.loggedIn && !state.accountTunnels.length) {
    refreshAccountTunnels().then(() => openTunnelModal(null));
    return;
  }
  openTunnelModal(null);
}

$('#btn-add').addEventListener('click', openNewTunnelModal);
$('#btn-add-empty').addEventListener('click', openNewTunnelModal);

document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.goto));
});

$('#btn-refresh').addEventListener('click', async () => {
  try {
    await refreshTunnels();
    toast('已刷新');
  } catch (err) {
    toast(err.message, 'err');
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeTunnelModal();
});

/* Polling rebuilds the card DOM when something changed, which would drop an open
 * log box back to the top. Capture the scroll offsets first so the rebuild can
 * put them back. */
function captureLogScroll() {
  const saved = {};
  eachCardBox((id, box) => {
    if (box) saved[id] = box.scrollTop;
  });
  return saved;
}

let polling = false;

/* Live status refresh while the tunnel list is visible.
 *
 * renderTunnels() already skips the DOM when nothing changed, so the remaining
 * cost is the request itself. The guards below keep a backgrounded tab from
 * polling a NAS for nothing, and stop a refresh from fighting the user while a
 * modal is open. */
setInterval(async () => {
  if (polling) return;
  if (isHidden()) return;
  if (!$('#view-tunnels').classList.contains('is-active')) return;
  if (!$('#modal-backdrop').classList.contains('hidden')) return;
  polling = true;
  try {
    await refreshTunnels();
    for (const id of Object.keys(state.openLogs)) {
      if (state.openLogs[id]) await loadTunnelLog(id);
    }
    renderTunnels();
  } catch (err) {
    /* transient errors are ignored during polling */
  } finally {
    polling = false;
  }
}, 3000);

/* Account polling while the account tab is visible and login is pending. */
setInterval(async () => {
  if (isHidden()) return;
  if (!$('#view-account').classList.contains('is-active')) return;
  if (state.account && state.account.loggedIn) return;
  if (!state.account || state.account.status !== 'waiting') return;
  const acc = await pollAccount();
  if (acc.loggedIn) toast('登录成功');
}, 3000);

/* Coming back to a backgrounded tab should show current data immediately rather
   than waiting out the next tick. */
document.addEventListener('visibilitychange', () => {
  if (isHidden()) return;
  if ($('#view-tunnels').classList.contains('is-active')) {
    refreshTunnels().catch(() => {});
  }
  if ($('#view-logs').classList.contains('is-active')) {
    refreshAppLog().catch(() => {});
  }
});

(async function boot() {
  try {
    await refreshMeta();
  } catch (err) {
    toast(`无法连接后端：${err.message}`, 'err');
  }
  await switchView('tunnels');
})();
