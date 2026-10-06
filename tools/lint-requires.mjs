/*
 * Lint: a Node module namespace used in a file that never requires it.
 *
 * This is the exact defect class that shipped in 1.3.0 and broke the basic
 * features: lib/paths.js called fs.mkdirSync without require('fs') (so the data
 * directories were never created), lib/dns.js called path.basename without
 * require('path') (so every DNS route check threw), and lib/http.js called
 * runtime.get/runtime.delete without importing the registry (so deleting a
 * tunnel answered 500).
 *
 * Scope is deliberately narrow -- only the Node built-in module namespaces --
 * so the check has no false positives and can gate the build.
 *
 * Run: node tools/lint-requires.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* Node built-in namespaces that must be bound via require()/import before use. */
const NODE_NAMESPACES = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto',
  'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
];

/* `process` is a global, so it never needs a require. */
const GLOBAL_NAMESPACES = new Set(['process', 'console']);

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      /* keep the text so require('fs') is still visible */
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* Replace string / template-literal *contents* with spaces, preserving length so
 * reported line numbers stay accurate. Without this, a URL such as
 * "https://cloudflare-dns.com/dns-query" looks like a `dns.` namespace usage. */
function maskStringContents(src) {
  const chars = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { chars[j] = ' '; chars[j + 1] = ' '; j += 2; continue; }
        if (src[j] === quote) break;
        if (src[j] !== '\n') chars[j] = ' ';
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

function targets() {
  const list = [];
  const serverDir = path.join(ROOT, 'cloudflared', 'app', 'server');
  const libDir = path.join(serverDir, 'lib');
  list.push(path.join(serverDir, 'server.js'));
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) if (f.endsWith('.js')) list.push(path.join(libDir, f));
  }
  const wwwJs = path.join(ROOT, 'cloudflared', 'app', 'www', 'app.js');
  if (fs.existsSync(wwwJs)) list.push(wwwJs);
  return list.filter((f) => fs.existsSync(f));
}

let problems = 0;

for (const file of targets()) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  /* Bindings are read from `src` (require('fs') must stay visible); usage is
     scanned on a copy whose string contents are masked out. */
  const code = maskStringContents(src);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  /* Names bound by require(...) / import ... from '...' */
  const bound = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    bound.add(m[1]);
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) bound.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^.*\bas\s+/, '');
      if (t) bound.add(t);
    }
  }
  for (const m of src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    /* bare require('fs') without a binding still means the module is present,
       but it does not create a namespace identifier -- ignore. */
    void m;
  }

  const missing = [];
  for (const ns of NODE_NAMESPACES) {
    if (GLOBAL_NAMESPACES.has(ns)) continue;
    if (bound.has(ns)) continue;
    /* namespace-style usage: `ns.something` not preceded by an identifier char
       or a dot, and not part of a longer property chain. */
    const useRe = new RegExp(`(?<![\\w$.'"])${ns}\\s*\\.\\s*[A-Za-z_$]`);
    if (!useRe.test(code)) continue;
    /* A local variable of the same name also counts as bound. */
    const localRe = new RegExp(`\\b(?:const|let|var|function|class)\\s+${ns}\\b`);
    if (localRe.test(code)) continue;
    const paramRe = new RegExp(`\\(\\s*[^)]*\\b${ns}\\b[^)]*\\)\\s*(?:=>|\\{)`);
    if (paramRe.test(code)) continue;
    const line = code.slice(0, code.search(useRe)).split('\n').length;
    missing.push(`${ns} (line ${line})`);
  }

  if (missing.length) {
    problems += missing.length;
    console.log(`FAIL  ${rel}`);
    for (const m of missing) console.log(`        uses \`${m.split(' ')[0]}\` but never requires it -- ${m}`);
  } else {
    console.log(`ok    ${rel}`);
  }
}

if (problems) {
  console.log(`\n${problems} missing module binding(s). Add the require() before using the namespace.`);
  process.exit(1);
}
console.log('\nno missing module bindings');
