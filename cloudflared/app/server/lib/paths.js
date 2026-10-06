'use strict';
/*
 * Paths and tunables. The fnOS app centre hands the locations in through TRIM_*
 * environment variables; everything else in the app derives from them.
 */
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ paths */

const APPNAME = process.env.TRIM_APPNAME || 'cloudflared';
const APPDEST = process.env.TRIM_APPDEST || `/var/apps/${APPNAME}/target`;
const PKGVAR = process.env.TRIM_PKGVAR || `/var/apps/${APPNAME}/var`;
const PKGTMP = process.env.TRIM_PKGTMP || `/var/apps/${APPNAME}/tmp`;
const PKGETC = process.env.TRIM_PKGETC || `/var/apps/${APPNAME}/etc`;

const WWW_DIR = path.join(APPDEST, 'www');
const CF_BIN = path.join(APPDEST, 'bin', 'cloudflared');
const SOCKET_PATH = path.join(APPDEST, 'app.sock');
const GATEWAY_PREFIX = '/app/' + APPNAME;

/* cloudflared state lives in the app's persistent var directory */
const CF_HOME = PKGVAR;
const CF_DIR = path.join(PKGVAR, '.cloudflared');
const CERT_FILE = path.join(CF_DIR, 'cert.pem');
const TUNNELS_DIR = path.join(PKGVAR, 'tunnels');
const LOGS_DIR = path.join(PKGVAR, 'logs');
const CONFIG_FILE = path.join(PKGVAR, 'config.json');
const APP_LOG = path.join(PKGVAR, 'server.log');
const CF_VERSION_FILE = path.join(PKGVAR, 'cloudflared.version');

const TCP_HOST = process.env.CF_TUNNEL_HOST || '127.0.0.1';
const TCP_PORT = parseInt(process.env.TRIM_SERVICE_PORT || '0', 10) || 0;

const MAX_LOG_LINES = 600;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_APP_LOG_BYTES = 2 * 1024 * 1024;
/* Per-tunnel logs are appended on every line cloudflared emits. Nothing used to
 * cap them, so a chatty tunnel filled the NAS system volume over weeks. One
 * generation is kept, so a tunnel costs at most 2x this on disk. */
const MAX_TUNNEL_LOG_BYTES = 1024 * 1024;
/* The log endpoints read only the tail of a file. Reading the whole thing (the
 * old behaviour) pulled an unbounded amount of text into memory on every UI
 * poll, every 3 seconds. */
const MAX_TAIL_BYTES = 64 * 1024;
const RESTART_BASE_MS = 5000;
const RESTART_MAX_MS = 60000;
const RESTART_MAX_ATTEMPTS = 10;
const RESTART_STABLE_MS = 120000;

function ensureDirs() {
  for (const dir of [PKGVAR, PKGTMP, CF_DIR, TUNNELS_DIR, LOGS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      /* best effort: a missing dir surfaces later with a clearer error */
    }
  }
  try {
    fs.chmodSync(CF_DIR, 0o700);
  } catch (err) {
    /* ignore */
  }
}

module.exports = {
  APPNAME,
  APPDEST,
  PKGVAR,
  PKGTMP,
  PKGETC,
  WWW_DIR,
  CF_BIN,
  SOCKET_PATH,
  GATEWAY_PREFIX,
  CF_HOME,
  CF_DIR,
  CERT_FILE,
  TUNNELS_DIR,
  LOGS_DIR,
  CONFIG_FILE,
  APP_LOG,
  CF_VERSION_FILE,
  TCP_HOST,
  TCP_PORT,
  MAX_LOG_LINES,
  MAX_BODY_BYTES,
  MAX_APP_LOG_BYTES,
  MAX_TUNNEL_LOG_BYTES,
  MAX_TAIL_BYTES,
  RESTART_BASE_MS,
  RESTART_MAX_MS,
  RESTART_MAX_ATTEMPTS,
  RESTART_STABLE_MS,
  ensureDirs,
};
