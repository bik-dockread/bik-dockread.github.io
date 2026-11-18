/* DOCK READ app: the conductor (SPEC 9.3 to 9.10).
   Everything he does goes through here: the two modes, a dock, the moment, the turn, the cards,
   connect, sync and the service worker. It decides; DR.surface draws; DR.store keeps; DR.sound and
   DR.geo sense. One function (view) builds what is drawn, from DR.reduce over the book, home's State
   and the mode. Nothing else decides what is drawn.

   Rules this file keeps:
   - Every event is made with DR.event, checked with DR.validate (with the town list) and written with
     DR.store.add. An event that fails validation is never written: one console line, no content.
   - Every spoken line comes from DR.lines, but one: the newest-print line of a late moment (15.13) is built
     here from DR.sayValue until core carries it. Every plate text is built from core's helpers.
   - ONE FLOW AT A TIME: while a dock, a moment, a turn or a recording runs, the dial, the rail and the
     stage do nothing, and a 'change' from the store is held and drawn when the flow ends.
   - Cab law: ROLLING is one tap (the read) or nothing. PARKED only by his tap on the lever; it falls back
     by itself. Permissions are asked only from the line card.
   - No markup strings, no style strings. This file never touches the page itself except to listen. */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;
  var DR = G.DR || (G.DR = {});

  /* ---------- named constants ---------- */

  var IDLE_MS = 60000;              // PARKED falls back after this long with no touch (9.3)
  var HOLD_MS = 5 * 60000;          // an overlay or a flow waiting on him holds PARKED at most this long
  var HIDDEN_MS = 2 * 60000;        // hidden this long: ROLLING
  var FRESH_MS = 60000;             // the freshest cut can be flipped or pulled for this long (9.3)
  var DOCK_DRAIN_MS = 8000;         // the dock's halves drain (9.4)
  var MOVE_DRAIN_MS = 8000;         // POSITION / MONEY / HELP drain (9.5 step 8)
  var VOICE_CAP_MS = 4000;          // the breath opens when the voice ends or this long after the thumb
  var DOCK_OPEN_MS = 6000;          // he has this long to start talking after a dock (9.4)
  var BREATH_MAX_MS = 20000;        // a breath is cut at this length
  var WHY_OPEN_MS = 8000;           // the call's WHY (9.5 step 7)
  var STEP_MAX_MS = 380;            // retrace: min(0.38 s, 8 s / n) a notch (9.5 step 3)
  var RETRACE_MS = 8000;
  var RETRACE_BREATHS = 3;          // the newest breaths stored here that play in the retrace
  var RETRACE_PLAY_MS = 4000;
  var LEVEL_BEAT_MS = 1400;         // a level print reads, then its move
  var CHECK_MS = 2000;              // MIC CHECK records about two seconds
  var UNKEPT_MS = 4000;             // NOT KEPT ON THIS PHONE holds the plate this long
  var PLAY_MAX_MS = 30000;
  var UPDATE_MS = 3600000;          // the worker is checked hourly
  var CLOCK_OFF_MIN = 10;
  var OWN_MAX = 48;                 // his own question, at most (9.6)
  var TOWNS_K = 5;
  var MOVES = ['position', 'money', 'help'];
  var MOVE_BANDS = ['POSITION', 'MONEY', 'HELP'];
  var TURN_BANDS = ['TAKE IT', 'NEXT', 'MY OWN'];
  var PAIR_BANDS = ['UP / DOWN', 'YES / NO'];
  var Q_RE = /^[A-Z0-9 ?'\-,.]{3,60}$/;
  var LINE_WORD = { home: 'HOME', none: 'NO LINE', unset: 'NOT SET' };
  var MARK_ORDER = ['needle', 'figure', 'beam', 'hand', 'bridge', 'arrow', 'bezel', 'tag', 'retrace', 'plate'];
  var UNKEPT = 'NOT KEPT ON THIS PHONE';
  var NO_BOOK = 'THIS PHONE WOULD NOT OPEN ITS BOOK';
  var NOT_HERE = 'NOT ON THIS PHONE';
  var WHY_UNKEPT = 'YOUR WHY WAS NOT KEPT';
  var SYNCING = 'SYNCING YOUR BOOK';

  var A = {
    mode: 'ROLLING',
    events: [], st: null, series: {}, home: null, prefs: { muted: false, towns: false, guard: true, setup: false },
    flow: null,            // {kind, dead} while a dock, moment, turn or recording runs
    held: false,           // a store change arrived during a flow
    marks: {},             // the moment's pieces drawn directly, replayed after a render
    recording: false,
    callWait: null,        // round id whose NEXT PRINT? halves he left (9.5 step 6)
    freshCut: false,       // the next offer is the first after a cut
    offerIdx: 0, offerAfter: undefined,
    groundAlt: false,
    tackRefs: [],
    lastTouch: 0, idleT: null, hiddenAt: 0, hiddenT: null,   // on mono()
    lastTouchWall: 0, hiddenWall: 0,                         // the same moments on the wall clock (15.39)
    swallow: false,        // the touch that rolled an overdue PARKED: its tap does nothing (15.39)
    turnWait: false,       // PARKED wanted the turn before the first sync; it opens when the sync lands
    unkept: false, unkeptT: null,
    noBook: false, noBookShown: false,   // a standing state, not a passing note: every write fails with it
    writing: 0,            // writes in flight; the idle reload waits for them
    guardStop: null,
    wake: { lock: null, want: false, asking: false },
    graded: {}, aimed: {},
    syncOk: false, lastSync: 0, note: '',
    partial: false,        // the last sync left pages at home: nothing is graded, aimed or opened on it (15.23)
    syncs: 0,              // whole syncs answered this launch
    handSync: {},          // 'series period' -> syncs when he typed it here (15.14)
    sw: { reg: null, reload: false, version: '' },
    opening: false, booted: false
  };

  /* ---------- small helpers ---------- */

  function S() { return DR.surface; }
  function iso() { return DR.nowIso(); }
  function nowMs() { return Date.now(); }
  // A wall clock set back by hand or by the network would hold PARKED for as long as it moved.
  function mono() {
    var p = G.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }
  // And performance.now() stands still while the phone sleeps. Time since a moment is the larger of the
  // two clocks' answers, so neither a clock stepped back nor a sleep can hold PARKED (15.39).
  function elapsed(atMono, atWall) { return Math.max(mono() - atMono, nowMs() - atWall); }
  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function wait(ms) { return new Promise(function (r) { G.setTimeout(r, ms); }); }
  function log(msg) { try { G.console.warn('dockread: ' + msg); } catch (e) { /* nothing */ } }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayOf(at) { var t = Date.parse(at); return isFinite(t) ? ymd(new Date(t)) : ''; }
  function clockOf(ms) {
    var d = new Date(ms);
    return DR.dateLabel(ymd(d)) + ' ' + d.getHours() + ':' + pad2(d.getMinutes());
  }
  function count(n) { return DR.showValue(num(n) ? n : 0, { decimals: 0 }); }
  function hiddenPage() {
    var d = G.document;
    return !!(d && (d.hidden || d.visibilityState === 'hidden'));
  }
  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  function setPref(k, v) {
    var p = DR.store.setPref(k, v);
    if (isObj(p)) A.prefs = p;
    return A.prefs;
  }

  /* ---------- the book: write, recompute ---------- */

  function placesSet() {
    var p = safe(function () { return DR.geo && DR.geo.places ? DR.geo.places() : null; });
    return p && typeof p.has === 'function' ? p : new Set();
  }

  // Make and check an event. Null (and one console line, no content) when it fails validation.
  function make(type, round, data) {
    var e = DR.event(type, round, data);
    var why = DR.validate(e, placesSet());
    if (why) { log('not written: ' + type + ' failed validation (' + why + ')'); return null; }
    return e;
  }
  async function commit(e) {
    if (!e) return null;
    var ok;
    A.writing++;
    try { ok = await DR.store.add(e); } finally {
      A.writing--;
      if (!A.writing) G.setTimeout(maybeReload, 0);
    }
    if (!ok) { log('not written: ' + e.type + ' (this phone would not store it)'); unkept(); return null; }
    A.events.push(e);
    recompute();
    return e;
  }
  // He acted and the phone dropped it: say so at once, where he is looking (SPEC 15.8).
  function unkept() {
    A.note = UNKEPT;
    if (A.mode !== 'PARKED') return;
    safe(function () { DR.sound.buzz([200, 80, 200]); });
    A.unkept = true;
    if (A.unkeptT !== null) G.clearTimeout(A.unkeptT);
    A.unkeptT = G.setTimeout(function () {
      A.unkeptT = null;
      A.unkept = false;
      if (!A.flow) paint();
    }, UNKEPT_MS);
    if (A.flow) mk(A.flow, 'plate', UNKEPT);
    else paint();
  }
  // Voice-note bytes are writes too (15.44): the idle reload waits for them as it does for commit().
  async function holding(fn) {
    A.writing++;
    try { return await fn(); } finally {
      A.writing--;
      if (!A.writing) G.setTimeout(maybeReload, 0);
    }
  }
  function write(type, round, data) { return commit(make(type, round, data)); }
  // A round's open, its close and the field's cut are written after every open and close the phone
  // holds (SPEC 15.25): another phone's fast clock would otherwise sort them under its close and bury them.
  function writeAfterBook(type, round, data) {
    var e = make(type, round, data);
    if (!e) return commit(null);
    var floor = -Infinity;
    A.events.forEach(function (x) {
      if (x.type !== 'round.opened' && x.type !== 'round.closed') return;
      var t = Date.parse(x.at);
      if (t > floor) floor = t;
    });
    if (!(Date.parse(e.at) > floor)) e.at = new Date(floor + 1).toISOString();
    return commit(e);
  }

  function recompute() { A.st = DR.reduce(A.events, A.series, iso()); return A.st; }
  async function refreshLocal() {
    var list = await DR.store.all();
    A.events = Array.isArray(list) ? list : [];
    A.home = DR.store.home();
    A.series = DR.store.series() || {};
    recompute();
  }
  function st() { return A.st || recompute(); }
  function active() { return st().active; }
  function roundById(id) {
    var rs = st().rounds;
    for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
    return null;
  }
  function proposals() { return A.home && isObj(A.home.proposals) ? A.home.proposals : {}; }
  function lastLane() {
    var rs = st().rounds, best = null;
    rs.forEach(function (R) {
      if (R.shadow || !R.closed) return;
      if (!best || Date.parse(R.closedAt) >= Date.parse(best.closedAt)) best = R;
    });
    return best ? best.lane : null;
  }
  function offersNow() {
    var after = lastLane();
    if (after !== A.offerAfter) { A.offerAfter = after; A.offerIdx = 0; }
    return DR.offers(after, proposals());
  }
  function currentOffer() {
    var o = offersNow();
    return o.length ? o[A.offerIdx % o.length] : null;
  }
  // The newest round.closed has no field.cut after it (compared as instants). A cut stamped after a close
  // from a fast clock (15.25) still cuts only through now, so its own time counts too.
  function needsCut() {
    var s = st();
    if (s.active || !s.lastClosed) return false;
    if (!s.cutThrough) return true;
    var cutAt = -Infinity;
    A.events.forEach(function (x) { if (x.type === 'field.cut' && Date.parse(x.at) > cutAt) cutAt = Date.parse(x.at); });
    return Math.max(Date.parse(s.cutThrough), cutAt) < Date.parse(s.lastClosed);
  }

  /* ---------- the view: the one place that decides what is drawn ---------- */

  function handOf(R, prints, t) {
    if (!R || !R.twin) return null;
    var s = DR.series(R.twin);
    if (!s || s.scale !== 'share' || DR.due(R, prints, t) !== 'in') return null;
    var p = DR.closingPrint(R, prints);
    return p && num(p.value) ? p.value : null;
  }
  function plateText(R, prints, t) {
    if (R) {
      if (A.callWait === R.id && DR.due(R, prints, t) === 'in' && !R.call) return 'CALL THE NEXT ONE';
      return R.q;
    }
    // The turn is held for the book (15.45): say why, rather than an offer a tap would not open.
    if (A.mode === 'PARKED' && bookPending()) return SYNCING;
    var o = currentOffer();
    return o ? o.q : '';
  }
  function brandsOf(s, R, t) {
    var reg = DR.registry();
    return (reg && reg.lanes || []).map(function (l) {
      var asked = s.asked[l.id];
      var state = R && R.lane === l.id ? 'hot' : asked ? 'warm' : 'never';
      return { id: l.id, brand: l.brand, state: state, warmth: asked ? DR.warmth(asked, t) : 0 };
    });
  }
  function tacksOf(s) {
    var shadow = {};
    s.rounds.forEach(function (R) { if (R.shadow) shadow[R.id] = true; });
    A.tackRefs = s.tacks.filter(function (k) { return !shadow[k.round]; });
    return A.tackRefs.map(function (k) { return { lane: k.lane, grade: k.graded ? k.grade : null }; });
  }
  function fieldOf(s, t) {
    var f = A.home && isObj(A.home.field) ? A.home.field : null;
    if (!f || !Array.isArray(f.flags)) return null;
    return DR.fieldDays(f.flags, s.cutThrough, t);
  }
  // The unlisted flags are all older than the oldest listed one: a cut through it bales every one of them.
  function olderBaled(flags) {
    var cut = st().cutThrough ? Date.parse(st().cutThrough) : NaN, oldest = Infinity;
    if (!isFinite(cut)) return false;
    flags.forEach(function (x) {
      var t = Array.isArray(x) && typeof x[1] === 'string' ? Date.parse(x[1]) : NaN;
      if (isFinite(t) && t < oldest) oldest = t;
    });
    return oldest <= cut;
  }
  function labelsOf(field) {
    var f = A.home && isObj(A.home.field) ? A.home.field : null, y = A.home && isObj(A.home.yours) ? A.home.yours : null;
    var out = { field: '', horizon: '', ground: '' };
    if (f && f.status === 'ok') {
      if (field) {
        var standing = field.standing, baled = field.baled, older = num(f.older) && f.older > 0 ? f.older : 0, split = true;
        if (older) {                                  // flags past the newest 3000 count too (15.20)
          if (olderBaled(f.flags)) baled += older;
          // A cut older than the oldest listed flag: the unlisted ones may fall either side of it (15.47).
          else if (isFinite(Date.parse(st().cutThrough))) split = false;
          else standing += older;
        }
        if (!split) out.field = count(standing) + '+ STANDING';
        else out.field = standing > 0 ? count(standing) + ' HEARD' : '0 STANDING, ' + count(baled) + ' BALED';
      }
      out.horizon = 'THE EAR KEPT ' + count(f.kept);
    }
    if (y) out.ground = A.groundAlt ? count(y.turned) + ' TURNED / ' + count(y.whys) + ' WHYS' : 'YOURS ' + count(y.live);
    return out;
  }

  function view() {
    var s = st(), R = s.active, t = iso();
    var field = fieldOf(s, t);
    return {
      mode: A.mode,
      line: DR.store.line(),
      muted: !!A.prefs.muted,
      lit: !!R && R.n > 0,
      words: R ? R.words.slice() : ['UP', 'DOWN'],
      u: R ? R.u : 0,
      n: R ? R.n : 0,
      plate: A.unkept && A.mode === 'PARKED' ? UNKEPT : plateText(R, s.prints, t),
      tag: R ? DR.tag(R, s.prints, t) : { text: '', lamp: false, rule: false },
      hand: handOf(R, s.prints, t),
      notches: R ? R.notches.map(function (N) { return { up: N.up, tag: !!N.breath }; }) : [],
      brands: brandsOf(s, R, t),
      tacks: tacksOf(s),
      field: field,
      labels: A.mode === 'PARKED' ? labelsOf(field) : null,
      dock: !!R
    };
  }

  // Draw the resting frame, then lay the running flow's own pieces back on top of it.
  function paint() {
    if (!S()) return;
    S().render(view());
    MARK_ORDER.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(A.marks, k)) return;
      var args = A.marks[k].slice();
      if (k === 'plate') args = [args[0]];
      S()[k].apply(null, args);
    });
  }
  // One of the moment's pieces: drawn now, remembered so a render (a mute, his own write) keeps it.
  // f is the flow that draws it. A flow that has ended draws and keeps nothing (15.41).
  function mk(f, name) {
    if (!f || f !== A.flow) return;
    var args = Array.prototype.slice.call(arguments, 2);
    A.marks[name] = args;
    S()[name].apply(null, args);
  }

  /* ---------- flows: one at a time ---------- */

  function blocked() { return !!A.flow || !!(S() && S().busy()); }
  function begin(kind) {
    if (A.flow) return null;
    A.flow = { kind: kind, dead: false };
    A.marks = {};
    wakeOn();                                         // a long flow outlasts the screen timeout (15.5)
    return A.flow;
  }
  function end(f) {
    if (!f || A.flow !== f) return;
    A.flow = null;
    A.marks = {};
    if (A.mode !== 'ROLLING') wakeOff();
    paint();
    if (A.held) { A.held = false; settle(); }
    armIdle();
    maybeReload();
  }
  // The guard, a hidden page, the hold limit or the lever: a recording is thrown away, nothing is written.
  // Sound stops too, flow or not: a card's PLAY runs with no flow. The wake lock is left to the caller,
  // which knows the mode it is going to.
  function abort() {
    var f = A.flow;
    if (f) {
      f.dead = true;
      A.flow = null;
      A.marks = {};
      safe(function () { DR.sound.cancelRecord(); });
    }
    safe(function () { DR.sound.hush(); });
    if (S()) S().closeAll();
    if (f) {
      paint();
      if (A.held) { A.held = false; settle(); }
    }
  }
  // Overlays go through here: nothing opens outside PARKED (15.1), and an idle reload waiting on them can
  // happen when they close. Null is what every caller already reads as closed.
  async function overlay(kind, opts) {
    if (A.mode !== 'PARKED') return null;
    var r = await S()[kind](opts);
    G.setTimeout(maybeReload, 0);
    return r;
  }

  /* ---------- after a sync: hold, grade, re-aim, first launch ---------- */

  var settling = null, settleAgain = false, settleLaunch = false;
  function settle(launch) {
    if (launch) settleLaunch = true;
    if (settling) { settleAgain = true; return settling; }
    settling = (async function () {
      try {
        var l = settleLaunch; settleLaunch = false;
        await settleOnce(l);
      } catch (e) {
        log('settle failed');
      } finally {
        settling = null;
        if (settleAgain) { settleAgain = false; settle(); }
      }
    })();
    return settling;
  }
  async function settleOnce(launch) {
    await refreshLocal();
    if (A.flow) { A.held = true; return; }
    if (partialBook()) {                              // the rest follows; a part can name the wrong round open (15.23)
      if (launch) settleLaunch = true;
      paint();
      return;
    }
    await firstLaunch();
    if (launch && needsCut()) {                       // killed mid-turn (9.6)
      if (await writeAfterBook('field.cut', null, { through: iso() })) A.freshCut = true;
    }
    await gradeCalls();
    await reaimActive();
    if (A.flow) { A.held = true; return; }
    paint();
    if (A.turnWait && !bookPending()) {
      A.turnWait = false;
      if (A.mode === 'PARKED' && !active() && !blocked()) turnFlow();
    }
  }

  // 9.6: a phone with a key opens nothing until its first sync has answered on an empty book.
  function firstSyncPending() {
    return DR.store.line() !== 'unset' && !A.syncOk && !A.events.length;
  }
  // Nor while part of the book is still at home (15.23). Only a live key finishes a book: the store can
  // say 'line unset' and then hand over the part it pulled, and no sync will come after that (15.45).
  function partialBook() { return A.partial && DR.store.line() !== 'unset'; }
  function bookPending() { return partialBook() || firstSyncPending(); }
  // No open round in PARKED shows the offers, unless the book is not here yet; then the sync brings them.
  function offerTurn() {
    if (bookPending()) { A.turnWait = true; return; }
    turnFlow();
  }

  // 9.6 first launch: no events at all, and no key or a first sync that came back with none.
  async function firstLaunch() {
    if (A.events.length || A.opening) return;
    if (bookPending()) return;
    var c = DR.canon('macro');
    if (!c) return;
    A.opening = true;
    try {
      var offer = { lane: 'macro', q: c.q, say: c.say, words: c.words.slice(), twin: c.twin, origin: 'canon', from: null };
      await openRound(offer);
    } finally { A.opening = false; }
  }
  function openRound(o) {
    return writeAfterBook('round.opened', DR.uuid(), {
      lane: o.lane, q: o.q, say: o.say, words: o.words.slice(), twin: o.twin, origin: o.origin,
      aim: DR.aimFor(o, A.series, iso()), from: o.from
    });
  }

  // 9.5 grading: call.graded once per pending call. It never changes again.
  async function gradeCalls() {
    if (bookPending()) return;                        // a part of the book may hold the grade already (15.45)
    var rs = st().rounds.slice();
    for (var i = 0; i < rs.length; i++) {
      var C = rs[i].call;
      if (rs[i].shadow || !C || !C.pending || C.graded || A.graded[C.c]) continue;
      var p = C.pending;
      if (handHeld(C.series, p.print.period) || handHeld(C.series, p.base.period)) continue;
      A.graded[C.c] = true;
      await write('call.graded', rs[i].id, { c: C.c, grade: p.grade, print: p.print, base: p.base });
    }
  }
  // 15.14: a grade is given once. On a phone with a key a second phone may grade the same call on home's
  // own figure, so a print held only by hand waits for a sync that answered after it was typed. With no key
  // there is no second phone.
  function handHeld(sid, period) {
    if (DR.store.line() === 'unset') return false;
    var hs = A.series[sid], fetched = hs && Array.isArray(hs.prints) ? hs.prints : [];
    if (fetched.some(function (p) { return p && p.period === period; })) return false;
    if (!(st().hand[sid] || []).some(function (h) { return h.period === period; })) return false;
    var k = sid + ' ' + period;
    return A.syncs <= (Object.prototype.hasOwnProperty.call(A.handSync, k) ? A.handSync[k] : 0);
  }
  // 9.6 re-aiming: written only when it differs from the round's aim, once per new aim.
  async function reaimActive() {
    var R = active();
    if (!R) return;
    var a = DR.reaim(R, A.series, iso());
    if (!a) return;
    var key = R.id + ' ' + DR.canonical(a);
    if (A.aimed[key]) return;
    A.aimed[key] = true;
    await write('round.aimed', R.id, { after: a.after, period: a.period, label: a.label, date: a.date, time_et: a.time_et, conf: a.conf });
  }

  // A change marked partial is drawn and nothing more: the rest of the book follows (15.23).
  function onChange(arg) {
    A.partial = !!(arg && arg.partial === true);
    if (!A.partial) {
      A.lastSync = nowMs();
      A.syncOk = true;
      A.syncs++;
    }
    if (A.flow) { A.held = true; return; }
    settle();
  }
  function onLine() {
    // A key forgotten or refused: no sync will finish the book now, so it settles as a phone with no
    // key (15.45).
    var unset = DR.store.line() === 'unset';
    if (unset) A.partial = false;
    if (A.flow) { A.held = true; return; }
    if (unset) settle(); else paint();
  }

  /* ---------- modes (9.3) ---------- */

  function park() {
    if (A.mode === 'PARKED') return;
    A.mode = 'PARKED';
    wakeOff();
    A.lastTouch = mono(); A.lastTouchWall = nowMs();
    startGuard();
    paint();
    armIdle();
    var bookShut = A.noBook && !A.noBookShown;
    if (!A.prefs.setup || bookShut) {                 // the setup card once ever; a shut book once a launch
      if (!A.prefs.setup) setPref('setup', true);
      if (bookShut) A.noBookShown = true;
      lineCard().then(function () {
        if (A.mode === 'PARKED' && !active() && !blocked()) offerTurn();
      });
      return;
    }
    if (!active()) offerTurn();                       // no open round: in PARKED it shows the offers
  }
  function roll() {
    abort();
    if (S()) S().closeAll();
    stopGuard();
    if (A.idleT !== null) { G.clearTimeout(A.idleT); A.idleT = null; }
    A.mode = 'ROLLING';
    A.groundAlt = false;
    A.turnWait = false;
    A.unkept = false;
    paint();
    wakeOn();
    maybeReload();
  }

  // 60 s with no touch; an overlay or a flow waiting on him holds PARKED at most 5 minutes.
  function armIdle() {
    if (A.idleT !== null) { G.clearTimeout(A.idleT); A.idleT = null; }
    if (A.mode !== 'PARKED') return;
    var held = blocked();
    var limit = held ? HOLD_MS : IDLE_MS;
    var since = elapsed(A.lastTouch, A.lastTouchWall);
    if (since >= limit) { roll(); return; }
    A.idleT = G.setTimeout(function () { A.idleT = null; armIdle(); }, limit - since);
  }
  function onPointer() {
    safe(function () { DR.sound.unlock(); });
    A.swallow = false;
    // A page that froze, or a phone that slept with no hide, may miss its idle timer. The touch that finds
    // PARKED overdue goes ROLLING and does nothing else: it must not re-arm PARKED (15.39).
    if (A.mode === 'PARKED' && elapsed(A.lastTouch, A.lastTouchWall) >= (blocked() ? HOLD_MS : IDLE_MS)) {
      roll();
      A.swallow = true;
      return;
    }
    A.lastTouch = mono(); A.lastTouchWall = nowMs();
    armIdle();
  }
  // The tap that follows a swallowing touch: true once, then it is spent.
  function swallowed() {
    if (!A.swallow) return false;
    A.swallow = false;
    return true;
  }

  function startGuard() {
    stopGuard();
    if (A.mode !== 'PARKED' || !A.prefs.guard) return;
    A.guardStop = safe(function () { return DR.geo.guard(onMoving); });
  }
  function stopGuard() {
    var s = A.guardStop;
    A.guardStop = null;
    if (typeof s === 'function') safe(s);
  }
  function onMoving() {
    if (A.mode !== 'PARKED') return;
    roll();
  }

  function onVisibility() {
    if (hiddenPage()) {
      A.hiddenAt = mono(); A.hiddenWall = nowMs();
      abort();
      wakeOff();
      if (A.hiddenT !== null) G.clearTimeout(A.hiddenT);
      A.hiddenT = G.setTimeout(function () { A.hiddenT = null; if (hiddenPage() && A.mode === 'PARKED') roll(); }, HIDDEN_MS);
      return;
    }
    if (A.hiddenT !== null) { G.clearTimeout(A.hiddenT); A.hiddenT = null; }
    if (A.hiddenAt && elapsed(A.hiddenAt, A.hiddenWall) >= HIDDEN_MS && A.mode === 'PARKED') roll();
    A.hiddenAt = 0;
    if (A.mode === 'ROLLING') wakeOn();
    else armIdle();                                   // the idle rule, by both clocks, may have run out too
    swUpdate();
  }

  // The screen stays on while ROLLING and visible, and in PARKED for the length of a flow (15.5).
  function wakeWanted() { return A.mode === 'ROLLING' || !!A.flow; }
  async function wakeOn() {
    var W = A.wake, nav = G.navigator;
    W.want = true;
    if (!wakeWanted() || W.lock || W.asking || !nav || !nav.wakeLock || hiddenPage()) return;
    W.asking = true;
    try {
      var l = await nav.wakeLock.request('screen');
      if (!W.want || !wakeWanted()) { try { l.release(); } catch (e) { /* gone */ } return; }
      W.lock = l;
      if (l && typeof l.addEventListener === 'function') l.addEventListener('release', function () { if (W.lock === l) W.lock = null; });
    } catch (e) {
      /* refused: the screen may sleep */
    } finally { W.asking = false; }
  }
  function wakeOff() {
    var W = A.wake, l = W.lock;
    W.want = false;
    W.lock = null;
    if (l) { try { var p = l.release(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* gone */ } }
  }

  /* ---------- touches ---------- */

  function parkedFree() { return A.mode === 'PARKED' && !blocked(); }

  function speakRead() {
    var s = st();
    DR.sound.hush();                                  // two reads never overlap (15.2)
    DR.sound.say(DR.lines.read(s.active, s.prints, iso()));
  }
  function onStage() {
    if (swallowed() || A.mode !== 'ROLLING' || A.flow) return;
    speakRead();                                      // the read, and nothing else changes
  }
  function onLever() {
    if (swallowed()) return;
    if (A.mode === 'ROLLING') park(); else roll();
  }
  function onMute() {
    if (swallowed()) return;
    var m = !A.prefs.muted;
    setPref('muted', m);
    DR.sound.mute(m);
    if (m) DR.sound.hush();
    paint();
  }
  function onDial() {
    if (!parkedFree()) return;
    var R = active();
    if (!R) { offerTurn(); return; }
    if (R.call) { moment(R.id, 'resume'); return; }   // a call waiting (killed after call.made)
    var d = DR.due(R, st().prints, iso());
    if (d === 'in') { moment(R.id, A.callWait === R.id ? 'halves' : 'top'); return; }
    if (d === 'own') { moment(R.id, 'top'); return; }
    speakRead();
  }
  function onRail(p) {
    if (!parkedFree()) return;
    var R = active();
    if (!R || !R.notches.length) return;
    var i = p && num(p.i) ? p.i : -1, hold = !!(p && p.hold);
    var last = R.notches[R.notches.length - 1], age = nowMs() - Date.parse(last.at);
    if (age >= 0 && age < FRESH_MS) {                 // inside 60 s of the freshest cut
      if (hold) pull(R, last); else flip(R, last);
      return;
    }
    if (i < 0) return;
    notchCard(R.id, Math.min(i, R.notches.length - 1));
  }
  async function flip(R, N) {
    var e = await write('notch.flip', R.id, { n: N.n });
    if (!e) return;
    if (A.mode !== 'PARKED') { paint(); return; }    // the lever or the guard came during the write: it stands, silent
    DR.sound.tick();
    paint();
    var R2 = roundById(R.id), N2 = R2 && R2.notches.filter(function (x) { return x.n === N.n; })[0];
    if (R2 && N2) DR.sound.say(DR.lines.notch(N2.up, R2.words, R2.u, R2.n));
  }
  async function pull(R, N) {
    var e = await write('notch.pull', R.id, { n: N.n });
    if (!e) return;
    if (A.mode === 'PARKED') DR.sound.knock();       // a pull that lands in ROLLING stands, silent
    paint();
  }

  /* ---------- a dock (9.4) ---------- */

  function notchLines(R) {
    return [DR.lines.notch(true, R.words, R.u + 1, R.n + 1), DR.lines.notch(false, R.words, R.u, R.n + 1)];
  }

  async function dock() {
    if (!parkedFree()) return;
    var R = active();
    if (!R) return;
    var f = begin('dock');
    if (!f) return;
    try {
      DR.sound.warm(notchLines(R));
      var pick = await overlay('halves', { a: R.words[0], b: R.words[1], seam: R.q, see: false, drainMs: DOCK_DRAIN_MS });
      if (f.dead || pick === null) return;            // a swipe or 8 s: nothing is cut
      var up = pick === 'a', n = DR.uuid(), thumbAt = nowMs();
      var cut = await write('notch.cut', R.id, { n: n, up: up, place: null });
      if (!cut || f.dead) return;
      DR.sound.tick();
      DR.sound.buzz(up ? [30, 40, 30] : [90]);
      paint();                                        // the notch, the needle, the figure
      var R2 = roundById(R.id) || R;
      var said = DR.sound.say(DR.lines.notch(up, R2.words, R2.u, R2.n));
      DR.sound.warm(notchLines(R2));
      if (A.prefs.towns) placeLater(f, R.id, n);      // one fix, the town or nothing
      await Promise.race([said, wait(Math.max(0, VOICE_CAP_MS - (nowMs() - thumbAt)))]);
      if (f.dead) return;
      var mic = await DR.sound.micState();
      if (f.dead || mic !== 'granted') return;
      mk(f, 'plate', "WHAT'D THEY SAY?");
      var clip = await breathe(f, DOCK_OPEN_MS, false);
      if (f.dead || !clip) return;
      await keepBreath(f, clip, 'notch', n, R.id);
    } finally { end(f); }
  }
  function placeLater(f, round, n) {
    Promise.resolve().then(function () { return DR.geo.town(); }).then(function (t) {
      if (!t || f.dead) return null;
      return write('notch.place', round, { n: n, city: t.city, st: t.st }).then(function (e) {
        if (e && !A.flow) paint();
      });
    }).catch(function () { /* no town */ });
  }

  // One breath through the mic, only when it is granted. Null when he said nothing or the flow died.
  async function breathe(f, openMs, withLevel) {
    var mic = await DR.sound.micState();
    if (f.dead || mic !== 'granted') return null;
    A.recording = true;
    var clip = null;
    try {
      clip = await DR.sound.record({
        openMs: openMs, maxMs: BREATH_MAX_MS,
        onLevel: withLevel ? function (x) { if (!f.dead) S().bezel(x); } : undefined
      });
    } finally {
      A.recording = false;
      if (withLevel) S().bezel(0);
    }
    return f.dead ? null : clip;
  }
  // The clip is stored on this phone first, then breath.kept hangs it on the notch or the call. Once the
  // bytes are stored their breath.kept follows, even if f has ended, so no bytes lie on the phone unnamed;
  // a flow that has ended makes no sound (15.41). False when the phone would not store it, null when there
  // was nothing to keep.
  async function keepBreath(f, clip, of, ref, round) {
    if (!clip || !clip.blob) return null;
    var mime = String(clip.mime || '').split(';')[0].trim().toLowerCase();
    var ms = Math.round(clip.ms);
    if (!(ms >= 200 && ms <= 30000)) return null;
    var b = DR.uuid();
    var e = make('breath.kept', round, { b: b, of: of, ref: ref, ms: ms, mime: mime });
    if (!e) return null;
    var stored = await holding(function () { return DR.store.putBlob(b, clip.blob, { mime: mime, ms: ms }); });
    if (!stored) { log('not written: breath.kept (this phone would not store the clip)'); unkept(); return false; }
    var done = await commit(e);
    if (done) {
      if (of === 'notch' && !f.dead) DR.sound.breath();   // the paper tag hangs (15.11)
      paint();
    }
    return done || false;
  }

  /* ---------- the moment (9.5) ---------- */

  function printPlate(p, sid) {
    var t = 'PRINT ' + DR.showValue(p.value, sid);
    return p.by === 'hand' ? t + ' BY HAND' : t;
  }
  // 15.13: a moment left past the next print is called from the newest figure, which he can already see.
  function newestPlate(p, sid) {
    var t = 'NEWEST ' + (p.label || DR.periodLabel(p.period)) + ' ' + DR.showValue(p.value, sid);
    return p.by === 'hand' ? t + ' BY HAND' : t;
  }
  function newestLine(p, sid) { return 'The newest print is ' + DR.sayValue(p.value, sid) + '.'; }
  // 15.38: the call's seam carries the figure he calls from. The seam sits over the plate, so the plate
  // alone would leave him calling UP or DOWN from a number he cannot read.
  function fromPlate(p, sid) {
    var t = 'FROM ' + (p.label || DR.periodLabel(p.period)) + ' ' + DR.showValue(p.value, sid);
    return p.by === 'hand' ? t + ' BY HAND' : t;
  }
  // 15.18: a twin with no period to wait on and no number to type (the BTOS cycle before home has a
  // schedule) would hold the lanes forever; he can close it as his own.
  function railOnly(R) {
    if (!R || !R.twin || R.closed || (R.aim && R.aim.period)) return false;
    return !DR.handPeriod(R, A.series, iso()) && !DR.closingPrint(R, st().prints);
  }
  function printBefore(sid, period) {
    var list = st().prints[sid] || [], prev = null;
    list.forEach(function (p) { if (p.period < period) prev = p; });
    return prev;
  }

  async function moment(roundId, from) {
    var f = begin('moment');
    if (!f) return;
    try {
      var R = roundById(roundId);
      if (!R || R.closed) return;
      var own = !R.twin || (from === 'rail' && railOnly(R));
      var sid = own ? null : R.twin, s = own ? null : DR.series(sid), share = !!(s && s.scale === 'share');
      var print = own ? null : DR.closingPrint(R, st().prints);
      if (!R.call) {
        if (!own && !print) return;
        var list = own ? [] : (st().prints[sid] || []), newest = list[list.length - 1];
        var base = !own && newest && newest.period > print.period ? newest : print;
        if (from !== 'halves') {
          DR.sound.bell();                                       // 1
          mk(f, 'tag', own ? 'DUE' : 'IN', { lamp: true, rule: false });
          mk(f, 'needle', null);                                 // 2
          mk(f, 'figure', null, R.n, null);
          await retrace(R, f);                                   // 3
          if (f.dead) return;
        }
        var v = R.n ? DR.share(R.u, R.n) : null, up = null, inside = null;
        if (!own) {
          if (share) {                                           // 4
            mk(f, 'hand', print.value);
            mk(f, 'plate', printPlate(print, sid), { flip: from !== 'halves' });
            if (v !== null) mk(f, 'bridge', v, print.value);
          } else {
            mk(f, 'plate', printPlate(print, sid), { flip: from !== 'halves' });
          }
          if (from !== 'halves') {
            var say = DR.sound.say(DR.lines.printIn(R, print));  // 5
            if (!share) {
              var prev = printBefore(sid, print.period), mv = prev ? DR.levelMove(prev.value, print.value) : null;
              if (mv) { await wait(LEVEL_BEAT_MS); if (f.dead) return; mk(f, 'plate', mv.text, { flip: true }); }
            }
            await say;
            if (f.dead) return;
          }
          if (base !== print) {
            mk(f, 'plate', newestPlate(base, sid), { flip: from !== 'halves' });
            if (from !== 'halves') { await DR.sound.say(newestLine(base, sid)); if (f.dead) return; }
          }
          DR.sound.warm([DR.lines.yours()]);
          var pick = await overlay('halves', { a: 'UP', b: 'DOWN', seam: 'NEXT PRINT?', sub: fromPlate(base, sid), see: true, drainMs: null });   // 6
          if (f.dead) return;
          if (pick === null) { A.callWait = R.id; return; }      // the plate reads CALL THE NEXT ONE
          A.callWait = null;
          up = pick === 'a';                                     // 7
          if (share) mk(f, 'arrow', base.value, up);             // a level twin has no place on the dial (15.15)
          DR.sound.click();
          mk(f, 'plate', 'WHY?');
          if (share && R.n) inside = DR.inside(v, R.n, print.value);
        } else {
          await DR.sound.say(DR.lines.ownClose(R));
          if (f.dead) return;
          mk(f, 'plate', 'WHAT DID THE DOCKS TELL YOU?');
        }
        var why = await breathe(f, WHY_OPEN_MS, true);
        if (f.dead) return;
        var c = DR.uuid();
        var made = await write('call.made', R.id, {
          c: c, lane: R.lane, series: own ? null : sid,
          from: own ? null : { period: base.period, label: base.label, value: base.value, by: base.by },
          up: own ? null : up, docks: { u: R.u, n: R.n }, inside: own ? null : inside
        });
        if (!made) return;
        // A WHY already recorded goes with the call already written, even if the flow has just ended (15.41).
        var kept = why ? await keepBreath(f, why, 'call', c, R.id) : null;
        if (f.dead) return;
        DR.sound.knock();                                        // a tack in his ground
        // The call stands; a WHY the phone would not store says so, and holds the plate (15.42).
        mk(f, 'plate', kept === false ? WHY_UNKEPT : "THAT ONE'S YOURS");
        paint();
        var hold = kept === false ? wait(UNKEPT_MS) : null;
        await DR.sound.say(DR.lines.yours());
        if (f.dead) return;
        if (hold) { await hold; if (f.dead) return; }
      }
      R = roundById(roundId);
      if (!R || !R.call) return;
      if (R.call.move === null) {                                // 8
        var idx = await overlay('bands', { seam: 'POSITION, MONEY OR HELP?', options: MOVE_BANDS, drainMs: MOVE_DRAIN_MS });
        if (f.dead) return;
        var moved = await write('call.move', R.id, { c: R.call.c, move: idx === null ? 'none' : MOVES[idx] });
        if (!moved || f.dead) return;
      }
      R = roundById(roundId);
      var byPrint = !!(R && R.twin && R.call && R.call.series);   // a rail closed as his own has no print
      var cp = byPrint ? DR.closingPrint(R, st().prints) : null;   // 9
      var closed = await writeAfterBook('round.closed', roundId, {
        reason: byPrint ? 'print' : 'own',
        print: cp ? { series: R.twin, period: cp.period, label: cp.label, value: cp.value, by: cp.by } : null
      });
      if (!closed) return;
      A.callWait = null;
      if (f.dead) return;
      A.marks = {};
      paint();
      await turnBody(f);                                         // the turn
    } finally { end(f); }
  }

  async function retrace(R, f) {
    var n = R.n;
    if (!n) return;                                              // no docks: skipped
    var step = Math.min(STEP_MAX_MS, RETRACE_MS / n), plays = {}, found = 0, i;
    for (i = n - 1; i >= 0 && found < RETRACE_BREATHS; i--) {   // the newest three that carry a breath (15.11)
      var b = R.notches[i].breath;
      if (!b) continue;
      found++;
      var blob = await DR.store.getBlob(b);
      if (blob) plays[i] = blob;
    }
    if (f.dead) return;
    mk(f, 'retrace', -1);
    var u = 0;
    for (i = 0; i < n; i++) {
      if (f.dead) return;
      if (R.notches[i].up) u++;
      var k = i + 1, v = 100 * u / k;
      mk(f, 'retrace', i);
      DR.sound.tick();
      mk(f, 'needle', v);
      mk(f, 'figure', u, k, R.words[0]);
      mk(f, 'beam', v, k);
      await wait(step);
      if (plays[i] && !f.dead) await DR.sound.play(plays[i], { maxMs: RETRACE_PLAY_MS });
    }
    if (f.dead) return;
    mk(f, 'retrace', null);
  }

  /* ---------- the turn (9.6) ---------- */

  async function turnFlow() {
    var f = begin('turn');
    if (!f) return;
    try { await turnBody(f); } finally { end(f); }
  }
  async function turnBody(f) {
    // A part of the book may hold a cut or an open round: the whole sync opens the turn (15.45).
    if (bookPending()) { A.turnWait = true; return; }
    if (needsCut()) {
      var cut = await writeAfterBook('field.cut', null, { through: iso() });
      if (f.dead) return;
      if (cut) { A.freshCut = true; DR.sound.swish(); paint(); }
    }
    if (active()) return;
    var offers = offersNow();                                    // round the turn_order after the lane just closed
    if (!offers.length) return;
    while (!f.dead) {
      var i = A.offerIdx % offers.length, o = offers[i], prev = i > 0 ? offers[i - 1] : null;
      mk(f, 'plate', o.q, { flip: true });
      var line = A.freshCut ? DR.lines.turn(o) : DR.lines.offer(o, prev);
      A.freshCut = false;
      DR.sound.hush();
      DR.sound.say(line);
      var n1 = offers[(i + 1) % offers.length], n2 = offers[(i + 2) % offers.length];
      DR.sound.warm([DR.lines.offer(n1, o), DR.lines.offer(n2, n1)]);
      var pick = await overlay('bands', { seam: o.q, options: TURN_BANDS, drainMs: null });
      if (f.dead) return;
      if (pick === null) { DR.sound.hush(); return; }
      if (pick === 1) { A.offerIdx = (i + 1) % offers.length; continue; }
      var take = o;
      if (pick === 2) {
        DR.sound.hush();
        take = await myOwn(f, o.lane);
        if (f.dead) return;
        if (!take) continue;
      }
      DR.sound.hush();
      var e = await openRound(take);
      if (e) {
        A.offerIdx = 0;
        var R = active();
        if (R) DR.sound.warm(notchLines(R));
      }
      return;
    }
  }
  function spokenOf(q) {
    return q.toLowerCase().replace(/\bai\b/g, 'A.I.').slice(0, 80);
  }
  async function myOwn(f, lane) {
    var l = DR.lane(lane);
    var raw = await overlay('entry', { title: 'YOUR OWN QUESTION · ' + (l ? l.brand : ''), kind: 'text', hint: 'ONE QUESTION A STRANGER CAN ANSWER IN ONE WORD', max: OWN_MAX });
    if (f.dead || raw === null) return null;
    var q = String(raw).replace(/[‘’]/g, "'").toUpperCase().replace(/\s+/g, ' ').trim();
    if (!q || q === '?') return null;
    if (q.charAt(q.length - 1) !== '?') q = q.slice(0, OWN_MAX - 1).trim() + '?';
    if (q.length > OWN_MAX) q = q.slice(0, OWN_MAX - 1).trim() + '?';
    if (!Q_RE.test(q)) {
      await overlay('card', { title: 'NOT THAT ONE', marks: [], lines: ["Letters, numbers, spaces and ? ' - , . only, three characters or more."], actions: [] });
      return null;
    }
    var w = await overlay('bands', { seam: q, options: PAIR_BANDS, drainMs: null });
    if (f.dead || w === null) return null;
    return { lane: lane, q: q, say: spokenOf(q), words: w === 0 ? ['UP', 'DOWN'] : ['YES', 'NO'], twin: null, origin: 'own', from: null };
  }

  /* ---------- the cards (9.3 table) ---------- */

  async function tagCard() {
    if (!parkedFree()) return;
    for (;;) {
      if (A.mode !== 'PARKED' || blocked()) return;   // REFRESH may outlast PARKED (15.1)
      var R = active();
      if (!R) return;
      var s = R.twin ? DR.series(R.twin) : null, home = R.twin ? A.series[R.twin] : null, aim = R.aim || {};
      var marks = [], lines = [], acts = [];
      if (s) {
        lines.push(s.means, s.caveat);
        if (home && home.question) lines.push('THEIR QUESTION: ' + home.question);
        else if (s.id === 'btos_ai_use') lines.push('THEIR WORDING: NOT FETCHED YET');   // its means line points here
        if (aim.date) {
          lines.push('NEXT ' + (aim.label || DR.periodLabel(aim.period) || 'PRINT') + ': ' + DR.dateLabel(aim.date) + (aim.time_et ? ' ' + aim.time_et + ' ET' : ''));
          if (aim.conf === 'confirmed') marks.push('DATE CONFIRMED');
          else if (aim.conf === 'rule') marks.push('DATE BY RULE');
        } else lines.push('NO DATE YET');
        var list = st().prints[R.twin] || [], last = list[list.length - 1];
        if (last) {
          var src = last.by === 'hand' ? 'BY HAND' : (last.source || 'FETCHED');
          lines.push('LAST PRINT ' + (last.label || DR.periodLabel(last.period)) + ': ' + DR.showValue(last.value, R.twin) + ' · ' + src +
                     (last.by !== 'hand' && last.fetched_at ? ' · FETCHED ' + DR.dateLabel(dayOf(last.fetched_at) || last.fetched_at.slice(0, 10)) : ''));
          var hand = (st().hand[R.twin] || []).filter(function (h) { return h.period === last.period; })[0];
          if (hand && last.by !== 'hand' && hand.value !== last.value) {
            lines.push('YOURS BY HAND ' + DR.showValue(hand.value, R.twin) + ', FETCHED ' + DR.showValue(last.value, R.twin));
          }
        } else lines.push('NO PRINT YET');
        if (home && home.status && home.status !== 'ok' && home.note) lines.push(home.note);
        if (DR.handPeriod(R, A.series, iso())) acts.push({ id: 'hand', label: 'SET PRINT BY HAND' });
        // A series he types by hand has nothing at home to fetch (15.63).
        if (DR.store.line() !== 'unset' && !(home && home.status === 'hand')) acts.push({ id: 'refresh', label: 'REFRESH' });
        if (railOnly(R)) acts.push({ id: 'closerail', label: 'CLOSE THE RAIL' });
      } else {
        marks.push('ONLY YOURS');
        lines.push('No print for this one.');
        if (aim.date) lines.push('THE RAIL CLOSES ' + DR.dateLabel(aim.date));
        acts.push({ id: 'closerail', label: 'CLOSE THE RAIL' });
      }
      var a = await overlay('card', { title: s ? s.name : 'THIS RAIL', marks: marks, lines: lines, actions: acts });
      if (a === null || A.mode !== 'PARKED') return;
      if (a === 'refresh') {
        var ran = await DR.store.refreshPrints();
        A.note = ran ? 'HOME FETCHED THE PRINTS' : 'HOME DID NOT FETCH JUST NOW';
        await DR.store.sync();
        await settle();
      } else if (a === 'hand') {
        await printByHand(R.id);
        return;
      } else if (a === 'closerail') {
        moment(R.id, 'rail');
        return;
      }
    }
  }

  async function printByHand(roundId) {
    var R = roundById(roundId);
    var hp = R ? DR.handPeriod(R, A.series, iso()) : null, s = R && DR.series(R.twin);
    if (!hp || !s) return;
    await enterPrint(roundId, s, hp);
  }

  // 15.17: what he types is what the screens show. The power price is shown in cents, so it is typed in
  // cents (and kept in dollars, as fetched). A figure takes no more decimals than the series prints.
  function inCents(s) { return s.unit === 'dollars per kWh'; }
  function handPlaces(s) {
    var d = num(s.decimals) ? s.decimals : 1;
    return inCents(s) ? Math.max(0, d - 2) : d;
  }
  function handBounds(s) {
    if (inCents(s)) return [String(Math.round(s.lo * 1000) / 10), String(Math.round(s.hi * 1000) / 10)];
    if (handPlaces(s) === 0) return [count(s.lo), count(s.hi)];
    return [String(s.lo), String(s.hi)];
  }
  function handHint(s) {
    var b = handBounds(s);
    return b[0] + ' TO ' + b[1] + (inCents(s) ? ' CENTS' : '');
  }
  function handRule(s) {
    var b = handBounds(s), k = handPlaces(s);
    if (k === 0) return 'A whole number from ' + b[0] + ' to ' + b[1] + '.';
    return 'A number from ' + b[0] + ' to ' + b[1] + (inCents(s) ? ' cents' : '') + ', at most ' +
      DR.num(k) + (k === 1 ? ' decimal.' : ' decimals.');
  }
  // The number he typed, in the series' own unit; null when it is not one.
  function handValue(raw, s) {
    var t = String(raw).replace(/[\s$¢]/g, ''), k = handPlaces(s);
    if (k === 0 && /^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');   // a count: 501,609
    if (!/^\d*\.?\d+$/.test(t)) return null;
    var dot = t.indexOf('.');
    if (dot >= 0 && t.length - dot - 1 > k) return null;
    var v = Number(t);
    if (!num(v)) return null;
    return inCents(s) ? Number((v / 100).toFixed(num(s.decimals) ? s.decimals : 3)) : v;
  }
  // The number entry for one period, from the tag card or a pending call's tack card. The print names
  // roundId, the round it is for.
  async function enterPrint(roundId, s, hp) {
    for (;;) {
      // Reached as a card closes (the tag card, the tack card, TRY AGAIN): a flow may have begun (15.43).
      if (A.mode !== 'PARKED' || blocked()) return null;
      var raw = await overlay('entry', { title: s.name + ' · ' + hp.label, kind: 'number', hint: handHint(s), max: 16 });
      if (raw === null || A.mode !== 'PARKED') return null;
      var v = handValue(raw, s);
      var e = v === null ? null : make('print.hand', roundId, { series: s.id, period: hp.period, label: hp.label, value: v });
      if (!e) {
        if (blocked()) return null;                   // a flow may have begun as the entry closed (15.43)
        var again = await overlay('card', { title: 'NOT THAT NUMBER', marks: [], lines: [handRule(s)], actions: [{ id: 'again', label: 'TRY AGAIN' }] });
        if (again !== 'again') return null;
        continue;
      }
      if (!(await commit(e))) return null;
      A.handSync[s.id + ' ' + hp.period] = A.syncs;   // with a key it grades after the next sync (15.14)
      await gradeCalls();
      paint();
      S().plate(printPlate({ value: v, by: 'hand' }, s.id), { flip: true });
      return e;
    }
  }

  async function notchCard(roundId, i) {
    var gone = null;                                  // the breath he asked for that is not on this phone
    for (;;) {
      var R = roundById(roundId);
      if (!R || !R.notches.length || A.mode !== 'PARKED') return;
      i = Math.max(0, Math.min(i, R.notches.length - 1));
      var N = R.notches[i], word = R.words[N.up ? 0 : 1];
      var lines = [word, N.place ? N.place.city + ', ' + N.place.st : 'NO TOWN', dayOf(N.at) ? DR.dateLabel(dayOf(N.at)) + ' ' + clockOf(Date.parse(N.at)).split(' ').pop() : ''];
      if (N.breath && N.breath === gone) lines.push(NOT_HERE);
      var acts = [];
      if (i > 0) acts.push({ id: 'prev', label: 'PREV' });
      if (i < R.notches.length - 1) acts.push({ id: 'next', label: 'NEXT' });
      if (N.breath) acts.push({ id: 'play', label: 'PLAY' });
      acts.push({ id: 'flip', label: 'FLIP' }, { id: 'pull', label: 'PULL' }, { id: 'town', label: 'TOWN' });
      if (N.breath) acts.push({ id: 'drop', label: 'DROP BREATH' });
      acts.push({ id: 'close', label: 'CLOSE' });
      var a = await overlay('card', { title: 'DOCK ' + (i + 1) + ' OF ' + R.notches.length, marks: N.breath ? ['YOUR BREATH'] : [], lines: lines, actions: acts });
      if (a === null || a === 'close' || A.mode !== 'PARKED') return;
      if (a === 'prev') i--;
      else if (a === 'next') i++;
      else if (a === 'play') { if (!(await playBreath(N.breath))) gone = N.breath; }
      // A FLIP or PULL that lands after the phone went ROLLING stands, silent.
      else if (a === 'flip') { if (await write('notch.flip', R.id, { n: N.n })) { if (A.mode === 'PARKED') DR.sound.tick(); paint(); } }
      else if (a === 'pull') { if (await write('notch.pull', R.id, { n: N.n })) { if (A.mode === 'PARKED') DR.sound.knock(); paint(); } }
      else if (a === 'town') await townPick(R.id, N);
      else if (a === 'drop') {
        if (blocked()) return;                        // a flow may have begun as the card closed (15.43)
        var sure = await overlay('card', { title: 'DROP THIS BREATH?', marks: [], lines: ['It is deleted here and at home.'], actions: [{ id: 'yes', label: 'DROP IT' }, { id: 'close', label: 'KEEP IT' }] });
        // The drop and its bytes' delete are one stretch of writing: no idle reload between them (15.44).
        var dropped = sure === 'yes' && (await holding(async function () {
          var e = await write('breath.dropped', R.id, { b: N.breath });
          if (e) await DR.store.dropBlob(N.breath);
          return e;
        }));
        if (dropped) paint();
      }
      if (A.mode !== 'PARKED' || blocked()) return;   // a PLAY or a TOWN may outlast PARKED, or a dock begin (15.43)
    }
  }
  // False when the voice note is neither here nor fetchable; the card that asked says so.
  async function playBreath(b) {
    var blob = await DR.store.fetchBlob(b);
    if (!blob) { A.note = 'THAT BREATH IS NOT ON THIS PHONE'; return false; }
    if (A.mode !== 'PARKED') return true;             // fetched after the phone went ROLLING: it never plays (15.40)
    await DR.sound.play(blob, { maxMs: PLAY_MAX_MS });
    return true;
  }
  async function townPick(roundId, N) {
    var list = [], note = '';
    if (A.prefs.towns && (await DR.geo.state()) === 'granted') list = await DR.geo.towns(TOWNS_K);
    for (;;) {
      if (A.mode !== 'PARKED' || blocked()) return;   // the town lookup may outlast PARKED, or a dock begin (15.43)
      var acts = list.map(function (t, k) { return { id: 't' + k, label: t.city + ', ' + t.st }; });
      acts.push({ id: 'type', label: 'TYPE THREE LETTERS' });
      if (N.place) acts.push({ id: 'clear', label: 'NO TOWN' });
      var a = await overlay('card', { title: 'WHICH TOWN?', marks: [], lines: note ? [note] : [], actions: acts });
      if (a === null) return;
      if (a === 'clear') { if (await write('notch.place', roundId, { n: N.n, city: '', st: '' })) paint(); return; }
      if (a === 'type') {
        if (blocked()) return;                        // a flow may have begun as the card closed (15.43)
        var raw = await overlay('entry', { title: 'TOWN', kind: 'text', hint: 'THE FIRST THREE LETTERS', max: 40 });
        if (raw === null) continue;
        var pre = String(raw).trim().toUpperCase();
        if (pre.length < 3) { note = 'Three letters or more.'; list = []; continue; }
        list = DR.geo.find(pre) || [];
        note = list.length ? '' : 'No town in the list starts with ' + pre + '.';
        continue;
      }
      var t = list[+a.slice(1)];
      if (t && (await write('notch.place', roundId, { n: N.n, city: t.city, st: t.st }))) paint();
      return;
    }
  }

  async function heardCard() {
    if (!parkedFree()) return;
    var f = A.home && isObj(A.home.field) ? A.home.field : null;
    var heard = f && Array.isArray(f.heard) ? f.heard : [];
    var i = 0;
    for (;;) {
      var h = heard[i], acts = [];
      if (h) DR.sound.say(DR.lines.heard(h.line));
      if (i > 0) acts.push({ id: 'prev', label: 'PREV' });
      if (i < heard.length - 1) acts.push({ id: 'next', label: 'NEXT' });
      var a = await overlay('card', {
        title: 'HEARD',
        marks: ['HEARD, NOT YOURS', 'GIST, BY MACHINE'],
        lines: h ? [String(h.line), DR.dateLabel(String(h.at).slice(0, 10))] : ['No gist yet.'],
        actions: acts
      });
      DR.sound.hush();
      if (a === null || A.mode !== 'PARKED' || blocked()) return;   // a flow may have begun as it closed (15.43)
      if (a === 'prev') i--; else if (a === 'next') i++;
    }
  }

  async function tackCard(i) {
    if (!parkedFree()) return;
    var k = A.tackRefs[i];
    var R = k ? roundById(k.round) : null;
    if (!R || !R.call) return;
    var C = R.call, s = C.series ? DR.series(C.series) : null, l = DR.lane(R.lane), lines = [], marks = [];
    if (s && C.from) {
      lines.push('YOU CALLED ' + (C.up ? 'UP' : 'DOWN') + ' ON ' + s.name + ' ' + (C.from.label || DR.periodLabel(C.from.period)) + ': ' +
                 DR.showValue(C.from.value, s.id) + (C.from.by === 'hand' ? ' BY HAND' : ''));
    } else {
      marks.push('ONLY YOURS');
      lines.push('No print for this one.');
    }
    lines.push('YOUR DOCKS THEN: ' + C.docks.u + ' OF ' + C.docks.n + ' ' + R.words[0]);
    if (C.inside === true) lines.push('INSIDE YOUR BEAM');
    if (C.inside === false) lines.push('OUTSIDE YOUR BEAM');
    if (C.move && C.move !== 'none') lines.push('MOVE: ' + C.move.toUpperCase());
    var aw = null;
    if (C.graded && s) {
      // 15.16: a figure he typed says so, and home's figure for that month later is not a revision.
      var list = st().prints[s.id] || [], hands = st().hand[s.id] || [];
      var rowOf = function (rows, p) { return rows.filter(function (x) { return x.period === p.period; })[0]; };
      var typed = function (p) {
        var h = rowOf(hands, p), now = rowOf(list, p);
        return !!h && h.value === p.value && !(now && now.by !== 'hand' && now.value === p.value);
      };
      var g = C.graded, on = (g.print.label || DR.periodLabel(g.print.period)) + ' ' + DR.showValue(g.print.value, s.id) +
        (typed(g.print) ? ' BY HAND' : '');
      lines.push(g.grade === 1 ? 'IT STOOD ON ' + on : g.grade === 0 ? "IT DIDN'T STAND ON " + on : 'EVEN ON ' + on + ': THE PRINTS WERE EQUAL');
      [g.base, g.print].forEach(function (p) {
        var now = rowOf(list, p);
        if (!now || now.value === p.value) return;
        lines.push((p.label || DR.periodLabel(p.period)) + (typed(p) ? ' FETCHED SINCE: ' : ' REVISED SINCE: NOW ') + DR.showValue(now.value, s.id));
      });
    } else if (s) {
      aw = DR.awaitedPeriod(C);                       // 15.12: a monthly call waits on one month only
      // 15.46: his figure for that month is in and waits on a sync (15.14): say so, not a plain wait.
      var held = aw && handHeld(s.id, aw.period) ? (st().hand[s.id] || []).filter(function (h) { return h.period === aw.period; }).pop() : null;
      if (held) lines.push('SET BY HAND: ' + aw.label + ' ' + DR.showValue(held.value, s.id), 'GRADES AFTER THE NEXT SYNC');
      else lines.push(aw ? 'WAITING ON ' + aw.label : 'WAITING ON THE NEXT PRINT');
    }
    var acts = C.why ? [{ id: 'play', label: 'PLAY YOUR WHY' }] : [];
    if (aw) acts.push({ id: 'hand', label: 'SET ' + aw.label + ' BY HAND' });
    for (;;) {
      var a = await overlay('card', { title: (l ? l.brand : '') + ' CALL', marks: marks, lines: lines, actions: acts });
      if (a === 'hand' && A.mode === 'PARKED') { await enterPrint(R.id, s, aw); return; }
      if (a !== 'play' || A.mode !== 'PARKED') return;
      if (!(await playBreath(C.why)) && lines.indexOf(NOT_HERE) < 0) lines.push(NOT_HERE);
      if (A.mode !== 'PARKED' || blocked()) return;   // the play may outlast PARKED (15.1)
    }
  }

  function onGround() {
    if (!parkedFree()) return;
    A.groundAlt = !A.groundAlt;
    paint();
  }

  async function showCounter() {
    if (!parkedFree()) return;
    var R = active();
    await overlay('counter', { u: R ? R.u : 0, n: R ? R.n : 0, word: R ? R.words[0] : 'UP', question: R ? R.q : '' });
  }

  // The line card: connection, counts and the switches. The only place a permission is asked.
  async function lineInfo() {
    var c = DR.store.cfg(), line = DR.store.line(), k = DR.store.counts() || {};
    var mic = await DR.sound.micState(), geo = await DR.geo.state();
    var townsOn = A.prefs.towns && geo === 'granted';
    var marks = [LINE_WORD[line] || 'NOT SET'], lines = [], acts = [];
    if (num(k.clockOffMin) && Math.abs(k.clockOffMin) > CLOCK_OFF_MIN) marks.push('CLOCK OFF');
    if (k.registryMismatch) marks.push('UPDATE THE APP');
    if (c && !c.refused) lines.push('CONNECTED AS ' + (c.device || 'THIS PHONE'));
    else if (c && c.refused) lines.push('HOME REFUSED THIS KEY. OPEN A NEW CONNECT LINK FROM THE MAC.');
    else lines.push('NOT CONNECTED. OPEN A CONNECT LINK FROM THE MAC.');
    var home = DR.store.home(), synced = A.lastSync || (home && Date.parse(home.now)) || 0;
    lines.push(synced ? 'LAST SYNC ' + clockOf(synced) : 'NO SYNC YET');
    if (k.refused > 0) lines.push(count(k.refused) + ' NOT TAKEN');
    if (k.breathsNotHome > 0) lines.push(count(k.breathsNotHome) + ' BREATHS NOT HOME');
    var status = ['MIC ' + (mic === 'granted' ? 'ON' : 'OFF'), 'TOWNS ' + (townsOn ? 'ON' : 'OFF'), 'MOVING GUARD ' + (A.prefs.guard ? 'ON' : 'OFF')];
    lines.push(status.join(' · '));
    if (A.noBook) lines.push(NO_BOOK);
    if (A.note && status.indexOf(A.note) < 0) lines.push(A.note);   // never the status line twice
    lines.push('SHELL ' + (A.sw.version || DR.VERSION));
    if (c && !c.refused) acts.push({ id: 'sync', label: 'SYNC NOW' });
    acts.push(mic === 'granted' ? { id: 'check', label: 'MIC CHECK' } : { id: 'mic', label: 'MIC ON' });
    acts.push(townsOn ? { id: 'townsoff', label: 'TOWNS OFF' } : { id: 'townson', label: 'TOWNS ON' });
    acts.push({ id: 'guard', label: A.prefs.guard ? 'MOVING GUARD OFF' : 'MOVING GUARD ON' });
    if (c) acts.push({ id: 'forget', label: 'FORGET THIS KEY' });
    return { title: 'THE LINE', marks: marks, lines: lines, actions: acts };
  }
  async function lineCard() {
    if (S().busy() || A.flow) return;
    askVersion();
    for (;;) {
      if (A.mode !== 'PARKED' || blocked()) return;   // SYNC NOW, MIC ON, MIC CHECK may outlast PARKED (15.1)
      var info = await lineInfo();
      // A FORGET's settle may open the turn while the card's words are gathered: never over it (15.43).
      if (A.mode !== 'PARKED' || blocked()) return;
      var a = await overlay('card', info);
      if (a === null || A.mode !== 'PARKED') return;
      A.note = '';
      if (a === 'sync') {
        var r = await DR.store.sync();
        A.note = r && r.ok ? (r.partial ? 'SYNCING: THE REST FOLLOWS' : 'SYNCED') : r && r.status === 401 ? 'HOME REFUSED THIS KEY' : 'NO ANSWER FROM HOME';
        await settle();
      } else if (a === 'mic') {
        A.note = (await DR.sound.askMic()) === 'granted' ? 'MIC ON' : 'THE PHONE SAID NO TO THE MIC';
      } else if (a === 'check') {
        await micCheck();
      } else if (a === 'townson') {
        if ((await DR.geo.ask()) === 'granted') setPref('towns', true);
        else A.note = 'THE PHONE SAID NO TO LOCATION';
      } else if (a === 'townsoff') {
        setPref('towns', false);
      } else if (a === 'guard') {
        setPref('guard', !A.prefs.guard);
        startGuard();
      } else if (a === 'forget') {
        if (blocked()) return;                        // a flow may have begun as the card closed (15.43)
        var sure = await overlay('card', { title: 'FORGET THIS KEY?', marks: [], lines: ['The book stays on this phone. A new connect link from the Mac brings the line back.'], actions: [{ id: 'yes', label: 'FORGET IT' }, { id: 'close', label: 'KEEP IT' }] });
        if (sure === 'yes') { DR.store.forget(); paint(); }
      }
    }
  }
  async function micCheck() {
    var f = begin('record');
    if (!f) return;
    try {
      A.recording = true;
      var clip = null;
      try { clip = await DR.sound.record({ raw: true, maxMs: CHECK_MS }); } finally { A.recording = false; }   // no gate (15.6)
      if (f.dead) return;
      if (!clip) { A.note = 'MIC CHECK: THE MIC RECORDED NOTHING'; return; }   // raw: only a dead mic is empty
      await DR.sound.play(clip.blob, { maxMs: CHECK_MS + 2000 });
      A.note = 'MIC CHECK: PLAYED BACK';
    } finally { end(f); }
  }

  function guarded(fn) {
    return function (arg) {
      if (!parkedFree()) return;
      fn(arg);
    };
  }

  /* ---------- the service worker, #reset (9.9, 9.10) ---------- */

  function startSW() {
    var sw = G.navigator && G.navigator.serviceWorker;
    if (!sw || typeof sw.register !== 'function') return;
    var had = !!sw.controller;
    sw.addEventListener('controllerchange', function () {
      if (had) { A.sw.reload = true; maybeReload(); }       // never on the first install
      had = true;
      askVersion();
    });
    sw.addEventListener('message', function (e) {
      var d = e && e.data;
      if (d && d.type === 'VERSION' && typeof d.version === 'string') A.sw.version = d.version;
    });
    Promise.resolve().then(function () { return sw.register('sw.js', { scope: './', updateViaCache: 'none' }); })
      .then(function (r) { A.sw.reg = r || null; }, function () { /* no offline copy */ });
    G.setInterval(swUpdate, UPDATE_MS);
    askVersion();
  }
  function swUpdate() {
    try { var r = A.sw.reg; if (r && r.update) { var p = r.update(); if (p && p.catch) p.catch(function () {}); } } catch (e) { /* later */ }
  }
  function askVersion() {
    try {
      var sw = G.navigator && G.navigator.serviceWorker;
      if (sw && sw.controller) sw.controller.postMessage({ type: 'VERSION' });
    } catch (e) { /* nothing */ }
  }
  // A new shell reloads only at an idle point: no overlay, no recording, no flow.
  function maybeReload() {
    if (!A.sw.reload || A.flow || A.recording || A.writing || (S() && S().busy())) return;
    A.sw.reload = false;
    G.location.reload();
  }
  function scrubHash() {
    try { G.history.replaceState(null, '', G.location.pathname + G.location.search); } catch (e) { /* nothing */ }
  }
  async function doReset() {
    var r = await DR.store.resetShell();
    scrubHash();
    if (r && r.ok) { G.location.reload(); return true; }
    A.note = r && r.why === 'offline' ? 'RESET REFUSED: NO SIGNAL' : 'THE RESET DID NOT FINISH';
    return false;
  }
  async function takeConnect(link) {
    if (!link) return;
    if (!isObj(link) || !link.api) { A.note = 'THAT CONNECT LINK COULD NOT BE READ'; return; }
    var r = await DR.store.adopt(link);
    A.note = r && r.ok ? 'CONNECTED' : 'NOT CONNECTED: ' + String(r && r.why || '').toUpperCase();
    if (r && r.ok && r.synced) A.syncOk = true;      // a key is not a book: only a whole first sync is (15.23)
  }
  async function onHash() {
    var h = G.location && G.location.hash;
    if (h === '#reset') { await doReset(); return; }
    var link = DR.store.takeLink();
    if (link) { await takeConnect(link); await settle(); }
  }

  /* ---------- boot ---------- */

  async function loadRegistry() {
    for (var k = 0; k < 2; k++) {
      try {
        var r = await G.fetch('registry.json');
        if (r && r.ok) { DR.setRegistry(await r.json()); return true; }
      } catch (e) { /* try again */ }
      if (k === 0) await wait(1500);
    }
    log('the registry could not be read');
    return false;
  }

  function wire() {
    var s = S();
    s.on('stage', onStage);
    s.on('lever', onLever);
    s.on('mute', onMute);
    s.on('dock', function () { dock(); });
    s.on('dial', onDial);
    s.on('rail', onRail);
    s.on('tag', guarded(function () { tagCard(); }));
    s.on('grass', guarded(function () { heardCard(); }));
    s.on('tack', guarded(function (i) { tackCard(i); }));
    s.on('ground', onGround);
    s.on('line', guarded(function () { lineCard(); }));
    s.on('show', guarded(function () { showCounter(); }));
    var d = G.document;
    if (d && d.addEventListener) {
      d.addEventListener('pointerdown', onPointer, true);
      d.addEventListener('visibilitychange', onVisibility);
    }
    if (G.addEventListener) G.addEventListener('hashchange', function () { onHash(); });
    DR.store.on('change', onChange);
    DR.store.on('line', onLine);
  }

  async function boot() {
    var reset = !!(G.location && G.location.hash === '#reset');
    var link = reset ? null : DR.store.takeLink();       // scrubbed before any request
    await loadRegistry();
    var opened = await DR.store.open();
    if (!opened || !opened.ok) A.noBook = true;
    try { await DR.geo.load(); } catch (e) { /* no town list: no towns */ }
    S().mount();
    A.prefs = DR.store.prefs();
    DR.sound.mute(!!A.prefs.muted);
    wire();
    await refreshLocal();
    paint();                                             // it opens ROLLING
    wakeOn();
    if (reset && (await doReset())) return;
    await takeConnect(link);
    startSW();
    var r = await DR.store.sync();                       // a phone with a key always syncs first
    if (r && r.ok && !r.partial) { A.syncOk = true; A.lastSync = nowMs(); }
    if (r && r.ok) A.partial = !!r.partial;
    await settle(true);
    A.booted = true;
  }

  DR.app = {
    ready: null,
    view: view,
    mode: function () { return A.mode; },
    flow: function () { return A.flow ? A.flow.kind : null; }
  };
  DR.app.ready = boot().catch(function () { log('boot failed'); });
})();
