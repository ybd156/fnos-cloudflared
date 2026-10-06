'use strict';
/*
 * The HTTP surface: static assets for the web UI plus the small REST API that
 * drives it. Nothing may throw out of a request handler -- see requestHandler.
 */
const fs = require('fs');
const path = require('path');
const {
  APPNAME,
  WWW_DIR,
  GATEWAY_PREFIX,
  CF_BIN,
  CERT_FILE,
  APP_LOG,
  LOGS_DIR,
  MAX_LOG_LINES,
  MAX_BODY_BYTES,
  MAX_TAIL_BYTES,
} = require('./paths');
const { logInfo, logWarn, logError, readTailLines } = require('./log');
const { getConfig, saveConfig, setSettings, validateTunnelInput, newId } = require('./store');
const {
  runtimeRecord,
  forgetTunnel,
  tunnelById,
  tunnelView,
  startTunnel,
  stopTunnel,
  applyLocalConfig,
} = require('./runner');
const { ensureDnsRoutes } = require('./dns');
const {
  cloudflaredVersion,
  readAppVersion,
  updateBinary,
  accountLoginStart,
  accountLoginStatus,
  accountLogout,
  accountListTunnels,
  accountCreateTunnel,
  accountDeleteTunnel,
  accountRouteDns,
  resolveTunnelIdByName,
} = require('./cloudflared');

/* --------------------------------------------------------------- http layer */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 回 413 而不是 destroy()：直接断连接客户端只会看到 ECONNRESET，
        // 看不到「请求体过大」。剩下的数据交给 Node 读掉即可。
        rejected = true;
        chunks.length = 0;
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* Strip the fnOS gateway prefix so the same router serves both entry points. */
function stripPrefix(pathname) {
  if (pathname === GATEWAY_PREFIX) return '/';
  if (pathname.startsWith(GATEWAY_PREFIX + '/')) return pathname.slice(GATEWAY_PREFIX.length);
  return pathname;
}

/* Decode a URL path, rejecting anything that cannot be a legal path. A
 * malformed percent-encoding (or a NUL byte) used to throw URIError straight out
 * of the request handler; that is an uncaught exception, so a single bad request
 * killed the whole service and orphaned every running cloudflared child. */
function safeDecodePath(value) {
  try {
    const decoded = decodeURIComponent(String(value == null ? '' : value));
    return decoded.includes('\0') ? null : decoded;
  } catch (err) {
    return null;
  }
}

function serveStatic(req, res, pathname, prefix) {
  const decoded = safeDecodePath(pathname);
  if (decoded === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  let rel = decoded;
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(WWW_DIR, rel));
  /* A plain startsWith(WWW_DIR) check also accepts a sibling directory whose
   * name merely begins with the same characters (…/www-evil); compare the
   * relative path instead so escaping the root is always detected. */
  const withinWww = path.relative(WWW_DIR, target);
  if (withinWww.startsWith('..') || path.isAbsolute(withinWww)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      /* single page app: unknown non-asset paths fall back to index.html */
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      return serveStatic(req, res, '/index.html', prefix);
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';

    /* HTML carries a %%CF_BASE%% placeholder so relative asset and API URLs stay
     * correct whether the page is served behind the gateway or on a bare port. */
    if (path.extname(target).toLowerCase() === '.html') {
      return fs.readFile(target, 'utf8', (readErr, html) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Internal Error');
        }
        const body = Buffer.from(html.split('%%CF_BASE%%').join(prefix || ''), 'utf8');
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=300',
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* A locally-managed tunnel needs its UUID to locate <uuid>.json. When the user
 * picked it by name the UUID can be missing (typed by hand, or saved before the
 * dropdown carried data-id), and running "whichever credentials file exists"
 * silently attaches the wrong tunnel. Resolve the name once, so every later
 * start/DNS call is exact. Best effort: without a login the tunnel still saves,
 * and start reports precisely what is missing. */
async function resolveLocalTunnelId(tunnel, persist) {
  if (!tunnel || tunnel.type !== 'local' || tunnel.tunnelId || !tunnel.tunnelName) return false;
  try {
    const resolved = await resolveTunnelIdByName(tunnel.tunnelName);
    if (!resolved) return false;
    tunnel.tunnelId = resolved;
    if (persist) saveConfig();
    logInfo(`resolved tunnel ${tunnel.tunnelName} to ${resolved}`);
    return true;
  } catch (err) {
    logWarn(`could not resolve the UUID of tunnel ${tunnel.tunnelName}: ${err.message}`);
    return false;
  }
}

async function handleApi(req, res, pathname, query) {
  const method = req.method || 'GET';
  const segments = pathname.split('/').filter(Boolean); // api/...
  const [, resource, id, action] = segments;

  if (resource === 'meta' && method === 'GET') {
    return sendJson(res, 200, {
      app: APPNAME,
      version: readAppVersion(),
      cloudflared: await cloudflaredVersion(),
      binary: CF_BIN,
      binaryExists: fs.existsSync(CF_BIN),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      gatewayPrefix: GATEWAY_PREFIX,
      uptime: Math.round(process.uptime()),
      loggedIn: fs.existsSync(CERT_FILE),
    });
  }

  if (resource === 'settings') {
    if (method === 'GET') return sendJson(res, 200, getConfig().settings);
    if (method === 'PUT') {
      const body = await readBody(req);
      const next = Object.assign({}, getConfig().settings, body || {});
      if (!['auto', 'http2', 'quic'].includes(next.protocol)) return sendJson(res, 400, { error: 'protocol 取值非法' });
      if (!['', '4', '6', 4, 6].includes(next.edgeIpVersion)) return sendJson(res, 400, { error: 'edgeIpVersion 取值非法' });
      if (!['debug', 'info', 'warn', 'error'].includes(next.logLevel)) return sendJson(res, 400, { error: 'logLevel 取值非法' });
      const metrics = parseInt(next.metricsPort, 10) || 0;
      if (metrics < 0 || metrics > 65535) return sendJson(res, 400, { error: 'metrics 端口超出范围' });
      next.metricsPort = metrics;
      next.edgeIpVersion = next.edgeIpVersion === 4 || next.edgeIpVersion === 6 ? String(next.edgeIpVersion) : next.edgeIpVersion;
      /* setSettings() marks them dirty so saveConfig() knows memory is the newer
       * writer here, instead of deferring to a config.json written by the App
       * Center settings page (cmd/config_callback). */
      setSettings(next);
      saveConfig();
      return sendJson(res, 200, { ok: true, settings: getConfig().settings });
    }
    return sendJson(res, 405, { error: '方法不允许' });
  }

  if (resource === 'tunnels') {
    if (!id && method === 'GET') {
      return sendJson(res, 200, { tunnels: getConfig().tunnels.map(tunnelView) });
    }
    if (!id && method === 'POST') {
      const body = await readBody(req);
      const result = validateTunnelInput(body, null);
      if (result.errors.length) return sendJson(res, 400, { error: result.errors.join('；') });
      result.tunnel.id = newId();
      await resolveLocalTunnelId(result.tunnel);
      getConfig().tunnels.push(result.tunnel);
      saveConfig();
      logInfo(`created tunnel ${result.tunnel.id} (${result.tunnel.type})`);
      // 勾了「应用启动时自动启动」就立刻拉起来；否则用户保存后看到的是「已停止」，
      // 会以为没生效（autoStart 原本只在服务启动时生效）。
      if (result.tunnel.enabled && result.tunnel.autoStart) {
        startTunnel(result.tunnel.id);
      } else {
        applyLocalConfig(result.tunnel);
      }
      return sendJson(res, 200, { ok: true, tunnel: tunnelView(result.tunnel) });
    }
    if (id && action === 'start' && method === 'POST') {
      /* Self-heal tunnels saved before the UUID was recorded. */
      const target = tunnelById(id);
      if (target) await resolveLocalTunnelId(target, true);
      const out = startTunnel(id);
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    if (id && action === 'stop' && method === 'POST') {
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      stopTunnel(id);
      return sendJson(res, 200, { ok: true });
    }
    if (id && action === 'dns' && method === 'POST') {
      // 手动「修复 DNS 路由」：force=true 绕过 10 分钟缓存，立刻重新检查并修复。
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      const out = await ensureDnsRoutes(tunnel);
      const rec = runtimeRecord(id);
      rec.dnsResults = { routed: out.routed, alreadyOk: out.alreadyOk, failed: out.failed };
      rec.dnsMessage = out.message;
      rec.dnsStatus = out.skipped ? 'skipped' : out.ok ? 'ok' : 'error';
      return sendJson(res, out.ok ? 200 : 400, {
        ok: out.ok,
        message: out.message,
        routed: out.routed,
        alreadyOk: out.alreadyOk,
        failed: out.failed,
        skipped: out.skipped,
      });
    }
    if (id && action === 'restart' && method === 'POST') {
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      stopTunnel(id);
      setTimeout(() => startTunnel(id), 1200).unref();
      return sendJson(res, 200, { ok: true });
    }
    if (id && action === 'logs' && method === 'GET') {
      /* runtimeRecord() is a get-or-CREATE keyed on the raw URL segment, so
       * without this guard any string creates a permanent entry in the
       * supervisor's runtime Map. Nothing reaps it (DELETE 404s on unknown ids
       * first), so an unauthenticated caller could grow it without bound. */
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      const rec = runtimeRecord(id);
      const limit = Math.min(parseInt(query.get('lines') || '300', 10) || 300, MAX_LOG_LINES);
      let lines = rec.log.slice(-limit);
      if (!lines.length) {
        /* Read only the tail: the whole file used to be pulled into memory on
         * every poll, so a long-running tunnel made each refresh slower. */
        lines = readTailLines(path.join(LOGS_DIR, `${id}.log`), MAX_TAIL_BYTES, limit);
      }
      return sendJson(res, 200, { lines });
    }
    if (id && method === 'GET') {
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      return sendJson(res, 200, tunnelView(tunnel));
    }
    if (id && method === 'PUT') {
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      const body = await readBody(req);
      const result = validateTunnelInput(body, tunnel);
      if (result.errors.length) return sendJson(res, 400, { error: result.errors.join('；') });
      result.tunnel.id = tunnel.id;
      await resolveLocalTunnelId(result.tunnel);
      const idx = getConfig().tunnels.findIndex((t) => t.id === id);
      const wasRunning = runtimeRecord(id).child != null;
      getConfig().tunnels[idx] = result.tunnel;
      saveConfig();
      if (wasRunning) {
        stopTunnel(id);
        setTimeout(() => startTunnel(id), 1200).unref();
      } else {
        applyLocalConfig(result.tunnel);
      }
      return sendJson(res, 200, { ok: true, tunnel: tunnelView(result.tunnel) });
    }
    if (id && method === 'DELETE') {
      const tunnel = tunnelById(id);
      if (!tunnel) return sendJson(res, 404, { error: '隧道不存在' });
      stopTunnel(id);
      getConfig().tunnels = getConfig().tunnels.filter((t) => t.id !== id);
      saveConfig();
      forgetTunnel(id);
      /* Remove the tunnel's log and its rotated generation, so a deleted tunnel
       * does not leave up to 2MB of stale log behind forever. */
      for (const suffix of ['', '.1']) {
        try {
          fs.unlinkSync(path.join(LOGS_DIR, `${id}.log${suffix}`));
        } catch (err) {
          /* not every tunnel has written a log yet */
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: '接口不存在' });
  }

  if (resource === 'account') {
    if (!id && method === 'GET') return sendJson(res, 200, accountLoginStatus());
    if (id === 'login' && method === 'GET') return sendJson(res, 200, accountLoginStatus());
    if (id === 'login' && method === 'POST') {
      const out = await accountLoginStart();
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    if (id === 'logout' && method === 'POST') return sendJson(res, 200, accountLogout());

    if (id === 'tunnels' && method === 'GET') {
      const out = await accountListTunnels();
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    if (id === 'tunnels' && method === 'POST') {
      const body = await readBody(req);
      const out = await accountCreateTunnel(body.name);
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    if (id === 'tunnels' && action && method === 'DELETE') {
      /* A malformed percent-escape must not reach decodeURIComponent: it throws
       * URIError, which is the same class of bug that used to take the whole
       * service down on GET /%. Reuse the decoder the static path already uses. */
      const name = safeDecodePath(action);
      if (name === null) return sendJson(res, 400, { error: '隧道名称编码非法' });
      const out = await accountDeleteTunnel(name);
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    if (id === 'tunnels' && action && segments[4] === 'dns' && method === 'POST') {
      const body = await readBody(req);
      const name = safeDecodePath(action);
      if (name === null) return sendJson(res, 400, { error: '隧道名称编码非法' });
      const out = await accountRouteDns(name, body.hostname);
      return sendJson(res, out.ok ? 200 : 400, out);
    }
    return sendJson(res, 404, { error: '接口不存在' });
  }

  if (resource === 'logs' && method === 'GET') {
    /* Bounded tail read, matching the per-tunnel log endpoint. This used to
     * pass MAX_APP_LOG_BYTES (2MB) as the window, so every 3-second poll pulled
     * 2MB into memory and decoded it -- the same unbounded read the per-tunnel
     * endpoint was already fixed for. MAX_TAIL_BYTES is the shared bound. */
    return sendJson(res, 200, { lines: readTailLines(APP_LOG, MAX_TAIL_BYTES, 300) });
  }

  if (resource === 'binary' && id === 'update' && method === 'POST') {
    const out = await updateBinary();
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* -------------------------------------------------------------- entry point */

/* Every request enters here, and nothing may throw out of a request handler: an
 * uncaught exception terminates the process, which orphans the cloudflared
 * children and leaves the UI dead until the app is restarted by hand. */
function requestHandler(req, res) {
  try {
    routeRequest(req, res);
  } catch (err) {
    logError('unhandled request error:', err && err.stack ? err.stack : String(err));
    if (!res.headersSent) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Error');
      } catch (writeErr) {
        /* the socket is already gone */
      }
    }
  }
}

function routeRequest(req, res) {
  let pathname = '/';
  let rawPathname = '/';
  let query = new URLSearchParams();
  try {
    const parsed = new URL(req.url, 'http://localhost');
    rawPathname = parsed.pathname;
    pathname = stripPrefix(rawPathname);
    query = parsed.searchParams;
  } catch (err) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  /* Requests that arrive through the fnOS gateway carry the /app/<name>
   * prefix; remember it so the HTML placeholder can be filled in. */
  const prefix = rawPathname === GATEWAY_PREFIX || rawPathname.startsWith(GATEWAY_PREFIX + '/') ? GATEWAY_PREFIX : '';

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, query).catch((err) => {
      logError('api error:', err && err.stack ? err.stack : String(err));
      if (!res.headersSent) sendJson(res, err.statusCode || 500, { error: err.message || '服务器内部错误' });
    });
    return;
  }

  serveStatic(req, res, pathname, prefix);
}

module.exports = { requestHandler, serveStatic };
