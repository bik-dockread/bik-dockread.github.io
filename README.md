# Dock Read: the phone page

Ask the dock. Read the economy.

One question rides from one official number to the next. A driver asks it out loud at each loading dock
and thumbs up or down. A needle moves on a dial. When the number prints he calls the next one, says why
in one breath, and the next print grades the call.

This folder is the whole page: plain files, no build step, no packages. It works with no signal: the
phone keeps the book. A small home service, which is not in this repo, keeps a copy of the book and
fetches the official numbers. The page reaches it only through a connect link.

- `index.html` is written by `tools/mkindex.py`. Do not edit it by hand.
- After changing any file the phone caches, run `python3 tools/stamp.py`. It rewrites the cache name in
  `sw.js` from the files' contents, so a phone updates by itself. `tools/test_shell.py` fails if you forget.
- Tests: `python3 tools/test_shell.py` (static checks plus the five Node suites). The end-to-end walks
  (`tools/walk.mjs`, `tools/walk2.mjs`) also need the home service.
- The town list `places.json` is built by `tools/mkplaces.py` from the U.S. Census Bureau's 2026 Gazetteer
  Places file, which is public domain. A place is a town and a state, never more.
- There is no icon yet.

Never put in this folder: a key, a connect link, a coordinate, or anyone's words.
