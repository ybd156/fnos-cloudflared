#!/usr/bin/env python3
"""Verify a built .fpk against the source tree it was packed from.

`fnpack build` prints "Packing successfully" for a package that is missing
every fix, because it only checks that required files exist -- not that the
archive contains what the source tree currently says. This gate re-opens the
artefact and asserts the things a bad build actually gets wrong:

  * container shape (gzip tar, both layers, required entries, 10 cmd/ scripts)
  * manifest version and the `checksum = md5(app.tgz)` invariant
  * the packaged manifest is byte-identical to the source manifest, and its
    version matches the changelog head
  * every authored file in the package is byte-identical to its source file
    (the whole tree, discovered by walking it -- not a hand-maintained list)
  * permission bits: cmd/* and bin/cloudflared executable, nothing 0666/0777
    (a Windows-hosted fnpack build otherwise ships non-executable scripts)
  * the specific regression probes for the bugs fixed in 1.3.1, 1.4.0 and 1.4.1

Usage: verify-fpk.py <path-to.fpk> [source-dir]
Exit:  0 all checks passed, 1 at least one check failed, 2 usage error.
"""

import hashlib
import io
import os
import re
import sys
import tarfile

DEFAULT_SRC = "cloudflared"

# outer: path -> expected mode. cmd/* and the bundled binary must be runnable.
OUTER_REQUIRED = [
    "app.tgz", "manifest", "ICON.PNG", "ICON_256.PNG",
    "config/privilege", "config/resource",
    "wizard/install", "wizard/config", "wizard/uninstall", "wizard/upgrade",
]
APP_REQUIRED = [
    "server/server.js", "www/index.html", "www/app.js", "www/style.css",
    "ui/config", "bin/cloudflared", "config/privilege", "config/resource",
]
# Paths in the source tree that are NOT compared byte-for-byte: the 40MB bundled
# binary (checked separately for ELF magic and size) and the manifest (fnpack
# realigns it and appends the checksum, so it is compared field-by-field above).
NOT_AUTHORED = {
    "app/bin/cloudflared",
    "manifest",
}


def read_binary_pin(src):
    """Read (VERSION, SHA256) from tools/fetch-cloudflared.py.

    Returns (None, None) if the file or either constant is missing, so the
    caller reports a failure instead of silently skipping the comparison.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(src)), "tools", "fetch-cloudflared.py")
    if not os.path.isfile(path):
        path = os.path.join("tools", "fetch-cloudflared.py")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None, None
    ver = re.search(r'^VERSION\s*=\s*"([^"]+)"', text, re.M)
    sha = re.search(r'^SHA256\s*=\s*"([0-9a-f]{64})"', text, re.M)
    if not ver or not sha:
        return None, None
    return ver.group(1), sha.group(1)


def discover_authored(src):
    """Walk the source tree and return [(path-inside-app.tgz, source-path)].

    This used to be a hand-maintained list of 13 files, which meant the files
    fnOS actually executes and renders -- all 10 cmd/* lifecycle scripts, the 4
    wizard/* descriptors, config/privilege, config/resource, both icons and the
    manifest -- were never compared. A stale lifecycle script shipped with a
    green gate. Discovering the tree means a new file is covered by default
    instead of being silently omitted.
    """
    pairs = []
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            if rel in NOT_AUTHORED:
                continue
            # The packer puts cmd/, wizard/, config/, manifest, ICON*.PNG at the
            # outer level; everything under app/ goes inside app.tgz.
            if rel.startswith("app/"):
                pairs.append((rel[len("app/"):], full))
            else:
                pairs.append((rel, full))
    return pairs


class Checker:
    def __init__(self):
        self.failures = []
        self.passed = 0

    def ck(self, cond, label, detail=""):
        if cond:
            self.passed += 1
        else:
            self.failures.append(label if not detail else f"{label} ({detail})")

    def section(self, title):
        print(f"\n=== {title} ===")


def want_outer_mode(name, isdir):
    if isdir:
        return 0o755
    if name.startswith("cmd/"):
        return 0o755
    return 0o644


def want_app_mode(name, isdir):
    if isdir:
        return 0o755
    if name == "bin/cloudflared":
        return 0o755
    return 0o644


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    fpk = sys.argv[1]
    src = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SRC

    if not os.path.isfile(fpk):
        print(f"verify-fpk: not a file: {fpk}", file=sys.stderr)
        return 2

    c = Checker()

    # ---------------------------------------------------------- container
    c.section("container format")
    with open(fpk, "rb") as f:
        c.ck(f.read(2) == b"\x1f\x8b", "fpk is gzip-compressed")

    t = tarfile.open(fpk, "r:gz")
    infos = t.getmembers()
    names = [m.name for m in infos]
    print(f"  outer members: {len(names)}")

    for req in OUTER_REQUIRED:
        c.ck(req in names, f"outer contains {req}")
    c.ck("cmd" in names, "outer contains cmd/")
    cmd_members = [n for n in names if n.startswith("cmd/")]
    c.ck(len(cmd_members) == 10, "cmd/ has 10 entries", f"got {len(cmd_members)}")

    # ----------------------------------------------------------- manifest
    c.section("manifest")
    mf = t.extractfile("manifest").read().decode("utf-8")
    ver = re.search(r"^version\s*=\s*(\S+)", mf, re.M)
    c.ck(ver is not None, "manifest declares version")
    packed_ver = ver.group(1) if ver else None
    if ver:
        print(f"  version = {packed_ver}")

    # The version is not just a string to print: a build that packages an old
    # manifest ships the wrong version, changelog, install_dep_apps and
    # os_min_version -- exactly the fields fnOS acts on. Comparing it to the
    # source manifest (below) is what makes the check mean anything.
    src_manifest_path = os.path.join(src, "manifest")
    if os.path.isfile(src_manifest_path):
        with open(src_manifest_path, "rb") as f:
            src_text = f.read().decode("utf-8")

        def parse_manifest(text):
            """Return (key -> value, [lines that are not well-formed key=value])."""
            fields = {}
            stray = []
            for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
                line = raw.strip()
                if not line:
                    continue
                if "=" not in line:
                    stray.append(line)
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
                    stray.append(line)
                    continue
                fields[key] = value.strip()
            return fields, stray

        src_fields, src_stray = parse_manifest(src_text)
        pkg_fields, pkg_stray = parse_manifest(mf)

        # fnpack does NOT copy the manifest verbatim: it realigns the '=' padding
        # and appends the checksum line, so byte-identity can never hold for this
        # file. Compare it field by field instead -- that is the invariant fnOS
        # actually reads, and it still catches a stale or truncated manifest.
        c.ck(not src_stray, "source manifest has no malformed lines",
             "; ".join(src_stray[:3]))

        mismatched = []
        for key, value in src_fields.items():
            if key not in pkg_fields:
                mismatched.append(f"{key}: missing from the package")
            elif pkg_fields[key] != value:
                mismatched.append(
                    f"{key}: packed {len(pkg_fields[key])} chars != source {len(value)} chars"
                )
        c.ck(not mismatched, "every manifest field matches the source manifest",
             "; ".join(mismatched[:4]))

        # fnpack splits a value at a ';' and prefixes the continuation with ';',
        # which is an INI COMMENT -- the rest of the value is then silently
        # dropped by fnOS. A stray line here means exactly that happened.
        c.ck(not pkg_stray,
             "packaged manifest has no stray lines (a ';' in a value is mangled)",
             "; ".join(s[:70] for s in pkg_stray[:2]))

        c.ck(src_fields.get("version") == packed_ver,
             "packaged version matches the source manifest",
             f"packed={packed_ver} source={src_fields.get('version')}")

        c.ck(src_fields.get("version", "") in src_fields.get("changelog", ""),
             "changelog names the declared version", src_fields.get("version"))
    else:
        c.ck(False, "source manifest found", src_manifest_path)

    app_bytes = t.extractfile("app.tgz").read()
    md5 = hashlib.md5(app_bytes).hexdigest()
    declared = re.search(r"^checksum\s*=\s*(\S+)", mf, re.M)
    c.ck(declared is not None, "manifest has checksum line")
    if declared:
        c.ck(md5 == declared.group(1), "checksum == md5(app.tgz)",
             f"calc={md5} declared={declared.group(1)}")
    print(f"  md5(app.tgz) = {md5}")

    # ------------------------------------------------------------ app.tgz
    c.section("app.tgz contents")
    a = tarfile.open(fileobj=io.BytesIO(app_bytes), mode="r:gz")
    ainfos = a.getmembers()
    anames = [m.name for m in ainfos]
    for req in APP_REQUIRED:
        c.ck(req in anames, f"app.tgz contains {req}")
    print(f"  app.tgz members: {len(anames)}")

    def body(n):
        """Read a file from inside app.tgz, or b'' if absent.

        Returning empty rather than raising matters: a package that predates a
        file (the stale 1.3.0 artefact is the whole point of this gate) must
        produce a FAILED check, not a traceback. A crash here would abort the
        run before it could report the real findings.
        """
        try:
            return a.extractfile(n).read()
        except KeyError:
            return b""

    # Raw bytes of both layers, keyed by path. The probes below and the
    # byte-for-byte comparison both read from these.
    outer_bytes = {m.name: t.extractfile(m).read() for m in infos if m.isfile()}
    inner_bytes = {m.name: a.extractfile(m).read() for m in ainfos if m.isfile()}

    # ----------------------------------------- regression probes (1.3.1)
    # Each of these was a shipped bug; assert the fix is really in the artefact.
    c.section("1.3.1 regression probes")
    probes = [
        ("server/lib/paths.js", [b"require('fs')", b'require("fs")'],
         "fs required in paths.js"),
        ("server/lib/dns.js", [b"require('path')", b'require("path")'],
         "path required in dns.js"),
        ("server/lib/http.js", [b"require('./runner')", b'require("./runner")'],
         "runner required in http.js"),
    ]
    for name, needles, label in probes:
        data = body(name)
        c.ck(any(n in data for n in needles), label)
        print(f"  {label:38s} {'OK' if any(n in data for n in needles) else 'MISSING'}")

    http_src = body("server/lib/http.js").decode("utf-8")
    c.ck("runtimeRecord" in http_src and "forgetTunnel" in http_src,
         "http.js imports runtimeRecord + forgetTunnel")
    c.ck(re.search(r"\bruntime\.(get|delete)\b", http_src) is None,
         "http.js has no bare runtime.* call (the 1.3.0 crash)")
    c.ck(b"forgetTunnel" in body("server/lib/runner.js"),
         "runner.js exposes forgetTunnel")

    cf_src = body("server/lib/cloudflared.js").decode("utf-8")
    c.ck("resolveTunnelIdByName" in cf_src,
         "cloudflared.js resolves name -> tunnel id (no credential guessing)")
    c.ck("resolveCredentials" in cf_src, "cloudflared.js has resolveCredentials")

    # ------------------------------------------------- 1.4.0 regression probes
    # The artefact is the thing that ships, so assert the 1.4.0 fixes are in it
    # too -- not only in the working tree. A stale package is the failure mode
    # this whole gate exists to catch.
    c.section("1.4.0 regression probes")

    log_src = body("server/lib/log.js").decode("utf-8")
    c.ck(re.search(r"readSync\([^)]*\)", log_src) is not None,
         "log.js captures the readSync return value")
    c.ck(re.search(r"toString\(\s*'utf8'\s*,\s*0\s*,\s*bytesRead\s*\)", log_src) is not None
         or re.search(r'toString\(\s*"utf8"\s*,\s*0\s*,\s*bytesRead\s*\)', log_src) is not None,
         "log.js decodes only the bytes actually read (no uninitialised heap)")
    c.ck("rotateTunnelLog" not in log_src,
         "log.js has no dead rotateTunnelLog export")

    store_src = body("server/lib/store.js").decode("utf-8")
    c.ck("safeId" in store_src,
         "store.js validates the tunnel id before using it as a path")
    c.ck(re.search(r"id:\s*safeId\(", store_src) is not None,
         "normalizeTunnel routes the id through safeId")

    http_src2 = body("server/lib/http.js").decode("utf-8")
    c.ck(re.search(r"readTailLines\(APP_LOG,\s*MAX_TAIL_BYTES", http_src2) is not None,
         "app-log endpoint reads the bounded MAX_TAIL_BYTES window")
    c.ck(re.search(r"readTailLines\(APP_LOG,\s*MAX_APP_LOG_BYTES", http_src2) is None,
         "app-log endpoint no longer reads the 2MB rotation cap as a window")

    www_app = body("www/app.js").decode("utf-8")
    c.ck("lastListHtml" in www_app,
         "app.js skips the DOM when the rendered list is unchanged")
    c.ck("isHidden" in www_app and "visibilitychange" in www_app,
         "app.js pauses polling in a background tab")
    c.ck("applyLogBoxes" in www_app,
         "app.js updates log boxes in place instead of inlining log text")
    c.ck("MARKER" not in www_app, "no probe marker leaked into app.js")

    idx_src = body("www/index.html").decode("utf-8")
    c.ck("%%CF_BASE%%" in idx_src,
         "index.html still carries the %%CF_BASE%% placeholder (substituted at serve time)")
    for landmark in ("view-tunnels", "tunnel-summary", "modal-backdrop", "skip-link"):
        c.ck(landmark in idx_src, f"index.html contains {landmark}")

    css_src = body("www/style.css").decode("utf-8")
    c.ck("prefers-color-scheme" in css_src, "style.css supports a dark theme")
    c.ck("prefers-reduced-motion" in css_src, "style.css respects reduced motion")
    c.ck("--primary:" in css_src, "style.css is driven by design tokens")

    # ------------------------------------------------- 1.4.1 regression probes
    c.section("1.4.1 regression probes")

    store_src2 = body("server/lib/store.js").decode("utf-8")
    c.ck("setSettings" in store_src2,
         "store.js exposes setSettings (marks settings as locally changed)")
    c.ck(re.search(r"function saveConfig\(\)\s*\{[\s\S]*?settingsDirty", store_src2) is not None,
         "saveConfig() consults settingsDirty before overwriting settings")
    c.ck(re.search(r"readFileSync\(CONFIG_FILE", store_src2) is not None,
         "saveConfig() re-reads config.json to merge another writer's settings")

    http_src3 = body("server/lib/http.js").decode("utf-8")
    c.ck(re.search(r"setSettings\(next\)", http_src3) is not None,
         "settings route writes through setSettings()")
    # Every :id route that reaches runtimeRecord() must first check the tunnel
    # exists; runtimeRecord() is a get-or-create, so a missing guard leaks an
    # entry that nothing can reap.
    for action in ("logs", "stop", "restart"):
        pat = re.compile(
            r"action === '" + action + r"'[\s\S]{0,400}?tunnelById\(id\)"
        )
        c.ck(pat.search(http_src3) is not None,
             f"http.js guards the {action} route with tunnelById(id)")

    # cmd/config_callback lives at the OUTER level, not inside app.tgz, so read
    # it from the outer archive. Reading it via body() raised KeyError on a
    # package that predates the file -- a gate must report a failure, not crash.
    ck_raw = outer_bytes.get("cmd/config_callback")
    if ck_raw is None:
        c.ck(False, "packaged cmd/config_callback is present")
    else:
        ck_src = ck_raw.decode("utf-8")
        c.ck("readFileSync" in ck_src,
             "config_callback does a read-modify-write (does not clobber tunnels)")

    # The uninstall must not leave rotated log generations or version markers
    # behind when the user chose to delete their data.
    un_raw = outer_bytes.get("cmd/uninstall_callback")
    if un_raw is None:
        c.ck(False, "packaged cmd/uninstall_callback is present")
    else:
        un_src = un_raw.decode("utf-8")
        for leftover in ("server.log.1", "VERSION", "cloudflared.version"):
            c.ck(leftover in un_src, f"uninstall removes {leftover}")

    # cmd/_lib must keep probing absolute node paths before falling back to PATH:
    # dependency apps are not added to PATH on fnOS, so the reverse order would
    # break every lifecycle script on the target.
    lib_raw = outer_bytes.get("cmd/_lib")
    if lib_raw is None:
        c.ck(False, "packaged cmd/_lib is present")
    else:
        lib_src = lib_raw.decode("utf-8")
        abs_probe = lib_src.find("/var/apps/nodejs_v24")
        path_probe = lib_src.find("command -v node")
        c.ck(abs_probe > 0 and path_probe > abs_probe,
             "cmd/_lib probes absolute node paths before PATH")

    # ------------------------------------------------- byte-for-byte check
    # Every authored file, in whichever layer it lives: app/* is inside
    # app.tgz, everything else (cmd/, wizard/, config/, manifest, icons) is at
    # the outer level.
    c.section("packaged files match source")
    pairs = discover_authored(src)

    compared = 0
    missing = []
    for arc, disk in pairs:
        if not os.path.isfile(disk):
            c.ck(False, f"source missing: {disk}")
            continue
        inside_app = arc not in outer_bytes
        packed = inner_bytes.get(arc) if inside_app else outer_bytes.get(arc)
        if packed is None:
            missing.append(arc)
            c.ck(False, f"packaged file missing: {arc}")
            continue
        with open(disk, "rb") as f:
            cur = f.read()
        c.ck(packed == cur, f"{arc} matches source",
             f"packed={len(packed)} disk={len(cur)}")
        compared += 1

    print(f"  compared {compared} authored files (discovered, not hand-listed)")
    if missing:
        print(f"    MISSING from package: {', '.join(missing[:6])}")

    # Guard against the walk silently covering almost nothing: the tree really
    # does have this many authored files, and the lifecycle scripts and wizard
    # descriptors -- the ones fnOS executes -- must be among them.
    c.ck(compared >= 30, "a substantial number of authored files was compared",
         f"only {compared}")
    for must in ("cmd/main", "cmd/_lib", "wizard/install", "wizard/config",
                 "config/privilege", "ICON.PNG"):
        c.ck(must in [arc for arc, _ in pairs], f"authored walk includes {must}")

    # -------------------------------------------------------- permissions
    c.section("archive permissions")
    bad = []
    for m in infos:
        want = want_outer_mode(m.name, m.isdir())
        if m.mode != want:
            bad.append(f"outer:{m.name} {oct(m.mode)}!={oct(want)}")
    for m in ainfos:
        want = want_app_mode(m.name, m.isdir())
        if m.mode != want:
            bad.append(f"app:{m.name} {oct(m.mode)}!={oct(want)}")

    omode = {m.name: m.mode for m in infos}
    amode = {m.name: m.mode for m in ainfos}
    c.ck(amode.get("bin/cloudflared") == 0o755,
         "bin/cloudflared is 0755", oct(amode.get("bin/cloudflared", 0)))
    c.ck(omode.get("cmd/main") == 0o755, "cmd/main is 0755",
         oct(omode.get("cmd/main", 0)))
    for n in cmd_members:
        c.ck(omode[n] == 0o755, f"{n} is 0755", oct(omode[n]))
    c.ck(not bad, "no unexpected 0666/0777 modes", "; ".join(bad[:4]))
    print(f"  cmd/main        = {oct(omode.get('cmd/main', 0))}")
    print(f"  bin/cloudflared = {oct(amode.get('bin/cloudflared', 0))}")
    if bad:
        for b in bad[:10]:
            print(f"    BAD {b}")

    # ------------------------------------------------------------- binary
    # The binary is not tracked in git (38MB of upstream build), so it cannot be
    # compared to a source file. It is instead compared to the pin in
    # tools/fetch-cloudflared.py -- which is what the build actually downloaded,
    # and therefore the only thing that can catch a stale or swapped binary.
    c.section("bundled binary")
    bin_bytes = body("bin/cloudflared")
    bin_len = len(bin_bytes)
    magic = bin_bytes[:4]
    c.ck(bin_len > 30_000_000, "cloudflared binary is present", f"{bin_len} bytes")
    c.ck(magic == b"\x7fELF", "binary is an ELF executable", magic.hex())
    print(f"  size = {bin_len} bytes, magic = {magic.hex()}")

    pinned_ver, pinned_sha = read_binary_pin(src)
    if pinned_ver is None:
        c.ck(False, "tools/fetch-cloudflared.py declares the pinned binary version")
    else:
        print(f"  pinned {pinned_ver} sha256 {pinned_sha[:16]}...")
        # The pin must describe *this* binary. The hash alone would not catch a
        # version string bumped without re-deriving the hash, and the version
        # alone would not catch a swapped same-version rebuild, so assert both.
        c.ck(pinned_ver.encode() in bin_bytes,
             "the pinned version string really occurs in the packaged binary",
             f"pin={pinned_ver}")
        actual = hashlib.sha256(bin_bytes).hexdigest()
        c.ck(actual == pinned_sha, "packaged binary matches the pinned SHA-256",
             f"packed={actual[:16]}... pin={pinned_sha[:16]}...")
        print(f"  packaged sha256 {actual}")

    # -------------------------------------------------------------- recap
    print()
    print("=" * 60)
    print(f"RESULT: {c.passed} passed, {len(c.failures)} failed")
    if c.failures:
        print("FAILED:")
        for f in c.failures:
            print("  -", f)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
