#!/usr/bin/env python3
"""test_shell.py: the shell's rules, read from the files (SPEC 9.1, 9.10, 9.10a, 9.12).

  - the CSP meta is the first tag in the head and is the SPEC's, exactly (read from docs/SPEC.md);
  - no inline script, style or handler in the page; the six scripts in the SPEC's order, all defer;
  - no innerHTML, outerHTML, insertAdjacentHTML, document.write, cssText or setAttribute('style') in any
    shell file;
  - every id a script looks up exists once in the page; every button has type and aria-label;
  - tools/mkindex.py --check and tools/stamp.py --check pass; every precached path exists; the service
    worker's rules; the manifest is the SPEC's;
  - node --check on every script; the five Node suites run and their return codes are read;
  - every row of places.json is a name, a state, two whole numbers and a radius, and every name passes the
    city rule;
    mkplaces.py --check passes with no city table (no facility rows, sorted, the source line);
  - mkplaces.py turns a made-up Census-shaped file into exactly the rows its rules say, from a .zip or a .txt;
    places.json carries the Census source and licence lines and no Puerto Rico row;
  - no script but geo.js names a coordinate or a position API (rule 0.3);
  - no string in app.js or surface.js says HIS (SPEC 15.10);
  - no file the shell repo tracks names a person, a home path or another project (SPEC 15.35);
  - no commit in the shell repo's history does either, and every commit e-mail is a no-reply one (SPEC 15.54);
    nor does any annotated tag's name or message, and every tagger e-mail is a no-reply one.

No network, no browser, nothing written outside throwaway temp folders (one repo, one pair of town files).
Run: python3 shell/tools/test_shell.py
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from html.parser import HTMLParser
from pathlib import Path

SHELL = Path(__file__).resolve().parent.parent
TOOLS = SHELL / "tools"
SPEC = SHELL.parent / "docs" / "SPEC.md"
INDEX = (SHELL / "index.html").read_text(encoding="utf-8")
SW = (SHELL / "sw.js").read_text(encoding="utf-8")
SCRIPTS = ("js/core.js", "js/store.js", "js/geo.js", "js/sound.js", "js/surface.js", "js/app.js")
SUITES = ("test_core.mjs", "test_store.mjs", "test_senses.mjs", "test_surface.mjs", "test_app.mjs")
NODE = shutil.which("node") or "/opt/homebrew/bin/node"
PY = sys.executable
CITY_RE = re.compile(r"^[A-Z][A-Z .'-]{0,39}$")
ST_RE = re.compile(r"^[A-Z]{2}$")
SINKS = ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "cssText")


def spec_csp():
    """The CSP exactly as SPEC 9.1 writes it (one backticked span that wraps over lines)."""
    text = SPEC.read_text(encoding="utf-8")
    at = text.index("First tag in the head is the CSP meta:")
    m = re.search(r"`(default-src[^`]*)`", text[at:at + 800])
    if not m:
        raise AssertionError("could not find the CSP in docs/SPEC.md 9.1")
    return re.sub(r"\s*\n\s*", " ", m.group(1)).strip()


def shell_files():
    """Every shell file a phone loads: the page, the stylesheet, the scripts, the worker."""
    out = [SHELL / "index.html", SHELL / "app.css", SHELL / "sw.js"]
    out += sorted((SHELL / "js").glob("*.js"))
    return out


def js_strings(text):
    """Every string literal in a script ('...', "...", and the plain parts of `...`), comments skipped.

    A small reader, not a parser: it knows strings, template literals and both kinds of comment, and takes a
    '/' after an operator or an opening bracket as the start of a regex literal (skipped to its closing '/')."""
    out, i, n, prev = [], 0, len(text), ""
    while i < n:
        c = text[i]
        if c == "/" and text[i + 1:i + 2] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and text[i + 1:i + 2] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^"):
            j, cls = i + 1, False
            while j < n and text[j] != "\n":
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "[":
                    cls = True
                elif text[j] == "]":
                    cls = False
                elif text[j] == "/" and not cls:
                    break
                j += 1
            i, prev = j + 1, "x"
            continue
        if c in "'\"`":
            j, buf = i + 1, []
            while j < n and text[j] != c:
                if text[j] == "\\":
                    buf.append(text[j:j + 2])
                    j += 2
                    continue
                if c == "`" and text[j:j + 2] == "${":
                    depth, j = 1, j + 2
                    while j < n and depth:
                        depth += {"{": 1, "}": -1}.get(text[j], 0)
                        j += 1
                    buf.append(" ")
                    continue
                buf.append(text[j])
                j += 1
            out.append("".join(buf))
            i, prev = j + 1, "x"
            continue
        if not c.isspace():
            prev = c
        i += 1
    return out


# SPEC 15.35: words no file in the public folder may hold (any case). Spelled in pieces so this file passes.
PRIVATE = [re.compile(p, re.I) for p in (
    "/" + "users" + "/", "bry" + "an" + "hertzig", "alma" + "nac", "theai" + "trucker", "goo" + "se",
    "bmh" + "solutions", r"\b" + "bry" + "an" + r"\b")]


def public_files():
    """Every file the shell repo tracks, plus any new file it would take (not ignored)."""
    r = subprocess.run(["git", "-C", str(SHELL), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                       capture_output=True, timeout=60)
    if r.returncode != 0:
        raise AssertionError("git ls-files failed in shell/: " + r.stderr.decode("utf-8", "replace")[:200])
    return sorted({p for p in r.stdout.decode("utf-8").split("\0") if p})


# A town row of places.json as a patch line shows it: ' ', '+' or '-', then ["NAME","ST",lat,lon,r10] and a
# comma. Older commits carry rows without the radius, so it is optional here.
PATCH_ROW = re.compile(r'^[-+ ]\["([^"]*)","([A-Z]{2})",-?\d+,-?\d+(?:,\d+)?\],?$')
NOREPLY = "@users.noreply.github.com"
CENSUS_SOURCE = '"source": "U.S. Census Bureau, '


def history_hits(repo):
    """SPEC 15.54: what the repo's history at `repo` would publish that 15.35 refuses (empty = clean).

    Every commit on every ref: its message and every line of its patch (all files read as text, so a binary
    file is read too) are scanned for the PRIVATE words; places.json's town rows are left out as the file
    rule leaves them out, and its header line is scanned. Every author and committer e-mail must be a GitHub
    no-reply address. The author name is not read: it is the owner's own. Every annotated tag's name and
    message are scanned the same way and its tagger e-mail must be no-reply too. Hits name the commit (or the
    tag object) and the place, never the text found."""
    def git(*args):
        r = subprocess.run(["git", "-C", str(repo), "-c", "core.quotepath=off", *args], capture_output=True,
                           timeout=300)
        if r.returncode != 0:
            raise AssertionError("git %s failed: %s" % (args[0], r.stderr.decode("utf-8", "replace")[:200]))
        return r.stdout.decode("utf-8", "replace")

    hits = []
    for line in git("log", "--all", "--format=%h%x00%ae%x00%ce").splitlines():
        sha, author, committer = line.split("\0")
        for who, mail in (("author", author), ("committer", committer)):
            if not mail.lower().endswith(NOREPLY):
                hits.append(f"commit {sha}: {who} e-mail is not a no-reply address")
    # Each commit starts with \x01 and its message ends with \x02; the patch follows. -m shows a merge's own
    # changes too, so nothing can hide in a merge.
    log = git("log", "--all", "-p", "-m", "--text", "--no-renames", "--no-color", "--no-ext-diff",
              "--format=%x01%h%n%B%x02")
    for chunk in log.split("\x01")[1:]:
        sha, _, rest = chunk.partition("\n")
        message, _, patch = rest.partition("\x02")
        for rx in PRIVATE:
            if rx.search(message):
                hits.append(f"commit {sha}: message")
                break
        where, town_file = "", False
        for n, pl in enumerate(patch.splitlines(), 1):
            if pl.startswith("diff --git "):
                where = pl[len("diff --git "):]
                town_file = where == "a/places.json b/places.json"
            if town_file:
                m = PATCH_ROW.match(pl)
                if m and CITY_RE.match(m.group(1)):
                    continue
                # SPEC 15.65: the first town list had no recorded source or licence. A push publishes every
                # commit, so no commit may add a places.json that is not the Census Bureau's.
                if pl.startswith('+{"v"') and CENSUS_SOURCE not in pl:
                    hits.append(f"commit {sha}: places.json is not the Census town list")
            if any(rx.search(pl) for rx in PRIVATE):
                hits.append(f"commit {sha}: {where or 'patch'} (patch line {n})")
    # A push with --tags publishes each annotated tag too: its name, message and tagger e-mail. A lightweight
    # tag is only a name on a commit (objecttype commit) and has no message or tagger. Named by the tag
    # object's sha, so a hit never repeats a word it found.
    refs = git("for-each-ref", "refs/tags",
               "--format=%(objecttype)%00%(objectname:short)%00%(refname:short)%00%(taggeremail)%00%(contents)%01")
    for rec in refs.split("\x01"):
        rec = rec.lstrip("\n")
        if not rec:
            continue
        kind, sha, name, mail, message = rec.split("\0", 4)
        if kind != "tag":
            continue
        if any(rx.search(name) or rx.search(message) for rx in PRIVATE):
            hits.append(f"tag {sha}: name or message")
        if not mail.strip().strip("<>").lower().endswith(NOREPLY):
            hits.append(f"tag {sha}: tagger e-mail is not a no-reply address")
    return hits


class Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        self.in_head = False

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs), self.in_head))
        if tag == "head":
            self.in_head = True

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False


def tags():
    p = Tags()
    p.feed(INDEX)
    return p.tags


class TestPage(unittest.TestCase):
    def test_csp_is_first_and_exact(self):
        head = [(t, a) for t, a, h in tags() if h]
        self.assertTrue(head, "the head has tags")
        tag, attrs = head[0]
        self.assertEqual(tag, "meta", "the first tag in the head is the CSP meta")
        self.assertEqual(attrs.get("http-equiv"), "Content-Security-Policy")
        self.assertEqual(attrs.get("content"), spec_csp())
        self.assertEqual(len(re.findall(r"Content-Security-Policy", INDEX)), 1)

    def test_no_inline_anything(self):
        for m in re.finditer(r"<script\b([^>]*)>(.*?)</script>", INDEX, re.S):
            self.assertIn("src=", m.group(1), "every script is a file")
            self.assertEqual(m.group(2).strip(), "", "no inline script")
        self.assertNotRegex(INDEX, r"<style\b")
        self.assertNotRegex(INDEX, r"\sstyle\s*=")
        self.assertNotRegex(INDEX, r"\son[a-z]+\s*=")
        self.assertNotRegex(INDEX, r"javascript:")

    def test_scripts_in_order_all_defer(self):
        found = [(a.get("src"), "defer" in a) for t, a, _ in tags() if t == "script"]
        self.assertEqual([s for s, _ in found], list(SCRIPTS))
        self.assertTrue(all(d for _, d in found), "every script is defer")

    def test_page_metas(self):
        metas = {a.get("name"): a.get("content") for t, a, _ in tags() if t == "meta" and a.get("name")}
        self.assertEqual(metas.get("viewport"),
                         "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content")
        self.assertEqual(metas.get("theme-color"), "#0D0B09")
        self.assertEqual(metas.get("color-scheme"), "dark")
        self.assertEqual(metas.get("referrer"), "no-referrer")

    def test_no_forbidden_sinks_in_any_shell_file(self):
        for f in shell_files():
            text = f.read_text(encoding="utf-8")
            for sink in SINKS:
                self.assertNotIn(sink, text, f"{f.name} uses {sink}")
            self.assertNotRegex(text, r"setAttribute\(\s*['\"]style['\"]", f"{f.name} sets a style attribute")

    def test_every_id_a_script_looks_up_exists_once(self):
        ids = re.findall(r'\bid="([^"]+)"', INDEX)
        self.assertEqual(len(ids), len(set(ids)), "ids are unique")
        wanted = set()
        for f in sorted((SHELL / "js").glob("*.js")):
            text = f.read_text(encoding="utf-8")
            wanted |= set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]", text))
            wanted |= set(re.findall(r"querySelector(?:All)?\(\s*['\"]#([\w-]+)['\"]", text))
        self.assertIn("dr", wanted, "surface looks up #dr")
        for i in sorted(wanted):
            self.assertEqual(ids.count(i), 1, f"id {i!r} must exist once in index.html")

    def test_every_button_has_type_and_label(self):
        for t, a, _ in tags():
            if t == "button":
                self.assertEqual(a.get("type"), "button")
                self.assertIn("aria-label", a)
        for f in sorted((SHELL / "js").glob("*.js")):
            text = f.read_text(encoding="utf-8")
            if re.search(r"['\"]button['\"]\s*,", text) and "createElement" in text:
                self.assertIn("setAttribute('type', 'button')", text, f"{f.name} makes buttons without a type")
                self.assertIn("setAttribute('aria-label'", text, f"{f.name} makes buttons without a label")

    def test_mkindex_check(self):
        r = subprocess.run([PY, str(TOOLS / "mkindex.py"), "--check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_no_script_but_geo_touches_a_coordinate(self):
        # Rule 0.3: coordinates live only inside geo.js. core.js names the refused keys once, in the list
        # DR.validate refuses them by; that one line is the only exception.
        refused_list = "var BANNED = ['lat', 'lon', 'lng', 'coords', 'accuracy', 'address', 'zip', 'street'];"
        names = sorted(f.name for f in (SHELL / "js").glob("*.js"))
        self.assertIn("geo.js", names)
        self.assertEqual(len(names), 6, names)
        for f in sorted((SHELL / "js").glob("*.js")):
            if f.name == "geo.js":
                continue
            text = f.read_text(encoding="utf-8")
            if f.name == "core.js":
                self.assertEqual(text.count(refused_list), 1, "core.js keeps its refused-key list")
                text = text.replace(refused_list, "")
            self.assertNotRegex(text, r"\b(lat|lon|lng|coords|latitude|longitude|accuracy|getCurrentPosition|"
                                      r"watchPosition|clearWatch|geolocation)\b", f"{f.name} names a coordinate")

    def test_nothing_but_a_card_can_scroll(self):
        """An overflow: hidden box still scrolls when a script, a focus or a screen reader asks it
        to, and a finger cannot scroll it back: the whole instrument would sit shifted. So every
        such box also says overflow: clip, which cannot scroll at all. (html and body carry the
        page's own overflow and are left alone; a card's overflow-y: auto is meant to scroll.)"""
        css = re.sub(r"/\*.*?\*/", "", (SHELL / "app.css").read_text(encoding="utf-8"), flags=re.S)
        bad = []
        for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            sel = " ".join(sel.split())
            if sel == "html, body":
                continue
            decl = [d.strip() for d in body.split(";") if d.strip().startswith("overflow")]
            if "overflow: hidden" in decl and (not decl or decl[-1] != "overflow: clip"):
                bad.append(sel)
        self.assertEqual(bad, [], "these can be scrolled sideways and not scrolled back")

    def test_no_on_screen_string_says_his(self):
        # SPEC 15.10: copy speaks to him. No string in app.js or surface.js (where every on-screen word is
        # written) holds the word HIS, in any case. Comments are not on screen and are skipped.
        for name in ("app.js", "surface.js"):
            strings = js_strings((SHELL / "js" / name).read_text(encoding="utf-8"))
            self.assertGreater(len(strings), 50, f"{name}: the string reader found its strings")
            bad = [s for s in strings if re.search(r"\bhis\b", s, re.I)]
            self.assertEqual(bad, [], f"{name} has on-screen text with HIS")
        self.assertIn("PLAY YOUR WHY", js_strings((SHELL / "js" / "app.js").read_text(encoding="utf-8")))


class TestWorker(unittest.TestCase):
    def precache(self):
        m = re.search(r"^const SHELL = \[\n((?:  \"[^\"\n]+\",\n)*)\];$", SW, re.M)
        self.assertIsNotNone(m, "sw.js has a SHELL list")
        return re.findall(r'"([^"]+)"', m.group(1))

    def test_stamp_check(self):
        r = subprocess.run([PY, str(TOOLS / "stamp.py"), "--check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_every_precached_path_exists(self):
        paths = self.precache()
        want = ["./", "./index.html", "./app.css"] + ["./" + s for s in SCRIPTS] + \
               ["./registry.json", "./places.json", "./manifest.webmanifest"]
        self.assertEqual(paths[:len(want)], want, "the SPEC's precache list, in order")
        for p in paths[len(want):]:
            self.assertTrue(p.startswith("./icons/"), f"only icons may follow: {p}")
        for p in paths:
            f = SHELL / ("index.html" if p == "./" else p[2:])
            self.assertTrue(f.is_file(), f"precached {p} is missing")

    def test_worker_rules(self):
        self.assertIn('const PREFIX = "dockread-shell-";', SW)
        self.assertRegex(SW, r'const CACHE = PREFIX \+ "[0-9a-f]{12}";')
        self.assertIn('cache: "reload"', SW, "install fetches past the HTTP cache")
        self.assertIn("if (!r.ok) throw", SW, "install is all or nothing")
        self.assertIn("self.skipWaiting()", SW)
        self.assertIn("k.startsWith(PREFIX) && k !== CACHE", SW, "activate deletes only its own old caches")
        self.assertIn("self.clients.claim()", SW)
        self.assertIn('req.method !== "GET"', SW)
        self.assertIn("u.origin !== self.location.origin", SW, "never cross-origin")
        self.assertIn('"/api/"', SW, "never anything under /api/")
        self.assertIn("SHELL.indexOf(rel) === -1", SW, "listed files only")
        self.assertIn('e.data.type === "VERSION"', SW)
        self.assertNotIn("importScripts", SW)
        r = subprocess.run([NODE, "--check", str(SHELL / "sw.js")], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_app_registers_the_worker_as_the_spec_says(self):
        app = (SHELL / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("register('sw.js', { scope: './', updateViaCache: 'none' })", app)
        self.assertIn("controllerchange", app)

    def test_manifest(self):
        m = json.loads((SHELL / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(m, {
            "id": "/", "name": "Dock Read", "short_name": "Dock Read",
            "description": "Ask the dock. Read the economy.", "start_url": "./", "scope": "./",
            "display": "standalone", "orientation": "portrait",
            "background_color": "#0D0B09", "theme_color": "#0D0B09", "icons": [],
        })


class TestScripts(unittest.TestCase):
    def test_node_check_every_script(self):
        for s in SCRIPTS:
            r = subprocess.run([NODE, "--check", str(SHELL / s)], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, f"{s}: {r.stderr}")

    def test_the_five_node_suites(self):
        for s in SUITES:
            with self.subTest(suite=s):
                path = TOOLS / s
                self.assertTrue(path.is_file(), f"{s} is missing")
                r = subprocess.run([NODE, str(path)], capture_output=True, text=True, timeout=600, cwd=str(SHELL.parent))
                tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-15:])
                self.assertEqual(r.returncode, 0, f"{s} exited {r.returncode}:\n{tail}")


class TestPlaces(unittest.TestCase):
    def test_every_row(self):
        d = json.loads((SHELL / "places.json").read_text(encoding="utf-8"))
        self.assertEqual(d.get("v"), 1)
        self.assertIsInstance(d.get("source"), str)
        self.assertIsInstance(d.get("licence"), str)
        rows = d.get("rows")
        self.assertIsInstance(rows, list)
        self.assertGreater(len(rows), 1000)
        seen = set()
        for r in rows:
            self.assertIsInstance(r, list)
            self.assertEqual(len(r), 5, r)
            name, st, a, b, r10 = r
            self.assertIsInstance(name, str)
            self.assertRegex(name, CITY_RE)
            self.assertIsInstance(st, str)
            self.assertRegex(st, ST_RE)
            for x in (a, b, r10):
                self.assertTrue(isinstance(x, int) and not isinstance(x, bool), r)
            self.assertTrue(0 <= r10 <= 5000, r)
            seen.add(name + "|" + st)
        self.assertIn("JOLIET|IL", seen)

    def test_round_two_rows(self):
        # The second review of the Census names: facilities by state and name, the common name, two centres.
        rows = json.loads((SHELL / "places.json").read_text(encoding="utf-8"))["rows"]
        at = {r[0] + "|" + r[1]: r for r in rows}
        self.assertEqual([k for k in ROUND_TWO_DROPPED if k in at], [], "not towns, still rows")
        for k in ("STANFORD|KY", "COUNTRY CLUB|MO", "GOLF|IL", "MORGAN'S POINT RESORT|TX", "WORLD GOLF VILLAGE|FL",
                  "KO OLINA|HI", "LEISURE WORLD|MD", "HONOLULU|HI", "LOUISVILLE|KY", "GEORGETOWN|GA"):
            self.assertIn(k, at)
        self.assertNotIn("URBAN HONOLULU|HI", at)
        self.assertEqual(at["LOUISVILLE|KY"][2:4], [3822, -8574], "the city row, not the metro balance")
        self.assertEqual(at["GEORGETOWN|GA"][2:4], [3198, -8123], "the CDP by Savannah, not Quitman County")

    def test_mkplaces_rules_hold_with_no_table(self):
        # SPEC 15.35: no facility rows, sorted, no repeats, the source line says only what is known. With
        # DOCKREAD_CITY_TABLE unset, mkplaces.py --check checks the file against its rules alone.
        env = {k: v for k, v in os.environ.items() if k != "DOCKREAD_CITY_TABLE"}
        r = subprocess.run([PY, str(TOOLS / "mkplaces.py"), "--check"], capture_output=True, text=True,
                           timeout=120, env=env)
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-600:])


def load_mkplaces():
    """tools/mkplaces.py as a module, found from this file's own path; no bytecode left in the public folder."""
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("mkplaces", TOOLS / "mkplaces.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# A made-up file in the Census Gazetteer's shape (2026 Places), one row per rule. Names are made up or are
# real town names; coordinates are made up, but for the Honolulu and Louisville rows, which are copied from the
# 2026 file. Some fields carry the file's space padding.
CENSUS_HEAD = "USPS|GEOID|GEOIDFQ|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG"
CENSUS_TEXT = "\n".join([
    CENSUS_HEAD,
    "IL|1700100|1600000US1700100|00000001|Alpha city|25|A|165000000|0|63.707|0.000|41.525051|-88.084567",
    "IL|1700200|1600000US1700200|00000002|Beta town|43|A|0|0|0.000|0.000|40.100000|-89.000000",
    "IL|1700300|1600000US1700300|00000003|Gamma village|47|A|1000|0|0.000|0.000|40.200000|-89.100000",
    "PA|4200100|1600000US4200100|00000004|Delta borough|21|A|1000|0|0.000|0.000|40.500000|-77.500000",
    "IL|1700400|1600000US1700400|00000005|Epsilon CDP|57|S|1000|0|0.000|0.000|40.300000|-89.200000",
    "PA|4200200|1600000US4200200|00000006|Zeta municipality|37|A|1000|0|0.000|0.000|40.600000|-79.800000",
    "AK|0200100|1600000US0200100|00000007|Eta city and borough|53|A|1000|0|0.000|0.000|58.300000|-134.400000",
    "WV|5400100|1600000US5400100|00000008|Theta corporation|CN|A|1000|0|0.000|0.000|39.300000|-77.900000",
    "NV|3200100|1600000US3200100|00000009|Carson City|00|A|1000|0|0.000|0.000|39.150000|-119.740000",
    "ID|1600100|1600000US1600100|00000010|Boise City city|25|A|1000|0|0.000|0.000|43.600000|-116.200000",
    "PR|7200100|1600000US7200100|00000011|Iota zona urbana|62|S|1000|0|0.000|0.000|18.200000|-66.500000",
    "PR|7200200|1600000US7200200|00000012|Kappa city|25|A|1000|0|0.000|0.000|18.300000|-66.600000",
    "GU|6600100|1600000US6600100|00000013|Lambda village|47|A|1000|0|0.000|0.000|13.400000|144.700000",
    "CO|0800100|1600000US0800100|00000014|Cañon City city|25|A|1000|0|0.000|0.000|38.440000|-105.220000",
    "MO|2900100|1600000US2900100|00000015|O'Fallon city|25|A|1000|0|0.000|0.000|38.780000|-90.700000",
    "NC|3700100|1600000US3700100|00000016|Winston-Salem city|25|A|1000|0|0.000|0.000|36.100000|-80.260000",
    "TX|4800100|1600000US4800100|00000017|District 9 CDP|57|S|1000|0|0.000|0.000|31.000000|-97.000000",
    "OH|3900100|1600000US3900100|00000018|Lakeview (Old Town) village|47|A|1000|0|0.000|0.000|40.000000|-83.000000",
    "CA|0600100|1600000US0600100|00000019|San Buenaventura (Ventura) city|25|A|1000|0|0.000|0.000|34.270000|-119.230000",
    "PA|4200300|1600000US4200300|00000020|Penn State Erie (Behrend) CDP|57|S|1000|0|0.000|0.000|42.120000|-79.980000",
    "IN|1800100|1600000US1800100|00000021|Indianapolis city (balance)|00|F|1000|0|0.000|0.000|39.780000|-86.150000",
    "TX|4800200|1600000US4800200|00000022|Lone County unified government|UG|A|1000|0|0.000|0.000|31.100000|-97.100000",
    "GA|1300100|1600000US1300100|00000023|Cusseta-Chattahoochee County unified government|UG|A|1000|0|0.000|0.000"
    "|32.300000|-84.770000",
    "GA|1300200|1600000US1300200|00000024|Echols County consolidated government|CG|A|1000|0|0.000|0.000"
    "|30.700000|-82.890000",
    "FL|1200100|1600000US1200100|00000025|Hurlburt Field CDP|57|S|1000|0|0.000|0.000|30.420000|-86.690000",
    "NJ|3400100|1600000US3400100|00000026|Picatinny Arsenal CDP|57|S|1000|0|0.000|0.000|40.950000|-74.550000",
    "KS|2000100|1600000US2000100|00000027|Basehor city|25|A|1000|0|0.000|0.000|39.130000|-94.930000",
    "HI|1500100|1600000US1500100|00000028|Schofield Barracks CDP|57|S|1000|0|0.000|0.000|21.490000|-158.060000",
    "NY|3600100|1600000US3600100|00000029|Huntington Station CDP|57|S|1000|0|0.000|0.000|40.840000|-73.400000",
    "NY|3600200|1600000US3600200|00000030|Vassar College CDP|57|S|1000|0|0.000|0.000|41.690000|-73.900000",
    "VA|5100100|1600000US5100100|00000031|University of Virginia CDP|57|S|1000|0|0.000|0.000|38.030000|-78.510000",
    "PA|4200400|1600000US4200400|00000032|Penn State University CDP|57|S|1000|0|0.000|0.000|40.800000|-77.860000",
    "TX|4800300|1600000US4800300|00000033|University Park city|25|A|1000|0|0.000|0.000|32.850000|-96.800000",
    "PA|4200500|1600000US4200500|00000034|State College borough|21|A|1000|0|0.000|0.000|40.790000|-77.860000",
    "AK|0200200|1600000US0200200|00000035|Red Dog Mine CDP|57|S|1000|0|0.000|0.000|68.030000|-162.900000",
    "CA|0600200|1600000US0600200|00000036|Airport CDP|57|S|1000|0|0.000|0.000|37.630000|-120.980000",
    "MO|2900200|1600000US2900200|00000037|Airport Drive village|47|A|1000|0|0.000|0.000|37.140000|-94.510000",
    # one name, one state: a real municipality beats a bigger CDP; then the larger land; then the smaller GEOID
    "IL|1700500|1600000US1700500|00000038|Joliet CDP|57|S|99000000|0|38.224|0.000|41.600000|-88.200000",
    "IL|1700600|1600000US1700600|00000039|Joliet city|25|A|1000|0|0.000|0.000|41.520000|-88.080000",
    "CA|0600300|1600000US0600300|00000040|Lakeside CDP|57|S|2000000|0|0.772|0.000|32.850000|-116.920000",
    "CA|0600400|1600000US0600400|00000041|Lakeside CDP|57|S|3000000|0|1.158|0.000|32.860000|-116.930000",
    "OH|3900300|1600000US3900300|00000042|Fairview village|47|A|500|0|0.000|0.000|41.000000|-81.000000",
    "OH|3900200|1600000US3900200|00000043|Fairview village|47|A|500|0|0.000|0.000|41.100000|-81.100000",
    # the city rule: 40 characters pass, 41 do not; a letter that does not fold to A to Z does not
    "TX|4800400|1600000US4800400|00000044|Q" + "u" * 39 + " CDP|57|S|1000|0|0.000|0.000|30.000000|-98.000000",
    "TX|4800500|1600000US4800500|00000045|R" + "u" * 40 + " CDP|57|S|1000|0|0.000|0.000|30.100000|-98.100000",
    "HI|1500200|1600000US1500200|00000046|Kaʻaʻawa CDP|57|S|1000|0|0.000|0.000|21.550000|-157.850000",
    "TX|4800600|1600000US4800600|00000047|Big  Spring city|25|A|1000|0|0.000|0.000|32.240000|-101.470000",
    "TX  |4800700|1600000US4800700|00000048|Odessa city               |25|A|1000|0|0.000|0.000|31.850000|-102.360000   ",
    # one name, one state, the winner FIRST: a rule that lets the later row win would keep the CDP
    "IL|1700700|1600000US1700700|00000049|Moline city|25|A|2000000|0|0.772|0.000|41.500000|-90.510000",
    "IL|1700800|1600000US1700800|00000050|Moline CDP|57|S|50000000|0|19.305|0.000|41.400000|-90.400000",
    # the common name; and a consolidated row dropped, so the plain city row (with its downtown) is the town
    "HI|1571550|1600000US1571550|02630783|Urban Honolulu CDP|57|S|157010065|20284393|60.622|7.832|21.324347"
    "|-157.84764",
    "KY|2148000|1600000US2148000|02404963|Louisville city|25|N|159192984|12488302|61.465|4.822|38.224692|-85.741067",
    "KY|2148006|1600000US2148006|01967434|Louisville/Jefferson County metro government (balance)|00|F|681080338"
    "|30150106|262.967|11.641|38.165376|-85.647377",
    # not towns, dropped by state and name; the same words name a real town in another state, which stays
    "CA|0600500|1600000US0600500|00000051|Stanford CDP|57|S|1000|0|0.000|0.000|37.420000|-122.170000",
    "KY|2100100|1600000US2100100|00000052|Stanford city|25|A|1000|0|0.000|0.000|37.530000|-84.660000",
    "CA|0600600|1600000US0600600|00000053|Bakersfield Country Club CDP|57|S|1000|0|0.000|0.000|35.370000|-118.970000",
    "MO|2900300|1600000US2900300|00000054|Country Club village|47|A|1000|0|0.000|0.000|39.840000|-94.820000",
    "TX|4800800|1600000US4800800|00000055|Sunny Acres Mobile Home Park CDP|57|S|1000|0|0.000|0.000|30.200000"
    "|-97.700000",
    "XX|broken row",
]) + "\n"

CENSUS_ROWS = [
    # the fifth number is the radius in tenths of a km of the circle with the town's land: sqrt(ALAND / pi)
    ["ETA", "AK", 5830, -13440, 0],
    ["LAKESIDE", "CA", 3286, -11693, 10],      # the winner's land (3,000,000 m2), not the loser's (8)
    ["VENTURA", "CA", 3427, -11923, 0],
    ["CANON CITY", "CO", 3844, -10522, 0],
    ["CUSSETA", "GA", 3230, -8477, 0],
    ["HONOLULU", "HI", 2132, -15785, 71],
    ["SCHOFIELD BARRACKS", "HI", 2149, -15806, 0],
    ["BOISE CITY", "ID", 4360, -11620, 0],
    ["ALPHA", "IL", 4153, -8808, 72],          # 165,000,000 m2
    ["BETA", "IL", 4010, -8900, 0],            # no land at all
    ["EPSILON", "IL", 4030, -8920, 0],
    ["GAMMA", "IL", 4020, -8910, 0],
    ["JOLIET", "IL", 4152, -8808, 0],          # the city's 1,000 m2, not the CDP's 99,000,000 (56)
    ["MOLINE", "IL", 4150, -9051, 8],          # the city, listed first
    ["INDIANAPOLIS", "IN", 3978, -8615, 0],
    ["BASEHOR", "KS", 3913, -9493, 0],
    ["LOUISVILLE", "KY", 3822, -8574, 71],     # the city row, not the metro balance
    ["STANFORD", "KY", 3753, -8466, 0],
    ["AIRPORT DRIVE", "MO", 3714, -9451, 0],
    ["COUNTRY CLUB", "MO", 3984, -9482, 0],
    ["O'FALLON", "MO", 3878, -9070, 0],
    ["WINSTON-SALEM", "NC", 3610, -8026, 0],
    ["CARSON CITY", "NV", 3915, -11974, 0],
    ["HUNTINGTON STATION", "NY", 4084, -7340, 0],
    ["FAIRVIEW", "OH", 4110, -8110, 0],
    ["DELTA", "PA", 4050, -7750, 0],
    ["STATE COLLEGE", "PA", 4079, -7786, 0],
    ["ZETA", "PA", 4060, -7980, 0],
    ["BIG SPRING", "TX", 3224, -10147, 0],
    ["ODESSA", "TX", 3185, -10236, 0],
    ["Q" + "U" * 39, "TX", 3000, -9800, 0],
    ["UNIVERSITY PARK", "TX", 3285, -9680, 0],
    ["THETA", "WV", 3930, -7790, 0],
]

CENSUS_DROPS = {
    "state": ["Iota zona urbana|PR", "Kappa city|PR", "Lambda village|GU"],
    "reviewed": ["Penn State Erie (Behrend) CDP|PA", "Echols County consolidated government|GA",
                 "Louisville/Jefferson County metro government (balance)|KY", "Stanford CDP|CA",
                 "Bakersfield Country Club CDP|CA"],
    "odd": ["District 9 CDP|TX", "Lakeview (Old Town) village|OH"],
    "lsad": ["Lone County unified government|TX"],
    "bad": ["line 60"],
    "city": ["R" + "U" * 40 + "|TX", "KAʻAʻAWA|HI"],
    "facility": ["HURLBURT FIELD|FL", "PICATINNY ARSENAL|NJ", "VASSAR COLLEGE|NY", "UNIVERSITY OF VIRGINIA|VA",
                 "PENN STATE UNIVERSITY|PA", "RED DOG MINE|AK", "AIRPORT|CA", "SUNNY ACRES MOBILE HOME PARK|TX"],
    "same": ["JOLIET|IL", "LAKESIDE|CA", "FAIRVIEW|OH", "MOLINE|IL"],
}

# SPEC 15.35 and 15.53: names the facility rule refuses and look-alikes it keeps. test_senses.mjs holds the
# same two lists and checks its mirror of the rule against them.
FACILITY_DROP = [
    "JOINT BASE", "LACKLAND BASE", "NAVY HOUSING", "NAVAL AIR FACILITY", "NAVAL ACADEMY", "AIR FORCE ACADEMY",
    "HURLBURT FIELD", "ATTU STATION", "EARECKSON STATION", "KODIAK STATION", "LEMOORE STATION",
    "PENSACOLA STATION", "NEW ORLEANS STATION", "MERIDIAN STATION", "FALLON STATION", "WHIDBEY ISLAND STATION",
    "UNIVERSITY", "STATE UNIVERSITY", "UNIVERSITY OF VIRGINIA", "UNIVERSITY AT BUFFALO", "UNIVERSITY-PARKSIDE",
    "BERRY COLLEGE", "CROWN COLLEGE", "RAMAPO COLLEGE OF NEW JERSEY", "THE COLLEGE OF NEW JERSEY", "BARD COLLEGE",
    "HAMILTON COLLEGE", "MARIST COLLEGE", "NAZARETH COLLEGE", "ST. JOHN FISHER COLLEGE", "SIENA COLLEGE",
    "VASSAR COLLEGE", "HAVERFORD COLLEGE", "MESSIAH COLLEGE", "ST. VINCENT COLLEGE",
    "ROCHESTER INSTITUTE OF TECHNOLOGY", "AIRPORT", "RED DOG MINE",
    "naval academy", "Vassar College", "State University", "Airport",
    # the list before the Census rebuild
    "PICATINNY ARSENAL", "MARCH AIR RESERVE BASE", "U S A F ACADEMY", "TRIPLER ARMY MEDICAL CENTER",
    # round two: an air reserve base by its letters, and mobile home parks
    "MARCH ARB", "ARB", "PLANTATION MOBILE HOME PARK", "Spring Drive Mobile Home Park",
]
FACILITY_KEEP = [
    "UNIVERSITY PARK", "UNIVERSITY HEIGHTS", "UNIVERSITY CITY", "UNIVERSITY PLACE", "WEST UNIVERSITY PLACE",
    "UNIVERSITY GARDENS", "UNIVERSITY CENTER", "STATE COLLEGE", "RUTHERFORD COLLEGE", "YADKIN COLLEGE",
    "COLLEGE", "COLLEGE STATION", "COLLEGE PARK", "INSTITUTE", "NAVY", "NAPIER FIELD", "HUNTINGTON STATION",
    "SUFFIELD DEPOT", "SUSQUEHANNA DEPOT", "ANNEX", "AIRPORT DRIVE", "SCHOFIELD BARRACKS", "CARLISLE BARRACKS",
    "FORT WORTH", "FORT BRAGG", "CAMP VERDE", "CAMP LEJEUNE", "QUANTICO", "WEST POINT", "BASEHOR",
    "LITTLE RIVER-ACADEMY", "ACADEMY", "ARMY", "BERRY", "AIRPORT HEIGHTS", "RED DOG", "SAAFB",
    "MOBILE", "ANN ARBOR", "HARBOR", "ARBUCKLE", "HOME", "MOBILE HOME", "HOMEPARK",
]


# Round two: CDPs that are a base, a campus, a work site, a mall, a resort, a club or a park, not a town. The
# reviewed table drops each by state and exact Census name (the same words name real towns elsewhere).
ROUND_TWO_CENSUS = [
    ("CA", "March ARB CDP"), ("VA", "Dahlgren Center CDP"), ("HI", "Iroquois Point CDP"), ("NY", "SUNY Oswego CDP"),
    ("PA", "Penn State Berks CDP"), ("MS", "Mississippi State CDP"), ("IN", "Notre Dame CDP"), ("CA", "Stanford CDP"),
    ("NY", "St. Bonaventure CDP"), ("IN", "St. Mary of the Woods CDP"), ("AK", "Prudhoe Bay CDP"),
    ("NM", "Napi Headquarters CDP"), ("NM", "North Light Plant CDP"), ("AK", "Whitestone Logging Camp CDP"),
    ("CA", "Woodville Farm Labor Camp CDP"), ("NJ", "Cherry Hill Mall CDP"), ("VA", "One Loudoun CDP"),
    ("NJ", "Encore at Monroe CDP"), ("NJ", "Regency at Monroe CDP"), ("NJ", "Renaissance at Monroe CDP"),
    ("NJ", "Pine Ridge at Crestwood CDP"), ("NM", "Eldorado at Santa Fe CDP"), ("PA", "Homewood at Martinsburg CDP"),
    ("CA", "Silverado Resort CDP"), ("HI", "Waikoloa Beach Resort CDP"), ("FL", "Lely Resort CDP"),
    ("HI", "Volcano Golf Course CDP"), ("TX", "Boys Ranch CDP"), ("KS", "Kickapoo Tribal Center CDP"),
    ("OK", "Elohim City CDP"), ("AZ", "Pinetop Country Club CDP"), ("CA", "Bakersfield Country Club CDP"),
    ("CA", "Lake Almanor Country Club CDP"), ("LA", "Bayou Country Club CDP"), ("MI", "Crystal Downs Country Club CDP"),
    ("FL", "Plantation Mobile Home Park CDP"), ("PA", "Spring Drive Mobile Home Park CDP"),
    ("IN", "Lakeshore Resort CDP"),
    # found by the second checker: two malls, a business park, clubs, navy housing, labor camps, mobile parks
    ("VA", "Dulles Town Center CDP"), ("VA", "Potomac Mills CDP"), ("CA", "McClellan Park CDP"),
    ("NC", "Governors Club CDP"), ("CT", "Conning Towers-Nautilus Park CDP"), ("VA", "County Center CDP"),
    ("CT", "Candlewood Lake Club CDP"), ("CA", "Linnell Camp CDP"), ("CA", "Rodriguez Camp CDP"),
    ("CA", "El Monte Mobile Village CDP"), ("AZ", "Orange Grove Mobile Manor CDP"),
]
ROUND_TWO_DROPPED = [n[:-len(" CDP")].upper() + "|" + st for st, n in ROUND_TWO_CENSUS]


class TestMkplaces(unittest.TestCase):
    def test_reviewed_round_two(self):
        mk = load_mkplaces()
        self.assertEqual(len(ROUND_TWO_CENSUS), 49)
        self.assertEqual([k for k in ROUND_TWO_CENSUS if k not in mk.REVIEWED or mk.REVIEWED[k] is not None], [],
                         "dropped by state and name")
        self.assertEqual(mk.REVIEWED.get(("HI", "Urban Honolulu CDP")), "HONOLULU")
        self.assertIsNone(mk.REVIEWED.get(("KY", "Louisville/Jefferson County metro government (balance)"), "x"))
        self.assertIsNone(mk.REVIEWED.get(("GA", "Georgetown-Quitman County unified government"), "x"))
        self.assertFalse(hasattr(mk, "ST_RE"), "no dead constant")

    def test_census_text_to_rows(self):
        mk = load_mkplaces()
        drops = {}
        self.maxDiff = None
        self.assertEqual(mk.build(CENSUS_TEXT, drops), CENSUS_ROWS)
        self.assertEqual(drops, CENSUS_DROPS)
        # every line but the header is a row kept or a row dropped by exactly one rule
        self.assertEqual(len(CENSUS_ROWS) + sum(len(v) for v in drops.values()), len(CENSUS_TEXT.splitlines()) - 1)

    def test_zip_and_txt_read_alike(self):
        mk = load_mkplaces()
        with tempfile.TemporaryDirectory(prefix="dockread-towns-") as d:
            txt = Path(d, "places.txt")
            txt.write_text(CENSUS_TEXT, encoding="utf-8")
            zpath = Path(d, "places.zip")
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("places.txt", CENSUS_TEXT.encode("utf-8"))
            self.assertEqual(mk.read_source(str(txt)), CENSUS_TEXT)
            self.assertEqual(mk.read_source(str(zpath)), CENSUS_TEXT)
            self.assertEqual(mk.build(mk.read_source(str(zpath))), CENSUS_ROWS)
            two = Path(d, "two.zip")
            with zipfile.ZipFile(two, "w") as z:
                z.writestr("a.txt", CENSUS_TEXT)
                z.writestr("b.txt", CENSUS_TEXT)
            with self.assertRaises(ValueError):
                mk.read_source(str(two))

    def test_check_rules_wants_five_items(self):
        # A row is name, state, lat x 100, lon x 100 and the radius in tenths of a km, a whole number 0 to 5000.
        mk = load_mkplaces()
        good = [["ALPHA", "IL", 4153, -8808, 72], ["BETA", "IL", 4010, -8900, 0], ["GAMMA", "IL", 4020, -8910, 5000]]
        self.assertEqual(mk.check_rules(mk.render(good)), [])
        for bad in (["BETA", "IL", 4010, -8900], ["BETA", "IL", 4010, -8900, -1], ["BETA", "IL", 4010, -8900, 5001],
                    ["BETA", "IL", 4010, -8900, 1.5], ["BETA", "IL", 4010, -8900, True],
                    ["BETA", "IL", 4010, -8900, "7"], ["BETA", "IL", 4010, -8900, 7, 7]):
            rows = [good[0], bad, good[2]]
            self.assertEqual(mk.check_rules(mk.render(rows)), ["bad row %r" % (bad,)], bad)

    def test_a_file_of_another_shape_is_refused(self):
        mk = load_mkplaces()
        with self.assertRaises(ValueError):
            mk.build(CENSUS_TEXT.replace("INTPTLONG", "LONGITUDE", 1))

    def test_facility_rule_by_group(self):
        mk = load_mkplaces()
        self.assertEqual([n for n in FACILITY_DROP if not mk.facility(n)], [], "refused")
        self.assertEqual([n for n in FACILITY_KEEP if mk.facility(n)], [], "kept")

    def test_real_places_json_header_rules_and_states(self):
        mk = load_mkplaces()
        text = (SHELL / "places.json").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(
            '{"v": 1, "source": "U.S. Census Bureau, 2026 Gazetteer Files, Places (2026_Gaz_place_national.zip)", '
            '"licence": "public domain (U.S. Government work)", "rows": [\n'), text[:200])
        self.assertEqual(mk.check_rules(text), [])
        rows = json.loads(text)["rows"]
        self.assertEqual([r for r in rows if r[1] == "PR"], [])
        self.assertEqual(len({r[1] for r in rows}), 51, "the 50 states and DC")


class TestPublic(unittest.TestCase):
    def test_no_file_names_a_person_a_home_path_or_another_project(self):
        # SPEC 15.35. places.json's rows are real town names (some share a word with a name) and are checked by the
        # city rule instead; everything else in it, and every other file, is read whole.
        self.maxDiff = None
        files = public_files()
        self.assertIn("js/app.js", files)
        self.assertIn("tools/test_shell.py", files)
        hits = []
        for rel in files:
            path = SHELL / rel
            if not path.is_file():
                continue
            text = path.read_bytes().decode("utf-8", "replace")
            if rel == "places.json":
                d = json.loads(text)
                d.pop("rows", None)
                text = json.dumps(d)
            for rx in PRIVATE:
                for m in rx.finditer(text):
                    line = text.count("\n", 0, m.start()) + 1
                    hits.append(f"{rel}:{line}")
        self.assertEqual(hits, [], "files that name a person, a home path or another project")

    def test_history_names_no_person_home_path_or_project(self):
        # SPEC 15.54: a push publishes every commit, so the history must be as clean as the tree.
        if not (SHELL / ".git").exists():
            self.skipTest("shell/ is not a git repo")
        self.maxDiff = None
        self.assertEqual(history_hits(SHELL), [], "commits that name a person, a home path or another project")

    def test_history_refuses_a_town_list_from_another_source(self):
        # SPEC 15.65. Proved on a throwaway repo in a temp folder with a made-up list: a commit that adds a
        # places.json with another source line is a hit even after a later commit replaces it.
        clean = "1+tester" + NOREPLY
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="tester",
                   GIT_AUTHOR_EMAIL=clean, GIT_COMMITTER_NAME="tester", GIT_COMMITTER_EMAIL=clean)
        row = '["JOLIET","IL",4152,-8815,74]'
        with tempfile.TemporaryDirectory(prefix="dockread-src-") as repo:
            def git(*args):
                subprocess.run(["git", "-C", repo, *args], env=env, capture_output=True, check=True, timeout=60)
            git("init", "-q")
            f = Path(repo) / "places.json"
            f.write_text('{"v": 1, "source": "some other table", "licence": "not recorded", "rows": [\n'
                         + row + "\n]}\n", encoding="utf-8")
            git("add", "-A"); git("commit", "-q", "-m", "an old list")
            f.write_text('{"v": 1, ' + CENSUS_SOURCE + '2026 Gazetteer Files, Places (x.zip)", '
                         '"licence": "public domain (U.S. Government work)", "rows": [\n' + row + "\n]}\n",
                         encoding="utf-8")
            git("add", "-A"); git("commit", "-q", "-m", "the census list")
            hits = history_hits(repo)
            self.assertEqual(len(hits), 1, hits)
            self.assertIn("places.json is not the Census town list", hits[0])

    def test_history_reads_annotated_tags(self):
        # A push with --tags publishes each annotated tag's message and tagger e-mail too. Proved on a throwaway
        # repo in a temp folder; made-up words and addresses only.
        clean = "1+tester" + NOREPLY
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="tester",
                   GIT_AUTHOR_EMAIL=clean, GIT_COMMITTER_NAME="tester", GIT_COMMITTER_EMAIL=clean)
        with tempfile.TemporaryDirectory(prefix="dockread-tags-") as repo:
            def git(*args, **more):
                subprocess.run(["git", "-C", repo, *args], env=dict(env, **more), capture_output=True, check=True,
                               timeout=60)
            git("init", "-q")
            Path(repo, "a.txt").write_text("a clean line\n", encoding="utf-8")
            git("add", "a.txt")
            git("commit", "-q", "-m", "a clean commit")
            self.assertEqual(history_hits(repo), [], "the control is clean")
            git("tag", "-a", "v1", "-m", "notes kept in " + "/" + "Users" + "/someone/notes")
            git("tag", "-a", "v2", "-m", "a clean note", GIT_COMMITTER_EMAIL="someone@example.com")
            git("tag", "v3")                          # lightweight: no message, no tagger, nothing to read
            hits = history_hits(repo)
        self.assertEqual(len(hits), 2, hits)
        self.assertTrue(hits[0].startswith("tag ") and hits[0].endswith(": name or message"), hits)
        self.assertTrue(hits[1].startswith("tag ") and hits[1].endswith(": tagger e-mail is not a no-reply address"),
                        hits)
        self.assertFalse(any("someone" in h for h in hits), "a hit never repeats the text it found")


if __name__ == "__main__":
    unittest.main(verbosity=2)
