/* DOCK READ service worker (SPEC 9.10, 15.29).

   WHAT IT IS FOR: the page opens with no signal. Every shell file is precached at install, so docks,
   breaths, calls and turns all work in a dead zone.

   WHAT IT NEVER DOES:
   - It never touches /api/ or any other origin. Home's answers go straight to the network.
   - It never caches anything outside the SHELL list below.

   CACHE-FIRST, VERSIONED. The stamp in CACHE is written by tools/stamp.py: the first 12 hex of a sha-256
   over every precached file. Any change to a shell file changes the cache name, so a phone updates by
   itself. tools/stamp.py --check fails when this file does not match the files.
   - install fetches with cache: "reload", so the browser's HTTP cache never slips an old file into a new
     version, and asks for each file as ?v=<stamp>, an address no host's edge cache has seen, so a deploy
     half spread across the host cannot pin a mix of old and new files under the new stamp. Each file is
     stored under its plain address, the one the page asks for;
   - install is all or nothing: one missed file fails it, and the old version stays whole and live. */
const PREFIX = "dockread-shell-";
const CACHE = PREFIX + "8feff3fc44b6";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./js/core.js",
  "./js/store.js",
  "./js/geo.js",
  "./js/sound.js",
  "./js/surface.js",
  "./js/app.js",
  "./registry.json",
  "./places.json",
  "./manifest.webmanifest",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u =>
        fetch(u + (u.includes("?") ? "&" : "?") + "v=" + CACHE.slice(PREFIX.length), { cache: "reload" }).then(r => {
          if (!r.ok) throw new Error("dockread shell fetch failed: " + u + " " + r.status);
          return c.put(u, r);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  // Only our own old versions: CacheStorage is shared by everything on this origin.
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIX) && k !== CACHE)
                                .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The version that cannot lie: the page asks, the worker answers with what is actually installed.
self.addEventListener("message", e => {
  if (e.data && e.data.type === "VERSION" && e.source) {
    e.source.postMessage({ type: "VERSION", version: CACHE });
  }
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;       // another origin: never cached, never answered
  if (u.pathname.indexOf("/api/") !== -1) return;      // home's answers: never cached
  const base = new URL(self.registration.scope).pathname;
  if (!u.pathname.startsWith(base)) return;            // outside the scope
  let rel = "./" + u.pathname.slice(base.length);
  if (rel === "./index.html") rel = "./";              // one copy of the page, under the scope root
  if (SHELL.indexOf(rel) === -1) return;               // not a shell file: the network, uncached
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(rel))
      .then(hit => hit || fetch(req))
  );
});
