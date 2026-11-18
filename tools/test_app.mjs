// Tests for shell/js/app.js (SPEC 9.3 to 9.10, 9.12). Node, no packages.
// Each scenario loads the real core.js and the real app.js into a fresh vm context with scripted fakes for
// DR.store, DR.sound, DR.geo and DR.surface (every call recorded; overlays answered by the test), a fake
// page (document, navigator, location, history, fetch) and a clock the test moves by hand.
// Uncaught errors and unhandled rejections are fatal.
// Run: node shell/tools/test_app.mjs   (exit 1 on any failure)
process.env.TZ = 'America/New_York';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const CORE = fs.readFileSync(path.join(SHELL, 'js', 'core.js'), 'utf8');
const APP = fs.readFileSync(path.join(SHELL, 'js', 'app.js'), 'utf8');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(SHELL, 'registry.json'), 'utf8'));

let passed = 0, failed = 0;
function fail(name, msg) { failed++; console.log('FAIL ' + name + ': ' + msg); }
process.on('uncaughtException', e => { console.log('FATAL uncaught: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', e => { console.log('FATAL unhandled rejection: ' + (e && e.stack || e)); process.exit(1); });
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { fail(name, e && e.message ? e.message : String(e)); }
}
function ok(c, what) { if (!c) throw new Error(what || 'not true'); }
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what ? what + ': ' : '') + 'got ' + sa + ' want ' + sb);
}
const clone = o => JSON.parse(JSON.stringify(o));
const tick = () => new Promise(r => setImmediate(r));
async function flush(n = 30) { for (let i = 0; i < n; i++) await tick(); }

/* ── time and events ───────────────────────────────────────────────────── */
const NOW = Date.parse('2026-11-17T15:00:00.000Z');     // 10:00 in New York, winter
const uuid = () => globalThis.crypto.randomUUID();
const iso = ms => new Date(ms).toISOString();
function E(type, round, data, at) {
  return { id: uuid(), dev: '', at: iso(at), tz: -300, type, round: round === undefined ? null : round, data };
}
function aim(o = {}) { return Object.assign({ after: '', period: '', label: '', date: '', time_et: '', conf: 'none' }, o); }
function opened(lane, at, o = {}) {
  const c = REGISTRY.canon[lane];
  const rid = uuid();
  const d = Object.assign({ lane, q: c.q, say: c.say, words: c.words.slice(), twin: c.twin, origin: 'canon', aim: aim(), from: null }, o);
  return { rid, ev: E('round.opened', rid, d, at) };
}
function cuts(rid, ups, start, gap = 60000) {
  return ups.map((up, i) => E('notch.cut', rid, { n: uuid(), up, place: null }, start + i * gap));
}
function pr(period, label, value, o = {}) {
  return Object.assign({ period, label, value, by: 'fetch', source: 'TEST', url: '', released: '', fetched_at: '2026-11-16T10:00:00-05:00' }, o);
}
function seriesOf(map) {
  const out = {};
  for (const [sid, v] of Object.entries(map)) out[sid] = Object.assign({ prints: [], upcoming: [], question: '', status: 'ok', checked_at: '', note: '' }, v);
  return out;
}
const PLACES = ['JOLIET|IL', 'GARY|IN', 'JOLLY|TX'];
const BLOB = { size: 100, fake: 'blob' };

/* ── a world: fresh context, fakes, the app booted ─────────────────────── */
async function world(o = {}) {
  const T = { now: o.now || NOW, mono: 1000 };          // wall clock and performance.now(); timers run on mono
  const timers = []; let tid = 0;
  const order = [];                                     // one shared log of who did what, in order
  const consoleLines = [];

  const ctxTimers = {
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, at: T.mono + Math.max(0, +ms || 0), fn, every: 0 }); return id; },
    clearTimeout: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = ++tid; timers.push({ id, at: T.mono + ms, fn, every: ms }); return id; },
    clearInterval: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };

  /* store */
  const ST = {
    events: (o.events || []).map(clone), prefsV: Object.assign({ muted: false, towns: false, guard: true, setup: true }, o.prefs || {}),
    cfgV: o.key ? { api: 'http://127.0.0.1:8660', device: 'fold', refused: false } : null,
    lineV: o.key ? (o.line || 'none') : 'unset', homeV: o.home || null, seriesV: o.series || {},
    blobs: new Map(Object.entries(o.blobs || {})), listeners: {}, calls: [], syncs: [], syncQueue: (o.syncs || []).slice(),
    countsV: Object.assign({ unsent: 0, refused: 0, breathsNotHome: 0, clockOffMin: null, registryMismatch: false }, o.counts || {}),
    linkV: o.link || null, pendingSync: null,
    addFail: !!o.addFail, addDelay: 0, blobFail: false, refreshHold: null, openOk: o.openOk !== false,
  };
  const emitS = (n, a) => (ST.listeners[n] || []).slice().forEach(cb => cb(a));
  const upsert = e => { const i = ST.events.findIndex(x => x.id === e.id); if (i >= 0) ST.events[i] = clone(e); else ST.events.push(clone(e)); };
  const sortEv = l => l.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1));
  let ctx;
  const store = {
    open: async () => { ST.calls.push(['open']); order.push('open'); return { ok: ST.openOk }; },
    add: async e => {
      const why = ctx.DR.validate(e, new Set(PLACES));
      if (why) throw new Error('app wrote an invalid event: ' + e.type + ' ' + why);
      if (ST.addFail) { order.push('add refused ' + e.type); return false; }
      if (ST.addDelay) { order.push('add START ' + e.type); await new Promise(r => ctxTimers.setTimeout(r, ST.addDelay)); }
      ST.calls.push(['add', e.type]); order.push('add ' + e.type); upsert(e); return true;
    },
    all: async () => sortEv(ST.events).map(clone),
    putBlob: async (b, blob, m) => { ST.calls.push(['putBlob', b, m]); if (ST.blobFail) return false; ST.blobs.set(b, blob); return true; },
    getBlob: async b => ST.blobs.get(b) || null,
    fetchBlob: async b => { ST.calls.push(['fetchBlob', b]); return ST.blobs.get(b) || null; },
    dropBlob: async b => { ST.calls.push(['dropBlob', b]); ST.blobs.delete(b); return true; },
    prefs: () => Object.assign({}, ST.prefsV),
    setPref: (k, v) => { if (k in ST.prefsV) ST.prefsV[k] = !!v; ST.calls.push(['setPref', k, !!v]); return Object.assign({}, ST.prefsV); },
    cfg: () => ST.cfgV ? Object.assign({}, ST.cfgV) : null,
    takeLink: () => { order.push('takeLink'); const l = ST.linkV; ST.linkV = null; return l; },
    // synced: the real adopt's own first sync came back whole (SPEC 15.23).
    adopt: async link => { order.push('adopt'); ST.calls.push(['adopt', link]); ST.cfgV = { api: link.api, device: 'fold', refused: false }; ST.lineV = 'home'; return { ok: true, why: '', synced: o.adoptSynced !== false }; },
    // As the real store: forgetting the key changes the line, and a changed line is emitted.
    forget: () => { ST.calls.push(['forget']); ST.cfgV = null; const was = ST.lineV; ST.lineV = 'unset'; if (was !== 'unset') emitS('line', 'unset'); return true; },
    resetShell: async () => { ST.calls.push(['resetShell']); return { ok: true, why: '' }; },
    sync: () => {
      order.push('sync'); ST.syncs.push(T.now);
      const s = ST.syncQueue.shift() || { ok: !!ST.cfgV, status: ST.cfgV ? 200 : 0 };
      const run = s2 => {
        (s2.pull || []).forEach(upsert);
        if (s2.home) ST.homeV = s2.home;
        if (s2.series) ST.seriesV = s2.series;
        const partial = !!s2.partial;                   // pages left at home, or a re-base (SPEC 15.23)
        if (s2.ok) { ST.lineV = 'home'; emitS('change', { pulled: (s2.pull || []).length, partial }); }
        const r = { ok: !!s2.ok, status: s2.status || (s2.ok ? 200 : 0) };
        if (s2.ok && partial) r.partial = true;
        return r;
      };
      if (s.defer) return new Promise(res => { ST.pendingSync = s2 => res(run(s2)); });
      return Promise.resolve(run(s));
    },
    home: () => ST.homeV ? clone(ST.homeV) : null,
    series: () => clone(ST.seriesV),
    line: () => ST.lineV,
    counts: () => Object.assign({}, ST.countsV),
    voiceClip: async () => null,
    refreshPrints: () => { ST.calls.push(['refreshPrints']); return ST.refreshHold ? new Promise(r => { ST.refreshHold = () => r(true); }) : Promise.resolve(true); },
    on: (n, cb) => { (ST.listeners[n] = ST.listeners[n] || []).push(cb); return () => {}; },
  };

  /* sound */
  const SO = { calls: [], says: [], recQueue: (o.records || []).slice(), pendingRec: null, mic: o.mic || 'granted', muted: false, holdPlay: false, playing: [] };
  const endPlays = () => { const p = SO.playing; SO.playing = []; p.forEach(r => r()); };
  const sound = {
    unlock: () => SO.calls.push(['unlock']),
    tick: () => SO.calls.push(['tick']), bell: () => SO.calls.push(['bell']), click: () => SO.calls.push(['click']),
    knock: () => SO.calls.push(['knock']), breath: () => SO.calls.push(['breath']), swish: () => SO.calls.push(['swish']),
    buzz: p => SO.calls.push(['buzz', p]),
    say: text => { SO.says.push(text); SO.calls.push(['say', text]); order.push('say'); return Promise.resolve(); },
    warm: texts => SO.calls.push(['warm', texts]),
    hush: () => { SO.calls.push(['hush']); endPlays(); },
    mute: m => { SO.muted = !!m; SO.calls.push(['mute', !!m]); },
    muted: () => SO.muted,
    askMic: async () => { SO.calls.push(['askMic']); SO.mic = 'granted'; return 'granted'; },
    record: opts => {
      const rec = { openMs: opts.openMs, maxMs: opts.maxMs, level: typeof opts.onLevel === 'function' };
      if (opts.raw) rec.raw = true;
      SO.calls.push(['record', rec]);
      order.push('record');
      if (typeof opts.onLevel === 'function') opts.onLevel(0.4);
      if (SO.recQueue.length) { const r = SO.recQueue.shift(); if (r !== 'hold') return Promise.resolve(r); }
      return new Promise(res => { SO.pendingRec = res; });
    },
    cancelRecord: () => { SO.calls.push(['cancelRecord']); if (SO.pendingRec) { const r = SO.pendingRec; SO.pendingRec = null; r(null); } },
    play: (blob, opts) => { SO.calls.push(['play', opts && opts.maxMs]); return SO.holdPlay ? new Promise(r => SO.playing.push(r)) : Promise.resolve(); },
    micState: async () => SO.mic,
  };

  /* geo */
  const GE = { calls: [], state: o.geo || 'granted', townV: o.town === undefined ? null : o.town, guardCb: null, guardStops: 0 };
  const geo = {
    load: async () => { GE.calls.push(['load']); },
    places: () => new Set(PLACES),
    find: p => PLACES.map(x => x.split('|')).filter(x => x[0].startsWith(p)).map(x => ({ city: x[0], st: x[1] })),
    nearest: () => [],
    town: async () => { GE.calls.push(['town']); return GE.townV; },
    towns: async k => { GE.calls.push(['towns', k]); return [{ city: 'GARY', st: 'IN' }]; },
    ask: async () => { GE.calls.push(['ask']); GE.state = 'granted'; return 'granted'; },
    guard: cb => { GE.calls.push(['guard']); GE.guardCb = cb; return () => { GE.guardStops++; GE.guardCb = null; }; },
    state: async () => GE.state,
  };

  /* surface */
  const SU = { renders: [], calls: [], open: {}, listeners: {}, opened: [] };
  const ov = (kind, opts) => new Promise(res => {
    if (SU.open[kind]) { const old = SU.open[kind]; delete SU.open[kind]; old.res(null); }
    SU.open[kind] = { o: clone(opts || {}), res };
    SU.opened.push([kind, clone(opts || {})]);
    order.push('ov ' + kind);
  });
  const surface = {
    mount: () => SU.calls.push(['mount']), fit: () => {},
    render: v => { SU.renders.push(clone(v)); },
    halves: o2 => ov('halves', o2), bands: o2 => ov('bands', o2), card: o2 => ov('card', o2),
    entry: o2 => ov('entry', o2), counter: o2 => ov('counter', o2),
    closeAll: () => { SU.calls.push(['closeAll']); for (const k of Object.keys(SU.open)) { const r = SU.open[k]; delete SU.open[k]; r.res(null); } },
    busy: () => Object.keys(SU.open).length > 0,
    on: (n, cb) => { (SU.listeners[n] = SU.listeners[n] || []).push(cb); return () => {}; },
  };
  ['needle', 'hand', 'bridge', 'arrow', 'bezel', 'plate', 'figure', 'beam', 'tag', 'retrace'].forEach(k => {
    surface[k] = (...a) => { SU.calls.push([k, ...clone(a.map(x => x === undefined ? null : x))]); };
  });

  /* the page */
  const DOC = { visibilityState: 'visible', hidden: false, listeners: {} };
  const document = {
    get visibilityState() { return DOC.visibilityState; }, get hidden() { return DOC.hidden; },
    addEventListener: (n, cb) => { (DOC.listeners[n] = DOC.listeners[n] || []).push(cb); },
  };
  const NAV = { wakeReq: 0, released: 0, swListeners: {}, posted: [], registered: [] };
  const navigator = {
    onLine: true,
    wakeLock: { request: async () => { NAV.wakeReq++; return { release: async () => { NAV.released++; }, addEventListener: () => {} }; } },
    serviceWorker: {
      controller: o.controller ? { postMessage: m => NAV.posted.push(m) } : null,
      register: async (u, opts) => { NAV.registered.push([u, opts]); return { update: async () => {} }; },
      addEventListener: (n, cb) => { (NAV.swListeners[n] = NAV.swListeners[n] || []).push(cb); },
    },
  };
  const LOC = { reloads: 0, replaced: 0 };
  const location = { hash: o.hash || '', href: 'http://127.0.0.1:8918/', pathname: '/', search: '', reload: () => { LOC.reloads++; order.push('reload'); } };
  const history = { replaceState: () => { LOC.replaced++; } };
  const winListeners = {};

  ctx = vm.createContext({
    __T: T, console: { log: () => {}, warn: m => consoleLines.push(String(m)), error: m => consoleLines.push(String(m)) },
    crypto: globalThis.crypto, TextEncoder, URL, performance: { now: () => T.mono },
    document, navigator, location, history,
    fetch: async u => { order.push('fetch ' + u); return u === 'registry.json' ? { ok: true, json: async () => clone(REGISTRY) } : { ok: false }; },
    addEventListener: (n, cb) => { (winListeners[n] = winListeners[n] || []).push(cb); },
    ...ctxTimers,
  });
  ctx.window = ctx;
  vm.runInContext(`(function () {
    var RD = Date, T = globalThis.__T;
    function D() { if (!new.target) return new RD(T.now).toString(); return arguments.length ? new (Function.prototype.bind.apply(RD, [null].concat([].slice.call(arguments))))() : new RD(T.now); }
    D.now = function () { return T.now; }; D.parse = RD.parse; D.UTC = RD.UTC; D.prototype = RD.prototype;
    globalThis.Date = D;
  })();`, ctx);
  vm.runInContext(CORE, ctx, { filename: 'core.js' });
  ctx.DR.store = store; ctx.DR.sound = sound; ctx.DR.geo = geo; ctx.DR.surface = surface;

  const W = {
    ctx, T, ST, SO, GE, SU, DOC, NAV, LOC, order, consoleLines, timers, DR: ctx.DR,
    async advance(ms) {
      const end = T.mono + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = timers[0] && timers[0].at <= end ? timers[0] : null;
        if (!due) break;
        timers.shift();
        const d = Math.max(0, due.at - T.mono);
        T.mono += d; T.now += d;
        if (due.every) timers.push({ id: due.id, at: due.at + due.every, fn: due.fn, every: due.every });
        due.fn();
      }
      T.now += end - T.mono; T.mono = end;
      await flush();
    },
    // The phone's clock is set by hand or by the network: the wall moves, time does not.
    stepWall(ms) { T.now += ms; },
    // A frozen page: time passes and no timer runs.
    async frozen(ms) { T.mono += ms; T.now += ms; await flush(); },
    async until(cond, what, maxMs = 0) {
      for (let i = 0; i < 300; i++) { if (cond()) return; await flush(3); }
      if (maxMs) { for (let s = 0; s < maxMs; s += 100) { if (cond()) return; await W.advance(100); } }
      if (!cond()) throw new Error('timed out waiting for ' + (what || 'a condition'));
    },
    emit(n, a) { (SU.listeners[n] || []).slice().forEach(cb => cb(a)); },
    touch() { (DOC.listeners.pointerdown || []).forEach(cb => cb({})); },
    async tap(n, a) { W.touch(); W.emit(n, a); await flush(); },
    async answer(kind, v, maxMs = 30000) {
      await W.until(() => SU.open[kind], 'overlay ' + kind, maxMs);
      const r = SU.open[kind]; delete SU.open[kind]; r.res(v); await flush();
      return r.o;
    },
    openOpts(kind) { return SU.open[kind] ? SU.open[kind].o : null; },
    view() { return SU.renders[SU.renders.length - 1]; },
    added() { return ST.calls.filter(c => c[0] === 'add').map(c => c[1]); },
    evs(type) { return sortEv(ST.events).filter(e => e.type === type); },
    newEvents(before) { return ST.events.slice(before); },
    async hide() { DOC.visibilityState = 'hidden'; DOC.hidden = true; (DOC.listeners.visibilitychange || []).forEach(cb => cb()); await flush(); },
    async show() { DOC.visibilityState = 'visible'; DOC.hidden = false; (DOC.listeners.visibilitychange || []).forEach(cb => cb()); await flush(); },
    swEmit(n, e) { (NAV.swListeners[n] || []).forEach(cb => cb(e || {})); },
    plates() { return SU.calls.filter(c => c[0] === 'plate').map(c => c[1]); },
    calls(name) { return SU.calls.filter(c => c[0] === name); },
    soundCalls(name) { return SO.calls.filter(c => c[0] === name); },
  };
  // peek: the real app.js with its mk() and state handed to the test, for guards no path can reach.
  const src = o.peek ? APP.replace('  DR.app = {', '  G.__peek = { mk: mk, A: A };\n  DR.app = {') : APP;
  if (o.peek && src === APP) throw new Error('peek: the hook point in app.js is gone');
  vm.runInContext(src, ctx, { filename: 'app.js' });
  W.peek = () => ctx.__peek;
  if (o.noWait) return W;
  await W.until(() => W.DR.app && W.DR.app.ready, 'app object');
  await W.DR.app.ready;
  await flush();
  return W;
}

/* ── fixtures ──────────────────────────────────────────────────────────── */
// A macro round opened an hour ago with its twin's print in: 7 of 11 UP, the newest dock with a breath.
function shareRound(opts = {}) {
  const ups = opts.ups || [true, true, false, true, true, false, true, false, true, false, true];
  const o = opened('macro', NOW - 7200000, { aim: aim({ after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' }) });
  const cs = cuts(o.rid, ups, NOW - 3600000);
  const events = [o.ev, ...cs];
  const blobs = {};
  if (cs.length && opts.breath !== false) {
    const b = uuid();
    events.push(E('breath.kept', o.rid, { b, of: 'notch', ref: cs[cs.length - 1].data.n, ms: 1200, mime: 'audio/webm' }, NOW - 1000000));
    blobs[b] = BLOB;
  }
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49.0), pr('2026-11', 'NOV 2026', 55.5)] } });
  return { o, cs, events, blobs, series };
}
const CLIP = { blob: BLOB, mime: 'audio/webm;codecs=opus', ms: 1500 };
const HOME = {
  now: iso(NOW), version: '0.1.0', registry_version: 1, series: {},
  field: { status: 'ok', flags: [[1, '2026-11-16T09:00:00-05:00', 'macro'], [2, '2026-11-16T09:05:00-05:00', 'ai']], older: 0, kept: 6532, sorted: { done: 2, total: 2 },
           heard: [{ flag: 2, at: '2026-11-16T09:05:00-05:00', line: 'They talked about freight getting busier' }] },
  yours: { live: 171, turned: 3, whys: 9 }, proposals: {}, breaths: {}, parts: {},
};

/* ── scenarios ─────────────────────────────────────────────────────────── */

await t('first launch with no key opens the macro round, ROLLING', async () => {
  const W = await world();
  const ro = W.evs('round.opened');
  eq(ro.length, 1, 'one round opened');
  eq(ro[0].data.lane, 'macro'); eq(ro[0].data.origin, 'canon'); eq(ro[0].data.twin, 'ism_new_orders');
  eq(ro[0].data.q, REGISTRY.canon.macro.q);
  eq(ro[0].data.aim.conf, 'none', 'no date until home gives one');
  eq(W.view().mode, 'ROLLING');
  eq(W.view().plate, REGISTRY.canon.macro.q, 'view carries the question (surface blanks it while ROLLING)');
  eq(W.view().dock, true);
  ok(W.NAV.wakeReq >= 1, 'wake lock asked while ROLLING');
  eq(W.SO.calls.filter(c => c[0] === 'mute')[0], ['mute', false], 'mute set from prefs at start');
  ok(W.GE.calls.some(c => c[0] === 'load'), 'town list loaded');
});

await t('with a key nothing opens before the first sync; an empty first sync opens macro', async () => {
  const W = await world({ key: true, syncs: [{ defer: true }], noWait: true });
  await flush(60);
  ok(W.ST.syncs.length === 1, 'the launch sync ran');
  eq(W.ST.events.length, 0, 'nothing written before the sync answered');
  W.ST.pendingSync({ ok: true });
  await W.DR.app.ready; await flush();
  eq(W.evs('round.opened').length, 1, 'macro opened after an empty first sync');
});

await t('with a key and a failed first sync nothing opens', async () => {
  const W = await world({ key: true, syncs: [{ ok: false, status: 0 }] });
  eq(W.ST.events.length, 0);
});

await t('with a key and a sync that brings a book, nothing new opens', async () => {
  const r = opened('ai', NOW - 86400000);
  const W = await world({ key: true, syncs: [{ ok: true, pull: [r.ev] }] });
  eq(W.evs('round.opened').length, 1);
  eq(W.evs('round.opened')[0].data.lane, 'ai');
});

await t('ROLLING tap speaks the read and writes nothing', async () => {
  const f = shareRound({ breath: false });
  f.series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49.0)] } });
  const W = await world({ events: f.events, series: f.series });
  const n0 = W.ST.events.length, r0 = W.SU.renders.length;
  await W.tap('stage');
  eq(W.SO.says.length, 1);
  eq(W.SO.says[0], 'Orders up or down? Seven of eleven up. Print December first, by rule.');
  eq(W.ST.events.length, n0, 'nothing written');
  eq(W.SU.opened.length, 0, 'no overlay');
  eq(W.SU.renders.length, r0, 'nothing redrawn');
  eq(W.view().mode, 'ROLLING');
  await W.tap('dial'); await W.tap('rail', { i: 0, hold: false }); await W.tap('tag');
  eq(W.SO.says.length, 1, 'PARKED targets do nothing while ROLLING');
  eq(W.SU.opened.length, 0);
});

await t('lever to PARKED, the 60 second fall back, a touch restarts it', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  eq(W.view().mode, 'PARKED');
  ok(W.view().labels, 'labels in PARKED');
  ok(W.GE.calls.some(c => c[0] === 'guard'), 'moving guard on');
  ok(W.NAV.released >= 1, 'wake lock let go in PARKED');
  await W.advance(30000);
  W.touch();
  await W.advance(59000);
  eq(W.view().mode, 'PARKED', 'a touch at 30 s holds it');
  await W.advance(2000);
  eq(W.view().mode, 'ROLLING', 'fell back after 60 s with no touch');
  eq(W.GE.guardStops, 1, 'guard stopped');
  eq(W.view().labels, null);
});

await t('an open card holds PARKED for at most 5 minutes', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  await W.tap('tag');
  ok(W.SU.open.card, 'tag card open');
  await W.advance(120000);
  eq(W.view().mode, 'PARKED', 'held at 2 minutes');
  await W.advance(181000);
  eq(W.view().mode, 'ROLLING', 'dropped at 5 minutes');
  ok(!W.SU.open.card, 'the card was closed');
});

await t('hidden two minutes drops to ROLLING; a short hide does not', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  await W.hide(); await W.advance(20000); await W.show();
  eq(W.view().mode, 'PARKED');
  W.touch();
  await W.hide(); await W.advance(121000);
  eq(W.view().mode, 'ROLLING');
  await W.show();
  ok(W.NAV.wakeReq >= 2, 'wake lock again when visible and ROLLING');
});

await t('the setup card opens once, on the first PARKED, with MIC and TOWNS off', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, prefs: { setup: false }, mic: 'prompt', geo: 'prompt' });
  await W.tap('lever');
  const o = W.openOpts('card');
  ok(o, 'card open');
  eq(o.title, 'THE LINE');
  ok(o.actions.some(a => a.id === 'mic' && a.label === 'MIC ON'), 'MIC ON offered');
  ok(o.actions.some(a => a.id === 'townson' && a.label === 'TOWNS ON'), 'TOWNS ON offered');
  ok(o.lines.some(l => /MIC OFF/.test(l) && /TOWNS OFF/.test(l)), 'shows them off');
  eq(W.ST.prefsV.setup, true);
  eq(W.GE.calls.filter(c => c[0] === 'ask').length + W.SO.calls.filter(c => c[0] === 'askMic').length, 0, 'nothing asked by itself');
  await W.answer('card', null);
  await W.tap('lever'); await W.tap('lever');
  eq(W.SU.opened.filter(x => x[0] === 'card').length, 1, 'only once');
});

await t('a dock end to end: cut, town, breath, in order', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], prefs: { towns: true }, town: { city: 'JOLIET', st: 'IL' }, records: ['hold'] });
  await W.tap('lever');
  await W.tap('dock');
  const h = W.openOpts('halves');
  eq([h.a, h.b, h.seam, h.drainMs, h.see], ['UP', 'DOWN', REGISTRY.canon.macro.q, 8000, false]);
  ok(W.soundCalls('warm').length >= 1, 'next lines warmed');
  await W.answer('halves', 'a');
  await W.until(() => W.SO.pendingRec, 'the recording');
  const cut = W.evs('notch.cut');
  eq(cut.length, 1); eq(cut[0].data.up, true); eq(cut[0].data.place, null);
  ok(W.SO.calls.some(c => c[0] === 'tick'), 'knife tick');
  ok(W.SO.calls.some(c => c[0] === 'buzz' && JSON.stringify(c[1]) === '[30,40,30]'), 'UP buzz');
  eq(W.SO.says[0], 'Up. One of one.');
  eq(W.view().n, 1); eq(W.view().u, 1); eq(W.view().lit, true);
  ok(W.plates().includes("WHAT'D THEY SAY?"), 'plate asks');
  eq(W.SO.calls.find(c => c[0] === 'record')[1], { openMs: 6000, maxMs: 20000, level: false });
  eq(W.DR.app.flow(), 'dock');
  W.SO.pendingRec(CLIP); W.SO.pendingRec = null;
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  eq(W.added(), ['notch.cut', 'notch.place', 'breath.kept'], 'events in order');
  eq(W.evs('notch.place')[0].data, { n: cut[0].data.n, city: 'JOLIET', st: 'IL' });
  const bk = W.evs('breath.kept')[0];
  eq([bk.data.of, bk.data.ref, bk.data.ms, bk.data.mime, bk.round], ['notch', cut[0].data.n, 1500, 'audio/webm', o.rid]);
  ok(W.ST.calls.some(c => c[0] === 'putBlob' && c[1] === bk.data.b), 'clip stored on the phone');
  eq(W.view().notches, [{ up: true, tag: true }], 'paper tag on the notch');
});

await t('a dock with the mic not granted keeps no breath; towns off takes no fix', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], mic: 'prompt' });
  await W.tap('lever'); await W.tap('dock');
  await W.answer('halves', 'b');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  eq(W.added(), ['notch.cut']);
  eq(W.SO.calls.filter(c => c[0] === 'record').length, 0, 'no recording');
  eq(W.GE.calls.filter(c => c[0] === 'town').length, 0, 'no fix');
  ok(W.SO.calls.some(c => c[0] === 'buzz' && JSON.stringify(c[1]) === '[90]'), 'DOWN buzz');
  eq(W.SO.says[0], 'Down. Zero of one.');
});

await t('a dock drained or swiped cuts nothing', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev] });
  await W.tap('lever'); await W.tap('dock');
  await W.answer('halves', null);
  await flush();
  eq(W.added(), []);
  eq(W.DR.app.flow(), null);
});

await t('a town not in the list is never written, and the console line holds no content', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], prefs: { towns: true }, town: { city: 'NOWHERE', st: 'ZZ' }, mic: 'prompt' });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null); await flush();
  eq(W.added(), ['notch.cut']);
  eq(W.consoleLines.length, 1, 'one line');
  ok(/notch\.place/.test(W.consoleLines[0]) && !/NOWHERE|ZZ/.test(W.consoleLines[0]), 'no content: ' + W.consoleLines[0]);
});

await t('wrong thumb: inside 60 s a rail tap flips and a hold pulls the freshest cut', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], mic: 'prompt' });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null);
  const newest = W.evs('notch.cut')[1].data.n;
  await W.tap('rail', { i: 0, hold: false });
  eq(W.evs('notch.flip').map(e => e.data.n), [newest], 'flipped the freshest, not the touched one');
  eq(W.SO.says[W.SO.says.length - 1], 'Down. One of two.');
  await W.tap('rail', { i: 0, hold: true });
  eq(W.evs('notch.pull').map(e => e.data.n), [newest], 'pulled the freshest');
  eq(W.view().n, 1);
  eq(W.SU.opened.filter(x => x[0] === 'card').length, 0, 'no card inside 60 s');
});

await t('outside 60 s a rail tap opens the notch card for the nearest notch', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs });
  await W.tap('lever');
  await W.tap('rail', { i: 4, hold: false });
  eq(W.openOpts('card').title, 'DOCK 5 OF 11');
  await W.answer('card', 'close');
  await W.tap('rail', { i: 2, hold: true });
  eq(W.openOpts('card').title, 'DOCK 3 OF 11', 'a hold outside 60 s is the card too');
  await W.answer('card', null);
  eq(W.evs('notch.flip').length + W.evs('notch.pull').length, 0);
});

async function runShareMoment(W) {
  await W.tap('lever');
  await W.tap('dial');
  await W.until(() => W.SU.open.halves, 'NEXT PRINT? halves', 30000);
}

await t('the moment, share twin: retrace, hand, voice, call, why, move, close, turn', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, records: ['hold'] });
  eq(W.view().tag.text, 'IN', 'the tag reads IN');
  eq(W.view().hand, 55.5, 'the hand stands while the print is in');
  const before = W.ST.events.length;
  await runShareMoment(W);
  eq(W.soundCalls('bell').length, 1, 'bell');
  const sc = W.SU.calls;
  const iTag = sc.findIndex(c => c[0] === 'tag' && c[1] === 'IN');
  const iPeg = sc.findIndex(c => c[0] === 'needle' && c[1] === null);
  const iFig = sc.findIndex(c => c[0] === 'figure' && c[1] === null);
  ok(iTag >= 0 && iPeg > iTag && iFig > iPeg, 'tag IN, needle to peg, figure blank');
  const rt = W.calls('retrace').map(c => c[1]);
  eq(rt, [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null], 'retrace left to right');
  eq(W.calls('figure').filter(c => c[1] !== null).map(c => c[1] + '/' + c[2]).slice(-1)[0], '7/11', 'figure counts up');
  eq(W.SO.calls.filter(c => c[0] === 'play'), [['play', 4000]], 'his newest breath plays, at most 4 s');
  eq(W.calls('hand').slice(-1)[0], ['hand', 55.5]);
  ok(W.plates().includes('PRINT 55.5'), 'plate PRINT 55.5');
  const br = W.calls('bridge').slice(-1)[0];
  ok(br && Math.abs(br[1] - 700 / 11) < 1e-9 && br[2] === 55.5, 'bridge between the needles');
  ok(W.SO.says.includes("Print's in. Fifty-five point five. Your docks: seven of eleven up. Inside your beam. Their question, their mouths. Call the next one."), 'the voice line');
  const h = W.openOpts('halves');
  eq([h.a, h.b, h.seam, h.see, h.drainMs], ['UP', 'DOWN', 'NEXT PRINT?', true, null]);
  eq(h.sub, 'FROM NOV 2026 55.5', 'the seam carries the figure he calls from (15.38)');
  eq(W.ST.events.length, before, 'nothing written before the thumb');
  await W.answer('halves', 'a');
  await W.until(() => W.SO.pendingRec, 'WHY recording');
  eq(W.calls('arrow').slice(-1)[0], ['arrow', 55.5, true]);
  ok(W.soundCalls('click').length === 1, 'brass click');
  ok(W.plates().includes('WHY?'));
  eq(W.SO.calls.filter(c => c[0] === 'record').slice(-1)[0][1], { openMs: 8000, maxMs: 20000, level: true });
  ok(W.calls('bezel').some(c => c[1] === 0.4), 'the bezel glows with his voice');
  W.SO.pendingRec(CLIP); W.SO.pendingRec = null;
  await W.until(() => W.SU.open.bands, 'move bands');
  const b = W.openOpts('bands');
  eq([b.seam, b.options, b.drainMs], ['POSITION, MONEY OR HELP?', ['POSITION', 'MONEY', 'HELP'], 8000]);
  ok(W.plates().includes("THAT ONE'S YOURS"));
  ok(W.SO.says.includes("That one's yours."));
  ok(W.soundCalls('knock').length >= 1, 'tack knocked');
  eq(W.view().tacks, [{ lane: 'macro', grade: null }], 'a tack under macro');
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn bands');
  eq(W.added(), ['call.made', 'breath.kept', 'call.move', 'round.closed', 'field.cut'], 'events in order');
  const cm = W.evs('call.made')[0];
  eq(cm.data, { c: cm.data.c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-11', label: 'NOV 2026', value: 55.5, by: 'fetch' }, up: true, docks: { u: 7, n: 11 }, inside: true });
  const bk = W.evs('breath.kept').slice(-1)[0];
  eq([bk.data.of, bk.data.ref], ['call', cm.data.c]);
  eq(W.evs('call.move')[0].data, { c: cm.data.c, move: 'money' });
  eq(W.evs('round.closed')[0].data, { reason: 'print', print: { series: 'ism_new_orders', period: '2026-11', label: 'NOV 2026', value: 55.5, by: 'fetch' } });
  ok(W.soundCalls('swish').length === 1, 'swish');
  const offers = W.DR.offers('macro', {});
  eq(W.SO.says[W.SO.says.length - 1], W.DR.lines.turn(offers[0]), "Field's cut, the first offer");
  ok(/^Field's cut\. Next lane, A\.I\. Dock question: anybody here using A\.I\. for real\? Take it\?$/.test(W.SO.says[W.SO.says.length - 1]));
  await W.answer('bands', 0);
  await W.until(() => W.DR.app.flow() === null);
  const ro = W.evs('round.opened').slice(-1)[0];
  eq([ro.data.lane, ro.data.origin, ro.data.twin], ['ai', 'canon', 'btos_ai_use']);
  eq(W.added().slice(-1)[0], 'round.opened');
});

await t('the moment, level twin: no hand, the print then its move, no beam sentence', async () => {
  const o = opened('physics', NOW - 7200000, { aim: aim({ after: '2026-09', period: '2026-10', label: 'OCT 2026', conf: 'none' }) });
  const cs = cuts(o.rid, [true, false, true], NOW - 3600000);
  const series = seriesOf({ bls_power_price: { prints: [pr('2026-09', 'SEP 2026', 0.170), pr('2026-10', 'OCT 2026', 0.180)] } });
  const W = await world({ events: [o.ev, ...cs], series, mic: 'prompt' });
  eq(W.view().hand, null, 'no hand for a level');
  await W.tap('lever'); await W.tap('dial');
  await W.until(() => W.SU.open.halves, 'halves', 30000);
  eq(W.calls('hand').filter(c => c[1] !== null).length, 0, 'never a hand');
  const ps = W.plates();
  ok(ps.indexOf('PRINT 18.0¢') >= 0 && ps.indexOf('UP 5.9%') > ps.indexOf('PRINT 18.0¢'), 'print, then its move: ' + JSON.stringify(ps));
  const line = W.SO.says.find(s => s.startsWith("Print's in."));
  eq(line, "Print's in. Eighteen cents a kilowatt hour. Your docks: two of three up. Different yardstick. Call the next one.");
  await W.answer('halves', 'b');
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn');
  const cm = W.evs('call.made')[0];
  eq([cm.data.series, cm.data.up, cm.data.inside, cm.data.docks], ['bls_power_price', false, null, { u: 2, n: 3 }]);
  eq(W.evs('call.move')[0].data.move, 'none', 'no thumb is none');
  eq(W.added(), ['call.made', 'call.move', 'round.closed', 'field.cut']);
  await W.answer('bands', null);
});

await t('the moment with no docks: no retrace, the no-docks line', async () => {
  const o = opened('macro', NOW - 7200000, { aim: aim({ after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', conf: 'rule' }) });
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-11', 'NOV 2026', 55.5)] } });
  const W = await world({ events: [o.ev], series, mic: 'prompt' });
  await W.tap('lever'); await W.tap('dial');
  await W.until(() => W.SU.open.halves, 'halves', 30000);
  eq(W.calls('retrace').length, 0, 'retrace skipped');
  ok(W.SO.says.includes("Print's in. Fifty-five point five. No docks this round. Call the next one."));
  eq(W.calls('bridge').filter(c => c[2] !== null).length, 0, 'no bridge with no needle');
  await W.answer('halves', 'a');
  await W.until(() => W.SU.open.bands);
  const cm = W.evs('call.made')[0];
  eq([cm.data.docks, cm.data.inside], [{ u: 0, n: 0 }, null]);
  await W.answer('bands', 2);
  await W.until(() => W.evs('field.cut').length === 1);
  eq(W.added(), ['call.made', 'call.move', 'round.closed', 'field.cut']);
});

await t('a rail with no twin closes on its date: own line, call with up null, reason own', async () => {
  const o = opened('crypto', NOW - 31 * 86400000, { aim: aim({ date: '2026-11-16', conf: 'own' }) });
  const cs = cuts(o.rid, [true, true, false], NOW - 30 * 86400000);
  const W = await world({ events: [o.ev, ...cs], records: [CLIP] });
  eq(W.view().tag.text, 'DUE');
  await W.tap('lever'); await W.tap('dial');
  await W.until(() => W.SU.open.bands, 'move bands', 30000);
  eq(W.soundCalls('bell').length, 1);
  const rt = W.calls('retrace').map(c => c[1]);
  eq(rt.slice(0, rt.indexOf(null) + 1), [-1, 0, 1, 2, null]);
  ok(W.SO.says.includes("No print for this one. It's only yours. Two of three yes. What did the docks tell you?"), JSON.stringify(W.SO.says));
  ok(W.plates().includes('WHAT DID THE DOCKS TELL YOU?'));
  eq(W.SU.opened.filter(x => x[0] === 'halves').length, 0, 'no halves for an own rail');
  await W.answer('bands', null);
  await W.until(() => W.evs('field.cut').length === 1);
  const cm = W.evs('call.made')[0];
  eq([cm.data.series, cm.data.from, cm.data.up, cm.data.inside, cm.data.docks], [null, null, null, null, { u: 2, n: 3 }]);
  eq(W.evs('breath.kept')[0].data.of, 'call');
  eq(W.evs('round.closed')[0].data, { reason: 'own', print: null });
  eq(W.added(), ['call.made', 'breath.kept', 'call.move', 'round.closed', 'field.cut']);
  await W.answer('bands', null);
});

await t('CLOSE THE RAIL starts the own close early', async () => {
  const o = opened('crypto', NOW - 86400000, { aim: aim({ date: '2026-12-16', conf: 'own' }) });
  const W = await world({ events: [o.ev], mic: 'prompt' });
  await W.tap('lever'); await W.tap('tag');
  const c = W.openOpts('card');
  ok(c.actions.some(a => a.id === 'closerail' && a.label === 'CLOSE THE RAIL'));
  ok(c.marks.includes('ONLY YOURS'));
  await W.answer('card', 'closerail');
  await W.until(() => W.SU.open.bands, 'bands', 30000);
  eq(W.soundCalls('bell').length, 1);
  await W.answer('bands', 0);
  await W.until(() => W.evs('round.closed').length === 1);
  eq(W.evs('round.closed')[0].data.reason, 'own');
  await W.answer('bands', null);
});

await t('a kill before call.made writes nothing and restarts from the top', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, mic: 'prompt' });
  await runShareMoment(W);
  await W.hide();
  ok(!W.SU.open.halves, 'the halves closed');
  eq(W.added(), [], 'nothing written');
  await W.show();
  W.touch();
  await W.tap('dial');
  await W.until(() => W.SU.open.halves, 'halves again', 30000);
  eq(W.soundCalls('bell').length, 2, 'from the top: the bell again');
  await W.answer('halves', null);
  await flush();
  eq(W.view().plate, 'CALL THE NEXT ONE', 'he left: the plate says so');
  await W.tap('dial');
  await W.until(() => W.SU.open.halves, 'halves back');
  eq(W.soundCalls('bell').length, 2, 'a tap on the dial brings the halves back, no retrace');
  await W.answer('halves', 'a');
  await W.until(() => W.SU.open.bands);
  eq(W.added()[0], 'call.made');
  await W.answer('bands', 0);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT');
  await W.answer('bands', null);
});

await t('a kill after call.made resumes at the move bands', async () => {
  const f = shareRound();
  const c = uuid();
  f.events.push(E('call.made', f.o.rid, { c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-11', label: 'NOV 2026', value: 55.5, by: 'fetch' }, up: true, docks: { u: 7, n: 11 }, inside: true }, NOW - 60000));
  const W = await world({ events: f.events, series: f.series, mic: 'prompt' });
  eq(W.view().tacks.length, 1);
  await W.tap('lever'); await W.tap('dial');
  await W.until(() => W.SU.open.bands, 'move bands');
  eq(W.soundCalls('bell').length, 0, 'no bell, no retrace');
  eq(W.calls('retrace').length, 0);
  await W.answer('bands', 0);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn');
  eq(W.added(), ['call.move', 'round.closed', 'field.cut']);
  eq(W.evs('call.move')[0].data, { c, move: 'position' });
  await W.answer('bands', null);
});

await t('the guard firing mid-recording throws the breath away and writes nothing', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, records: ['hold'] });
  await runShareMoment(W);
  await W.answer('halves', 'b');
  await W.until(() => W.SO.pendingRec, 'WHY recording');
  ok(W.GE.guardCb, 'guard is armed');
  W.GE.guardCb();
  await flush();
  ok(W.SO.calls.some(c => c[0] === 'cancelRecord'), 'recording cancelled');
  eq(W.view().mode, 'ROLLING');
  eq(W.added(), [], 'nothing written');
  eq(W.DR.app.flow(), null);
});

await t('the guard mid-dock recording: the cut stays, no breath', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], records: ['hold'] });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.SO.pendingRec);
  W.GE.guardCb();
  await flush();
  eq(W.added(), ['notch.cut']);
  eq(W.view().mode, 'ROLLING');
});

await t('the moving guard is off when the pref is off', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, prefs: { guard: false } });
  await W.tap('lever');
  eq(W.GE.calls.filter(c => c[0] === 'guard').length, 0);
});

await t('print by hand: the period, the entry title, the event, PRINT x BY HAND', async () => {
  const o = opened('macro', NOW - 86400000, { aim: aim({ after: '2026-10' }) });
  const cs = cuts(o.rid, [true, false], NOW - 3600000);
  const W = await world({ events: [o.ev, ...cs], series: seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49)] } }) });
  await W.tap('lever'); await W.tap('tag');
  const c = W.openOpts('card');
  eq(c.title, 'ISM NEW ORDERS');
  ok(c.actions.some(a => a.id === 'hand' && a.label === 'SET PRINT BY HAND'));
  ok(c.lines.includes(REGISTRY.series.ism_new_orders.means) && c.lines.includes(REGISTRY.series.ism_new_orders.caveat));
  await W.answer('card', 'hand');
  const en = W.openOpts('entry');
  eq([en.title, en.kind], ['ISM NEW ORDERS · NOV 2026', 'number']);
  await W.answer('entry', '500');
  eq(W.openOpts('card').title, 'NOT THAT NUMBER');
  eq(W.added(), [], 'out of range: nothing written');
  await W.answer('card', 'again');
  await W.answer('entry', '55.5');
  await flush();
  eq(W.evs('print.hand')[0].data, { series: 'ism_new_orders', period: '2026-11', label: 'NOV 2026', value: 55.5 });
  eq(W.plates().slice(-1)[0], 'PRINT 55.5 BY HAND');
  eq(W.view().tag.text, 'IN', 'the print is in');
});

await t('grading: call.graded written once after a sync, never again', async () => {
  const o = opened('macro', NOW - 40 * 86400000);
  const c = uuid();
  const evs = [o.ev,
    E('call.made', o.rid, { c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' }, up: true, docks: { u: 3, n: 4 }, inside: true }, NOW - 30 * 86400000),
    E('call.move', o.rid, { c, move: 'none' }, NOW - 30 * 86400000 + 1000),
    E('round.closed', o.rid, { reason: 'print', print: { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' } }, NOW - 30 * 86400000 + 2000),
    E('field.cut', null, { through: iso(NOW - 30 * 86400000 + 3000) }, NOW - 30 * 86400000 + 3000)];
  const r2 = opened('ai', NOW - 30 * 86400000 + 4000);
  evs.push(r2.ev);
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 52)] } });
  const W = await world({ key: true, events: evs, syncs: [{ ok: true, series }] });
  eq(W.evs('call.graded').length, 1);
  eq(W.evs('call.graded')[0].data, { c, grade: 1, print: { period: '2026-11', label: 'NOV 2026', value: 52 }, base: { period: '2026-10', label: 'OCT 2026', value: 50 } });
  eq(W.view().tacks, [{ lane: 'macro', grade: 1 }], 'the tack turns bright');
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0 }));
  await flush(60);
  eq(W.evs('call.graded').length, 1, 'never written twice');
  const W2 = await world({ key: true, events: W.ST.events, syncs: [{ ok: true, series: seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 48)] } }) }] });
  eq(W2.added(), [], 'a revision later moves nothing');
  eq(W2.view().tacks, [{ lane: 'macro', grade: 1 }]);
});

await t('re-aim: round.aimed when home learns a date, once', async () => {
  const o = opened('macro', NOW - 86400000);
  const W = await world({ key: true, events: [o.ev], syncs: [{ ok: true }] });
  eq(W.added(), []);
  W.ST.seriesV = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49)], upcoming: [{ period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule', source: 'ISM RULE' }] } });
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0 }));
  await flush(60);
  eq(W.evs('round.aimed').length, 1);
  eq(W.evs('round.aimed')[0].data, { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' });
  eq(W.view().tag, { text: 'DEC 1', lamp: false, rule: true }, 'the tag hangs a rule date');
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0 }));
  await flush(60);
  eq(W.evs('round.aimed').length, 1, 'once');
});

function closedBook() {
  const o = opened('macro', NOW - 10 * 86400000);
  return [o.ev,
    E('round.closed', o.rid, { reason: 'own', print: null }, NOW - 86400000),
    E('field.cut', null, { through: iso(NOW - 86400000 + 1000) }, NOW - 86400000 + 1000)];
}
const PROPOSALS = { ai: [{ q: 'ANYBODY TRAINING A MODEL?', say: 'anybody training a model?', words: ['YES', 'NO'], day: '2026-11-14', taps: 11, minutes: 20 }] };

await t('the turn: NEXT reads the next offer, TAKE IT opens a flags round', async () => {
  const W = await world({ events: closedBook(), home: Object.assign({}, HOME, { proposals: PROPOSALS }) });
  eq(W.view().lit, false, 'dark dial with no round');
  eq(W.view().plate, REGISTRY.canon.ai.q, 'the plate shows the offer');
  await W.tap('lever');
  await W.until(() => W.SU.open.bands, 'offer bands');
  const b = W.openOpts('bands');
  eq([b.options, b.drainMs], [['TAKE IT', 'NEXT', 'MY OWN'], null]);
  eq(W.SO.says.slice(-1)[0], 'Next lane, A.I. Dock question: anybody here using A.I. for real? Take it?');
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  eq(W.SO.says.slice(-1)[0], 'Tallest in A.I.: the fourteenth, eleven taps in twenty minutes. Dock question: anybody training a model? Take it?');
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  ok(/^Next lane, next gen\./.test(W.SO.says.slice(-1)[0]), 'on to next gen');
  await W.answer('bands', null);
  await flush();
  eq(W.view().plate, REGISTRY.canon.nextgen.q, 'he left: the plate keeps the offer');
  await W.tap('dial');
  await W.until(() => W.SU.open.bands, 'dial brings the offers back');
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  await W.answer('bands', 1);
  await W.until(() => W.SU.open.bands);
  await W.answer('bands', 1);   // round the turn back to ai canon, then ai flags
  await W.until(() => W.SU.open.bands);
  await W.answer('bands', 0);
  await W.until(() => W.DR.app.flow() === null);
  const ro = W.evs('round.opened').slice(-1)[0];
  eq([ro.data.lane, ro.data.origin, ro.data.twin, ro.data.q], ['ai', 'flags', null, 'ANYBODY TRAINING A MODEL?']);
  eq(ro.data.from, { day: '2026-11-14', taps: 11, minutes: 20 });
  eq([ro.data.aim.conf, ro.data.aim.date], ['own', '2026-12-17']);
  eq(W.view().plate, 'ANYBODY TRAINING A MODEL?');
  eq(W.added(), ['round.opened'], 'no cut: the field was cut already');
});

await t('the turn: MY OWN, upper-cased, a ? added, its own word pair', async () => {
  const W = await world({ events: closedBook() });
  await W.tap('lever');
  await W.answer('bands', 2);
  const en = W.openOpts('entry') || (await W.until(() => W.SU.open.entry), W.openOpts('entry'));
  eq([en.kind, en.max], ['text', 48]);
  await W.answer('entry', 'do you ship more’n last week');
  const pair = W.openOpts('bands');
  eq([pair.seam, pair.options], ["DO YOU SHIP MORE'N LAST WEEK?", ['UP / DOWN', 'YES / NO']]);
  await W.answer('bands', 1);
  await W.until(() => W.DR.app.flow() === null);
  const ro = W.evs('round.opened').slice(-1)[0];
  eq([ro.data.lane, ro.data.q, ro.data.say, ro.data.words, ro.data.origin, ro.data.twin, ro.data.from],
     ['ai', "DO YOU SHIP MORE'N LAST WEEK?", "do you ship more'n last week?", ['YES', 'NO'], 'own', null, null]);
});

await t('killed mid-turn: the field.cut is written at launch, then PARKED shows the offers', async () => {
  const o = opened('macro', NOW - 10 * 86400000);
  const W = await world({ events: [o.ev, E('round.closed', o.rid, { reason: 'own', print: null }, NOW - 3600000)] });
  eq(W.added(), ['field.cut']);
  const cut = W.evs('field.cut')[0];
  ok(Date.parse(cut.data.through) >= Date.parse(W.evs('round.closed')[0].at), 'cut after the close');
  eq(W.SU.opened.length, 0, 'ROLLING: no offers yet');
  await W.tap('lever');
  await W.until(() => W.SU.open.bands);
  ok(/^Field's cut\./.test(W.SO.says.slice(-1)[0]), "the first offer after a cut says so");
  await W.answer('bands', null);
});

await t("a store 'change' during a flow is held and drawn when it ends", async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ key: true, events: [o.ev], syncs: [{ ok: true }], mic: 'prompt' });
  await W.tap('lever'); await W.tap('dock');
  ok(W.SU.open.halves);
  const r0 = W.SU.renders.length;
  W.ST.homeV = HOME;
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0 }));
  await flush(60);
  eq(W.SU.renders.length, r0, 'nothing drawn mid-flow');
  await W.answer('halves', null);
  await flush(60);
  const v = W.view();
  ok(v.field && v.field.standing === 2, 'the held field is drawn');
  eq(v.labels, { field: '2 HEARD', horizon: 'THE EAR KEPT 6,532', ground: 'YOURS 171' });
});

await t('mute flips the pref, mutes the sound and redraws; it works mid-flow', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('mute');
  eq(W.ST.prefsV.muted, true);
  eq(W.SO.calls.filter(c => c[0] === 'mute').slice(-1)[0], ['mute', true]);
  eq(W.view().muted, true);
  await W.tap('lever'); await W.tap('dock');
  await W.tap('mute');
  eq(W.view().muted, false);
  ok(W.SU.open.halves, 'the dock is still open');
  await W.answer('halves', null);
});

await t('the line card: counts, marks and every switch', async () => {
  const f = shareRound();
  const W = await world({ key: true, line: 'home', events: f.events, series: f.series, syncs: [{ ok: true }], mic: 'prompt', geo: 'prompt', records: [CLIP],
                          counts: { refused: 2, breathsNotHome: 1, clockOffMin: 15, registryMismatch: true } });
  await W.tap('lever'); await W.tap('line');
  let c = W.openOpts('card');
  eq(c.title, 'THE LINE');
  eq(c.marks, ['HOME', 'CLOCK OFF', 'UPDATE THE APP']);
  ok(c.lines.includes('CONNECTED AS fold') && c.lines.includes('2 NOT TAKEN') && c.lines.includes('1 BREATHS NOT HOME'), JSON.stringify(c.lines));
  ok(c.lines.some(l => l.startsWith('LAST SYNC ')) && c.lines.some(l => l.startsWith('SHELL ')));
  eq(c.actions.map(a => a.id), ['sync', 'mic', 'townson', 'guard', 'forget']);
  const s0 = W.ST.syncs.length;
  await W.answer('card', 'sync');
  await W.until(() => W.SU.open.card);
  eq(W.ST.syncs.length, s0 + 1, 'SYNC NOW');
  await W.answer('card', 'mic');
  await W.until(() => W.SU.open.card);
  ok(W.SO.calls.some(c2 => c2[0] === 'askMic'), 'mic asked from the card');
  c = W.openOpts('card');
  ok(c.actions.some(a => a.id === 'check' && a.label === 'MIC CHECK'));
  await W.answer('card', 'check');
  await W.until(() => W.SU.open.card);
  eq(W.SO.calls.filter(x => x[0] === 'record').slice(-1)[0][1], { maxMs: 2000, level: false, raw: true }, 'two seconds, no voice gate (15.6)');
  ok(W.SO.calls.some(x => x[0] === 'play'), 'played back');
  ok(W.openOpts('card').lines.includes('MIC CHECK: PLAYED BACK'));
  await W.answer('card', 'townson');
  await W.until(() => W.SU.open.card);
  ok(W.GE.calls.some(x => x[0] === 'ask'), 'location asked from the card');
  eq(W.ST.prefsV.towns, true);
  ok(W.openOpts('card').actions.some(a => a.id === 'townsoff' && a.label === 'TOWNS OFF'));
  await W.answer('card', 'townsoff');
  await W.until(() => W.SU.open.card);
  eq(W.ST.prefsV.towns, false);
  const stops = W.GE.guardStops;
  await W.answer('card', 'guard');
  await W.until(() => W.SU.open.card);
  eq(W.ST.prefsV.guard, false);
  ok(W.GE.guardStops > stops && !W.GE.guardCb, 'guard stopped');
  ok(W.openOpts('card').actions.some(a => a.label === 'MOVING GUARD ON'));
  await W.answer('card', 'forget');
  eq(W.openOpts('card').title, 'FORGET THIS KEY?');
  await W.answer('card', 'yes');
  await W.until(() => W.SU.open.card);
  ok(W.ST.calls.some(x => x[0] === 'forget'), 'forgot the key');
  c = W.openOpts('card');
  eq(c.marks[0], 'NOT SET');
  ok(!c.actions.some(a => a.id === 'forget' || a.id === 'sync'));
  await W.answer('card', null);
  eq(W.SU.open.card, undefined);
});

await t('the tag card: date mark, last print, REFRESH', async () => {
  const f = shareRound();
  f.series.ism_new_orders.question = 'Orders this month compared with last?';
  const W = await world({ key: true, line: 'home', events: f.events, series: f.series, syncs: [{ ok: true, series: f.series }] });
  await W.tap('lever'); await W.tap('tag');
  const c = W.openOpts('card');
  ok(c.marks.includes('DATE BY RULE'));
  ok(c.lines.includes('THEIR QUESTION: Orders this month compared with last?'));
  ok(c.lines.some(l => l.startsWith('NEXT NOV 2026: DEC 1')), JSON.stringify(c.lines));
  ok(c.lines.some(l => l.startsWith('LAST PRINT NOV 2026: 55.5 · TEST · FETCHED NOV 16')), JSON.stringify(c.lines));
  ok(c.actions.some(a => a.id === 'refresh'));
  await W.answer('card', 'refresh');
  await W.until(() => W.SU.open.card);
  ok(W.ST.calls.some(x => x[0] === 'refreshPrints'), 'refresh asked');
  await W.answer('card', null);
});

await t('the heard card: marks, the gist and its date, the voice says the gist', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, home: HOME });
  await W.tap('lever'); await W.tap('grass');
  const c = W.openOpts('card');
  eq(c.marks, ['HEARD, NOT YOURS', 'GIST, BY MACHINE']);
  eq(c.lines, ['They talked about freight getting busier', 'NOV 16']);
  eq(W.SO.says.slice(-1)[0], 'The gist: They talked about freight getting busier.');
  await W.answer('card', null);
});

await t('the tack card, his ground, SHOW', async () => {
  const o = opened('macro', NOW - 40 * 86400000);
  const c = uuid(), b = uuid();
  const evs = [o.ev,
    E('call.made', o.rid, { c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' }, up: true, docks: { u: 3, n: 4 }, inside: true }, NOW - 30 * 86400000),
    E('breath.kept', o.rid, { b, of: 'call', ref: c, ms: 2000, mime: 'audio/webm' }, NOW - 30 * 86400000 + 500),
    E('call.move', o.rid, { c, move: 'help' }, NOW - 30 * 86400000 + 1000),
    E('call.graded', o.rid, { c, grade: 1, print: { period: '2026-11', label: 'NOV 2026', value: 52 }, base: { period: '2026-10', label: 'OCT 2026', value: 50 } }, NOW - 1000),
    E('round.closed', o.rid, { reason: 'print', print: null }, NOW - 30 * 86400000 + 2000),
    E('field.cut', null, { through: iso(NOW - 30 * 86400000 + 3000) }, NOW - 30 * 86400000 + 3000)];
  const r2 = opened('ai', NOW - 29 * 86400000);
  evs.push(r2.ev, ...cuts(r2.rid, [true, false, true], NOW - 3600000));
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 53)] } });
  const W = await world({ events: evs, series, home: HOME, blobs: { [b]: BLOB } });
  await W.tap('lever');
  await W.tap('tack', 0);
  const card = W.openOpts('card');
  eq(card.title, 'MACRO CALL');
  ok(card.lines.includes('YOU CALLED UP ON ISM NEW ORDERS OCT 2026: 50.0'), JSON.stringify(card.lines));
  ok(card.lines.includes('YOUR DOCKS THEN: 3 OF 4 UP') && card.lines.includes('INSIDE YOUR BEAM') && card.lines.includes('MOVE: HELP'));
  ok(card.lines.includes('IT STOOD ON NOV 2026 52.0'));
  ok(card.lines.includes('NOV 2026 REVISED SINCE: NOW 53.0'), 'the revised figure');
  await W.answer('card', 'play');
  await W.until(() => W.SU.open.card);
  ok(W.SO.calls.some(x => x[0] === 'play'), 'his why plays');
  await W.answer('card', null);
  eq(W.view().labels.ground, 'YOURS 171');
  await W.tap('ground');
  eq(W.view().labels.ground, '3 TURNED / 9 WHYS');
  await W.tap('ground');
  eq(W.view().labels.ground, 'YOURS 171');
  await W.tap('show');
  const cv = W.openOpts('counter');
  eq(cv, { u: 2, n: 3, word: 'YES', question: REGISTRY.canon.ai.q }, 'the count and the question, nothing else');
  await W.answer('counter', null);
});

await t('the notch card: PREV, NEXT, PLAY, TOWN by letters, DROP BREATH, FLIP, PULL', async () => {
  const f = shareRound({ ups: [true, false] });
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs });
  await W.tap('lever');
  await W.tap('rail', { i: 1, hold: false });
  let c = W.openOpts('card');
  eq(c.title, 'DOCK 2 OF 2');
  eq(c.actions.map(a => a.id), ['prev', 'play', 'flip', 'pull', 'town', 'drop', 'close']);
  eq(c.lines[0], 'DOWN'); eq(c.lines[1], 'NO TOWN');
  await W.answer('card', 'prev');
  await W.until(() => W.SU.open.card);
  eq(W.openOpts('card').title, 'DOCK 1 OF 2');
  await W.answer('card', 'next');
  await W.until(() => W.SU.open.card);
  await W.answer('card', 'play');
  await W.until(() => W.SU.open.card);
  ok(W.ST.calls.some(x => x[0] === 'fetchBlob') && W.SO.calls.some(x => x[0] === 'play'), 'PLAY his breath');
  await W.answer('card', 'town');
  await W.until(() => W.SU.open.card);
  eq(W.openOpts('card').title, 'WHICH TOWN?');
  await W.answer('card', 'type');
  await W.until(() => W.SU.open.entry);
  await W.answer('entry', 'jol');
  await W.until(() => W.SU.open.card);
  eq(W.openOpts('card').actions.map(a => a.label), ['JOLIET, IL', 'JOLLY, TX', 'TYPE THREE LETTERS']);
  await W.answer('card', 't0');
  await W.until(() => W.SU.open.card);
  const pl = W.evs('notch.place')[0];
  eq([pl.data.city, pl.data.st, pl.data.n], ['JOLIET', 'IL', f.cs[1].data.n]);
  eq(W.openOpts('card').lines[1], 'JOLIET, IL');
  await W.answer('card', 'drop');
  eq(W.openOpts('card').title, 'DROP THIS BREATH?');
  await W.answer('card', 'yes');
  await W.until(() => W.SU.open.card);
  eq(W.evs('breath.dropped').length, 1);
  ok(W.ST.calls.some(x => x[0] === 'dropBlob'), 'the phone copy is dropped');
  eq(W.view().notches[1].tag, false, 'the paper tag is gone');
  await W.answer('card', 'flip');
  await W.until(() => W.SU.open.card);
  eq(W.evs('notch.flip').length, 1);
  eq(W.openOpts('card').lines[0], 'UP');
  await W.answer('card', 'pull');
  await W.until(() => W.SU.open.card);
  eq(W.evs('notch.pull').length, 1);
  eq(W.openOpts('card').title, 'DOCK 1 OF 1');
  await W.answer('card', 'close');
  eq(W.added(), ['notch.place', 'breath.dropped', 'notch.flip', 'notch.pull']);
});

await t('touches on the dial, the rail and the stage do nothing while a flow runs', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, mic: 'prompt' });
  await W.tap('lever'); await W.tap('dial');
  await W.advance(500);
  eq(W.DR.app.flow(), 'moment');
  const says = W.SO.says.length, opened0 = W.SU.opened.length;
  W.emit('dial'); W.emit('rail', { i: 0, hold: false }); W.emit('tag'); W.emit('dock'); W.emit('show');
  await flush();
  eq(W.SO.says.length, says); eq(W.SU.opened.length, opened0);
  await W.until(() => W.SU.open.halves, 'halves', 30000);
  await W.answer('halves', null);
});

await t('the lever mid-flow drops to ROLLING and writes nothing', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], records: ['hold'] });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.SO.pendingRec);
  await W.tap('lever');
  eq(W.view().mode, 'ROLLING');
  eq(W.added(), ['notch.cut']);
});

await t('connect: the link is taken before any request, adopted, then synced', async () => {
  const W = await world({ link: { api: 'http://127.0.0.1:8660', code: 'A'.repeat(32) } });
  const i = k => W.order.indexOf(k);
  ok(i('takeLink') === 0, 'takeLink first: ' + W.order.slice(0, 4).join(', '));
  ok(i('takeLink') < i('fetch registry.json'), 'scrubbed before any request');
  ok(i('adopt') > 0 && i('adopt') < i('sync'), 'adopt then sync');
  eq(W.ST.calls.find(c => c[0] === 'adopt')[1].api, 'http://127.0.0.1:8660');
  eq(W.evs('round.opened').length, 1, 'adopt synced an empty book: macro opens');
});

await t('an unreadable link is noted, never adopted', async () => {
  const W = await world({ link: {} });
  eq(W.ST.calls.filter(c => c[0] === 'adopt').length, 0);
});

await t('#reset unregisters through the store, scrubs and reloads', async () => {
  const W = await world({ hash: '#reset' });
  ok(W.ST.calls.some(c => c[0] === 'resetShell'));
  ok(W.LOC.replaced >= 1, 'scrubbed');
  eq(W.LOC.reloads, 1);
  eq(W.NAV.registered.length, 0, 'no worker registered on the way out');
});

await t('the service worker: registered with updateViaCache none; reloads once, only when idle', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, controller: true });
  eq(W.NAV.registered, [['sw.js', { scope: './', updateViaCache: 'none' }]]);
  ok(W.NAV.posted.some(m => m.type === 'VERSION'), 'asks the version');
  W.swEmit('message', { data: { type: 'VERSION', version: 'dockread-shell-abc' } });
  await W.tap('lever'); await W.tap('tag');
  W.swEmit('controllerchange');
  await flush();
  eq(W.LOC.reloads, 0, 'not while a card is open');
  await W.answer('card', null);
  await W.advance(10);
  eq(W.LOC.reloads, 1, 'at the next idle point');
  ok(W.timers.some(x => x.every === 3600000), 'checked hourly');
  const W2 = await world({ events: f.events, series: f.series, controller: false });
  W2.swEmit('controllerchange');
  await flush();
  eq(W2.LOC.reloads, 0, 'never on the first install');
});

await t('the shell version from the worker shows on the line card', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, controller: true });
  W.swEmit('message', { data: { type: 'VERSION', version: 'dockread-shell-abc123abc123' } });
  await W.tap('lever'); await W.tap('line');
  ok(W.openOpts('card').lines.includes('SHELL dockread-shell-abc123abc123'));
  await W.answer('card', null);
});

/* ── the review's fixes (SPEC 15) ─────────────────────────────────────── */

// A graded tack under macro, its why on this phone, and an ai round open.
function tackBook(o2 = {}) {
  const o = opened('macro', NOW - 40 * 86400000);
  const c = uuid(), b = uuid();
  const evs = [o.ev,
    E('call.made', o.rid, { c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' }, up: true, docks: { u: 3, n: 4 }, inside: true }, NOW - 30 * 86400000),
    E('breath.kept', o.rid, { b, of: 'call', ref: c, ms: 2000, mime: 'audio/webm' }, NOW - 30 * 86400000 + 500),
    E('call.move', o.rid, { c, move: 'help' }, NOW - 30 * 86400000 + 1000),
    E('round.closed', o.rid, { reason: 'print', print: null }, NOW - 30 * 86400000 + 2000),
    E('field.cut', null, { through: iso(NOW - 30 * 86400000 + 3000) }, NOW - 30 * 86400000 + 3000)];
  const r2 = opened('ai', NOW - 29 * 86400000);
  evs.push(r2.ev);
  return { events: evs, blobs: o2.noBlob ? {} : { [b]: BLOB } };
}
const cardsOpened = W => W.SU.opened.filter(x => x[0] === 'card').length;

await t('15.1: SYNC NOW outlived by the guard: ROLLING, and the line card never comes back', async () => {
  const f = shareRound();
  const W = await world({ key: true, line: 'home', events: f.events, series: f.series, syncs: [{ ok: true }, { defer: true }] });
  await W.tap('lever'); await W.tap('line');
  await W.answer('card', 'sync');
  ok(W.ST.pendingSync, 'the sync is held');
  const n = cardsOpened(W);
  W.GE.guardCb();
  await flush();
  eq(W.view().mode, 'ROLLING');
  W.ST.pendingSync({ ok: true }); W.ST.pendingSync = null;
  await flush(60);
  await W.advance(600000);
  eq(W.view().mode, 'ROLLING', 'still ROLLING ten minutes later');
  eq(Object.keys(W.SU.open), [], 'no overlay open');
  eq(cardsOpened(W), n, 'the card was never reopened');
});

await t('15.1: SYNC NOW outlived by his own lever tap or by 61 s idle: no card on ROLLING', async () => {
  for (const how of ['lever', 'idle']) {
    const f = shareRound();
    const W = await world({ key: true, line: 'home', events: f.events, series: f.series, syncs: [{ ok: true }, { defer: true }] });
    await W.tap('lever'); await W.tap('line');
    await W.answer('card', 'sync');
    const n = cardsOpened(W);
    if (how === 'lever') await W.tap('lever'); else await W.advance(61000);
    eq(W.view().mode, 'ROLLING', how);
    W.ST.pendingSync({ ok: true }); W.ST.pendingSync = null;
    await flush(60);
    eq(Object.keys(W.SU.open), [], how + ': no overlay open');
    eq(cardsOpened(W), n, how + ': the card was never reopened');
  }
});

await t('15.1: tag card REFRESH outlived by the guard: no card on ROLLING', async () => {
  const f = shareRound();
  const W = await world({ key: true, line: 'home', events: f.events, series: f.series, syncs: [{ ok: true }] });
  await W.tap('lever'); await W.tap('tag');
  W.ST.refreshHold = true;
  await W.answer('card', 'refresh');
  ok(typeof W.ST.refreshHold === 'function', 'the refresh is held');
  const n = cardsOpened(W);
  W.GE.guardCb();
  await flush();
  W.ST.refreshHold();
  await flush(60);
  eq(W.view().mode, 'ROLLING');
  eq(Object.keys(W.SU.open), [], 'no overlay open');
  eq(cardsOpened(W), n, 'the tag card was never reopened');
});

await t('15.1/15.2: tack card PLAY outlived by the guard: hushed, no card on ROLLING', async () => {
  const b = tackBook();
  const W = await world({ events: b.events, home: HOME, blobs: b.blobs });
  await W.tap('lever'); await W.tap('tack', 0);
  W.SO.holdPlay = true;
  await W.answer('card', 'play');
  eq(W.SO.playing.length, 1, 'his why is playing');
  const n = cardsOpened(W), h = W.soundCalls('hush').length;
  W.GE.guardCb();
  await flush(60);
  eq(W.view().mode, 'ROLLING');
  eq(W.soundCalls('hush').length - h, 1, 'one hush on going ROLLING');
  eq(W.SO.playing.length, 0, 'the play has ended');
  eq(Object.keys(W.SU.open), [], 'no overlay open');
  eq(cardsOpened(W), n, 'the tack card was never reopened');
});

await t('15.1: MIC CHECK outlived by the guard: no card on ROLLING', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, records: ['hold'] });
  await W.tap('lever'); await W.tap('line');
  await W.answer('card', 'check');
  await W.until(() => W.SO.pendingRec, 'the check is recording');
  const n = cardsOpened(W);
  W.GE.guardCb();
  await flush(60);
  eq(W.view().mode, 'ROLLING');
  eq(Object.keys(W.SU.open), [], 'no overlay open');
  eq(cardsOpened(W), n, 'the line card was never reopened');
});

await t('15.2: going ROLLING hushes even with no flow running', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  const h = W.soundCalls('hush').length;
  await W.tap('lever');
  eq(W.view().mode, 'ROLLING');
  eq(W.soundCalls('hush').length - h, 1, 'one hush');
});

await t('15.2: a ROLLING tap hushes before it speaks, so two reads never overlap', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('stage'); await W.tap('stage');
  const seq = W.SO.calls.filter(c => c[0] === 'hush' || c[0] === 'say').map(c => c[0]);
  eq(seq.slice(-4), ['hush', 'say', 'hush', 'say']);
});

await t('15.3: a phone with a key and an empty book opens nothing before its first sync', async () => {
  const W = await world({ key: true, syncs: [{ defer: true }], noWait: true });
  await flush(60);
  await W.tap('lever');
  await flush(60);
  eq(W.view().mode, 'PARKED');
  eq(Object.keys(W.SU.open), [], 'no bands before the sync');
  eq(W.ST.events.length, 0, 'no events before the sync');
  W.ST.pendingSync({ ok: true, pull: closedBook() });
  await W.DR.app.ready; await flush(60);
  await W.until(() => W.SU.open.bands, 'the offer once the sync lands');
  eq(W.openOpts('bands').options, ['TAKE IT', 'NEXT', 'MY OWN']);
  eq(W.evs('round.opened').length, 1, 'only home\'s round');
  await W.answer('bands', null);
});

await t('15.3: the same phone with an empty book from home: macro opens, no bands', async () => {
  const W = await world({ key: true, syncs: [{ defer: true }], noWait: true });
  await flush(60);
  await W.tap('lever');
  await flush(60);
  eq(W.ST.events.length, 0);
  W.ST.pendingSync({ ok: true });
  await W.DR.app.ready; await flush(60);
  eq(W.evs('round.opened').length, 1, 'macro opened after the sync');
  eq(Object.keys(W.SU.open), [], 'no bands: a round is open');
});

await t('15.4: the PARKED fall back counts on performance.now, not a wall clock stepped back', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  await W.advance(10000);
  W.stepWall(-3600000);
  await W.advance(51000);
  eq(W.view().mode, 'ROLLING', 'fell back 60 s after the touch');
});

await t('15.4: hidden two minutes while frozen, wall clock stepped back: ROLLING on return', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  await W.hide();
  await W.frozen(130000);
  W.stepWall(-3600000);
  await W.show();
  eq(W.view().mode, 'ROLLING');
});

await t('15.5: a flow in PARKED holds a wake lock and lets it go at its end', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], mic: 'prompt' });
  await W.tap('lever');
  const req = W.NAV.wakeReq, rel = W.NAV.released;
  await W.tap('dock');
  await flush();
  eq(W.NAV.wakeReq, req + 1, 'asked when the dock began');
  await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  await flush();
  eq(W.NAV.released, rel + 1, 'let go at its end');
  eq(W.view().mode, 'PARKED');
});

await t('15.6: MIC CHECK records raw for two seconds and always plays it back', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, records: [CLIP] });
  await W.tap('lever'); await W.tap('line');
  await W.answer('card', 'check');
  await W.until(() => W.SU.open.card);
  eq(W.SO.calls.filter(x => x[0] === 'record').slice(-1)[0][1].raw, true, 'no voice gate');
  eq(W.SO.calls.filter(x => x[0] === 'record').slice(-1)[0][1].maxMs, 2000);
  ok(W.SO.calls.some(x => x[0] === 'play'), 'played back');
  await W.answer('card', null);
  const W2 = await world({ events: f.events, series: f.series, records: [null] });
  await W2.tap('lever'); await W2.tap('line');
  await W2.answer('card', 'check');
  await W2.until(() => W2.SU.open.card);
  ok(W2.openOpts('card').lines.includes('MIC CHECK: THE MIC RECORDED NOTHING'), 'a raw take is empty only when the mic is dead');
  eq(W2.SO.calls.filter(x => x[0] === 'play').length, 0, 'nothing to play');
  await W2.answer('card', null);
});

await t('15.8: a dock the phone will not store: a buzz and NOT KEPT ON THIS PHONE', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], mic: 'prompt' });
  await W.tap('lever');
  W.ST.addFail = true;
  await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  ok(W.soundCalls('buzz').some(c => JSON.stringify(c[1]) === '[200,80,200]'), 'the refusal buzz');
  ok(W.plates().includes('NOT KEPT ON THIS PHONE'), 'on the plate');
  eq(W.view().plate, 'NOT KEPT ON THIS PHONE', 'it stays on the plate after the flow');
  await W.advance(10000);
  eq(W.view().plate, REGISTRY.canon.macro.q, 'then the question comes back');
});

await t('15.8: TAKE IT the phone will not store: a buzz and NOT KEPT ON THIS PHONE', async () => {
  const W = await world({ events: closedBook() });
  W.ST.addFail = true;
  await W.tap('lever');
  await W.answer('bands', 0);
  await W.until(() => W.DR.app.flow() === null, 'turn end');
  ok(W.soundCalls('buzz').some(c => JSON.stringify(c[1]) === '[200,80,200]'), 'the refusal buzz');
  ok(W.plates().includes('NOT KEPT ON THIS PHONE') || W.view().plate === 'NOT KEPT ON THIS PHONE', 'on the plate');
});

await t('15.8: a breath the phone will not store: a buzz and NOT KEPT ON THIS PHONE', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], records: [CLIP] });
  await W.tap('lever');
  W.ST.blobFail = true;
  await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  eq(W.added(), ['notch.cut']);
  ok(W.soundCalls('buzz').some(c => JSON.stringify(c[1]) === '[200,80,200]'), 'the refusal buzz');
  ok(W.plates().includes('NOT KEPT ON THIS PHONE'), 'on the plate');
});

await t('15.8: a book that would not open: the line card opens once on PARKED', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, openOk: false });
  await W.tap('lever');
  const c = W.openOpts('card');
  ok(c && c.title === 'THE LINE', 'the line card');
  ok(c.lines.includes('THIS PHONE WOULD NOT OPEN ITS BOOK'));
  await W.answer('card', null);
  await W.tap('lever'); await W.tap('lever');
  eq(cardsOpened(W), 1, 'once per launch');
  // A shut book refuses every write too: the first launch's round fails before he parks.
  const W2 = await world({ openOk: false, addFail: true });
  eq(W2.ST.events.length, 0);
  await W2.tap('lever');
  const c2 = W2.openOpts('card');
  ok(c2 && c2.title === 'THE LINE', 'the line card even after a refused write');
  ok(c2.lines.includes('THIS PHONE WOULD NOT OPEN ITS BOOK'), JSON.stringify(c2.lines));
  await W2.answer('card', 'guard');
  await W2.until(() => W2.SU.open.card);
  ok(W2.openOpts('card').lines.includes('THIS PHONE WOULD NOT OPEN ITS BOOK'), 'it stays on the card while the book is shut');
  await W2.answer('card', null);
});

await t('15.9: the idle reload waits for a write in flight', async () => {
  const o = opened('macro', NOW - 86400000, { aim: aim({ after: '2026-10' }) });
  const W = await world({ events: [o.ev], series: seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49)] } }), controller: true });
  await W.tap('lever'); await W.tap('tag');
  await W.answer('card', 'hand');
  await W.until(() => W.SU.open.entry);
  W.swEmit('controllerchange');
  await flush();
  eq(W.LOC.reloads, 0);
  W.ST.addDelay = 5;
  await W.answer('entry', '55.5');
  await W.advance(20);
  const i = W.order.indexOf('reload'), j = W.order.indexOf('add print.hand');
  ok(j >= 0, 'the write landed');
  ok(i > j, 'the reload came after the write: ' + JSON.stringify(W.order.slice(-4)));
});

await t('15.10: copy speaks to him: YOUR BREATH, PLAY YOUR WHY, no HIS in app.js', async () => {
  const f = shareRound({ ups: [true, false] });
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs });
  await W.tap('lever');
  await W.tap('rail', { i: 1, hold: false });
  eq(W.openOpts('card').marks, ['YOUR BREATH']);
  await W.answer('card', null);
  const b = tackBook();
  const W2 = await world({ events: b.events, home: HOME, blobs: b.blobs });
  await W2.tap('lever'); await W2.tap('tack', 0);
  ok(W2.openOpts('card').actions.some(a => a.id === 'play' && a.label === 'PLAY YOUR WHY'));
  await W2.answer('card', null);
  const lits = APP.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || [];
  eq(lits.filter(x => /\bHIS\b/.test(x)), [], 'no on-screen string says HIS');
});

await t('15.10: after MIC ON the line card says MIC ON once', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, mic: 'prompt' });
  await W.tap('lever'); await W.tap('line');
  await W.answer('card', 'mic');
  await W.until(() => W.SU.open.card);
  const lines = W.openOpts('card').lines;
  eq(lines.filter(l => /\bMIC ON\b/.test(l)).length, 1, JSON.stringify(lines));
  await W.answer('card', null);
});

await t('15.11: the paper tag hangs with the soft breath sound; a why does not', async () => {
  const o = opened('macro', NOW - 7200000);
  const W = await world({ events: [o.ev], records: [CLIP] });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  eq(W.evs('breath.kept').length, 1);
  eq(W.soundCalls('breath').length, 1, 'the breath sound');
  const c = W.SO.calls.map(x => x[0]);
  ok(c.lastIndexOf('breath') > c.lastIndexOf('record'), 'after the clip was kept');
});

await t('a voice note not on this phone: the card shows NOT ON THIS PHONE at once', async () => {
  const f = shareRound({ ups: [true, false] });
  const W = await world({ events: f.events, series: f.series, blobs: {} });
  await W.tap('lever');
  await W.tap('rail', { i: 1, hold: false });
  await W.answer('card', 'play');
  await W.until(() => W.SU.open.card);
  ok(W.openOpts('card').lines.includes('NOT ON THIS PHONE'), 'the notch card: ' + JSON.stringify(W.openOpts('card').lines));
  await W.answer('card', 'prev');
  await W.until(() => W.SU.open.card);
  ok(!W.openOpts('card').lines.includes('NOT ON THIS PHONE'), 'only on the notch it was asked for');
  await W.answer('card', null);
  const b = tackBook({ noBlob: true });
  const W2 = await world({ events: b.events, home: HOME, blobs: b.blobs });
  await W2.tap('lever'); await W2.tap('tack', 0);
  await W2.answer('card', 'play');
  await W2.until(() => W2.SU.open.card);
  ok(W2.openOpts('card').lines.includes('NOT ON THIS PHONE'), 'the tack card');
  await W2.answer('card', null);
});

await t('15.21: the AI tag card says THEIR WORDING: NOT FETCHED YET with no question from home', async () => {
  const r = opened('ai', NOW - 86400000);
  const W = await world({ events: [r.ev] });
  await W.tap('lever'); await W.tap('tag');
  ok(W.openOpts('card').lines.includes('THEIR WORDING: NOT FETCHED YET'), JSON.stringify(W.openOpts('card').lines));
  await W.answer('card', null);
});

await t('the ISM tag card with no print: NO PRINT YET, home\'s by-hand note, SET PRINT BY HAND', async () => {
  const note = "You type this one. Read New Orders off ISM's report on release day.";
  const o = opened('macro', NOW - 86400000, { aim: aim({ after: '2026-10', period: '2026-10', label: 'OCT 2026', date: '2026-11-02', time_et: '10:00', conf: 'rule' }) });
  const W = await world({ events: [o.ev], series: seriesOf({ ism_new_orders: { status: 'hand', note } }) });
  await W.tap('lever'); await W.tap('tag');
  const c = W.openOpts('card');
  eq(c.title, 'ISM NEW ORDERS');
  ok(c.lines.includes('NO PRINT YET'), JSON.stringify(c.lines));
  ok(!c.lines.includes('NO PRINT FETCHED YET'), JSON.stringify(c.lines));
  ok(c.lines.includes(note), JSON.stringify(c.lines));
  ok(c.actions.some(a => a.id === 'hand' && a.label === 'SET PRINT BY HAND'), JSON.stringify(c.actions));
  await W.answer('card', null);
});

await t('15.63: a by-hand series offers no REFRESH; a fetched one still does', async () => {
  const note = "You type this one. Read New Orders off ISM's report on release day.";
  const o = opened('macro', NOW - 86400000, { aim: aim({ after: '2026-10', period: '2026-10', label: 'OCT 2026', date: '2026-11-02', time_et: '10:00', conf: 'rule' }) });
  const W = await world({ key: true, events: [o.ev], series: seriesOf({ ism_new_orders: { status: 'hand', note } }) });
  await W.tap('lever'); await W.tap('tag');
  let c = W.openOpts('card');
  eq(c.title, 'ISM NEW ORDERS');
  ok(!c.actions.some(a => a.id === 'refresh'), 'home has nothing to fetch for this one: ' + JSON.stringify(c.actions));
  ok(c.actions.some(a => a.id === 'hand'), 'he can still set it');
  await W.answer('card', null);

  const n = opened('physics', NOW - 86400000, { aim: aim({ after: '2026-09' }) });
  const W2 = await world({ key: true, events: [n.ev], series: seriesOf({ bls_power_price: { prints: [pr('2026-09', 'SEP 2026', 0.18)] } }) });
  await W2.tap('lever'); await W2.tap('tag');
  c = W2.openOpts('card');
  ok(c.actions.some(a => a.id === 'refresh' && a.label === 'REFRESH'), JSON.stringify(c.actions));
  await W2.answer('card', null);
});

/* ── pass two: true numbers, the turn and the book (SPEC 15.12 to 15.25) ── */

// A macro call made on OCT 50, its round closed, waiting on NOV; an ai round open.
function pendingBook() {
  const o = opened('macro', NOW - 40 * 86400000);
  const c = uuid();
  const at = NOW - 30 * 86400000;
  const evs = [o.ev,
    E('call.made', o.rid, { c, lane: 'macro', series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' }, up: true, docks: { u: 3, n: 4 }, inside: true }, at),
    E('call.move', o.rid, { c, move: 'none' }, at + 1000),
    E('round.closed', o.rid, { reason: 'print', print: { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 50, by: 'fetch' } }, at + 2000),
    E('field.cut', null, { through: iso(at + 3000) }, at + 3000)];
  const r2 = opened('ai', at + 4000);
  evs.push(r2.ev);
  return { rid: o.rid, c, events: evs };
}
const OCT_ONLY = () => seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50)] } });
async function handOnTack(W, value) {
  await W.tap('tack', 0);
  await W.answer('card', 'hand');
  await W.until(() => W.SU.open.entry, 'the number entry');
  await W.answer('entry', value);
  await flush(60);
}

await t('15.12: a pending tack card waits on NOV 2026 and sets it by hand; with no key it grades at once', async () => {
  const b = pendingBook();
  const W = await world({ events: b.events, series: OCT_ONLY(), home: HOME });
  eq(W.evs('call.graded').length, 0);
  await W.tap('lever'); await W.tap('tack', 0);
  const c = W.openOpts('card');
  ok(c.lines.includes('WAITING ON NOV 2026'), JSON.stringify(c.lines));
  ok(!c.lines.includes('WAITING ON THE NEXT PRINT'));
  ok(c.actions.some(a => a.id === 'hand' && a.label === 'SET NOV 2026 BY HAND'), JSON.stringify(c.actions));
  await W.answer('card', 'hand');
  await W.until(() => W.SU.open.entry, 'the number entry');
  eq(W.openOpts('entry').title, 'ISM NEW ORDERS · NOV 2026');
  await W.answer('entry', '55.5');
  await flush(60);
  const ph = W.evs('print.hand');
  eq(ph.length, 1);
  eq([ph[0].round, ph[0].data], [b.rid, { series: 'ism_new_orders', period: '2026-11', label: 'NOV 2026', value: 55.5 }], 'his number, on the call\'s own round');
  eq(W.evs('call.graded').length, 1, 'graded right after the print by hand (no key, no second phone)');
  eq(W.evs('call.graded')[0].data, { c: b.c, grade: 1, print: { period: '2026-11', label: 'NOV 2026', value: 55.5 }, base: { period: '2026-10', label: 'OCT 2026', value: 50 } });
  eq(W.view().tacks, [{ lane: 'macro', grade: 1 }]);
  eq(W.plates().slice(-1)[0], 'PRINT 55.5 BY HAND');
});

await t('15.12: a later month alone leaves the tack card waiting on the month he called', async () => {
  const b = pendingBook();
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-12', 'DEC 2026', 57)] } });
  const W = await world({ events: b.events, series, home: HOME });
  eq(W.evs('call.graded').length, 0, 'DEC grades nothing');
  await W.tap('lever'); await W.tap('tack', 0);
  ok(W.openOpts('card').lines.includes('WAITING ON NOV 2026'));
  await W.answer('card', null);
});

await t('15.14: a phone with a key holds a by-hand grade until a sync answers, then grades on home\'s figure', async () => {
  const b = pendingBook();
  const W = await world({ key: true, events: b.events, series: OCT_ONLY(), home: HOME, syncs: [{ ok: false, status: 0 }, { ok: false, status: 0 }] });
  await W.tap('lever');
  await handOnTack(W, '55.5');
  eq(W.evs('print.hand').length, 1, 'the print is kept');
  eq(W.evs('call.graded').length, 0, 'no grade with the line down');
  await W.tap('line');
  await W.answer('card', 'sync');
  await W.until(() => W.SU.open.card, 'the line card back');
  eq(W.evs('call.graded').length, 0, 'a failed sync answers nothing');
  await W.answer('card', null);
  W.ST.syncQueue.push({ ok: true, series: seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 48)] } }) });
  await W.DR.store.sync();
  await flush(60);
  eq(W.evs('call.graded').length, 1, 'graded once the sync answered');
  eq(W.evs('call.graded')[0].data.print, { period: '2026-11', label: 'NOV 2026', value: 48 }, 'on home\'s figure');
  eq(W.evs('call.graded')[0].data.grade, 0);
});

await t('15.14: with a key, a by-hand print a sync has already answered grades', async () => {
  const b = pendingBook();
  const W = await world({ key: true, events: b.events, series: OCT_ONLY(), home: HOME, syncs: [{ ok: true }, { ok: true }] });
  await W.tap('lever');
  await handOnTack(W, '55.5');
  eq(W.evs('call.graded').length, 0, 'held');
  await W.advance(1000);
  await W.DR.store.sync();
  await flush(60);
  eq(W.evs('call.graded').length, 1, 'home had no NOV: his figure grades');
  eq(W.evs('call.graded')[0].data.print.value, 55.5);
});

await t('15.16: a grade on his number says BY HAND, and a later fetch says FETCHED SINCE', async () => {
  const b = pendingBook();
  const W = await world({ events: b.events, series: OCT_ONLY(), home: HOME });
  await W.tap('lever');
  await handOnTack(W, '55.5');
  eq(W.evs('call.graded')[0].data.print.value, 55.5);
  W.ST.seriesV = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 55.3)] } });
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: false }));
  await flush(60);
  W.touch();
  await W.tap('tack', 0);
  const lines = W.openOpts('card').lines;
  ok(lines.includes('IT STOOD ON NOV 2026 55.5 BY HAND'), JSON.stringify(lines));
  ok(lines.includes('NOV 2026 FETCHED SINCE: 55.3'), JSON.stringify(lines));
  eq(lines.filter(l => /REVISED SINCE/.test(l)), [], 'not a revision: it was his typing');
  ok(!W.openOpts('card').actions.some(a => a.id === 'hand'), 'graded: nothing to set');
  await W.answer('card', null);
});

await t('15.17: by hand takes the series\' own decimals, no comma in a decimal, counts with thousands commas', async () => {
  const o = opened('macro', NOW - 86400000, { aim: aim({ after: '2026-10' }) });
  const W = await world({ events: [o.ev], series: OCT_ONLY() });
  await W.tap('lever'); await W.tap('tag');
  await W.answer('card', 'hand');
  for (const bad of ['55.55', '5,5', '55,5', '0x37', '5e1', '']) {
    await W.until(() => W.SU.open.entry, 'entry');
    await W.answer('entry', bad);
    eq(W.openOpts('card') && W.openOpts('card').title, 'NOT THAT NUMBER', bad);
    await W.answer('card', 'again');
  }
  await W.until(() => W.SU.open.entry, 'entry');
  await W.answer('entry', ' 55.5 ');
  await flush();
  eq(W.evs('print.hand').map(e => e.data.value), [55.5]);
  eq(W.added(), ['print.hand'], 'nothing else was written');

  const n = opened('nextgen', NOW - 86400000, { aim: aim({ after: '2026-09' }) });
  const W2 = await world({ events: [n.ev], series: seriesOf({ bfs_applications: { prints: [pr('2026-09', 'SEP 2026', 480000)] } }) });
  await W2.tap('lever'); await W2.tap('tag');
  await W2.answer('card', 'hand');
  for (const bad of ['501,60', '501609.5', '50,1609']) {
    await W2.until(() => W2.SU.open.entry, 'entry');
    await W2.answer('entry', bad);
    eq(W2.openOpts('card') && W2.openOpts('card').title, 'NOT THAT NUMBER', bad);
    await W2.answer('card', 'again');
  }
  await W2.until(() => W2.SU.open.entry, 'entry');
  await W2.answer('entry', '501,609');
  await flush();
  eq(W2.evs('print.hand').map(e => e.data.value), [501609]);
});

await t('15.17: the power price is typed and hinted in cents and kept in dollars', async () => {
  const o = opened('physics', NOW - 86400000, { aim: aim({ after: '2026-09' }) });
  const W = await world({ events: [o.ev], series: seriesOf({ bls_power_price: { prints: [pr('2026-09', 'SEP 2026', 0.17)] } }) });
  await W.tap('lever'); await W.tap('tag');
  await W.answer('card', 'hand');
  await W.until(() => W.SU.open.entry, 'entry');
  ok(/CENTS/.test(W.openOpts('entry').hint) && /\b3\b/.test(W.openOpts('entry').hint) && /\b150\b/.test(W.openOpts('entry').hint), W.openOpts('entry').hint);
  await W.answer('entry', '18.45');
  eq(W.openOpts('card').title, 'NOT THAT NUMBER', 'cents take one decimal');
  await W.answer('card', 'again');
  await W.until(() => W.SU.open.entry, 'entry');
  await W.answer('entry', '18.4¢');
  await flush();
  eq(W.evs('print.hand').map(e => e.data.value), [0.184], 'kept in dollars');
  eq(W.plates().slice(-1)[0], 'PRINT 18.4¢ BY HAND');
});

await t('15.18: an AI round with no schedule closes from the tag card, as an own round, and the turn goes on', async () => {
  const W = await world({ events: closedBook(), mic: 'prompt' });
  await W.tap('lever');
  await W.answer('bands', 0);                                     // TAKE IT: AI canon
  await W.until(() => W.DR.app.flow() === null, 'turn end');
  const ro = W.evs('round.opened').slice(-1)[0];
  eq([ro.data.lane, ro.data.twin, ro.data.aim.period], ['ai', 'btos_ai_use', '']);
  W.stepWall(60 * 86400000);
  W.touch();                                                      // the wall jumped: a touch no longer rescues PARKED (15.39)
  eq(W.view().mode, 'ROLLING');
  await W.tap('lever');                                           // he parks again on the new day
  await W.tap('tag');
  const c = W.openOpts('card');
  ok(c.actions.some(a => a.id === 'closerail' && a.label === 'CLOSE THE RAIL'), JSON.stringify(c.actions));
  ok(!c.actions.some(a => a.id === 'hand'));
  await W.answer('card', 'closerail');
  await W.until(() => W.SU.open.bands, 'move bands', 30000);
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'the turn bands');
  const cm = W.evs('call.made')[0];
  eq([cm.round, cm.data.series, cm.data.from, cm.data.up, cm.data.inside], [ro.round, null, null, null, null]);
  eq(W.evs('round.closed').slice(-1)[0].data, { reason: 'own', print: null });
  eq(W.view().dock, false, 'no round open while the turn runs');
  await W.answer('bands', null);
});

await t('15.18: a round with a print in or a month to wait on is not offered CLOSE THE RAIL', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever'); await W.tap('tag');
  ok(!W.openOpts('card').actions.some(a => a.id === 'closerail'));
  await W.answer('card', null);
});

await t('15.25: after a close stamped a day ahead, two full turns each leave the new round open, one cut per close', async () => {
  const o = opened('macro', NOW - 10 * 86400000);
  const ahead = E('round.closed', o.rid, { reason: 'own', print: null }, NOW + 86400000);
  const W = await world({ events: [o.ev, ahead], mic: 'prompt' });
  eq(W.evs('field.cut').length, 1, 'the launch cut after the close');
  ok(Date.parse(W.evs('field.cut')[0].at) > Date.parse(ahead.at), 'stamped after the close it follows');
  await W.tap('lever');
  await W.answer('bands', 0);                                     // TAKE IT: AI
  await W.until(() => W.DR.app.flow() === null, 'turn end');
  let st = W.DR.reduce(W.ST.events, W.ST.seriesV, iso(W.T.now));
  const r1 = W.evs('round.opened').slice(-1)[0];
  ok(st.active && st.active.id === r1.round && !st.active.shadow, 'the new round is the open one');
  ok(Date.parse(r1.at) > Date.parse(ahead.at), 'stamped after the close');
  eq(W.view().dock, true, 'the dock is live');
  await W.tap('dock');
  ok(W.SU.open.halves, 'a dock opens its halves');
  await W.answer('halves', 'a');
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  eq(W.evs('notch.cut').length, 1);
  W.touch();
  await W.tap('tag');
  await W.answer('card', 'closerail');
  await W.until(() => W.SU.open.bands, 'move bands', 30000);
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'the second turn');
  const closes = W.evs('round.closed');
  eq(closes.length, 2);
  eq(closes[1].round, r1.round, 'his close sorts last');
  eq(W.evs('field.cut').length, 2, 'one cut for each close');
  eq(W.SO.says.slice(-1)[0].startsWith("Field's cut. Next lane, next gen."), true, 'the turn follows the lane he just closed: ' + W.SO.says.slice(-1)[0]);
  await W.answer('bands', 0);                                     // TAKE IT: next gen
  await W.until(() => W.DR.app.flow() === null, 'turn end');
  st = W.DR.reduce(W.ST.events, W.ST.seriesV, iso(W.T.now));
  const r2 = W.evs('round.opened').slice(-1)[0];
  eq(r2.data.lane, 'nextgen');
  ok(st.active && st.active.id === r2.round && !st.active.shadow, 'the second new round is the open one');
  eq(st.rounds.filter(R => R.shadow).length, 0, 'no shadow rounds');
  eq(W.view().dock, true);
  eq(W.evs('field.cut').length, 2, 'still one cut per close');
});

await t('15.13: a late moment calls from the newest print, says it before the halves, and is not graded at once', async () => {
  const o = opened('macro', NOW - 70 * 86400000, { aim: aim({ after: '2026-09', period: '2026-10', label: 'OCT 2026', date: '2026-11-03', conf: 'rule' }) });
  const cs = cuts(o.rid, [true, true, false], NOW - 60 * 86400000);
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-09', 'SEP 2026', 47), pr('2026-10', 'OCT 2026', 49), pr('2026-11', 'NOV 2026', 55.5)] } });
  const W = await world({ events: [o.ev, ...cs], series, mic: 'prompt' });
  await runShareMoment(W);
  const ps = W.plates();
  ok(ps.indexOf('PRINT 49.0') >= 0 && ps.indexOf('NEWEST NOV 2026 55.5') > ps.indexOf('PRINT 49.0'), JSON.stringify(ps));
  ok(W.SO.says.includes('The newest print is fifty-five point five.'), JSON.stringify(W.SO.says));
  eq(W.calls('hand').slice(-1)[0], ['hand', 49], 'the hand stands on the closing print');
  eq(W.openOpts('halves').sub, 'FROM NOV 2026 55.5', 'the seam names the newest print, the one he calls from (15.38)');
  await W.answer('halves', 'a');
  await W.until(() => W.SU.open.bands, 'move bands');
  eq(W.calls('arrow').slice(-1)[0], ['arrow', 55.5, true], 'the arrow on the figure he called from');
  const cm = W.evs('call.made')[0];
  eq(cm.data.from, { period: '2026-11', label: 'NOV 2026', value: 55.5, by: 'fetch' });
  eq(cm.data.inside, W.DR.inside(200 / 3, 3, 49), 'inside is on the closing print');
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn');
  eq(W.evs('round.closed')[0].data.print, { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 49, by: 'fetch' }, 'closed on the closing print');
  eq(W.evs('call.graded').length, 0, 'not graded on a print he could already see');
  const st = W.DR.reduce(W.ST.events, W.ST.seriesV, iso(W.T.now));
  eq(st.rounds[0].call.pending, null);
  await W.answer('bands', null);
});

await t('15.38: a call from a print he typed says BY HAND on the seam', async () => {
  const o = opened('macro', NOW - 7200000, { aim: aim({ after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' }) });
  const cs = cuts(o.rid, [true, false, true], NOW - 3600000);
  const hand = E('print.hand', o.rid, { series: 'ism_new_orders', period: '2026-11', label: 'NOV 2026', value: 55.5 }, NOW - 600000);
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49.0)] } });
  const W = await world({ events: [o.ev, ...cs, hand], series, mic: 'prompt' });
  await runShareMoment(W);
  eq(W.openOpts('halves').sub, 'FROM NOV 2026 55.5 BY HAND');
  await W.answer('halves', null);
});

await t('15.15: a level twin draws no arrow', async () => {
  const o = opened('physics', NOW - 7200000, { aim: aim({ after: '2026-09', period: '2026-10', label: 'OCT 2026', conf: 'none' }) });
  const cs = cuts(o.rid, [true, false, true], NOW - 3600000);
  const series = seriesOf({ bls_power_price: { prints: [pr('2026-09', 'SEP 2026', 0.170), pr('2026-10', 'OCT 2026', 0.180)] } });
  const W = await world({ events: [o.ev, ...cs], series, mic: 'prompt' });
  await runShareMoment(W);
  eq(W.openOpts('halves').sub, 'FROM OCT 2026 ' + W.DR.showValue(0.180, 'bls_power_price'), 'a level twin: the seam still carries the figure (15.38)');
  await W.answer('halves', 'a');
  await W.until(() => W.SU.open.bands, 'move bands');
  eq(W.calls('arrow').filter(c => c[1] !== null), [], 'no arrow');
  eq(W.soundCalls('click').length, 1, 'the click stays');
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn');
  await W.answer('bands', null);
});

await t('15.20: field labels count the flags past the newest 3000', async () => {
  const f = shareRound();
  const home = Object.assign({}, HOME, { field: Object.assign({}, HOME.field, { older: 5 }) });
  const W = await world({ events: f.events, series: f.series, home });
  await W.tap('lever');
  eq(W.view().labels.field, '7 HEARD', 'no cut yet: every flag stands');
  const W2 = await world({ events: closedBook(), home });
  await W2.tap('lever');
  await W2.until(() => W2.SU.open.bands, 'offer bands');
  eq(W2.view().labels.field, '0 STANDING, 7 BALED', 'cut after the oldest listed flag: the older ones are baled');
  await W2.answer('bands', null);
});

await t('15.23: a partial book grades nothing, re-aims nothing and opens nothing until it is whole', async () => {
  const W = await world({ key: true, syncs: [{ ok: true, partial: true }] });
  eq(W.ST.events.length, 0, 'an empty partial book opens no round');
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: false }));
  await flush(60);
  eq(W.evs('round.opened').length, 1, 'the whole book: macro opens');

  const b = pendingBook();
  const later = seriesOf({
    ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 52)] },
    btos_ai_use: { prints: [], upcoming: [{ period: '202626', label: 'DEC 14 TO DEC 27', date: '2026-12-30', time_et: '', conf: 'rule', source: 'RULE' }] },
  });
  const W2 = await world({ key: true, events: b.events, syncs: [{ ok: true, partial: true, series: later }] });
  eq(W2.added(), [], 'no grade, no aim on a partial book');
  await W2.tap('lever');
  eq(W2.view().mode, 'PARKED');
  W2.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: true }));
  await flush(60);
  eq(W2.added(), [], 'a second partial page: still nothing');
  W2.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: false }));
  await flush(60);
  eq(W2.added().sort(), ['call.graded', 'round.aimed']);
});

await t('15.23: a link whose adopt did not sync, then a failed boot sync, opens nothing', async () => {
  const W = await world({ link: { api: 'http://127.0.0.1:8660', code: 'A'.repeat(32) }, adoptSynced: false, syncs: [{ ok: false, status: 0 }] });
  ok(W.ST.calls.some(c => c[0] === 'adopt'), 'adopted');
  eq(W.evs('round.opened').length, 0, 'no stray macro round');
  await W.tap('lever');
  await flush(60);
  eq(Object.keys(W.SU.open), [], 'no offers before a whole sync');
  eq(W.ST.events.length, 0);
});

await t('15.11: the retrace plays the newest three notches that carry a breath, at most', async () => {
  const o = opened('macro', NOW - 7200000, { aim: aim({ after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', conf: 'rule' }) });
  const cs = cuts(o.rid, [true, true, false, true, true, false], NOW - 3600000);
  const series = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 49.0), pr('2026-11', 'NOV 2026', 55.5)] } });
  const mkBook = here => {
    const events = [o.ev, ...cs], blobs = {};
    [1, 2, 3, 4, 5].forEach(i => {
      const b = uuid();
      events.push(E('breath.kept', o.rid, { b, of: 'notch', ref: cs[i].data.n, ms: 1200, mime: 'audio/webm' }, NOW - 1000000 + i));
      if (here(i)) blobs[b] = BLOB;
    });
    return { events, blobs };
  };
  const all = mkBook(() => true);
  const W = await world({ events: all.events, series, blobs: all.blobs, mic: 'prompt' });
  await runShareMoment(W);
  eq(W.soundCalls('play').length, 3, 'five tagged notches, three play');
  await W.answer('halves', null);
  const gap = mkBook(i => i !== 5);
  const W2 = await world({ events: gap.events, series, blobs: gap.blobs, mic: 'prompt' });
  await runShareMoment(W2);
  eq(W2.soundCalls('play').length, 2, 'the newest one is not on this phone: no older one stands in');
  await W2.answer('halves', null);
});

await t('PARKED with no flow takes no wake lock', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  const req = W.NAV.wakeReq;
  await W.advance(20000);
  await W.hide(); await W.advance(5000); await W.show();
  W.touch(); await W.tap('ground');
  eq(W.view().mode, 'PARKED');
  eq(W.NAV.wakeReq, req, 'no wake lock asked in PARKED');
});

await t('a shadow round\'s call is never graded', async () => {
  const a = opened('macro', NOW - 40 * 86400000);
  const s = opened('physics', NOW - 39 * 86400000);
  const c = uuid();
  const evs = [a.ev, s.ev,
    E('call.made', s.rid, { c, lane: 'physics', series: 'bls_power_price', from: { period: '2026-09', label: 'SEP 2026', value: 0.17, by: 'fetch' }, up: true, docks: { u: 0, n: 0 }, inside: null }, NOW - 38 * 86400000)];
  const series = seriesOf({ bls_power_price: { prints: [pr('2026-09', 'SEP 2026', 0.17), pr('2026-10', 'OCT 2026', 0.18)] } });
  const W = await world({ events: evs, series });
  const st = W.DR.reduce(W.ST.events, series, iso(W.T.now));
  const S = st.rounds.find(R => R.id === s.rid);
  ok(S.shadow && S.call && S.call.pending, 'a shadow with a grade it could take');
  eq(W.evs('call.graded').length, 0);
});

await t('the town card asks for the five nearest towns', async () => {
  const f = shareRound({ ups: [true, false] });
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, prefs: { towns: true } });
  await W.tap('lever');
  await W.tap('rail', { i: 1, hold: false });
  await W.answer('card', 'town');
  await W.until(() => W.SU.open.card);
  eq(W.GE.calls.filter(c => c[0] === 'towns'), [['towns', 5]]);
  await W.answer('card', null);
});

/* ── pass three: the second review's fixes (SPEC 15.39 to 15.47) ─────── */

await t('15.40: a PLAY fetched from home never starts once the phone went ROLLING', async () => {
  for (const how of ['tack', 'notch']) {
    let W, rel = null;
    if (how === 'tack') {
      const b = tackBook({ noBlob: true });
      W = await world({ key: true, line: 'home', events: b.events, home: HOME, blobs: b.blobs });
    } else {
      const f = shareRound();
      W = await world({ key: true, line: 'home', events: f.events, series: f.series, blobs: {} });
    }
    W.DR.store.fetchBlob = () => new Promise(r => { rel = () => r(BLOB); });   // the note is at home
    await W.tap('lever');
    if (how === 'tack') await W.tap('tack', 0); else await W.tap('rail', { i: 10, hold: false });
    await W.answer('card', 'play');
    ok(rel, how + ': the fetch is in flight');
    if (how === 'tack') { W.GE.guardCb(); await flush(); } else await W.tap('lever');
    eq(W.view().mode, 'ROLLING', how);
    const p0 = W.soundCalls('play').length;
    rel(); await flush(60);
    eq(W.soundCalls('play').length - p0, 0, how + ': nothing plays');
    eq(W.view().mode, 'ROLLING', how);
    eq(Object.keys(W.SU.open), [], how + ': no card');
  }
});

await t('15.41: a moment ended during its last writes: no knock, no voice, no stale plate', async () => {
  for (const how of ['lever during call.made', 'guard during the WHY bytes', 'lever during call.move']) {
    const f = shareRound();
    const W = await world({ events: f.events, series: f.series, blobs: f.blobs, records: ['hold'] });
    await runShareMoment(W);
    await W.answer('halves', 'a');
    await W.until(() => W.SO.pendingRec, how + ': WHY recording');
    let rel = null;
    if (how === 'lever during call.made') W.ST.addDelay = 40;
    if (how === 'guard during the WHY bytes') {
      const put = W.DR.store.putBlob;
      W.DR.store.putBlob = (...a) => new Promise(r => { rel = () => r(put(...a)); });
    }
    W.SO.pendingRec(CLIP); W.SO.pendingRec = null;
    if (how === 'lever during call.made') {
      await W.until(() => W.order.includes('add START call.made'), 'call.made in flight');
      await W.tap('lever');
    } else if (how === 'guard during the WHY bytes') {
      await W.until(() => rel, 'putBlob in flight');
      W.GE.guardCb(); await flush();
    } else {
      await W.until(() => W.SU.open.bands, 'move bands');
      W.ST.addDelay = 40;
      await W.answer('bands', 0);
      await W.until(() => W.order.includes('add START call.move'), 'call.move in flight');
      await W.tap('lever');
    }
    eq(W.view().mode, 'ROLLING', how);
    const s0 = W.SO.says.length, k0 = W.soundCalls('knock').length, w0 = W.soundCalls('swish').length;
    if (rel) rel();
    await W.advance(200);
    eq(W.SO.says.slice(s0), [], how + ': no voice in ROLLING');
    eq(W.soundCalls('knock').length - k0, 0, how + ': no knock in ROLLING');
    eq(W.soundCalls('swish').length - w0, 0, how + ': no swish in ROLLING');
    if (how === 'lever during call.move') eq(W.added(), ['call.made', 'breath.kept', 'call.move'], how + ': no close, no cut');
    else eq(W.added(), ['call.made', 'breath.kept'], how + ': the WHY stays with its written call');
    const p1 = W.plates().length;
    await W.tap('lever');
    eq(W.view().mode, 'PARKED', how);
    const ps = W.plates().slice(p1);
    eq(ps.length ? ps[ps.length - 1] : W.view().plate, W.view().plate, how + ': the plate drawn is the view\'s');
    await W.advance(20000);
    const ps2 = W.plates().slice(p1);
    eq(ps2.length ? ps2[ps2.length - 1] : W.view().plate, W.view().plate, how + ': still the view\'s');
  }
});

await t('15.42: a WHY the phone will not store: the call stands and YOUR WHY WAS NOT KEPT holds before the bands', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, records: ['hold'] });
  await runShareMoment(W);
  await W.answer('halves', 'a');
  await W.until(() => W.SO.pendingRec, 'WHY recording');
  W.ST.blobFail = true;
  const p0 = W.plates().length, t0 = W.T.mono, k0 = W.soundCalls('knock').length;
  W.SO.pendingRec(CLIP); W.SO.pendingRec = null;
  await W.until(() => W.SU.open.bands, 'move bands', 10000);
  eq(W.soundCalls('buzz').filter(c => JSON.stringify(c[1]) === '[200,80,200]').length, 1, 'the refusal buzz');
  eq(W.soundCalls('knock').length - k0, 1, 'the knock stays');
  ok(W.SO.says.includes("That one's yours."), 'the spoken line stays');
  eq(W.added(), ['call.made'], 'the call stands');
  const ps = W.plates().slice(p0);
  eq(ps[ps.length - 1], 'YOUR WHY WAS NOT KEPT', 'the refusal is the last plate before the bands: ' + JSON.stringify(ps));
  ok(W.T.mono - t0 >= 4000, 'held four seconds: ' + (W.T.mono - t0));
  await W.answer('bands', null);
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'turn');
  await W.answer('bands', null);
});

await t('15.43: a notch card PLAY or TOWN outlived by a dock does not reopen over the halves', async () => {
  for (const how of ['play', 'town']) {
    const f = shareRound();
    const W = await world({ events: f.events, series: f.series, blobs: f.blobs, prefs: { towns: true }, mic: 'prompt' });
    let rel = null;
    if (how === 'town') W.DR.geo.towns = () => new Promise(r => { rel = () => r([{ city: 'GARY', st: 'IN' }]); });
    await W.tap('lever'); await W.tap('rail', { i: 10, hold: false });
    if (how === 'play') W.SO.holdPlay = true;
    await W.answer('card', how);
    if (how === 'town') await W.until(() => rel, 'the town lookup in flight');
    else eq(W.SO.playing.length, 1, 'the breath is playing');
    await W.tap('dock');
    eq(Object.keys(W.SU.open), ['halves'], how + ': the dock is open');
    const n = cardsOpened(W);
    if (how === 'play') { W.SO.holdPlay = false; const p = W.SO.playing; W.SO.playing = []; p.forEach(r => r()); } else rel();
    await flush(60);
    eq(Object.keys(W.SU.open), ['halves'], how + ': only the halves');
    eq(cardsOpened(W), n, how + ': no card reopened');
    await W.answer('halves', 'a');
    await W.until(() => W.DR.app.flow() === null, 'dock end');
    eq(W.evs('notch.cut').length, f.cs.length + 1, how + ': a notch is cut');
  }
});

await t('15.44: the idle reload waits for a voice note\'s bytes, deleted or stored', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, controller: true });
  let rel = null;
  W.DR.store.dropBlob = () => { W.order.push('dropBlob START'); return new Promise(r => { rel = () => { W.order.push('dropBlob DONE'); r(true); }; }); };
  await W.tap('lever'); await W.tap('rail', { i: 10, hold: false });
  W.swEmit('controllerchange'); await flush();
  eq(W.LOC.reloads, 0, 'not while the card is open');
  await W.answer('card', 'drop');
  await W.answer('card', 'yes');
  await W.advance(50);
  ok(rel, 'the delete is in flight');
  eq(W.LOC.reloads, 0, 'no reload while the bytes are being deleted');
  rel();
  await W.advance(50);
  if (W.SU.open.card) await W.answer('card', null);
  await W.advance(50);
  eq(W.LOC.reloads, 1, 'the reload once the delete is done');
  ok(W.order.indexOf('dropBlob DONE') < W.order.indexOf('reload'), JSON.stringify(W.order.slice(-4)));

  const o = opened('macro', NOW - 7200000);
  const W2 = await world({ events: [o.ev], records: [CLIP], controller: true });
  let rel2 = null;
  const put = W2.DR.store.putBlob;
  W2.DR.store.putBlob = (...a) => { W2.order.push('putBlob START'); return new Promise(r => { rel2 = () => { W2.order.push('putBlob DONE'); r(put(...a)); }; }); };
  await W2.tap('lever'); await W2.tap('dock'); await W2.answer('halves', 'a');
  await W2.until(() => rel2, 'the bytes are being stored');
  W2.swEmit('controllerchange'); await flush();
  await W2.tap('lever');                                           // the flow ends; only the bytes are pending
  await W2.advance(50);
  eq(W2.LOC.reloads, 0, 'no reload while the bytes are being stored');
  rel2();
  await W2.advance(50);
  eq(W2.LOC.reloads, 1, 'the reload once they are stored');
  ok(W2.order.indexOf('putBlob DONE') < W2.order.indexOf('reload'), JSON.stringify(W2.order.slice(-4)));
});

await t('15.39: a phone that slept while hidden comes back ROLLING; a short hide stays PARKED', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series });
  await W.tap('lever');
  await W.hide();
  const p0 = W.plates().length;
  W.stepWall(600000);                                              // performance.now() stood still
  await W.show();
  eq(W.view().mode, 'ROLLING', 'ten minutes by the wall clock');
  eq(W.plates().slice(p0), [], 'no plate text');

  const W2 = await world({ events: f.events, series: f.series });
  await W2.tap('lever');
  await W2.hide();
  W2.stepWall(90000);
  await W2.show();
  eq(W2.view().mode, 'ROLLING', 'ninety seconds by the wall clock: the idle rule ran out');

  const W3 = await world({ events: f.events, series: f.series });
  await W3.tap('lever');
  await W3.hide();
  W3.stepWall(4000);
  await W3.show();
  eq(W3.view().mode, 'PARKED', 'four seconds');
});

await t('15.45: on a partial book a print by hand grades nothing until the book is whole', async () => {
  const b = pendingBook();
  const nov = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 52)] } });
  const W = await world({ key: true, events: b.events, home: HOME, syncs: [{ ok: true, partial: true, series: nov }] });
  eq(W.added(), [], 'the partial boot grades nothing');
  await W.tap('lever');
  await handOnTack(W, '55.5');
  eq(W.added(), ['print.hand'], 'only his print');
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: false }));
  await flush(60);
  eq(W.added(), ['print.hand', 'call.graded'], 'graded on the whole book');
});

await t('15.45: a moment closed on a partial book opens no turn until the book is whole', async () => {
  const f = shareRound();
  const W = await world({ key: true, line: 'home', events: f.events, series: f.series, blobs: f.blobs, mic: 'prompt', syncs: [{ ok: true, partial: true, series: f.series }] });
  await runShareMoment(W);
  await W.answer('halves', 'a');
  await W.answer('bands', 0);
  await W.until(() => W.DR.app.flow() === null, 'the moment ends');
  eq(Object.keys(W.SU.open), [], 'no TAKE IT bands');
  eq(W.added(), ['call.made', 'call.move', 'round.closed'], 'no cut, no round opened');
  eq(W.view().plate, 'SYNCING YOUR BOOK', 'the plate says why');
  W.ST.listeners.change.forEach(cb => cb({ pulled: 0, partial: false }));
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'the turn once the book is whole');
  eq(W.evs('field.cut').length, 1, 'one cut');
  await W.answer('bands', null);
});

await t('15.45: a first sync pending in PARKED reads SYNCING YOUR BOOK; it goes when the book lands', async () => {
  const W = await world({ key: true, syncs: [{ ok: false, status: 0 }] });
  eq(W.ST.events.length, 0);
  ok(W.view().plate !== 'SYNCING YOUR BOOK', 'never in ROLLING');
  await W.tap('lever');
  eq(W.view().mode, 'PARKED');
  eq(W.view().plate, 'SYNCING YOUR BOOK');
  W.ST.syncQueue.push({ ok: true });
  await W.DR.store.sync();
  await flush(60);
  eq(W.evs('round.opened').length, 1, 'the macro round opens');
  eq(W.view().plate, REGISTRY.canon.macro.q, 'the plate carries its question');
});

await t('15.45: a partial book, then FORGET THIS KEY: grading and the turn stop waiting', async () => {
  const b = pendingBook();
  const nov = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 52)] } });
  const W = await world({ key: true, line: 'home', events: b.events, home: HOME, syncs: [{ ok: true, partial: true, series: nov }] });
  eq(W.added(), [], 'held on the partial book');
  await W.tap('lever'); await W.tap('line');
  await W.answer('card', 'forget'); await W.answer('card', 'yes');
  await flush(60);
  eq(W.added(), ['call.graded'], 'graded as a phone with no key');
  if (W.SU.open.card) await W.answer('card', null);

  const W2 = await world({ key: true, line: 'home', events: closedBook(), syncs: [{ ok: true, partial: true }] });
  await W2.tap('lever');
  eq(Object.keys(W2.SU.open), [], 'the turn waits on the partial book');
  await W2.tap('line');
  await W2.answer('card', 'forget'); await W2.answer('card', 'yes');
  await flush(60);
  if (W2.SU.open.card) await W2.answer('card', null);
  if (!W2.SU.open.bands) await W2.tap('dial');
  await W2.until(() => W2.SU.open.bands && W2.openOpts('bands').options[0] === 'TAKE IT', 'the turn opens');
  await W2.answer('bands', null);
});

await t('15.46: a by-hand figure held for a sync: the tack card says so and still offers SET', async () => {
  const b = pendingBook();
  const down = Array.from({ length: 6 }, () => ({ ok: false, status: 0 }));
  const W = await world({ key: true, events: b.events, series: OCT_ONLY(), home: HOME, syncs: down });
  await W.tap('lever');
  await handOnTack(W, '55.5');
  eq(W.evs('call.graded').length, 0, 'held');
  W.touch();
  await W.tap('tack', 0);
  const c = W.openOpts('card');
  ok(c.lines.includes('SET BY HAND: NOV 2026 55.5'), JSON.stringify(c.lines));
  ok(c.lines.includes('GRADES AFTER THE NEXT SYNC'), JSON.stringify(c.lines));
  ok(!c.lines.includes('WAITING ON NOV 2026'), 'not the plain waiting line');
  ok(c.actions.some(a => a.id === 'hand' && a.label === 'SET NOV 2026 BY HAND'), JSON.stringify(c.actions));
  await W.answer('card', null);
});

await t('15.47: past 3000 flags with the cut older than the oldest listed one: N+ STANDING', async () => {
  const home = Object.assign({}, HOME, { field: Object.assign({}, HOME.field, { older: 5 }) });
  const b = pendingBook();                                         // its cut is a month old
  const W = await world({ events: b.events, home });
  await W.tap('lever');
  eq(W.view().labels.field, '2+ STANDING', 'the split is unknown');
  const f = shareRound();
  const W2 = await world({ events: f.events, series: f.series, home });
  await W2.tap('lever');
  eq(W2.view().labels.field, '7 HEARD', 'no cut: exact');
  const W3 = await world({ events: closedBook(), home });
  await W3.tap('lever');
  await W3.until(() => W3.SU.open.bands, 'offer bands');
  eq(W3.view().labels.field, '0 STANDING, 7 BALED', 'a cut inside the list: as before');
  await W3.answer('bands', null);
});

await t('15.18: an AI round whose print is in by rule three is not offered CLOSE THE RAIL', async () => {
  const r = opened('ai', NOW - 20 * 86400000, { aim: aim({ after: '202620' }) });
  const series = seriesOf({ btos_ai_use: { prints: [pr('202622', 'OCT 19 TO NOV 1', 18.2)] } });
  const W = await world({ events: [r.ev], series });
  ok(W.DR.closingPrint(W.DR.reduce(W.ST.events, series, iso(W.T.now)).active, W.DR.reduce(W.ST.events, series, iso(W.T.now)).prints), 'a closing print by rule three');
  await W.tap('lever'); await W.tap('tag');
  ok(!W.openOpts('card').actions.some(a => a.id === 'closerail'), JSON.stringify(W.openOpts('card').actions));
  await W.answer('card', null);
});

/* ── pass four: the third review's fixes ───────────────────────────────── */

await t('15.43: FORGET on a partial book: the turn opens and the line card does not reopen over it', async () => {
  const W = await world({ key: true, line: 'home', events: closedBook(), syncs: [{ ok: true, partial: true }] });
  await W.tap('lever');
  eq(Object.keys(W.SU.open), [], 'the turn waits on the partial book');
  await W.tap('line');
  await W.answer('card', 'forget'); await W.answer('card', 'yes');
  await W.advance(200);
  eq(Object.keys(W.SU.open), ['bands'], 'one overlay, the turn\'s bands');
  eq(W.openOpts('bands').options[0], 'TAKE IT');
  eq(W.DR.app.flow(), 'turn');
  await W.answer('bands', null);
});

// A flow that begins in the moment a card closes: nothing a card would open next lands over it.
async function closeThenDock(W, kind, v) {
  await W.until(() => W.SU.open[kind], 'overlay ' + kind);
  const r = W.SU.open[kind]; delete W.SU.open[kind]; r.res(v);
  W.emit('dock');                                       // before the card's own code goes on
  await flush(60);
}
await t('15.43: a card that goes on after it closes opens nothing over a flow begun in between', async () => {
  for (const how of ['heard next', 'line forget', 'notch drop', 'town type', 'tack hand', 'entry bad number']) {
    const f = shareRound(), b = pendingBook();
    const tack = how === 'tack hand' || how === 'entry bad number';
    const W = await world(tack ? { events: b.events, series: OCT_ONLY(), home: HOME }
      : { key: how === 'line forget', line: 'home', events: f.events, series: f.series, blobs: f.blobs, home: HOME, mic: 'prompt' });
    await W.tap('lever');
    if (how === 'heard next') { await W.tap('grass'); await closeThenDock(W, 'card', 'next'); }
    if (how === 'line forget') { await W.tap('line'); await closeThenDock(W, 'card', 'forget'); }
    if (how === 'notch drop') { await W.tap('rail', { i: 10, hold: false }); await closeThenDock(W, 'card', 'drop'); }
    if (how === 'town type') { await W.tap('rail', { i: 10, hold: false }); await W.answer('card', 'town'); await closeThenDock(W, 'card', 'type'); }
    if (how === 'tack hand') { await W.tap('tack', 0); await closeThenDock(W, 'card', 'hand'); }
    if (how === 'entry bad number') { await W.tap('tack', 0); await W.answer('card', 'hand'); await closeThenDock(W, 'entry', 'abc'); }
    eq(W.DR.app.flow(), 'dock', how);
    eq(Object.keys(W.SU.open), ['halves'], how + ': only the dock\'s halves');
    await W.answer('halves', null);
    await W.until(() => W.DR.app.flow() === null, how + ': dock end');
  }
});

await t('15.45: the key forgotten mid-pull (line unset, then a partial change): nothing waits on the book', async () => {
  const unsetThenPartial = async (W, series) => {
    W.ST.cfgV = null; W.ST.lineV = 'unset';
    W.ST.listeners.line.forEach(cb => cb('unset'));
    await flush(60);
    if (series) W.ST.seriesV = series;                // the page that landed brought the print
    W.ST.listeners.change.forEach(cb => cb({ pulled: 4, partial: true }));
    await flush(60);
  };
  const W = await world({ key: true, line: 'home', events: closedBook(), syncs: [{ ok: true }] });
  await W.tap('lever');
  await W.answer('bands', null);
  await W.until(() => W.DR.app.flow() === null, 'the turn ends');
  await unsetThenPartial(W);
  eq(W.view().mode, 'PARKED');
  ok(W.view().plate !== 'SYNCING YOUR BOOK', 'the plate does not wait: ' + W.view().plate);
  await W.tap('dial');
  await W.until(() => W.SU.open.bands && W.openOpts('bands').options[0] === 'TAKE IT', 'the turn opens');
  await W.answer('bands', null);

  const b = pendingBook();
  const nov = seriesOf({ ism_new_orders: { prints: [pr('2026-10', 'OCT 2026', 50), pr('2026-11', 'NOV 2026', 52)] } });
  const W2 = await world({ key: true, line: 'home', events: b.events, series: OCT_ONLY(), home: HOME, syncs: [{ ok: true }] });
  await W2.tap('lever');
  eq(W2.added(), [], 'nothing to grade yet');
  await unsetThenPartial(W2, nov);
  eq(W2.added(), ['call.graded'], 'graded as a phone with no key');
});

await t('15.39: a touch does not rescue a PARKED whose time ran out; it goes ROLLING and does nothing else', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs });
  await W.tap('lever');
  await W.frozen(600000);                                         // a visible page froze ten minutes
  const n0 = W.ST.calls.length;
  await W.tap('dock');
  eq(W.view().mode, 'ROLLING', 'frozen ten minutes');
  eq(W.DR.app.flow(), null, 'no flow');
  eq(Object.keys(W.SU.open), [], 'no overlay');
  eq(W.ST.calls.slice(n0).filter(c => c[0] === 'add'), [], 'nothing written');
  await W.tap('lever');
  eq(W.view().mode, 'PARKED', 'a lever tap from ROLLING still parks');

  for (const tap of ['lever', 'stage']) {
    const W2 = await world({ events: f.events, series: f.series, blobs: f.blobs });
    await W2.tap('lever');
    W2.stepWall(600000);                                          // slept while visible: performance.now() stood still
    const s0 = W2.SO.says.length;
    await W2.tap(tap);
    eq(W2.view().mode, 'ROLLING', 'wall clock ten minutes on, a touch on the ' + tap);
    eq(W2.SO.says.slice(s0), [], tap + ': the touch is swallowed');
    await W2.tap('lever');
    eq(W2.view().mode, 'PARKED', tap + ': the next lever tap parks');
  }

  const W3 = await world({ events: f.events, series: f.series, blobs: f.blobs });
  await W3.tap('lever');
  await W3.advance(30000);
  await W3.tap('dock');
  eq(W3.view().mode, 'PARKED', 'a touch 30 s on works as before');
  eq(Object.keys(W3.SU.open), ['halves'], 'the dock opens');
  await W3.answer('halves', null);
});

await t('15.41: a flip or a pull whose write lands in ROLLING makes no sound; the write stands', async () => {
  for (const how of ['rail flip', 'rail pull', 'card flip', 'card pull']) {
    let W;
    if (how.startsWith('rail')) {
      const o = opened('macro', NOW - 7200000);
      W = await world({ events: [o.ev], mic: 'prompt' });
      await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
      await W.until(() => W.DR.app.flow() === null, 'dock end');
      W.ST.addDelay = 40;
      await W.tap('rail', { i: 0, hold: how === 'rail pull' });
    } else {
      const f = shareRound();
      W = await world({ events: f.events, series: f.series, blobs: f.blobs });
      await W.tap('lever'); await W.tap('rail', { i: 10, hold: false });
      W.ST.addDelay = 40;
      await W.answer('card', how === 'card flip' ? 'flip' : 'pull');
    }
    const type = how.endsWith('flip') ? 'notch.flip' : 'notch.pull';
    await W.until(() => W.order.includes('add START ' + type), how + ': the write in flight');
    await W.tap('lever');
    eq(W.view().mode, 'ROLLING', how);
    const s0 = W.SO.says.length, c0 = W.SO.calls.length;
    await W.advance(200);
    eq(W.evs(type).length, 1, how + ': the write stands');
    eq(W.SO.says.slice(s0), [], how + ': no voice in ROLLING');
    eq(W.SO.calls.slice(c0).map(c => c[0]).filter(k => k === 'tick' || k === 'knock'), [], how + ': no tick, no knock in ROLLING');
    eq(Object.keys(W.SU.open), [], how + ': no card');
  }
});

await t('15.41: the lever during the round.closed write: no field.cut in ROLLING', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, mic: 'prompt' });
  await runShareMoment(W);
  await W.answer('halves', 'a');
  await W.until(() => W.SU.open.bands, 'move bands', 10000);
  W.ST.addDelay = 40;
  await W.answer('bands', 0);
  await W.until(() => W.order.includes('add START call.move'), 'call.move in flight');
  await W.advance(40);                                            // call.move lands; round.closed starts
  await W.until(() => W.order.includes('add START round.closed'), 'round.closed in flight');
  ok(!W.order.includes('add round.closed'), 'round.closed still in flight');
  await W.tap('lever');
  eq(W.view().mode, 'ROLLING');
  const w0 = W.soundCalls('swish').length;
  await W.advance(500);
  eq(W.added(), ['call.made', 'call.move', 'round.closed'], 'the close stands, no cut');
  eq(W.evs('field.cut').length, 0, 'no field.cut');
  eq(W.soundCalls('swish').length - w0, 0, 'no swish');
  eq(Object.keys(W.SU.open), [], 'no bands');
});

await t('15.41: the guard during a dock breath\'s bytes: the breath is kept, and no breath sound', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, records: [CLIP] });
  let rel = null; const put = W.DR.store.putBlob;
  W.DR.store.putBlob = (...a) => new Promise(r => { rel = () => r(put(...a)); });
  await W.tap('lever'); await W.tap('dock'); await W.answer('halves', 'a');
  await W.until(() => rel, 'the bytes are being stored', 20000);
  W.GE.guardCb(); await flush();
  eq(W.view().mode, 'ROLLING');
  const c0 = W.SO.calls.length;
  rel(); await W.advance(200);
  eq(W.added(), ['notch.cut', 'breath.kept'], 'a breath already recorded is kept (15.41)');
  eq(W.SO.calls.slice(c0).filter(c => c[0] === 'breath'), [], 'no breath sound in ROLLING');
});

await t('15.41: mk() for a flow that has ended draws and keeps nothing', async () => {
  const f = shareRound();
  const W = await world({ events: f.events, series: f.series, blobs: f.blobs, mic: 'prompt', peek: true });
  const P = W.peek();
  await W.tap('lever'); await W.tap('dock');
  const dead = P.A.flow;
  ok(dead && dead.kind === 'dock', 'a dock runs');
  await W.tap('lever');                                           // the lever ends it
  ok(dead.dead, 'the dock is dead');
  const p0 = W.plates().length;
  P.mk(dead, 'plate', 'STALE');
  eq(Object.keys(P.A.marks), [], 'a dead flow keeps no mark');
  eq(W.plates().slice(p0), [], 'a dead flow draws nothing');
  await W.tap('lever'); await W.tap('dock');
  const done = P.A.flow;
  await W.answer('halves', null);
  await W.until(() => W.DR.app.flow() === null, 'dock end');
  P.mk(done, 'plate', 'STALE');                                   // ended by its own end(), not dead
  eq(Object.keys(P.A.marks), [], 'an ended flow keeps no mark');
  eq(W.plates().slice(p0), [], 'an ended flow draws nothing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
