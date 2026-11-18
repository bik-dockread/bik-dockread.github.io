/* DOCK READ geo: the town finder (SPEC 0.3, 9.4 step 3, 9.10a, 9.11).
   Rule 0.3: the coordinates of a fix exist only inside this file, in local variables of the
   callback that receives the fix, for as long as it takes to find the nearest town. They are never
   returned, stored, logged, put in an error, or handed to any other module. What leaves this file is
   {city, st} from the town list, or null.
   ask() is the only function here that may trigger the browser's location prompt. Everything else
   checks the permission first and does nothing unless it is already granted.
   The pure part (nearest) is exported through module.exports for Node tests. */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var DR = G.DR || (G.DR = {});

  var LIMIT_KM = 40;             // no town inside this: no place (9.4 step 3)
  var R_FLOOR_KM = 0.75;         // the smallest circle a town gets: the list keeps a centre to a hundredth of a degree (about a km), and a smaller circle could miss the town's own true centre
  var R10_MAX = 5000;            // 500 km: the list's own ceiling for a radius; a bigger one is a broken row
  var NEAR_OUT = 1.25;           // a spot this far out of a town's circle (x its radius) still leans to that town over a bare centre
  var FIX_MS = 8000;             // one fix, at most this long (9.4 step 3)
  var MOVING_MPS = 6.7;          // 15 mph: the moving guard fires at or above this (9.3)
  var FIND_MAX = 8;              // DR.geo.find returns at most this many
  var TOWNS_K = 5;               // the TOWN picker's default count (9.3)
  var EARTH_KM = 6371;
  var PLACES_URL = 'places.json';
  var CITY_RE = /^[A-Z][A-Z .'-]{0,39}$/;
  var ST_RE = /^[A-Z]{2}$/;

  var rows = [];                 // [[CITY, ST, lat100, lon100, r10]] : town centres and sizes from the list, never his position
  var placeSet = new Set();
  var loading = null;

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function nav() { return G.navigator || null; }
  function geoApi() { var n = nav(); return n && n.geolocation ? n.geolocation : null; }

  /* ---------- the list ---------- */

  function adopt(json) {
    var out = [], set = new Set();
    var list = json && Array.isArray(json.rows) ? json.rows : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!Array.isArray(r) || r.length !== 5) continue;
      if (typeof r[0] !== 'string' || !CITY_RE.test(r[0])) continue;
      if (typeof r[1] !== 'string' || !ST_RE.test(r[1])) continue;
      if (!isInt(r[2]) || !isInt(r[3]) || !isInt(r[4]) || r[4] < 0 || r[4] > R10_MAX) continue;
      out.push(r);
      set.add(r[0] + '|' + r[1]);
    }
    rows = out;
    placeSet = set;
  }

  // Reads places.json once. Never throws; a failed read leaves the list empty and may be retried.
  function load() {
    if (loading) return loading;
    var f = G.fetch;
    if (typeof f !== 'function') return Promise.resolve();
    loading = Promise.resolve()
      .then(function () { return f(PLACES_URL); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('places');
        return res.json();
      })
      .then(function (json) { adopt(json); })
      .catch(function () { loading = null; });
    return loading;
  }

  function places() { return placeSet; }

  function find(prefix) {
    var p = String(prefix == null ? '' : prefix).trim().toUpperCase();
    if (!p) return [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < FIND_MAX; i++) {
      if (rows[i][0].indexOf(p) === 0) out.push({ city: rows[i][0], st: rows[i][1] });
    }
    out.sort(function (a, b) { return a.city < b.city ? -1 : a.city > b.city ? 1 : (a.st < b.st ? -1 : a.st > b.st ? 1 : 0); });
    return out;
  }

  /* ---------- the pure part ---------- */

  // The k towns that best name (lat, lon), from rows ([[CITY, ST, lat100, lon100, r10]]) within LIMIT_KM.
  // A town is its centre and a circle of its land's area (r10 tenths of a km, at least R_FLOOR_KM). The best
  // first: (1) towns whose circle holds the spot, the smallest circle first, so a suburb inside a big city's
  // circle keeps its own name; (2) towns the spot is just outside (within NEAR_OUT x r), by d / r; (3) the
  // rest, nearest first. A big city's Census centre can sit kilometres from its downtown, so plain nearest
  // centre named the wrong town there (SPEC 9.10a). Ties by name, then state. Pure: the arguments are read,
  // nothing is kept, and only {city, st} leaves.
  function nearest(lat, lon, list, k) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return [];
    if (!Array.isArray(list)) return [];
    k = isInt(k) && k > 0 ? k : 1;
    var rad = Math.PI / 180;
    var la1 = lat * rad;
    var cosLa1 = Math.cos(la1);
    var latBox = (LIMIT_KM / EARTH_KM) / rad * 100 * 1.01;               // in list units (deg x 100)
    var lonBox = cosLa1 > 0.01 ? latBox / cosLa1 : 36000;
    var lat100 = lat * 100, lon100 = lon * 100;
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!Array.isArray(r) || r.length < 4) continue;
      if (Math.abs(r[2] - lat100) > latBox) continue;
      var dl = Math.abs(r[3] - lon100);
      if (dl > 18000) dl = 36000 - dl;
      if (dl > lonBox) continue;
      var la2 = (r[2] / 100) * rad;
      var dLa = la2 - la1;
      var dLo = (r[3] / 100 - lon) * rad;
      var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + cosLa1 * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
      var d = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
      if (d > LIMIT_KM) continue;
      var r10 = isInt(r[4]) && r[4] > 0 ? r[4] : 0;      // a row with no size is a point: the floor circle
      var rk = Math.max(r10 / 10, R_FLOOR_KM);
      // group 1 sorts by circle size then distance; group 2 by d / r; group 3 by distance
      var g = d <= rk ? 1 : d <= NEAR_OUT * rk ? 2 : 3;
      hits.push({ g: g, a: g === 1 ? r10 : g === 2 ? d / rk : d, b: g === 1 ? d : 0, city: r[0], st: r[1] });
    }
    hits.sort(function (a, b) {
      if (a.g !== b.g) return a.g - b.g;
      if (a.a !== b.a) return a.a - b.a;
      if (a.b !== b.b) return a.b - b.b;
      return a.city < b.city ? -1 : a.city > b.city ? 1 : (a.st < b.st ? -1 : a.st > b.st ? 1 : 0);
    });
    var out = [];
    for (var j = 0; j < hits.length && out.length < k; j++) out.push({ city: hits[j].city, st: hits[j].st });
    return out;
  }

  /* ---------- the permission ---------- */

  function state() {
    var n = nav();
    if (!n || !n.permissions || typeof n.permissions.query !== 'function') return Promise.resolve('unknown');
    return Promise.resolve()
      .then(function () { return n.permissions.query({ name: 'geolocation' }); })
      .then(function (s) {
        var v = s && s.state;
        return v === 'granted' || v === 'prompt' || v === 'denied' ? v : 'unknown';
      })
      .catch(function () { return 'unknown'; });
  }

  // The only function that may trigger the prompt. The fix it takes is thrown away unread.
  function ask() {
    var g = geoApi();
    if (!g) return Promise.resolve('denied');
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      try {
        g.getCurrentPosition(
          function () { finish('granted'); },
          function (err) {
            if (err && err.code === 1) { finish('denied'); return; }
            state().then(function (s) { finish(s === 'granted' ? 'granted' : 'denied'); });
          },
          { enableHighAccuracy: false, timeout: FIX_MS, maximumAge: 0 });
      } catch (e) { finish('denied'); }
    });
  }

  /* ---------- one fix ---------- */

  // One fix, at most FIX_MS. Only when already granted. The fix is read inside the callback and
  // reduced to towns there; what resolves is towns only.
  function fixTowns(k) {
    return Promise.all([load(), state()]).then(function (got) {
      var g = geoApi();
      if (got[1] !== 'granted' || !g || !rows.length) return [];
      return new Promise(function (resolve) {
        var done = false, timer = null;
        function finish(v) {
          if (done) return;
          done = true;
          if (timer !== null) G.clearTimeout(timer);
          resolve(v);
        }
        timer = G.setTimeout(function () { finish([]); }, FIX_MS);
        try {
          g.getCurrentPosition(
            function (p) {
              var found = [];
              try { found = nearest(p.coords.latitude, p.coords.longitude, rows, k); } catch (e) { found = []; }
              finish(found);
            },
            function () { finish([]); },
            { enableHighAccuracy: false, timeout: FIX_MS, maximumAge: 0 });
        } catch (e) { finish([]); }
      });
    }).catch(function () { return []; });
  }

  function town() {
    return fixTowns(1).then(function (list) { return list.length ? list[0] : null; });
  }

  function towns(k) {
    return fixTowns(isInt(k) && k > 0 ? k : TOWNS_K);
  }

  /* ---------- the moving guard ---------- */

  // Best effort, only if location is already granted. Calls onMoving() (no arguments) whenever a reading
  // shows a speed at or above MOVING_MPS. Speed is read from the reading only, never worked out from
  // positions. Returns stop().
  function guard(onMoving) {
    var stopped = false, watchId = null;
    function stop() {
      stopped = true;
      var g = geoApi();
      if (watchId !== null && g && typeof g.clearWatch === 'function') {
        try { g.clearWatch(watchId); } catch (e) { /* nothing to do */ }
      }
      watchId = null;
    }
    if (typeof onMoving !== 'function') return stop;
    state().then(function (s) {
      var g = geoApi();
      if (stopped || s !== 'granted' || !g || typeof g.watchPosition !== 'function') return;
      try {
        watchId = g.watchPosition(
          function (p) {
            if (stopped) return;
            var v = p && p.coords ? p.coords.speed : null;
            if (typeof v === 'number' && isFinite(v) && v >= MOVING_MPS) {
              try { onMoving(); } catch (e) { /* the caller's problem, never a coordinate */ }
            }
          },
          function () { /* best effort: nothing */ },
          { enableHighAccuracy: true, maximumAge: 5000 });
      } catch (e) { watchId = null; }
    });
    return stop;
  }

  DR.geo = {
    load: load,
    places: places,
    find: find,
    nearest: nearest,
    town: town,
    towns: towns,
    ask: ask,
    guard: guard,
    state: state
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { nearest: nearest, LIMIT_KM: LIMIT_KM };
})();
