/* Static checks for the fnOS shell scripts.
 *
 * Why this exists: the lifecycle scripts and build.sh run on the NAS, where no
 * developer can iterate quickly -- and on a Windows host there is no way to run
 * them at all (no bash; the bundled minGit sh.exe cannot start under the
 * sandbox because it needs a signal pipe). A shell edit therefore used to ship
 * on inspection alone, and the mistakes a shell edit actually makes are all
 * invisible to the eye:
 *
 *   * an unbound variable under `set -u` (the script dies in the App Center's
 *     environment but works in the author's shell, where the var happens to be
 *     exported);
 *   * a variable used before it is defined;
 *   * an unbalanced quote, which silently swallows the rest of the file;
 *   * a bare `node`/`python` on a host where neither is on PATH -- exactly the
 *     situation cmd/_lib exists to work around.
 *
 * These are textual checks, not a substitute for running the suite on the NAS.
 * They catch the class of error that inspection misses, and they are cheap.
 *
 * Usage: node tools/lint-shell.mjs
 * Exit:  0 all checks passed, 1 at least one failed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const failures = [];
function ck(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(detail ? `${label} (${detail})` : label);
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const CMD_SCRIPTS = [
  'cloudflared/cmd/_lib',
  'cloudflared/cmd/main',
  'cloudflared/cmd/install_init',
  'cloudflared/cmd/install_callback',
  'cloudflared/cmd/config_init',
  'cloudflared/cmd/config_callback',
  'cloudflared/cmd/uninstall_init',
  'cloudflared/cmd/uninstall_callback',
  'cloudflared/cmd/upgrade_init',
  'cloudflared/cmd/upgrade_callback',
];
const ALL_SCRIPTS = [...CMD_SCRIPTS, 'build.sh', 'tools/test-lifecycle.sh'];

/* Every script the app centre runs must be present; a missing one is a package
 * that fails at install time, not at review time. */
console.log('\n[0] 生命周期脚本齐备');
for (const f of CMD_SCRIPTS) {
  ck(fs.existsSync(path.join(ROOT, f)), `${path.basename(f)} 存在`);
}

console.log('\n[1] 引号与 ${} 展开配平');
for (const f of ALL_SCRIPTS) {
  const t = read(f);
  /* Strip comments so an apostrophe in prose is not counted as a quote. */
  const code = t.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const singles = (code.match(/'/g) || []).length;
  const doubles = (code.match(/"/g) || []).length;
  ck(singles % 2 === 0, `${f}: 单引号成对`, `count=${singles}`);
  ck(doubles % 2 === 0, `${f}: 双引号成对`, `count=${doubles}`);
  const open = (code.match(/\$\{/g) || []).length;
  const close = (code.match(/\}/g) || []).length;
  ck(open <= close, `${f}: \${} 展开配平`, `open=${open} close=${close}`);
}

console.log('\n[2] set -u 安全：裸用 ${TRIM_X} 必须有 :- 默认值或同变量守卫');
{
  /* Under `set -u` a bare ${TRIM_X} aborts the script when the variable is
   * unset. The safe patterns are a `:-` default, or a preceding guard
   * `[ -n "${TRIM_X:-}" ]`. Anything else is a latent abort in the one
   * environment these scripts actually run in. */
  const unsafe = [];
  for (const f of CMD_SCRIPTS) {
    const lines = read(f).split('\n');
    let openGuard = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const guard = line.match(/\[\s+-n\s+"\$\{(TRIM_[A-Z_]+):-\}"\s*\]/);
      if (guard) openGuard = guard[1];
      if (/^\s*(fi|esac|done)\b/.test(line)) openGuard = null;
      for (const m of line.matchAll(/\$\{(TRIM_[A-Z_]+)\}/g)) {
        if (m[1] !== openGuard) unsafe.push(`${f}:${i + 1} ${m[1]}`);
      }
    }
  }
  ck(unsafe.length === 0, '所有裸用 ${TRIM_X} 都处于 :- 默认值或同变量守卫内', unsafe.join('; '));
}

console.log('\n[3] 不依赖 PATH 上的 node/python');
{
  /* cmd/_lib probes absolute paths precisely because dependency apps are not
   * added to PATH on fnOS. A bare `node` here works on a dev box and fails on
   * the NAS, which is the worst possible failure mode. */
  const offenders = [];
  for (const f of CMD_SCRIPTS) {
    /* _lib is where the absolute-path probing lives, so its own final
     * `command -v node` fallback is the mechanism, not a violation. */
    if (f.endsWith('/_lib')) continue;
    read(f).split('\n').forEach((line, i) => {
      if (/(^|\s)(node|python3?|npm|pnpm)\s/.test(line) && !/#/.test(line)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  ck(offenders.length === 0, 'cmd/* 不裸调 node/python（必须走 find_node / 绝对路径）', offenders.join('; '));

  /* find_node must still probe absolute paths BEFORE falling back to PATH:
   * reordering it would silently reintroduce the PATH dependency. */
  const lib = read('cloudflared/cmd/_lib');
  const firstAbs = lib.search(/\/var\/apps\/nodejs_v\d+/);
  const pathFallback = lib.search(/command -v node/);
  ck(firstAbs > 0 && pathFallback > firstAbs,
     '_lib: find_node 先探测绝对路径，最后才回退 PATH');

  const t = read('tools/test-lifecycle.sh');
  ck(!/^node_eval\(\) \{ node -e/m.test(t), 'test-lifecycle.sh: node_eval 不裸调 node');
  ck(/\. "\$SRC\/cmd\/_lib"/.test(t), 'test-lifecycle.sh: source 了 cmd/_lib');
  ck(/NODE="\$\(find_node\)"/.test(t), 'test-lifecycle.sh: 通过 find_node 解析 node');
  ck(/node_eval\(\) \{ "\$NODE" -e "\$1"; \}/.test(t), 'test-lifecycle.sh: node_eval 使用解析到的 $NODE');
  const dupes = [...t.matchAll(/\/var\/apps\/nodejs_v\d+/g)];
  ck(dupes.length === 0, 'test-lifecycle.sh: 没有复制 _lib 的候选路径列表', `found ${dupes.length}`);
  ck(t.indexOf('NODE="$(find_node)"') < t.indexOf('node_eval()'), 'test-lifecycle.sh: find_node 解析早于使用');
}

console.log('\n[4] build.sh：node 只解析一次，语法检查不再裸调');
{
  const t = read('build.sh');
  const bareNode = [...t.matchAll(/^\s*node\s/gm)];
  ck(bareNode.length === 0, '没有裸调 node 的命令行', `found ${bareNode.length}`);
  ck(/NODE=node/.test(t), 'NODE 默认解析为 node');
  ck(/command -v "\$NODE"/.test(t), '用 command -v 探测 $NODE');
  const invocations = [...t.matchAll(/"\$NODE"/g)].length;
  ck(invocations >= 3, '所有 node 调用都走 "$NODE"', `invocations=${invocations}`);
  /* The syntax check must fail loudly when node is absent: silently skipping it
   * is how a syntax error reaches the NAS. */
  const syntaxStep = t.slice(t.indexOf('Validating JavaScript syntax'));
  ck(syntaxStep.length > 0, '存在 JavaScript 语法检查步骤');
  ck(/if \[ -z "\$NODE" \]/.test(syntaxStep), '语法检查在 node 缺失时明确报错');
  ck(/die "node not found/.test(syntaxStep), '报错信息说明缺少 node');
  ck(/^set -euo pipefail/m.test(t), 'set -euo pipefail 保留');
  ck(t.indexOf('die()') < t.indexOf('die "'), 'die 定义早于首次使用');
  ck(/\$PY/.test(t), 'python 仍通过 $PY 调用');
  ck(/bash -n/.test(t), 'build.sh 仍对 cmd/* 做 bash -n 语法检查');
}

console.log('\n[5] uninstall_callback：删除数据时清理所有残留');
{
  const t = read('cloudflared/cmd/uninstall_callback');
  /* server.log rotates to server.log.1 (up to MAX_APP_LOG_BYTES = 2MB); the
   * version markers are rewritten on reinstall. Leaving them contradicts the
   * "delete my data" choice in the uninstall wizard. */
  for (const target of ['server.log.1', 'main.log.1', 'VERSION', 'cloudflared.version']) {
    ck(t.includes(target), `清理列表包含 ${target}`);
  }
  ck(/\$\{PKGVAR\}"\/\*\.log/.test(t), '通配删除限定在 ${PKGVAR} 内');
  ck(/rm -f "\$\{PKGVAR\}"\/\*\.log/.test(t), '通配删除使用 rm -f（无匹配时不报错）');
  ck(/wizard_remove_data/.test(t), '仍然由向导选项决定是否删除');
}

console.log('\n[6] config_callback：读-改-写，只合并 settings');
{
  const t = read('cloudflared/cmd/config_callback');
  ck(/readFileSync/.test(t), '读取现有 config.json');
  ck(/writeFileSync/.test(t), '写回 config.json');
  ck(!/cfg\.tunnels\s*=/.test(t), '不覆盖 tunnels 字段');
  ck(/chmodSync\(file, 0o600\)/.test(t), '写回后恢复 0600');
}

console.log('\n[7] 生命周期脚本的退出码契约');
{
  for (const f of CMD_SCRIPTS) {
    const t = read(f);
    /* _lib is SOURCED, never executed: a TOP-LEVEL `exit` would terminate
     * whichever script sourced it, at the moment of sourcing. The `exit 1`
     * inside fail() is deliberate -- that function exists to abort the caller
     * with a message the App Center shows. So only flag an unindented exit. */
    if (f.endsWith('/_lib')) {
      const topLevelExit = t.split('\n').filter((l) => /^exit\s+\d/.test(l));
      ck(topLevelExit.length === 0, '_lib: 没有顶层 exit（它只被 source）', topLevelExit.join('; '));
      ck(/^fail\(\)/m.test(t) && /^\s+exit 1/m.test(t), '_lib: fail() 内部保留 exit 1（用于中止调用方）');
      continue;
    }
    ck(/^set -u/m.test(t), `${path.basename(f)}: set -u`);
    /* A script that falls off the end returns the status of its last command,
     * which may be a failed test -- so every script must end explicitly. */
    ck(/exit\s+\d/.test(t), `${path.basename(f)}: 显式 exit`);
  }
}

console.log(`\n${failures.length ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
