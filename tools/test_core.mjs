// Tests for shell/js/core.js (SPEC 9.12). Node, no packages.
// Run: node shell/tools/test_core.mjs   -> one line per failure, a count, exit 1 on any failure.
process.env.TZ = 'America/New_York';   // dates are the device's local calendar; pin it before core loads

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const DR = require(path.join(SHELL, 'js', 'core.js'));
const REGISTRY = JSON.parse(fs.readFileSync(path.join(SHELL, 'registry.json'), 'utf8'));
DR.setRegistry(REGISTRY);

let passed = 0, failed = 0;
function fail(name, msg) { failed++; console.log('FAIL ' + name + ': ' + msg); }
function t(name, fn) {
  try { const r = fn(); if (r === false) fail(name, 'returned false'); else passed++; }
  catch (e) { fail(name, e && e.message ? e.message : String(e)); }
}
const show = (v) => JSON.stringify(v);
function eq(a, b, what = '') {
  if (DR.canonical(a) !== DR.canonical(b)) throw new Error((what ? what + ': ' : '') + 'got ' + show(a) + ' want ' + show(b));
}
function ok(c, what) { if (!c) throw new Error(what || 'not true'); }

// Partial tree: every key shown must match; lists by position and length. A number against a list = its length.
function match(exp, act, p, errs) {
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) { errs.push(p + ': want a list, got ' + show(act)); return; }
    if (exp.length !== act.length) { errs.push(p + ': want ' + exp.length + ' items, got ' + act.length); return; }
    exp.forEach((e, i) => match(e, act[i], p + '[' + i + ']', errs));
  } else if (exp !== null && typeof exp === 'object') {
    if (act === null || typeof act !== 'object' || Array.isArray(act)) { errs.push(p + ': want an object, got ' + show(act)); return; }
    for (const k of Object.keys(exp)) {
      if (!(k in act)) { errs.push(p + '.' + k + ': missing'); continue; }
      match(exp[k], act[k], p + '.' + k, errs);
    }
  } else if (typeof exp === 'number' && Array.isArray(act)) {
    if (act.length !== exp) errs.push(p + ': want length ' + exp + ', got ' + act.length);
  } else if (exp !== act) {
    errs.push(p + ': want ' + show(exp) + ', got ' + show(act));
  }
}
function partial(exp, act, what) {
  const errs = []; match(exp, act, what || '$', errs);
  if (errs.length) throw new Error(errs.slice(0, 4).join('; '));
}
function getPath(o, dotted) {
  // keys may hold dots only as the separator; uuids hold none
  let cur = o;
  for (const k of dotted.split('.')) { if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
}

const PLACES = new Set(['JOLIET|IL']);

// Home's plain counting rule (SPEC 6.1 / 8.3), over the events home would store.
function plainSummary(events) {
  const seen = new Map();
  for (const e of events) if (DR.validate(e, PLACES) === '' && !seen.has(e.id)) seen.set(e.id, e);
  const ev = [...seen.values()];
  const rounds = new Set(ev.filter((e) => e.type === 'round.opened').map((e) => e.round));
  const pulled = new Set(ev.filter((e) => e.type === 'notch.pull').map((e) => e.data.n));
  const docks = new Set(ev.filter((e) => e.type === 'notch.cut' && !pulled.has(e.data.n)).map((e) => e.data.n));
  const calls = new Set(ev.filter((e) => e.type === 'call.made').map((e) => e.data.c));
  return { rounds: rounds.size, docks: docks.size, calls: calls.size };
}

/* ---------------- fixtures ---------------- */

const FIX = path.join(HERE, 'fixtures');
const files = fs.readdirSync(FIX).filter((f) => /^reduce-.*\.json$/.test(f)).sort();
t('fixtures present', () => ok(files.length >= 17 && files.includes('reduce-basic.json'), 'found ' + files.length));
for (const f of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  const name = f.replace(/\.json$/, '');
  let st = null;
  t(name + ' reduce', () => {
    st = DR.reduce(fx.events, fx.homeSeries, fx.now);
    partial(fx.expect.state || {}, st, 'state');
  });
  t(name + ' summary (plain rule)', () => eq(plainSummary(fx.events), fx.expect.summary));
  if (fx.expect.absent) t(name + ' absent', () => {
    for (const p of fx.expect.absent) ok(getPath(st, p) === undefined, p + ' should not be there');
  });
  if (fx.expect.calc) t(name + ' calc', () => {
    const c = fx.expect.calc;
    const R = c.round ? st.rounds.find((r) => r.id === c.round) : st.active;
    ok(R, 'no round');
    if ('closing' in c) {
      const got = DR.closingPrint(R, st.prints);
      if (c.closing === null) eq(got, null, 'closing'); else partial(c.closing, got, 'closing');
    }
    if ('due' in c) eq(DR.due(R, st.prints, fx.now), c.due, 'due');
    if ('tag' in c) eq(DR.tag(R, st.prints, fx.now), c.tag, 'tag');
    if ('reaim' in c) {
      const got = DR.reaim(R, fx.homeSeries, fx.now);
      if (c.reaim === null) eq(got, null, 'reaim'); else partial(c.reaim, got, 'reaim');
    }
  });
  if (fx.expect.field) t(name + ' field', () => partial(fx.expect.field, DR.fieldDays(fx.flags, st.cutThrough, fx.now), 'field'));
  t(name + ' events pass validate with the town list', () => {
    // every event in a fixture other than the garbage one is valid, so home would store it
    if (name === 'reduce-garbage') return;
    for (const e of fx.events) eq(DR.validate(e, PLACES), '', e.id);
  });
}
t('reduce-basic town: refused without JOLIET in the list', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'reduce-basic.json'), 'utf8'));
  const placeEv = fx.events.find((e) => e.type === 'notch.place');
  eq(DR.validate(placeEv, new Set(['PEORIA|IL'])), 'town not in list');
});

/* ---------------- registry and lookups ---------------- */

t('registry shape', () => {
  eq(DR.registry().version, 1);
  eq(REGISTRY.turn_order, ['macro', 'ai', 'nextgen', 'crypto', 'physics']);
  eq(REGISTRY.lanes.map((l) => l.id), ['ai', 'nextgen', 'crypto', 'macro', 'physics']);
  eq(Object.keys(REGISTRY.series).sort(), ['bfs_applications', 'bls_power_price', 'btos_ai_use', 'ism_new_orders']);
  eq(REGISTRY.min_round_days, 7); eq(REGISTRY.own_round_days, 30);
  for (const l of REGISTRY.turn_order) {
    const c = REGISTRY.canon[l];
    eq(DR.validate(DR.event('round.opened', DR.uuid(), { lane: l, q: c.q, say: c.say, words: c.words, twin: c.twin, origin: 'canon',
      aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' }, from: null }), null), '', 'canon ' + l);
  }
});
t('lane, canon, series', () => {
  eq(DR.lane('ai').say, 'A.I.'); eq(DR.lane('nope'), null);
  eq(DR.canon('crypto').twin, null); eq(DR.canon('x'), null);
  eq(DR.series('ism_new_orders').id, 'ism_new_orders'); eq(DR.series('x'), null); eq(DR.series(null), null);
});
t('VERSION', () => eq(DR.VERSION, '0.1.0'));

/* ---------------- ids, clock, event ---------------- */

t('uuid v4 lower case', () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (let i = 0; i < 50; i++) ok(re.test(DR.uuid()));
  ok(DR.uuid() !== DR.uuid());
});
t('nowIso, tzNow, event', () => {
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(DR.nowIso()));
  ok(Number.isInteger(DR.tzNow()));
  const e = DR.event('notch.flip', DR.uuid(), { n: DR.uuid() });
  eq(Object.keys(e).sort(), ['at', 'data', 'dev', 'id', 'round', 'type', 'tz']);
  eq(e.dev, ''); eq(DR.validate(e, null), '');
  eq(DR.event('field.cut', undefined, { through: DR.nowIso() }).round, null);
});

/* ---------------- validate: one test per rule, pass and fail ---------------- */

const U = () => DR.uuid();
const AIM = { after: '2026-09', period: '2026-10', label: 'OCT 2026', date: '2026-11-02', time_et: '10:00', conf: 'rule' };
function base(type, data, round) {
  return { id: U(), dev: '', at: '2026-10-01T15:00:00.000Z', tz: -240, type, round: round === undefined ? U() : round, data };
}
const OPEN = () => base('round.opened', { lane: 'macro', q: 'ORDERS UP OR DOWN?', say: 'orders up or down?', words: ['UP', 'DOWN'], twin: 'ism_new_orders', origin: 'canon', aim: { ...AIM }, from: null });
const CALL = () => base('call.made', { c: U(), lane: 'macro', series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: 55.5, by: 'fetch' }, up: true, docks: { u: 7, n: 11 }, inside: true });
function with_(ev, fn) { fn(ev); return ev; }
function pass(name, ev, places = null) { t('validate pass: ' + name, () => eq(DR.validate(ev, places), '')); }
function refuse(name, ev, places = null, why) {
  t('validate refuse: ' + name, () => {
    const r = DR.validate(ev, places);
    ok(r !== '', 'accepted');
    if (why) ok(r.indexOf(why) === 0, 'reason ' + show(r) + ' want ' + why);
  });
}

// the envelope
pass('a whole round.opened', OPEN());
refuse('not an object', null); refuse('an array', []); refuse('a string', 'x');
refuse('id upper case', with_(OPEN(), (e) => { e.id = e.id.toUpperCase(); }), null, 'bad id');
refuse('id not v4', with_(OPEN(), (e) => { e.id = '00000000-0000-1000-8000-000000000000'; }), null, 'bad id');
refuse('dev not a string', with_(OPEN(), (e) => { e.dev = null; }), null, 'bad dev');
refuse('at without ms', with_(OPEN(), (e) => { e.at = '2026-10-01T15:00:00Z'; }), null, 'bad at');
refuse('at with an offset', with_(OPEN(), (e) => { e.at = '2026-10-01T15:00:00.000-05:00'; }), null, 'bad at');
refuse('at impossible', with_(OPEN(), (e) => { e.at = '2026-02-30T15:00:00.000Z'; }), null);
refuse('tz not an integer', with_(OPEN(), (e) => { e.tz = -300.5; }), null, 'bad tz');
refuse('tz out of range', with_(OPEN(), (e) => { e.tz = 900; }), null, 'bad tz');
pass('tz New York winter', with_(OPEN(), (e) => { e.tz = -300; }));
refuse('unknown type', with_(OPEN(), (e) => { e.type = 'round.burned'; }), null, 'unknown type');
refuse('round missing where needed', with_(OPEN(), (e) => { e.round = null; }), null, 'bad round');
refuse('field.cut with a round', base('field.cut', { through: '2026-10-01T15:00:00.000Z' }), null, 'round must be null');
pass('breath.dropped with round null', base('breath.dropped', { b: U() }, null));
refuse('data not an object', with_(OPEN(), (e) => { e.data = [1]; }), null, 'bad data');
pass('extra top-level key (a store mark)', with_(OPEN(), (e) => { e.sent = true; }));
// rule 0.3: banned key names at any depth
for (const k of ['lat', 'lon', 'lng', 'coords', 'accuracy', 'address', 'zip', 'street']) {
  refuse('banned key ' + k + ' at the top', with_(OPEN(), (e) => { e[k] = 1; }), null, 'banned key');
}
refuse('banned key deep in data', with_(OPEN(), (e) => { e.data.from = { day: '2026-11-14', taps: 3, minutes: 4, x: [{ zip: '60431' }] }; }), null, 'banned key');
refuse('banned key in another case', with_(OPEN(), (e) => { e.Lat = 1; }), null, 'banned key');
// size cap
refuse('data over 2000 bytes as canonical JSON', with_(OPEN(), (e) => { e.data.aim.label = 'X'.repeat(1900); }), null, 'data too big');
pass('data just under the cap', with_(OPEN(), (e) => { e.data.aim.label = 'X'.repeat(1700); }));
t('size cap counts UTF-8 bytes', () => {
  const e = with_(OPEN(), (x) => { x.data.aim.label = 'é'.repeat(900); });   // 1800 bytes, 900 chars
  eq(DR.validate(e, null), 'data too big');
});
// lane, words, q, say
refuse('lane unknown', with_(OPEN(), (e) => { e.data.lane = 'sports'; }), null, 'bad lane');
refuse('words mixed', with_(OPEN(), (e) => { e.data.words = ['UP', 'NO']; }), null, 'bad words');
refuse('words three', with_(OPEN(), (e) => { e.data.words = ['UP', 'DOWN', 'SAME']; }), null, 'bad words');
pass('words YES NO', with_(OPEN(), (e) => { e.data.words = ['YES', 'NO']; }));
refuse('q lower case', with_(OPEN(), (e) => { e.data.q = 'orders up or down?'; }), null, 'bad q');
refuse('q no question mark', with_(OPEN(), (e) => { e.data.q = 'ORDERS UP OR DOWN'; }), null, 'bad q');
refuse('q too short', with_(OPEN(), (e) => { e.data.q = 'A?'; }), null, 'bad q');
refuse('q too long', with_(OPEN(), (e) => { e.data.q = 'A'.repeat(60) + '?'; }), null, 'bad q');
refuse('q a bad character', with_(OPEN(), (e) => { e.data.q = 'ORDERS UP! OR DOWN?'; }), null, 'bad q');
pass('q with digits and \' - , .', with_(OPEN(), (e) => { e.data.q = "IT'S 2-WAY, OR A.M. ONLY?"; }));
pass('q 60 characters', with_(OPEN(), (e) => { e.data.q = 'A'.repeat(59) + '?'; }));
refuse('say too short', with_(OPEN(), (e) => { e.data.say = 'ok'; }), null, 'bad say');
refuse('say too long', with_(OPEN(), (e) => { e.data.say = 'a'.repeat(81); }), null, 'bad say');
pass('say 80', with_(OPEN(), (e) => { e.data.say = 'a'.repeat(80); }));
// twin, origin, from
refuse('twin unknown', with_(OPEN(), (e) => { e.data.twin = 'gdp'; }), null, 'bad series');
refuse('twin with origin own', with_(OPEN(), (e) => { e.data.origin = 'own'; }), null, 'twin only with origin canon');
refuse('twin with origin flags', with_(OPEN(), (e) => { e.data.origin = 'flags'; e.data.from = { day: '2026-11-14', taps: 11, minutes: 20 }; }), null, 'twin only');
pass('origin own, twin null', with_(OPEN(), (e) => { e.data.origin = 'own'; e.data.twin = null; e.data.aim = { after: '', period: '', label: '', date: '2026-12-01', time_et: '', conf: 'own' }; }));
refuse('origin unknown', with_(OPEN(), (e) => { e.data.origin = 'model'; }), null, 'bad origin');
pass('origin flags with from', with_(OPEN(), (e) => { e.data.origin = 'flags'; e.data.twin = null; e.data.from = { day: '2026-11-14', taps: 11, minutes: 20 }; }));
refuse('origin flags without from', with_(OPEN(), (e) => { e.data.origin = 'flags'; e.data.twin = null; }), null, 'flags needs from');
refuse('from on a canon question', with_(OPEN(), (e) => { e.data.from = { day: '2026-11-14', taps: 11, minutes: 20 }; }), null, 'from only');
refuse('from with a bad day', with_(OPEN(), (e) => { e.data.origin = 'flags'; e.data.twin = null; e.data.from = { day: '14 NOV', taps: 11, minutes: 20 }; }), null, 'bad from day');
refuse('data with an extra key', with_(OPEN(), (e) => { e.data.extra = 1; }), null, 'bad data keys');
// aim and round.aimed
refuse('aim missing a key', with_(OPEN(), (e) => { delete e.data.aim.time_et; }), null, 'bad aim');
refuse('aim field not a string', with_(OPEN(), (e) => { e.data.aim.label = 5; }), null, 'bad aim');
refuse('aim date bad', with_(OPEN(), (e) => { e.data.aim.date = '2026-11-2'; }), null, 'bad aim date');
refuse('aim conf bad', with_(OPEN(), (e) => { e.data.aim.conf = 'guess'; }), null, 'bad conf');
pass('aim all empty, conf none', with_(OPEN(), (e) => { e.data.aim = { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' }; }));
pass('round.aimed', base('round.aimed', { ...AIM, conf: 'confirmed' }));
refuse('round.aimed bad conf', base('round.aimed', { ...AIM, conf: 'maybe' }), null, 'bad conf');
// notches
pass('notch.cut place null', base('notch.cut', { n: U(), up: true, place: null }));
refuse('notch.cut n not a uuid', base('notch.cut', { n: 'n1', up: true, place: null }), null, 'bad n');
refuse('notch.cut up not boolean', base('notch.cut', { n: U(), up: 1, place: null }), null, 'bad up');
pass('notch.cut place in the list', base('notch.cut', { n: U(), up: true, place: { city: 'JOLIET', st: 'IL' } }), PLACES);
refuse('notch.cut place not in the list', base('notch.cut', { n: U(), up: true, place: { city: 'PEORIA', st: 'IL' } }), PLACES, 'town not in list');
pass('notch.cut places null skips only the list test', base('notch.cut', { n: U(), up: true, place: { city: 'PEORIA', st: 'IL' } }), null);
refuse('notch.cut city lower case', base('notch.cut', { n: U(), up: true, place: { city: 'Joliet', st: 'IL' } }), null, 'bad city');
refuse('notch.cut city with a digit', base('notch.cut', { n: U(), up: true, place: { city: 'DOCK 4', st: 'IL' } }), null, 'bad city');
refuse('notch.cut city 41 long', base('notch.cut', { n: U(), up: true, place: { city: 'A'.repeat(41), st: 'IL' } }), null, 'bad city');
pass("notch.cut city with . ' -", base('notch.cut', { n: U(), up: true, place: { city: "ST. MARY'S-BY SEA", st: 'MD' } }), null);
refuse('notch.cut st three letters', base('notch.cut', { n: U(), up: true, place: { city: 'JOLIET', st: 'ILL' } }), null, 'bad st');
refuse('notch.cut place with an extra key', base('notch.cut', { n: U(), up: true, place: { city: 'JOLIET', st: 'IL', yard: 'X' } }), null, 'bad place');
pass('notch.flip', base('notch.flip', { n: U() }));
refuse('notch.flip bad n', base('notch.flip', { n: '' }), null, 'bad n');
pass('notch.pull', base('notch.pull', { n: U() }));
pass('notch.place clear', base('notch.place', { n: U(), city: '', st: '' }), PLACES);
pass('notch.place in the list', base('notch.place', { n: U(), city: 'JOLIET', st: 'IL' }), PLACES);
refuse('notch.place half empty', base('notch.place', { n: U(), city: '', st: 'IL' }), PLACES, 'bad city');
refuse('notch.place not in the list', base('notch.place', { n: U(), city: 'GARY', st: 'IN' }), PLACES, 'town not in list');
// breaths
const BK = (o = {}) => base('breath.kept', { b: U(), of: 'notch', ref: U(), ms: 2400, mime: 'audio/webm', ...o });
pass('breath.kept', BK());
pass('breath.kept of call', BK({ of: 'call' }));
refuse('breath.kept of other', BK({ of: 'tack' }), null, 'bad of');
refuse('breath.kept ref bad', BK({ ref: 'x' }), null, 'bad ref');
refuse('breath.kept ms 199', BK({ ms: 199 }), null, 'bad ms');
pass('breath.kept ms 200', BK({ ms: 200 }));
pass('breath.kept ms 30000', BK({ ms: 30000 }));
refuse('breath.kept ms 30001', BK({ ms: 30001 }), null, 'bad ms');
pass('breath.kept mime with codecs', BK({ mime: 'audio/webm;codecs=opus' }));
pass('breath.kept mime ogg', BK({ mime: 'audio/ogg' }));
pass('breath.kept mime mp4', BK({ mime: 'audio/mp4' }));
refuse('breath.kept mime wav', BK({ mime: 'audio/wav' }), null, 'bad mime');
pass('breath.dropped', base('breath.dropped', { b: U() }));
refuse('breath.dropped bad b', base('breath.dropped', { b: 7 }), null, 'bad b');
// print.hand and value
const PH = (o = {}) => base('print.hand', { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 55.5, ...o });
pass('print.hand', PH());
pass('print.hand BTOS cycle', PH({ series: 'btos_ai_use', period: '202616', value: 9.4 }));
refuse('print.hand series null', PH({ series: null }), null, 'bad series');
refuse('print.hand series unknown', PH({ series: 'gdp' }), null, 'bad series');
refuse('print.hand value above hi', PH({ value: 80.1 }), null, 'value out of range');
refuse('print.hand value below lo', PH({ value: 19.9 }), null, 'value out of range');
pass('print.hand value at lo', PH({ value: 20 }));
refuse('print.hand value not finite', PH({ value: Infinity }), null, 'bad value');
refuse('print.hand value a string', PH({ value: '55.5' }), null, 'bad value');
refuse('print.hand period bad', PH({ period: 'OCT' }), null, 'bad period');
pass('print.hand power price', PH({ series: 'bls_power_price', value: 0.196 }));
refuse('print.hand power price out of range', PH({ series: 'bls_power_price', value: 19.6 }), null, 'value out of range');
// call.made
pass('call.made', CALL());
pass('call.made no twin', with_(CALL(), (e) => { e.data.series = null; e.data.from = null; e.data.up = null; e.data.inside = null; }));
refuse('call.made up null with a twin', with_(CALL(), (e) => { e.data.up = null; }), null, 'bad up');
refuse('call.made up set with no twin', with_(CALL(), (e) => { e.data.series = null; e.data.from = null; }), null, 'bad up');
refuse('call.made from without a series', with_(CALL(), (e) => { e.data.series = null; e.data.up = null; }), null, 'from needs a series');
pass('call.made from null', with_(CALL(), (e) => { e.data.from = null; }));
refuse('call.made from by bad', with_(CALL(), (e) => { e.data.from.by = 'guess'; }), null, 'bad by');
refuse('call.made from value out of range', with_(CALL(), (e) => { e.data.from.value = 90; }), null, 'value out of range');
refuse('call.made docks u > n', with_(CALL(), (e) => { e.data.docks = { u: 3, n: 2 }; }), null, 'bad docks');
refuse('call.made docks n > 10000', with_(CALL(), (e) => { e.data.docks = { u: 0, n: 10001 }; }), null, 'bad docks');
refuse('call.made docks negative', with_(CALL(), (e) => { e.data.docks = { u: -1, n: 2 }; }), null, 'bad docks');
pass('call.made docks 0 of 0', with_(CALL(), (e) => { e.data.docks = { u: 0, n: 0 }; }));
pass('call.made docks 10000', with_(CALL(), (e) => { e.data.docks = { u: 10000, n: 10000 }; }));
refuse('call.made inside a string', with_(CALL(), (e) => { e.data.inside = 'yes'; }), null, 'bad inside');
refuse('call.made c bad', with_(CALL(), (e) => { e.data.c = 'c1'; }), null, 'bad c');
// call.move, call.graded
pass('call.move', base('call.move', { c: U(), move: 'position' }));
for (const m of ['money', 'help', 'none']) pass('call.move ' + m, base('call.move', { c: U(), move: m }));
refuse('call.move bad', base('call.move', { c: U(), move: 'sell' }), null, 'bad move');
const GR = (o = {}) => base('call.graded', { c: U(), grade: 1, print: { period: '2026-11', label: 'NOV 2026', value: 56 }, base: { period: '2026-10', label: 'OCT 2026', value: 55.5 }, ...o });
pass('call.graded 1', GR()); pass('call.graded 0', GR({ grade: 0 })); pass('call.graded null', GR({ grade: null }));
refuse('call.graded 2', GR({ grade: 2 }), null, 'bad grade');
refuse('call.graded true', GR({ grade: true }), null, 'bad grade');
refuse('call.graded print missing label', GR({ print: { period: '2026-11', value: 56 } }), null, 'bad print');
// round.closed
pass('round.closed print', base('round.closed', { reason: 'print', print: { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 55.5, by: 'hand' } }));
pass('round.closed own', base('round.closed', { reason: 'own', print: null }));
refuse('round.closed reason bad', base('round.closed', { reason: 'quit', print: null }), null, 'bad reason');
refuse('round.closed print value out of range', base('round.closed', { reason: 'print', print: { series: 'ism_new_orders', period: '2026-10', label: 'OCT 2026', value: 5, by: 'fetch' } }), null, 'value out of range');
// field.cut
pass('field.cut through Z', base('field.cut', { through: '2026-11-11T04:30:00.000Z' }, null));
pass('field.cut through Z no ms', base('field.cut', { through: '2026-11-11T04:30:00Z' }, null));
refuse('field.cut through with an offset', base('field.cut', { through: '2026-11-10T23:30:00-05:00' }, null), null, 'bad through');
refuse('field.cut through a day', base('field.cut', { through: '2026-11-10' }, null), null, 'bad through');
// The same edges as home's events.validate (SPEC 6: same rules, both sides).
pass('field.cut through with 6 fraction digits (as home)', base('field.cut', { through: '2026-11-11T04:30:00.123456Z' }, null));
refuse('field.cut through with 7 fraction digits', base('field.cut', { through: '2026-11-11T04:30:00.1234567Z' }, null), null, 'bad through');
pass('breath.kept mime upper case (home lower-cases)', BK({ mime: 'AUDIO/WEBM' }));
pass('breath.kept mime mixed case with codecs', BK({ mime: 'Audio/Ogg; codecs=opus' }));
pass('tz -720 (home floor)', with_(OPEN(), (e) => { e.tz = -720; }));
refuse('tz -721 (home refuses)', with_(OPEN(), (e) => { e.tz = -721; }), null, 'bad tz');
refuse('tz -800 (home refuses)', with_(OPEN(), (e) => { e.tz = -800; }), null, 'bad tz');
pass('tz 840 (home ceiling)', with_(OPEN(), (e) => { e.tz = 840; }));
refuse('tz 841', with_(OPEN(), (e) => { e.tz = 841; }), null, 'bad tz');
const FL = (from) => with_(OPEN(), (e) => { e.data.origin = 'flags'; e.data.twin = null; e.data.from = from; });
refuse('from taps 0 (home wants >= 1)', FL({ day: '2026-11-14', taps: 0, minutes: 20 }), null, 'bad from counts');
refuse('from minutes 0 (home wants >= 1)', FL({ day: '2026-11-14', taps: 3, minutes: 0 }), null, 'bad from counts');
pass('from taps 1 minutes 1', FL({ day: '2026-11-14', taps: 1, minutes: 1 }));
refuse('from day not a real date', FL({ day: '2026-02-30', taps: 3, minutes: 4 }), null, 'bad from day');
refuse('from day month 13', FL({ day: '2026-13-01', taps: 3, minutes: 4 }), null, 'bad from day');
pass('from day Feb 29 in a leap year', FL({ day: '2028-02-29', taps: 3, minutes: 4 }));
// Past 2**53 - 1 a whole number is a rounded float here and exact digits at home: both sides refuse it.
pass('from taps 2**53 - 1', FL({ day: '2026-11-14', taps: 2 ** 53 - 1, minutes: 4 }));
refuse('from taps 2**53', FL({ day: '2026-11-14', taps: 2 ** 53, minutes: 4 }), null, 'bad from counts');
refuse('from minutes 2**53', FL({ day: '2026-11-14', taps: 3, minutes: 2 ** 53 }), null, 'bad from counts');
pass('from taps 5.0 read from JSON', JSON.parse(JSON.stringify(FL({ day: '2026-11-14', taps: 3, minutes: 4 })).replace('"taps":3', '"taps":5.0')));
t('offers: a proposal past 2**53 - 1 taps is no offer', () => {
  const p = { q: 'ANY AGENTS ON THE DOCK?', say: 'any agents on the dock?', words: ['YES', 'NO'], day: '2026-11-14', minutes: 20 };
  eq(DR.offers('macro', { ai: [{ ...p, taps: 2 ** 53 - 1 }] }).filter((x) => x.origin === 'flags').length, 1);
  eq(DR.offers('macro', { ai: [{ ...p, taps: 2 ** 53 }] }).filter((x) => x.origin === 'flags').length, 0);
});
refuse('aim date not a real date', with_(OPEN(), (e) => { e.data.aim.date = '2026-02-30'; }), null, 'bad aim date');
refuse('round.aimed date not a real date', base('round.aimed', { ...AIM, date: '2027-02-29' }), null, 'bad aim date');
pass('aim date Dec 31', with_(OPEN(), (e) => { e.data.aim.date = '2026-12-31'; }));
// Shapes home refuses, so the phone must too (sync-9).
refuse('a lone surrogate in a data string', base('print.hand', { series: 'ism_new_orders', period: '2026-10', label: 'OCT \ud800 2026', value: 55.5 }), null, 'bad text');
refuse('a lone low surrogate in a data string', base('print.hand', { series: 'ism_new_orders', period: '2026-10', label: '\udc00OCT', value: 55.5 }), null, 'bad text');
pass('a whole surrogate pair in a data string', base('print.hand', { series: 'ism_new_orders', period: '2026-10', label: 'OCT 😀 2026', value: 55.5 }));
refuse('at in year 0000', with_(OPEN(), (e) => { e.at = '0000-06-01T12:00:00.000Z'; }), null, 'bad at');
pass('at in year 0001', with_(OPEN(), (e) => { e.at = '0001-06-01T12:00:00.000Z'; }));
t('validate takes a plain array of places too', () => eq(DR.validate(base('notch.place', { n: U(), city: 'JOLIET', st: 'IL' }), ['JOLIET|IL']), ''));

/* ---------------- reduce never throws ---------------- */

t('reduce on garbage input', () => {
  for (const bad of [null, undefined, 'x', 42, {}, [null, 1, 'a', [], {}], [{ type: 'round.opened' }]]) {
    const s = DR.reduce(bad, 'nope', null);
    eq(s.rounds, []); eq(s.active, null); eq(s.tacks, []); eq(s.cutThrough, null);
  }
});
t('reduce empty', () => partial({ rounds: [], active: null, tacks: [], asked: {}, cutThrough: null, lastClosed: null, breaths: {}, hand: {}, prints: {} }, DR.reduce([], {}, DR.nowIso())));
t('reduce with homeSeries passes prints through', () => {
  const s = DR.reduce([], { ism_new_orders: { prints: [{ period: '2026-10', label: 'OCT 2026', value: 55.5, by: 'fetch', source: 'ISM PDF', url: 'u', released: '2026-11-02', fetched_at: 'f' }] } }, null);
  eq(s.prints.ism_new_orders, [{ period: '2026-10', label: 'OCT 2026', value: 55.5, by: 'fetch', source: 'ISM PDF', url: 'u', released: '2026-11-02', fetched_at: 'f' }]);
});

/* ---------------- prints, grading, closing ---------------- */

const P = (period, value, extra = {}) => ({ period, label: DR.periodLabel(period), value, by: 'fetch', source: 'T', url: '', released: '', fetched_at: '', ...extra });
t('mergePrints: home beats hand, ascending', () => {
  const m = DR.mergePrints({ ism_new_orders: { prints: [P('2026-10', 53.5), P('2026-08', 47)] } },
    { ism_new_orders: [{ period: '2026-10', label: 'OCT 2026', value: 52, by: 'hand', at: 'A' }, { period: '2026-11', label: 'NOV 2026', value: 56, by: 'hand', at: 'B' }],
      bfs_applications: [{ period: '2026-09', label: 'SEP 2026', value: 500000, by: 'hand', at: 'C' }] });
  eq(m.ism_new_orders.map((p) => [p.period, p.value, p.by]), [['2026-08', 47, 'fetch'], ['2026-10', 53.5, 'fetch'], ['2026-11', 56, 'hand']]);
  partial({ source: 'BY HAND', fetched_at: 'B', url: '', released: '' }, m.ism_new_orders[2]);
  eq(m.bfs_applications.length, 1);
});
t('mergePrints accepts a plain list per series', () => eq(DR.mergePrints({ x: [P('2026-01', 1)] }, {}).x.length, 1));
const callOf = (up, fromV, extra = {}) => ({ series: 'ism_new_orders', from: { period: '2026-10', label: 'OCT 2026', value: fromV, by: 'fetch' }, up, ...extra });
t('gradeFor: no later print', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50)] }), null));
t('gradeFor: up and rose', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 51)] }).grade, 1));
t('gradeFor: up and fell', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 49)] }).grade, 0));
t('gradeFor: down and fell', () => eq(DR.gradeFor(callOf(false, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 49)] }).grade, 1));
t('gradeFor: down and rose', () => eq(DR.gradeFor(callOf(false, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 51)] }).grade, 0));
t('gradeFor: equal', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 50)] }), { grade: null, print: { period: '2026-11', label: 'NOV 2026', value: 50 }, base: { period: '2026-10', label: 'OCT 2026', value: 50 } }));
t('gradeFor: base is the stored (revised) print', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 52), P('2026-11', 51)] }).grade, 0));
t('gradeFor: base falls back to from when its period is gone', () => {
  const g = DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-11', 51)] });
  eq(g.base, { period: '2026-10', label: 'OCT 2026', value: 50 }); eq(g.grade, 1);
});
t('gradeFor: skips a print at an earlier period', () => eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-09', 10), P('2026-10', 50), P('2026-11', 49)] }).print.period, '2026-11'));
// SPEC 15.12: a monthly call is graded only by the month right after from.period; any later month leaves it plain.
t('gradeFor monthly: a later month is not the one he called', () => {
  eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2027-01', 52)] }), null);
  eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-12', 52)] }), null);
});
t('gradeFor monthly: grades on the month right after', () => {
  const g = DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 51), P('2026-12', 40)] });
  eq(g.print.period, '2026-11'); eq(g.grade, 1);
  eq(DR.gradeFor(callOf(true, 50), { ism_new_orders: [P('2026-10', 50), P('2026-11', 49)] }).print.period, '2026-11');
});
t('gradeFor monthly: December grades on January of the next year', () => {
  const c = callOf(false, 50, { from: { period: '2026-12', label: 'DEC 2026', value: 50, by: 'fetch' } });
  eq(DR.gradeFor(c, { ism_new_orders: [P('2026-12', 50), P('2027-01', 48)] }).print.period, '2027-01');
  eq(DR.gradeFor(c, { ism_new_orders: [P('2026-12', 50), P('2027-02', 48)] }), null);
});
t('gradeFor cycle: the first later print still grades', () => {
  const c = { series: 'btos_ai_use', from: { period: '202615', label: '6 JUL - 19 JUL', value: 9.5, by: 'fetch' }, up: true };
  const g = DR.gradeFor(c, { btos_ai_use: [P('202615', 9.5), P('202618', 9.9), P('202619', 9.0)] });
  eq(g.print.period, '202618'); eq(g.grade, 1);
});
t('awaitedPeriod', () => {
  eq(DR.awaitedPeriod(callOf(true, 50)), { period: '2026-11', label: 'NOV 2026' });
  eq(DR.awaitedPeriod(callOf(true, 50, { from: { period: '2026-12', label: 'DEC 2026', value: 50, by: 'hand' } })), { period: '2027-01', label: 'JAN 2027' });
  eq(DR.awaitedPeriod({ series: 'btos_ai_use', from: { period: '202615', label: 'x', value: 9.5, by: 'fetch' }, up: true }), null);
  eq(DR.awaitedPeriod({ series: null, from: null, up: null }), null);
  eq(DR.awaitedPeriod({ series: 'ism_new_orders', from: null, up: true }), null);
  eq(DR.awaitedPeriod(null), null);
});
t('gradeFor: no twin / up null / no from', () => {
  eq(DR.gradeFor({ series: null, from: null, up: null }, {}), null);
  eq(DR.gradeFor(callOf(null, 50), { ism_new_orders: [P('2026-11', 51)] }), null);
  eq(DR.gradeFor({ series: 'ism_new_orders', from: null, up: true }, { ism_new_orders: [P('2026-11', 51)] }), null);
});
const RND = (o = {}) => ({ id: U(), lane: 'macro', twin: 'ism_new_orders', say: 'orders up or down?', words: ['UP', 'DOWN'], u: 7, n: 11, openedAt: '2026-10-05T14:00:00.000Z', hands: [], aim: { ...AIM }, ...o });
t('closingPrint: no twin is null', () => eq(DR.closingPrint(RND({ twin: null }), { ism_new_orders: [P('2026-12', 50)] }), null));
t('closingPrint rule 2 exact period', () => eq(DR.closingPrint(RND(), { ism_new_orders: [P('2026-09', 49), P('2026-10', 55.5)] }).value, 55.5));
t('closingPrint rule 2 nothing yet', () => eq(DR.closingPrint(RND(), { ism_new_orders: [P('2026-09', 49)] }), null));
t('closingPrint rule 3 seen exactly 7 days later', () => {
  const r = RND({ aim: { ...AIM, period: '', date: '', conf: 'none' } });
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-10', 50, { released: '2026-10-11' })] }), null);
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-10', 50, { released: '2026-10-12' })] }).period, '2026-10');
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-10', 50, { released: '2026-10-12' })] }, { min_round_days: 8 }), null);
});
t('closingPrint rule 1 beats rule 2', () => {
  const r = RND({ hands: [{ series: 'ism_new_orders', period: '2026-09', at: 'x' }] });
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-09', 49), P('2026-10', 55.5)] }).period, '2026-09');
});
t('closingPrint rule 1 ignores a hand print made after the round closed', () => {
  const r = RND({ closed: true, closedAt: '2026-11-03T15:00:00.000Z', hands: [{ series: 'ism_new_orders', period: '2026-11', at: '2026-12-02T15:00:00.000Z' }] });
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-10', 55.5), P('2026-11', 57)] }).period, '2026-10');
  const before = RND({ closed: true, closedAt: '2026-11-03T15:00:00.000Z', hands: [{ series: 'ism_new_orders', period: '2026-11', at: '2026-11-03T14:00:00.000Z' }] });
  eq(DR.closingPrint(before, { ism_new_orders: [P('2026-10', 55.5), P('2026-11', 57)] }).period, '2026-11');
});
t('closingPrint ignores a hand print for another series', () => {
  const r = RND({ hands: [{ series: 'bfs_applications', period: '2026-09', at: 'x' }] });
  eq(DR.closingPrint(r, { ism_new_orders: [P('2026-09', 49)] }), null);
});

/* ---------------- due and tag, by the local date ---------------- */

t('due: open before the date', () => eq(DR.due(RND(), {}, '2026-11-01T12:00:00.000Z'), 'open'));
t('due: open on the date', () => eq(DR.due(RND(), {}, '2026-11-02T20:00:00.000Z'), 'open'));
t('due: late the next local day', () => eq(DR.due(RND(), {}, '2026-11-03T12:00:00.000Z'), 'late'));
t('due: not late at 23:30 local even though UTC is a day on', () => eq(DR.due(RND(), {}, '2026-11-03T04:30:00.000Z'), 'open'));
t('due: in', () => eq(DR.due(RND(), { ism_new_orders: [P('2026-10', 55.5)] }, '2026-11-03T12:00:00.000Z'), 'in'));
t('due: twin with no date is open', () => eq(DR.due(RND({ aim: { ...AIM, period: '', after: '', date: '', conf: 'none' } }), {}, '2027-03-01T12:00:00.000Z'), 'open'));
const OWNR = (date) => RND({ twin: null, lane: 'crypto', words: ['YES', 'NO'], say: 'anybody here own any crypto?', aim: { after: '', period: '', label: '', date, time_et: '', conf: 'own' } });
t('due: own on its local date', () => eq(DR.due(OWNR('2026-10-31'), {}, '2026-10-31T12:00:00.000Z'), 'own'));
t('due: own not yet at 23:30 the night before (UTC already on the day)', () => eq(DR.due(OWNR('2026-10-31'), {}, '2026-10-31T03:30:00.000Z'), 'open'));
t('due: null round', () => eq(DR.due(null, {}, '2026-10-31T12:00:00.000Z'), 'open'));
t('tag: rule date', () => eq(DR.tag(RND({ aim: { ...AIM, date: '2026-12-01' } }), {}, '2026-11-20T12:00:00.000Z'), { text: 'DEC 1', lamp: false, rule: true }));
t('tag: confirmed date', () => eq(DR.tag(RND({ aim: { ...AIM, date: '2026-12-01', conf: 'confirmed' } }), {}, '2026-11-20T12:00:00.000Z'), { text: 'DEC 1', lamp: false, rule: false }));
t('tag: IN', () => eq(DR.tag(RND(), { ism_new_orders: [P('2026-10', 55.5)] }, '2026-11-01T12:00:00.000Z'), { text: 'IN', lamp: true, rule: false }));
t('tag: LATE', () => eq(DR.tag(RND(), {}, '2026-11-05T12:00:00.000Z'), { text: 'LATE', lamp: true, rule: false }));
t('tag: DUE', () => eq(DR.tag(OWNR('2026-10-31'), {}, '2026-11-05T12:00:00.000Z'), { text: 'DUE', lamp: true, rule: false }));
t('tag: own date before it is due', () => eq(DR.tag(OWNR('2026-10-31'), {}, '2026-10-05T12:00:00.000Z'), { text: 'OCT 31', lamp: false, rule: false }));
t('tag: blank', () => eq(DR.tag(RND({ aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' } }), {}, '2026-11-05T12:00:00.000Z'), { text: '', lamp: false, rule: false }));
t('tag: no round', () => eq(DR.tag(null, {}, '2026-11-05T12:00:00.000Z'), { text: '', lamp: false, rule: false }));

/* ---------------- aimFor, reaim, handPeriod, offers ---------------- */

const HOME = {
  ism_new_orders: {
    prints: [P('2026-09', 49), P('2026-10', 55.5)],
    upcoming: [
      { period: '2026-12', label: 'DEC 2026', date: '2027-01-04', time_et: '10:00', conf: 'rule', source: 'ISM RULE' },
      { period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule', source: 'ISM RULE' },
    ],
  },
  btos_ai_use: { prints: [], upcoming: [] },
};
const NOW = '2026-11-21T03:00:00.000Z';   // 22:00 on Nov 20 in New York
t('aimFor: twin, first upcoming at least 7 days out', () => eq(DR.aimFor({ twin: 'ism_new_orders' }, HOME, NOW), { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' }));
t('aimFor: an upcoming date under 7 days out is passed over', () => eq(DR.aimFor({ twin: 'ism_new_orders' }, HOME, '2026-11-25T15:00:00.000Z').period, '2026-12'));
t('aimFor: exactly 7 days out counts', () => eq(DR.aimFor({ twin: 'ism_new_orders' }, HOME, '2026-11-24T15:00:00.000Z').period, '2026-11'));
t('aimFor: no upcoming = blank tag', () => eq(DR.aimFor({ twin: 'btos_ai_use' }, HOME, NOW), { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' }));
t('aimFor: no home at all', () => eq(DR.aimFor({ twin: 'ism_new_orders' }, {}, NOW).conf, 'none'));
t('aimFor: no twin = local today + 30, own', () => eq(DR.aimFor({ twin: null }, HOME, NOW), { after: '', period: '', label: '', date: '2026-12-20', time_et: '', conf: 'own' }));
t('reaim: fills after when empty', () => {
  const r = RND({ aim: { after: '', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' } });
  eq(DR.reaim(r, HOME, NOW), { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' });
});
t('reaim: fills the date when conf is none', () => {
  const r = RND({ aim: { after: '2026-10', period: '', label: '', date: '', time_et: '', conf: 'none' } });
  eq(DR.reaim(r, HOME, NOW), { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' });
});
t('reaim: updates a changed date for aim.period', () => {
  const r = RND({ aim: { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-02', time_et: '10:00', conf: 'rule' } });
  eq(DR.reaim(r, HOME, NOW).date, '2026-12-01');
});
t('reaim: rule date confirmed by home', () => {
  const h = JSON.parse(JSON.stringify(HOME)); h.ism_new_orders.upcoming[1].conf = 'confirmed';
  const r = RND({ aim: { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' } });
  eq(DR.reaim(r, h, NOW).conf, 'confirmed');
});
t('reaim: nothing changed is null', () => eq(DR.reaim(RND({ aim: { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' } }), HOME, NOW), null));
t('reaim: no twin, no round, closed round', () => {
  eq(DR.reaim(OWNR('2026-12-01'), HOME, NOW), null); eq(DR.reaim(null, HOME, NOW), null);
  eq(DR.reaim(RND({ closed: true, aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' } }), HOME, NOW), null);
});
t('reaim: still nothing known is null', () => eq(DR.reaim(RND({ twin: 'btos_ai_use', aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' } }), HOME, NOW), null));
t('handPeriod: aim.period', () => eq(DR.handPeriod(RND(), HOME, NOW), { period: '2026-10', label: 'OCT 2026' }));
t('handPeriod: month after aim.after', () => eq(DR.handPeriod(RND({ aim: { ...AIM, period: '', label: '', after: '2026-12' } }), HOME, NOW), { period: '2027-01', label: 'JAN 2027' }));
t('handPeriod: last calendar month (local) with no after', () => eq(DR.handPeriod(RND({ aim: { ...AIM, period: '', label: '', after: '' } }), HOME, '2026-01-01T03:00:00.000Z'), { period: '2025-11', label: 'NOV 2025' }));
t('handPeriod: BTOS with no period is off', () => eq(DR.handPeriod(RND({ twin: 'btos_ai_use', aim: { ...AIM, period: '', after: '202616' } }), HOME, NOW), null));
t('handPeriod: BTOS with a period', () => eq(DR.handPeriod(RND({ twin: 'btos_ai_use', aim: { ...AIM, period: '202617', label: '2 NOV - 15 NOV' } }), HOME, NOW), { period: '202617', label: '2 NOV - 15 NOV' }));
t('handPeriod: no twin', () => eq(DR.handPeriod(OWNR('2026-12-01'), HOME, NOW), null));
const PROPS = { ai: [{ q: 'ANY AGENTS ON THE DOCK?', say: 'any agents on the dock?', words: ['YES', 'NO'], day: '2026-11-14', taps: 11, minutes: 20 }],
                crypto: [{ q: 'bad', say: 'x', words: ['A', 'B'], day: '2026-11-14', taps: 3, minutes: 2 }] };
t('offers: turn order after the closed lane, canon then flags', () => {
  const o = DR.offers('macro', PROPS);
  eq(o.map((x) => x.lane + ':' + x.origin), ['ai:canon', 'ai:flags', 'nextgen:canon', 'crypto:canon', 'physics:canon', 'macro:canon']);
  eq(o[0], { lane: 'ai', q: 'ANYBODY HERE USING AI FOR REAL?', say: 'anybody here using A.I. for real?', words: ['YES', 'NO'], twin: 'btos_ai_use', origin: 'canon', from: null });
  eq(o[1], { lane: 'ai', q: 'ANY AGENTS ON THE DOCK?', say: 'any agents on the dock?', words: ['YES', 'NO'], twin: null, origin: 'flags', from: { day: '2026-11-14', taps: 11, minutes: 20 } });
});
t('offers: a proposal with a bad day or counts is no offer (its round.opened would be refused)', () => {
  const good = PROPS.ai[0];
  for (const bad of [{ day: '14 NOV' }, { day: '2026-02-30' }, { taps: 0 }, { taps: 3.5 }, { minutes: 0 }, { minutes: NaN }, { taps: '11' }]) {
    const o = DR.offers('macro', { ai: [{ ...good, ...bad }] });
    eq(o.filter((x) => x.origin === 'flags').length, 0, show(bad));
  }
});
t('offers: every flags offer opens a valid round', () => {
  for (const o of DR.offers('macro', PROPS)) {
    const ev = DR.event('round.opened', DR.uuid(), { lane: o.lane, q: o.q, say: o.say, words: o.words, twin: o.twin, origin: o.origin,
      aim: DR.aimFor(o, {}, '2026-11-17T12:00:00.000Z'), from: o.from });
    eq(DR.validate(ev, null), '', o.lane + ':' + o.origin);
  }
});
t('offers: wraps round from physics', () => eq(DR.offers('physics', {}).map((x) => x.lane), ['macro', 'ai', 'nextgen', 'crypto', 'physics']));
t('offers: no lane starts at macro', () => eq(DR.offers(null, null).map((x) => x.lane), ['macro', 'ai', 'nextgen', 'crypto', 'physics']));

/* ---------------- the dial ---------------- */

const near = (a, b, what) => ok(Math.abs(a - b) < 1e-9, (what || '') + ' got ' + a + ' want ' + b);
t('share', () => { near(DR.share(7, 11), 700 / 11); eq(DR.share(0, 0), null); eq(DR.share(3, 3), 100); });
t('beamHalf', () => { eq(DR.beamHalf(1), 50); eq(DR.beamHalf(25), 10); eq(DR.beamHalf(0), null); near(DR.beamHalf(30), 50 / Math.sqrt(30)); });
t('inside: on the edge is inside', () => { eq(DR.inside(50, 4, 75), true); eq(DR.inside(50, 4, 25), true); });
t('inside: just past the edge is outside', () => { eq(DR.inside(50, 4, 75.01), false); eq(DR.inside(50, 4, 24.99), false); });
t('inside: one dock spans everything', () => { eq(DR.inside(100, 1, 50), true); eq(DR.inside(0, 1, 50.5), false); });
t('inside: no docks is never inside', () => eq(DR.inside(null, 0, 50), false));
t('angle', () => { eq(DR.angle(50), 0); eq(DR.angle(100), 120); eq(DR.angle(0), -120); eq(DR.angle(null), 180); near(DR.angle(700 / 11), (700 / 11 - 50) * 2.4); });
t('heat matches the mockup', () => {
  eq(DR.heat(0), '#4fa3f7'); eq(DR.heat(50), '#efe7d6'); eq(DR.heat(85), '#ff8a1f'); eq(DR.heat(100), '#ff5a1f');
  eq(DR.heat(25), '#9fc5e7'); eq(DR.heat(-5), '#4fa3f7'); eq(DR.heat(120), '#ff5a1f');
});
t('warmth', () => {
  eq(DR.warmth('2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 1);
  near(DR.warmth('2026-09-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 0.5);
  eq(DR.warmth('2026-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 0);
  eq(DR.warmth(null, '2026-11-01T00:00:00.000Z'), 0);
  eq(DR.warmth('2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 1);
});

/* ---------------- field days ---------------- */

function dayFlags(day, k, startId, hh = 8) {
  const out = [];
  for (let i = 0; i < k; i++) out.push([startId + i, day + 'T' + String(hh + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '45' : '05') + ':00-05:00', '']);
  return out;
}
function daysFrom(start, count, step = 1) {
  const out = [], d0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  for (let i = 0; i < count; i++) out.push(new Date(d0 + i * step * 86400000).toISOString().slice(0, 10));
  return out;
}
t('fieldDays: empty', () => eq(DR.fieldDays([], null, NOW), { rows: [], far: null, bales: [], stack: null, standing: 0, baled: 0, pitch: 9 }));
t('fieldDays: no cut means all standing, one stroke per flag', () => {
  const f = [...dayFlags('2026-11-01', 3, 1), ...dayFlags('2026-11-02', 2, 10)];
  const r = DR.fieldDays(f, null, NOW);
  eq(r.standing, 5); eq(r.baled, 0); eq(r.rows.map((x) => [x.d, x.n]), [['2026-11-01', 3], ['2026-11-02', 2]]);
  eq(r.rows.reduce((s, x) => s + x.n, 0), 5);
});
t('fieldDays: far row beyond 20 days and stack beyond 14 bales', () => {
  let id = 1, f = [];
  const baledDays = daysFrom('2026-01-01', 16), standDays = daysFrom('2026-03-01', 25);
  for (const d of baledDays) { f = f.concat(dayFlags(d, 2, id)); id += 10; }
  for (const d of standDays) { f = f.concat(dayFlags(d, 3, id)); id += 10; }
  const r = DR.fieldDays(f, '2026-02-15T00:00:00.000Z', NOW);
  eq(r.standing, 75); eq(r.baled, 32);
  eq(r.rows.length, 20); eq(r.far, { days: 5, n: 15 }); eq(r.rows[0].d, standDays[5]); eq(r.rows[19].d, standDays[24]);
  eq(r.bales.length, 14); eq(r.stack, { days: 2, n: 4 }); eq(r.bales[0].d, baledDays[2]);
  eq(r.pitch, 5);
});
t('fieldDays: row pitch 9 up to 12, tighter after', () => {
  let f = [];
  daysFrom('2026-03-01', 12).forEach((d, i) => { f = f.concat(dayFlags(d, 1, i * 10 + 1)); });
  eq(DR.fieldDays(f, null, NOW).pitch, 9);
  daysFrom('2026-03-13', 4).forEach((d, i) => { f = f.concat(dayFlags(d, 1, 500 + i * 10)); });
  eq(DR.fieldDays(f, null, NOW).pitch, 7);
});
t('fieldDays: a gap strip only past 7 days', () => {
  const f = [...dayFlags('2026-10-01', 1, 1), ...dayFlags('2026-10-08', 1, 2), ...dayFlags('2026-10-16', 1, 3)];
  eq(DR.fieldDays(f, null, NOW).rows.map((x) => x.gapBefore), [false, false, true]);
});
t('fieldDays: the tall burst needs 5 inside 20 minutes', () => {
  const four = [1, 2, 3, 4].map((i) => [i, '2026-11-14T09:0' + i + ':00-05:00', 'ai']);
  eq(DR.fieldDays(four, null, NOW).rows[0].tall, null);
  const five = four.concat([[5, '2026-11-14T09:20:00-05:00', 'ai']]);   // 09:01..09:20 = 19 minutes
  eq(DR.fieldDays(five, null, NOW).rows[0].tall, [0, 1, 2, 3, 4]);
  const spread = four.concat([[5, '2026-11-14T09:22:00-05:00', 'ai']]);   // 09:01..09:22 = 21 minutes
  eq(DR.fieldDays(spread, null, NOW).rows[0].tall, null);
});
t('fieldDays: only the tallest burst stands tall, across lanes', () => {
  const a = [0, 2, 4, 6, 8].map((m, i) => [i + 1, '2026-11-13T09:0' + m + ':00-05:00', 'ai']);
  const b = [0, 1, 2, 3, 4, 5].map((m, i) => [i + 10, '2026-11-14T14:0' + m + ':00-05:00', i % 2 ? 'macro' : 'physics']);
  const r = DR.fieldDays(a.concat(b), null, NOW);
  eq(r.rows[0].tall, null); eq(r.rows[1].tall, [0, 1, 2, 3, 4, 5]);
});
t('fieldDays: day is the first ten characters, not the UTC day', () => {
  const r = DR.fieldDays([[1, '2026-11-14T22:30:00-05:00', '']], null, NOW);
  eq(r.rows[0].d, '2026-11-14');
});
t('fieldDays: bad flags skipped', () => {
  const r = DR.fieldDays([null, [1], [2, 'not a date', ''], [3, 42, ''], 'x', [4, '2026-11-14T09:00:00-05:00', '']], null, NOW);
  eq(r.standing, 1);
});
t('fieldDays: a flag exactly at the cut is baled', () => {
  const r = DR.fieldDays([[1, '2026-11-10T23:30:00-05:00', ''], [2, '2026-11-10T23:30:01-05:00', '']], '2026-11-11T04:30:00.000Z', NOW);
  eq([r.standing, r.baled], [1, 1]);
});

/* ---------------- numbers and dates as words ---------------- */

const NUMS = [[0, 'zero'], [1, 'one'], [7, 'seven'], [11, 'eleven'], [13, 'thirteen'], [19, 'nineteen'], [20, 'twenty'],
  [21, 'twenty-one'], [55, 'fifty-five'], [99, 'ninety-nine'], [100, 'one hundred'], [101, 'one hundred one'],
  [110, 'one hundred ten'], [115, 'one hundred fifteen'], [999, 'nine hundred ninety-nine'], [1000, 'one thousand'],
  [1001, 'one thousand one'], [2026, 'two thousand twenty-six'], [21000, 'twenty-one thousand'],
  [100000, 'one hundred thousand'], [502000, 'five hundred two thousand'], [501609, 'five hundred one thousand six hundred nine'],
  [999999, 'nine hundred ninety-nine thousand nine hundred ninety-nine']];
for (const [n, w] of NUMS) t('num ' + n, () => eq(DR.num(n), w));
t('num out of range or not whole', () => { eq(DR.num(-1), '-1'); eq(DR.num(1000000), '1000000'); eq(DR.num(1.5), '1.5'); eq(DR.num(NaN), 'NaN'); });
const ORDS = [[1, 'first'], [2, 'second'], [3, 'third'], [4, 'fourth'], [5, 'fifth'], [8, 'eighth'], [9, 'ninth'], [11, 'eleventh'],
  [12, 'twelfth'], [14, 'fourteenth'], [20, 'twentieth'], [21, 'twenty-first'], [22, 'twenty-second'], [23, 'twenty-third'],
  [30, 'thirtieth'], [31, 'thirty-first'], [100, 'one hundredth']];
for (const [n, w] of ORDS) t('ordinal ' + n, () => eq(DR.ordinal(n), w));
t('sayValue share', () => {
  eq(DR.sayValue(55.5, 'ism_new_orders'), 'fifty-five point five');
  eq(DR.sayValue(55, 'ism_new_orders'), 'fifty-five');
  eq(DR.sayValue(55.04, 'ism_new_orders'), 'fifty-five');
  eq(DR.sayValue(47.96, 'ism_new_orders'), 'forty-eight');
  eq(DR.sayValue(24.2, 'btos_ai_use'), 'twenty-four point two');
  eq(DR.sayValue(100, 'btos_ai_use'), 'one hundred');
  eq(DR.sayValue(0.3, 'btos_ai_use'), 'zero point three');
  eq(DR.sayValue(55.5, DR.series('ism_new_orders')), 'fifty-five point five');
});
t('sayValue applications: nearest thousand', () => {
  eq(DR.sayValue(501609, 'bfs_applications'), 'about five hundred two thousand');
  eq(DR.sayValue(501499, 'bfs_applications'), 'about five hundred one thousand');
  eq(DR.sayValue(1234567, 'bfs_applications'), 'about one million two hundred thirty-five thousand');
  eq(DR.sayValue(1999600, 'bfs_applications'), 'about two million');
});
t('sayValue power price in cents', () => {
  eq(DR.sayValue(0.19, 'bls_power_price'), 'nineteen cents a kilowatt hour');
  eq(DR.sayValue(0.196, 'bls_power_price'), 'nineteen point six cents a kilowatt hour');
  eq(DR.sayValue(0.1, 'bls_power_price'), 'ten cents a kilowatt hour');
  eq(DR.sayValue(1.234, 'bls_power_price'), 'one hundred twenty-three point four cents a kilowatt hour');
});
t('sayValue not a number', () => eq(DR.sayValue(null, 'ism_new_orders'), 'no number'));
t('showValue', () => {
  eq(DR.showValue(55.5, 'ism_new_orders'), '55.5'); eq(DR.showValue(55, 'ism_new_orders'), '55.0');
  eq(DR.showValue(501609, 'bfs_applications'), '501,609'); eq(DR.showValue(1234567, 'bfs_applications'), '1,234,567');
  eq(DR.showValue(0.19, 'bls_power_price'), '19.0¢'); eq(DR.showValue(0.196, 'bls_power_price'), '19.6¢');
  eq(DR.showValue(24.25, 'btos_ai_use'), '24.3'); eq(DR.showValue(null, 'btos_ai_use'), '');
});
t('levelMove', () => {
  eq(DR.levelMove(533627, 501609), { dir: 'DOWN', pct: 6, text: 'DOWN 6.0%' });
  eq(DR.levelMove(100, 110), { dir: 'UP', pct: 10, text: 'UP 10.0%' });
  eq(DR.levelMove(100, 100), { dir: 'EVEN', pct: 0, text: 'EVEN' });
  eq(DR.levelMove(0.19, 0.196).text, 'UP 3.2%');
  eq(DR.levelMove(0, 5), null); eq(DR.levelMove(null, 5), null);
});
t('levelMove: a print that moved never reads EVEN (SPEC 15.15)', () => {
  eq(DR.levelMove(501609, 501800), { dir: 'UP', pct: 0, text: 'UP <0.1%' });
  eq(DR.levelMove(501800, 501609), { dir: 'DOWN', pct: 0, text: 'DOWN <0.1%' });
  eq(DR.levelMove(501609, 501609), { dir: 'EVEN', pct: 0, text: 'EVEN' });
});
t('periodLabel', () => { eq(DR.periodLabel('2026-11'), 'NOV 2026'); eq(DR.periodLabel('2027-01'), 'JAN 2027'); eq(DR.periodLabel('202617'), '202617'); eq(DR.periodLabel(null), ''); });
t('dateLabel', () => { eq(DR.dateLabel('2026-12-01'), 'DEC 1'); eq(DR.dateLabel('2027-01-04'), 'JAN 4'); eq(DR.dateLabel('2026-11-30'), 'NOV 30'); eq(DR.dateLabel(''), ''); });
t('sayDate', () => { eq(DR.sayDate('2026-12-01'), 'December first'); eq(DR.sayDate('2026-11-14'), 'November fourteenth'); eq(DR.sayDate('2026-10-31'), 'October thirty-first'); eq(DR.sayDate('x'), ''); });

/* ---------------- lines ---------------- */

const all = [];
const L = (s) => { all.push(s); return s; };
t('lines.notch', () => {
  eq(L(DR.lines.notch(true, ['UP', 'DOWN'], 4, 6)), 'Up. Four of six.');
  eq(L(DR.lines.notch(false, ['UP', 'DOWN'], 3, 7)), 'Down. Three of seven.');
  eq(L(DR.lines.notch(true, ['YES', 'NO'], 1, 1)), 'Yes. One of one.');
  eq(L(DR.lines.notch(false, ['YES', 'NO'], 0, 1)), 'No. Zero of one.');
});
const MR = RND({ aim: { after: '2026-10', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' } });
t('lines.read: the spec example', () => eq(L(DR.lines.read(MR, {}, NOW)), 'Orders up or down? Seven of eleven up. Print December first, by rule.'));
t('lines.read: confirmed date', () => eq(L(DR.lines.read({ ...MR, aim: { ...MR.aim, conf: 'confirmed' } }, {}, NOW)), 'Orders up or down? Seven of eleven up. Print December first.'));
t('lines.read: in', () => eq(L(DR.lines.read(MR, { ism_new_orders: [P('2026-11', 55.5)] }, NOW)), "Orders up or down? Seven of eleven up. Print's in."));
t('lines.read: no date says nothing after the read', () => eq(L(DR.lines.read({ ...MR, aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' } }, {}, NOW)), 'Orders up or down? Seven of eleven up.'));
t('lines.read: no docks', () => eq(L(DR.lines.read({ ...MR, u: 0, n: 0 }, {}, NOW)), 'Orders up or down? No docks yet. Print December first, by rule.'));
t('lines.read: late', () => eq(L(DR.lines.read(MR, {}, '2026-12-03T15:00:00.000Z')), 'Orders up or down? Seven of eleven up. Print was due December first, by rule.'));
t('lines.read: A.I. question', () => eq(L(DR.lines.read(RND({ lane: 'ai', twin: 'btos_ai_use', say: 'anybody here using A.I. for real?', words: ['YES', 'NO'], u: 2, n: 3, aim: { after: '', period: '', label: '', date: '', time_et: '', conf: 'none' } }), {}, NOW)), 'Anybody here using A.I. for real? Two of three yes.'));
t('lines.read: only yours', () => {
  eq(L(DR.lines.read({ ...OWNR('2026-12-20'), u: 2, n: 5 }, {}, NOW)), 'Anybody here own any crypto? Two of five yes. This one is only yours. The rail closes December twentieth.');
  eq(L(DR.lines.read({ ...OWNR('2026-11-20'), u: 2, n: 5 }, {}, NOW)), 'Anybody here own any crypto? Two of five yes. This one is only yours. The rail is due.');
});
t('lines.read: no round', () => eq(L(DR.lines.read(null, {}, NOW)), 'No question open.'));
const pr = (v, s = 'ism_new_orders') => ({ series: s, period: '2026-11', label: 'NOV 2026', value: v, by: 'fetch' });
t('lines.printIn: share, outside the beam', () => eq(L(DR.lines.printIn(MR, pr(45))), "Print's in. Forty-five. Your docks: seven of eleven up. Outside your beam. Their question, their mouths. Call the next one."));
t('lines.printIn: share, inside the beam', () => eq(L(DR.lines.printIn(MR, pr(55.5))), "Print's in. Fifty-five point five. Your docks: seven of eleven up. Inside your beam. Their question, their mouths. Call the next one."));
t('lines.printIn: level, no beam sentence', () => eq(L(DR.lines.printIn(RND({ lane: 'nextgen', twin: 'bfs_applications', words: ['YES', 'NO'], u: 3, n: 4 }), pr(501609, 'bfs_applications'))), "Print's in. About five hundred two thousand. Your docks: three of four yes. Different yardstick. Call the next one."));
t('lines.printIn: power price', () => eq(L(DR.lines.printIn(RND({ lane: 'physics', twin: 'bls_power_price', u: 1, n: 2 }), pr(0.196, 'bls_power_price'))), "Print's in. Nineteen point six cents a kilowatt hour. Your docks: one of two up. Different yardstick. Call the next one."));
t('lines.printIn: no docks', () => eq(L(DR.lines.printIn({ ...MR, u: 0, n: 0 }, pr(55.5))), "Print's in. Fifty-five point five. No docks this round. Call the next one."));
t('lines.noDocks', () => eq(L(DR.lines.noDocks(pr(55.5))), "Print's in. Fifty-five point five. No docks this round. Call the next one."));
t('lines.ownClose', () => {
  eq(L(DR.lines.ownClose({ ...OWNR('2026-12-01'), u: 7, n: 11 })), "No print for this one. It's only yours. Seven of eleven yes. What did the docks tell you?");
  eq(L(DR.lines.ownClose({ ...OWNR('2026-12-01'), u: 0, n: 0 })), "No print for this one. It's only yours. No docks this round. What did the docks tell you?");
});
t('lines.yours', () => eq(L(DR.lines.yours()), "That one's yours."));
const FLAGOFFER = { lane: 'ai', q: 'ANYBODY HERE USING AI FOR REAL?', say: 'anybody here using A.I. for real?', words: ['YES', 'NO'], twin: null, origin: 'flags', from: { day: '2026-11-14', taps: 11, minutes: 20 } };
t('lines.turn: the spec example', () => eq(L(DR.lines.turn(FLAGOFFER)), "Field's cut. Next lane, A.I. Tallest in A.I.: the fourteenth, eleven taps in twenty minutes. Dock question: anybody here using A.I. for real? Take it?"));
t('lines.offer: canon has no Tallest sentence', () => eq(L(DR.lines.offer(DR.offers('physics', {})[0])), 'Next lane, macro. Dock question: orders up or down? Take it?'));
t('lines.offer: second offer in the same lane skips Next lane', () => {
  const o = DR.offers('macro', PROPS);
  eq(L(DR.lines.offer(o[1], o[0])), 'Tallest in A.I.: the fourteenth, eleven taps in twenty minutes. Dock question: any agents on the dock? Take it?');
  eq(L(DR.lines.offer(o[2], o[1])), 'Next lane, next gen. Dock question: know anybody who started a business this year? Take it?');
});
t('lines.heard', () => {
  eq(L(DR.lines.heard('A data center is a token factory')), 'The gist: A data center is a token factory.');
  eq(L(DR.lines.heard('AI agents write most of the tokens.')), 'The gist: A.I. agents write most of the tokens.');
});
t('every line: AI is written A.I., no digits, beam words only', () => {
  ok(all.length > 20, 'lines collected ' + all.length);
  for (const s of all) {
    ok(!/\bAI\b/.test(s), 'bare AI in ' + s);
    ok(!/\d/.test(s), 'digit in ' + s);
    ok(!/agree|wrong/i.test(s), 'banned beam word in ' + s);
    const beam = s.match(/[^.?]*beam[^.?]*\./g) || [];
    for (const b of beam) ok(b.trim() === 'Inside your beam.' || b.trim() === 'Outside your beam.', 'beam sentence ' + b);
  }
});

/* ---------------- purity: no DOM, storage, network, timers ---------------- */

t('core.js stays pure', () => {
  const src = fs.readFileSync(path.join(SHELL, 'js', 'core.js'), 'utf8');
  for (const bad of ['document.', 'localStorage', 'indexedDB', 'fetch(', 'XMLHttpRequest', 'setTimeout', 'setInterval', 'innerHTML', 'navigator.', 'WebSocket']) {
    ok(src.indexOf(bad) < 0, 'found ' + bad);
  }
});

t('in a browser it hangs on window.DR and never replaces it', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(SHELL, 'js', 'core.js'), 'utf8');
  const win = { DR: { kept: 1 } };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx);
  ok(win.DR.kept === 1, 'existing DR replaced');
  ok(typeof win.DR.reduce === 'function' && typeof win.DR.lines.read === 'function', 'API missing');
  const win2 = {}; win2.window = win2;
  vm.runInContext(src, vm.createContext(win2));
  ok(win2.DR && typeof win2.DR.validate === 'function', 'DR not created');
});

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
