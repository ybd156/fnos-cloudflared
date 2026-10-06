#!/bin/bash
#
# Simulated-install test for the cloudflared fnOS lifecycle scripts.
#
# The .fpk cannot be installed without root, so this reproduces the layout the
# app centre creates under /var/apps/<appname>/ inside a scratch directory and
# drives every cmd/ script with the TRIM_* variables the app centre would set.
# It exercises the whole install -> start -> status -> config -> uninstall path
# for real, rather than only syntax-checking the scripts.
#
# Run it under setsid so that any process-group signal stays inside the test:
#
#   setsid ./tools/test-lifecycle.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/cloudflared"
SCRATCH="$ROOT/work/fakeinstall"
APPS="$SCRATCH/apps/cloudflared"

PASS=0
FAIL=0

ok() {
    printf '  \033[32mPASS\033[0m %s\n' "$*"
    PASS=$((PASS + 1))
}
bad() {
    printf '  \033[31mFAIL\033[0m %s\n' "$*"
    FAIL=$((FAIL + 1))
}
check() { # check <description> <expected> <actual>
    if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 (expected [$2], got [$3])"; fi
}
section() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# ------------------------------------------------------------------ environment
# Mirror what the app centre exports before invoking cmd/*.
export TRIM_APPNAME=cloudflared
export TRIM_APPDEST="$APPS/target"
export TRIM_PKGVAR="$SCRATCH/var"
export TRIM_PKGTMP="$SCRATCH/tmp"
export TRIM_PKGETC="$SCRATCH/etc"
export TRIM_PKGHOME="$SCRATCH/home"
export TRIM_APPDEST_VOL="$SCRATCH"
export TRIM_TEMP_LOGFILE="$SCRATCH/install.log"
export TRIM_SERVICE_PORT=0

setup_install_root() {
    rm -rf "$SCRATCH"
    mkdir -p "$APPS" "$TRIM_PKGVAR" "$TRIM_PKGTMP" "$TRIM_PKGETC" "$TRIM_PKGHOME"
    cp -a "$SRC/app" "$APPS/target"
    cp -a "$SRC/cmd" "$APPS/cmd"
    cp -a "$SRC/config" "$APPS/config"
    cp -a "$SRC/wizard" "$APPS/wizard"
    cp "$SRC/manifest" "$APPS/manifest"
    : >"$TRIM_TEMP_LOGFILE"
}

CMD="$APPS/cmd"
run() {
    local script="$1"
    shift
    bash "$CMD/$script" "$@"
}

# node is NOT on PATH on fnOS -- dependency apps are not added to it, which is
# exactly why cmd/_lib probes the well-known install locations. Calling bare
# `node` here made every node_eval step fail on the one host this suite is
# written for (the NAS). Reuse _lib's find_node so the candidate list has a
# single owner instead of a second copy drifting out of sync.
. "$SRC/cmd/_lib"
NODE="$(find_node)" || {
    echo "FATAL: no node runtime found; this suite needs one (see cmd/_lib find_node)" >&2
    exit 1
}
echo "node   : $NODE"

node_eval() { "$NODE" -e "$1"; }

cleanup() {
    bash "$CMD/main" stop >/dev/null 2>&1
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ------------------------------------------------------------------- the tests
setup_install_root

section "install_init"
run install_init
check "install_init exit code" 0 $?

section "install_callback with wizard_auto_start=true"
export wizard_auto_start=true
run install_callback
check "install_callback exit code" 0 $?
[ -f "$TRIM_PKGVAR/VERSION" ] && ok "VERSION written" || bad "VERSION missing"
[ -d "$TRIM_PKGVAR/.cloudflared" ] && ok "credential dir created" || bad "credential dir missing"
check "credential dir mode" 700 "$(stat -c %a "$TRIM_PKGVAR/.cloudflared" 2>/dev/null)"
[ -x "$APPS/target/bin/cloudflared" ] && ok "cloudflared is executable" || bad "cloudflared not executable"
[ -f "$TRIM_PKGVAR/config.json" ] && ok "config.json created via config_callback" || bad "config.json missing"

section "main status before start"
run main status
check "status reports not-running" 3 $?

section "main start"
run main start
check "start exit code" 0 $?
[ -S "$TRIM_APPDEST/app.sock" ] && ok "app.sock created" || bad "app.sock missing"
check "app.sock mode" 660 "$(stat -c %a "$TRIM_APPDEST/app.sock" 2>/dev/null)"
check "pid file mode" 644 "$(stat -c %a "$TRIM_PKGVAR/server.pid" 2>/dev/null)"

section "main status after start"
run main status
check "status reports running" 0 $?

section "main start is idempotent"
BEFORE="$(cat "$TRIM_PKGVAR/server.pid")"
run main start
check "second start exit code" 0 $?
check "same process kept" "$BEFORE" "$(cat "$TRIM_PKGVAR/server.pid")"

section "gateway API over the unix socket"
META="$(curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" http://localhost/api/meta)"
if printf '%s' "$META" | grep -q '"app":"cloudflared"'; then
    ok "GET /api/meta answered"
    printf '       %s\n' "$META"
else
    bad "GET /api/meta returned: $META"
fi

section "gateway prefix handling"
PREFIXED="$(curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" http://localhost/app/cloudflared/ | grep -o '__CF_BASE__ = "[^"]*"')"
check "prefixed request injects prefix" '__CF_BASE__ = "/app/cloudflared"' "$PREFIXED"
ROOTED="$(curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" http://localhost/ | grep -o '__CF_BASE__ = "[^"]*"')"
check "unprefixed request injects empty" '__CF_BASE__ = ""' "$ROOTED"

section "main restart"
run main restart
check "restart exit code" 0 $?
run main status
check "status running after restart" 0 $?

section "config_callback merges without losing tunnels or tokens"
node_eval '
const fs = require("fs");
const p = process.env.TRIM_PKGVAR + "/config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.tunnels = [{ id: "keepme", name: "Keep Me", type: "token", token: "secret-token", enabled: true }];
c.settings = c.settings || {};
c.settings.logLevel = "info";
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
export wizard_log_level=debug wizard_protocol=http2 wizard_auto_start=false wizard_auto_restart=false
run config_callback
check "config_callback exit code" 0 $?
MERGED="$(node_eval '
const c = require(process.env.TRIM_PKGVAR + "/config.json");
console.log([c.settings.logLevel, c.settings.protocol, c.settings.autoStart, c.settings.autoRestart,
  c.tunnels.length, c.tunnels[0].id, c.tunnels[0].token].join("|"));
')"
check "settings merged, tunnel + token preserved" \
    "debug|http2|false|false|1|keepme|secret-token" "$MERGED"
check "config.json mode" 600 "$(stat -c %a "$TRIM_PKGVAR/config.json" 2>/dev/null)"

section "config_callback rejects out-of-enum values"
node_eval '
const fs = require("fs");
const p = process.env.TRIM_PKGVAR + "/config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.settings.logLevel = "debug";
fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
export wizard_log_level="../../etc/passwd" wizard_protocol="bogus"
run config_callback
check "config_callback exit code" 0 $?
REJECTED="$(node_eval '
const c = require(process.env.TRIM_PKGVAR + "/config.json");
console.log(c.settings.logLevel + "|" + c.settings.protocol);
')"
check "invalid values ignored, previous kept" "debug|http2" "$REJECTED"
unset wizard_log_level wizard_protocol

section "a token tunnel keeps the token out of the process command line"
# A token passed as an argv flag would be readable by any local user through
# /proc/<pid>/cmdline, so the server must hand it over via TUNNEL_TOKEN.
TOKEN="$(node_eval '
console.log(Buffer.from(JSON.stringify({
  a: "00000000000000000000000000000000",
  t: "00000000-0000-0000-0000-000000000000",
  s: "SECRETTOKENMARKER",
})).toString("base64"));
')"
CREATED="$(curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"argv-test\",\"type\":\"token\",\"token\":\"$TOKEN\"}" \
    http://localhost/api/tunnels)"
TID="$(printf '%s' "$CREATED" | node_eval '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try { console.log(JSON.parse(s).tunnel.id); } catch (e) { console.log(""); }
});
')"
if [ -n "$TID" ]; then ok "token tunnel created ($TID)"; else bad "could not create tunnel: $CREATED"; fi

# autoStart 默认开启：创建响应里就该是 starting，而不是 stopped（否则用户保存后
# 看到「已停止」，会以为没生效）。
case "$CREATED" in
*'"status":"starting"'*) ok "auto-start: tunnel starts immediately on create" ;;
*) bad "created tunnel did not auto-start: $CREATED" ;;
esac

LIST="$(curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" http://localhost/api/tunnels)"
case "$LIST" in
*"$TOKEN"*) bad "the raw token is returned by the list API" ;;
*) ok "list API returns no token plaintext" ;;
esac
case "$LIST" in
*'"hasToken":true'*) ok "list API reports hasToken" ;;
*) bad "list API did not report hasToken: $LIST" ;;
esac

curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" \
    -X POST "http://localhost/api/tunnels/$TID/start" >/dev/null

# cloudflared may exit quickly with a bogus token, so sample the process as soon
# as it appears rather than after a fixed sleep.
CFPID=""
CMDLINE=""
ENVIRON=""
for _ in $(seq 1 50); do
    # 只认本测试自己起的进程：安装目录前缀必须落在 fakeinstall 下。
    # 真机上用户的 cloudflared（/vol1/@appcenter/...）也在跑，按名字抓会抓错。
    CFPID="$(ps -eo pid=,args= | awk -v d="$TRIM_APPDEST" '$0 ~ d && /bin\/cloudflared/ {print $1}' | head -1)"
    if [ -n "$CFPID" ]; then
        CMDLINE="$(tr '\0' ' ' <"/proc/$CFPID/cmdline" 2>/dev/null)"
        ENVIRON="$(tr '\0' '\n' <"/proc/$CFPID/environ" 2>/dev/null)"
        [ -n "$CMDLINE" ] && break
    fi
    sleep 0.1
done

if [ -n "$CFPID" ]; then
    ok "captured the cloudflared process (pid $CFPID)"
    case "$CMDLINE" in
    *SECRETTOKENMARKER*) bad "token is visible in argv: $CMDLINE" ;;
    *) ok "argv is token-free: ${CMDLINE#*cloudflared }" ;;
    esac
    if printf '%s' "$ENVIRON" | grep -q "^TUNNEL_TOKEN=$TOKEN$"; then
        ok "token delivered through the TUNNEL_TOKEN environment variable"
    else
        bad "TUNNEL_TOKEN not found in the child environment"
    fi
else
    bad "no cloudflared process appeared"
fi

curl -s --max-time 5 --unix-socket "$TRIM_APPDEST/app.sock" \
    -X DELETE "http://localhost/api/tunnels/$TID" >/dev/null

section "main stop"
run main stop
check "stop exit code" 0 $?
run main status
check "status reports not-running" 3 $?
[ -S "$TRIM_APPDEST/app.sock" ] && bad "app.sock left behind" || ok "app.sock removed"

section "uninstall keeping data (wizard_remove_data=false)"
run uninstall_init
check "uninstall_init exit code" 0 $?
export wizard_remove_data=false
run uninstall_callback
check "uninstall_callback exit code" 0 $?
[ -f "$TRIM_PKGVAR/config.json" ] && ok "config.json preserved" || bad "config.json was deleted"
[ -d "$TRIM_PKGVAR/.cloudflared" ] && ok "credentials preserved" || bad "credentials were deleted"

section "uninstall removing data (wizard_remove_data=true)"
export wizard_remove_data=true
run uninstall_callback
check "uninstall_callback exit code" 0 $?
[ -f "$TRIM_PKGVAR/config.json" ] && bad "config.json still present" || ok "config.json removed"
[ -d "$TRIM_PKGVAR/.cloudflared" ] && bad "credentials still present" || ok "credentials removed"

section "start fails loudly when the payload is missing"
setup_install_root
export TRIM_APPDEST="$SCRATCH/empty-target"
mkdir -p "$TRIM_APPDEST"
run main start
RC=$?
if [ "$RC" -ne 0 ]; then ok "start fails without server.js (rc=$RC)"; else bad "start succeeded without server.js"; fi
if grep -q '应用文件缺失' "$TRIM_TEMP_LOGFILE" 2>/dev/null; then
    ok "error surfaced through TRIM_TEMP_LOGFILE"
else
    bad "TRIM_TEMP_LOGFILE did not get the error: $(cat "$TRIM_TEMP_LOGFILE" 2>/dev/null)"
fi
run main status
check "status reports not-running after failure" 3 $?

# ------------------------------------------------------------------- teardown
trap - EXIT
cleanup

printf '\n\033[1m%s passed, %s failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
