#!/usr/bin/env python3
"""Write shell/places.json, the town list (SPEC 9.10a), from the Census Bureau's Gazetteer place file.

The source is the U.S. Census Bureau's 2026 Gazetteer Files, Places (national): one row per city, town,
village, borough and census-designated place, "|"-separated text. Rows outside the 50 states and DC are
left out. Each name loses its kind word ("Joliet city" is JOLIET), accents fold to plain letters, and the
name is upper-cased. A name that fails the city rule of SPEC 6 or names a facility (SPEC 15.35, 15.53) is
dropped, and one row is kept per name and state. Latitude and longitude are stored x 100 as whole numbers
(a town's centre to about a kilometre), then the town's size: the radius, in tenths of a kilometre, of the
circle with the same area as its land (the phone needs it to name the town downtown, SPEC 9.10a). The file is
read as text only.

The source file's path comes only from DOCKREAD_CITY_TABLE (the .zip as published, or its one .txt member),
so no home path is written in this public folder (SPEC 15.35):

    DOCKREAD_CITY_TABLE=<file> python3 shell/tools/mkplaces.py           # write shell/places.json
    DOCKREAD_CITY_TABLE=<file> python3 shell/tools/mkplaces.py --check   # exit 1 if it would differ
    python3 shell/tools/mkplaces.py --check    # no file: check places.json against the rules alone

Standard library only.
"""
import json
import math
import os
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL = HERE.parent
OUT = SHELL / "places.json"
# This file is published, so it carries what is known about the source and nothing about whose it is.
SOURCE_NOTE = "U.S. Census Bureau, 2026 Gazetteer Files, Places (2026_Gaz_place_national.zip)"
LICENCE = "public domain (U.S. Government work)"

CITY_RE = re.compile(r"^[A-Z][A-Z .'-]{0,39}$")   # SPEC 6, place.city
R10_MAX = 5000                                     # 500 km: far past any town's circle; a bigger one is broken

HEADER = ["USPS", "GEOID", "GEOIDFQ", "ANSICODE", "NAME", "LSAD", "FUNCSTAT", "ALAND", "AWATER", "ALAND_SQMI",
          "AWATER_SQMI", "INTPTLAT", "INTPTLONG"]
# The 50 states and DC. Puerto Rico and the island areas are left out: the page is for US docks.
STATES = frozenset("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH "
                   "NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())
# The kind word each LSAD code puts at the end of a name, stripped once. A code not here (and not in REVIEWED)
# is a kind nobody has looked at, so its rows are dropped.
KIND_WORDS = {"25": " city", "43": " town", "47": " village", "21": " borough", "57": " CDP",
              "37": " municipality", "53": " city and borough", "CN": " corporation", "00": ""}
# Names the plain rules would get wrong: consolidated cities, "(balance)" rows, a town known by the name in
# its brackets, a campus. Reviewed by hand against the 2026 file, row by row. (USPS, NAME exactly) -> the
# name to use, or None to drop the row.
REVIEWED = {
    ("CT", "Milford city (balance)"): "MILFORD",
    ("GA", "Athens-Clarke County unified government (balance)"): "ATHENS",
    ("GA", "Augusta-Richmond County consolidated government (balance)"): "AUGUSTA",
    ("GA", "Cusseta-Chattahoochee County unified government"): "CUSSETA",
    ("GA", "Echols County consolidated government"): None,
    # Dropped so the Georgetown CDP by Savannah supplies GEORGETOWN|GA, not this county seat's far centre.
    ("GA", "Georgetown-Quitman County unified government"): None,
    ("GA", "Macon-Bibb County"): "MACON",
    ("GA", "Webster County unified government"): None,
    ("IN", "Indianapolis city (balance)"): "INDIANAPOLIS",
    ("KS", "Greeley County unified government (balance)"): None,
    ("KY", "Lexington-Fayette urban county"): "LEXINGTON",
    # Dropped so the plain "Louisville city" row supplies LOUISVILLE|KY with its downtown centre.
    ("KY", "Louisville/Jefferson County metro government (balance)"): None,
    ("MT", "Anaconda-Deer Lodge County"): "ANACONDA",
    ("MT", "Butte-Silver Bow (balance)"): "BUTTE",
    ("TN", "Hartsville/Trousdale County"): "HARTSVILLE",
    ("TN", "Lynchburg, Moore County metropolitan government"): "LYNCHBURG",
    ("TN", "Nashville-Davidson metropolitan government (balance)"): "NASHVILLE",
    ("AZ", "Village of Oak Creek (Big Park) CDP"): "VILLAGE OF OAK CREEK",
    ("AR", "Fredonia (Biscoe) town"): "BISCOE",
    ("CA", "El Paso de Robles (Paso Robles) city"): "PASO ROBLES",
    ("CA", "San Buenaventura (Ventura) city"): "VENTURA",
    ("CO", "Raymer (New Raymer) town"): "NEW RAYMER",
    ("FL", "Islamorada, Village of Islands village"): "ISLAMORADA",
    ("IL", "Alvan (Alvin) village"): "ALVIN",
    ("NE", "Howard City (Boelus) village"): "BOELUS",
    ("ND", "Canton City (Hensel) city"): "HENSEL",
    ("OH", "Centerville (Thurman) village"): "THURMAN",
    ("OH", "Hartford (Croton) village"): "CROTON",
    ("OH", "Matamoras (New Matamoras) village"): "NEW MATAMORAS",
    ("PA", "Penn State Erie (Behrend) CDP"): None,
    ("PA", "Tharptown (Uniontown) CDP"): "THARPTOWN",
    ("WV", "Addison (Webster Springs) town"): "WEBSTER SPRINGS",
    ("WV", "Bath (Berkeley Springs) town"): "BERKELEY SPRINGS",
    ("WV", "Womelsdorf (Coalton) town"): "COALTON",
    # The name everyone uses.
    ("HI", "Urban Honolulu CDP"): "HONOLULU",
    # Round two: CDPs that are a base, base housing, a campus, a work site, a mall, a developer's community, a
    # resort, a club, an institution or a park, not a town. Dropped by state and name, not by a word rule,
    # because the same words name real towns elsewhere (STANFORD, KY; COUNTRY CLUB, MO; GOLF, IL).
    ("CA", "March ARB CDP"): None,
    ("VA", "Dahlgren Center CDP"): None,
    ("HI", "Iroquois Point CDP"): None,
    ("NY", "SUNY Oswego CDP"): None,
    ("PA", "Penn State Berks CDP"): None,
    ("MS", "Mississippi State CDP"): None,
    ("IN", "Notre Dame CDP"): None,
    ("CA", "Stanford CDP"): None,
    ("NY", "St. Bonaventure CDP"): None,
    ("IN", "St. Mary of the Woods CDP"): None,
    ("AK", "Prudhoe Bay CDP"): None,
    ("NM", "Napi Headquarters CDP"): None,
    ("NM", "North Light Plant CDP"): None,
    ("AK", "Whitestone Logging Camp CDP"): None,
    ("CA", "Woodville Farm Labor Camp CDP"): None,
    ("NJ", "Cherry Hill Mall CDP"): None,
    ("VA", "One Loudoun CDP"): None,
    ("NJ", "Encore at Monroe CDP"): None,
    ("NJ", "Regency at Monroe CDP"): None,
    ("NJ", "Renaissance at Monroe CDP"): None,
    ("NJ", "Pine Ridge at Crestwood CDP"): None,
    ("NM", "Eldorado at Santa Fe CDP"): None,
    ("PA", "Homewood at Martinsburg CDP"): None,
    ("CA", "Silverado Resort CDP"): None,
    ("HI", "Waikoloa Beach Resort CDP"): None,
    ("FL", "Lely Resort CDP"): None,
    ("HI", "Volcano Golf Course CDP"): None,
    ("TX", "Boys Ranch CDP"): None,
    ("KS", "Kickapoo Tribal Center CDP"): None,
    ("OK", "Elohim City CDP"): None,
    ("AZ", "Pinetop Country Club CDP"): None,
    ("CA", "Bakersfield Country Club CDP"): None,
    ("CA", "Lake Almanor Country Club CDP"): None,
    ("LA", "Bayou Country Club CDP"): None,
    ("MI", "Crystal Downs Country Club CDP"): None,
    ("FL", "Plantation Mobile Home Park CDP"): None,
    ("PA", "Spring Drive Mobile Home Park CDP"): None,
    ("IN", "Lakeshore Resort CDP"): None,
    # The second checker's reading of the names: two malls, a business park on a former air base, club and
    # navy-housing communities, a county government complex, farm labor camps, mobile home parks.
    ("VA", "Dulles Town Center CDP"): None,
    ("VA", "Potomac Mills CDP"): None,
    ("CA", "McClellan Park CDP"): None,
    ("NC", "Governors Club CDP"): None,
    ("CT", "Conning Towers-Nautilus Park CDP"): None,
    ("VA", "County Center CDP"): None,
    ("CT", "Candlewood Lake Club CDP"): None,
    ("CA", "Linnell Camp CDP"): None,
    ("CA", "Rodriguez Camp CDP"): None,
    ("CA", "El Monte Mobile Village CDP"): None,
    ("AZ", "Orange Grove Mobile Manor CDP"): None,
}
ODD_RE = re.compile(r"[(),/0-9]")   # a name with any of these that nobody reviewed is dropped
MAX_TEXT = 50 * 1024 * 1024         # the 2026 file is about 3.3 MB; anything far bigger is not that file

# Facilities are not towns (SPEC 15.35). Whole-word phrases, any case. CAMP, FORT, ACADEMY, YARD and
# BARRACKS alone are left in on purpose: CAMP VERDE, AZ, FORT WORTH, TX and SCHOFIELD BARRACKS, HI are towns.
# test_senses.mjs carries the same rule.
FACILITIES = ["AFB", "AIR FORCE BASE", "ARSENAL", "NAVY YARD", "NAVAL STATION", "NAVAL AIR STATION",
              "NAVAL BASE", "AIR STATION", "PROVING GROUNDS?", "SPACE CENTER", "ARMY DEPOT",
              "ARMY AIRFIELD", "ARMY AIR FIELD", "ARMY AMMUNITION PLANT", "JRB", "MARINE CORPS",
              "COAST GUARD", "AIR NATIONAL GUARD", "ANGB", "AAF",
              # SPEC 15.53: an air reserve base, a navy construction base, a navy annex, the air force
              # academy and an army hospital. Whole phrases, so ACADEMY, ARMY and ANNEX alone stay allowed.
              "AIR RESERVE BASE", "CBC BASE", "NAVAL ANACOST ANNEX", "U S A F ACADEMY", "ARMY MEDICAL CENTER",
              # The Census file names bases, base housing and naval stations its own way. The stations are
              # named whole, so HUNTINGTON STATION, NY stays a town.
              "BASE", "HOUSING", "NAVAL AIR FACILITY", "NAVAL ACADEMY", "AIR FORCE ACADEMY", "HURLBURT FIELD",
              "ATTU STATION", "EARECKSON STATION", "KODIAK STATION", "LEMOORE STATION", "PENSACOLA STATION",
              "NEW ORLEANS STATION", "MERIDIAN STATION", "FALLON STATION", "WHIDBEY ISLAND STATION",
              # An air reserve base by its letters, and a mobile home park: no real town uses either phrase.
              "ARB", "MOBILE HOME PARK"]
# Whole names only: campuses called COLLEGE (STATE COLLEGE, PA and COLLEGE STATION, TX are towns), an
# airport and a mine.
FACILITY_NAMES = ["BERRY COLLEGE", "CROWN COLLEGE", "RAMAPO COLLEGE OF NEW JERSEY", "THE COLLEGE OF NEW JERSEY",
                  "BARD COLLEGE", "HAMILTON COLLEGE", "MARIST COLLEGE", "NAZARETH COLLEGE",
                  "ST. JOHN FISHER COLLEGE", "SIENA COLLEGE", "VASSAR COLLEGE", "HAVERFORD COLLEGE",
                  "MESSIAH COLLEGE", "ST. VINCENT COLLEGE", "ROCHESTER INSTITUTE OF TECHNOLOGY", "AIRPORT",
                  "RED DOG MINE"]
FACILITY_RE = re.compile(
    r"\b(?:" + "|".join(w.replace(" ", r"\s+") for w in FACILITIES) + r")\b"
    + r"|^(?:" + "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in FACILITY_NAMES) + r")$"
    # A campus: a name that is UNIVERSITY or ends in it, or UNIVERSITY OF / AT / - (UNIVERSITY PARK stays).
    + r"|(?:^|\s)UNIVERSITY$|\bUNIVERSITY(?:\s+(?:OF|AT)\s|-)", re.I)


def facility(name):
    return bool(FACILITY_RE.search(name))


def radius10(aland):
    """The radius, in tenths of a km, of the circle whose area is the town's land (ALAND, square metres)."""
    return int(round(math.sqrt(max(aland, 0) / math.pi) / 100))


def read_source(path):
    """The Census file's text: the .txt itself, or the one .txt inside the .zip the Bureau publishes."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            txt = [i for i in z.infolist() if i.filename.lower().endswith(".txt")]
            if len(txt) != 1:
                raise ValueError("the zip holds %d .txt files, not one" % len(txt))
            if txt[0].file_size > MAX_TEXT:
                raise ValueError("the .txt in the zip is too big to be the place file")
            data = z.read(txt[0])
    else:
        with open(path, "rb") as f:
            data = f.read(MAX_TEXT + 1)
        if len(data) > MAX_TEXT:
            raise ValueError("the file is too big to be the place file")
    return data.decode("utf-8-sig")


def town_name(st, name, lsad):
    """(the town name, "") or (None, the rule that drops the row). The reviewed table first; then an odd name
    is dropped; then the kind word goes, accents fold, and the name is upper-cased with single spaces."""
    if (st, name) in REVIEWED:
        made = REVIEWED[(st, name)]
        return (made, "") if made else (None, "reviewed")
    if ODD_RE.search(name):
        return None, "odd"
    if lsad not in KIND_WORDS:
        return None, "lsad"
    kind = KIND_WORDS[lsad]
    if kind and name.endswith(kind) and name[:-len(kind)].strip():
        name = name[:-len(kind)]
    name = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    return re.sub(r" {2,}", " ", name.upper()).strip(), ""


def build(text, drops=None):
    """The rows of places.json from the Census file's text. If `drops` is a dict, each rule that drops a row
    appends it there as "NAME|ST" (the file's name before a name is made, the made name after)."""
    def drop(rule, what):
        if drops is not None:
            drops.setdefault(rule, []).append(what)

    lines = text.splitlines()
    if not lines or [f.strip() for f in lines[0].split("|")] != HEADER:
        raise ValueError("the first line is not the Census place file's header")
    best = {}
    for n, line in enumerate(lines[1:], 2):
        f = [x.strip() for x in line.split("|")]
        try:
            if len(f) != len(HEADER):
                raise ValueError
            aland, lat, lon = int(f[7]), float(f[11]), float(f[12])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):   # also refuses nan
                raise ValueError
        except ValueError:
            drop("bad", "line %d" % n)
            continue
        st, geoid, name, lsad = f[0], f[1], f[4], f[5]
        if st not in STATES:
            drop("state", name + "|" + st)
            continue
        made, rule = town_name(st, name, lsad)
        if rule:
            drop(rule, name + "|" + st)
            continue
        if not CITY_RE.match(made):
            drop("city", made + "|" + st)
            continue
        if facility(made):
            drop("facility", made + "|" + st)
            continue
        # One row per name and state: a real municipality before a census-designated place, then the larger
        # land area, then the smaller GEOID. The smallest rank wins, and its own land gives the radius.
        rank = (lsad == "57", -aland, geoid)
        row = [made, st, int(round(lat * 100)), int(round(lon * 100)), radius10(aland)]
        key = (st, made)
        if key in best:
            drop("same", made + "|" + st)
            if rank >= best[key][0]:
                continue
        best[key] = (rank, row)
    return [best[k][1] for k in sorted(best)]


def render(rows):
    head = json.dumps({"v": 1, "source": SOURCE_NOTE, "licence": LICENCE}, ensure_ascii=False)[:-1]
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    return head + ', "rows": [\n' + body + "\n]}\n"


def check_rules(text):
    """With no source file at hand: the problems with places.json under the rules alone (empty = good)."""
    try:
        d = json.loads(text)
    except ValueError as e:
        return ["places.json does not parse: %s" % e]
    if not isinstance(d, dict) or sorted(d) != ["licence", "rows", "source", "v"]:
        return ["places.json keys are not v, source, licence, rows"]
    bad = []
    if d["v"] != 1:
        bad.append("v is not 1")
    if d["source"] != SOURCE_NOTE:
        bad.append("the source line is not %r" % SOURCE_NOTE)
    if d["licence"] != LICENCE:
        bad.append("the licence line is not %r" % LICENCE)
    rows = d["rows"] if isinstance(d["rows"], list) else []
    if not rows:
        bad.append("no rows")
    prev = None
    for r in rows:
        ok = (isinstance(r, list) and len(r) == 5 and isinstance(r[0], str) and CITY_RE.match(r[0])
              and isinstance(r[1], str) and r[1] in STATES
              and all(isinstance(x, int) and not isinstance(x, bool) for x in r[2:])
              and abs(r[2]) <= 9000 and abs(r[3]) <= 18000 and 0 <= r[4] <= R10_MAX)
        if not ok:
            bad.append("bad row %r" % (r,))
            continue
        if facility(r[0]):
            bad.append("facility row %s|%s" % (r[0], r[1]))
        if prev is not None and (r[1], r[0]) <= prev:
            bad.append("out of order or repeated at %s|%s" % (r[0], r[1]))
        prev = (r[1], r[0])
    if text != render(rows) and not bad:
        bad.append("places.json is not in the form mkplaces.py writes")
    return bad


def main(argv):
    source = os.environ.get("DOCKREAD_CITY_TABLE")
    if not source:
        if "--check" not in argv:
            print("mkplaces: set DOCKREAD_CITY_TABLE to the Census place file to write places.json",
                  file=sys.stderr)
            return 1
        bad = check_rules(OUT.read_text(encoding="utf-8")) if OUT.exists() else ["places.json is missing"]
        for b in bad[:20]:
            print("mkplaces: " + b, file=sys.stderr)
        print("mkplaces: places.json " + ("passes the rules" if not bad else "fails %d rule(s)" % len(bad)))
        return 0 if not bad else 1
    drops = {}
    try:
        rows = build(read_source(source), drops)
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        print("mkplaces: the Census place file cannot be used: %s" % e, file=sys.stderr)
        return 1
    text = render(rows)
    json.loads(text)   # must parse
    if "--check" in argv:
        same = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("mkplaces: " + ("places.json matches" if same else "places.json differs"))
        return 0 if same else 1
    tmp = OUT.with_name(OUT.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, OUT)
    print("mkplaces: wrote %d towns" % len(rows))
    for rule in sorted(drops):
        print("mkplaces: left out (%s) %d" % (rule, len(drops[rule])))
    for rule in ("bad", "lsad", "city", "facility"):
        for k in drops.get(rule, []):
            print("mkplaces: left out (%s) %s" % (rule, k))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
