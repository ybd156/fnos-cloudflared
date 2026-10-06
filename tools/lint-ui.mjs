/*
 * Lint: the web UI's selector contract.
 *
 * The UI is plain DOM scripting with no build step, so nothing catches a
 * selector that points at an element which does not exist. A typo there fails
 * silently: the handler is attached to null (or to nothing), the button simply
 * does nothing, and no error is reported anywhere. That is the same class of
 * silent breakage as the missing require() calls this project already shipped.
 *
 * Three checks, each of which corresponds to a real way the UI can go dead:
 *
 *   1. Every '#id' app.js looks up must exist -- either in index.html or in the
 *      markup app.js generates itself (the modal body is built at runtime).
 *   2. Every static class token used in markup must have a rule in style.css,
 *      otherwise the intended styling silently does not apply.
 *   3. Every id in index.html must be unique.
 *
 * Run: node tools/lint-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WWW = path.join(ROOT, 'cloudflared', 'app', 'www');

const appJs = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(WWW, 'style.css'), 'utf8');

let problems = 0;
function fail(msg) {
  problems += 1;
  console.log(`FAIL  ${msg}`);
}

/* ── 1. ids ──────────────────────────────────────────────────────────────── */

function idsIn(html) {
  const out = new Set();
  for (const m of html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) out.add(m[1]);
  return out;
}

const htmlIds = idsIn(indexHtml);

/* Duplicate ids in index.html: getElementById returns the first, so the second
   element is unreachable and any handler bound to it is bound to the wrong node. */
const seen = new Map();
for (const m of indexHtml.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) {
  seen.set(m[1], (seen.get(m[1]) || 0) + 1);
}
for (const [id, n] of seen) if (n > 1) fail(`index.html 中 id="${id}" 出现了 ${n} 次（必须唯一）`);

/* ids app.js itself renders into the DOM. Only the modal body and the tunnel
   list are built at runtime, so scanning the whole file is close enough -- an
   id string that appears anywhere in app.js is available by the time it is
   queried, and a false negative here would only ever hide a genuine typo if the
   same id happened to appear in unrelated text. */
const jsGeneratedIds = idsIn(appJs);

/* Only '#id' lookups that app.js performs directly. */
const referenced = new Set();
for (const m of appJs.matchAll(/\$\(\s*'#([A-Za-z][\w-]*)'\s*\)/g)) referenced.add(m[1]);
for (const m of appJs.matchAll(/getElementById\(\s*'([A-Za-z][\w-]*)'\s*\)/g)) referenced.add(m[1]);

const unknown = [...referenced].filter((id) => !htmlIds.has(id) && !jsGeneratedIds.has(id)).sort();
for (const id of unknown) fail(`app.js 查询了 #${id}，但 index.html 和 app.js 生成的标记里都没有这个 id`);

/* ── 2. classes ──────────────────────────────────────────────────────────── */

/* Class tokens that can appear at runtime. Anything inside a ${...}
   interpolation is skipped, because its concrete value is not knowable here
   (e.g. class="status ${status}" and class="tunnel-card is-${status}"). The
   values those produce are listed explicitly below and checked too. */
const DYNAMIC_VALUES = [
  'running', 'starting', 'stopping', 'stopped', 'error',
  'is-running', 'is-starting', 'is-stopping', 'is-stopped', 'is-error',
  'ok', 'err', 'info', 'warn',
];

function staticClassTokens(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bclass="([^"]*)"/g)) {
    const raw = m[1];
    /* `class="tunnel-card is-${status}"` splits into the literal parts
       `tunnel-card` and `is-`. The trailing `-` marks a prefix that is
       completed by the interpolation, so it is not a class name of its own --
       the concrete values are covered by DYNAMIC_VALUES below. */
    const withoutExpr = raw.replace(/\$\{[^}]*\}/g, ' ');
    for (const t of withoutExpr.split(/\s+/)) {
      if (t && !t.endsWith('-')) out.add(t);
    }
  }
  return out;
}

const usedClasses = new Set([
  ...staticClassTokens(indexHtml),
  ...staticClassTokens(appJs),
  ...DYNAMIC_VALUES,
]);

/* A class is "styled" if it appears anywhere in the stylesheet as a selector.
   Comments are stripped first so a class named only in prose does not count. */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const styledClasses = new Set();
for (const m of cssNoComments.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) styledClasses.add(m[1]);

const unstyled = [...usedClasses].filter((c) => !styledClasses.has(c)).sort();
for (const c of unstyled) fail(`标记里用了 .${c}，但 style.css 里没有对应规则（样式不会生效）`);

/* ── 3. JS-only classes that the JS toggles but CSS never defines ─────────── */

/* classList.add/remove/toggle with a literal name: those names must be styled,
   or the state change is invisible. `hidden` is defined. */
for (const m of appJs.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([\w-]+)'/g)) {
  if (!styledClasses.has(m[1])) fail(`app.js 切换了 .${m[1]}，但 style.css 里没有这条规则`);
}

/* ── report ──────────────────────────────────────────────────────────────── */

if (problems) {
  console.log(`\n${problems} 个 UI 选择器问题。`);
  process.exit(1);
}
console.log(`ok    index.html ${htmlIds.size} 个 id，${usedClasses.size} 个类均有样式，选择器全部可解析`);
console.log('\nno unresolved UI selectors');
