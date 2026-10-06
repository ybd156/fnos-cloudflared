#!/usr/bin/env python3
"""Normalise permission bits inside a built .fpk.

`fnpack` derives archive modes from the host filesystem's stat(). On Linux the
source tree has already been chmod'ed by build.sh, so the archive gets
0755/0644. On Windows there is no executable bit: every file lands as 0666 and
every directory as 0777, so `cmd/main` and `app/bin/cloudflared` arrive on the
NAS **non-executable** and the app cannot start.

This runs after `fnpack build` and rewrites the modes in both tar layers to the
Linux-correct values, then repairs the `checksum` line in the packaged manifest
(rewriting app.tgz changes its MD5, which is what that field records).

Usage: normalize-fpk.py <path-to.fpk>
"""

import gzip
import hashlib
import io
import os
import re
import sys
import tarfile

DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_MODE = 0o755

# Paths that must be executable on the target, as POSIX paths relative to their
# tar root. `cmd/*` are the lifecycle scripts the app framework invokes;
# `bin/cloudflared` is the tunnel binary the server spawns.
EXEC_PREFIXES = ("cmd/",)
EXEC_EXACT = {"bin/cloudflared"}


def want_mode(name, isdir):
    if isdir:
        return DIR_MODE
    if name in EXEC_EXACT:
        return EXEC_MODE
    if any(name.startswith(p) for p in EXEC_PREFIXES):
        return EXEC_MODE
    return FILE_MODE


def read_members(raw):
    """Return (tarinfo list, {name: bytes}) for a gzip'd tar.

    Only regular files and directories are expected. Anything else (symlink,
    hardlink, device) is rejected rather than silently rewritten as an empty
    regular file, which would corrupt the archive.
    """
    tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
    infos = tf.getmembers()
    data = {}
    for m in infos:
        if not (m.isfile() or m.isdir()):
            tf.close()
            raise ValueError(
                f"unsupported tar member type {m.type!r} for {m.name!r}; "
                "this normaliser only handles regular files and directories"
            )
        data[m.name] = tf.extractfile(m).read() if m.isfile() else b""
    tf.close()
    return infos, data


def write_tar(infos, data, mode_of):
    """Rebuild a gzip'd ustar archive, preserving everything but the mode."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as out:
        for m in infos:
            m.mode = mode_of(m)
            if m.isdir():
                m.size = 0
            else:
                m.size = len(data[m.name])
            out.addfile(m, io.BytesIO(data[m.name]) if not m.isdir() else None)
    raw = buf.getvalue()
    gz = io.BytesIO()
    with gzip.GzipFile(fileobj=gz, mode="wb", mtime=0) as g:
        g.write(raw)
    return gz.getvalue()


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    fpk = sys.argv[1]
    if not os.path.isfile(fpk):
        print(f"normalize-fpk: not a file: {fpk}", file=sys.stderr)
        return 2

    with open(fpk, "rb") as f:
        outer_raw = f.read()

    try:
        infos, data = read_members(outer_raw)
    except ValueError as exc:
        print(f"normalize-fpk: {exc}", file=sys.stderr)
        return 1
    names = [m.name for m in infos]

    if "app.tgz" not in names or "manifest" not in names:
        print("normalize-fpk: not an fnpack archive (missing app.tgz/manifest)",
              file=sys.stderr)
        return 1

    # Capture the original modes before write_tar mutates the TarInfo objects.
    outer_before = {m.name: m.mode for m in infos}

    # --- inner layer: the app tree -------------------------------------
    try:
        inner_infos, inner_data = read_members(data["app.tgz"])
    except ValueError as exc:
        print(f"normalize-fpk: app.tgz: {exc}", file=sys.stderr)
        return 1
    inner_before = {m.name: m.mode for m in inner_infos}
    inner_out = write_tar(
        inner_infos, inner_data, lambda m: want_mode(m.name, m.isdir())
    )
    data["app.tgz"] = inner_out

    # --- repair the manifest checksum ----------------------------------
    mf = data["manifest"].decode("utf-8")
    new_md5 = hashlib.md5(inner_out).hexdigest()
    if re.search(r"^checksum\s*=", mf, re.M):
        mf = re.sub(r"^checksum\s*=.*$", f"checksum = {new_md5}", mf, flags=re.M)
    else:
        mf = mf.rstrip("\n") + f"\nchecksum = {new_md5}\n"
    data["manifest"] = mf.encode("utf-8")

    # --- outer layer ---------------------------------------------------
    outer_out = write_tar(
        infos, data, lambda m: want_mode(m.name, m.isdir())
    )

    with open(fpk, "wb") as f:
        f.write(outer_out)

    # --- report ---------------------------------------------------------
    changed = sum(
        1 for m in inner_infos
        if inner_before[m.name] != want_mode(m.name, m.isdir())
    )
    outer_changed = sum(
        1 for m in infos
        if outer_before[m.name] != want_mode(m.name, m.isdir())
    )

    print(f"  normalised {outer_changed} outer + {changed} inner permission bits")
    print(f"  checksum = {new_md5} (md5 of app.tgz)")
    print(f"  size     = {os.path.getsize(fpk)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
