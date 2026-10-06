'use strict';
/*
 * Process supervision: one cloudflared child per tunnel, with restart handling
 * and the runtime record the UI reads. The rule that keeps this honest is that
 * only the *current* child may touch its record -- a process that is on its way
 * out must not clobber the state of the one that replaced it.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  CF_BIN,
  PKGVAR,
  LOGS_DIR,
  MAX_LOG_LINES,
  MAX_TUNNEL_LOG_BYTES,
  RESTART_BASE_MS,
  RESTART_MAX_MS,
  RESTART_MAX_ATTEMPTS,
  RESTART_STABLE_MS,
} = require('./paths');
const { logInfo, logWarn, appendPrivate } = require('./log');
const { getConfig, maskSecret } = require('./store');
const { cfEnv, buildArgs, writeTunnelConfig, resolveCredentials } = require('./cloudflared');
const { ensureDnsRoutes, ingressHostnames, routeCacheFresh } = require('./dns');

/* 「保存即生效」：隧道没在运行时，保存不会触发 startTunnel，config.yml 与 DNS 路由
 * 都停留在上一次启动时的状态 —— 用户会以为刚添加的域名没生效（界面却显示保存成功、
 * DNS 正常）。这里主动写一次配置并补 DNS 路由，runDnsRoutes 会在关闭自动 DNS 路由
 * 或没有域名时自行跳过。 */
function applyLocalConfig(tunnel) {
  if (tunnel.type !== 'local') return;
  const cred = resolveCredentials(tunnel);
  if (!cred) {
    logWarn(`tunnel ${tunnel.id}: no credentials file, skipping config write after save`);
    return;
  }
  try {
    writeTunnelConfig(tunnel, cred);
  } catch (err) {
    logWarn(`tunnel ${tunnel.id}: writing config.yml after save failed: ${err.message}`);
    return;
  }
  runDnsRoutes(tunnel.id, true);
}

/* Run ensureDnsRoutes in the background for one tunnel and record the outcome
 * on its runtime record, so the UI can show it. Never throws, never blocks the
 * caller: the tunnel starts regardless of what happens here. */
function runDnsRoutes(id, force) {
  const tunnel = tunnelById(id);
  if (!tunnel) return;
  const rec = runtimeRecord(id);
  if (rec.dnsRunning) return;
  if (tunnel.type !== 'local' || tunnel.autoDns === false) return;
  if (!ingressHostnames(tunnel).length) return;

  // Auto-restarts can fire every few seconds; only re-check when the cache is
  // stale, otherwise a crash loop would hammer the Cloudflare API.
  if (!force) {
    const name = tunnel.tunnelName || tunnel.tunnelId;
    let fresh = true;
    for (const hostname of ingressHostnames(tunnel)) {
      if (!routeCacheFresh(name, hostname)) fresh = false;
    }
    if (fresh) return;
  }

  rec.dnsRunning = true;
  rec.dnsStatus = 'checking';
  rec.dnsMessage = '正在检查 DNS 路由…';

  ensureDnsRoutes(tunnel)
    .then((out) => {
      rec.dnsResults = { routed: out.routed, alreadyOk: out.alreadyOk, failed: out.failed };
      rec.dnsMessage = out.message;
      if (out.skipped) rec.dnsStatus = 'skipped';
      else rec.dnsStatus = out.ok ? 'ok' : 'error';
      if (out.routed.length || out.failed.length) {
        logInfo(`dns routes for ${id}: ${out.message}`);
      }
    })
    .catch((err) => {
      rec.dnsStatus = 'error';
      rec.dnsMessage = `DNS 路由检查失败: ${err.message}`;
      logWarn(`dns route check failed for ${id}: ${err.message}`);
    })
    .finally(() => {
      rec.dnsRunning = false;
    });
}

/* --------------------------------------------------------- process manager */

const runtime = new Map(); // id -> runtime record

function runtimeRecord(id) {
  let rec = runtime.get(id);
  if (!rec) {
    rec = {
      status: 'stopped',
      pid: null,
      startedAt: null,
      stoppedAt: null,
      url: '',
      error: '',
      log: [],
      child: null,
      stopping: false,
      attempts: 0,
      restartTimer: null,
      lastExitCode: null,
      lastExitAt: null,
      dnsStatus: '', // '' | 'checking' | 'ok' | 'error' | 'skipped'
      dnsResults: null, // { routed: [], alreadyOk: [], failed: [] }
      dnsMessage: '',
      dnsRunning: false,
      pendingRestart: false, // 等待旧进程退出后再启动
    };
    runtime.set(id, rec);
  }
  return rec;
}

function pushLog(id, text) {
  const rec = runtimeRecord(id);
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line && lines.length > 1) continue;
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    rec.log.push(entry);
    if (rec.log.length > MAX_LOG_LINES) rec.log.splice(0, rec.log.length - MAX_LOG_LINES);
    /* Rotation limit is passed explicitly: appendPrivate serves both the server
     * log and the per-tunnel logs, which have different caps. */
    appendPrivate(path.join(LOGS_DIR, `${id}.log`), entry + '\n', MAX_TUNNEL_LOG_BYTES);
    observeLine(id, line);
  }
}

const QUICK_URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/;
const READY_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered|Initial protocol/i;

function observeLine(id, line) {
  const rec = runtimeRecord(id);
  const quick = line.match(QUICK_URL_RE);
  if (quick) {
    rec.url = quick[0];
    logInfo(`tunnel ${id} quick URL: ${rec.url}`);
  }
  if (READY_RE.test(line) && rec.status !== 'running') {
    rec.status = 'running';
    rec.error = '';
  }
  if (/ERR |failed to |Unable to |error=|level=error/i.test(line)) {
    if (rec.status === 'starting') rec.error = line.slice(0, 300);
  }
}

function tunnelById(id) {
  return getConfig().tunnels.find((t) => t.id === id) || null;
}

function startTunnel(id, options) {
  const opts = options || {};
  const tunnel = tunnelById(id);
  if (!tunnel) return { ok: false, error: '隧道不存在' };
  const rec = runtimeRecord(id);

  if (rec.child && !rec.stopping) return { ok: true, already: true };

  /* 旧进程还在优雅退出（stopTunnel 刚发过 SIGTERM，cloudflared 通常要 1~3 秒）：
   * 先把它从记录里摘掉，等它真正退出再启动。否则同一隧道会并存两个 cloudflared
   * —— 连接重复、旧进程退出后没人回收。 */
  if (rec.child) {
    const prev = rec.child;
    rec.child = null;
    rec.pid = null;
    rec.status = 'starting';
    rec.pendingRestart = true;
    const launch = () => {
      if (!rec.pendingRestart) return; // 等待期间用户点了「停止」
      rec.pendingRestart = false;
      startTunnel(id, options);
    };
    prev.once('exit', launch);
    // 兜底：stopTunnel 会在 8 秒后 SIGKILL，exit 理论上一定到达；万一丢了也不能
    // 让隧道永远停在「启动中」。
    setTimeout(launch, 10000).unref();
    return { ok: true, pending: true };
  }

  if (!fs.existsSync(CF_BIN)) {
    rec.status = 'error';
    rec.error = `cloudflared 可执行文件不存在: ${CF_BIN}`;
    return { ok: false, error: rec.error };
  }

  const built = buildArgs(tunnel, getConfig().settings);
  if (built.error) {
    rec.status = 'error';
    rec.error = built.error;
    return { ok: false, error: built.error };
  }

  if (!opts.keepAttempts) rec.attempts = 0;
  rec.stopping = false;
  rec.status = 'starting';
  rec.error = '';
  rec.url = '';
  rec.log = [];
  rec.startedAt = new Date().toISOString();

  logInfo(`starting tunnel ${id} (${tunnel.type}): ${CF_BIN} ${built.args.join(' ')}`);

  let child;
  try {
    child = spawn(CF_BIN, built.args, {
      cwd: PKGVAR,
      env: cfEnv(built.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    rec.status = 'error';
    rec.error = `启动失败: ${err.message}`;
    return { ok: false, error: rec.error };
  }

  rec.child = child;
  rec.pid = child.pid;
  rec.lastExitCode = null;

  /* 重启时旧进程往往还在退出，它随后到达的 stdout/exit 事件会把新进程的记录清空
   * （界面显示「已停止」而进程其实活着），还会被当成崩溃再拉起一个进程。所以凡是
   * 改运行时记录的地方都先确认「这个 child 还是当前进程」。 */
  const isCurrent = () => rec.child === child;

  child.stdout.on('data', (buf) => {
    if (isCurrent()) pushLog(id, buf.toString('utf8'));
  });
  child.stderr.on('data', (buf) => {
    if (isCurrent()) pushLog(id, buf.toString('utf8'));
  });

  child.on('error', (err) => {
    if (!isCurrent()) return;
    rec.status = 'error';
    rec.error = `进程错误: ${err.message}`;
    pushLog(id, `spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (!isCurrent()) {
      logInfo(`tunnel ${id}: superseded process ${child.pid} exited (code=${code}), ignoring`);
      return;
    }
    const wasStopping = rec.stopping;
    rec.child = null;
    rec.pid = null;
    rec.lastExitCode = code;
    rec.lastExitAt = new Date().toISOString();
    rec.stoppedAt = rec.lastExitAt;
    logInfo(`tunnel ${id} exited code=${code} signal=${signal} stopping=${wasStopping}`);

    if (wasStopping) {
      rec.status = 'stopped';
      rec.error = '';
      return;
    }
    rec.status = code === 0 ? 'stopped' : 'error';
    if (code !== 0) {
      rec.error = rec.error || `cloudflared 退出，退出码 ${code}${signal ? ` (${signal})` : ''}`;
    }
    scheduleRestart(id);
  });

  /* cloudflared can take a few seconds before it reports a connection; keep the
   * UI honest by promoting "starting" to "running" after a short grace period
   * when the process is still alive and no fatal error was seen. */
  setTimeout(() => {
    if (isCurrent() && rec.status === 'starting') rec.status = 'running';
  }, 8000).unref();

  // 本地管理隧道：顺便把 ingress 里的域名 CNAME 到隧道（幂等、失败不影响启动）。
  runDnsRoutes(id, false);

  return { ok: true };
}

function scheduleRestart(id) {
  const tunnel = tunnelById(id);
  const rec = runtimeRecord(id);
  if (!tunnel || !getConfig().settings.autoRestart || tunnel.autoRestart === false) return;
  if (!tunnel.enabled) return;

  const ranFor = rec.startedAt ? Date.now() - Date.parse(rec.startedAt) : 0;
  if (ranFor > RESTART_STABLE_MS) rec.attempts = 0;

  if (rec.attempts >= RESTART_MAX_ATTEMPTS) {
    rec.status = 'error';
    rec.error = `连续 ${RESTART_MAX_ATTEMPTS} 次启动失败，已停止自动重试`;
    logWarn(`tunnel ${id}: giving up after ${RESTART_MAX_ATTEMPTS} attempts`);
    return;
  }
  rec.attempts += 1;
  const delay = Math.min(RESTART_BASE_MS * Math.pow(2, rec.attempts - 1), RESTART_MAX_MS);
  pushLog(id, `将在 ${Math.round(delay / 1000)} 秒后自动重启（第 ${rec.attempts} 次）`);
  if (rec.restartTimer) clearTimeout(rec.restartTimer);
  rec.restartTimer = setTimeout(() => {
    rec.restartTimer = null;
    rec.status = 'starting';
    startTunnel(id, { keepAttempts: true });
  }, delay);
  rec.restartTimer.unref();
}

function stopTunnel(id) {
  const rec = runtimeRecord(id);
  if (rec.restartTimer) {
    clearTimeout(rec.restartTimer);
    rec.restartTimer = null;
  }
  rec.attempts = 0;
  rec.stopping = true;
  rec.pendingRestart = false;

  const child = rec.child;
  if (!child || !rec.pid) {
    rec.status = 'stopped';
    rec.pid = null;
    return { ok: true };
  }
  logInfo(`stopping tunnel ${id} (pid ${rec.pid})`);
  try {
    child.kill('SIGTERM');
  } catch (err) {
    /* already gone */
  }
  const pid = rec.pid;
  setTimeout(() => {
    if (rec.child && rec.pid === pid) {
      try {
        rec.child.kill('SIGKILL');
      } catch (err) {
        /* ignore */
      }
    }
  }, 8000).unref();
  rec.status = 'stopping';
  return { ok: true };
}

function stopAll() {
  for (const tunnel of getConfig().tunnels) {
    try {
      stopTunnel(tunnel.id);
    } catch (err) {
      /* ignore */
    }
  }
}

/* Drop a tunnel's runtime record once the tunnel itself is gone. The registry is
 * owned here, so callers (the HTTP layer) must not reach into it directly --
 * deleting a tunnel used to throw ReferenceError from the request handler and
 * still answer 200 to the UI, leaving a restart timer alive for a tunnel that no
 * longer exists. */
function forgetTunnel(id) {
  const rec = runtime.get(id);
  if (rec) {
    if (rec.restartTimer) clearTimeout(rec.restartTimer);
    rec.restartTimer = null;
    rec.pendingRestart = false;
  }
  return runtime.delete(id);
}

function tunnelView(tunnel) {
  const rec = runtimeRecord(tunnel.id);
  const view = {
    id: tunnel.id,
    name: tunnel.name,
    type: tunnel.type,
    enabled: tunnel.enabled,
    autoStart: tunnel.autoStart,
    autoDns: tunnel.autoDns,
    target: tunnel.target,
    quickHostname: tunnel.quickHostname,
    tunnelName: tunnel.tunnelName,
    tunnelId: tunnel.tunnelId,
    credentialsFile: tunnel.credentialsFile,
    configFile: tunnel.configFile,
    ingress: tunnel.ingress,
    catchAll: tunnel.catchAll,
    extraArgs: tunnel.extraArgs,
    note: tunnel.note,
    hasToken: !!tunnel.token,
    tokenPreview: maskSecret(tunnel.token),
    status: rec.status,
    pid: rec.pid,
    url: rec.url,
    error: rec.error,
    startedAt: rec.startedAt,
    stoppedAt: rec.stoppedAt,
    lastExitCode: rec.lastExitCode,
    lastExitAt: rec.lastExitAt,
    attempts: rec.attempts,
    dnsStatus: rec.dnsStatus,
    dnsResults: rec.dnsResults,
    dnsMessage: rec.dnsMessage,
    dnsRunning: rec.dnsRunning,
  };
  return view;
}

module.exports = {
  runtimeRecord,
  forgetTunnel,
  tunnelById,
  tunnelView,
  startTunnel,
  stopTunnel,
  stopAll,
  runDnsRoutes,
  applyLocalConfig,
};
