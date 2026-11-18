/* DOCK READ core: the pure part of the phone app (SPEC 9.11).
   No DOM, no storage, no network, no timers. The only clock read is DR.nowIso / DR.tzNow / DR.event.
   Everything hangs on window.DR in a browser (created if missing, never replaced) and is
   exported through module.exports under Node. */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var DR = G.DR || (G.DR = {});

  DR.VERSION = '0.1.0';

  var DAY_MS = 86400000;
  var BURST_MS = 20 * 60000;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var AT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
  var UTC_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/;   // as home's _THROUGH
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var PERIOD_RE = /^(\d{4}-(0[1-9]|1[0-2])|\d{6})$/;
  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var Q_RE = /^[A-Z0-9 ?'\-,.]{3,60}$/;
  var CITY_RE = /^[A-Z][A-Z .'-]{0,39}$/;
  var ST_RE = /^[A-Z]{2}$/;
  var BANNED = ['lat', 'lon', 'lng', 'coords', 'accuracy', 'address', 'zip', 'street'];
  var MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
  var MOVES = ['position', 'money', 'help', 'none'];
  var CONFS = ['confirmed', 'rule', 'own', 'none'];
  var ORIGINS = ['canon', 'flags', 'own'];
  // Series whose period is a six-digit collection cycle, not a month (SPEC 8.4, 9.5).
  var CYCLE_SERIES = ['btos_ai_use'];

  /* ---------- small helpers ---------- */

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function isStr(s) { return typeof s === 'string'; }
  // Safe range only: past 2**53 - 1 a number here is rounded while home keeps the digits, so both refuse it.
  function isInt(n) { return Number.isSafeInteger(n); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function inList(v, list) { return list.indexOf(v) >= 0; }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function instant(iso) { return isStr(iso) ? Date.parse(iso) : NaN; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function keysAre(o, keys) {
    if (!isObj(o)) return false;
    var k = Object.keys(o);
    if (k.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) if (!has(o, keys[i])) return false;
    return true;
  }

  // Order by (at, id), the instant parsed to a number (SPEC 6, "Comparing times").
  function byAtId(a, b) {
    var ta = instant(a.at), tb = instant(b.at);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /* ---------- calendar (the device's LOCAL date) ---------- */

  function localDay(iso) {
    var t = instant(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  // A YYYY-MM-DD that names a real calendar day (2026-02-30 is not one), as home's date.fromisoformat.
  function realDay(day) {
    if (!isStr(day) || !DATE_RE.test(day)) return false;
    var y = +day.slice(0, 4), m = +day.slice(5, 7), d = +day.slice(8, 10);
    var t = new Date(Date.UTC(y, m - 1, d));
    return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function dayNum(day) {
    if (!isStr(day) || !DATE_RE.test(day)) return NaN;
    return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS;
  }
  function addDays(day, k) {
    var n = dayNum(day);
    if (!isFinite(n)) return '';
    var d = new Date((n + k) * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function monthAdd(period, k) {
    var y = +period.slice(0, 4), m = +period.slice(5, 7) - 1 + k;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad2(m + 1);
  }

  /* ---------- registry ---------- */

  var REG = null;
  DR.setRegistry = function (json) {
    REG = isStr(json) ? JSON.parse(json) : json;
    return REG;
  };
  DR.registry = function () { return REG; };
  DR.lane = function (id) {
    var l = REG && REG.lanes || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  };
  DR.canon = function (lane) { return REG && REG.canon && has(REG.canon, lane) ? REG.canon[lane] : null; };
  DR.series = function (id) {
    if (!REG || !REG.series || !isStr(id) || !has(REG.series, id)) return null;
    var s = clone(REG.series[id]); s.id = id; return s;
  };
  function seriesOf(s) { return isStr(s) ? DR.series(s) : (isObj(s) ? s : null); }
  function regNum(k, dflt) { return REG && isNum(REG[k]) ? REG[k] : dflt; }

  /* ---------- ids, clock, events ---------- */

  DR.uuid = function () {
    var c = G.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase();
    var b = new Array(16), i;
    if (c && typeof c.getRandomValues === 'function') { var u = new Uint8Array(16); c.getRandomValues(u); for (i = 0; i < 16; i++) b[i] = u[i]; }
    else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = b.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
  DR.nowIso = function () { return new Date().toISOString(); };
  DR.tzNow = function () { return -new Date().getTimezoneOffset(); };
  DR.event = function (type, round, data) {
    return { id: DR.uuid(), dev: '', at: DR.nowIso(), tz: DR.tzNow(), type: type, round: round || null, data: data || {} };
  };

  /* ---------- canonical JSON (sorted keys, no spaces) ---------- */

  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (isObj(v)) {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  DR.canonical = canonical;
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  // Home cannot write half a surrogate pair as UTF-8 and refuses the event, so the phone refuses it too.
  // The raw strings are read, not DR.canonical's output: JSON.stringify writes a lone half as an escape.
  function plainText(v) {
    if (isStr(v)) return wellFormed(v);
    if (Array.isArray(v)) return v.every(plainText);
    if (isObj(v)) return Object.keys(v).every(function (k) { return wellFormed(k) && plainText(v[k]); });
    return true;
  }
  function wellFormed(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (d < 0xdc00 || d > 0xdfff) return false;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
  }

  /* ---------- validate (SPEC 6, field rules) ---------- */

  // Rule 0.3: a banned key name at any depth refuses the event.
  function bannedKey(v, depth) {
    if (depth > 20) return 'too deep';
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var r = bannedKey(v[i], depth + 1); if (r) return r; } return ''; }
    if (!isObj(v)) return '';
    var ks = Object.keys(v);
    for (var j = 0; j < ks.length; j++) {
      if (inList(ks[j].toLowerCase(), BANNED)) return 'banned key ' + ks[j];
      var r2 = bannedKey(v[ks[j]], depth + 1); if (r2) return r2;
    }
    return '';
  }

  function checkTown(city, st, places) {
    if (!isStr(city) || !CITY_RE.test(city)) return 'bad city';
    if (!isStr(st) || !ST_RE.test(st)) return 'bad st';
    if (places && !places.has(city + '|' + st)) return 'town not in list';
    return '';
  }
  function checkPlace(p, places) {
    if (p === null) return '';
    if (!keysAre(p, ['city', 'st'])) return 'bad place';
    return checkTown(p.city, p.st, places);
  }
  function checkValue(v, sid) {
    if (!isNum(v)) return 'bad value';
    var s = sid ? DR.series(sid) : null;
    if (sid && !s) return 'bad series';
    if (s && (v < s.lo || v > s.hi)) return 'value out of range';
    return '';
  }
  function checkSeriesId(s, nullable) {
    if (s === null) return nullable ? '' : 'bad series';
    return DR.series(s) ? '' : 'bad series';
  }
  function checkPrintRef(p, keys, sid) {   // {period, label, value} (+ by / series)
    if (!keysAre(p, keys)) return 'bad print';
    if (!isStr(p.period) || !PERIOD_RE.test(p.period)) return 'bad period';
    if (!isStr(p.label)) return 'bad label';
    if (has(p, 'by') && !inList(p.by, ['fetch', 'hand'])) return 'bad by';
    if (has(p, 'series')) { var e = checkSeriesId(p.series, false); if (e) return e; sid = p.series; }
    return checkValue(p.value, sid);
  }
  function checkAim(a) {
    if (!keysAre(a, ['after', 'period', 'label', 'date', 'time_et', 'conf'])) return 'bad aim';
    var ks = ['after', 'period', 'label', 'date', 'time_et', 'conf'];
    for (var i = 0; i < ks.length; i++) if (!isStr(a[ks[i]])) return 'bad aim ' + ks[i];
    if (a.after !== '' && !PERIOD_RE.test(a.after)) return 'bad aim after';     // SPEC 6.1 ruling on periods
    if (a.period !== '' && !PERIOD_RE.test(a.period)) return 'bad aim period';
    if (a.date !== '' && !realDay(a.date)) return 'bad aim date';
    if (!inList(a.conf, CONFS)) return 'bad conf';
    return '';
  }
  function checkWords(w) {
    return Array.isArray(w) && w.length === 2 &&
      ((w[0] === 'UP' && w[1] === 'DOWN') || (w[0] === 'YES' && w[1] === 'NO')) ? '' : 'bad words';
  }
  function checkQ(q) { return isStr(q) && Q_RE.test(q) && q.charAt(q.length - 1) === '?' ? '' : 'bad q'; }
  function checkSay(s) {                       // counted in code points, as home counts them
    var n = isStr(s) ? Array.from(s).length : 0;
    return n >= 3 && n <= 80 ? '' : 'bad say';
  }
  function uuidOk(x) { return isStr(x) && UUID_RE.test(x); }

  var DATA = {
    'round.opened': function (d) {
      if (!keysAre(d, ['lane', 'q', 'say', 'words', 'twin', 'origin', 'aim', 'from'])) return 'bad data keys';
      if (!DR.lane(d.lane)) return 'bad lane';
      var e = checkQ(d.q) || checkSay(d.say) || checkWords(d.words) || checkSeriesId(d.twin, true);
      if (e) return e;
      if (!inList(d.origin, ORIGINS)) return 'bad origin';
      if (d.twin !== null && d.origin !== 'canon') return 'twin only with origin canon';
      e = checkAim(d.aim); if (e) return e;
      if (d.from === null) return d.origin === 'flags' ? 'flags needs from' : '';
      if (d.origin !== 'flags') return 'from only with origin flags';
      if (!keysAre(d.from, ['day', 'taps', 'minutes'])) return 'bad from';
      if (!realDay(d.from.day)) return 'bad from day';
      if (!isInt(d.from.taps) || d.from.taps < 1 || !isInt(d.from.minutes) || d.from.minutes < 1) return 'bad from counts';
      return '';
    },
    'round.aimed': function (d) { return checkAim(d); },
    'notch.cut': function (d, places) {
      if (!keysAre(d, ['n', 'up', 'place'])) return 'bad data keys';
      if (!uuidOk(d.n)) return 'bad n';
      if (typeof d.up !== 'boolean') return 'bad up';
      return checkPlace(d.place, places);
    },
    'notch.flip': function (d) { return keysAre(d, ['n']) && uuidOk(d.n) ? '' : 'bad n'; },
    'notch.pull': function (d) { return keysAre(d, ['n']) && uuidOk(d.n) ? '' : 'bad n'; },
    'notch.place': function (d, places) {
      if (!keysAre(d, ['n', 'city', 'st'])) return 'bad data keys';
      if (!uuidOk(d.n)) return 'bad n';
      if (d.city === '' && d.st === '') return '';
      return checkTown(d.city, d.st, places);
    },
    'breath.kept': function (d) {
      if (!keysAre(d, ['b', 'of', 'ref', 'ms', 'mime'])) return 'bad data keys';
      if (!uuidOk(d.b)) return 'bad b';
      if (!inList(d.of, ['notch', 'call'])) return 'bad of';
      if (!uuidOk(d.ref)) return 'bad ref';
      if (!isInt(d.ms) || d.ms < 200 || d.ms > 30000) return 'bad ms';
      if (!isStr(d.mime) || !inList(d.mime.split(';')[0].trim().toLowerCase(), MIMES)) return 'bad mime';
      return '';
    },
    'breath.dropped': function (d) { return keysAre(d, ['b']) && uuidOk(d.b) ? '' : 'bad b'; },
    'print.hand': function (d) {
      if (!keysAre(d, ['series', 'period', 'label', 'value'])) return 'bad data keys';
      var e = checkSeriesId(d.series, false); if (e) return e;
      if (!isStr(d.period) || !PERIOD_RE.test(d.period)) return 'bad period';
      if (!isStr(d.label)) return 'bad label';
      return checkValue(d.value, d.series);
    },
    'call.made': function (d) {
      if (!keysAre(d, ['c', 'lane', 'series', 'from', 'up', 'docks', 'inside'])) return 'bad data keys';
      if (!uuidOk(d.c)) return 'bad c';
      if (!DR.lane(d.lane)) return 'bad lane';
      var e = checkSeriesId(d.series, true); if (e) return e;
      if (d.series === null ? d.up !== null : typeof d.up !== 'boolean') return 'bad up';
      if (d.from !== null) {
        if (d.series === null) return 'from needs a series';
        e = checkPrintRef(d.from, ['period', 'label', 'value', 'by'], d.series); if (e) return e;
      }
      if (!keysAre(d.docks, ['u', 'n']) || !isInt(d.docks.u) || !isInt(d.docks.n) ||
          d.docks.u < 0 || d.docks.u > d.docks.n || d.docks.n > 10000) return 'bad docks';
      if (d.inside !== null && typeof d.inside !== 'boolean') return 'bad inside';
      return '';
    },
    'call.move': function (d) {
      if (!keysAre(d, ['c', 'move'])) return 'bad data keys';
      if (!uuidOk(d.c)) return 'bad c';
      return inList(d.move, MOVES) ? '' : 'bad move';
    },
    'call.graded': function (d) {
      if (!keysAre(d, ['c', 'grade', 'print', 'base'])) return 'bad data keys';
      if (!uuidOk(d.c)) return 'bad c';
      if (d.grade !== 1 && d.grade !== 0 && d.grade !== null) return 'bad grade';
      return checkPrintRef(d.print, ['period', 'label', 'value'], null) ||
             checkPrintRef(d.base, ['period', 'label', 'value'], null);
    },
    'round.closed': function (d) {
      if (!keysAre(d, ['reason', 'print'])) return 'bad data keys';
      if (!inList(d.reason, ['print', 'own'])) return 'bad reason';
      if (d.print === null) return '';
      return checkPrintRef(d.print, ['series', 'period', 'label', 'value', 'by'], null);
    },
    'field.cut': function (d) {
      if (!keysAre(d, ['through'])) return 'bad data keys';
      return isStr(d.through) && UTC_RE.test(d.through) && realDay(d.through.slice(0, 10)) &&
        isFinite(Date.parse(d.through)) ? '' : 'bad through';
    }
  };
  DR.TYPES = Object.keys(DATA);

  // round: required uuid, except breath.dropped (uuid or null) and field.cut (null).
  function checkRound(type, r) {
    if (type === 'field.cut') return r === null ? '' : 'round must be null';
    if (type === 'breath.dropped' && r === null) return '';
    return uuidOk(r) ? '' : 'bad round';
  }

  DR.validate = function (event, places) {
    try {
      if (!isObj(event)) return 'not an object';
      if (!uuidOk(event.id)) return 'bad id';
      if (!isStr(event.dev) || event.dev.length > 64) return 'bad dev';
      if (!isStr(event.at) || !AT_RE.test(event.at) || !isFinite(Date.parse(event.at)) ||
          new Date(Date.parse(event.at)).toISOString() !== event.at ||
          +event.at.slice(0, 4) < 1) return 'bad at';                               // home has no year 0000
      if (!isInt(event.tz) || event.tz < -720 || event.tz > 840) return 'bad tz';   // as home: -12h to +14h
      if (!isStr(event.type) || !has(DATA, event.type)) return 'unknown type';
      var e = checkRound(event.type, event.round); if (e) return e;
      if (!isObj(event.data)) return 'bad data';
      e = bannedKey(event, 0); if (e) return e;
      if (utf8Len(canonical(event.data)) > 2000) return 'data too big';
      if (!plainText(event.data)) return 'bad text';
      var pl = places ? (typeof places.has === 'function' ? places : new Set(places)) : null;
      return DATA[event.type](event.data, pl);
    } catch (x) {
      return 'unreadable';
    }
  };

  /* ---------- prints ---------- */

  function homePrints(homeSeries, sid) {
    var s = isObj(homeSeries) ? homeSeries[sid] : null;
    if (Array.isArray(s)) return s;
    return isObj(s) && Array.isArray(s.prints) ? s.prints : [];
  }
  function homeUpcoming(homeSeries, sid) {
    var s = isObj(homeSeries) ? homeSeries[sid] : null;
    return isObj(s) && Array.isArray(s.upcoming) ? s.upcoming : [];
  }
  function cleanPrint(p, by) {
    return {
      period: p.period, label: isStr(p.label) ? p.label : '', value: p.value, by: by || p.by || 'fetch',
      source: isStr(p.source) ? p.source : '', url: isStr(p.url) ? p.url : '',
      released: isStr(p.released) ? p.released : '', fetched_at: isStr(p.fetched_at) ? p.fetched_at : ''
    };
  }
  function byPeriod(a, b) { return a.period < b.period ? -1 : a.period > b.period ? 1 : 0; }

  // SPEC 6.1 step 6: per series ascending by period; a home print beats a by-hand one.
  DR.mergePrints = function (homeSeries, hand) {
    var out = {}, sids = {}, k;
    if (isObj(homeSeries)) for (k in homeSeries) if (has(homeSeries, k)) sids[k] = 1;
    if (isObj(hand)) for (k in hand) if (has(hand, k)) sids[k] = 1;
    Object.keys(sids).forEach(function (sid) {
      var m = {};
      (isObj(hand) && Array.isArray(hand[sid]) ? hand[sid] : []).forEach(function (h) {
        if (!isObj(h) || !isStr(h.period) || !isNum(h.value)) return;
        var p = cleanPrint({ period: h.period, label: h.label, value: h.value, source: 'BY HAND', fetched_at: h.at }, 'hand');
        m[h.period] = p;
      });
      homePrints(homeSeries, sid).forEach(function (p) {
        if (!isObj(p) || !isStr(p.period) || !isNum(p.value)) return;
        m[p.period] = cleanPrint(p);
      });
      out[sid] = Object.keys(m).map(function (x) { return m[x]; }).sort(byPeriod);
    });
    return out;
  };

  function pick(p) { return { period: p.period, label: p.label, value: p.value }; }

  // SPEC 15.12: the month a monthly call waits on (the one right after from.period). The BTOS cycle has
  // no fixed next id, so a cycle call waits on no one period.
  DR.awaitedPeriod = function (call) {
    if (!isObj(call) || !isStr(call.series) || !isObj(call.from) || !isStr(call.from.period)) return null;
    if (inList(call.series, CYCLE_SERIES) || !MONTH_RE.test(call.from.period)) return null;
    var p = monthAdd(call.from.period, 1);
    return { period: p, label: DR.periodLabel(p) };
  };

  // SPEC 6.1 and 15.12: the grade a print gives a call. Written once as call.graded, then frozen (rule 0.5).
  // A monthly call is graded only by the month he called; a later month would grade a call he never made.
  DR.gradeFor = function (call, prints) {
    if (!isObj(call) || !isStr(call.series) || !isObj(call.from) || typeof call.up !== 'boolean') return null;
    var list = isObj(prints) && Array.isArray(prints[call.series]) ? prints[call.series] : [];
    var from = call.from, print = null, base = null, i;
    var cycle = inList(call.series, CYCLE_SERIES), want = cycle ? null : DR.awaitedPeriod(call);
    if (!cycle && !want) return null;
    for (i = 0; i < list.length; i++) {
      if (cycle ? list[i].period > from.period : list[i].period === want.period) { print = list[i]; break; }
    }
    if (!print) return null;
    for (i = 0; i < list.length; i++) if (list[i].period === from.period) { base = list[i]; break; }
    base = base || from;
    var grade = print.value > base.value ? (call.up ? 1 : 0) : print.value < base.value ? (call.up ? 0 : 1) : null;
    return { grade: grade, print: pick(print), base: pick(base) };
  };

  function seenDay(p) {
    if (isStr(p.released) && DATE_RE.test(p.released)) return p.released;
    return isStr(p.fetched_at) ? p.fetched_at.slice(0, 10) : '';
  }
  function withSeries(p, sid) { var o = clone(p); o.series = sid; return o; }

  // SPEC 6.1 closing print, four rules in order. registry is optional (defaults to the one set).
  DR.closingPrint = function (round, prints, registry) {
    if (!isObj(round) || !round.twin) return null;
    var sid = round.twin, aim = round.aim || {};
    var list = isObj(prints) && Array.isArray(prints[sid]) ? prints[sid] : [];
    var minDays = registry && isNum(registry.min_round_days) ? registry.min_round_days : regNum('min_round_days', 7);
    // A hand print set after the round closed (SPEC 15.12: the month a call waits on) is for the call's
    // grade, not the rail: it must not change what a closed round closed on.
    var shut = round.closed ? instant(round.closedAt) : NaN;
    var i, hands = (round.hands || []).filter(function (h) {
      return h.series === sid && !(instant(h.at) > shut);
    });
    if (hands.length) {                                                          // (1) his hand print
      var per = hands[hands.length - 1].period;
      for (i = 0; i < list.length; i++) if (list[i].period === per) return withSeries(list[i], sid);
    }
    if (aim.period) {                                                            // (2) the awaited period
      for (i = 0; i < list.length; i++) if (list[i].period >= aim.period) return withSeries(list[i], sid);
      return null;
    }
    if (aim.after) {                                                             // (3) a later period, seen late enough
      var opened = dayNum(localDay(round.openedAt));
      for (i = 0; i < list.length; i++) {
        if (list[i].period <= aim.after) continue;
        if (dayNum(seenDay(list[i])) - opened >= minDays) return withSeries(list[i], sid);
      }
    }
    return null;                                                                 // (4)
  };

  // SPEC 6.1 due: 'in' | 'own' | 'late' | 'open', by the device's local date.
  DR.due = function (round, prints, nowIso) {
    if (!isObj(round)) return 'open';
    if (DR.closingPrint(round, prints)) return 'in';
    var date = round.aim && round.aim.date, today = localDay(nowIso || DR.nowIso());
    if (!date) return 'open';
    if (!round.twin) return today >= date ? 'own' : 'open';
    return today > date ? 'late' : 'open';
  };

  DR.tag = function (round, prints, nowIso) {
    if (!isObj(round)) return { text: '', lamp: false, rule: false };
    var d = DR.due(round, prints, nowIso);
    if (d === 'in') return { text: 'IN', lamp: true, rule: false };
    if (d === 'own') return { text: 'DUE', lamp: true, rule: false };
    if (d === 'late') return { text: 'LATE', lamp: true, rule: false };
    var date = round.aim && round.aim.date;
    return { text: date ? DR.dateLabel(date) : '', lamp: false, rule: !!date && round.aim.conf === 'rule' };
  };

  /* ---------- the reducer (SPEC 6.1) ---------- */

  function emptyState() {
    return { rounds: [], active: null, tacks: [], asked: {}, cutThrough: null, lastClosed: null,
             breaths: {}, hand: {}, prints: {} };
  }

  // Step 1: valid only, dedupe by id (a copy with a dev wins), sort by (at, id).
  function cleanEvents(events) {
    var seen = {}, out = [];
    (Array.isArray(events) ? events : []).forEach(function (e) {
      if (DR.validate(e, null)) return;
      var prev = seen[e.id];
      if (!prev) { seen[e.id] = e; out.push(e); return; }
      if (prev.dev === '' && e.dev !== '') { out[out.indexOf(prev)] = e; seen[e.id] = e; }
    });
    return out.sort(byAtId);
  }

  function mkRound(e, shadow) {
    var d = e.data;
    return { id: e.round, lane: d.lane, q: d.q, say: d.say, words: d.words.slice(), twin: d.twin,
             origin: d.origin, aim: clone(d.aim), from: clone(d.from), openedAt: e.at, closedAt: null,
             closed: false, shadow: shadow, notches: [], u: 0, n: 0, call: null,
             close: null, hands: [], aliases: [] };
  }

  // Step 3: one open round at a time; a same lane + q opening is an alias, any other a shadow.
  function walkRounds(list, opened) {
    var w = { rounds: [], byId: {}, alias: {}, open: null };
    var pending = {};
    function close(R, e) {
      if (!R || R.closed) return;
      R.closed = true; R.closedAt = e.at; R.close = clone(e.data);
      if (w.open === R) w.open = null;
    }
    list.forEach(function (e) {
      if (e.type === 'round.opened') {
        if (opened[e.round] !== e) return;
        var o = w.open;
        if (o && o.lane === e.data.lane && o.q === e.data.q) {
          w.alias[e.round] = o.id; o.aliases.push(e.round);
        } else {
          var R = mkRound(e, !!o);
          w.rounds.push(R); w.byId[R.id] = R;
          if (!o) w.open = R;
        }
        if (pending[e.round]) close(resolve(w, e.round), pending[e.round]);
      } else if (e.type === 'round.closed') {
        if (!opened[e.round]) return;
        var t = resolve(w, e.round);
        if (!t) { if (!pending[e.round]) pending[e.round] = e; return; }  // a close that sorts before its open
        close(t, e);
      }
    });
    return w;
  }
  function resolve(w, id) { return w.byId[w.alias[id] || id] || null; }

  function placeOf(p) { return p ? { city: p.city, st: p.st } : null; }

  function attachMakers(list, w, ix) {
    list.forEach(function (e) {
      var R, d = e.data;
      if (e.type === 'notch.cut' && ix.cuts[d.n] === e) {
        R = resolve(w, e.round); if (!R) return;
        var N = { n: d.n, up: d.up, at: e.at, tz: e.tz, place: placeOf(d.place), breath: null, dev: e.dev, pulled: false, round: R.id };
        R.notches.push(N); ix.notch[d.n] = N;
      } else if (e.type === 'call.made' && ix.calls[d.c] === e) {
        R = resolve(w, e.round); if (!R || R.call) return;                     // first call per round only
        R.call = { c: d.c, up: d.up, at: e.at, from: clone(d.from), docks: clone(d.docks), inside: d.inside,
                   move: null, why: null, grade: null, graded: null, pending: null,
                   series: d.series, lane: d.lane, round: R.id };
        ix.call[d.c] = R.call;
      }
    });
  }

  function breathTarget(d, ix) {
    if (d.of === 'notch') { var N = ix.notch[d.ref]; return N && !N.pulled ? N : null; }
    return ix.call[d.ref] || null;
  }

  // Step 4: changers in (at, id) order, whatever their clock says against what they name.
  function applyChangers(list, w, ix, st) {
    var droppedB = {};     // every breath id named by a breath.dropped, wherever its clock put it
    list.forEach(function (e) {
      var d = e.data, N, C, R, B;
      switch (e.type) {
        case 'notch.flip': N = ix.notch[d.n]; if (N && !N.pulled) N.up = !N.up; break;
        case 'notch.pull': N = ix.notch[d.n]; if (N) N.pulled = true; break;
        case 'notch.place':
          N = ix.notch[d.n]; if (N && !N.pulled) N.place = d.city ? { city: d.city, st: d.st } : null; break;
        case 'breath.kept':
          if (st.breaths[d.b]) break;
          var T = breathTarget(d, ix); if (!T) break;
          st.breaths[d.b] = { of: d.of, ref: d.ref, ms: d.ms, mime: d.mime, round: T.round, dropped: false };
          if (d.of === 'notch') T.breath = d.b; else T.why = d.b;
          break;
        case 'breath.dropped':
          droppedB[d.b] = true;                                                   // applied after the walk
          break;
        case 'call.move': C = ix.call[d.c]; if (C && C.move === null) C.move = d.move; break;
        case 'call.graded':
          C = ix.call[d.c]; if (!C || C.graded) break;                            // first per c wins
          C.grade = d.grade; C.graded = { grade: d.grade, print: clone(d.print), base: clone(d.base), at: e.at };
          break;
        case 'round.aimed':
          R = resolve(w, e.round); if (!R) break;
          ['period', 'label', 'date', 'time_et', 'conf'].forEach(function (k) { R.aim[k] = d[k]; });
          if (R.aim.after === '') R.aim.after = d.after;
          break;
      }
    });
    // A drop holds whatever its time against the keep (two phones, two clocks): the audio is gone at home.
    Object.keys(droppedB).forEach(function (b) {
      var B = st.breaths[b]; if (!B) return;
      B.dropped = true;
      var T = B.of === 'notch' ? ix.notch[B.ref] : ix.call[B.ref];
      if (T && B.of === 'notch' && T.breath === b) T.breath = null;
      if (T && B.of === 'call' && T.why === b) T.why = null;
    });
  }

  // Step 5: by-hand prints; the newest for one (series, period) wins.
  function collectHand(list, w) {
    var m = {};
    list.forEach(function (e) {
      if (e.type !== 'print.hand') return;
      var d = e.data;
      m[d.series] = m[d.series] || {};
      m[d.series][d.period] = { period: d.period, label: d.label, value: d.value, by: 'hand', at: e.at };
      var R = resolve(w, e.round);
      if (R) R.hands.push({ series: d.series, period: d.period, at: e.at });
    });
    var out = {};
    Object.keys(m).forEach(function (s) { out[s] = Object.keys(m[s]).map(function (p) { return m[s][p]; }).sort(byPeriod); });
    return out;
  }

  function finishRound(R, prints) {
    R.notches = R.notches.filter(function (N) { return !N.pulled; }).map(function (N) {
      return { n: N.n, up: N.up, at: N.at, tz: N.tz, place: N.place, breath: N.breath, dev: N.dev };
    });
    R.n = R.notches.length;
    R.u = R.notches.filter(function (N) { return N.up; }).length;
    if (R.call) R.call.pending = R.call.graded ? null : DR.gradeFor(R.call, prints);
  }

  DR.reduce = function (events, homeSeries, nowIso) {
    var st = emptyState();
    try {
      var list = cleanEvents(events);
      var ix = { opened: {}, cuts: {}, calls: {}, notch: {}, call: {} };
      list.forEach(function (e) {                                                  // step 2: makers indexed
        var d = e.data;
        if (e.type === 'round.opened' && !ix.opened[e.round]) ix.opened[e.round] = e;
        if (e.type === 'notch.cut' && !ix.cuts[d.n]) ix.cuts[d.n] = e;
        if (e.type === 'call.made' && !ix.calls[d.c]) ix.calls[d.c] = e;
        if (e.type === 'round.opened') st.asked[d.lane] = e.at;
        if (e.type === 'field.cut') st.cutThrough = d.through;
        if (e.type === 'round.closed') st.lastClosed = e.at;
      });
      var w = walkRounds(list, ix.opened);                                         // step 3
      attachMakers(list, w, ix);
      applyChangers(list, w, ix, st);                                              // step 4
      st.hand = collectHand(list, w);                                              // step 5
      st.prints = DR.mergePrints(isObj(homeSeries) ? homeSeries : {}, st.hand);    // step 6
      w.rounds.forEach(function (R) { finishRound(R, st.prints); });
      st.rounds = w.rounds;
      st.active = w.open && !w.open.closed ? w.open : null;
      // A shadow round is never drawn: its call makes no tack (SPEC 6.1 ruling).
      st.tacks = w.rounds.filter(function (R) { return R.call && !R.shadow; }).map(function (R) {
        var C = R.call;
        return { round: R.id, lane: C.lane, c: C.c, up: C.up, at: C.at, grade: C.grade, graded: C.graded };
      }).sort(function (a, b) { return byAtId({ at: a.at, id: a.c }, { at: b.at, id: b.c }); });
    } catch (x) {
      return emptyState();
    }
    return st;
  };

  /* ---------- aim, re-aim, the print by hand, offers (SPEC 9.5, 9.6) ---------- */

  function newestPeriod(homeSeries, sid) {
    var l = homePrints(homeSeries, sid).filter(function (p) { return isObj(p) && isStr(p.period); });
    var best = '';
    l.forEach(function (p) { if (p.period > best) best = p.period; });
    return best;
  }
  function firstUpcoming(homeSeries, sid, fromDay) {
    var l = homeUpcoming(homeSeries, sid).filter(function (u) { return isObj(u) && isStr(u.date) && DATE_RE.test(u.date); });
    l.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    for (var i = 0; i < l.length; i++) if (l[i].date >= fromDay) return l[i];
    return null;
  }

  DR.aimFor = function (offer, homeSeries, nowIso) {
    var today = localDay(nowIso || DR.nowIso());
    var twin = offer && offer.twin;
    if (!twin) {
      return { after: '', period: '', label: '', date: addDays(today, regNum('own_round_days', 30)), time_et: '', conf: 'own' };
    }
    var aim = { after: newestPeriod(homeSeries, twin), period: '', label: '', date: '', time_et: '', conf: 'none' };
    var up = firstUpcoming(homeSeries, twin, addDays(today, regNum('min_round_days', 7)));
    if (up) {
      aim.period = isStr(up.period) ? up.period : ''; aim.label = isStr(up.label) ? up.label : '';
      aim.date = up.date; aim.time_et = isStr(up.time_et) ? up.time_et : '';
      aim.conf = inList(up.conf, ['confirmed', 'rule']) ? up.conf : 'rule';
    }
    return aim;
  };

  function sameAim(a, b) {
    return ['after', 'period', 'label', 'date', 'time_et', 'conf'].every(function (k) { return a[k] === b[k]; });
  }

  DR.reaim = function (round, homeSeries, nowIso) {
    if (!isObj(round) || !round.twin || !isObj(round.aim) || round.closed) return null;
    var a = clone(round.aim);
    if (a.after === '') a.after = newestPeriod(homeSeries, round.twin);
    if (a.conf === 'none') {
      var f = DR.aimFor({ twin: round.twin }, homeSeries, nowIso);
      if (f.date) { a.period = f.period; a.label = f.label; a.date = f.date; a.time_et = f.time_et; a.conf = f.conf; }
    } else if (a.period) {
      var up = homeUpcoming(homeSeries, round.twin).filter(function (u) { return isObj(u) && u.period === a.period && isStr(u.date) && DATE_RE.test(u.date); })[0];
      if (up && (up.date !== a.date || (up.time_et || '') !== a.time_et || (up.conf && up.conf !== a.conf))) {
        a.date = up.date; a.time_et = isStr(up.time_et) ? up.time_et : '';
        if (inList(up.conf, ['confirmed', 'rule'])) a.conf = up.conf;
        if (isStr(up.label) && up.label) a.label = up.label;
      }
    }
    return sameAim(a, round.aim) ? null : a;
  };

  DR.handPeriod = function (round, homeSeries, nowIso) {
    if (!isObj(round) || !round.twin) return null;
    var aim = round.aim || {};
    if (aim.period) return { period: aim.period, label: aim.label || DR.periodLabel(aim.period) };
    if (inList(round.twin, CYCLE_SERIES)) return null;                           // off until home gives a schedule
    var p;
    if (aim.after && MONTH_RE.test(aim.after)) p = monthAdd(aim.after, 1);
    else { var t = localDay(nowIso || DR.nowIso()); p = monthAdd(t.slice(0, 7), -1); }
    return { period: p, label: DR.periodLabel(p) };
  };

  DR.offers = function (afterLane, proposals) {
    var order = REG && REG.turn_order || [];
    var start = order.indexOf(afterLane) + 1, out = [];
    for (var i = 0; i < order.length; i++) {
      var lane = order[(start + i) % order.length], c = DR.canon(lane);
      if (c) out.push({ lane: lane, q: c.q, say: c.say, words: c.words.slice(), twin: c.twin, origin: 'canon', from: null });
      var ps = isObj(proposals) && Array.isArray(proposals[lane]) ? proposals[lane] : [];
      ps.slice(0, 1).forEach(function (p) {
        if (!isObj(p) || checkQ(p.q) || checkSay(p.say) || checkWords(p.words)) return;
        if (!realDay(p.day) || !isInt(p.taps) || p.taps < 1 || !isInt(p.minutes) || p.minutes < 1) return;   // as validate's from
        out.push({ lane: lane, q: p.q, say: p.say, words: p.words.slice(), twin: null, origin: 'flags',
                   from: { day: p.day, taps: p.taps, minutes: p.minutes } });
      });
    }
    return out;
  };

  /* ---------- the dial (SPEC 6.2; maths and colours from the mockup) ---------- */

  DR.share = function (u, n) { return n > 0 ? 100 * u / n : null; };
  DR.beamHalf = function (n) { return n > 0 ? 50 / Math.sqrt(n) : null; };
  DR.inside = function (v, n, p) {
    if (!(n > 0) || !isNum(v) || !isNum(p)) return false;
    return Math.abs(p - v) <= 50 / Math.sqrt(n) + 1e-9;
  };
  DR.angle = function (v) { return isNum(v) ? (v - 50) * 2.4 : 180; };   // no docks: plumb on the peg
  function mix(c1, c2, t) {
    var o = '#';
    for (var i = 0; i < 3; i++) {
      var a = parseInt(c1.substr(1 + i * 2, 2), 16), b = parseInt(c2.substr(1 + i * 2, 2), 16);
      o += ('0' + Math.round(a + (b - a) * t).toString(16)).slice(-2);
    }
    return o;
  }
  DR.heat = function (v) {
    v = Math.max(0, Math.min(100, isNum(v) ? v : 50));
    return v < 50 ? mix('#4FA3F7', '#EFE7D6', v / 50) : v < 85 ? mix('#EFE7D6', '#FF8A1F', (v - 50) / 35) : mix('#FF8A1F', '#FF5A1F', (v - 85) / 15);
  };

  /* ---------- the field (SPEC 9.6, drawing the field) ---------- */

  function tallestBurst(items) {
    var best = null, j = 0;
    for (var i = 0; i < items.length; i++) {
      while (items[i].t - items[j].t > BURST_MS) j++;
      var cnt = i - j + 1;
      if (cnt >= 5 && (!best || cnt >= best.n)) best = { from: j, to: i, n: cnt };  // ties: the newest
    }
    var set = {};
    if (best) for (var k = best.from; k <= best.to; k++) set[k] = 1;
    return set;
  }
  function groupDays(items) {
    var m = {}, days = [];
    items.forEach(function (x) { if (!m[x.day]) { m[x.day] = []; days.push(x.day); } m[x.day].push(x); });
    days.sort();
    return { m: m, days: days };
  }

  DR.fieldDays = function (flags, cutThrough, nowIso) {
    var cut = cutThrough ? instant(cutThrough) : NaN, items = [];
    (Array.isArray(flags) ? flags : []).forEach(function (f) {
      if (!Array.isArray(f) || !isStr(f[1])) return;
      var t = instant(f[1]), day = f[1].slice(0, 10);                            // a flag's day: its first ten characters
      if (isFinite(t) && DATE_RE.test(day)) items.push({ id: f[0], t: t, day: day });
    });
    items.sort(function (a, b) { return a.t - b.t || (String(a.id) < String(b.id) ? -1 : 1); });
    var standing = [], baled = [];
    items.forEach(function (x) { (isFinite(cut) && !(x.t > cut) ? baled : standing).push(x); });
    var tall = tallestBurst(standing);
    standing.forEach(function (x, i) { x.tall = !!tall[i]; });
    var g = groupDays(standing), allRows = g.days.map(function (d, k) {
      var list = g.m[d], idx = [];
      list.forEach(function (x, i) { if (x.tall) idx.push(i); });
      return { d: d, n: list.length, gapBefore: k > 0 && dayNum(d) - dayNum(g.days[k - 1]) > 7, tall: idx.length ? idx : null };
    });
    var keep = 20, far = null, rows = allRows;
    if (allRows.length > keep) {
      var old = allRows.slice(0, allRows.length - keep);
      far = { days: old.length, n: old.reduce(function (s, r) { return s + r.n; }, 0) };
      rows = allRows.slice(allRows.length - keep);
    }
    var b = groupDays(baled), bales = b.days.map(function (d) { return { d: d, n: b.m[d].length }; }), stack = null;
    if (bales.length > 14) {
      var older = bales.slice(0, bales.length - 14);
      stack = { days: older.length, n: older.reduce(function (s, r) { return s + r.n; }, 0) };
      bales = bales.slice(bales.length - 14);
    }
    var drawn = rows.length + (far ? 1 : 0);
    var pitch = drawn <= 12 ? 9 : Math.max(5, 9 - (drawn - 12) * 0.5);
    return { rows: rows, far: far, bales: bales, stack: stack, standing: standing.length, baled: baled.length, pitch: pitch };
  };

  // The board: full warm at 0 days since asked, cold char at 120 (SPEC 9.6).
  DR.warmth = function (askedAt, nowIso) {
    var a = instant(askedAt), n = instant(nowIso || DR.nowIso());
    if (!isFinite(a) || !isFinite(n)) return 0;
    return Math.max(0, Math.min(1, 1 - (n - a) / DAY_MS / 120));
  };

  /* ---------- numbers and dates as words ---------- */

  var ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
  var TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
  function under100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10) - 2] + (n % 10 ? '-' + ONES[n % 10] : ''); }
  function under1000(n) {
    var h = Math.floor(n / 100), r = n % 100, out = [];
    if (h) out.push(ONES[h] + ' hundred');
    if (r || !h) out.push(under100(r));
    return out.join(' ');
  }
  DR.num = function (n) {
    if (!isInt(n) || n < 0 || n > 999999) return String(n);
    var th = Math.floor(n / 1000), r = n % 1000;
    if (!th) return under1000(r);
    return under1000(th) + ' thousand' + (r ? ' ' + under1000(r) : '');
  };
  function bigNum(n) {   // up to the millions, for counts past num's range
    if (n <= 999999) return DR.num(n);
    var m = Math.floor(n / 1000000), r = n % 1000000;
    return DR.num(m) + ' million' + (r ? ' ' + DR.num(r) : '');
  }
  function decimalWords(s) {   // "55.5" -> "fifty-five point five"; a whole number has no "point zero"
    var parts = s.split('.'), whole = bigNum(parseInt(parts[0], 10)), frac = (parts[1] || '').replace(/0+$/, '');
    return frac ? whole + ' point ' + frac.split('').map(function (c) { return ONES[+c]; }).join(' ') : whole;
  }
  function commas(s) {
    var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  var ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
  DR.ordinal = function (n) {
    var w = DR.num(n);
    if (!isInt(n) || n < 0 || n > 999999) return w;
    var m = /([a-z]+)$/.exec(w), last = m[1], head = w.slice(0, w.length - last.length);
    var o = ORD[last] || (/y$/.test(last) ? last.slice(0, -1) + 'ieth' : last + 'th');
    return head + o;
  };

  DR.sayValue = function (value, series) {
    var s = seriesOf(series);
    if (!isNum(value)) return 'no number';
    if (s && s.unit === 'dollars per kWh') {
      var c = (value * 100).toFixed(1), w = decimalWords(c);
      return w + (c === '1.0' ? ' cent' : ' cents') + ' a kilowatt hour';
    }
    if (s && s.unit === 'applications') return 'about ' + bigNum(Math.round(value / 1000) * 1000);
    var d = s && isInt(s.decimals) ? s.decimals : 1;
    return (value < 0 ? 'minus ' : '') + decimalWords(Math.abs(value).toFixed(d));
  };
  DR.showValue = function (value, series) {
    var s = seriesOf(series);
    if (!isNum(value)) return '';
    if (s && s.unit === 'dollars per kWh') return (value * 100).toFixed(1) + '¢';
    var d = s && isInt(s.decimals) ? s.decimals : 1;
    return commas(value.toFixed(d));
  };
  DR.levelMove = function (prev, cur) {
    if (!isNum(prev) || !isNum(cur) || prev === 0) return null;
    var pct = Math.round(Math.abs((cur - prev) / prev) * 1000) / 10;
    // A print that moved at all reads UP or DOWN, never EVEN, even under a tenth of a percent (SPEC 15.15).
    var dir = cur === prev ? 'EVEN' : cur > prev ? 'UP' : 'DOWN';
    var text = dir === 'EVEN' ? 'EVEN' : pct === 0 ? dir + ' <0.1%' : dir + ' ' + pct.toFixed(1) + '%';
    return { dir: dir, pct: pct, text: text };
  };

  var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  DR.periodLabel = function (period) {
    if (!isStr(period)) return '';
    return MONTH_RE.test(period) ? MON[+period.slice(5, 7) - 1] + ' ' + period.slice(0, 4) : period;
  };
  DR.dateLabel = function (iso) {
    if (!isStr(iso) || !DATE_RE.test(iso)) return '';
    return MON[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10));
  };
  DR.sayDate = function (iso) {
    if (!isStr(iso) || !DATE_RE.test(iso)) return '';
    return MONTHS[+iso.slice(5, 7) - 1] + ' ' + DR.ordinal(+iso.slice(8, 10));
  };

  /* ---------- spoken lines (SPEC 9.3 to 9.6, 9.8): every line the app says is built here ---------- */

  // AI is always written "A.I." in spoken text (SPEC 9.8).
  function spoken(s) { return s.replace(/\bAI\b/g, 'A.I.').replace(/\s+/g, ' ').trim(); }
  function sentence(s) { s = cap(s); return /[.?!]$/.test(s) ? s : s + '.'; }
  function docksPhrase(u, n, word) { return DR.num(u) + ' of ' + DR.num(n) + ' ' + String(word || '').toLowerCase(); }
  function beamSentence(inside) { return inside ? 'Inside your beam.' : 'Outside your beam.'; }
  function laneSay(id) { var l = DR.lane(id); return l ? l.say : String(id || ''); }

  function tagSentence(round, prints, nowIso) {
    var d = DR.due(round, prints, nowIso), aim = round.aim || {}, date = aim.date ? DR.sayDate(aim.date) : '';
    var rule = aim.conf === 'rule' ? ', by rule' : '';
    if (!round.twin) {
      if (d === 'own') return 'This one is only yours. The rail is due.';
      return 'This one is only yours.' + (date ? ' The rail closes ' + date + '.' : '');
    }
    if (d === 'in') return "Print's in.";
    if (!date) return '';
    if (d === 'late') return 'Print was due ' + date + rule + '.';
    return 'Print ' + date + rule + '.';
  }

  DR.lines = {
    // After a thumb (SPEC 9.4): "Up. Four of six."
    notch: function (up, words, u, n) {
      var w = (words || ['UP', 'DOWN'])[up ? 0 : 1];
      return spoken(cap(String(w).toLowerCase()) + '. ' + cap(DR.num(u)) + ' of ' + DR.num(n) + '.');
    },
    // The ROLLING read (SPEC 9.3): question, read, tag.
    read: function (round, prints, nowIso) {
      if (!isObj(round)) return 'No question open.';
      var r = round.n ? sentence(docksPhrase(round.u, round.n, round.words[0])) : 'No docks yet.';
      return spoken([sentence(round.say), r, tagSentence(round, prints, nowIso)].join(' '));
    },
    // The moment's line with no docks (SPEC 9.5 step 5).
    noDocks: function (print, series) {
      var sid = series || (print && print.series);
      return spoken("Print's in. " + sentence(DR.sayValue(print && print.value, sid)) + ' No docks this round. Call the next one.');
    },
    // The moment's line (SPEC 9.5 step 5). Level twins get no beam sentence.
    printIn: function (round, print) {
      var sid = (print && print.series) || round.twin, s = DR.series(sid);
      if (!round.n) return DR.lines.noDocks(print, sid);
      var out = ["Print's in.", sentence(DR.sayValue(print.value, sid)),
                 'Your docks: ' + docksPhrase(round.u, round.n, round.words[0]) + '.'];
      if (s && s.scale === 'share') out.push(beamSentence(DR.inside(DR.share(round.u, round.n), round.n, print.value)));
      if (s && s.compare) out.push(s.compare);
      out.push('Call the next one.');
      return spoken(out.join(' '));
    },
    // A rail with no twin, on its date (SPEC 9.5).
    ownClose: function (round) {
      var r = round.n ? sentence(docksPhrase(round.u, round.n, round.words[0])) : 'No docks this round.';
      return spoken("No print for this one. It's only yours. " + r + ' What did the docks tell you?');
    },
    yours: function () { return "That one's yours."; },
    // The first offer after a cut (SPEC 9.6).
    turn: function (offer) { return spoken("Field's cut. " + DR.lines.offer(offer)); },
    // One offer; prev = the offer before it, so a second offer in the same lane skips "Next lane".
    offer: function (offer, prev) {
      var out = [];
      if (!prev || prev.lane !== offer.lane) out.push(sentence('Next lane, ' + laneSay(offer.lane)));
      if (offer.origin === 'flags' && isObj(offer.from)) {
        var f = offer.from;
        out.push('Tallest in ' + laneSay(offer.lane) + ': the ' + DR.ordinal(+String(f.day).slice(8, 10)) + ', ' +
                 DR.num(f.taps) + (f.taps === 1 ? ' tap' : ' taps') + ' in ' + DR.num(f.minutes) +
                 (f.minutes === 1 ? ' minute.' : ' minutes.'));
      }
      out.push('Dock question: ' + offer.say + ' Take it?');
      return spoken(out.join(' '));
    },
    // The heard card (SPEC 9.3): "The gist:" then the machine's line.
    heard: function (line) { return spoken('The gist: ' + sentence(String(line || '').trim())); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DR;
})();
