// Tests for shell/js/store.js (SPEC 9.9, 9.11). Node, no packages.
// core.js and store.js run inside a vm context with hand-written fakes: a small in-memory
// IndexedDB, localStorage, fetch as a scripted table (a fake home that speaks /api/sync),
// caches, location and history, navigator, and manual timers.
// Run: node shell/tools/test_store.mjs   -> one line per failure, a count, exit 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const CORE = fs.readFileSync(path.join(SHELL, 'js', 'core.js'), 'utf8');
const STORE = fs.readFileSync(path.join(SHELL, 'js', 'store.js'), 'utf8');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(SHELL, 'registry.json'), 'utf8'));

function fatal(what, e) {
  console.log('STORE TESTS CRASHED (' + what + '): ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
process.on('uncaughtException', (e) => fatal('uncaught', e));
process.on('unhandledRejection', (e) => fatal('unhandled rejection', e));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : String(e))); }
}
function ok(c, what) { if (!c) throw new Error(what || 'not true'); }
function eq(a, b, what) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what ? what + ': ' : '') + 'got ' + x + ' want ' + y);
}
const flush = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await flush(); }

/* ---------- fake IndexedDB: exactly what store.js uses ---------- */

function plainClone(v) {
  if (Array.isArray(v)) return v.map(plainClone);
  if (v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plainClone(v[k]);
    return o;
  }
  return v;   // Blob, ArrayBuffer, numbers, strings: by reference / by value
}

function makeIDB() {
  const dbs = new Map();
  const F = { dbs, opens: 0 };
  F.open = (name, version) => {
    F.opens++;
    const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    setImmediate(() => {
      let rec = dbs.get(name);
      if (!rec) { rec = { version: 0, stores: new Map() }; dbs.set(name, rec); }
      const db = makeDb(rec);
      req.result = db;
      if (version > rec.version) {
        rec.version = version;
        db._upgrading = true;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: version });
        db._upgrading = false;
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  };
  return F;
}
function makeDb(rec) {
  return {
    _rec: rec,
    objectStoreNames: { contains: (n) => rec.stores.has(n) },
    createObjectStore(n, o) {
      if (!this._upgrading) throw new Error('InvalidStateError: not in an upgrade');
      rec.stores.set(n, { keyPath: (o && o.keyPath) || null, data: new Map() });
      return {};
    },
    close() {},
    transaction(names, mode) { return makeTx(rec, [].concat(names), mode || 'readonly'); }
  };
}
function makeTx(rec, names, mode) {
  for (const n of names) if (!rec.stores.has(n)) throw new Error('NotFoundError: ' + n);
  const tx = { oncomplete: null, onerror: null, onabort: null, done: false };
  const queue = [];
  const snap = new Map(names.map((n) => [n, new Map(rec.stores.get(n).data)]));
  function run() {
    while (queue.length && !tx.done) {
      const job = queue.shift();
      try { job.req.result = job.fn(); }
      catch (e) { job.req.error = e; tx.abort(); return; }
      if (job.req.onsuccess) job.req.onsuccess({ target: job.req });
    }
    setImmediate(() => {
      if (tx.done) return;
      if (queue.length) return run();
      tx.done = true;
      if (tx.oncomplete) tx.oncomplete({});
    });
  }
  setImmediate(run);
  tx.abort = () => {
    if (tx.done) return;
    tx.done = true;
    for (const [n, m] of snap) rec.stores.get(n).data = m;
    if (tx.onabort) tx.onabort({});
  };
  tx.objectStore = (n) => {
    if (!names.includes(n)) throw new Error('NotFoundError: ' + n);
    const st = rec.stores.get(n);
    const add = (fn) => {
      if (tx.done) throw new Error('TransactionInactiveError');
      const req = { result: undefined, onsuccess: null, onerror: null };
      queue.push({ req, fn });
      return req;
    };
    const rw = () => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); };
    return {
      get: (k) => add(() => (st.data.has(k) ? plainClone(st.data.get(k)) : undefined)),
      getAll: () => add(() => [...st.data.values()].map(plainClone)),
      count: () => add(() => st.data.size),
      put: (v, k) => { rw(); return add(() => { const key = st.keyPath ? v[st.keyPath] : k; st.data.set(key, plainClone(v)); return key; }); },
      delete: (k) => { rw(); return add(() => { st.data.delete(k); }); }
    };
  };
  return tx;
}

/* ---------- fake caches ---------- */

function makeCaches() {
  const names = new Map();   // name -> Map(url -> {bytes, type})
  const C = { names };
  function cacheOf(m) {
    const url = (k) => (typeof k === 'string' ? k : k.url);
    return {
      async match(k) { const e = m.get(url(k)); return e ? new Response(e.bytes.slice(0), { headers: { 'Content-Type': e.type } }) : undefined; },
      async put(k, resp) {
        const bytes = await resp.arrayBuffer();
        m.delete(url(k));
        m.set(url(k), { bytes, type: resp.headers.get('Content-Type') || '' });
      },
      async keys() { return [...m.keys()].map((u) => ({ url: u })); },
      async delete(k) { return m.delete(url(k)); }
    };
  }
  C.open = async (n) => { if (!names.has(n)) names.set(n, new Map()); return cacheOf(names.get(n)); };
  C.keys = async () => [...names.keys()];
  C.delete = async (n) => names.delete(n);
  return C;
}

/* ---------- a fake home: speaks /api/sync like events.py ---------- */

function utc(ms) { return new Date(ms).toISOString(); }
const BOOK1 = '0123456789abcdef'.repeat(2);
const BOOK2 = 'fedcba9876543210'.repeat(2);
function makeHome() {
  const H = {
    events: [], seq: 0, refuse: {}, limit: 2000, dev: 'fold', got: {},
    state: {
      now: utc(Date.now()), version: '0.1.0', registry_version: 1, book: BOOK1,
      series: {
        ism_new_orders: { prints: [], upcoming: [], question: '', status: 'ok', checked_at: '', note: '' }
      },
      field: { status: 'ok', flags: [], older: 0, kept: 0, sorted: { done: 0, total: 0 }, heard: [] },
      yours: null, proposals: {}, breaths: {}, parts: {}
    },
    breathPost: {}, breathGet: {}, pushes: []
  };
  H.add = (e) => { H.events.push(Object.assign({}, e, { dev: H.dev, seq: ++H.seq })); };
  // As events.py: a repeat id is accepted only with the same content, whoever sends it.
  const same = (a, b) => a.at === b.at && a.tz === b.tz && a.type === b.type && (a.round || null) === (b.round || null) &&
                         JSON.stringify(a.data) === JSON.stringify(b.data);
  // SPEC 7 / 15.52: a well-formed mark is [seq, id], seq a whole number 1 to 2**63-1, id 1 to 64 chars.
  const isMark = (m) => Array.isArray(m) && m.length === 2 && Number.isInteger(m[0]) && m[0] >= 1 &&
                        m[0] <= 2 ** 63 - 1 && typeof m[1] === 'string' && m[1].length >= 1 && m[1].length <= 64;
  H.sync = (body) => {
    // mark_ok: does the row with that seq still have that id? (null: no well-formed mark sent)
    const markOk = isMark(body.mark) ? H.events.some((x) => x.seq === body.mark[0] && x.id === body.mark[1]) : null;
    const accepted = [], refused = [];
    for (const e of body.events) {
      if (H.refuse[e.id]) { refused.push({ id: e.id, why: H.refuse[e.id] }); continue; }
      const had = H.events.find((x) => x.id === e.id);
      if (had && !same(had, e)) { refused.push({ id: e.id, why: 'id reused' }); continue; }
      if (!had) H.add(e);
      accepted.push(e.id);
    }
    if (body.events.length) H.pushes.push(body.events.length);
    const after = H.events.filter((x) => x.seq > body.cursor);
    const page = after.slice(0, H.limit);
    const out = page.map((x) => { const y = Object.assign({}, x); delete y.seq; return y; });
    const reply = { cursor: page.length ? page[page.length - 1].seq : body.cursor, events: out,
                    more: after.length > page.length, accepted, refused, state: JSON.parse(JSON.stringify(H.state)) };
    // An older home (H.old) sends neither top nor mark_ok.
    if (!H.old) {
      const last = H.events[H.events.length - 1];
      reply.top = last ? [last.seq, last.id] : null;
      reply.mark_ok = markOk;
    }
    return reply;
  };
  // A home that lost its database: nothing kept, and a new book id.
  H.wipe = (book) => { H.events = []; H.seq = 0; H.got = {}; H.state.breaths = {}; H.state.book = book; };
  return H;
}

/* ---------- the world: one page load ---------- */

const API = 'http://127.0.0.1:8660';
const KEY = 'k_' + 'x'.repeat(40);   // a made-up test key; never printed

function makeWorld(o = {}) {
  const W = {
    log: [], reqs: [], timers: [], tnow: 0, tid: 0,
    idb: o.idb || makeIDB(), caches: o.caches || makeCaches(), lsData: o.lsData || new Map(),
    home: o.home || makeHome(), off: { ms: 0 }, routes: {}, listeners: {}, docListeners: {},
    regs: [], online: true
  };
  W.loc = { hash: o.hash || '', pathname: '/', search: '', href: 'http://127.0.0.1:8918/' + (o.hash || ''), origin: 'http://127.0.0.1:8918' };
  const localStorage = {
    getItem: (k) => (W.lsData.has(k) ? W.lsData.get(k) : null),
    setItem: (k, v) => { W.lsData.set(k, String(v)); },
    removeItem: (k) => { W.lsData.delete(k); }
  };
  const history = {
    replaceState: (s, title, url) => {
      W.log.push('scrub');
      W.loc.hash = '';
      W.loc.href = 'http://127.0.0.1:8918' + url;
    }
  };
  const resp = (status, json) => new Response(json === undefined ? '' : JSON.stringify(json),
                                              { status, headers: { 'Content-Type': 'application/json' } });
  async function fetch(url, init) {
    const u = new URL(url);
    let body = init.body;
    let json = null;
    if (typeof body === 'string') { try { json = JSON.parse(body); } catch (e) {} }
    const req = { method: init.method, url, origin: u.origin, path: u.pathname, headers: init.headers || {}, json, body,
                  cache: init.cache, credentials: init.credentials };
    W.reqs.push(req);
    W.log.push('fetch ' + init.method + ' ' + u.pathname);
    const k = init.method + ' ' + u.pathname;
    const hit = W.routes[k] || W.routes[init.method + ' ' + u.pathname.replace(/[0-9a-f-]{36}$/, '*')];
    if (hit) {
      const r = await hit(req);
      if (r === 'network') throw new TypeError('Failed to fetch');
      if (r instanceof Response) return r;
      return resp(r.status, r.json);
    }
    // default routes: the fake home
    if (k === 'POST /api/sync') {
      if ((req.headers.Authorization || '') !== 'Bearer ' + KEY) return resp(401, { error: 'no key' });
      return resp(200, W.home.sync(json));
    }
    if (k === 'GET /api/health') return resp(200, { ok: true, name: 'dockread', version: '0.1.0', parts: {} });
    if (k === 'POST /api/connect') return resp(200, { key: KEY, device: 'fold' });
    if (init.method === 'POST' && u.pathname.startsWith('/api/breath/')) {
      const b = u.pathname.slice(12);
      const st = W.home.breathPost[b] || 200;
      if (st === 200) { W.home.got[b] = true; W.home.state.breaths[b] = { have: true, text: '' }; }
      return resp(st, st === 200 ? { ok: true, id: b } : { error: 'x' });
    }
    if (init.method === 'GET' && u.pathname.startsWith('/api/breath/')) {
      const b = u.pathname.slice(12);
      const g = W.home.breathGet[b];
      if (!g) return resp(404, { error: 'no such breath' });
      return new Response(new Blob([g], { type: 'audio/webm' }), { status: 200, headers: { 'Content-Type': 'audio/webm' } });
    }
    return resp(404, { error: 'not found' });
  }
  const navigator = {
    get onLine() { return W.online; },
    serviceWorker: { getRegistrations: async () => W.regs.slice() },
    storage: { persist: async () => { W.log.push('persist'); return true; } }
  };
  const ctx = {
    console, URL, Blob, Response, Headers, TextEncoder, TextDecoder, AbortController,
    atob, btoa, crypto: globalThis.crypto,
    localStorage, history, navigator, location: W.loc,
    indexedDB: W.idb, caches: W.caches, fetch,
    setTimeout: (fn, ms) => { const id = ++W.tid; W.timers.push({ id, fn, at: W.tnow + (ms || 0), every: 0 }); return id; },
    clearTimeout: (id) => { W.timers = W.timers.filter((x) => x.id !== id); },
    setInterval: (fn, ms) => { const id = ++W.tid; W.timers.push({ id, fn, at: W.tnow + ms, every: ms }); return id; },
    clearInterval: (id) => { W.timers = W.timers.filter((x) => x.id !== id); },
    addEventListener: (n, cb) => { (W.listeners[n] = W.listeners[n] || []).push(cb); },
    document: { visibilityState: 'visible', addEventListener: (n, cb) => { (W.docListeners[n] = W.docListeners[n] || []).push(cb); } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('(function (off) { var real = Date.now; Date.now = function () { return real() + off.ms; }; })', ctx)(W.off);
  vm.runInContext(CORE, ctx, { filename: 'core.js' });
  vm.runInContext(STORE, ctx, { filename: 'store.js' });
  W.DR = ctx.DR;
  W.S = ctx.DR.store;
  W.DR.setRegistry(JSON.parse(JSON.stringify(REGISTRY)));
  // Run the timers that are due after moving the manual clock forward ms.
  W.advance = async (ms) => {
    W.tnow += ms;
    for (;;) {
      const due = W.timers.filter((x) => x.at <= W.tnow).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      if (due.every) due.at += due.every; else W.timers = W.timers.filter((x) => x !== due);
      due.fn();
      await settle();
    }
  };
  W.connect = () => { W.lsData.set('dockread.cfg', JSON.stringify({ api: API, key: KEY, device: 'fold', refused: false })); };
  W.syncs = () => W.reqs.filter((r) => r.path === '/api/sync');
  W.pulls = () => W.syncs().filter((r) => r.json && r.json.events.length === 0);
  W.kv = (k) => { const r = W.idb.dbs.get('dockread'); return r ? r.stores.get('kv').data.get(k) : undefined; };
  W.rawEvent = (id) => W.idb.dbs.get('dockread').stores.get('events').data.get(id);
  W.rawBlob = (b) => W.idb.dbs.get('dockread').stores.get('blobs').data.get(b);
  return W;
}

/* ---------- valid events ---------- */

function mk(W, type, round, data, atMs) {
  const e = W.DR.event(type, round, data);
  if (atMs !== undefined) e.at = utc(atMs);
  return JSON.parse(JSON.stringify(e));
}
const AIM = { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' };
function opened(W, round, atMs) {
  return mk(W, 'round.opened', round, { lane: 'macro', q: 'ORDERS UP OR DOWN?', say: 'orders up or down?',
    words: ['UP', 'DOWN'], twin: 'ism_new_orders', origin: 'canon', aim: AIM, from: null }, atMs);
}
function cut(W, round, atMs) { return mk(W, 'notch.cut', round, { n: W.DR.uuid(), up: true, place: null }, atMs); }
function kept(W, round, n, atMs) {
  return mk(W, 'breath.kept', round, { b: W.DR.uuid(), of: 'notch', ref: n, ms: 1200, mime: 'audio/webm' }, atMs);
}
function closed(W, round, atMs) { return mk(W, 'round.closed', round, { reason: 'own', print: null }, atMs); }
const T0 = Date.parse('2026-11-10T15:00:00.000Z');

/* ======================= scenarios ======================= */

await t('events are valid by core (fixture sanity)', async () => {
  const W = makeWorld();
  const r = W.DR.uuid();
  const c = cut(W, r, T0 + 1000);
  for (const e of [opened(W, r, T0), c, kept(W, r, c.data.n, T0 + 2000), closed(W, r, T0 + 3000)]) {
    eq(W.DR.validate(e, null), '', e.type);
  }
});

await t('add upserts by id; home\'s copy replaces the local one; marks never leave the store', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  const e = opened(W, r, T0);
  ok(await W.S.add(e), 'add');
  ok(await W.S.add(e), 'add again');
  let list = await W.S.all();
  eq(list.length, 1, 'one copy');
  eq(list[0].dev, '', 'local dev');
  const res = await W.S.sync();
  ok(res.ok, 'sync ok ' + JSON.stringify(res));
  list = await W.S.all();
  eq(list.length, 1, 'still one copy');
  eq(list[0].dev, 'fold', 'home copy wins');
  ok(Object.keys(list[0]).every((k) => k[0] !== '_'), 'no marks in all()');
  eq(Object.keys(list[0]).sort(), ['at', 'data', 'dev', 'id', 'round', 'type', 'tz'], 'seven fields');
  ok(W.rawEvent(e.id)._sent === true, 'marked sent');
  // what was pushed carried no marks either
  const pushed = W.syncs().find((x) => x.json.events.length);
  ok(pushed.json.events.every((x) => Object.keys(x).every((k) => k[0] !== '_')), 'no marks on the wire');
  eq(pushed.headers.Authorization, 'Bearer ' + KEY, 'bearer');
  eq(pushed.cache, 'no-store', 'no-store'); eq(pushed.credentials, 'omit', 'credentials omit');
});

await t('push batches by count (500) and by bytes (900 KB)', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  for (let i = 0; i < 1201; i++) await W.S.add(cut(W, r, T0 + i));
  await W.S.sync();
  const pushes = W.syncs().filter((x) => x.json.events.length);
  eq(pushes.map((x) => x.json.events.length), [500, 500, 201], 'by count');
  ok(pushes.every((x) => x.json.cursor > 1e15), 'a push asks for nothing back');

  const V = makeWorld(); V.connect();
  await V.S.open();
  const pad = 'P'.repeat(1900);
  for (let i = 0; i < 700; i++) {
    const e = cut(V, r, T0 + i); e.data.pad = pad;   // fat on purpose: home here takes it
    await V.S.add(e);
  }
  await V.S.sync();
  const fat = V.syncs().filter((x) => x.json.events.length);
  ok(fat.length >= 2, 'split by bytes, got ' + fat.length);
  ok(fat.every((x) => x.json.events.length < 500), 'none hit the count cap');
  ok(fat.every((x) => Buffer.byteLength(x.body) <= 900 * 1024 + 64), 'each push under 900 KB');
  eq(fat.reduce((a, x) => a + x.json.events.length, 0), 700, 'every event sent once');
});

await t('accepted marked sent; refused marked with its why and never sent again', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  const a = opened(W, r, T0), b = cut(W, r, T0 + 1);
  W.home.refuse[b.id] = 'bad place';
  await W.S.add(a); await W.S.add(b);
  eq(W.S.counts().unsent, 2, 'two unsent');
  await W.S.sync();
  ok(W.rawEvent(a.id)._sent === true, 'a sent');
  eq(W.rawEvent(b.id)._refused, 'bad place', 'b refused why');
  ok(!W.rawEvent(b.id)._sent, 'b not sent');
  const c = W.S.counts();
  eq([c.unsent, c.refused], [0, 1], 'counts');
  W.reqs.length = 0;
  await W.S.sync();
  ok(W.syncs().every((x) => !x.json.events.some((e) => e.id === b.id)), 'refused never re-sent');
  ok(W.syncs().every((x) => x.json.events.length === 0), 'nothing pushed');
  eq((await W.S.all()).length, 2, 'refused event stays in the book');
});

await t('pull loops while more, at most 10 rounds', async () => {
  const W = makeWorld(); W.connect();
  const r = W.DR.uuid();
  W.home.add(opened(W, r, T0));
  for (let i = 0; i < 6; i++) W.home.add(cut(W, r, T0 + 10 + i));
  W.home.limit = 2;
  await W.S.open();
  const res = await W.S.sync();
  ok(res.ok, 'ok');
  eq(res.pulled, 7, 'pulled count');
  eq(W.pulls().map((x) => x.json.cursor), [0, 2, 4, 6], 'cursors asked');
  eq((await W.S.all()).length, 7, 'all stored');
  eq(W.kv('cursor'), 7, 'cursor saved');

  const V = makeWorld(); V.connect();
  for (let i = 0; i < 15; i++) V.home.add(cut(V, r, T0 + i));
  V.home.limit = 1;
  await V.S.open();
  await V.S.sync();
  eq(V.pulls().length, 10, 'ten rounds at most');
  eq((await V.S.all()).length, 10, 'ten pulled');
  V.reqs.length = 0;
  await V.S.sync();
  eq(V.pulls()[0].json.cursor, 10, 'next sync goes on from the saved cursor');
});

await t('cursor lives in kv; reload uses it; an empty event store means cursor 0', async () => {
  const W = makeWorld(); W.connect();
  const r = W.DR.uuid();
  W.home.add(opened(W, r, T0)); W.home.add(cut(W, r, T0 + 1)); W.home.add(cut(W, r, T0 + 2));
  await W.S.open();
  await W.S.sync();
  eq(W.kv('cursor'), 3, 'kv cursor');
  // a reload over the same storage
  const W2 = makeWorld({ idb: W.idb, lsData: W.lsData, home: W.home, caches: W.caches });
  await W2.S.open();
  await W2.S.sync();
  eq(W2.pulls()[0].json.cursor, 3, 'reload pulls from the saved cursor');
  // storage of events wiped (cursor left behind in kv): cursor 0
  W.idb.dbs.get('dockread').stores.get('events').data.clear();
  const W3 = makeWorld({ idb: W.idb, lsData: W.lsData, home: W.home, caches: W.caches });
  await W3.S.open();
  await W3.S.sync();
  eq(W3.pulls()[0].json.cursor, 0, 'empty book pulls from 0');
  eq((await W3.S.all()).length, 3, 'book rebuilt');
});

await t('breath upload: 200 and 409 mark home, 410 stops it, 404 waits; only after its breath.kept is sent', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  await W.S.add(opened(W, r, T0));
  const statuses = [200, 409, 410, 404];
  const bs = [];
  for (let i = 0; i < 4; i++) {
    const c = cut(W, r, T0 + 10 + i); await W.S.add(c);
    const k = kept(W, r, c.data.n, T0 + 20 + i); await W.S.add(k);
    W.home.breathPost[k.data.b] = statuses[i];
    ok(await W.S.putBlob(k.data.b, new Blob([new Uint8Array([1, 2, 3, i])], { type: 'audio/webm;codecs=opus' }), { mime: 'audio/webm;codecs=opus', ms: 1200 }), 'putBlob');
    bs.push(k.data.b);
  }
  // a fifth whose breath.kept home refuses: never uploaded
  const c5 = cut(W, r, T0 + 30); await W.S.add(c5);
  const k5 = kept(W, r, c5.data.n, T0 + 31); await W.S.add(k5);
  W.home.refuse[k5.id] = 'no';
  await W.S.putBlob(k5.data.b, new Blob([new Uint8Array([9])]), { mime: 'audio/webm', ms: 900 });
  eq(W.S.counts().breathsNotHome, 5, 'five not home');
  await W.S.sync();
  const firstBreath = W.log.findIndex((x) => x.startsWith('fetch POST /api/breath/'));
  const lastPush = W.log.map((x, i) => [x, i]).filter(([x]) => x === 'fetch POST /api/sync').map(([, i]) => i)[0];
  ok(lastPush < firstBreath, 'events pushed before breaths');
  const posts = W.reqs.filter((x) => x.path.startsWith('/api/breath/'));
  eq(posts.map((x) => x.path.slice(12)).sort(), bs.slice().sort(), 'the four with a sent kept went up');
  ok(posts.every((x) => x.headers['Content-Type'] === 'audio/webm;codecs=opus'), 'mime as Content-Type');
  ok(W.rawBlob(bs[0]).home && W.rawBlob(bs[1]).home, '200 and 409 home');
  ok(W.rawBlob(bs[2]).gone && !W.rawBlob(bs[2]).home, '410 gone');
  ok(!('blob' in W.rawBlob(bs[2])), '410 deletes the bytes on this phone');
  eq(await W.S.getBlob(bs[2]), null, 'a gone breath has no bytes here');
  ok(!W.rawBlob(bs[3]).home && !W.rawBlob(bs[3]).gone, '404 waits');
  eq(W.S.counts().breathsNotHome, 1, 'the 404 only: a breath whose breath.kept home refused is not counted');
  W.reqs.length = 0;
  await W.S.sync();
  const again = W.reqs.filter((x) => x.path.startsWith('/api/breath/')).map((x) => x.path.slice(12));
  eq(again, [bs[3]], 'only the 404 tries again');
});

await t('fetchBlob: this phone first, else home, then kept here', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const b = W.DR.uuid();
  W.home.breathGet[b] = new Uint8Array([7, 7, 7]);
  eq(await W.S.getBlob(b), null, 'not here yet');
  const blob = await W.S.fetchBlob(b);
  ok(blob && blob.size === 3, 'got from home');
  eq(W.reqs.filter((x) => x.method === 'GET').length, 1, 'one GET');
  const again = await W.S.fetchBlob(b);
  ok(again && again.size === 3, 'kept');
  eq(W.reqs.filter((x) => x.method === 'GET').length, 1, 'no second GET');
  ok((await W.S.getBlob(b)).size === 3, 'getBlob sees it');
  ok(W.rawBlob(b).home === true, 'marked home (never uploaded)');
  eq(await W.S.fetchBlob(W.DR.uuid()), null, 'unknown -> null');
  eq(await W.S.fetchBlob('../../etc'), null, 'not a uuid -> null, no request');
  ok(W.reqs.every((x) => !x.path.includes('..')), 'no odd path');
  ok(await W.S.dropBlob(b), 'drop');
  eq(await W.S.getBlob(b), null, 'dropped here');
});

await t('step 5: the open round\'s missing breaths are fetched before change', async () => {
  const W = makeWorld(); W.connect();
  const old = W.DR.uuid(), r = W.DR.uuid();
  // a closed round with a breath, then the open one with two breaths (one home has, one it doesn't)
  W.home.add(opened(W, old, T0));
  const oc = cut(W, old, T0 + 1); W.home.add(oc);
  const ok0 = kept(W, old, oc.data.n, T0 + 2); W.home.add(ok0);
  W.home.add(closed(W, old, T0 + 3));
  W.home.add(opened(W, r, T0 + 10));
  const c1 = cut(W, r, T0 + 11), c2 = cut(W, r, T0 + 12);
  W.home.add(c1); W.home.add(c2);
  const k1 = kept(W, r, c1.data.n, T0 + 13), k2 = kept(W, r, c2.data.n, T0 + 14);
  W.home.add(k1); W.home.add(k2);
  W.home.state.breaths = { [ok0.data.b]: { have: true, text: '' }, [k1.data.b]: { have: true, text: '' },
                           [k2.data.b]: { have: false, text: '' } };
  W.home.breathGet[ok0.data.b] = new Uint8Array([1]);
  W.home.breathGet[k1.data.b] = new Uint8Array([2, 2]);
  await W.S.open();
  W.S.on('change', () => W.log.push('change'));
  const res = await W.S.sync();
  ok(res.ok, 'ok');
  const gets = W.reqs.filter((x) => x.method === 'GET').map((x) => x.path.slice(12));
  eq(gets, [k1.data.b], 'only the open round\'s breath home has');
  ok((await W.S.getBlob(k1.data.b)).size === 2, 'kept here');
  ok(W.log.indexOf('fetch GET /api/breath/' + k1.data.b) < W.log.indexOf('change'), 'fetched before change');
  ok(W.log.lastIndexOf('fetch POST /api/sync') < W.log.indexOf('change'), 'change comes last');
});

await t('a 401 marks the key refused, keeps the book, and stops asking', async () => {
  const W = makeWorld();
  W.lsData.set('dockread.cfg', JSON.stringify({ api: API, key: 'wrong-key', device: 'fold' }));
  await W.S.open();
  const r = W.DR.uuid();
  await W.S.add(opened(W, r, T0));
  const lines = [];
  W.S.on('line', (l) => lines.push(l));
  eq(W.S.line(), 'none', 'a key, never synced');
  const res = await W.S.sync();
  eq([res.ok, res.status], [false, 401], 'sync says 401');
  eq(W.S.line(), 'unset', 'LINE reads NOT SET');
  eq(lines, ['unset'], 'line event');
  ok(W.S.cfg().refused === true, 'cfg says refused');
  eq((await W.S.all()).length, 1, 'book kept');
  eq(W.S.counts().unsent, 1, 'still unsent');
  const n = W.reqs.length;
  const again = await W.S.sync();
  eq(again.status, 401, 'refused again');
  eq(W.reqs.length, n, 'no request with a refused key');
});

function linkFor(api, code) {
  return '#cfg=' + Buffer.from(JSON.stringify({ api, code })).toString('base64url');
}
const CODE = 'c'.repeat(32);

await t('takeLink scrubs the fragment before any request; adopt connects and syncs inside the flow', async () => {
  const W = makeWorld({ hash: linkFor(API, CODE) });
  await W.S.open();
  const link = W.S.takeLink();
  eq(W.log[0], 'scrub', 'scrubbed first');
  eq(W.loc.hash, '', 'hash gone');
  ok(!W.loc.href.includes('cfg='), 'href clean');
  eq(link.api, API, 'api read');
  eq(W.reqs.length, 0, 'no request yet');
  const res = await W.S.adopt(link);
  eq(res, { ok: true, why: '', synced: true }, 'adopted, and the first sync answered');
  const order = W.log.filter((x) => x.startsWith('fetch'));
  eq(order.slice(0, 2), ['fetch POST /api/connect', 'fetch GET /api/health'], 'connect then health');
  ok(order.slice(2).some((x) => x === 'fetch POST /api/sync'), 'first sync inside adopt');
  ok(W.log.indexOf('scrub') < W.log.indexOf('fetch POST /api/connect'), 'scrub before request');
  const conn = W.reqs[0];
  ok(!('Authorization' in conn.headers), 'connect carries no key');
  eq(conn.json.code, CODE, 'code sent');
  eq(W.reqs[1].headers.Authorization, 'Bearer ' + KEY, 'health with the new key');
  eq(JSON.parse(W.lsData.get('dockread.cfg')).key, KEY, 'key stored');
  eq(W.S.cfg(), { api: API, device: 'fold', refused: false }, 'cfg() hands out no key');
  eq(W.S.line(), 'home', 'line home after the first sync');
  // no link
  const V = makeWorld({ hash: '#reset' });
  eq(V.S.takeLink(), null, 'no cfg -> null');
  eq(V.log.length, 0, 'nothing scrubbed for #reset');
  const U = makeWorld({ hash: '#cfg=@@@' });
  eq(U.S.takeLink(), {}, 'garbage -> {}');
  eq(U.loc.hash, '', 'garbage scrubbed too');
});

await t('a wrong api shape or a missing code makes no request at all', async () => {
  const bad = ['http://evil.example:8660', 'https://evil.example:8660', 'https://box.ts.net:8650', 'https://box.ts.net',
               'http://box.ts.net:8660', 'http://127.0.0.1:8650', 'http://127.0.0.1:8660/x', 'http://127.0.0.1:8660/?a=1',
               'https://u:p@box.ts.net:8660', 'http://127.0.0.2:8660', 'javascript:alert(1)', '', null, 42];
  for (const api of bad) {
    const W = makeWorld();
    const res = await W.S.adopt({ api, code: CODE });
    ok(res.ok === false && res.why, 'refused ' + api);
    eq(W.reqs.length, 0, 'no request for ' + api);
    ok(!W.lsData.has('dockread.cfg'), 'nothing stored for ' + api);
  }
  for (const code of ['', 'short', 'has space in it xxxxxxxxxxxxxxxx', undefined]) {
    const W = makeWorld();
    const res = await W.S.adopt({ api: API, code });
    ok(!res.ok, 'bad code refused');
    eq(W.reqs.length, 0, 'no request for a bad code');
  }
  const W = makeWorld();
  eq((await W.S.adopt(null)).ok, false, 'null link'); eq(W.reqs.length, 0);
  for (const good of ['http://localhost:8660', 'https://mac.tail1234.ts.net:8660']) ok(W.S.apiShape(good), 'passes ' + good);
});

await t('the key is stored only after health says dockread', async () => {
  const cases = [
    ['connect 403', { 'POST /api/connect': () => ({ status: 403, json: { error: 'unknown, used or expired' } }) }],
    ['connect down', { 'POST /api/connect': () => 'network' }],
    ['connect no key', { 'POST /api/connect': () => ({ status: 200, json: { device: 'fold' } }) }],
    ['health 401', { 'GET /api/health': () => ({ status: 401, json: { error: 'no key' } }) }],
    ['health down', { 'GET /api/health': () => 'network' }],
    ['health names another app', { 'GET /api/health': () => ({ status: 200, json: { ok: true, name: 'otherapp' } }) }]
  ];
  for (const [name, routes] of cases) {
    const W = makeWorld();
    Object.assign(W.routes, routes);
    const res = await W.S.adopt({ api: API, code: CODE });
    ok(res.ok === false && typeof res.why === 'string' && res.why, name + ': refused');
    ok(!W.lsData.has('dockread.cfg'), name + ': nothing stored');
    ok(!W.reqs.some((x) => x.path === '/api/sync'), name + ': no sync');
    ok(!JSON.stringify(res).includes(KEY), name + ': no key in the answer');
  }
  // an old key is never sent to a new address
  const W = makeWorld(); W.connect();
  await W.S.adopt({ api: 'http://localhost:8660', code: CODE });
  ok(!('Authorization' in W.reqs[0].headers), 'old key not sent to connect');
});

await t('resetShell is refused offline; online it drops only this app\'s worker and shell caches', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  await W.S.add(opened(W, W.DR.uuid(), T0));
  let un = [];
  W.regs = [{ scope: 'http://127.0.0.1:8918/', unregister: async () => { un.push('mine'); return true; } },
            { scope: 'http://127.0.0.1:8918/other/', unregister: async () => { un.push('other'); return true; } }];
  for (const n of ['dockread-shell-abc', 'dockread-shell-def', 'dockread-voice-v1', 'otherapp-shell-v4']) await W.caches.open(n);
  W.online = false;
  const off = await W.S.resetShell();
  eq(off.ok, false, 'refused offline');
  eq(un, [], 'nothing unregistered');
  eq((await W.caches.keys()).length, 4, 'caches intact');
  W.online = true;
  const on = await W.S.resetShell();
  eq(on, { ok: true, why: '' }, 'ok online');
  eq(un, ['mine'], 'only this scope');
  eq((await W.caches.keys()).sort(), ['dockread-voice-v1', 'otherapp-shell-v4'], 'only dockread-shell- deleted');
  ok(W.lsData.has('dockread.cfg'), 'key kept');
  eq((await W.S.all()).length, 1, 'book kept');
  eq(W.reqs.length, 0, 'no request');
});

await t('forget removes only the key', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  W.S.setPref('muted', true);
  await W.S.add(opened(W, W.DR.uuid(), T0));
  await W.S.sync();
  const b = W.DR.uuid();
  await W.S.putBlob(b, new Blob([new Uint8Array([1])]), { mime: 'audio/webm', ms: 500 });
  ok(W.S.home(), 'state before');
  ok(W.S.forget(), 'forget');
  ok(!W.lsData.has('dockread.cfg'), 'key gone');
  eq(W.S.cfg(), null, 'cfg null');
  eq(W.S.line(), 'unset', 'line unset');
  eq(W.S.prefs().muted, true, 'prefs kept');
  eq((await W.S.all()).length, 1, 'book kept');
  ok(await W.S.getBlob(b), 'breath kept');
  ok(W.S.home(), 'state kept');
  eq(W.kv('cursor'), 1, 'cursor kept');
  const n = W.reqs.length;
  const res = await W.S.sync();
  eq(res.ok, false, 'no sync without a key');
  eq(W.reqs.length, n, 'no request');
});

await t('prints are never forgotten; home\'s newer copy of a period replaces the old', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const p = (period, value) => ({ period, label: period, value, by: 'fetch', source: 'ISM PDF', url: '', released: '', fetched_at: '2026-11-01T10:00:00-05:00' });
  W.home.state.series.ism_new_orders.prints = [p('2026-08', 48.1), p('2026-09', 49.0)];
  await W.S.sync();
  eq(W.S.series().ism_new_orders.prints.map((x) => x.period), ['2026-08', '2026-09'], 'first');
  W.home.state.series.ism_new_orders.prints = [p('2026-09', 49.4), p('2026-10', 51.2)];
  W.home.state.series.ism_new_orders.upcoming = [{ period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule', source: 'rule' }];
  await W.S.sync();
  const s = W.S.series().ism_new_orders;
  eq(s.prints.map((x) => [x.period, x.value]), [['2026-08', 48.1], ['2026-09', 49.4], ['2026-10', 51.2]], 'kept + revised');
  eq(s.upcoming.length, 1, 'the rest of the series is home\'s');
  eq(W.S.home().series.ism_new_orders.prints.length, 2, 'home() is State as sent');
  // a reload keeps the table
  const W2 = makeWorld({ idb: W.idb, lsData: W.lsData, home: W.home, caches: W.caches });
  await W2.S.open();
  eq(W2.S.series().ism_new_orders.prints.length, 3, 'kept across a reload');
  // series() feeds the reducer
  const st = W2.DR.reduce([], W2.S.series(), W2.DR.nowIso());
  eq(st.prints.ism_new_orders.length, 3, 'reduce sees the kept prints');
});

await t('line(): unset, home inside 15 minutes, then none', async () => {
  const W = makeWorld();
  await W.S.open();
  eq(W.S.line(), 'unset', 'no key');
  W.connect();
  eq(W.S.line(), 'none', 'key, no sync');
  await W.S.sync();
  eq(W.S.line(), 'home', 'just synced');
  W.off.ms = 14 * 60000;
  eq(W.S.line(), 'home', '14 minutes');
  W.off.ms = 15 * 60000 + 1000;
  eq(W.S.line(), 'none', '15 minutes on');
  W.off.ms = 0;
  W.routes['POST /api/sync'] = () => 'network';
  const res = await W.S.sync();
  eq([res.ok, res.status], [false, 0], 'no line is status 0');
});

await t('counts(): unsent, refused, breaths not home, clock off, registry mismatch', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  eq(W.S.counts(), { unsent: 0, refused: 0, breathsNotHome: 0, clockOffMin: null, registryMismatch: false }, 'empty');
  const r = W.DR.uuid();
  const a = opened(W, r, T0), b = cut(W, r, T0 + 1), c = cut(W, r, T0 + 2);
  W.home.refuse[c.id] = 'nope';
  await W.S.add(a); await W.S.add(b); await W.S.add(c);
  const kb = kept(W, r, b.data.n, T0 + 4);
  W.home.breathPost[kb.data.b] = 404;
  await W.S.add(kb);
  await W.S.putBlob(kb.data.b, new Blob([new Uint8Array([1])]), { mime: 'audio/webm', ms: 300 });
  W.home.state.now = utc(Date.now() + 30 * 60000);
  W.home.state.registry_version = 2;
  await W.S.sync();
  const k = W.S.counts();
  eq([k.unsent, k.refused, k.breathsNotHome], [0, 1, 1], 'marks');
  eq(k.clockOffMin, 30, 'home is 30 minutes ahead');
  eq(k.registryMismatch, true, 'registry differs');
  W.home.state.now = utc(Date.now() - 12 * 60000);
  W.home.state.registry_version = 1;
  await W.S.sync();
  eq([W.S.counts().clockOffMin, W.S.counts().registryMismatch], [-12, false], 'behind, same registry');
  await W.S.add(cut(W, r, T0 + 3));
  eq(W.S.counts().unsent, 1, 'new event counted at once');
});

await t('voiceClip: cache first, then home only on a HOME line inside waitMs; late answers cached; newest 600', async () => {
  const W = makeWorld();
  await W.S.open();
  let says = 0, hold = null;
  const wav = (n) => { const u = new Uint8Array(100); u[0] = n; return u; };
  W.routes['POST /api/say'] = async (req) => {
    says++;
    if (hold) await hold.p;
    return new Response(wav(req.json.text.length), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  };
  eq(await W.S.voiceClip('Orders up or down?', 2500), null, 'no key, no clip');
  eq(says, 0, 'no request without a line');
  W.connect();
  eq(await W.S.voiceClip('Orders up or down?', 2500), null, 'line none: no request');
  eq(says, 0, 'still none');
  await W.S.sync();
  eq(W.S.line(), 'home');
  const buf = await W.S.voiceClip('Orders up or down?', 2500);
  ok(buf && buf.byteLength === 100, 'clip from home');
  eq(says, 1, 'one say');
  const sayReq = W.reqs.find((x) => x.path === '/api/say');
  eq(sayReq.json, { text: 'Orders up or down?' }, 'words sent');
  const hex = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Orders up or down?'))).toString('hex');
  const vc = W.caches.names.get('dockread-voice-v1');
  ok([...vc.keys()].some((u) => u.endsWith(hex)), 'cached under the sha-256 of the text');
  const again = await W.S.voiceClip('Orders up or down?', 2500);
  ok(again && again.byteLength === 100, 'from cache');
  eq(says, 1, 'no second request');
  // the cache still answers when the line is down
  W.off.ms = 20 * 60000;
  ok(await W.S.voiceClip('Orders up or down?', 2500), 'cache answers with no line');
  W.off.ms = 0;
  // a late answer: null now, cached for next time
  let release; hold = { p: new Promise((r) => { release = r; }) };
  const late = W.S.voiceClip('Seven of eleven up.', 2500);
  await settle();
  await W.advance(2500);
  eq(await late, null, 'past waitMs: null');
  release(); hold = null;
  await settle(40);
  const now2 = await W.S.voiceClip('Seven of eleven up.', 2500);
  ok(now2 && now2.byteLength === 100, 'the late answer was cached');
  eq(says, 2, 'and not asked again');
  // a 503 is null and nothing cached
  W.routes['POST /api/say'] = () => ({ status: 503, json: { error: 'the voice is down' } });
  eq(await W.S.voiceClip('Down voice.', 2500), null, '503 null');
  eq(vc.size, 2, 'nothing cached for a 503');
  // cap: 600 newest
  for (let i = 0; i < 600; i++) vc.set('http://127.0.0.1:8918/voice-clip/old' + i, { bytes: new ArrayBuffer(50), type: 'audio/wav' });
  W.routes['POST /api/say'] = () => new Response(wav(1), { status: 200 });
  ok(await W.S.voiceClip('One more line.', 2500), 'new clip');
  eq(vc.size, 600, 'cache holds 600');
  ok(![...vc.keys()].some((u) => u.endsWith(hex)), 'the oldest went first');
  ok([...vc.keys()].pop().length > 60, 'the newest stays');
  eq(await W.S.voiceClip('', 2500), null, 'empty text');
});

await t('prefs: defaults, setPref, unknown keys ignored', async () => {
  const W = makeWorld();
  eq(W.S.prefs(), { muted: false, towns: false, guard: true, setup: false }, 'defaults');
  W.S.setPref('towns', true); W.S.setPref('setup', 1); W.S.setPref('evil', true);
  eq(W.S.prefs(), { muted: false, towns: true, guard: true, setup: true }, 'set');
  ok(!('evil' in JSON.parse(W.lsData.get('dockread.prefs'))), 'unknown key not stored');
  W.lsData.set('dockread.prefs', '{not json');
  eq(W.S.prefs().guard, true, 'bad json -> defaults');
});

await t('a sync runs two seconds after a new event, and on online', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  await W.S.add(opened(W, W.DR.uuid(), T0));
  eq(W.syncs().length, 0, 'not at once');
  await W.advance(1999);
  eq(W.syncs().length, 0, 'not before 2 s');
  await W.advance(1);
  await settle(40);
  ok(W.syncs().length >= 1, 'synced after 2 s');
  const n = W.syncs().length;
  for (const cb of W.listeners.online || []) cb();
  await settle(40);
  ok(W.syncs().length > n, 'online syncs');
});

await t('first notch asks for persistent storage once', async () => {
  const W = makeWorld();
  await W.S.open();
  const r = W.DR.uuid();
  await W.S.add(opened(W, r, T0));
  eq(W.log.filter((x) => x === 'persist').length, 0, 'not for a round');
  await W.S.add(cut(W, r, T0 + 1)); await W.S.add(cut(W, r, T0 + 2));
  eq(W.log.filter((x) => x === 'persist').length, 1, 'once');
});

await t('never throws: no IndexedDB, no caches, no crypto, a throwing fetch', async () => {
  const W = makeWorld();
  W.connect();
  const ctx = vm.createContext({ console, URL, Blob, Response, TextEncoder, TextDecoder,
    localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } },
    fetch() { throw new Error('sync throw'); }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0 });
  ctx.window = ctx;
  vm.runInContext(CORE, ctx); vm.runInContext(STORE, ctx);
  const S = ctx.DR.store;
  eq((await S.open()).ok, false, 'open says no');
  eq(await S.add({ id: 'x' }), false, 'add false');
  eq(JSON.stringify(await S.all()), '[]', 'all empty');
  eq(await S.getBlob('b'), null);
  eq(await S.fetchBlob(ctx.DR.uuid()), null);
  eq(await S.voiceClip('hi', 10), null);
  eq((await S.sync()).ok, false, 'sync false');
  eq((await S.adopt({ api: API, code: CODE })).ok, false, 'adopt false');
  eq(S.line(), 'unset'); eq(S.cfg(), null); eq(S.home(), null);
  eq(S.prefs().guard, true, 'prefs defaults');
  eq(S.takeLink(), null, 'no location');
  eq((await S.resetShell()).ok, true, 'nothing to reset');
  eq(await S.refreshPrints(), false);
  eq(JSON.stringify(S.series()), '{}');
});

await t('refreshPrints asks home and reports whether it ran', async () => {
  const W = makeWorld(); W.connect();
  W.routes['POST /api/print/refresh'] = () => ({ status: 200, json: { ok: true, ran: true } });
  eq(await W.S.refreshPrints(), true, 'ran');
  W.routes['POST /api/print/refresh'] = () => ({ status: 200, json: { ok: true, ran: false } });
  eq(await W.S.refreshPrints(), false, 'did not run');
  eq(W.reqs[0].json, {}, 'empty body');
});

/* ---------- rulings after the review (SPEC 15.22 to 15.24, 15.29, 15.35) ---------- */

// Six events (one home refuses) and one voice note, all synced once.
async function bookOf(W) {
  await W.S.open();
  const r = W.DR.uuid();
  const c = cut(W, r, T0 + 1);
  const k = kept(W, r, c.data.n, T0 + 2);
  const bad = cut(W, r, T0 + 5);
  W.home.refuse[bad.id] = 'bad place';
  const evs = [opened(W, r, T0), c, k, cut(W, r, T0 + 3), cut(W, r, T0 + 4), bad];
  for (const e of evs) await W.S.add(e);
  await W.S.putBlob(k.data.b, new Blob([new Uint8Array([1, 2, 3])]), { mime: 'audio/webm', ms: 900 });
  return { evs, k, bad };
}
const breathPosts = (W) => W.reqs.filter((x) => x.method === 'POST' && x.path.startsWith('/api/breath/'));
const pushedIds = (W) => W.syncs().flatMap((x) => (x.json.events || []).map((e) => e.id));

await t('a home that lost its book is refilled: a new book id re-bases the phone (15.22)', async () => {
  const W = makeWorld(); W.connect();
  const { k, bad } = await bookOf(W);
  const first = await W.S.sync();
  ok(first.ok && !first.partial, 'first sync whole ' + JSON.stringify(first));
  eq(W.home.events.length, 5, 'home holds five');
  ok(W.home.got[k.data.b] && W.rawBlob(k.data.b).home, 'the note is home');
  eq(W.kv('book'), BOOK1, 'the book id is kept beside the cursor');
  W.home.wipe(BOOK2);
  W.reqs.length = 0;
  const changes = [];
  W.S.on('change', (x) => changes.push(x));
  const res = await W.S.sync();
  eq([res.ok, res.partial], [true, true], 're-based: partial');
  eq(changes.map((x) => x.partial), [true], 'change says partial');
  eq(W.kv('book'), BOOK2, 'the new id stored');
  eq(W.kv('cursor'), 0, 'cursor back to 0');
  ok(!W.rawEvent(k.id)._sent, 'sent mark cleared');
  eq(W.rawEvent(bad.id)._refused, 'bad place', 'a refused event stays refused');
  ok(!W.rawBlob(k.data.b).home, 'home mark taken from State: home has no copy');
  await W.advance(3000); await settle(400);
  eq(W.home.events.length, 5, 'home holds five again');
  ok(W.home.got[k.data.b], 'the note went home again');
  eq(breathPosts(W).length, 1, 'one breath upload');
  ok(!pushedIds(W).includes(bad.id), 'a refused event is never sent again');
  eq(changes.map((x) => x.partial), [true, false], 'the follow-up sync is whole');
  const n = W.S.counts();
  eq([n.unsent, n.refused, n.breathsNotHome], [0, 1, 0], 'counts after the refill');
  eq(W.S.line(), 'home', 'line home');
  eq((await W.S.all()).length, 6, 'the phone lost nothing');
});

await t('a new adopt against the same home re-pushes only repeats and uploads no note home has (15.22)', async () => {
  const W = makeWorld(); W.connect();
  const { k, bad } = await bookOf(W);
  await W.S.sync();
  eq(breathPosts(W).length, 1, 'the note went up once');
  const refusedBefore = W.S.counts().refused;
  W.reqs.length = 0;
  let replies = [];
  W.routes['POST /api/sync'] = (req) => { const j = W.home.sync(req.json); replies.push(j); return { status: 200, json: j }; };
  const res = await W.S.adopt({ api: API, code: CODE });
  eq(res, { ok: true, why: '', synced: false }, 'a re-based first sync is not yet the whole book');
  ok(!W.rawBlob(k.data.b).gone && W.rawBlob(k.data.b).home, 'home has the note, State says so');
  await W.advance(3000); await settle(400);
  const pushed = pushedIds(W);
  eq(pushed.length, 5, 'the five home holds were pushed again');
  ok(!pushed.includes(bad.id), 'not the refused one');
  ok(replies.every((j) => j.refused.length === 0), 'home refused nothing');
  eq(breathPosts(W).length, 0, 'no note uploaded twice');
  eq(W.home.events.length, 5, 'home still holds five');
  eq(W.S.counts().refused, refusedBefore, 'no new refusals');
  eq(W.S.counts().unsent, 0, 'all sent');
});

await t('a home with no book id (older) changes nothing; a phone that never sent only stores the id (15.22)', async () => {
  const W = makeWorld(); W.connect();
  delete W.home.state.book;
  const { k } = await bookOf(W);
  ok(!(await W.S.sync()).partial, 'whole');
  W.reqs.length = 0;
  const res = await W.S.sync();
  ok(res.ok && !res.partial, 'still whole');
  eq(W.kv('book'), undefined, 'no id stored');
  eq(pushedIds(W).length, 0, 'nothing pushed again');
  ok(W.rawBlob(k.data.b).home, 'note still home');
  ok(W.pulls()[0].json.cursor > 0, 'cursor kept');

  const V = makeWorld(); V.connect();
  await bookOf(V);
  const first = await V.S.sync();
  ok(first.ok && !first.partial, 'a fresh phone: no re-base ' + JSON.stringify(first));
  eq(V.kv('book'), BOOK1, 'id stored');
  await V.advance(3000); await settle(400);
  eq(pushedIds(V).length, 6, 'each event pushed once, no second push');
  eq(breathPosts(V).length, 1, 'the note once');
});

await t('a pull longer than ten pages answers partial and the rest follows two seconds later (15.23)', async () => {
  const W = makeWorld(); W.connect();
  const r = W.DR.uuid();
  W.home.add(opened(W, r, T0));
  for (let i = 0; i < 30; i++) W.home.add(cut(W, r, T0 + 10 + i));
  W.home.limit = 2;
  await W.S.open();
  const changes = [];
  W.S.on('change', (x) => changes.push(x));
  const res = await W.S.sync();
  eq([res.ok, res.pulled, res.partial], [true, 20, true], 'first answer');
  eq(changes, [{ pulled: 20, partial: true }], 'change says partial');
  await W.advance(3000); await settle(400);
  eq((await W.S.all()).length, 31, 'the rest pulled');
  eq(changes[1], { pulled: 11, partial: false }, 'then whole');
});

await t('adopt answers synced:false when its first sync fails (15.23)', async () => {
  const W = makeWorld();
  W.routes['POST /api/sync'] = () => 'network';
  const res = await W.S.adopt({ api: API, code: CODE });
  eq(res, { ok: true, why: '', synced: false }, 'stored, not synced');
  ok(W.lsData.has('dockread.cfg'), 'key stored');
});

await t('a late 401 for the old key never marks the new key refused (15.23)', async () => {
  const W = makeWorld();
  W.lsData.set('dockread.cfg', JSON.stringify({ api: API, key: 'old-key', device: 'fold', refused: false }));
  await W.S.open();
  let release;
  const held = new Promise((r) => { release = r; });
  W.routes['POST /api/sync'] = async (req) => {
    if (req.headers.Authorization === 'Bearer old-key') { await held; return { status: 401, json: { error: 'no key' } }; }
    return { status: 200, json: W.home.sync(req.json) };
  };
  const old = W.S.sync();
  await settle();
  const ad = W.S.adopt({ api: API, code: CODE });
  await settle();
  release();
  const res = await ad;
  await old;
  eq(res, { ok: true, why: '', synced: true }, 'adopted');
  eq(W.S.cfg().refused, false, 'new key not refused');
  eq(W.S.line(), 'home', 'line home');
  eq(JSON.parse(W.lsData.get('dockread.cfg')).key, KEY, 'the new key kept');
});

await t('a voice clip with no breath.kept is not counted as not home (15.24)', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  await W.S.putBlob(W.DR.uuid(), new Blob([new Uint8Array([1])]), { mime: 'audio/webm', ms: 300 });
  await W.S.sync();
  eq(W.S.counts().breathsNotHome, 0, 'not on his record, not counted');
  eq(breathPosts(W).length, 0, 'and not sent');
});

await t('the worker installs each file with ?v=<stamp> and keeps it under its plain address (15.29)', async () => {
  const SW = fs.readFileSync(path.join(SHELL, 'sw.js'), 'utf8');
  const stamp = SW.match(/const CACHE = PREFIX \+ "([0-9a-f]{12})";/)[1];
  const list = JSON.parse(SW.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, ']'));
  const run = async (failOn) => {
    const caches = makeCaches(), got = [], on = {};
    const ctx = { console, URL, Response, caches,
      self: { addEventListener: (n, cb) => { on[n] = cb; }, skipWaiting: async () => { got.push('skip'); },
              location: { origin: 'http://127.0.0.1:8918' } },
      fetch: async (u, init) => { got.push([u, init.cache]); return new Response('x', { status: u.startsWith(failOn) ? 404 : 200 }); } };
    vm.createContext(ctx);
    vm.runInContext(SW, ctx, { filename: 'sw.js' });
    let p = null;
    on.install({ waitUntil: (x) => { p = x; } });
    let err = null;
    try { await p; } catch (e) { err = e; }
    return { caches, got, err };
  };
  const a = await run('nothing');
  ok(!a.err, 'installed');
  const fetched = a.got.filter((x) => Array.isArray(x));
  eq(fetched.map((x) => x[0]), list.map((u) => u + '?v=' + stamp), 'every file asked for under its stamp');
  ok(fetched.every((x) => x[1] === 'reload'), 'past the HTTP cache too');
  eq([...a.caches.names.get('dockread-shell-' + stamp).keys()].sort(), list.slice().sort(), 'kept under the plain address');
  const b = await run('./app.css');
  ok(b.err && !b.got.includes('skip'), 'one miss fails the install');
});

await t('the store and the worker name no other project (15.35)', async () => {
  const SW = fs.readFileSync(path.join(SHELL, 'sw.js'), 'utf8');
  const ME = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const [name, text] of [['store.js', STORE], ['sw.js', SW], ['test_store.mjs', ME]]) {
    ok(!/g[o]ose/i.test(text), name + ' names another project');
  }
});

/* ---------- after the second review (SPEC 15.45, 15.52, 15.23) ---------- */

// Replies seen by the phone, through the fake home (the key check stays the default route's).
function tapReplies(W) {
  const replies = [];
  W.routes['POST /api/sync'] = (req) => {
    if ((req.headers.Authorization || '') !== 'Bearer ' + KEY) return { status: 401, json: { error: 'no key' } };
    const j = W.home.sync(req.json); replies.push(j); return { status: 200, json: j };
  };
  return replies;
}

await t('a home restored from a backup with the same book id is refilled: the mark re-bases the phone (15.52)', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  const mine = [opened(W, r, T0)];
  for (let i = 1; i < 5; i++) mine.push(cut(W, r, T0 + i));
  for (const e of mine) await W.S.add(e);
  const first = await W.S.sync();
  ok(first.ok && !first.partial, 'first sync whole');
  eq(W.home.events.length, 5, 'home holds five');
  // The backup held the first three rows: same book id, numbering back to 3. Then another phone adds two.
  W.home.events = W.home.events.slice(0, 3); W.home.seq = 3;
  const o1 = cut(W, r, T0 + 100), o2 = cut(W, r, T0 + 101);
  W.home.add(o1); W.home.add(o2);
  W.reqs.length = 0;
  const res = await W.S.sync();
  eq([res.ok, res.partial], [true, true], 'home said the mark is gone: re-based, partial');
  await W.advance(3000); await settle(400);
  const held = W.home.events.map((x) => x.id);
  ok(mine.every((e) => held.includes(e.id)), 'home holds all five of this phone\'s events again');
  ok(pushedIds(W).includes(mine[3].id) && pushedIds(W).includes(mine[4].id), 'the two lost events were pushed again');
  const here = (await W.S.all()).map((e) => e.id);
  ok(here.includes(o1.id) && here.includes(o2.id), 'the other phone\'s two events landed here');
  eq(here.length, 7, 'seven here');
  const later = await W.S.sync();
  ok(later.ok && !later.partial, 'a later sync is whole ' + JSON.stringify(later));
  eq(W.S.counts().unsent, 0, 'nothing unsent');
});

await t('pushed but not pulled: a home cut back to before the push is refilled (15.52)', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  const r = W.DR.uuid();
  for (const e of [opened(W, r, T0), cut(W, r, T0 + 1), cut(W, r, T0 + 2)]) await W.S.add(e);
  ok((await W.S.sync()).ok, 'first sync');
  const b1 = cut(W, r, T0 + 3), b2 = cut(W, r, T0 + 4);
  await W.S.add(b1); await W.S.add(b2);
  // The push lands; the pull after it fails.
  W.routes['POST /api/sync'] = (req) => (req.json.events.length ? { status: 200, json: W.home.sync(req.json) } : 'network');
  const mid = await W.S.sync();
  ok(!mid.ok, 'the pull failed');
  eq(W.home.events.length, 5, 'the push landed');
  ok(W.rawEvent(b1.id)._sent && W.rawEvent(b2.id)._sent, 'marked sent');
  delete W.routes['POST /api/sync'];
  // Home is restored to before the push.
  W.home.events = W.home.events.slice(0, 3); W.home.seq = 3;
  W.reqs.length = 0;
  const res = await W.S.sync();
  eq([res.ok, res.partial], [true, true], 're-based, partial');
  await W.advance(3000); await settle(400);
  const held = W.home.events.map((x) => x.id);
  ok(held.includes(b1.id) && held.includes(b2.id), 'both pushed again');
  eq(W.home.events.length, 5, 'home holds five again');
  const later = await W.S.sync();
  ok(later.ok && !later.partial, 'a later sync is whole');
  eq(W.S.counts().unsent, 0, 'nothing unsent');
});

await t('steady state: eight mixed syncs never re-base, re-push nothing, are partial only by the page rule (15.52)', async () => {
  const W = makeWorld(); W.connect();
  const replies = tapReplies(W);
  W.home.limit = 2;
  await W.S.open();
  const changes = [];
  W.S.on('change', (x) => changes.push(x));
  const r = W.DR.uuid();
  let added = 0, other = 0;
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) { await W.S.add(cut(W, r, T0 + i * 10)); added++; }
    if (i % 3 === 0) { for (let j = 0; j < 3; j++) W.home.add(cut(W, r, T0 + 1000 + i * 10 + j)); other += 3; }
    // once: more than ten pages waiting, so that sync is partial by the page rule
    if (i === 5) { for (let j = 0; j < 25; j++) W.home.add(cut(W, r, T0 + 5000 + j)); other += 25; }
    await W.S.sync();
    await W.advance(2500); await settle(400);
  }
  const ids = pushedIds(W);
  eq(ids.length, added, 'each of this phone\'s events pushed once, none again');
  eq(new Set(ids).size, ids.length, 'no id pushed twice');
  eq(replies.filter((j) => j.mark_ok === false).length, 0, 'home never said the mark was gone');
  ok(replies.slice(1).every((j) => j.mark_ok === true), 'every request after the first carried a good mark');
  ok(replies.filter((j) => j.more === true).length > 10, 'pulls of more than one page');
  eq(changes.filter((x) => x.partial).length, 1, 'partial once: the page rule');
  eq((await W.S.all()).length, added + other, 'the book is whole');
});

await t('an older home with no top and no mark_ok changes nothing (15.52)', async () => {
  const W = makeWorld(); W.connect();
  W.home.old = true;
  await W.S.open();
  const r = W.DR.uuid();
  await W.S.add(opened(W, r, T0)); await W.S.add(cut(W, r, T0 + 1));
  const a = await W.S.sync();
  ok(a.ok && !a.partial, 'whole');
  ok(W.kv('mark') === undefined || W.kv('mark') === null, 'no mark kept');
  ok(W.syncs().every((x) => !('mark' in x.json)), 'no mark sent');
  // A phone that kept a mark from a newer home: the older home's replies leave it alone.
  const V = makeWorld(); V.connect();
  await V.S.open();
  await V.S.add(opened(V, r, T0)); await V.S.add(cut(V, r, T0 + 1));
  ok((await V.S.sync()).ok, 'synced with a newer home');
  const kept0 = JSON.stringify(V.kv('mark'));
  ok(Array.isArray(V.kv('mark')), 'a mark kept');
  V.home.old = true;
  V.home.add(cut(V, r, T0 + 2));
  await V.S.add(cut(V, r, T0 + 3));
  V.reqs.length = 0;
  const b = await V.S.sync();
  ok(b.ok && !b.partial, 'still whole');
  eq(JSON.stringify(V.kv('mark')), kept0, 'the mark unchanged');
  eq(pushedIds(V).length, 1, 'only the new event pushed');
  eq((await V.S.all()).length, 4, 'the other event pulled');
});

await t('a fresh phone sends no mark on its first request, then sends the top it got (15.52)', async () => {
  const W = makeWorld(); W.connect();
  const replies = tapReplies(W);
  W.home.add(opened(W, W.DR.uuid(), T0));
  await W.S.open();
  await W.S.add(cut(W, W.DR.uuid(), T0 + 1));
  await W.S.sync();
  const s = W.syncs();
  ok(s.length >= 2, 'a push and a pull');
  ok(!('mark' in s[0].json), 'no mark on the first request');
  eq(s[1].json.mark, replies[0].top, 'the second carries the first reply\'s top');
  eq(W.kv('mark'), replies[replies.length - 1].top, 'the last top is kept');
  // a reload sends the kept mark
  const W2 = makeWorld({ idb: W.idb, lsData: W.lsData, home: W.home, caches: W.caches });
  await W2.S.open();
  await W2.S.sync();
  eq(W2.syncs()[0].json.mark, W.kv('mark'), 'the kept mark is loaded and sent after a reload');
});

await t('after adopt the first request sends no mark (15.52)', async () => {
  const W = makeWorld(); W.connect();
  await W.S.open();
  await W.S.add(opened(W, W.DR.uuid(), T0));
  await W.S.sync();
  ok(Array.isArray(W.kv('mark')), 'a mark kept before');
  W.reqs.length = 0;
  const res = await W.S.adopt({ api: API, code: CODE });
  ok(res.ok, 'adopted');
  const s = W.syncs();
  ok(s.length >= 1, 'synced inside adopt');
  ok(!('mark' in s[0].json), 'the first request after adopt carries no mark');
});

await t('a pull that broke part way is retried two seconds later; a retry that pulls nothing arms no other (15.45)', async () => {
  const W = makeWorld(); W.connect();
  const r = W.DR.uuid();
  for (let i = 0; i < 5; i++) W.home.add(cut(W, r, T0 + i));
  W.home.limit = 2;
  let pagesOk = Infinity;   // pulls that answer before the line drops
  W.routes['POST /api/sync'] = (req) => {
    if (req.json.events.length === 0) { if (pagesOk <= 0) return 'network'; pagesOk--; }
    return { status: 200, json: W.home.sync(req.json) };
  };
  await W.S.open();
  const changes = [];
  W.S.on('change', (x) => changes.push(x));
  pagesOk = 1;
  const res = await W.S.sync();
  eq(res.ok, false, 'the pull failed');
  eq(changes, [{ pulled: 2, partial: true }], 'change says partial');
  pagesOk = Infinity;
  let n = W.syncs().length;
  await W.advance(1999);
  eq(W.syncs().length, n, 'not before 2 s');
  await W.advance(1); await settle(40);
  ok(W.syncs().length > n, 'retried two seconds later, not at the five-minute tick');
  eq((await W.S.all()).length, 5, 'the rest pulled');
  eq(changes[changes.length - 1].partial, false, 'then whole');
  // Again a pull breaks part way, and this time the retry fails having pulled nothing.
  for (let i = 0; i < 4; i++) W.home.add(cut(W, r, T0 + 10 + i));
  pagesOk = 1;
  await W.S.sync();
  pagesOk = 0;
  n = W.syncs().length;
  await W.advance(2000); await settle(40);
  eq(W.syncs().length, n + 1, 'one retry');
  const m = W.syncs().length;
  for (let i = 0; i < 60; i++) await W.advance(1000);
  eq(W.syncs().length, m, 'no retry after a retry that pulled nothing');
});

await t('a late 401 for the old key from a print refresh never marks the new key refused (15.23)', async () => {
  const W = makeWorld();
  W.lsData.set('dockread.cfg', JSON.stringify({ api: API, key: 'old-key', device: 'fold', refused: false }));
  await W.S.open();
  let release;
  const held = new Promise((r) => { release = r; });
  W.routes['POST /api/print/refresh'] = async () => { await held; return { status: 401, json: { error: 'no key' } }; };
  const rp = W.S.refreshPrints();
  await settle();
  const res = await W.S.adopt({ api: API, code: CODE });
  eq(res, { ok: true, why: '', synced: true }, 'adopted');
  release();
  eq(await rp, false, 'the old refresh answered no');
  await settle();
  eq(W.S.cfg().refused, false, 'new key not refused');
  eq(W.S.line(), 'home', 'line home');
});

console.log((failed ? 'STORE FAILED: ' + failed + ' of ' + (passed + failed) : 'STORE OK: ' + passed + ' scenarios'));
process.exit(failed ? 1 : 0);
