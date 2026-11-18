#!/usr/bin/env python3
"""make_icons.py: cut the app's three icons from one picture, and check them.

The mark is a glowing brain on a dark blue tile: a picture the owner made. The icons are cut from it
(crop, scale, a clean edge) and never redrawn. The picture is not in this repository: --render reads it
from design/dockread-brain-gemini.jpeg, in the folder beside this one.

  icons/icon-192.png            purpose "any": the tile, rim and all, with the corners outside it cut clear
  icons/icon-512.png            purpose "any": the same, at 512
  icons/icon-maskable-512.png   purpose "maskable": full bleed, for a launcher that cuts its own shape.
                                The rim is left out, the panel's own colours are carried on to every
                                edge, and the whole brain sits inside the middle circle no mask ever cuts.

--check reads every shipped icon back and refuses (exit 1) if one is missing, is not a plain 8-bit RGBA
PNG of its size, carries anything but pixels (a text or EXIF chunk), or does not hold the brain: blue, in
the middle, and big. A tile must also be clear outside its outline and solid inside it, to within a
pixel, with its rim on all four sides and none of the picture's pale background along its edge. The
full-bleed icon must also have no see-through pixel, nothing but the plain blue panel at its edge, nothing
pale outside the safe circle, and nothing bigger than a sparkle past that circle.

What --check cannot tell is one blue brain from another. That is settled where the picture is: the test
suite renders the picture again and compares the result with the shipped icons, pixel by pixel.

--render needs PIL and numpy. --check is the standard library alone (a real PNG reader below), so the
test suite runs it anywhere.

Usage:
  python3 tools/make_icons.py --render     cut the three PNGs into icons/
  python3 tools/make_icons.py --check      read the shipped icons back and check them; writes nothing

After a new picture: re-measure the numbers below, render, check, then run tools/stamp.py so phones take
the new icons.
"""
import hashlib
import math
import os
import struct
import sys
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "icons"
PICTURE = Path(__file__).resolve().parents[2] / "design" / "dockread-brain-gemini.jpeg"

# (file name, size, maskable)
JOBS = (
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
)

# Where things sit in the picture, measured once by pixel. A pixel's place is its row and column number.
PICTURE_SIZE = (2752, 1536)
PICTURE_SHA256 = "2348429f354664bb111e9b49cda2364791c14e435a54555d2ea41093d4a36065"
TILE = (1375.75, 768.22, 542.0, 230.6)  # the tile's outline, a rounded square: centre x, centre y, half its side, corner radius
EDGE = 4.5                      # the real edge strays up to 3.2 px from that outline: colours are trusted only this far inside it
RIM = 26                        # the rim is never wider than this, counted in from the outline
BRAIN = (1376.0, 751.0, 392.0)  # the smallest circle holding every line of the brain: x, y, radius
FIT = 0.38                      # that circle's radius in the full-bleed icon, as a share of its side
KEEP = 10                       # full bleed: the panel is trusted from this far inside the rim
FADE = 40                       # full bleed: the panel eases into its carried-on colours over this many px
SOFT = 5                        # full bleed: the carried-on colours are read from the panel smoothed this much,
                                # at a line 4 x SOFT inside the trusted panel, so the smoothing never reaches the rim

# A launcher may cut a maskable icon to any shape that keeps this circle (a share of the icon's side).
SAFE_RADIUS = 0.40

# What --check looks for, as shares of the icon's side unless it says otherwise.
LIGHT = 160                     # blue at or above this is light: a line of the brain, a sparkle, the rim. The panel never is.
BRAIN_LIGHT = 0.05              # the brain: this share of the whole icon, at least, is light inside the safe circle
BRAIN_SPAN = (0.66, 0.62)       # that light is at least this wide and this tall (it measures 0.73 by 0.69 on the tile)
BRAIN_OFF = 0.06                # and the middle of its box is this close to the icon's middle
BRAIN_BLUE = (60, 25)           # and it is blue: blue minus red, and blue minus green, averaged over it, are at
                                # least these (they measure 131 and 59; a green or a grey brain fails one)
DOT = 0.07                      # past the safe circle a light shape may only be a sparkle: no wider or taller than this
BORDER = 0.06                   # full bleed: this close to the edge there is only the plain panel,
EDGE_LUM = 78                   # nothing brighter than this (the panel there measures 67 at most; the rim's
                                # inner line, left in by a wrong RIM, measures 89) and nothing light,
EDGE_BLUE = 20                  # and every pixel there is blue: blue minus red is at least this (41 by measure)
RING = 0.0105                   # a tile: among the pixels this close to its outline that are not fully clear,
PALE_SHARE = 0.01               # no more than this share may be pale. None is, on the picture's own tile, but
                                # the rim's brightest pixels there have blue minus red 46 against pale()'s 40:
                                # six levels. A re-render that warms the rim that much trips this rule too.
RIM_BAND = 0.06                 # a tile's rim lies within this of each edge
RIM_INSIDE = 0.12               # and the panel this far in is darker than the rim by at least RIM_STEP
RIM_STEP = 50
PLAIN = (b"IHDR", b"IDAT", b"IEND")


def die(msg):
    """Loud and non-zero: a renderer that fails quietly ships yesterday's icon."""
    print(f"make_icons: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def decode_png(data, size=None):
    """Read an 8-bit RGBA PNG: (width, height, rows of RGBA bytes, the chunk names in order).

    A real reader, not a trust: it checks the signature, every CRC and the header, and undoes filters
    0 to 4, so --check can judge any 8-bit RGBA PNG. With `size`, a picture that is not size x size is
    refused before any of its pixels are unpacked, and no file is unpacked past the length its header gives.
    """
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width, height, tags, ended = 8, b"", None, None, [], False
    while pos < len(data):
        if pos + 12 > len(data):
            raise ValueError("cut short")
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        tag, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        if pos + 12 + n > len(data):
            raise ValueError("cut short")
        (crc,) = struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])
        if zlib.crc32(tag + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"bad CRC in {tag!r}")
        tags.append(tag)
        if tag == b"IHDR":
            if width is not None or len(body) != 13:
                raise ValueError("bad IHDR")
            width, height, depth, ctype, packing, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, ctype, packing, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("not a plain 8-bit RGBA PNG, non-interlaced")
            if size is not None and (width, height) != (size, size):
                raise ValueError(f"is {width}x{height}, not {size}x{size}")
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            if n:
                raise ValueError("bad IEND")
            ended = True
            pos += 12 + n
            break
        pos += 12 + n
    if width is None or tags[0] != b"IHDR":
        raise ValueError("no IHDR first")
    if not ended:
        raise ValueError("no IEND")
    if pos != len(data):
        raise ValueError("bytes after IEND")
    if not 0 < width <= 4096 or not 0 < height <= 4096:
        raise ValueError("an unreasonable size")
    stride = width * 4
    unpack = zlib.decompressobj()
    raw = unpack.decompress(idat, height * (stride + 1) + 1)
    if len(raw) != height * (stride + 1) or not unpack.eof or unpack.unused_data:
        raise ValueError("pixel data is the wrong length")
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + (a + prev[i]) // 2) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        elif f != 0:
            raise ValueError(f"unknown filter {f}")
        rows.append(bytes(line))
        prev = line
    return width, height, rows, tags


def lum(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def middle_light(rows, size):
    """The light pixels inside the safe circle, taken together: n (how many), x0, y0, x1, y1 (their box),
    blue (blue minus red, averaged over them), over_green (blue minus green, averaged over them)."""
    c, limit2 = size / 2.0, (SAFE_RADIUS * size) ** 2
    n = blue = over_green = 0
    x0 = y0 = size
    x1 = y1 = -1
    for y, row in enumerate(rows):
        dy2 = (y + 0.5 - c) ** 2
        if dy2 > limit2:
            continue
        for x in range(size):
            if row[x * 4 + 2] >= LIGHT and row[x * 4 + 3] == 255 and (x + 0.5 - c) ** 2 + dy2 <= limit2:
                n += 1
                blue += row[x * 4 + 2] - row[x * 4]
                over_green += row[x * 4 + 2] - row[x * 4 + 1]
                x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
    k = max(n, 1)
    return {"n": n, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "blue": blue / k, "over_green": over_green / k}


def light_shapes(rows, size):
    """Every joined patch of light pixels (solid ones only), biggest first.

    Each is a dict: n (pixels), x0, y0, x1, y1 (its box), reach (how far its farthest pixel is from the
    icon's middle, px), blue (blue minus red, averaged over it).
    """
    light = bytearray(size * size)
    for y, row in enumerate(rows):
        base = y * size
        for x in range(size):
            if row[x * 4 + 2] >= LIGHT and row[x * 4 + 3] == 255:
                light[base + x] = 1
    c = size / 2.0
    out = []
    for start in range(size * size):
        if light[start] != 1:
            continue
        light[start] = 2
        stack = [start]
        n = blue = 0
        x0 = y0 = size
        x1 = y1 = -1
        far = 0.0
        while stack:
            at = stack.pop()
            y, x = divmod(at, size)
            row = rows[y]
            n += 1
            blue += row[x * 4 + 2] - row[x * 4]
            x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
            far = max(far, (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2)
            if x > 0 and light[at - 1] == 1:
                light[at - 1] = 2
                stack.append(at - 1)
            if x < size - 1 and light[at + 1] == 1:
                light[at + 1] = 2
                stack.append(at + 1)
            if y > 0 and light[at - size] == 1:
                light[at - size] = 2
                stack.append(at - size)
            if y < size - 1 and light[at + size] == 1:
                light[at + size] = 2
                stack.append(at + size)
        out.append({"n": n, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "reach": math.sqrt(far), "blue": blue / n})
    out.sort(key=lambda s: -s["n"])
    return out


def pale(r, g, b):
    """Near white or light grey: the picture's background. The tile, the brain and the sparkles are all blue."""
    return min(r, g, b) > 150 and b - r < 40


def judge(name, size, maskable, data):
    """Every check one icon must pass. Returns a list of problems (empty = good)."""
    try:
        w, h, rows, tags = decode_png(data, size)
    except Exception as e:                        # a broken file is a finding, not a crash
        return [f"{name}: {e}"]
    problems = []
    extra = sorted({t.decode("latin-1") for t in tags if t not in PLAIN})
    if extra:
        problems.append(f"{name}: carries {', '.join(extra)}; an icon ships pixels and nothing else")

    def px(x, y):
        return rows[y][x * 4:x * 4 + 4]

    c, m, last = size / 2.0, size // 2, size - 1
    if maskable:
        see_through = sum(1 for row in rows for a in row[3::4] if a != 255)
        if see_through:
            problems.append(f"{name}: {see_through} see-through pixels; a full-bleed icon runs to every edge")
        edge, limit2 = max(1, round(size * BORDER)), (SAFE_RADIUS * size) ** 2
        bright = off_colour = pale_out = 0
        for y, row in enumerate(rows):
            for x in range(size):
                r, g, b = row[x * 4:x * 4 + 3]
                if x < edge or y < edge or x > last - edge or y > last - edge:
                    if b >= LIGHT or lum(r, g, b) > EDGE_LUM:
                        bright += 1
                    elif b - r < EDGE_BLUE:
                        off_colour += 1
                if pale(r, g, b) and (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 > limit2:
                    pale_out += 1
        if bright:
            problems.append(f"{name}: {bright} bright pixels at the edge, where only the plain panel belongs; "
                            "the rim is still in it")
        if off_colour:
            problems.append(f"{name}: {off_colour} pixels at the edge are not the panel's blue; something else is there")
        if pale_out:
            problems.append(f"{name}: {pale_out} pale pixels outside the safe circle; the picture's background is in it")
    else:
        # the tile's outline in this icon: the measured rounded square, scaled to fill it
        radius = TILE[3] / (2 * TILE[2]) * size
        core, ring = c - radius, max(2.0, RING * size)
        outside = inside = near = pale_near = 0
        for y, row in enumerate(rows):
            qy = abs(y + 0.5 - c) - core
            for x in range(size):
                a = row[x * 4 + 3]
                qx = abs(x + 0.5 - c) - core
                d = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius
                if d > 1 and a:
                    outside += 1
                elif d < -1 and a != 255:
                    inside += 1
                if a and d > -ring:
                    near += 1
                    if pale(*row[x * 4:x * 4 + 3]):
                        pale_near += 1
        if outside:
            problems.append(f"{name}: {outside} pixels outside the tile's outline are not clear; its corners must be clear")
        if inside:
            problems.append(f"{name}: {inside} see-through pixels inside the tile's outline; the tile must be solid")
        if pale_near > PALE_SHARE * near:
            problems.append(f"{name}: {pale_near} pale pixels along the tile's edge; the cut took in the picture's "
                            "background (or the rim itself has lost its blue)")
        band, deep_in = max(2, round(size * RIM_BAND)), round(size * RIM_INSIDE)
        sides = {"left": ([(i, m) for i in range(band)], (deep_in, m)),
                 "right": ([(last - i, m) for i in range(band)], (last - deep_in, m)),
                 "top": ([(m, i) for i in range(band)], (m, deep_in)),
                 "bottom": ([(m, last - i) for i in range(band)], (m, last - deep_in))}
        for side, (pts, deep) in sides.items():
            rim = max([lum(*px(x, y)[:3]) for x, y in pts if px(x, y)[3] == 255], default=0)
            if rim - lum(*px(*deep)[:3]) < RIM_STEP:
                problems.append(f"{name}: no rim along the tile's {side} edge; it is not the tile")
    # the brain: the light inside the safe circle (a tile's rim lies outside it)
    b = middle_light(rows, size)
    if b["n"] < BRAIN_LIGHT * size * size:
        return problems + [f"{name}: hardly any light in the middle; the brain is missing"]
    bw, bh = b["x1"] - b["x0"] + 1, b["y1"] - b["y0"] + 1
    if bw < BRAIN_SPAN[0] * size or bh < BRAIN_SPAN[1] * size:
        problems.append(f"{name}: the light in the middle spans {bw}x{bh}; the brain is too small")
    off = max(abs((b["x0"] + b["x1"] + 1) / 2 - size / 2), abs((b["y0"] + b["y1"] + 1) / 2 - size / 2))
    if off > BRAIN_OFF * size:
        problems.append(f"{name}: the brain sits {off:.0f} px off the middle")
    if b["blue"] < BRAIN_BLUE[0] or b["over_green"] < BRAIN_BLUE[1]:
        problems.append(f"{name}: the light in the middle is not blue; this is not the brain picture")
    if maskable:
        limit, dot = SAFE_RADIUS * size, DOT * size
        for s in light_shapes(rows, size):
            if s["reach"] > limit and (s["x1"] - s["x0"] + 1 > dot or s["y1"] - s["y0"] + 1 > dot):
                problems.append(f"{name}: a light shape {s['x1'] - s['x0'] + 1}x{s['y1'] - s['y0'] + 1} reaches "
                                f"{s['reach']:.0f} px from the middle, past the safe circle ({limit:.0f}); "
                                "a launcher's mask would cut the brain")
    return problems


def imaging():
    """PIL and numpy, for --render only."""
    try:
        import numpy as np
        from PIL import Image, ImageFilter
    except ImportError:
        die("--render needs PIL and numpy for this python; --check does not")
    return np, Image, ImageFilter


def to8(arr):
    np = imaging()[0]
    return np.clip(arr + 0.5, 0, 255).astype(np.uint8)


def smooth(t):
    np = imaging()[0]
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def outline(xs, ys, cx, cy, half, radius):
    """How far each point is from a rounded square's edge, px: below zero inside it, above zero outside."""
    np = imaging()[0]
    qx = np.abs(xs - cx) - (half - radius)
    qy = np.abs(ys - cy) - (half - radius)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius


def carried(src, x0, y0, xs, ys, inset):
    """Each pixel's colour, read from `src` at the nearest point of the tile's outline drawn `inset` px smaller.

    A pixel inside that smaller outline reads its own place. A pixel outside it reads the nearest point on
    it, so the colours at that line are carried straight on, outward, as far as they are asked for.
    """
    np = imaging()[0]
    cx, cy, half, radius = TILE
    core, r = half - radius, radius - inset
    if r <= 0:
        die("the inset is larger than the tile's corner radius; re-measure TILE")
    px, py = xs - cx, ys - cy
    qx, qy = np.clip(px, -core, core), np.clip(py, -core, core)
    dx, dy = px - qx, py - qy
    reach = np.hypot(dx, dy)
    k = np.where(reach > r, r / np.maximum(reach, 1e-6), 1.0)
    ix = np.clip(np.rint(cx + qx + dx * k).astype(int) - x0, 0, src.shape[1] - 1)
    iy = np.clip(np.rint(cy + qy + dy * k).astype(int) - y0, 0, src.shape[0] - 1)
    return src[iy, ix]


def window(arr, x0, y0, x1, y1):
    """A piece of the picture and the row and column number of each of its pixels."""
    np = imaging()[0]
    if x0 < 0 or y0 < 0 or x1 > arr.shape[1] or y1 > arr.shape[0]:
        die("the cut reaches past the picture's edge; re-measure TILE and BRAIN")
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    return arr[y0:y1, x0:x1], xs, ys


def tile_icon(arr, size):
    """The tile as it was drawn, cropped and scaled, the corners outside its outline cut clear."""
    np, Image, _ = imaging()
    cx, cy, half, radius = TILE
    pad = 8
    x0, y0 = math.floor(cx - half) - pad, math.floor(cy - half) - pad
    win, xs, ys = window(arr, x0, y0, math.ceil(cx + half) + pad + 1, math.ceil(cy + half) + pad + 1)
    # the tile's own colours carried just past its edge, so the soft edge mixes in none of the pale background
    colour = carried(win, x0, y0, xs, ys, EDGE)
    box = (cx - half + 0.5 - x0, cy - half + 0.5 - y0, cx + half + 0.5 - x0, cy + half + 0.5 - y0)
    img = Image.fromarray(to8(colour)).resize((size, size), Image.LANCZOS, box=box)
    iy, ix = np.mgrid[0:size, 0:size].astype(np.float32) + 0.5
    edge = outline(ix, iy, size / 2, size / 2, size / 2, radius * size / (2 * half))
    alpha = np.where(edge > 0.5, 0, np.clip(0.5 - edge, 0, 1))
    return Image.fromarray(np.dstack([np.asarray(img), to8(alpha * 255)]), "RGBA")


def maskable_icon(arr, size):
    """The panel inside the rim, its colours carried on to every edge, scaled so the whole brain fits the safe circle."""
    np, Image, _ = imaging()
    cx, cy, half, radius = TILE
    bx, by, br = BRAIN
    h = br / (2 * FIT)                              # half the icon's side, in picture px
    pad = 8
    x0, y0 = math.floor(bx - h) - pad, math.floor(by - h) - pad
    win, xs, ys = window(arr, x0, y0, math.ceil(bx + h) + pad + 1, math.ceil(by + h) + pad + 1)
    deep = -outline(xs, ys, cx, cy, half, radius) - (RIM + KEEP)     # px inside the trusted panel
    field = carried(blur(win, SOFT), x0, y0, xs, ys, RIM + KEEP + 4 * SOFT)
    keep = smooth(deep / FADE)[..., None]
    out = win * keep + field * (1 - keep)
    box = (bx - h + 0.5 - x0, by - h + 0.5 - y0, bx + h + 0.5 - x0, by + h + 0.5 - y0)
    return Image.fromarray(to8(out)).resize((size, size), Image.LANCZOS, box=box).convert("RGBA")


def blur(arr, radius):
    np, Image, ImageFilter = imaging()
    return np.asarray(Image.fromarray(to8(arr)).filter(ImageFilter.GaussianBlur(radius)), np.float32)


def render(icon_dir):
    if not PICTURE.is_file():
        die(f"{PICTURE.name} is missing from the design folder; nothing rendered")
    if hashlib.sha256(PICTURE.read_bytes()).hexdigest() != PICTURE_SHA256:
        die(f"{PICTURE.name} is not the picture these numbers were measured on: re-measure them first")
    np, Image, _ = imaging()
    picture = Image.open(PICTURE).convert("RGB")
    if picture.size != PICTURE_SIZE:
        die(f"{PICTURE.name} is {picture.size[0]}x{picture.size[1]}, not {PICTURE_SIZE[0]}x{PICTURE_SIZE[1]}")
    arr = np.asarray(picture, np.float32)
    icon_dir.mkdir(exist_ok=True)
    for name, size, maskable in JOBS:
        img = maskable_icon(arr, size) if maskable else tile_icon(arr, size)
        out = icon_dir / name
        tmp_out = out.with_suffix(".tmp.png")
        img.save(tmp_out, format="PNG", optimize=True)
        problems = judge(name, size, maskable, tmp_out.read_bytes())
        if problems:
            tmp_out.unlink()
            die("; ".join(problems))
        os.replace(tmp_out, out)
        print(f"  {name:<24} {size}x{size}  {'maskable' if maskable else 'any'}", flush=True)
    print(f"{len(JOBS)} icons cut from {PICTURE.name}. Run tools/stamp.py so phones take them.")


def check(icon_dir):
    problems = []
    for name, size, maskable in JOBS:
        path = icon_dir / name
        if not path.is_file():
            problems.append(f"{name}: missing")
            continue
        problems.extend(judge(name, size, maskable, path.read_bytes()))
    if problems:
        die("; ".join(problems))
    print(f"{len(JOBS)} icons check out.")


def main(argv):
    if argv == ["--render"]:
        return render(ICONS)
    if argv == ["--check"]:
        return check(ICONS)
    die("usage: make_icons.py --render | --check")


if __name__ == "__main__":
    main(sys.argv[1:])
