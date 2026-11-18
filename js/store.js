/* DOCK READ store: the phone's storage, connect and sync (SPEC 9.1, 9.9, 9.11).
   One IIFE; hangs DR.store on window.DR. Loaded after core.js.

   The rule of this file: nothing here ever throws to its caller or blocks the page. Every
   public function answers with a value; a failure is a return value (false, null, [] or
   {ok:false, ...}).

   Where things live:
     localStorage  dockread.cfg    {api, key, device, refused}   (the key; never handed out)
                   dockread.prefs  {muted, towns, guard, setup}
     IndexedDB     dockread v1     events (key id)  : the Event's own fields, plus local marks
                                                       _sent (true) and _refused (<why>) that are
                                                       stripped before an event leaves this file
                                   blobs  (key b)   : {b, blob, mime, ms, home, gone, at}
                                   kv               : cursor, book, mark, state, prints, syncedAt
     Cache         dockread-voice-v1                 : spoken clips, keyed by sha-256 of the text

   Connect reads a one-time link, trades its code for a key, checks the key, then syncs (takeLink,
   apiShape, adopt). Every request goes through call(), and every storage touch through a wrapper
   that turns a failure into a return value. */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var DR = G.DR || (G.DR = {});

  /* ---------- named constants ---------- */

  var PORT = '8660';
  var K_CFG = 'dockread.cfg';
  var K_PREFS = 'dockread.prefs';
  var DB_NAME = 'dockread';
  var DB_VERSION = 1;
  var VOICE_CACHE = 'dockread-voice-v1';
  var SHELL_PREFIX = 'dockread-shell-';
  var PUSH_MAX = 500;                  // events in one push (home's own cap)
  var PUSH_BYTES = 900 * 1024;         // bytes of events in one push (home's body cap is 1 MB)
  var PULL_ROUNDS = 10;                // at most this many pull pages in one sync
  var HOME_MS = 15 * 60000;            // the line reads HOME this long after a good sync
  var AFTER_EVENT_MS = 2000;           // a sync two seconds after any new event
  var EVERY_MS = 5 * 60000;            // and every five minutes while visible
  var CALL_MS = 12000;                 // a plain request's ceiling
  var CHECK_MS = 8000;                 // the health check inside adopt
  var BLOB_MS = 20000;                 // a breath up or down
  var SAY_MS = 20000;                  // a clip from home (cached even when it lands late)
  var REFRESH_MS = 90000;              // the print refresh runs a fetch pass at home
  var VOICE_KEEP = 600;                // clips kept in the voice cache, newest
  var VOICE_WAIT_MS = 2500;            // voiceClip's wait when the caller names none
  var NO_PULL = 9007199254740991;      // a push asks for nothing back: a cursor past any seq
  var PREFS = { muted: false, towns: false, guard: true, setup: false };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
  var TS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i;

  /* ---------- small helpers ---------- */

  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  // Home's mark on its history (SPEC 15.52): [seq, id] of a row home once called its newest.
  function isMark(m) {
    return Array.isArray(m) && m.length === 2 && isInt(m[0]) && m[0] >= 1 &&
           typeof m[1] === 'string' && m[1].length >= 1 && m[1].length <= 64;
  }
  function now() { return Date.now(); }
  function copy(o) { return o === undefined || o === null ? null : JSON.parse(JSON.stringify(o)); }
  function byAtId(a, b) {
    return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  function utf8Len(s) {
    try { return new G.TextEncoder().encode(s).length; } catch (e) { return s.length * 3; }
  }
  function wait(ms) {
    return new Promise(function (res) { try { G.setTimeout(function () { res(null); }, ms); } catch (e) { res(null); } });
  }
  // An event as it leaves this file: its own seven fields, no local marks.
  function strip(e) {
    return { id: e.id, dev: str(e.dev), at: e.at, tz: e.tz, type: e.type,
             round: e.round === undefined ? null : e.round, data: e.data };
  }
  function eventish(e) { return isObj(e) && typeof e.id === 'string' && UUID_RE.test(e.id) && typeof e.type === 'string'; }
  function sameContent(a, b) {
    var c = DR.canonical || JSON.stringify;
    return a.at === b.at && a.tz === b.tz && a.type === b.type && (a.round || null) === (b.round || null) &&
           c(a.data) === c(b.data);
  }

  // Storage that never throws: a blocked store must not take the page down.
  var ls = {
    get: function (k) { try { return G.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { G.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { G.localStorage.removeItem(k); return true; } catch (e) { return false; } }
  };

  /* ---------- listeners ---------- */

  var subs = { change: [], line: [] };
  function on(name, cb) {
    if (!subs[name] || typeof cb !== 'function') return function () {};
    subs[name].push(cb);
    return function () { var i = subs[name].indexOf(cb); if (i >= 0) subs[name].splice(i, 1); };
  }
  function emit(name, arg) {
    (subs[name] || []).slice().forEach(function (cb) { try { cb(arg); } catch (e) {} });
  }

  /* ---------- memory: what the synchronous answers read ---------- */

  var M = {
    db: null, opening: null, state: null, kept: {}, syncedAt: 0, cursor: 0, book: '', mark: null,
    counts: { unsent: 0, refused: 0, breathsNotHome: 0 },
    lastLine: null, soonT: null, listening: false, persistAsked: false
  };

  /* ---------- the connection (home on port 8660) ---------- */

  // The only home a link may name: this Mac's loopback on 8660 (the preview) or this Mac on the
  // tailnet (https, a .ts.net name, port 8660). The port is part of the check.
  function apiShape(raw) {
    var u;
    try { u = new G.URL(String(raw || '').trim()); } catch (e) { return null; }
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    var loop = u.protocol === 'http:' && u.port === PORT && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    var tail = u.protocol === 'https:' && u.port === PORT && TS_RE.test(u.hostname);
    return loop || tail ? u.origin : null;
  }

  function readCfg() {
    try {
      var c = JSON.parse(ls.get(K_CFG) || 'null');
      var api = isObj(c) ? apiShape(c.api) : null;
      if (api && typeof c.key === 'string' && c.key) {
        return { api: api, key: c.key, device: str(c.device), refused: c.refused === true };
      }
    } catch (e) {}
    return null;
  }
  function writeCfg(c) {
    return ls.set(K_CFG, JSON.stringify({ api: c.api, key: c.key, device: c.device, refused: !!c.refused }));
  }
  function live() { var c = readCfg(); return c && !c.refused ? c : null; }

  // Only the key that was sent: a late 401 for a key just replaced must not refuse the new one.
  function markRefused(sentKey) {
    var c = readCfg();
    if (c && !c.refused && c.key === sentKey) { c.refused = true; writeCfg(c); }
    lineCheck();
  }

  /* Every call: the bearer (its own api's key only), no HTTP cache, no cookies, and a ceiling.
     A network failure, an abort or a timeout comes back as status 0; nothing throws.
     o: {api, key, json, body, type, as: 'json'|'blob'|'buffer', timeout} */
  function call(method, path, o) {
    o = o || {};
    return (async function () {
      var c = readCfg();
      var api = o.api || (c ? c.api : '');
      var key = o.key !== undefined ? o.key : (c ? c.key : '');
      if (!api) return { status: 0, data: null };
      var ac = null, timer = null;
      try { ac = new G.AbortController(); } catch (e) {}
      try { if (ac) timer = G.setTimeout(function () { try { ac.abort(); } catch (e) {} }, o.timeout || CALL_MS); } catch (e) {}
      try {
        var headers = {};
        if (key) headers.Authorization = 'Bearer ' + key;
        var body;
        if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
        else if (o.body !== undefined) { if (o.type) headers['Content-Type'] = o.type; body = o.body; }
        var init = { method: method, headers: headers, body: body, cache: 'no-store', credentials: 'omit' };
        if (ac) init.signal = ac.signal;
        var r;
        try { r = await G.fetch(api + path, init); } catch (e) { return { status: 0, data: null }; }
        if (!r || typeof r.status !== 'number') return { status: 0, data: null };
        if (r.status === 401 && o.key === undefined) markRefused(key);
        var data = null;
        if (o.as === 'blob' || o.as === 'buffer') {
          if (r.ok) {
            try { data = o.as === 'blob' ? await r.blob() : await r.arrayBuffer(); }
            catch (e) { return { status: 0, data: null }; }
          }
        } else {
          try { data = await r.json(); } catch (e) {}
        }
        return { status: r.status, data: data };
      } catch (e) {
        return { status: 0, data: null };
      } finally {
        try { if (timer !== null) G.clearTimeout(timer); } catch (e) {}
      }
    })();
  }

  // The link is #cfg= + base64url of JSON {"api", "code"} (bin/dockread-connect). The fragment is
  // scrubbed from the address bar before anything else happens. null = no link; {} = unreadable.
  function takeLink() {
    try {
      var m = (str(G.location && G.location.hash)).match(/^#(?:.*&)?cfg=([^&]*)/);
      if (!m) return null;
      try { G.history.replaceState(null, '', G.location.pathname + G.location.search); } catch (e) {}
      try {
        var s = m[1];
        try { s = decodeURIComponent(s); } catch (e) {}
        s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
        while (s.length % 4) s += '=';
        var bin = G.atob(s);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var c = JSON.parse(new G.TextDecoder().decode(bytes));
        return isObj(c) ? c : {};
      } catch (e) { return {}; }
    } catch (e) { return null; }
  }

  /* A connect link: POST /api/connect {code, device} on the address it names (no key sent), then
     GET /api/health with the new key. Only a 200 that names dockread stores the key. Then the
     first sync runs, inside this same flow. synced is true only when that sync came back whole
     (ok and not partial): the app trusts the book only then. */
  function adopt(link) {
    return (async function () {
      var api = apiShape(isObj(link) ? link.api : null);
      var code = str(isObj(link) ? link.code : '').trim();
      if (!api) return { ok: false, why: "it doesn't point at this Mac's Dock Read" };
      if (!CODE_RE.test(code)) return { ok: false, why: 'it carried no code' };
      var r = await call('POST', '/api/connect', { api: api, key: '', json: { code: code, device: 'phone' } });
      if (r.status !== 200 || !isObj(r.data) || typeof r.data.key !== 'string' || !r.data.key) {
        return { ok: false, why: r.status === 0 ? "the Mac didn't answer"
          : r.status === 403 ? 'that code was used already or ran out' : 'the Mac answered ' + r.status };
      }
      var key = r.data.key;
      var device = str(r.data.device);
      var h = await call('GET', '/api/health', { api: api, key: key, timeout: CHECK_MS });
      if (h.status !== 200 || !isObj(h.data) || h.data.name !== 'dockread') {
        return { ok: false, why: h.status === 0 ? "the Mac didn't answer the check" : "the new key didn't check out" };
      }
      await open();
      // A sync already under way carries the old key; let it end before the new key is stored, so
      // its answers are never taken for the new key's.
      if (running) { try { await running; } catch (e) {} }
      if (!writeCfg({ api: api, key: key, device: device, refused: false })) {
        return { ok: false, why: "this phone wouldn't store the key" };
      }
      // A new key starts its book from the top: pulling from 0 is safe (upsert by id), and a home
      // whose numbering was reset can never strand this phone past its last seq. Forgetting the
      // book id makes the first sync re-base, so a home that lost what this phone sent is refilled.
      // The mark was the old key's view of home's history; the first sync sends none.
      M.cursor = 0; M.syncedAt = 0; M.book = ''; M.mark = null;
      await kvPut({ cursor: 0, syncedAt: 0, book: '', mark: null });
      lineCheck();
      var s = await sync();
      return { ok: true, why: '', synced: !!(s && s.ok && !s.partial) };
    })().catch(function () { return { ok: false, why: 'something on this phone failed' }; });
  }

  function forget() {
    try {
      ls.del(K_CFG);
      if (M.soonT !== null) { try { G.clearTimeout(M.soonT); } catch (e) {} M.soonT = null; }
      lineCheck();
      return true;
    } catch (e) { return false; }
  }

  // #reset: unregister this app's worker and delete its dockread-shell- caches. The key, the book,
  // the prefs and the voice cache stay. Refused while offline (the shell could not come back).
  function resetShell() {
    return (async function () {
      if (G.navigator && G.navigator.onLine === false) return { ok: false, why: 'offline' };
      var ok = true;
      try {
        var sw = G.navigator && G.navigator.serviceWorker;
        if (sw && typeof sw.getRegistrations === 'function') {
          var scope = new G.URL('./', G.location.href).href;
          var regs = await sw.getRegistrations();
          for (var i = 0; i < (regs || []).length; i++) {
            if (regs[i] && regs[i].scope === scope) await regs[i].unregister();
          }
        }
      } catch (e) { ok = false; }
      try {
        if (G.caches) {
          var names = await G.caches.keys();
          for (var j = 0; j < (names || []).length; j++) {
            if (String(names[j]).indexOf(SHELL_PREFIX) === 0) await G.caches.delete(names[j]);
          }
        }
      } catch (e) { ok = false; }
      return ok ? { ok: true, why: '' } : { ok: false, why: "the reset didn't finish" };
    })().catch(function () { return { ok: false, why: "the reset didn't finish" }; });
  }

  function cfg() {
    var c = readCfg();
    return c ? { api: c.api, device: c.device, refused: c.refused } : null;
  }

  /* ---------- prefs ---------- */

  function prefs() {
    var out = {}, p = null;
    try { p = JSON.parse(ls.get(K_PREFS) || 'null'); } catch (e) {}
    Object.keys(PREFS).forEach(function (k) {
      out[k] = isObj(p) && typeof p[k] === 'boolean' ? p[k] : PREFS[k];
    });
    return out;
  }
  function setPref(k, v) {
    var p = prefs();
    if (!Object.prototype.hasOwnProperty.call(PREFS, k)) return p;
    p[k] = !!v;
    ls.set(K_PREFS, JSON.stringify(p));
    return p;
  }

  /* ---------- IndexedDB ---------- */

  function openDb() {
    return new Promise(function (resolve) {
      var req;
      try { req = G.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      if (!req) return resolve(null);
      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'b' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        } catch (e) {}
      };
      req.onsuccess = function () {
        var db = req.result;
        try { db.onversionchange = function () { try { db.close(); } catch (e) {} M.db = null; M.opening = null; }; } catch (e) {}
        resolve(db);
      };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  // One transaction. body(tx, out) issues its requests synchronously (or from their own success
  // callbacks); the promise resolves with out.value when the transaction completes, or with
  // `fallback` when it fails or aborts.
  function withTx(names, mode, fallback, body) {
    return new Promise(function (resolve) {
      if (!M.db) return resolve(fallback);
      var t, out = { value: fallback };
      try { t = M.db.transaction(names, mode); } catch (e) { return resolve(fallback); }
      t.oncomplete = function () { resolve(out.value); };
      t.onabort = function () { resolve(fallback); };
      t.onerror = function () {};
      try { body(t, out); } catch (e) { try { t.abort(); } catch (x) {} resolve(fallback); }
    });
  }

  function getAll(name) {
    return withTx([name], 'readonly', [], function (t, out) {
      var r = t.objectStore(name).getAll();
      r.onsuccess = function () { out.value = Array.isArray(r.result) ? r.result : []; };
    });
  }
  function getOne(name, key) {
    return withTx([name], 'readonly', null, function (t, out) {
      var r = t.objectStore(name).get(key);
      r.onsuccess = function () { out.value = r.result === undefined ? null : r.result; };
    });
  }
  function countOf(name) {
    return withTx([name], 'readonly', -1, function (t, out) {
      var r = t.objectStore(name).count();
      r.onsuccess = function () { out.value = typeof r.result === 'number' ? r.result : -1; };
    });
  }
  function kvPut(obj) {
    return withTx(['kv'], 'readwrite', false, function (t, out) {
      var s = t.objectStore('kv');
      Object.keys(obj).forEach(function (k) { s.put(obj[k], k); });
      out.value = true;
    });
  }
  function kvLoad() {
    return withTx(['kv'], 'readonly', null, function (t, out) {
      var s = t.objectStore('kv'), got = {};
      ['cursor', 'book', 'mark', 'state', 'prints', 'syncedAt'].forEach(function (k) {
        var r = s.get(k);
        r.onsuccess = function () { got[k] = r.result; };
      });
      out.value = got;
    });
  }

  // A voice note counts as not home only when its breath.kept is on his record (not refused): a clip
  // whose event was never stored, or was refused, can never go home and must not stick on the count.
  function recount() {
    return withTx(['events', 'blobs'], 'readonly', null, function (t, out) {
      var c = { unsent: 0, refused: 0, breathsNotHome: 0 }, onRecord = {};
      var re = t.objectStore('events').getAll();
      re.onsuccess = function () {
        (re.result || []).forEach(function (e) {
          if (e._refused) c.refused++;
          else {
            if (!e._sent) c.unsent++;
            if (e.type === 'breath.kept' && isObj(e.data) && typeof e.data.b === 'string') onRecord[e.data.b] = true;
          }
        });
        var rb = t.objectStore('blobs').getAll();
        rb.onsuccess = function () {
          (rb.result || []).forEach(function (b) { if (b && !b.home && !b.gone && onRecord[b.b]) c.breathsNotHome++; });
        };
      };
      out.value = c;
    }).then(function (c) { if (c) M.counts = c; return M.counts; });
  }

  function open() {
    if (M.opening) return M.opening;
    M.opening = (async function () {
      M.db = await openDb();
      if (M.db) {
        var kv = await kvLoad();
        if (kv) {
          M.cursor = isInt(kv.cursor) && kv.cursor >= 0 ? kv.cursor : 0;
          M.book = str(kv.book);
          M.mark = isMark(kv.mark) ? [kv.mark[0], kv.mark[1]] : null;
          M.state = isObj(kv.state) ? kv.state : null;
          M.kept = isObj(kv.prints) ? kv.prints : {};
          M.syncedAt = typeof kv.syncedAt === 'number' && isFinite(kv.syncedAt) ? kv.syncedAt : 0;
        }
        await recount();
      }
      M.lastLine = line();
      listen();
      return { ok: !!M.db };
    })().catch(function () { return { ok: false }; });
    return M.opening;
  }

  /* ---------- the book on this phone ---------- */

  // Upsert by id. The same content again keeps its marks; anything else is stored fresh.
  function add(event) {
    return (async function () {
      await open();
      if (!eventish(event)) return false;
      var clean = strip(event);
      var ok = await withTx(['events'], 'readwrite', false, function (t, out) {
        var s = t.objectStore('events');
        var g = s.get(clean.id);
        g.onsuccess = function () {
          var old = g.result, rec = copy(clean);
          if (old && sameContent(old, clean)) {
            if (old._sent) rec._sent = true;
            if (old._refused) rec._refused = old._refused;
            if (old.dev && !rec.dev) rec.dev = old.dev;
          }
          s.put(rec);
          out.value = true;
        };
      });
      if (!ok) return false;
      if (clean.type === 'notch.cut') persistOnce();
      await recount();
      soon();
      return true;
    })().catch(function () { return false; });
  }

  function all() {
    return (async function () {
      await open();
      var list = await getAll('events');
      return list.filter(eventish).map(strip).sort(byAtId);
    })().catch(function () { return []; });
  }

  function persistOnce() {
    if (M.persistAsked) return;
    M.persistAsked = true;
    try {
      var st = G.navigator && G.navigator.storage;
      if (st && typeof st.persist === 'function') {
        var p = st.persist();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {}
  }

  /* ---------- breaths ---------- */

  function putBlob(b, blob, o) {
    o = o || {};
    return (async function () {
      await open();
      if (typeof b !== 'string' || !UUID_RE.test(b) || !blob) return false;
      var rec = { b: b, blob: blob, mime: str(o.mime) || str(blob.type), ms: isFinite(o.ms) ? Number(o.ms) : 0,
                  home: false, gone: false, at: now() };
      var ok = await withTx(['blobs'], 'readwrite', false, function (t, out) {
        t.objectStore('blobs').put(rec); out.value = true;
      });
      if (ok) { await recount(); soon(); }
      return ok;
    })().catch(function () { return false; });
  }

  function getBlob(b) {
    return (async function () {
      await open();
      if (typeof b !== 'string') return null;
      var rec = await getOne('blobs', b);
      return rec && rec.blob ? rec.blob : null;
    })().catch(function () { return null; });
  }

  // This phone first; else home's copy, which is then kept here (marked home: it came from there).
  function fetchBlob(b) {
    return (async function () {
      var have = await getBlob(b);
      if (have) return have;
      if (typeof b !== 'string' || !UUID_RE.test(b) || !live()) return null;
      var r = await call('GET', '/api/breath/' + b, { as: 'blob', timeout: BLOB_MS });
      if (r.status !== 200 || !r.data || !(r.data.size > 0)) return null;
      var blob = r.data;
      await withTx(['blobs'], 'readwrite', false, function (t, out) {
        t.objectStore('blobs').put({ b: b, blob: blob, mime: str(blob.type), ms: 0, home: true, gone: false, at: now() });
        out.value = true;
      });
      await recount();
      return blob;
    })().catch(function () { return null; });
  }

  // Deletes this phone's copy only. The breath.dropped event is the app's to write.
  function dropBlob(b) {
    return (async function () {
      await open();
      if (typeof b !== 'string') return false;
      var ok = await withTx(['blobs'], 'readwrite', false, function (t, out) {
        t.objectStore('blobs').delete(b); out.value = true;
      });
      if (ok) await recount();
      return ok;
    })().catch(function () { return false; });
  }

  // A mark whose value is undefined removes that field (a gone breath loses its bytes).
  function setBlobMark(b, mark) {
    return withTx(['blobs'], 'readwrite', false, function (t, out) {
      var s = t.objectStore('blobs');
      var g = s.get(b);
      g.onsuccess = function () {
        var rec = g.result;
        if (!rec) return;
        Object.keys(mark).forEach(function (k) { if (mark[k] === undefined) delete rec[k]; else rec[k] = mark[k]; });
        s.put(rec);
        out.value = true;
      };
    });
  }

  /* ---------- home's State, kept ---------- */

  function home() { return M.state; }

  // Every print ever seen, by series and period; home's newest copy of a period replaces the old.
  function mergeKept(kept, seriesObj) {
    var out = copy(kept) || {};
    if (!isObj(seriesObj)) return out;
    Object.keys(seriesObj).forEach(function (sid) {
      var s = seriesObj[sid];
      if (!isObj(s) || !Array.isArray(s.prints)) return;
      if (!isObj(out[sid])) out[sid] = {};
      s.prints.forEach(function (p) {
        if (isObj(p) && typeof p.period === 'string' && p.period && typeof p.value === 'number' && isFinite(p.value)) {
          out[sid][p.period] = copy(p);
        }
      });
    });
    return out;
  }
  function keptList(sid) {
    var m = isObj(M.kept[sid]) ? M.kept[sid] : {};
    return Object.keys(m).sort().map(function (p) { return copy(m[p]); });
  }

  function series() {
    try {
      var s = M.state && isObj(M.state.series) ? M.state.series : {};
      var out = {}, ids = {};
      Object.keys(s).forEach(function (k) { ids[k] = 1; });
      Object.keys(M.kept || {}).forEach(function (k) { ids[k] = 1; });
      Object.keys(ids).forEach(function (sid) {
        var one = isObj(s[sid]) ? copy(s[sid])
          : { prints: [], upcoming: [], question: '', status: 'never', checked_at: '', note: '' };
        one.prints = keptList(sid);
        out[sid] = one;
      });
      return out;
    } catch (e) { return {}; }
  }

  function line() {
    try {
      var c = readCfg();
      if (!c || c.refused) return 'unset';
      var age = now() - M.syncedAt;
      return M.syncedAt > 0 && age >= 0 && age < HOME_MS ? 'home' : 'none';
    } catch (e) { return 'unset'; }
  }
  function lineCheck() {
    var l = line();
    if (l !== M.lastLine) { M.lastLine = l; emit('line', l); }
  }

  function counts() {
    var out = { unsent: M.counts.unsent, refused: M.counts.refused, breathsNotHome: M.counts.breathsNotHome,
                clockOffMin: null, registryMismatch: false };
    try {
      if (M.state && M.syncedAt > 0) {
        var h = Date.parse(M.state.now);
        if (isFinite(h)) out.clockOffMin = Math.round((h - M.syncedAt) / 60000);
      }
      var reg = typeof DR.registry === 'function' ? DR.registry() : null;
      if (M.state && reg && M.state.registry_version !== undefined) {
        out.registryMismatch = M.state.registry_version !== reg.version;
      }
    } catch (e) {}
    return out;
  }

  /* ---------- sync (SPEC 9.9: six steps, in order) ---------- */

  var running = null, again = false;

  function sync() {
    if (running) { again = true; return running; }
    running = runSync().catch(function () { return { ok: false, status: 0 }; }).then(function (r) {
      running = null;
      if (again) { again = false; soon(); }
      return r;
    });
    return running;
  }

  function soon() {
    if (!live()) return;
    try {
      if (M.soonT !== null) G.clearTimeout(M.soonT);
      M.soonT = G.setTimeout(function () { M.soonT = null; sync(); }, AFTER_EVENT_MS);
    } catch (e) {}
  }

  function listen() {
    if (M.listening) return;
    M.listening = true;
    function visible() { try { return !G.document || G.document.visibilityState !== 'hidden'; } catch (e) { return true; } }
    try { if (typeof G.addEventListener === 'function') G.addEventListener('online', function () { if (live()) sync(); }); } catch (e) {}
    try {
      if (G.document && typeof G.document.addEventListener === 'function') {
        G.document.addEventListener('visibilitychange', function () { if (visible() && live()) sync(); });
      }
    } catch (e) {}
    try { G.setInterval(function () { if (visible() && live()) sync(); }, EVERY_MS); } catch (e) {}
  }

  // A sync request carries the mark as it stands when the request is built; none is sent until home
  // has given one (a fresh phone, or the first sync after an adopt or a re-base).
  function syncBody(cursor, events) {
    var b = { cursor: cursor, events: events };
    if (M.mark) b.mark = [M.mark[0], M.mark[1]];
    return b;
  }

  async function runSync() {
    await open();
    var c = readCfg();
    if (!c) { lineCheck(); return { ok: false, status: 0, why: 'unset' }; }
    if (c.refused) { lineCheck(); return { ok: false, status: 401, why: 'refused' }; }
    if (!M.db) return { ok: false, status: -1, why: 'storage' };
    var pulled = 0, state = null, rebased = false, more = false;

    async function fail(status, why) {
      await recount();
      // Some pages landed but the pull did not finish: the book here is not whole.
      // The retry follows 2 s later (15.45). A retry that fails having pulled nothing emits nothing
      // and arms nothing, so a dead line cannot loop.
      if (pulled) { emit('change', { pulled: pulled, partial: true }); soon(); }
      lineCheck();
      return { ok: false, status: status, why: why || '' };
    }

    // Every reply carries home's State. A book id other than the one kept (none is kept after an
    // adopt) re-bases this phone. So does mark_ok false: home's history no longer holds the row this
    // phone was last told was its newest (a restore from a backup keeps the old id, SPEC 15.52). Only
    // then is the reply's top kept as the new mark. A reply with no book, no top and no mark_ok (an
    // older home) changes nothing. false only when storage failed.
    async function bookCheck(d) {
      var st = d.state;
      var newBook = isObj(st) && typeof st.book === 'string' && st.book && st.book !== M.book;
      var lost = d.mark_ok === false;
      if (newBook || lost) {
        var v = await rebase(newBook ? st.book : M.book, isObj(st) ? st : {}, lost);
        if (!v) return false;
        if (v === 'rebased') { rebased = true; if (isObj(st)) state = st; return true; }
      }
      var t = d.top;
      if (isMark(t) && !(M.mark && M.mark[0] === t[0] && M.mark[1] === t[1])) {
        if (!(await kvPut({ mark: [t[0], t[1]] }))) return false;
        M.mark = [t[0], t[1]];
      }
      return true;
    }

    // (1) Push events not yet sent, in batches by count and by bytes.
    var book = (await getAll('events')).filter(eventish);
    var pend = book.filter(function (e) { return !e._sent && !e._refused; }).sort(byAtId);
    var i = 0;
    while (i < pend.length) {
      var batch = [], bytes = 40;
      while (i < pend.length && batch.length < PUSH_MAX) {
        var e = strip(pend[i]);
        var sz = utf8Len(JSON.stringify(e)) + 1;
        if (batch.length && bytes + sz > PUSH_BYTES) break;
        batch.push(e); bytes += sz; i++;
      }
      var r = await call('POST', '/api/sync', { json: syncBody(NO_PULL, batch) });
      if (r.status !== 200 || !isObj(r.data)) return fail(r.status, 'push');
      if (!(await bookCheck(r.data))) return fail(-1, 'storage');
      // After a re-base this batch's answers are still true of the new book; the rest waits for
      // the next run, which sends everything the re-base unmarked.
      if (!(await markPushed(r.data.accepted, r.data.refused))) return fail(-1, 'storage');
      if (rebased) break;
    }

    if (!rebased) {
      // (2) Upload breaths not yet home whose breath.kept is sent.
      var sent = {};
      (await getAll('events')).forEach(function (e) {
        if (e && e.type === 'breath.kept' && e._sent && isObj(e.data) && typeof e.data.b === 'string') sent[e.data.b] = true;
      });
      var blobs = (await getAll('blobs')).filter(function (b) { return b && !b.home && !b.gone && sent[b.b] && b.blob; });
      for (var j = 0; j < blobs.length; j++) {
        var B = blobs[j];
        var u = await call('POST', '/api/breath/' + B.b,
                           { body: B.blob, type: B.mime || str(B.blob.type) || 'audio/webm', timeout: BLOB_MS });
        if (u.status === 200 || u.status === 409) await setBlobMark(B.b, { home: true });
        // Home dropped it: the bytes can never go home, so they are not kept here either.
        else if (u.status === 410) await setBlobMark(B.b, { gone: true, blob: undefined });
        else if (u.status === 0 || u.status === 401) return fail(u.status, 'breath');
        // 404 (home has no breath.kept for it yet) and anything else: left for next time
      }

      // (3) Pull while home says "more", at most PULL_ROUNDS pages. Home's copy replaces the local one.
      var n = await countOf('events');
      var cursor = n === 0 ? 0 : M.cursor;
      var rounds = 0;
      more = true;
      while (more && rounds < PULL_ROUNDS) {
        rounds++;
        var p = await call('POST', '/api/sync', { json: syncBody(cursor, []) });
        if (p.status !== 200 || !isObj(p.data) || !Array.isArray(p.data.events)) return fail(p.status, 'pull');
        if (!(await bookCheck(p.data))) return fail(-1, 'storage');
        if (rebased) break;                // this page comes again, from cursor 0
        var evs = p.data.events.filter(eventish);
        var next = isInt(p.data.cursor) && p.data.cursor >= 0 ? p.data.cursor : cursor;
        if (!(await putPulled(evs, next))) return fail(-1, 'storage');
        cursor = next; M.cursor = next; pulled += evs.length;
        if (isObj(p.data.state)) state = p.data.state;
        more = p.data.more === true;
      }
    }
    // Pages left, or a re-base: the book here is not whole yet, and the next run follows soon.
    var partial = rebased || more;

    // (4) Save the cursor (saved with each page above) and the State; keep every print ever seen.
    if (state) {
      var at = now();
      var kept = mergeKept(M.kept, state.series);
      if (!(await kvPut({ cursor: M.cursor, state: state, prints: kept, syncedAt: at }))) return fail(-1, 'storage');
      M.state = state; M.kept = kept; M.syncedAt = at;
    }

    // (5) Fetch any breath of the open round that home has and this phone does not. Only on a whole
    // book: a partial one can name the wrong round as open.
    if (!partial) { try { await fetchActiveBreaths(); } catch (x) {} }

    // (6) Only now tell the app.
    await recount();
    emit('change', { pulled: pulled, partial: partial });
    lineCheck();
    if (partial) soon();
    return partial ? { ok: true, status: 200, pulled: pulled, partial: true } : { ok: true, status: 200, pulled: pulled };
  }

  /* Home's book id changed, or none is kept since an adopt: home's copy may lack what this phone
     marked as sent. In one transaction: clear the sent mark on every event home did not refuse, take
     each voice note's home mark from State.breaths (a gone one is left alone), put the cursor at 0 and
     keep the new id. A phone that has marked nothing and stands at cursor 0 only keeps the id.
     The mark is forgotten either way: it named a row of the history this phone no longer trusts.
     force (home said mark_ok false) always re-bases, so the answer is partial and a sync follows.
     Answers 'rebased', 'kept', or false when storage failed. */
  function rebase(id, st, force) {
    var have = isObj(st.breaths) ? st.breaths : {};
    var undo = !!force || M.cursor !== 0;
    return withTx(['events', 'blobs', 'kv'], 'readwrite', false, function (t, out) {
      var es = t.objectStore('events'), bs = t.objectStore('blobs'), kv = t.objectStore('kv');
      var evs = null, bls = null;
      function go() {
        if (!evs || !bls) return;
        evs.forEach(function (e) { if (e && e._sent && !e._refused) undo = true; });
        bls.forEach(function (b) { if (b && b.home && !b.gone) undo = true; });
        if (undo) {
          evs.forEach(function (e) { if (e && e._sent && !e._refused) { delete e._sent; es.put(e); } });
          bls.forEach(function (b) {
            if (!b || b.gone) return;
            var h = have[b.b], home = isObj(h) && h.have === true;
            if (b.home !== home) { b.home = home; bs.put(b); }
          });
          kv.put(0, 'cursor');
        }
        kv.put(id, 'book');
        kv.put(null, 'mark');
        out.value = undo ? 'rebased' : 'kept';
      }
      var re = es.getAll(), rb = bs.getAll();
      re.onsuccess = function () { evs = Array.isArray(re.result) ? re.result : []; go(); };
      rb.onsuccess = function () { bls = Array.isArray(rb.result) ? rb.result : []; go(); };
    }).then(function (v) {
      if (v) { M.book = id; M.mark = null; if (v === 'rebased') M.cursor = 0; }
      return v;
    });
  }

  function markPushed(accepted, refused) {
    var acc = Array.isArray(accepted) ? accepted.filter(function (x) { return typeof x === 'string'; }) : [];
    var ref = Array.isArray(refused) ? refused.filter(function (x) { return isObj(x) && typeof x.id === 'string'; }) : [];
    return withTx(['events'], 'readwrite', false, function (t, out) {
      var s = t.objectStore('events');
      acc.forEach(function (id) {
        var g = s.get(id);
        g.onsuccess = function () {
          var rec = g.result; if (!rec) return;
          rec._sent = true; delete rec._refused; s.put(rec);
        };
      });
      ref.forEach(function (x) {
        var g = s.get(x.id);
        g.onsuccess = function () {
          var rec = g.result; if (!rec || rec._sent) return;
          rec._refused = (str(x.why) || 'refused').slice(0, 200); s.put(rec);
        };
      });
      out.value = true;
    });
  }

  // One transaction per page: the events (home's copies, marked sent) and the cursor together.
  function putPulled(evs, cursor) {
    return withTx(['events', 'kv'], 'readwrite', false, function (t, out) {
      var s = t.objectStore('events');
      evs.forEach(function (e) {
        var rec = copy(strip(e));
        rec._sent = true;
        s.put(rec);
      });
      t.objectStore('kv').put(cursor, 'cursor');
      out.value = true;
    });
  }

  async function fetchActiveBreaths() {
    if (typeof DR.reduce !== 'function' || !M.state || !isObj(M.state.breaths)) return;
    var st = DR.reduce(await all(), series(), typeof DR.nowIso === 'function' ? DR.nowIso() : new Date(now()).toISOString());
    if (!st || !st.active) return;
    var ids = Object.keys(st.breaths || {}).filter(function (b) {
      var B = st.breaths[b], H = M.state.breaths[b];
      return B && B.round === st.active.id && !B.dropped && isObj(H) && H.have === true;
    });
    for (var i = 0; i < ids.length; i++) {
      if (!(await getBlob(ids[i]))) await fetchBlob(ids[i]);
    }
  }

  /* ---------- the voice cache ---------- */

  async function clipKey(text) {
    var subtle = G.crypto && G.crypto.subtle;
    if (!subtle) return null;
    var dig = await subtle.digest('SHA-256', new G.TextEncoder().encode(text));
    var b = new Uint8Array(dig), hex = '';
    for (var i = 0; i < b.length; i++) hex += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    var base = 'https://dockread.invalid/';
    try { base = new G.URL('./', G.location.href).href; } catch (e) {}
    return base + 'voice-clip/' + hex;
  }

  async function keepClip(cache, key, buf) {
    try {
      await cache.put(key, new G.Response(buf, { headers: { 'Content-Type': 'audio/wav' } }));
      var keys = await cache.keys();
      var extra = (keys || []).length - VOICE_KEEP;
      for (var i = 0; i < extra; i++) await cache.delete(keys[i]);
    } catch (e) {}
  }

  // The cache first; then, only with the line HOME, POST /api/say inside waitMs. An answer that
  // lands later is still cached for next time. ArrayBuffer or null; never throws.
  function voiceClip(text, waitMs) {
    return (async function () {
      text = str(text);
      if (!text.trim()) return null;
      var key = await clipKey(text);
      if (!key) return null;
      var cache = null;
      try { cache = G.caches ? await G.caches.open(VOICE_CACHE) : null; } catch (e) { cache = null; }
      if (cache) {
        try { var hit = await cache.match(key); if (hit) return await hit.arrayBuffer(); } catch (e) {}
      }
      if (line() !== 'home') return null;
      var ask = call('POST', '/api/say', { json: { text: text }, as: 'buffer', timeout: SAY_MS }).then(async function (r) {
        if (r.status !== 200 || !r.data || !(r.data.byteLength > 44)) return null;
        if (cache) await keepClip(cache, key, r.data.slice(0));
        return r.data;
      }).catch(function () { return null; });
      var ms = typeof waitMs === 'number' && isFinite(waitMs) && waitMs >= 0 ? waitMs : VOICE_WAIT_MS;
      return await Promise.race([ask, wait(ms)]);
    })().catch(function () { return null; });
  }

  /* ---------- prints ---------- */

  // POST /api/print/refresh. true when home ran a fetch pass (then a sync brings the prints).
  function refreshPrints() {
    return (async function () {
      if (!live()) return false;
      var r = await call('POST', '/api/print/refresh', { json: {}, timeout: REFRESH_MS });
      return r.status === 200 && isObj(r.data) && r.data.ran === true;
    })().catch(function () { return false; });
  }

  DR.store = {
    open: open,
    add: add, all: all,
    putBlob: putBlob, getBlob: getBlob, fetchBlob: fetchBlob, dropBlob: dropBlob,
    prefs: prefs, setPref: setPref,
    cfg: cfg, takeLink: takeLink, adopt: adopt, forget: forget, resetShell: resetShell,
    sync: sync,
    home: home, series: series, line: line, counts: counts,
    voiceClip: voiceClip,
    refreshPrints: refreshPrints,
    on: on,
    apiShape: apiShape
  };
})();
