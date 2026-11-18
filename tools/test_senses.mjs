// Tests for shell/js/geo.js, shell/js/sound.js and shell/places.json (SPEC 9.4, 9.8, 9.10a, 9.11, 9.12).
// Node, no packages. Each test loads the scripts into a fresh vm context with hand-written fakes
// (geolocation, permissions, mediaDevices, MediaRecorder, AudioContext with a scriptable analyser,
// speechSynthesis, DR.store) and a virtual clock. Uncaught errors are fatal.
// Run: node shell/tools/test_senses.mjs   -> one line per failure, a count, exit 1 on any failure.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const GEO_SRC = fs.readFileSync(path.join(SHELL, 'js', 'geo.js'), 'utf8');
const SOUND_SRC = fs.readFileSync(path.join(SHELL, 'js', 'sound.js'), 'utf8');
const PLACES_TEXT = fs.readFileSync(path.join(SHELL, 'places.json'), 'utf8');
const PLACES = JSON.parse(PLACES_TEXT);

process.on('uncaughtException', (e) => { console.log('FATAL uncaught: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('FATAL unhandled rejection: ' + (e && e.stack || e)); process.exit(1); });

let passed = 0, failed = 0;
function fail(name, msg) { failed++; console.log('FAIL ' + name + ': ' + msg); }
async function t(name, fn) {
  try { const r = await fn(); if (r === false) fail(name, 'returned false'); else passed++; }
  catch (e) { fail(name, e && e.message ? e.message : String(e)); }
}
function ok(c, what) { if (!c) throw new Error(what || 'not true'); }
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what ? what + ': ' : '') + 'got ' + sa + ' want ' + sb);
}

/* ---------------- the fake world ---------------- */

const T0 = 1763380000000;

function makeEnv(o = {}) {
  const env = {
    clock: T0, timers: [], nextId: 1,
    logs: [], sounds: [], buzzes: [], spoken: [], cancels: 0, acCount: 0, ac: null,
    perm: Object.assign({ geolocation: 'granted', microphone: 'granted' }, o.perm || {}),
    voices: o.voices || [],
    speechAutoEndMs: o.speechAutoEndMs === undefined ? 500 : o.speechAutoEndMs,
    geoCalls: [], watchCalls: [], clearWatches: [], geoImpl: null, watchCb: null,
    gum: [], gumImpl: null, devices: o.devices || [], tracksStopped: 0, streams: [],
    recorders: [], opus: o.opus === undefined ? true : o.opus,
    levelAt: () => 0.005, liveAt: null, analysers: 0,
    clipCalls: [], clipImpl: null, line: o.line || 'none', clipDur: 1.0,
    srcStarts: 0, srcStops: 0, fetches: [], vis: [],
    srcNoEnd: !!o.srcNoEnd,          // a buffer source whose onended never fires
    recStall: o.recStall || null,    // 'data': stop() gives data but no onstop; 'none': neither
  };

  function setTimeout_(fn, ms) { const id = env.nextId++; env.timers.push({ id, at: env.clock + Math.max(0, ms | 0), fn, every: 0 }); return id; }
  function setInterval_(fn, ms) { const id = env.nextId++; const e = Math.max(1, ms | 0); env.timers.push({ id, at: env.clock + e, fn, every: e }); return id; }
  function clear_(id) { env.timers = env.timers.filter((x) => x.id !== id); }
  env.setTimeout = setTimeout_;

  class FDate extends Date {
    constructor(...a) { if (a.length === 0) super(env.clock); else super(...a); }
    static now() { return env.clock; }
  }

  const spyConsole = {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) spyConsole[k] = (...a) => env.logs.push([k, a]);

  // --- audio ---
  function param() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }; }
  class FakeAC {
    constructor() { env.acCount++; env.ac = this; this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 8000; this.destination = { dest: true }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      const n = { kind: 'osc', type: '', frequency: param(), connect() {}, onended: null,
        start() { env.sounds.push({ kind: 'osc', type: n.type, f: n.frequency._f }); },
        stop() {} };
      const fr = n.frequency; fr.setValueAtTime = (v) => { fr._f = v; };
      return n;
    }
    createGain() { return { gain: param(), connect() {} }; }
    createBiquadFilter() { return { type: '', frequency: param(), connect() {} }; }
    createBuffer(ch, n) { return { getChannelData: () => new Float32Array(n) }; }
    createBufferSource() {
      const n = { kind: 'src', buffer: null, onended: null, stopped: false, connect() {},
        start() {
          env.srcStarts++;
          env.sounds.push({ kind: 'src', clip: !!(n.buffer && n.buffer.clip) });
          const d = n.buffer && typeof n.buffer.duration === 'number' ? n.buffer.duration : 0.05;
          if (!env.srcNoEnd) setTimeout_(() => { if (!n.stopped) { n.stopped = true; if (n.onended) n.onended(); } }, d * 1000);
        },
        stop() { if (n.stopped) return; n.stopped = true; env.srcStops++; if (n.onended && !env.srcNoEnd) n.onended(); } };
      return n;
    }
    decodeAudioData(buf) { return Promise.resolve({ clip: true, duration: env.clipDur, bytes: buf.byteLength }); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      env.analysers++; env.liveAt = env.clock;
      return { fftSize: 2048, getFloatTimeDomainData(a) { a.fill(env.levelAt(env.clock - env.liveAt)); } };
    }
  }

  class Utter { constructor(text) { this.text = text; this.voice = null; this.onend = null; this.onerror = null; } }
  const speechSynthesis = {
    getVoices: () => env.voices,
    speak(u) { env.spoken.push(u); if (env.speechAutoEndMs !== null) setTimeout_(() => { if (u.onend) u.onend(); }, env.speechAutoEndMs); },
    cancel() { env.cancels++; },
    addEventListener() {},
  };

  // --- microphone ---
  function makeStream() {
    const tr = { stopped: false, stop() { if (!tr.stopped) { tr.stopped = true; env.tracksStopped++; } } };
    const s = { tracks: [tr], getTracks: () => [tr] };
    env.streams.push(s);
    return s;
  }
  class FakeRecorder {
    static isTypeSupported(m) { return env.opus && m === 'audio/webm;codecs=opus'; }
    constructor(stream, opts) { this.stream = stream; this.opts = opts; this.mimeType = opts.mimeType; this.state = 'inactive'; env.recorders.push(this); }
    start() { this.state = 'recording'; this.startedAt = env.clock; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive'; this.stoppedAt = env.clock;
      Promise.resolve().then(() => {
        if (env.recStall === 'none') return;
        if (this.ondataavailable) this.ondataavailable({ data: new Blob(['x'.repeat(300)]) });
        if (this.onstop && env.recStall !== 'data') this.onstop();
      });
    }
  }
  const mediaDevices = {
    enumerateDevices: () => Promise.resolve(env.devices),
    getUserMedia(c) { env.gum.push(JSON.parse(JSON.stringify(c))); return env.gumImpl ? env.gumImpl(c, env.gum.length) : Promise.resolve(makeStream()); },
  };
  env.makeStream = makeStream;

  // --- location ---
  const geolocation = {
    getCurrentPosition(ok, err, opts) { env.geoCalls.push(opts); if (env.geoImpl) env.geoImpl(ok, err, opts); },
    watchPosition(ok, err, opts) { env.watchCalls.push(opts); env.watchCb = ok; return 77; },
    clearWatch(id) { env.clearWatches.push(id); },
  };

  const document = {
    hidden: false, visibilityState: 'visible', listeners: [],
    addEventListener(type, fn) { document.listeners.push([type, fn]); },
  };
  env.document = document;
  env.hide = () => { document.hidden = true; document.visibilityState = 'hidden'; document.listeners.filter((l) => l[0] === 'visibilitychange').forEach((l) => l[1]()); };
  env.show = () => { document.hidden = false; document.visibilityState = 'visible'; document.listeners.filter((l) => l[0] === 'visibilitychange').forEach((l) => l[1]()); };

  const store = o.noStore ? undefined : {
    line: () => env.line,
    voiceClip(text, waitMs) { env.clipCalls.push([text, waitMs]); return env.clipImpl ? env.clipImpl(text, waitMs) : Promise.resolve(null); },
  };

  const sb = {
    console: spyConsole, Date: FDate, Blob, Math, JSON,
    setTimeout: setTimeout_, clearTimeout: clear_, setInterval: setInterval_, clearInterval: clear_,
    navigator: { vibrate: (p) => { env.buzzes.push(p); return true; },
      permissions: { query: (d) => Promise.resolve({ state: env.perm[d.name] }) },
      mediaDevices, geolocation },
    document,
    AudioContext: FakeAC, MediaRecorder: FakeRecorder,
    speechSynthesis, SpeechSynthesisUtterance: Utter,
    fetch: (url, init) => { env.fetches.push([url, init]); return Promise.resolve({ ok: true, json: () => Promise.resolve(o.places || JSON.parse(PLACES_TEXT)) }); },
    DR: store ? { store } : {},
  };
  sb.window = sb;
  vm.createContext(sb);
  env.sb = sb;
  env.startKeys = new Set(Object.keys(sb));
  if (o.geo !== false) vm.runInContext(GEO_SRC, sb, { filename: 'geo.js' });
  if (o.sound !== false) vm.runInContext(SOUND_SRC, sb, { filename: 'sound.js' });
  env.DR = sb.DR;

  env.flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  env.advance = async (ms) => {
    const end = env.clock + ms;
    await env.flush();
    for (;;) {
      const due = env.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      env.clock = due.at;
      if (due.every) due.at += due.every; else env.timers = env.timers.filter((x) => x !== due);
      due.fn();
      await env.flush();
    }
    env.clock = end;
    await env.flush();
  };
  return env;
}

// Watches a promise without awaiting it.
function watch(p) { const w = { done: false, value: undefined }; p.then((v) => { w.done = true; w.value = v; }); return w; }

const SMALL = { v: 1, source: 'test', licence: 'not recorded', rows: [
  ['AAA', 'IL', 4000, -9000, 0],
  ['BBB', 'IL', 4030, -9000, 0],   // 33.4 km north of AAA
  ['CCC', 'IL', 4040, -9000, 0],   // 44.5 km
  ['DDD', 'IN', 4000, -8960, 0],   // 34.1 km east
] };

/* ---------------- places.json ---------------- */

const CITY_RE = /^[A-Z][A-Z .'-]{0,39}$/;
const ST_RE = /^[A-Z]{2}$/;

await t('places.json: header', () => {
  eq(Object.keys(PLACES).sort(), ['licence', 'rows', 'source', 'v']);
  eq(PLACES.v, 1); eq(PLACES.licence, 'public domain (U.S. Government work)');
  ok(typeof PLACES.source === 'string' && PLACES.source.length > 0, 'source');
  // Spelled in pieces so this file does not itself trip the public folder's own name check (SPEC 15.35).
  const NAMES = new RegExp(['Use' + 'rs/', 'bry' + 'an', 'hert' + 'zig', 'alma' + 'nac', 'theai' + 'trucker'].join('|'), 'i');
  ok(!NAMES.test(PLACES.source), 'source names no person, home path or project: ' + PLACES.source);
  eq(PLACES.source, 'U.S. Census Bureau, 2026 Gazetteer Files, Places (2026_Gaz_place_national.zip)');
  ok(Array.isArray(PLACES.rows) && PLACES.rows.length > 1000, 'rows ' + PLACES.rows.length);
  eq(PLACES.rows.filter((r) => r[1] === 'PR').length, 0, 'no Puerto Rico rows');
  eq(new Set(PLACES.rows.map((r) => r[1])).size, 51, 'the 50 states and DC');
});
await t('places.json: every row is a name, a state, two whole numbers and a radius; every name passes the city rule', () => {
  const bad = [];
  const seen = new Set();
  for (const r of PLACES.rows) {
    const good = Array.isArray(r) && r.length === 5 && typeof r[0] === 'string' && CITY_RE.test(r[0])
      && typeof r[1] === 'string' && ST_RE.test(r[1]) && Number.isInteger(r[2]) && Number.isInteger(r[3])
      && Math.abs(r[2]) <= 9000 && Math.abs(r[3]) <= 18000
      && Number.isInteger(r[4]) && r[4] >= 0 && r[4] <= 5000;
    if (!good) bad.push(r);
    const k = r[0] + '|' + r[1];
    if (seen.has(k)) bad.push(['dup', k]);
    seen.add(k);
  }
  ok(bad.length === 0, bad.length + ' bad rows, first ' + JSON.stringify(bad[0]));
  ok(seen.has('JOLIET|IL'), 'JOLIET IL present');
});

// SPEC 15.35: names that are facilities stay off the list. Real towns named CAMP, FORT, BARRACKS, ACADEMY,
// COLLEGE or UNIVERSITY PARK stay on it. This mirrors mkplaces.py FACILITY_RE; a row it catches is a failure.
const FACILITY_RE = new RegExp('\\b(?:' + ['AFB', 'AIR FORCE BASE', 'ARSENAL', 'NAVY YARD', 'NAVAL STATION',
  'NAVAL AIR STATION', 'NAVAL BASE', 'AIR STATION', 'PROVING GROUNDS?', 'SPACE CENTER', 'ARMY DEPOT',
  'ARMY AIRFIELD', 'ARMY AIR FIELD', 'ARMY AMMUNITION PLANT', 'JRB', 'MARINE CORPS', 'COAST GUARD',
  'AIR NATIONAL GUARD', 'ANGB', 'AAF',
  'AIR RESERVE BASE', 'CBC BASE', 'NAVAL ANACOST ANNEX', 'U S A F ACADEMY', 'ARMY MEDICAL CENTER',
  'BASE', 'HOUSING', 'NAVAL AIR FACILITY', 'NAVAL ACADEMY', 'AIR FORCE ACADEMY', 'HURLBURT FIELD',
  'ATTU STATION', 'EARECKSON STATION', 'KODIAK STATION', 'LEMOORE STATION', 'PENSACOLA STATION',
  'NEW ORLEANS STATION', 'MERIDIAN STATION', 'FALLON STATION', 'WHIDBEY ISLAND STATION',
  'ARB', 'MOBILE HOME PARK'].map((w) => w.replace(/ /g, '\\s+')).join('|') + ')\\b'
  // whole names only
  + '|^(?:' + ['BERRY COLLEGE', 'CROWN COLLEGE', 'RAMAPO COLLEGE OF NEW JERSEY', 'THE COLLEGE OF NEW JERSEY',
    'BARD COLLEGE', 'HAMILTON COLLEGE', 'MARIST COLLEGE', 'NAZARETH COLLEGE', 'ST. JOHN FISHER COLLEGE', 'SIENA COLLEGE',
    'VASSAR COLLEGE', 'HAVERFORD COLLEGE', 'MESSIAH COLLEGE', 'ST. VINCENT COLLEGE', 'ROCHESTER INSTITUTE OF TECHNOLOGY',
    'AIRPORT', 'RED DOG MINE'].map((w) => w.replace(/\./g, '\\.').replace(/ /g, '\\s+')).join('|') + ')$'
  // a campus: UNIVERSITY, a name ending in it, or UNIVERSITY OF / AT / -
  + '|(?:^|\\s)UNIVERSITY$|\\bUNIVERSITY(?:\\s+(?:OF|AT)\\s|-)', 'i');

// The same two lists as test_shell.py's FACILITY_DROP and FACILITY_KEEP.
const FACILITY_DROP = [
  'JOINT BASE', 'LACKLAND BASE', 'NAVY HOUSING', 'NAVAL AIR FACILITY', 'NAVAL ACADEMY', 'AIR FORCE ACADEMY',
  'HURLBURT FIELD', 'ATTU STATION', 'EARECKSON STATION', 'KODIAK STATION', 'LEMOORE STATION',
  'PENSACOLA STATION', 'NEW ORLEANS STATION', 'MERIDIAN STATION', 'FALLON STATION', 'WHIDBEY ISLAND STATION',
  'UNIVERSITY', 'STATE UNIVERSITY', 'UNIVERSITY OF VIRGINIA', 'UNIVERSITY AT BUFFALO', 'UNIVERSITY-PARKSIDE',
  'BERRY COLLEGE', 'CROWN COLLEGE', 'RAMAPO COLLEGE OF NEW JERSEY', 'THE COLLEGE OF NEW JERSEY', 'BARD COLLEGE',
  'HAMILTON COLLEGE', 'MARIST COLLEGE', 'NAZARETH COLLEGE', 'ST. JOHN FISHER COLLEGE', 'SIENA COLLEGE',
  'VASSAR COLLEGE', 'HAVERFORD COLLEGE', 'MESSIAH COLLEGE', 'ST. VINCENT COLLEGE',
  'ROCHESTER INSTITUTE OF TECHNOLOGY', 'AIRPORT', 'RED DOG MINE',
  'naval academy', 'Vassar College', 'State University', 'Airport',
  'PICATINNY ARSENAL', 'MARCH AIR RESERVE BASE', 'U S A F ACADEMY', 'TRIPLER ARMY MEDICAL CENTER',
  'MARCH ARB', 'ARB', 'PLANTATION MOBILE HOME PARK', 'Spring Drive Mobile Home Park',
];
const FACILITY_KEEP = [
  'UNIVERSITY PARK', 'UNIVERSITY HEIGHTS', 'UNIVERSITY CITY', 'UNIVERSITY PLACE', 'WEST UNIVERSITY PLACE',
  'UNIVERSITY GARDENS', 'UNIVERSITY CENTER', 'STATE COLLEGE', 'RUTHERFORD COLLEGE', 'YADKIN COLLEGE',
  'COLLEGE', 'COLLEGE STATION', 'COLLEGE PARK', 'INSTITUTE', 'NAVY', 'NAPIER FIELD', 'HUNTINGTON STATION',
  'SUFFIELD DEPOT', 'SUSQUEHANNA DEPOT', 'ANNEX', 'AIRPORT DRIVE', 'SCHOFIELD BARRACKS', 'CARLISLE BARRACKS',
  'FORT WORTH', 'FORT BRAGG', 'CAMP VERDE', 'CAMP LEJEUNE', 'QUANTICO', 'WEST POINT', 'BASEHOR',
  'LITTLE RIVER-ACADEMY', 'ACADEMY', 'ARMY', 'BERRY', 'AIRPORT HEIGHTS', 'RED DOG', 'SAAFB',
  'MOBILE', 'ANN ARBOR', 'HARBOR', 'ARBUCKLE', 'HOME', 'MOBILE HOME', 'HOMEPARK',
];

await t('places.json: no facility rows; real towns with base words stay', () => {
  const hits = PLACES.rows.filter((r) => FACILITY_RE.test(r[0])).map((r) => r[0] + '|' + r[1]);
  eq(hits, [], 'facility rows');
  const keys = new Set(PLACES.rows.map((r) => r[0] + '|' + r[1]));
  const names = new Set(PLACES.rows.map((r) => r[0]));
  eq(FACILITY_DROP.filter((n) => !FACILITY_RE.test(n)), [], 'the rule refuses');
  eq(FACILITY_KEEP.filter((n) => FACILITY_RE.test(n)), [], 'the rule keeps');
  eq(FACILITY_DROP.filter((n) => names.has(n.toUpperCase())), [], 'no refused name is a row');
  // Every kept name that is a real place in the Census file, in every state it is one.
  for (const k of ['UNIVERSITY PARK|IA', 'UNIVERSITY PARK|IL', 'UNIVERSITY PARK|MD', 'UNIVERSITY PARK|NM',
    'UNIVERSITY PARK|TX', 'UNIVERSITY HEIGHTS|IA', 'UNIVERSITY HEIGHTS|OH', 'UNIVERSITY CITY|MO', 'UNIVERSITY PLACE|WA',
    'WEST UNIVERSITY PLACE|TX', 'UNIVERSITY GARDENS|NY', 'UNIVERSITY CENTER|VA', 'STATE COLLEGE|PA',
    'RUTHERFORD COLLEGE|NC', 'YADKIN COLLEGE|NC', 'COLLEGE|AK', 'COLLEGE STATION|AR', 'COLLEGE STATION|TX',
    'COLLEGE PARK|GA', 'COLLEGE PARK|MD', 'INSTITUTE|WV', 'NAVY|VA', 'NAPIER FIELD|AL', 'HUNTINGTON STATION|NY',
    'SUFFIELD DEPOT|CT', 'SUSQUEHANNA DEPOT|PA', 'ANNEX|OR', 'AIRPORT DRIVE|MO', 'SCHOFIELD BARRACKS|HI',
    'CARLISLE BARRACKS|PA', 'QUANTICO|MD', 'QUANTICO|VA', 'WEST POINT|NY', 'BASEHOR|KS', 'LITTLE RIVER-ACADEMY|TX',
    'FORT WORTH|TX', 'CAMP VERDE|AZ', 'MOBILE|AL', 'ANN ARBOR|MI']) ok(keys.has(k), k + ' kept');
  ok(PLACES.rows.filter((r) => /^FORT /.test(r[0])).length > 100 && PLACES.rows.filter((r) => /^CAMP /.test(r[0])).length > 10,
    'FORT and CAMP towns kept');
  // The rows the Census file needs a reviewed name or a folded letter for, and towns the other tests lean on.
  for (const k of ['INDIANAPOLIS|IN', 'NASHVILLE|TN', 'LOUISVILLE|KY', 'LEXINGTON|KY', 'ATHENS|GA', 'AUGUSTA|GA',
    'MACON|GA', 'BUTTE|MT', 'ANACONDA|MT', 'VENTURA|CA', 'PASO ROBLES|CA', 'ANCHORAGE|AK', 'JUNEAU|AK',
    'CARSON CITY|NV', 'PRINCETON|NJ', 'ST. LOUIS|MO', "O'FALLON|MO", "COEUR D'ALENE|ID", 'WINSTON-SALEM|NC',
    'CANON CITY|CO', 'JOLIET|IL', 'CREST HILL|IL', 'GARY|IN', 'PEORIA|IL', 'FORT WAYNE|IN']) ok(keys.has(k), k + ' present');
  ok(FACILITY_RE.test('PICATINNY ARSENAL') && FACILITY_RE.test('Washington Navy Yard') && FACILITY_RE.test('ABERDEEN PROVING GROUND'), 'the rule bites');
  // SPEC 15.53: five more facility names, any case.
  for (const n of ['MARCH AIR RESERVE BASE', 'PORT HUENEME CBC BASE', 'NAVAL ANACOST ANNEX', 'U S A F ACADEMY',
    'TRIPLER ARMY MEDICAL CENTER', 'march air reserve base', 'Tripler Army Medical Center']) ok(FACILITY_RE.test(n), n + ' refused');
  for (const k of ['MARCH AIR RESERVE BASE|CA', 'PORT HUENEME CBC BASE|CA', 'NAVAL ANACOST ANNEX|DC', 'U S A F ACADEMY|CO',
    'TRIPLER ARMY MEDICAL CENTER|HI']) ok(!keys.has(k), k + ' left out');
  for (const k of ['BASEHOR|KS', 'SCHOFIELD BARRACKS|HI']) ok(keys.has(k), k + ' kept');
  ok(!FACILITY_RE.test('ACADEMY') && !FACILITY_RE.test('ARMY') && !FACILITY_RE.test('ANNEX'), 'the five stay whole words');
  ok(!FACILITY_RE.test('BASEHOR') && !FACILITY_RE.test('FORT BRAGG') && !FACILITY_RE.test('NAVY TOWN') && !FACILITY_RE.test('SAAFB'), 'whole words only');
});
// Round two: CDPs that are a base, a campus, a work site, a mall, a resort, a club or a park. mkplaces.py drops
// each by state and exact Census name, because the same words name real towns elsewhere (the second list).
const ROUND_TWO_DROPPED = ['MARCH ARB|CA', 'DAHLGREN CENTER|VA', 'IROQUOIS POINT|HI', 'SUNY OSWEGO|NY',
  'PENN STATE BERKS|PA', 'MISSISSIPPI STATE|MS', 'NOTRE DAME|IN', 'STANFORD|CA', 'ST. BONAVENTURE|NY',
  'ST. MARY OF THE WOODS|IN', 'PRUDHOE BAY|AK', 'NAPI HEADQUARTERS|NM', 'NORTH LIGHT PLANT|NM',
  'WHITESTONE LOGGING CAMP|AK', 'WOODVILLE FARM LABOR CAMP|CA', 'CHERRY HILL MALL|NJ', 'ONE LOUDOUN|VA',
  'ENCORE AT MONROE|NJ', 'REGENCY AT MONROE|NJ', 'RENAISSANCE AT MONROE|NJ', 'PINE RIDGE AT CRESTWOOD|NJ',
  'ELDORADO AT SANTA FE|NM', 'HOMEWOOD AT MARTINSBURG|PA', 'SILVERADO RESORT|CA', 'WAIKOLOA BEACH RESORT|HI',
  'LELY RESORT|FL', 'VOLCANO GOLF COURSE|HI', 'BOYS RANCH|TX', 'KICKAPOO TRIBAL CENTER|KS', 'ELOHIM CITY|OK',
  'PINETOP COUNTRY CLUB|AZ', 'BAKERSFIELD COUNTRY CLUB|CA', 'LAKE ALMANOR COUNTRY CLUB|CA', 'BAYOU COUNTRY CLUB|LA',
  'CRYSTAL DOWNS COUNTRY CLUB|MI', 'PLANTATION MOBILE HOME PARK|FL', 'SPRING DRIVE MOBILE HOME PARK|PA',
  'LAKESHORE RESORT|IN',
  // found by the second checker: two malls, a business park, clubs, navy housing, labor camps, mobile parks
  'DULLES TOWN CENTER|VA', 'POTOMAC MILLS|VA', 'MCCLELLAN PARK|CA', 'GOVERNORS CLUB|NC',
  'CONNING TOWERS-NAUTILUS PARK|CT', 'COUNTY CENTER|VA', 'CANDLEWOOD LAKE CLUB|CT', 'LINNELL CAMP|CA',
  'RODRIGUEZ CAMP|CA', 'EL MONTE MOBILE VILLAGE|CA', 'ORANGE GROVE MOBILE MANOR|AZ'];
await t('places.json: round two (not towns by state and name; the common name; two centres)', () => {
  const at = new Map(PLACES.rows.map((r) => [r[0] + '|' + r[1], r]));
  eq(ROUND_TWO_DROPPED.length, 49);
  eq(ROUND_TWO_DROPPED.filter((k) => at.has(k)), [], 'not towns, still rows');
  for (const k of ['STANFORD|KY', 'COUNTRY CLUB|MO', 'GOLF|IL', "MORGAN'S POINT RESORT|TX", 'WORLD GOLF VILLAGE|FL',
    'KO OLINA|HI', 'LEISURE WORLD|MD', 'HONOLULU|HI', 'LOUISVILLE|KY', 'GEORGETOWN|GA']) ok(at.has(k), k + ' present');
  ok(!at.has('URBAN HONOLULU|HI'), 'URBAN HONOLULU is HONOLULU');
  eq(at.get('LOUISVILLE|KY').slice(2, 4), [3822, -8574], 'LOUISVILLE|KY is the city row');
  eq(at.get('GEORGETOWN|GA').slice(2, 4), [3198, -8123], 'GEORGETOWN|GA is the CDP by Savannah');
});
await t('places.json: rows sorted by state then name', () => {
  for (let i = 1; i < PLACES.rows.length; i++) {
    const a = PLACES.rows[i - 1], b = PLACES.rows[i];
    ok(a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]), 'out of order at ' + i + ': ' + a[0] + '|' + a[1] + ' then ' + b[0] + '|' + b[1]);
  }
});

/* ---------------- geo: the pure part ---------------- */

const GEO = require(path.join(SHELL, 'js', 'geo.js'));

await t('nearest: exported for Node, 40 km limit', () => {
  eq(GEO.LIMIT_KM, 40);
  eq(GEO.nearest(40, -90, SMALL.rows, 1), [{ city: 'AAA', st: 'IL' }]);
  // 38.9 km north of a lone town: in; 41.1 km: out
  const one = [['ONE', 'OH', 4000, -9000]];
  eq(GEO.nearest(40.35, -90, one, 1), [{ city: 'ONE', st: 'OH' }], '38.9 km');
  eq(GEO.nearest(40.37, -90, one, 1), [], '41.1 km');
  eq(GEO.nearest(30, -40, PLACES.rows, 1), [], 'mid-Atlantic');
});
await t('nearest: the k best, none past 40 km; downtown Joliet is JOLIET', () => {
  eq(GEO.nearest(40, -90, SMALL.rows, 5), [{ city: 'AAA', st: 'IL' }, { city: 'BBB', st: 'IL' }, { city: 'DDD', st: 'IN' }]);
  eq(GEO.nearest(40.29, -90, SMALL.rows, 2), [{ city: 'BBB', st: 'IL' }, { city: 'CCC', st: 'IL' }]);
  const r = GEO.nearest(41.5250, -88.0817, PLACES.rows, 5);
  ok(r.length === 5, 'five near Joliet'); eq(r[0], { city: 'JOLIET', st: 'IL' }, 'downtown Joliet');
  r.forEach((x) => eq(Object.keys(x), ['city', 'st']));
});

// The naming rule (SPEC 9.10a): towns whose circle holds the spot, smallest circle first; then towns the spot is
// just outside (d <= 1.25 r), by d / r; then the rest by distance. r = max(r10 / 10, 0.3) km. Made-up towns
// around (40, -90): one list unit is 1.112 km north-south and 0.852 km east-west there.
const names = (list) => list.map((x) => x.city + '|' + x.st);
await t('nearest rule 1: inside two circles, the smaller circle wins', () => {
  const list = [['BIG', 'IL', 4000, -9000, 100],      // 0 km away, 10 km circle
    ['SMALLER', 'IL', 4002, -9000, 30]];               // 2.2 km away, 3 km circle
  eq(names(GEO.nearest(40, -90, list, 5)), ['SMALLER|IL', 'BIG|IL']);
  // the same circle size: the nearer centre first
  const same = [['FARC', 'IL', 4002, -9000, 30], ['NEARC', 'IL', 4001, -9000, 30]];
  eq(names(GEO.nearest(40, -90, same, 5)), ['NEARC|IL', 'FARC|IL']);
});
await t('nearest rule 1: inside one circle beats a nearer centre whose circle does not hold the spot', () => {
  const list = [['NEAR', 'IL', 4001, -9000, 5],       // 1.1 km away, 0.5 km circle: d / r = 2.2
    ['WIDE', 'IL', 4003, -9000, 40]];                  // 3.3 km away, 4 km circle: holds the spot
  eq(names(GEO.nearest(40, -90, list, 5)), ['WIDE|IL', 'NEAR|IL']);
  eq(GEO.nearest(40, -90, list, 1), [{ city: 'WIDE', st: 'IL' }]);
});
await t('nearest rules 2 and 3: just outside by d / r, after every inside town; the rest by distance', () => {
  const list = [
    ['FAR', 'IL', 4000, -9003, 0],                    // 2.6 km, rule 3
    ['OUTA', 'IL', 4001, -9000, 10],                  // 1.11 km, 1 km circle: d / r = 1.11
    ['NEARP', 'IL', 4000, -9001, 1],                  // 0.85 km, 0.75 km floor: d / r = 1.13, the last of rule 2
    ['INSIDE', 'IL', 4005, -9000, 60],                // 5.6 km, 6 km circle: rule 1
    ['OUTB', 'IL', 4000, -9002, 16],                  // 1.70 km, 1.6 km circle: d / r = 1.065
    ['GONE', 'IL', 4040, -9000, 2000]];               // 44.5 km: past 40 km, whatever its size
  eq(names(GEO.nearest(40, -90, list, 10)), ['INSIDE|IL', 'OUTB|IL', 'OUTA|IL', 'NEARP|IL', 'FAR|IL']);
  eq(names(GEO.nearest(40, -90, list, 2)), ['INSIDE|IL', 'OUTB|IL'], 'k');
  eq(names(GEO.nearest(40, -90, list)), ['INSIDE|IL'], 'k defaults to 1');
  eq(names(GEO.nearest(40, -90, [['GONE', 'IL', 4040, -9000, 2000]], 3)), [], 'nothing past 40 km');
});
// The list keeps a centre to a hundredth of a degree, about a kilometre. A circle smaller than that could
// miss the town's own true centre, so no circle is smaller than 0.75 km.
await t('nearest: the smallest circle a town gets is 0.75 km', () => {
  const list = [['DOT', 'IL', 4000, -9000, 0], ['WIDE', 'IL', 4002, -9000, 40]];
  const north = (km) => 40 + km / 6371 * 180 / Math.PI;
  eq(names(GEO.nearest(north(0.6), -90, list, 5)), ['DOT|IL', 'WIDE|IL'], '0.6 km: inside the floor, the smaller');
  eq(names(GEO.nearest(north(0.9), -90, list, 5)), ['WIDE|IL', 'DOT|IL'], '0.9 km: just outside (1.2 r)');
  // a town with a little land (r10 5 = 0.5 km) gets the floor too: 0.6 km from it is still inside
  eq(names(GEO.nearest(north(0.6), -90, [['SMALL', 'IL', 4000, -9000, 5], ['WIDE', 'IL', 4002, -9000, 40]], 5)),
    ['SMALL|IL', 'WIDE|IL'], 'r10 5 uses the floor');
  // 1.2 km: DOT is past 1.25 r, so it is ranked by plain distance, after every town that holds the spot
  eq(names(GEO.nearest(north(1.2), -90, list, 5)), ['WIDE|IL', 'DOT|IL'], '1.2 km: past 1.25 r');
});
await t('nearest: ties by name, then state, in every group', () => {
  const at = (n, st, r10) => [n, st, 4000, -9000, r10];
  const want = ['AAA|IL', 'AAA|IN', 'BBB|IL'];
  eq(names(GEO.nearest(40, -90, [at('BBB', 'IL', 10), at('AAA', 'IN', 10), at('AAA', 'IL', 10)], 5)), want, 'inside');
  const off = (n, st) => [n, st, 4001, -9000, 9];   // 1.11 km away, 0.9 km circle: just outside
  eq(names(GEO.nearest(40, -90, [off('BBB', 'IL'), off('AAA', 'IN'), off('AAA', 'IL')], 5)), want, 'just outside');
  const far = (n, st) => [n, st, 4010, -9000, 0];
  eq(names(GEO.nearest(40, -90, [far('BBB', 'IL'), far('AAA', 'IN'), far('AAA', 'IL')], 5)), want, 'the rest');
});

// SPEC 9.10a on the real list: public city-centre points, where the city itself must come first.
const DOWNTOWNS = [['CHICAGO', 'IL', 41.8781, -87.6298], ['JOLIET', 'IL', 41.5250, -88.0817],
  ['KANSAS CITY', 'MO', 39.0997, -94.5786], ['COLUMBUS', 'OH', 39.9612, -82.9988], ['LOUISVILLE', 'KY', 38.2527, -85.7585],
  ['DENVER', 'CO', 39.7392, -104.9903], ['INDIANAPOLIS', 'IN', 39.7684, -86.1581], ['NASHVILLE', 'TN', 36.1627, -86.7816],
  ['HOUSTON', 'TX', 29.7604, -95.3698], ['DALLAS', 'TX', 32.7767, -96.7970], ['ATLANTA', 'GA', 33.7490, -84.3880],
  ['MEMPHIS', 'TN', 35.1495, -90.0490], ['ST. LOUIS', 'MO', 38.6270, -90.1994], ['OMAHA', 'NE', 41.2565, -95.9345],
  ['OKLAHOMA CITY', 'OK', 35.4676, -97.5164], ['PHOENIX', 'AZ', 33.4484, -112.0740], ['GARY', 'IN', 41.5934, -87.3464],
  ['PEORIA', 'IL', 40.6936, -89.5890], ['FORT WAYNE', 'IN', 41.0793, -85.1394], ['DETROIT', 'MI', 42.3314, -83.0458],
  ['JACKSONVILLE', 'FL', 30.3322, -81.6557], ['AUGUSTA', 'GA', 33.4735, -82.0105], ['ATHENS', 'GA', 33.9519, -83.3576],
  ['LEXINGTON', 'KY', 38.0406, -84.5037], ['MACON', 'GA', 32.8407, -83.6324], ['ANCHORAGE', 'AK', 61.2181, -149.9003],
  ['NEW YORK', 'NY', 40.7128, -74.0060], ['LOS ANGELES', 'CA', 34.0522, -118.2437], ['SAN ANTONIO', 'TX', 29.4241, -98.4936],
  ['CHARLOTTE', 'NC', 35.2271, -80.8431]];
// Suburbs and enclaves inside or beside a big city's circle: one km due east of each one's own centre, it keeps its name.
const ENCLAVES = ['CULVER CITY|CA', 'EDGEWATER|CO', 'TOLLESON|AZ', 'HAMTRAMCK|MI', 'BEVERLY HILLS|CA', 'CICERO|IL',
  'BEDFORD PARK|IL', 'ELWOOD|IL', 'ROCKDALE|IL', 'UNIVERSITY PARK|TX', 'BELLAIRE|TX', 'NORTH KANSAS CITY|MO',
  'VERNON|CA', 'COMMERCE|CA'];
function eastOf(key, km) {
  const r = PLACES.rows.find((x) => x[0] + '|' + x[1] === key);
  if (!r) throw new Error(key + ' is not a row');
  const lat = r[2] / 100;
  return [lat, r[3] / 100 + (km / 6371) * (180 / Math.PI) / Math.cos(lat * Math.PI / 180)];
}
await t('nearest on the real list: each of 30 downtowns names its own city first', () => {
  eq(DOWNTOWNS.length, 30);
  const wrong = DOWNTOWNS.map(([c, st, la, lo]) => [c + '|' + st, names(GEO.nearest(la, lo, PLACES.rows, 1))[0]])
    .filter(([want, got]) => want !== got);
  eq(wrong, [], 'downtowns named wrong');
});
await t('nearest on the real list: one km east of a suburb or enclave, the town itself comes first', () => {
  eq(ENCLAVES.length, 14);
  const wrong = ENCLAVES.map((k) => [k, names(GEO.nearest(...eastOf(k, 1), PLACES.rows, 1))[0]]).filter(([a, b]) => a !== b);
  eq(wrong, [], 'enclaves named wrong');
  // Glendale's own circle is 0.7 km, so a km east of its centre is past 1.25 r and inside Denver's circle.
  eq(GEO.nearest(...eastOf('GLENDALE|CO', 1), PLACES.rows, 1), [{ city: 'DENVER', st: 'CO' }], 'Glendale, CO');
});
await t('nearest: pure (rows untouched, bad input is empty)', () => {
  const before = JSON.stringify(SMALL.rows);
  GEO.nearest(40, -90, SMALL.rows, 3);
  eq(JSON.stringify(SMALL.rows), before);
  eq(GEO.nearest(NaN, -90, SMALL.rows, 1), []);
  eq(GEO.nearest(40, -90, null, 1), []);
});

/* ---------------- geo: the browser part ---------------- */

const LAT = 41.5251234, LON = -88.0816789;   // downtown Joliet, with distinctive digits to hunt for
const LEAK_RE = /41\.52|5251234|88\.08|816789|4152\d|-8808\d/;

function deepScan(v, seen = new Set(), depth = 0) {
  // every number and string reachable from v, functions skipped
  const out = [];
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === 'number' || typeof v === 'string') { out.push(String(v)); return out; }
  if (typeof v !== 'object') return out;
  if (seen.has(v)) return out;
  seen.add(v);
  if (v instanceof Set) { for (const x of v) out.push(...deepScan(x, seen, depth + 1)); return out; }
  for (const k of Object.keys(v)) { if (!Array.isArray(v)) out.push(k); out.push(...deepScan(v[k], seen, depth + 1)); }
  return out;
}
function noCoord(v, what) {
  for (const s of deepScan(v)) {
    if (LEAK_RE.test(s)) throw new Error(what + ' carries ' + s);
    const n = Number(s);
    if (Number.isFinite(n) && (Math.abs(n - LAT) < 0.5 || Math.abs(n - LON) < 0.5)) throw new Error(what + ' carries a coordinate-like ' + s);
  }
}

await t('geo: load, places, find', async () => {
  const env = makeEnv({ sound: false });
  await env.DR.geo.load();
  await env.DR.geo.load();
  eq(env.fetches.length, 1, 'places.json read once');
  eq(env.fetches[0][0], 'places.json');
  ok(env.DR.geo.places().has('JOLIET|IL'), 'set has JOLIET|IL');
  eq(env.DR.geo.places().size, PLACES.rows.length);
  const f = env.DR.geo.find('jol');
  ok(f.length >= 1 && f.length <= 8, 'at most 8: ' + f.length);
  ok(f.every((x) => x.city.indexOf('JOL') === 0), JSON.stringify(f));
  ok(f.some((x) => x.city === 'JOLIET' && x.st === 'IL'), 'JOLIET IL found');
  eq(env.DR.geo.find('SPRING').length, 8, 'capped at 8');
  eq(env.DR.geo.find(''), []);
});

await t('geo: load keeps only rows of five with a whole radius of 0 or more', async () => {
  const env = makeEnv({ sound: false, places: { v: 1, source: 'test', licence: 'not recorded', rows: [
    ['GOOD', 'IL', 4000, -9000, 0], ['WIDE', 'IL', 4001, -9000, 120],
    ['FOUR', 'IL', 4000, -9000], ['SIX', 'IL', 4000, -9000, 1, 1], ['NEG', 'IL', 4000, -9000, -1],
    ['HALF', 'IL', 4000, -9000, 1.5], ['TEXT', 'IL', 4000, -9000, '7'], ['NAN', 'IL', 4000, -9000, NaN],
    ['NUL', 'IL', 4000, -9000, null], ['HUGE', 'IL', 4000, -9000, 5001]] } });
  await env.DR.geo.load();
  eq([...env.DR.geo.places()], ['GOOD|IL', 'WIDE|IL']);
  eq(env.DR.geo.find('').length, 0);
  eq(env.DR.geo.find('W'), [{ city: 'WIDE', st: 'IL' }]);
});

await t('geo: town() not granted takes no fix and asks nothing', async () => {
  for (const s of ['prompt', 'denied', undefined]) {
    const env = makeEnv({ sound: false, perm: { geolocation: s } });
    env.geoImpl = () => { throw new Error('fix taken'); };
    const w = watch(env.DR.geo.town());
    await env.advance(10);
    ok(w.done && w.value === null, String(s) + ': ' + JSON.stringify(w.value));
    eq(env.geoCalls.length, 0, String(s) + ': getCurrentPosition called');
    const w2 = watch(env.DR.geo.towns(5));
    await env.advance(10);
    eq(w2.value, [], String(s) + ': towns');
    eq(env.geoCalls.length, 0);
  }
});

await t('geo: town() never leaks a coordinate', async () => {
  const env = makeEnv({ sound: false });
  const coords = { latitude: LAT, longitude: LON, accuracy: 12, speed: 0 };
  env.geoImpl = (okcb) => setTimeout(() => okcb({ coords, timestamp: env.clock }), 0);
  const p = env.DR.geo.town();
  // a thrown-away error path must not carry one either
  const res = await p;
  eq(res, { city: 'JOLIET', st: 'IL' }, 'nearest town');
  eq(Object.keys(res), ['city', 'st']);
  noCoord(res, 'the return value');
  const many = await env.DR.geo.towns(5);
  ok(many.length === 5, 'towns(5): ' + many.length);
  noCoord(many, 'towns()');
  noCoord(env.logs, 'console');
  eq(env.logs.length, 0, 'nothing logged');
  noCoord(env.geoCalls, 'the options handed to getCurrentPosition');
  noCoord(env.fetches, 'fetch');
  noCoord(env.timers.map((x) => x.at - env.clock), 'timers');
  // nothing new on the global, and DR holds no coordinate
  const newKeys = Object.keys(env.sb).filter((k) => !env.startKeys.has(k));
  eq(newKeys, [], 'new globals');
  noCoord(Object.fromEntries(Object.entries(env.DR).filter(([k]) => k !== 'geo')), 'DR');
  const g = env.DR.geo;
  eq(Object.keys(g).sort(), ['ask', 'find', 'guard', 'load', 'nearest', 'places', 'state', 'town', 'towns']);
  for (const k of Object.keys(g)) ok(typeof g[k] === 'function', k + ' is a function, not a value');
  // the place set holds towns only
  noCoord([...g.places()].slice(0, 50), 'places');
  ok(env.geoCalls[0].timeout === 8000, 'fix limit 8 s');
});

await t('geo: town() is null after 8 s with no fix, on an error, and with no town inside 40 km', async () => {
  let env = makeEnv({ sound: false });
  env.geoImpl = () => {};   // never answers
  let w = watch(env.DR.geo.town());
  await env.advance(7990);
  ok(!w.done, 'still waiting at 7.99 s');
  await env.advance(20);
  ok(w.done && w.value === null, 'null at 8 s');
  env = makeEnv({ sound: false });
  env.geoImpl = (okcb, err) => err({ code: 3, message: 'timeout at ' + LAT });
  w = watch(env.DR.geo.town());
  await env.advance(1);
  ok(w.done && w.value === null, 'error: null');
  eq(env.logs.length, 0, 'the error is not logged');
  env = makeEnv({ sound: false });
  env.geoImpl = (okcb) => okcb({ coords: { latitude: 30, longitude: -40, speed: null } });
  w = watch(env.DR.geo.town());
  await env.advance(1);
  ok(w.done && w.value === null, 'mid-Atlantic: null');
});

await t('geo: ask() is the one that may prompt', async () => {
  let env = makeEnv({ sound: false, perm: { geolocation: 'prompt' } });
  env.geoImpl = (okcb) => okcb({ coords: { latitude: LAT, longitude: LON } });
  let r = await env.DR.geo.ask();
  eq(r, 'granted'); eq(env.geoCalls.length, 1);
  env = makeEnv({ sound: false, perm: { geolocation: 'prompt' } });
  env.geoImpl = (okcb, err) => err({ code: 1 });
  r = await env.DR.geo.ask();
  eq(r, 'denied');
  eq(await env.DR.geo.state(), 'prompt');
  env = makeEnv({ sound: false, perm: { geolocation: 'weird' } });
  eq(await env.DR.geo.state(), 'unknown');
});

await t('geo: guard only when granted and only at speed', async () => {
  let env = makeEnv({ sound: false, perm: { geolocation: 'prompt' } });
  let hits = 0;
  env.DR.geo.guard(() => hits++);
  await env.advance(10);
  eq(env.watchCalls.length, 0, 'no watch without the grant');
  eq(env.geoCalls.length, 0, 'no fix without the grant');

  env = makeEnv({ sound: false });
  const args = [];
  const stop = env.DR.geo.guard((...a) => { hits++; args.push(a); });
  ok(typeof stop === 'function', 'returns stop()');
  await env.advance(10);
  eq(env.watchCalls.length, 1, 'watching');
  hits = 0;
  const read = (speed) => env.watchCb({ coords: { latitude: LAT, longitude: LON, speed } });
  read(null); read(0); read(5); read(6.69);
  eq(hits, 0, 'below 6.7 m/s');
  read(6.7); eq(hits, 1, 'at 6.7');
  read(20); eq(hits, 2, 'above');
  args.forEach((a) => eq(a.length, 0, 'onMoving gets nothing'));
  stop();
  eq(env.clearWatches, [77]);
  read(30); eq(hits, 2, 'after stop');

  env = makeEnv({ sound: false });
  const s2 = env.DR.geo.guard(() => {});
  s2();   // stopped before the permission answered
  await env.advance(10);
  eq(env.watchCalls.length, 0, 'stopped early: no watch');
});

/* ---------------- sound: nothing before unlock, nothing when muted ---------------- */

const LOCAL = { name: 'Local', localService: true, lang: 'en-US' };
const NET = { name: 'Net', localService: false, lang: 'en-US' };

function allSounds(S) { S.tick(); S.bell(); S.click(); S.knock(); S.breath(); S.swish(); S.buzz([30, 40, 30]); }

await t('sound: nothing sounds before unlock()', async () => {
  const env = makeEnv({ geo: false, voices: [LOCAL] });
  env.clipImpl = () => Promise.resolve(new ArrayBuffer(8));
  const S = env.DR.sound;
  allSounds(S);
  await S.say('Orders up or down?');
  await S.play(new Blob(['abc']), { maxMs: 4000 });
  await env.advance(3000);
  eq(env.sounds, [], 'sounds'); eq(env.buzzes, [], 'buzz'); eq(env.spoken.length, 0, 'speech');
  eq(env.acCount, 0, 'no AudioContext made'); eq(env.clipCalls.length, 0, 'no clip asked');
});

await t('sound: the recipes after unlock, one context', async () => {
  const env = makeEnv({ geo: false });
  const S = env.DR.sound;
  S.unlock();
  eq(env.acCount, 1); eq(env.ac.state, 'running', 'resumed in the tap');
  S.bell();
  eq(env.sounds.map((s) => s.f), [196, 392], 'bell 196 + 392');
  env.sounds = [];
  S.tick(); ok(env.sounds.length === 2, 'tick = noise + tone');
  S.click(); S.knock(); S.breath(); S.swish();
  ok(env.sounds.length === 2 + 1 + 2 + 1 + 1, 'all recipes sounded: ' + env.sounds.length);
  S.buzz([90]); eq(env.buzzes, [[90]]);
  S.unlock(); eq(env.acCount, 1, 'unlock again: same context');
});

await t('sound: muted means silent; mute persists until unmuted', async () => {
  const env = makeEnv({ geo: false, voices: [LOCAL] });
  const S = env.DR.sound;
  S.unlock(); S.mute(true);
  ok(S.muted() === true, 'muted()');
  allSounds(S);
  await S.say('hello there');
  await S.play(new Blob(['abc']), {});
  eq(env.sounds, []); eq(env.buzzes, []); eq(env.spoken.length, 0);
  S.mute(false); ok(S.muted() === false);
  S.click(); eq(env.sounds.length, 1, 'sounds again');
});

await t('sound: a hidden page ends the visit; a new tap is needed', async () => {
  const env = makeEnv({ geo: false });
  const S = env.DR.sound;
  S.unlock(); env.hide(); S.tick(); env.show(); S.tick();
  eq(env.sounds, [], 'hidden, then back without a tap');
  S.unlock(); S.tick(); ok(env.sounds.length === 2, 'after a tap');
});

/* ---------------- sound: say's order ---------------- */

await t('say step 1: a cached clip plays at once (no line: cache only)', async () => {
  const env = makeEnv({ geo: false, voices: [LOCAL], line: 'none' });
  env.clipImpl = (text, wait) => Promise.resolve(new ArrayBuffer(16));
  const S = env.DR.sound; S.unlock();
  const w = watch(S.say('Up.  Four of six.'));
  await env.advance(10);
  eq(env.clipCalls, [['Up. Four of six.', 0]], 'asked the cache only');
  eq(env.sounds.filter((s) => s.clip).length, 1, 'clip playing');
  eq(env.spoken.length, 0, 'no phone voice');
  ok(!w.done, 'resolves when the clip ends');
  await env.advance(1000);
  ok(w.done, 'resolved at the clip end');
});

await t('say step 2: line home, a clip inside 2.5 s plays', async () => {
  const env = makeEnv({ geo: false, voices: [LOCAL], line: 'home' });
  env.clipImpl = () => new Promise((r) => env.setTimeout(() => r(new ArrayBuffer(16)), 2000));
  const S = env.DR.sound; S.unlock();
  const w = watch(S.say('Orders up or down?'));
  await env.advance(10);
  eq(env.clipCalls[0][1], 2500, 'waitMs 2500');
  await env.advance(2000);
  eq(env.sounds.filter((s) => s.clip).length, 1, 'home clip played');
  eq(env.spoken.length, 0);
  await env.advance(1000);
  ok(w.done);
});

await t('say: a late home answer is cached, not played; the phone voice speaks', async () => {
  const env = makeEnv({ geo: false, voices: [NET, LOCAL], line: 'home', speechAutoEndMs: 700 });
  const cache = new Map();
  env.clipImpl = (text) => {
    if (cache.has(text)) return Promise.resolve(cache.get(text));
    return new Promise((r) => env.setTimeout(() => { cache.set(text, new ArrayBuffer(16)); r(new ArrayBuffer(16)); }, 3000));
  };
  const S = env.DR.sound; S.unlock();
  const w = watch(S.say('Seven of eleven up.'));
  await env.advance(2490);
  eq(env.spoken.length, 0, 'still waiting on home at 2.49 s');
  await env.advance(20);
  eq(env.spoken.length, 1, 'phone voice at 2.5 s');
  eq(env.spoken[0].voice.name, 'Local', 'the local voice');
  await env.advance(1000);
  ok(cache.has('Seven of eleven up.'), 'the late answer was cached');
  eq(env.sounds.filter((s) => s.clip).length, 0, 'and never played');
  ok(w.done, 'resolved on onend');
  // next time it is a cache hit and plays at once
  const w2 = watch(S.say('Seven of eleven up.'));
  await env.advance(5);
  eq(env.sounds.filter((s) => s.clip).length, 1, 'cached clip plays');
  await env.advance(1000); ok(w2.done);
});

await t('say step 3: only a local voice; resolves on onend or after 1 s + 0.4 s a word', async () => {
  let env = makeEnv({ geo: false, voices: [NET, { name: 'Fr', localService: true, lang: 'fr-FR' }, LOCAL], line: 'none', speechAutoEndMs: null });
  const S = env.DR.sound; S.unlock();
  const w = watch(S.say('one two three four five'));
  await env.advance(1);
  eq(env.spoken.length, 1); eq(env.spoken[0].voice.name, 'Local');
  ok(env.cancels >= 1, 'queue cleared before speaking');
  await env.advance(2900);
  ok(!w.done, 'not before 3 s (5 words)');
  await env.advance(150);
  ok(w.done, 'resolved by the word timer');

  env = makeEnv({ geo: false, voices: [NET], line: 'none' });
  env.DR.sound.unlock();
  const w3 = watch(env.DR.sound.say('Nothing to say here'));
  await env.advance(1);
  ok(w3.done, 'resolves'); eq(env.spoken.length, 0, 'no local voice: silence');

  env = makeEnv({ geo: false, voices: [LOCAL], noStore: true });
  env.DR.sound.unlock();
  const w4 = watch(env.DR.sound.say('No store here'));
  await env.advance(1000);
  eq(env.spoken.length, 1, 'no DR.store = no line: the phone voice'); ok(w4.done);
});

await t('hush: cancels the clip path and the voice path, and resolves say', async () => {
  let env = makeEnv({ geo: false, voices: [LOCAL], line: 'none' });
  env.clipImpl = () => Promise.resolve(new ArrayBuffer(16));
  let S = env.DR.sound; S.unlock();
  let w = watch(S.say('a clip'));
  await env.advance(10);
  eq(env.srcStarts, 1, 'clip started');
  S.hush();
  await env.advance(1);
  ok(w.done, 'say resolved on hush'); eq(env.srcStops, 1, 'source stopped'); ok(env.cancels >= 1, 'speech cancelled too');

  env = makeEnv({ geo: false, voices: [LOCAL], line: 'none', speechAutoEndMs: null });
  S = env.DR.sound; S.unlock();
  w = watch(S.say('a long line said by the phone'));
  await env.advance(10);
  eq(env.spoken.length, 1);
  const c0 = env.cancels;
  S.hush();
  await env.advance(1);
  ok(w.done, 'say resolved on hush'); ok(env.cancels > c0, 'speechSynthesis.cancel');

  env = makeEnv({ geo: false, voices: [LOCAL], line: 'home' });
  env.clipImpl = () => new Promise((r) => env.setTimeout(() => r(new ArrayBuffer(16)), 1000));
  S = env.DR.sound; S.unlock();
  w = watch(S.say('waiting on home'));
  await env.advance(100);
  S.hush();
  await env.advance(1);
  ok(w.done, 'resolved at once while waiting on home');
  await env.advance(3000);
  eq(env.srcStarts, 0, 'the clip that came later never played'); eq(env.spoken.length, 0, 'nor the voice');

  env = makeEnv({ geo: false, voices: [LOCAL], line: 'none', speechAutoEndMs: null });
  S = env.DR.sound; S.unlock();
  w = watch(S.say('muted mid line'));
  await env.advance(10);
  const c1 = env.cancels;
  S.mute(true);
  await env.advance(1);
  ok(w.done && env.cancels > c1, 'MUTED stops the voice');
});

await t('warm: fetches ahead only with a line, quietly', async () => {
  let env = makeEnv({ geo: false, line: 'none' });
  env.DR.sound.warm(['a', 'b']);
  eq(env.clipCalls.length, 0, 'no line: nothing');
  env = makeEnv({ geo: false, line: 'home' });
  env.clipImpl = () => Promise.reject(new Error('down'));
  env.DR.sound.warm(['Up. Five of seven.', 'Down. Four of seven.']);
  await env.advance(10);
  eq(env.clipCalls.map((c) => c[0]), ['Up. Five of seven.', 'Down. Four of seven.']);
  eq(env.sounds, [], 'warm makes no sound'); eq(env.acCount, 0);
});

await t('play: his breath through the same context, cut at maxMs', async () => {
  const env = makeEnv({ geo: false });
  env.clipDur = 10;
  const S = env.DR.sound; S.unlock();
  const w = watch(S.play(new Blob(['breath bytes']), { maxMs: 4000 }));
  await env.advance(10);
  eq(env.acCount, 1, 'one context'); eq(env.srcStarts, 1);
  await env.advance(3980);
  ok(!w.done, 'playing');
  await env.advance(20);
  ok(w.done, 'cut at 4 s'); eq(env.srcStops, 1);
});

/* ---------------- the microphone ---------------- */

function speechEnv(levelAt, o = {}) {
  const env = makeEnv(Object.assign({ geo: false }, o));
  env.levelAt = levelAt;
  return env;
}
// Runs one record() to its end (or maxWait) and reports when it ended, measured from the stream going live.
async function runRecord(env, opts = {}, maxWait = 30000) {
  const w = watch(env.DR.sound.record(opts));
  let waited = 0;
  while (!w.done && waited < maxWait) { await env.advance(50); waited += 50; }
  const rec = env.recorders[0];
  return { w, rec, endT: rec && rec.stoppedAt !== undefined ? rec.stoppedAt - env.liveAt : null };
}
const speakAt = (from, to, lv = 0.2, floor = 0.01) => (t) => (t >= from && t < to ? lv : floor);

await t('record: null unless the mic is already granted, and no stream opened', async () => {
  for (const s of ['prompt', 'denied', undefined]) {
    const env = speechEnv(speakAt(1000, 2000), { perm: { microphone: s } });
    const r = await runRecord(env);
    ok(r.w.done && r.w.value === null, String(s));
    eq(env.gum.length, 0, String(s) + ': getUserMedia called');
  }
});

await t('record: constraints, the Speakerphone pick, the recorder format', async () => {
  const env = speechEnv(speakAt(1000, 2000), { devices: [
    { kind: 'audioinput', label: 'Built-in Microphone', deviceId: 'mic0' },
    { kind: 'audiooutput', label: 'Speakerphone out', deviceId: 'out1' },
    { kind: 'audioinput', label: 'Speakerphone', deviceId: 'spk1' }] });
  const r = await runRecord(env);
  eq(env.gum, [{ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, deviceId: { ideal: 'spk1' } } }]);
  eq(r.rec.opts, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
  ok(r.w.value && r.w.value.mime === 'audio/webm;codecs=opus', 'mime');
  ok(r.w.value.blob instanceof Blob && r.w.value.blob.size > 0, 'blob');
  eq(env.recorders.length, 1, 'one recorder per breath');
});

await t('record: no Speakerphone = default; audio/mp4 when opus is not supported', async () => {
  const env = speechEnv(speakAt(1000, 2000), { opus: false, devices: [{ kind: 'audioinput', label: 'Built-in', deviceId: 'm' }] });
  const r = await runRecord(env);
  eq(env.gum, [{ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } }]);
  eq(r.rec.opts.mimeType, 'audio/mp4'); eq(r.w.value.mime, 'audio/mp4');
});

await t('record: a constraint error retries once with the default', async () => {
  const env = speechEnv(speakAt(1000, 2000), { devices: [{ kind: 'audioinput', label: 'Speakerphone', deviceId: 'spk1' }] });
  env.gumImpl = (c, i) => i === 1 ? Promise.reject(Object.assign(new Error('x'), { name: 'OverconstrainedError' })) : Promise.resolve(env.makeStream());
  const r = await runRecord(env);
  eq(env.gum.length, 2);
  eq(env.gum[0].audio.deviceId, { ideal: 'spk1' });
  eq(env.gum[1], { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } });
  ok(r.w.value !== null, 'recorded on the retry');

  const env2 = speechEnv(speakAt(1000, 2000));
  env2.gumImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotReadableError' }));
  const r2 = await runRecord(env2);
  ok(r2.w.done && r2.w.value === null, 'other errors: null'); eq(env2.gum.length, 1, 'no retry');
});

await t('gate: speech then 1.4 s of quiet ends it; the stream stops at the end', async () => {
  const env = speechEnv(speakAt(1000, 3000));
  const levels = [];
  const r = await runRecord(env, { onLevel: (x) => levels.push(x) });
  ok(r.w.value, 'kept');
  ok(r.endT >= 4400 && r.endT <= 4450, 'ended at ' + r.endT);
  ok(r.w.value.ms >= 4400 && r.w.value.ms <= 4450, 'ms ' + r.w.value.ms);
  eq(env.tracksStopped, 1, 'stream stopped');
  ok(levels.length > 0 && levels.every((x) => x >= 0 && x <= 1), 'onLevel 0..1');
  ok(levels.some((x) => x > 0.5), 'loud above the gate');
});

await t('gate: short gaps under 1.4 s do not end it', async () => {
  const env = speechEnv((t) => ((t >= 1000 && t < 2000) || (t >= 3000 && t < 4000) ? 0.2 : 0.01));
  const r = await runRecord(env);
  ok(r.w.value && r.endT >= 5400 && r.endT <= 5450, 'ended at ' + r.endT);
});

await t('gate: speech must hold 250 ms to start', async () => {
  let env = speechEnv(speakAt(1000, 1200));
  let r = await runRecord(env);
  ok(r.w.done && r.w.value === null, '200 ms blip: nothing kept');
  ok(r.endT >= 6000 && r.endT <= 6050, 'gave up at 6 s: ' + r.endT);
  eq(env.tracksStopped, 1, 'stream stopped');
  env = speechEnv(speakAt(1000, 1300));
  r = await runRecord(env);
  ok(r.w.value, '300 ms: kept');
  ok(r.endT >= 2700 && r.endT <= 2750, 'ended 1.4 s after: ' + r.endT);
});

await t('gate: the first 300 ms are ignored and the floor comes from the next 300', async () => {
  // loud only in the ignored window: nothing
  let env = speechEnv((t) => (t < 300 ? 0.9 : 0.01));
  let r = await runRecord(env);
  ok(r.w.done && r.w.value === null, 'ignored window');
  // a noisy floor (0.1 -> gate 0.22) hides a 0.15 voice
  env = speechEnv((t) => (t >= 300 && t < 600 ? 0.1 : t >= 1000 && t < 3000 ? 0.15 : 0.01));
  r = await runRecord(env);
  ok(r.w.value === null, 'under 2.2 x floor');
  // a quiet floor: the gate is the 0.03 minimum
  env = speechEnv(speakAt(1000, 3000, 0.035, 0.001));
  r = await runRecord(env);
  ok(r.w.value, 'just above the 0.03 minimum');
  env = speechEnv(speakAt(1000, 3000, 0.029, 0.001));
  r = await runRecord(env);
  ok(r.w.value === null, 'just under the 0.03 minimum');
});

await t('gate: nobody speaks = nothing kept; openMs is his', async () => {
  let env = speechEnv(() => 0.01);
  let r = await runRecord(env);
  ok(r.w.done && r.w.value === null && env.tracksStopped === 1, 'silence');
  env = speechEnv(speakAt(7000, 8000));
  r = await runRecord(env, { openMs: 8000 });
  ok(r.w.value, 'starts at 7 s inside an 8 s window');
  env = speechEnv(speakAt(7000, 8000));
  r = await runRecord(env);
  ok(r.w.value === null, 'not inside the default 6 s');
});

await t('gate: 20 s cap', async () => {
  const env = speechEnv((t) => (t >= 1000 ? 0.2 : 0.01));
  const r = await runRecord(env, {}, 40000);
  ok(r.w.value, 'kept');
  ok(r.endT >= 21000 && r.endT <= 21050, 'cut at 20 s of speech: ' + r.endT);
});

await t('record: a hidden page or cancelRecord throws it away and stops the stream', async () => {
  let env = speechEnv((t) => (t >= 1000 ? 0.2 : 0.01));
  let w = watch(env.DR.sound.record({}));
  await env.advance(2000);
  env.hide();
  await env.advance(100);
  ok(w.done && w.value === null, 'hidden: null'); eq(env.tracksStopped, 1, 'stream stopped');

  env = speechEnv((t) => (t >= 1000 ? 0.2 : 0.01));
  w = watch(env.DR.sound.record({}));
  await env.advance(2000);
  env.DR.sound.cancelRecord();
  await env.advance(10);
  ok(w.done && w.value === null, 'cancelled: null'); eq(env.tracksStopped, 1);
  await env.advance(30000);
  eq(env.recorders.length, 1);
});

/* ---------------- SPEC 15.6 and 15.7: raw takes, hard limits, things that never report back ---------------- */

await t('record raw: no gate; speech from the first instant still gives about 2 s', async () => {
  const env = speechEnv(() => 0.2);   // he is already talking when the stream opens
  const r = await runRecord(env, { raw: true, maxMs: 2000 });
  ok(r.w.value, 'kept');
  ok(r.rec.stoppedAt - r.rec.startedAt >= 2000 && r.rec.stoppedAt - r.rec.startedAt <= 2050, 'recorded ' + (r.rec.stoppedAt - r.rec.startedAt));
  ok(r.w.value.ms >= 2000 && r.w.value.ms <= 2050, 'ms ' + r.w.value.ms);
  ok(r.w.value.blob instanceof Blob && r.w.value.blob.size > 0, 'blob');
  eq(r.w.value.mime, 'audio/webm;codecs=opus');
  eq(env.tracksStopped, 1, 'stream stopped');
});
await t('record raw: a loud idle cab and silence are kept alike', async () => {
  for (const lv of [0.6, 0.0]) {
    const env = speechEnv(() => lv);
    const r = await runRecord(env, { raw: true, maxMs: 2000 });
    ok(r.w.value && r.w.value.ms >= 2000 && r.w.value.ms <= 2050, 'level ' + lv + ': ' + JSON.stringify(r.w.value && r.w.value.ms));
  }
});
await t('record raw: null unless granted; cancelRecord and a hidden page throw it away', async () => {
  for (const s of ['prompt', 'denied', undefined]) {
    const env = speechEnv(() => 0.2, { perm: { microphone: s } });
    const r = await runRecord(env, { raw: true, maxMs: 2000 });
    ok(r.w.done && r.w.value === null, String(s)); eq(env.gum.length, 0, String(s) + ': no stream');
  }
  let env = speechEnv(() => 0.2);
  let w = watch(env.DR.sound.record({ raw: true, maxMs: 2000 }));
  await env.advance(1000);
  env.DR.sound.cancelRecord();
  await env.advance(10);
  ok(w.done && w.value === null, 'cancelled: null'); eq(env.tracksStopped, 1);
  env = speechEnv(() => 0.2);
  w = watch(env.DR.sound.record({ raw: true, maxMs: 2000 }));
  await env.advance(1000);
  env.hide();
  await env.advance(100);
  ok(w.done && w.value === null, 'hidden: null'); eq(env.tracksStopped, 1);
});
await t('record: never longer than 29.5 s from the recorder start', async () => {
  // a late start inside a long window plus a long maxMs would run past it
  let env = speechEnv((t) => (t >= 15000 ? 0.2 : 0.01));
  let r = await runRecord(env, { openMs: 20000, maxMs: 20000 }, 60000);
  ok(r.w.value, 'kept');
  let len = r.rec.stoppedAt - r.rec.startedAt;
  ok(len >= 29500 && len <= 29550, 'gated: stopped at ' + len);
  ok(r.w.value.ms <= 29550, 'ms ' + r.w.value.ms);
  // raw asks for a minute
  env = speechEnv(() => 0.2);
  r = await runRecord(env, { raw: true, maxMs: 60000 }, 70000);
  len = r.rec.stoppedAt - r.rec.startedAt;
  ok(r.w.value && len >= 29500 && len <= 29550, 'raw: stopped at ' + len);
  // a window longer than the limit with nobody speaking: nothing, at the limit
  env = speechEnv(() => 0.01);
  r = await runRecord(env, { openMs: 40000 }, 60000);
  len = r.rec.stoppedAt - r.rec.startedAt;
  ok(r.w.value === null && len >= 29500 && len <= 29550, 'silence: gave up at ' + len);
});
await t('record: a recorder that never reports its stop resolves 2 s later with what it gathered', async () => {
  let env = speechEnv(speakAt(1000, 3000), { recStall: 'data' });
  let r = await runRecord(env);
  ok(r.w.done && r.w.value && r.w.value.blob.size > 0, 'the gathered chunks: ' + JSON.stringify(r.w.value && r.w.value.ms));
  eq(env.tracksStopped, 1, 'stream stopped');
  env = speechEnv(speakAt(1000, 3000), { recStall: 'none' });
  const w = watch(env.DR.sound.record({}));
  await env.advance(4400 + 1900);
  ok(!w.done, 'still waiting 1.9 s after stop');
  await env.advance(200);
  ok(w.done && w.value === null, 'no chunks: null, 2 s after stop');
  eq(env.tracksStopped, 1, 'stream stopped');
  env = speechEnv(() => 0.2, { recStall: 'none' });
  r = await runRecord(env, { raw: true, maxMs: 2000 });
  ok(r.w.done && r.w.value === null, 'raw, no chunks: null');
});
await t('say: a clip whose end is never reported resolves at its length + 500 ms', async () => {
  const env = makeEnv({ geo: false, voices: [LOCAL], line: 'none', srcNoEnd: true });
  env.clipImpl = () => Promise.resolve(new ArrayBuffer(16));
  env.clipDur = 1.0;
  const S = env.DR.sound; S.unlock();
  const w = watch(S.say('Up. Four of six.'));
  await env.advance(10);
  eq(env.srcStarts, 1, 'clip started');
  await env.advance(1470);
  ok(!w.done, 'not before 1.5 s');
  await env.advance(40);
  ok(w.done, 'resolved by the timer');
});
await t('play: a clip whose end is never reported resolves at its length + 500 ms (or maxMs, sooner)', async () => {
  let env = makeEnv({ geo: false, srcNoEnd: true });
  env.clipDur = 2.0;
  let S = env.DR.sound; S.unlock();
  let w = watch(S.play(new Blob(['breath']), { maxMs: 4000 }));
  await env.advance(10);
  await env.advance(2470);
  ok(!w.done, 'not before 2.5 s');
  await env.advance(40);
  ok(w.done, 'resolved at 2.5 s');
  env = makeEnv({ geo: false, srcNoEnd: true });
  env.clipDur = 10;
  S = env.DR.sound; S.unlock();
  w = watch(S.play(new Blob(['breath']), { maxMs: 4000 }));
  await env.advance(4010);
  ok(w.done, 'maxMs still cuts first');
});

await t('askMic: the prompt, closed at once', async () => {
  let env = makeEnv({ geo: false, perm: { microphone: 'prompt' } });
  eq(await env.DR.sound.micState(), 'prompt');
  eq(await env.DR.sound.askMic(), 'granted');
  eq(env.gum.length, 1); eq(env.tracksStopped, 1, 'stream closed');
  env = makeEnv({ geo: false, perm: { microphone: 'prompt' } });
  env.gumImpl = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
  eq(await env.DR.sound.askMic(), 'denied');
});

await t('sound: the public names', () => {
  const env = makeEnv({ geo: false });
  eq(Object.keys(env.DR.sound).sort(), ['askMic', 'bell', 'breath', 'buzz', 'cancelRecord', 'click', 'hush', 'knock',
    'micState', 'mute', 'muted', 'play', 'record', 'say', 'swish', 'tick', 'unlock', 'warm']);
});

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
