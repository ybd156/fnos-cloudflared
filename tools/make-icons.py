#!/usr/bin/env python3
"""Generate the Cloudflare Tunnel app icons.

Pure standard library (zlib + struct) so it runs on any fnOS box without
Pillow or ImageMagick. Draws a rounded-square badge with a Cloudflare-orange
gradient, a white cloud and a downward arrow (the "tunnel" motif), then writes
RGBA PNGs at several sizes.
"""

import os
import struct
import zlib

OUTPUTS = [
    ("ICON.PNG", 64),
    ("ICON_256.PNG", 256),
    ("app/ui/images/icon_64.png", 64),
    ("app/ui/images/icon_256.png", 256),
    ("app/www/images/icon_64.png", 64),
    ("app/www/images/icon_256.png", 256),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.join(ROOT, "cloudflared")

# Cloudflare orange gradient (top -> bottom), sRGB.
TOP = (0xF9, 0xA1, 0x4A)
BOTTOM = (0xE0, 0x5A, 0x0B)
WHITE = (0xFF, 0xFF, 0xFF)


def lerp(a, b, t):
    return a + (b - a) * t


def in_rounded_rect(x, y, size, radius):
    half = size / 2.0
    dx = abs(x - half) - (half - radius)
    dy = abs(y - half) - (half - radius)
    dx = max(dx, 0.0)
    dy = max(dy, 0.0)
    return dx * dx + dy * dy <= radius * radius


def in_circle(x, y, cx, cy, r):
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def in_rect(x, y, x0, y0, x1, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def in_triangle(x, y, p0, p1, p2):
    def cross(ax, ay, bx, by, px, py):
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax)

    d1 = cross(p0[0], p0[1], p1[0], p1[1], x, y)
    d2 = cross(p1[0], p1[1], p2[0], p2[1], x, y)
    d3 = cross(p2[0], p2[1], p0[0], p0[1], x, y)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def cloud_and_arrow(x, y, s):
    """White foreground mask, coordinates normalised to 0..1 then scaled by s."""
    # --- cloud: three bumps over a flat base ---------------------------
    if in_circle(x, y, 0.325 * s, 0.420 * s, 0.110 * s):
        return True
    if in_circle(x, y, 0.505 * s, 0.360 * s, 0.155 * s):
        return True
    if in_circle(x, y, 0.670 * s, 0.425 * s, 0.110 * s):
        return True
    if in_rect(x, y, 0.215 * s, 0.415 * s, 0.785 * s, 0.545 * s):
        return True

    # --- downward arrow (the tunnel) -----------------------------------
    if in_rect(x, y, 0.455 * s, 0.525 * s, 0.545 * s, 0.670 * s):
        return True
    if in_triangle(
        x, y, (0.365 * s, 0.655 * s), (0.635 * s, 0.655 * s), (0.500 * s, 0.810 * s)
    ):
        return True
    return False


def render(size, supersample):
    """Return raw RGBA rows for one icon."""
    big = size * supersample
    radius = big * 0.225

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r_acc = g_acc = b_acc = a_acc = 0.0
            for sy in range(supersample):
                for sx in range(supersample):
                    fx = px * supersample + sx + 0.5
                    fy = py * supersample + sy + 0.5

                    if not in_rounded_rect(fx, fy, big, radius):
                        continue

                    t = fy / big
                    bg = (
                        lerp(TOP[0], BOTTOM[0], t),
                        lerp(TOP[1], BOTTOM[1], t),
                        lerp(TOP[2], BOTTOM[2], t),
                    )
                    if cloud_and_arrow(fx, fy, big):
                        bg = WHITE

                    r_acc += bg[0]
                    g_acc += bg[1]
                    b_acc += bg[2]
                    a_acc += 255.0

            samples = float(supersample * supersample)
            alpha = a_acc / samples
            if alpha <= 0.0:
                row += bytes((0, 0, 0, 0))
                continue

            # Un-premultiply so partially covered edge pixels keep a clean
            # colour instead of fading towards black.
            scale = a_acc / 255.0
            row += bytes(
                (
                    int(round(min(255.0, r_acc / scale))),
                    int(round(min(255.0, g_acc / scale))),
                    int(round(min(255.0, b_acc / scale))),
                    int(round(alpha)),
                )
            )
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as handle:
        handle.write(png)
    os.chmod(path, 0o644)
    return len(png)


def main():
    for relative, size in OUTPUTS:
        target = os.path.join(PROJECT, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        supersample = 8 if size <= 64 else 4
        rows = render(size, supersample)
        written = write_png(target, size, rows)
        print(f"{relative:34s} {size}x{size}  {written:>7,d} bytes")


if __name__ == "__main__":
    main()
