#!/usr/bin/env python3
"""Write the service worker's cache stamp (SPEC 9.10).

  python3 tools/stamp.py           rewrite the SHELL list and the CACHE stamp in sw.js
  python3 tools/stamp.py --check   exit 0 if sw.js matches the files on disk, else 1; writes nothing

The stamp is the first 12 hex of a sha-256 over every precached file (its path, then its bytes), in the
order of the list. The list is the page, the stylesheet, the six scripts, registry.json, places.json and
the manifest, plus the icons the manifest names, in its order. So any change to a shell file changes the
cache name, and a phone updates by itself. sw.js itself is not hashed (it holds the stamp). A stray file in
icons/ is never listed: the worker's install is all or nothing, and a listed file the host does not have
would keep every phone on the old version.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

SHELL = Path(__file__).resolve().parent.parent
SW = SHELL / "sw.js"

BASE = ("./", "./index.html", "./app.css",
        "./js/core.js", "./js/store.js", "./js/geo.js", "./js/sound.js", "./js/surface.js", "./js/app.js",
        "./registry.json", "./places.json", "./manifest.webmanifest")
ICON_RE = re.compile(r"icons/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|svg|webp)")

CACHE_RE = re.compile(r'^const CACHE = PREFIX \+ "([0-9a-f]{12})";$', re.M)
LIST_RE = re.compile(r"^const SHELL = \[\n(?:  \"[^\"\n]+\",\n)*\];$", re.M)


def precache():
    """The precache list, in order: the base files, then the icons the manifest names, in its order."""
    out = list(BASE)
    try:
        icons = json.loads((SHELL / "manifest.webmanifest").read_text(encoding="utf-8")).get("icons", [])
    except (OSError, ValueError, AttributeError, RecursionError) as e:
        raise ValueError("manifest.webmanifest cannot be read: " + str(e))
    for icon in icons if isinstance(icons, list) else [None]:
        src = icon.get("src") if isinstance(icon, dict) else None
        if not isinstance(src, str) or not ICON_RE.fullmatch(src):
            raise ValueError("the manifest names an icon that is not a plain file in icons/: " + repr(src))
        if "./" + src not in out:
            out.append("./" + src)
    return out


def path_of(rel):
    return SHELL / ("index.html" if rel == "./" else rel[2:])


def stamp(paths):
    h = hashlib.sha256()
    for rel in paths:
        if rel == "./":
            continue                      # the same file as ./index.html
        h.update(rel.encode("utf-8") + b"\0")
        h.update(path_of(rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:12]


def render(text, paths, st):
    if not CACHE_RE.search(text):
        raise ValueError("sw.js has no CACHE line to stamp")
    if not LIST_RE.search(text):
        raise ValueError("sw.js has no SHELL list to rewrite")
    lst = "const SHELL = [\n" + "".join('  "%s",\n' % p for p in paths) + "];"
    text = LIST_RE.sub(lambda m: lst, text, count=1)
    return CACHE_RE.sub(lambda m: 'const CACHE = PREFIX + "%s";' % st, text, count=1)


def main(argv):
    if argv not in ([], ["--check"]):
        print("usage: stamp.py [--check]", file=sys.stderr)
        return 2
    try:
        paths = precache()
    except ValueError as e:
        print("stamp: " + str(e), file=sys.stderr)
        return 1
    missing = [p for p in paths if not path_of(p).is_file()]
    if missing:
        print("stamp: precached files missing: " + ", ".join(missing), file=sys.stderr)
        return 1
    have = SW.read_text(encoding="utf-8")
    try:
        want = render(have, paths, stamp(paths))
    except ValueError as e:
        print("stamp: " + str(e), file=sys.stderr)
        return 1
    if argv == ["--check"]:
        if have != want:
            print("stamp: sw.js does not match the shell files; run tools/stamp.py", file=sys.stderr)
            return 1
        return 0
    if have == want:
        return 0
    fd, tmp = tempfile.mkstemp(dir=str(SHELL), prefix=".sw-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(want)
        os.chmod(tmp, 0o644)
        os.replace(tmp, SW)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
