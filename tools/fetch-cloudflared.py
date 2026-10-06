#!/usr/bin/env python3
"""Fetch the pinned official cloudflared binary into cloudflared/app/bin/.

The 40MB cloudflared binary is deliberately NOT tracked in git. It is a
third-party build that upstream already publishes, so committing it would put
~38MB into every clone -- and into the permanent history -- for a file that
nobody in this repository edits. The packaged .fpk, which does contain it, is
published as a GitHub Release asset instead.

The exact upstream release is pinned below and its SHA-256 is verified before
the file is put in place, so a truncated download, a hijacked mirror, or a
silently republished upstream tag cannot end up inside a package.

Usage:
    python3 tools/fetch-cloudflared.py           # fetch if missing or wrong
    python3 tools/fetch-cloudflared.py --check   # verify only; never downloads
    python3 tools/fetch-cloudflared.py --force   # re-fetch even if present

Exit: 0 success, 1 download or verification failure.
"""

import argparse
import hashlib
import os
import sys
import urllib.request

# ------------------------------------------------------------------- the pin
# This must stay in step with the version the package actually bundles: it is
# the single source of truth for "which cloudflared is inside the .fpk", and
# tools/verify-fpk.py re-reads it to assert the packaged binary matches.
VERSION = "2026.9.3"
ASSET = "cloudflared-linux-amd64"
SHA256 = "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2"
URL = "https://github.com/cloudflare/cloudflared/releases/download/{}/{}".format(VERSION, ASSET)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "cloudflared", "app", "bin", "cloudflared")
MODE = 0o755
CHUNK = 1 << 20


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download(url, part):
    """Stream to `part`; returns the number of bytes written."""
    req = urllib.request.Request(url, headers={"User-Agent": "fnos-cloudflared-build"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        next_mark = 8 << 20
        while True:
            block = resp.read(CHUNK)
            if not block:
                break
            out.write(block)
            done += len(block)
            if done >= next_mark:
                next_mark += 8 << 20
                pct = " ({:.0f}%)".format(done * 100.0 / total) if total else ""
                print("  ... {:.0f} MB{}".format(done / (1 << 20), pct), flush=True)
    return done


def main():
    ap = argparse.ArgumentParser(description="fetch the pinned cloudflared binary")
    ap.add_argument("--check", action="store_true", help="verify only, never download")
    ap.add_argument("--force", action="store_true", help="re-fetch even if present")
    args = ap.parse_args()

    print("pinned cloudflared {} ({})".format(VERSION, SHA256[:12] + "..."))

    if os.path.isfile(DEST) and not args.force:
        got = sha256_of(DEST)
        if got == SHA256:
            print("  {} already present and matches the pin".format(os.path.relpath(DEST, ROOT)))
            return 0
        print("  present but the hash differs:\n    have {}\n    want {}".format(got, SHA256))
        if args.check:
            print("  --check: not downloading", file=sys.stderr)
            return 1
        print("  re-fetching")
    elif args.check:
        print("  {} is missing".format(os.path.relpath(DEST, ROOT)), file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    part = DEST + ".part"
    try:
        print("  downloading {}".format(URL))
        size = download(URL, part)
        got = sha256_of(part)
        if got != SHA256:
            print("  SHA-256 mismatch:\n    got  {}\n    want {}".format(got, SHA256), file=sys.stderr)
            return 1
        # Only replace the real file once the bytes are proven: a truncated or
        # tampered download must never land where the build will pick it up.
        os.replace(part, DEST)
        try:
            os.chmod(DEST, MODE)
        except OSError:
            pass
        print("  ok: {} bytes, sha256 verified".format(size))
        return 0
    except Exception as exc:
        print("  download failed: {}".format(exc), file=sys.stderr)
        print("  fetch it by hand and place it at {}:".format(os.path.relpath(DEST, ROOT)), file=sys.stderr)
        print("    curl -L -o {} {}".format(os.path.relpath(DEST, ROOT), URL), file=sys.stderr)
        print("    expected sha256: {}".format(SHA256), file=sys.stderr)
        return 1
    finally:
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
