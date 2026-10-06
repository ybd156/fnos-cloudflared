#!/bin/bash
#
# Build the Cloudflare Tunnel .fpk package for fnOS.
#
#   ./build.sh              regenerate icons, validate, then pack
#   ./build.sh --no-icons   skip icon regeneration
#
# Requires the official `fnpack` utility (https://developer.fnnas.com/docs/cli/fnpack).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$ROOT/cloudflared"
DIST="$ROOT/dist"
FNPACK="${FNPACK:-fnpack}"
SKIP_ICONS=0

for arg in "$@"; do
    case "$arg" in
    --no-icons) SKIP_ICONS=1 ;;
    -h | --help)
        sed -n '2,10p' "$0"
        exit 0
        ;;
    *)
        echo "unknown option: $arg" >&2
        exit 2
        ;;
    esac
done

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- prerequisites
[ -d "$PROJECT" ] || die "application source directory not found: $PROJECT"
command -v "$FNPACK" >/dev/null 2>&1 || die "fnpack not found in PATH (set FNPACK=/path/to/fnpack)"

# Python is used by the icon generator and both artefact tools. Resolve it once.
PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || die "python3 (or python) not found in PATH"

# Node is used by the lints and the syntax check. Resolve it once: probing it
# separately in three places meant the syntax check could still run bare `node`
# on a host where the earlier two steps had already reported it missing.
NODE=node
if ! command -v "$NODE" >/dev/null 2>&1; then
    if [ -n "${TRIM_NODE_BIN:-}" ] && [ -x "${TRIM_NODE_BIN}" ]; then
        NODE="$TRIM_NODE_BIN"
    else
        NODE=""
    fi
fi

# ------------------------------------------------------------------- binary
# The 38MB cloudflared binary is not tracked in git (see .gitignore): it is an
# upstream build that nobody here edits, and committing it would put it into
# every clone and into the permanent history. Fetch the pinned release instead,
# verifying its SHA-256. --force is not used, so a correct local copy is kept.
step "Ensuring the cloudflared binary"
"$PY" "$ROOT/tools/fetch-cloudflared.py" || die "could not obtain the pinned cloudflared binary"

# ------------------------------------------------------------------- icons
if [ "$SKIP_ICONS" -eq 0 ]; then
    step "Generating icons"
    "$PY" "$ROOT/tools/make-icons.py" || die "icon generation failed"
else
    step "Skipping icon generation"
fi

# --------------------------------------------------------------- permissions
# This filesystem can present freshly created files as mode 0000, and the .fpk
# archive does not reliably preserve permission bits anyway. Normalise
# everything so the packaged tree is readable and the executables are runnable.
step "Normalising permissions"
find "$PROJECT" -type d -exec chmod 755 {} +
find "$PROJECT" -type f -exec chmod 644 {} +
chmod 755 "$PROJECT"/cmd/*
chmod 755 "$PROJECT/app/bin/cloudflared"
chmod 755 "$PROJECT/app/ui/images" "$PROJECT/app/www/images"
find "$PROJECT" -name '*.png' -exec chmod 644 {} +

# ---------------------------------------------------------------- validation
step "Validating shell scripts"
for script in "$PROJECT"/cmd/*; do
    bash -n "$script" || die "syntax error in $(basename "$script")"
done
echo "  $(ls -1 "$PROJECT"/cmd | wc -l) lifecycle scripts OK"

# A Node module namespace used without require() is invisible to `node --check`
# and only fails at runtime, in the one code path that touches it. That is how
# 1.3.0 shipped `fs` missing from paths.js (data dirs never created) and `path`
# missing from dns.js (every DNS route check threw).
step "Validating backend module bindings"
if [ -n "$NODE" ]; then
    "$NODE" "$ROOT/tools/lint-requires.mjs" || die "a backend module uses a namespace it never requires"
else
    echo "  ! node not found, skipping module binding lint"
fi

# A selector that points at an element which does not exist fails silently: the
# handler binds to nothing, the control stops working, and no error surfaces
# anywhere. Nothing else in the pipeline can see that, so check it explicitly.
step "Validating UI selectors"
if [ -n "$NODE" ]; then
    "$NODE" "$ROOT/tools/lint-ui.mjs" || die "the web UI references a selector that does not resolve"
else
    echo "  ! node not found, skipping UI selector lint"
fi

# A shell edit is otherwise reviewed by eye only: on Windows there is no bash to
# run it, and the mistakes that matter (an unbound ${TRIM_X} under `set -u`, a
# bare `node` that is absent on the NAS, an unbalanced quote) are invisible to
# inspection. This is a textual check, not a substitute for the NAS suite.
step "Validating shell scripts (static)"
if [ -n "$NODE" ]; then
    "$NODE" "$ROOT/tools/lint-shell.mjs" || die "a lifecycle script has a static defect"
else
    echo "  ! node not found, skipping static shell lint"
fi

step "Validating JavaScript syntax"
if [ -z "$NODE" ]; then
    # Previously this ran bare `node` even after the two steps above had
    # explicitly handled its absence, so the build died here with
    # "node: command not found" on exactly the host the guards were for.
    die "node not found: cannot syntax-check the JavaScript (install node or set TRIM_NODE_BIN)"
fi
for js in "$PROJECT"/app/server/server.js "$PROJECT"/app/server/lib/*.js "$PROJECT"/app/www/app.js; do
    "$NODE" --check "$js" || die "syntax error in $js"
done
echo "  backend + frontend JavaScript OK"

step "Validating JSON files"
"$PY" "$ROOT/tools/validate-json.py" \
    "$PROJECT"/config/privilege "$PROJECT"/config/resource \
    "$PROJECT"/app/ui/config "$PROJECT"/wizard/* ||
    die "invalid JSON in config/privilege, config/resource, app/ui/config or wizard/"

step "Checking required files"
for required in manifest ICON.PNG ICON_256.PNG config/privilege config/resource \
    app/ui/config app/bin/cloudflared app/server/server.js app/www/index.html; do
    [ -e "$PROJECT/$required" ] || die "missing required file: $required"
done
echo "  all required files present"

# ------------------------------------------------------------------- packing
step "Packing with $FNPACK"
mkdir -p "$DIST"
rm -f "$DIST/cloudflared.fpk"
cd "$DIST"
"$FNPACK" build -d "$PROJECT"

FPK="$DIST/cloudflared.fpk"
[ -f "$FPK" ] || die "expected $FPK was not produced"

# fnpack takes archive modes from the host filesystem's stat(). On Linux the
# chmod above has already applied them, but on Windows there is no executable
# bit at all: every file lands as 0666 and every directory as 0777, so
# `cmd/main` and `app/bin/cloudflared` reach the NAS non-executable and the app
# cannot start. Rewrite the modes to the Linux-correct values in both tar
# layers; this also repairs the manifest checksum, which records the MD5 of the
# rewritten app.tgz.
step "Normalising archive permissions"
"$PY" "$ROOT/tools/normalize-fpk.py" "$FPK" || die "archive permission normalisation failed"

# fnpack writes the archive with whatever umask the volume reports, and this
# filesystem presents new files as mode 0000, which would leave the artefact
# unreadable. Make sure the result can actually be copied out.
chmod 755 "$DIST"
chmod 644 "$FPK"

# `fnpack build` reports success as long as the required files exist -- it does
# not check that the archive matches the source tree, so a build from a stale
# tree (or a missing permission fix) still prints "Packing successfully".
# Re-open the artefact and assert what it actually contains before shipping it.
step "Verifying packaged artefact"
"$PY" "$ROOT/tools/verify-fpk.py" "$FPK" "$PROJECT" || die "packaged artefact failed verification"

step "Result"
printf '  %s\n' "$FPK"
printf '  size    : %s bytes (%s)\n' "$(stat -c %s "$FPK")" "$(du -h "$FPK" | cut -f1)"
printf '  sha256  : %s\n' "$(sha256sum "$FPK" | cut -d' ' -f1)"
printf '  manifest checksum: %s\n' "$(tar -xzOf "$FPK" manifest 2>/dev/null | grep -i '^checksum' || echo '(none)')"
