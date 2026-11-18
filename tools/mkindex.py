#!/usr/bin/env python3
"""Write shell/index.html from the template below (SPEC 9.1). Never edit index.html by hand.

  python3 tools/mkindex.py           write index.html
  python3 tools/mkindex.py --check   exit 0 if index.html on disk matches the template, else 1; writes nothing

The page is a shell: one <div id="dr">. surface.js builds the frame inside it with createElement, so the page
holds no inline script, no inline style and no handler. The CSP meta is the first tag in the head, exactly as
SPEC 9.1 gives it. Six deferred scripts in the SPEC's order.
"""
import os
import sys
import tempfile
from pathlib import Path

SHELL = Path(__file__).resolve().parent.parent
OUT = SHELL / "index.html"

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; "
       "connect-src 'self' https://*.ts.net:8660 http://127.0.0.1:8660 http://localhost:8660; worker-src 'self'; "
       "manifest-src 'self'")

SCRIPTS = ("js/core.js", "js/store.js", "js/geo.js", "js/sound.js", "js/surface.js", "js/app.js")

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0D0B09">
<meta name="color-scheme" content="dark">
<title>Dock Read</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-maskable-512.png">
<link rel="stylesheet" href="app.css">
{scripts}
</head>
<body>
<div id="dr" class="dr rolling"></div>
<noscript><p>DOCK READ NEEDS JAVASCRIPT.</p></noscript>
</body>
</html>
"""


def page():
    scripts = "\n".join('<script src="%s" defer></script>' % s for s in SCRIPTS)
    return TEMPLATE.format(csp=CSP, scripts=scripts)


def main(argv):
    want = page()
    if argv == ["--check"]:
        try:
            have = OUT.read_text(encoding="utf-8")
        except OSError:
            print("mkindex: index.html is missing", file=sys.stderr)
            return 1
        if have != want:
            print("mkindex: index.html does not match the template; run tools/mkindex.py", file=sys.stderr)
            return 1
        return 0
    if argv:
        print("usage: mkindex.py [--check]", file=sys.stderr)
        return 2
    fd, tmp = tempfile.mkstemp(dir=str(SHELL), prefix=".index-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(want)
        os.chmod(tmp, 0o644)
        os.replace(tmp, OUT)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
