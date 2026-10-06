'use strict';
/*
 * Persistent state: config.json (settings + tunnel definitions), the atomic
 * writer it is saved with, and the validation of incoming tunnel payloads.
 */
const fs = require('fs');
const crypto = require('crypto');
const { CONFIG_FILE } = require('./paths');
const { atomicWrite } = require('./atomic');
const { logWarn } = require('./log');
const { DNS_HOSTNAME_RE } = require('./dns');

function newId() {
  return 't_' + crypto.randomBytes(6).toString('hex');
}


function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 12) return '••••••••';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/* ------------------------------------------------------------------ config */

const DEFAULT_SETTINGS = {
  protocol: 'auto', // auto | http2 | quic
  edgeIpVersion: '', // '' | 4 | 6
  region: '',
  logLevel: 'info', // debug | info | warn | error
  metricsPort: 0,
  extraArgs: '',
  autoStart: true,
  autoRestart: true,
};

function defaultConfig() {
  return { version: 1, settings: Object.assign({}, DEFAULT_SETTINGS), tunnels: [] };
}

let config = defaultConfig();

/* Whether THIS process changed settings since the last load/save. The merge in
 * saveConfig() uses it to tell "I changed this" from "another process did". */
let settingsDirty = false;

/* A tunnel id is used to build filesystem paths (TUNNELS_DIR/<id>/config.yml,
 * LOGS_DIR/<id>.log), so an id carrying a path separator or ".." would let a
 * hand-edited or corrupted config.json write outside those directories. The API
 * always overwrites the id, so this only guards the persisted state -- but the
 * cost is one regex and the failure mode is a path escape, so validate it here
 * rather than trusting whatever is on disk. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function safeId(value) {
  const s = typeof value === 'string' ? value : '';
  return SAFE_ID_RE.test(s) ? s : newId();
}

function normalizeTunnel(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const type = ['token', 'quick', 'local', 'config'].includes(t.type) ? t.type : 'token';
  return {
    id: safeId(t.id),
    // 不在这里补默认名：补了之后 validateTunnelInput 的「请填写名称」永远触发不了，
    // 空名称会被悄悄存成「未命名隧道」。
    name: String(t.name || '').trim().slice(0, 80),
    type,
    enabled: t.enabled !== false,
    autoStart: t.autoStart !== false,
    // 默认开启：本地管理隧道最容易漏掉的一步就是 DNS 路由，少了它域名会返回
    // Cloudflare 边缘错误（1033/530），而隧道本身看起来是“运行中”，很难自查。
    // 用户已保存的隧道在下次加载时也会拿到该默认值，从而自愈。
    autoDns: t.autoDns !== false,
    token: typeof t.token === 'string' ? t.token : '',
    target: typeof t.target === 'string' ? t.target : '',
    quickHostname: typeof t.quickHostname === 'string' ? t.quickHostname : '',
    tunnelName: typeof t.tunnelName === 'string' ? t.tunnelName : '',
    tunnelId: typeof t.tunnelId === 'string' ? t.tunnelId : '',
    credentialsFile: typeof t.credentialsFile === 'string' ? t.credentialsFile : '',
    configFile: typeof t.configFile === 'string' ? t.configFile : '',
    ingress: Array.isArray(t.ingress)
      ? t.ingress.map((r) => ({
          hostname: String((r && r.hostname) || ''),
          path: String((r && r.path) || ''),
          service: String((r && r.service) || ''),
          noTLSVerify: !!(r && r.noTLSVerify),
          originServerName: String((r && r.originServerName) || ''),
          httpHostHeader: String((r && r.httpHostHeader) || ''),
        }))
      : [],
    catchAll: typeof t.catchAll === 'string' && t.catchAll ? t.catchAll : 'http_status:404',
    extraArgs: typeof t.extraArgs === 'string' ? t.extraArgs : '',
    note: typeof t.note === 'string' ? t.note : '',
  };
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    const tunnels = Array.isArray(raw.tunnels) ? raw.tunnels.map(normalizeTunnel) : [];
    config = { version: 1, settings, tunnels };
  } catch (err) {
    if (err.code !== 'ENOENT') logWarn('config.json unreadable, starting fresh:', err.message);
    config = defaultConfig();
  }
  settingsDirty = false;
}

/* The web UI's settings page is not the only writer of config.json: the App
 * Center settings page runs cmd/config_callback, a separate short-lived process
 * that edits the same file while this service holds its own copy in memory.
 * Saving the in-memory object wholesale would therefore silently revert whatever
 * the App Center just wrote -- both pages report success, and the user only
 * finds out when the setting is back the way it was.
 *
 * So a save merges instead of overwriting. The two halves have different owners:
 *
 *   settings -- writable from either side, so the newer writer wins. If this
 *               process changed them since the last save, memory wins; otherwise
 *               whatever is on disk now (e.g. config_callback) wins.
 *   tunnels  -- only ever written here, so memory is always authoritative.
 */
function saveConfig() {
  let merged = config;
  if (!settingsDirty) {
    try {
      const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (disk && typeof disk === 'object' && disk.settings && typeof disk.settings === 'object') {
        merged = {
          version: 1,
          settings: Object.assign({}, DEFAULT_SETTINGS, disk.settings),
          tunnels: config.tunnels,
        };
      }
    } catch (err) {
      /* no file yet, or unreadable: the in-memory copy is all we have */
    }
  }
  config = merged;
  atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 0o600);
  settingsDirty = false;
}

/* The single place settings are mutated. Marking them dirty here is what lets
 * saveConfig() tell "I changed this" apart from "someone else did". */
function setSettings(next) {
  config.settings = next;
  settingsDirty = true;
}

function validateTunnelInput(body, existing) {
  const merged = normalizeTunnel(Object.assign({}, existing || {}, body || {}));
  if (body && body.token === '' && existing) merged.token = existing.token;
  if (body && body.token === null) merged.token = '';
  const errors = [];
  if (!merged.name.trim()) errors.push('请填写名称');
  if (merged.type === 'token' && !merged.token) errors.push('请填写隧道 Token');
  if (merged.type === 'quick') {
    if (!/^https?:\/\//i.test(merged.target)) errors.push('本地服务地址需以 http:// 或 https:// 开头');
  }
  if (merged.type === 'local' && !merged.tunnelName && !merged.tunnelId) errors.push('请选择要运行的隧道');
  if (merged.type === 'config' && !merged.configFile) errors.push('请填写配置文件路径');
  if (merged.configFile && merged.configFile.includes('..')) errors.push('配置文件路径非法');
  for (const rule of merged.ingress) {
    if (!rule.hostname) errors.push('入站规则缺少域名');
    else if (!DNS_HOSTNAME_RE.test(rule.hostname)) {
      errors.push(`入站规则域名不合法：${rule.hostname}（只填主机名，例如 nas.example.com，不要带协议、端口或路径）`);
    }
    if (!/^https?:\/\//i.test(rule.service)) errors.push(`入站规则 ${rule.hostname || ''} 的服务地址需以 http:// 或 https:// 开头`);
  }
  return { tunnel: merged, errors };
}

/* loadConfig() replaces the object wholesale, so consumers must always read the
 * current one through this accessor instead of capturing it at require time. */
function getConfig() {
  return config;
}

module.exports = {
  DEFAULT_SETTINGS,
  getConfig,
  loadConfig,
  saveConfig,
  setSettings,
  normalizeTunnel,
  validateTunnelInput,
  newId,
  atomicWrite,
  maskSecret,
};
