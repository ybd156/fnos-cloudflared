#!/usr/bin/env node
/*
 * Cloudflare Tunnel for fnOS -- service entry point.
 *
 * Wires the modules in app/server/lib together: persistent state, the
 * cloudflared binary, one supervised process per tunnel, and the HTTP surface
 * the web UI talks to. Only Node built-in modules are used, so the package has
 * no npm dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const {
  SOCKET_PATH,
  TCP_HOST,
  TCP_PORT,
  ensureDirs,
} = require('./lib/paths');
const { logInfo, logError, rotateAppLogNow } = require('./lib/log');
const { loadConfig, getConfig } = require('./lib/store');
const { cloudflaredVersion } = require('./lib/cloudflared');
const { runtimeRecord, startTunnel, stopAll } = require('./lib/runner');
const { requestHandler } = require('./lib/http');

function startServer() {
  ensureDirs();
  /* Rotate before the first write: at startup nothing else is appending, so
   * this is the one moment the check cannot race a concurrent writer. */
  rotateAppLogNow();
  loadConfig();
  cloudflaredVersion(true).then((v) => logInfo(`cloudflared version: ${v || 'not found'}`));

  const server = http.createServer(requestHandler);
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (e) {
      /* ignore */
    }
  });

  /* The fnOS gateway reaches the app through a Unix socket inside the payload
   * directory; a loopback TCP port is kept as a fallback for the App Center's
   * port check and for local debugging. */
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    /* no stale socket */
  }
  try {
    server.listen(SOCKET_PATH, () => {
      try {
        fs.chmodSync(SOCKET_PATH, 0o660);
      } catch (err) {
        /* ignore */
      }
      logInfo(`listening on unix socket ${SOCKET_PATH}`);
    });
    server.on('error', (err) => logError('socket listener error:', err.message));
  } catch (err) {
    logError('failed to bind unix socket:', err.message);
  }

  if (TCP_PORT) {
    const tcp = http.createServer(requestHandler);
    tcp.on('error', (err) => logError(`tcp listener error on ${TCP_HOST}:${TCP_PORT}:`, err.message));
    tcp.listen(TCP_PORT, TCP_HOST, () => logInfo(`listening on http://${TCP_HOST}:${TCP_PORT}`));
  }

  if (getConfig().settings.autoStart) {
    setTimeout(() => {
      for (const tunnel of getConfig().tunnels) {
        if (tunnel.enabled && tunnel.autoStart) {
          logInfo(`autostart tunnel ${tunnel.id} (${tunnel.name})`);
          startTunnel(tunnel.id);
        }
      }
    }, 1500).unref();
  }

  /* Last-resort net: a bug in an async callback must not kill the service.
   * Exiting would orphan every cloudflared child and leave the UI dead until
   * someone restarts the app by hand, so log loudly and keep serving. */
  process.on('uncaughtException', (err) => {
    logError('uncaught exception:', err && err.stack ? err.stack : String(err));
  });
  process.on('unhandledRejection', (reason) => {
    logError('unhandled rejection:', reason && reason.stack ? reason.stack : String(reason));
  });

  const shutdown = (signal) => {
    logInfo(`received ${signal}, shutting down`);
    stopAll();
    /* Wait for the children to actually exit before leaving: exiting first hands
     * cloudflared over to init, where it keeps holding the tunnel connections
     * while the app can no longer see or stop it. */
    const deadline = Date.now() + 10000;
    const finish = () => {
      const alive = getConfig().tunnels.filter((t) => runtimeRecord(t.id).child);
      if (alive.length && Date.now() < deadline) {
        setTimeout(finish, 200).unref();
        return;
      }
      logInfo(`shutdown complete (${alive.length} child process(es) still running)`);
      process.exit(0);
    };
    finish();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
