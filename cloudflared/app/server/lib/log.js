'use strict';
/*
 * Logging. Everything the service does is written to one file so a support
 * request can be answered from $PKGVAR/server.log alone.
 *
 * Two rules shape this module:
 *
 *   1. Nothing here may block the event loop. pushLog() runs once per line
 *      cloudflared prints, and the service is single threaded -- a synchronous
 *      write per line stalls every HTTP request and every other tunnel behind
 *      it. The server log and the per-tunnel logs are therefore appended
 *      asynchronously, and never throw.
 *   2. Nothing here may grow without bound. Both logs rotate, so a chatty
 *      tunnel cannot fill the NAS system volume.
 */
const fs = require('fs');
const { APP_LOG, MAX_APP_LOG_BYTES, MAX_TUNNEL_LOG_BYTES } = require('./paths');

/* Rotation is checked on a timer rather than on every line: statSync() per line
 * was the other half of the synchronous-I/O cost. */
const ROTATE_CHECK_MS = 30 * 1000;

function rotate(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch (err) {
    /* no log yet, or the rename lost a race -- either way, keep going */
  }
}

function rotateAppLog() {
  rotate(APP_LOG, MAX_APP_LOG_BYTES);
}

/* Per-tunnel logs used to grow forever. Rotation now happens inside
 * appendPrivate(), which every per-tunnel write already goes through and which
 * receives the tunnel's own byte cap; there is no separate entry point. */

function log(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}`;
  if (level === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  appendPrivate(APP_LOG, line + '\n', MAX_APP_LOG_BYTES);
}

const logInfo = (...p) => log('INFO', ...p);
const logWarn = (...p) => log('WARN', ...p);
const logError = (...p) => log('ERROR', ...p);

/* Append a line to a log file that must not be world-readable.
 *
 * The mode is re-asserted on the first write because this filesystem can hand
 * out generous default modes for freshly created files. chmodSync() runs at
 * most once per path, not once per line.
 *
 * appendFile() is asynchronous on purpose: see rule 1 above. The callback
 * swallows errors, because a full disk must not take the service down. */
const privateLogs = new Set();
const rotateDue = new Map();

function appendPrivate(file, line, maxBytes) {
  const first = !privateLogs.has(file);
  if (first) {
    privateLogs.add(file);
    try {
      fs.chmodSync(file, 0o640);
    } catch (err) {
      /* the file may not exist yet; the mode is applied by appendFile's open */
    }
  }

  const now = Date.now();
  const last = rotateDue.get(file) || 0;
  if (now - last > ROTATE_CHECK_MS) {
    rotateDue.set(file, now);
    rotate(file, maxBytes || MAX_TUNNEL_LOG_BYTES);
  }

  try {
    fs.appendFile(file, line, { mode: 0o640 }, () => {
      /* never let logging take the service down */
    });
  } catch (err) {
    /* synchronous throw (e.g. invalid path) -- still must not propagate */
  }
}

/* Rotate the server log at startup, when no other writer can be active. */
function rotateAppLogNow() {
  rotateAppLog();
}

/* Read only the tail of a log file.
 *
 * The log endpoints used to readFileSync() the whole file and then slice the
 * last N lines: an unbounded read on every UI poll (every 3 seconds). Reading
 * just the final window keeps the cost flat no matter how large the log grew.
 * A byte window can start mid-line or mid-UTF-8-character, so the first
 * (partial) line is discarded. */
function readTailLines(file, maxBytes, maxLines) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return [];
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    /* The file can shrink between statSync and readSync -- rotate() renames it
     * away every 30s, and a fresh log then starts empty. Decoding the whole
     * buffer regardless of how much was actually read would emit whatever
     * uninitialized heap the buffer came from (allocUnsafe), so only the bytes
     * really read may be decoded. */
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8', 0, bytesRead);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const lines = text.split('\n').filter(Boolean);
    return maxLines > 0 ? lines.slice(-maxLines) : lines;
  } catch (err) {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  log,
  logInfo,
  logWarn,
  logError,
  appendPrivate,
  rotateAppLogNow,
  readTailLines,
  ROTATE_CHECK_MS,
};
