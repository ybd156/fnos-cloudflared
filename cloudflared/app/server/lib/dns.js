'use strict';
/*
 * DNS routing for locally-managed tunnels: a hostname served by a named tunnel
 * has to resolve as a CNAME to <uuid>.cfargotunnel.com, otherwise the edge
 * answers 1033/530 while the tunnel itself looks healthy.
 */
const fs = require('fs');
const path = require('path');
const { CERT_FILE } = require('./paths');
const { logInfo, logWarn } = require('./log');
const { accountRouteDns, resolveCredentials, UUID_RE } = require('./cloudflared');

/* ------------------------------------------------------------- DNS routing */

/* A hostname served by a named tunnel must resolve as a CNAME to
 * `<uuid>.cfargotunnel.com`; a plain A record (even orange-cloud proxied) never
 * reaches the tunnel and the edge answers 1033/530. Local-managed tunnels know
 * their tunnel name/UUID, so we can create that route ourselves. */
const DNS_ROUTE_CACHE_MS = 10 * 60 * 1000;
const dnsRouteCache = new Map(); // `${tunnelName}\n${hostname}` -> { at, target }
const DNS_HOSTNAME_RE = /^(\*\.)?([A-Za-z0-9_-]+\.)+[A-Za-z]{2,}$/;

/* A DNS lookup that hangs must not pin the route check forever: runDnsRoutes
 * guards against re-entry with `dnsRunning`, so a stuck lookup would leave the
 * tunnel permanently "checking" and never re-check. */
const DNS_LOOKUP_TIMEOUT_MS = 10000;

async function lookupCname(hostname) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DNS 查询失败 (HTTP ${res.status})`);
  const data = await res.json();
  const answer = (data.Answer || []).find((a) => a.type === 5);
  return answer ? String(answer.data).replace(/\.$/, '') : null;
}

function ingressHostnames(tunnel) {
  const list = [];
  for (const rule of Array.isArray(tunnel.ingress) ? tunnel.ingress : []) {
    const host = String((rule && rule.hostname) || '').trim();
    if (host && DNS_HOSTNAME_RE.test(host) && !list.includes(host)) list.push(host);
  }
  return list;
}

/* Create/fix the DNS routes for one tunnel. Best effort: a failure here must
 * never stop the tunnel from starting, so callers surface the result instead. */
async function ensureDnsRoutes(tunnel) {
  const result = { ok: true, routed: [], alreadyOk: [], failed: [], skipped: true, message: '' };
  if (tunnel.type !== 'local' || tunnel.autoDns === false) {
    result.message = '未启用自动 DNS 路由';
    return result;
  }
  const name = tunnel.tunnelName || tunnel.tunnelId;
  if (!name) {
    result.ok = false;
    result.message = '未选择已创建的隧道';
    return result;
  }
  const hostnames = ingressHostnames(tunnel);
  if (!hostnames.length) {
    result.message = '入站规则中没有需要路由的域名';
    return result;
  }
  if (!fs.existsSync(CERT_FILE)) {
    result.ok = false;
    result.message = '尚未登录 Cloudflare 账户，无法自动配置 DNS 路由';
    return result;
  }

  result.skipped = false;
  // 不能直接拼 `${id || ''}`：两者都拿不到时会得到 `.cfargotunnel.com` 这种非法
  // 目标，既是 truthy 又永远匹配不上，会把判断带偏。UUID 未知时明确放弃。
  const uuid = tunnel.tunnelId || resolveTunnelUuid(tunnel) || '';
  if (!uuid) {
    result.ok = false;
    result.message = '无法确认隧道 UUID，跳过 DNS 路由配置';
    return result;
  }
  const target = `${uuid}.cfargotunnel.com`;
  for (const hostname of hostnames) {
    const key = `${name}\n${hostname}`;
    let current = null;
    try {
      current = await lookupCname(hostname);
    } catch (err) {
      logWarn(`dns lookup failed for ${hostname}: ${err.message}`);
    }
    if (current && current.toLowerCase() === target.toLowerCase()) {
      result.alreadyOk.push(hostname);
      rememberRoute(name, hostname, current);
      continue;
    }
    logInfo(`routing ${hostname} -> ${name} (current CNAME: ${current || 'none'})`);
    const out = await accountRouteDns(name, hostname);
    if (out.ok) {
      result.routed.push(hostname);
      rememberRoute(name, hostname, target || current || '');
    } else {
      result.failed.push({ hostname, error: out.error || '未知错误' });
    }
  }

  if (result.failed.length) {
    result.ok = false;
    result.message = result.failed.map((f) => `${f.hostname}: ${f.error}`).join('；');
  } else if (result.routed.length) {
    result.message = `已配置 DNS 路由: ${result.routed.join('、')}`;
  } else {
    result.message = `DNS 路由已正确: ${result.alreadyOk.join('、')}`;
  }
  return result;
}

/* The credentials file is named after the tunnel UUID, so it is the most
 * reliable place to recover the UUID when only a name was stored.
 *
 * resolveCredentials() only answers with provable paths, so a tunnel known by
 * name alone yields '' here -- callers must resolve the name to a UUID first
 * rather than routing to whichever credentials file happens to sort first. */
function resolveTunnelUuid(tunnel) {
  const cred = resolveCredentials(tunnel);
  if (cred) {
    const base = path.basename(cred).replace(/\.json$/, '');
    if (UUID_RE.test(base)) return base;
  }
  return '';
}

/* The cache is only a rate limiter for the 10-minute re-check, so it stays in
 * memory: a restart simply re-verifies every route once. */
function rememberRoute(name, hostname, target) {
  dnsRouteCache.set(`${name}\n${hostname}`, { at: Date.now(), target: target || '' });
}

function routeCacheFresh(name, hostname) {
  const hit = dnsRouteCache.get(`${name}\n${hostname}`);
  return !!hit && Date.now() - hit.at <= DNS_ROUTE_CACHE_MS;
}

module.exports = {
  DNS_HOSTNAME_RE,
  DNS_ROUTE_CACHE_MS,
  lookupCname,
  ingressHostnames,
  ensureDnsRoutes,
  resolveTunnelUuid,
  rememberRoute,
  routeCacheFresh,
};
