/* DOCK READ surface: everything he sees (SPEC 9.1 to 9.7, 9.11).
   It draws and reports touches. It decides nothing, stores nothing, calls no network.
   Needs js/core.js loaded first (DR.angle, DR.heat, DR.share, DR.beamHalf).

   THE CONTRACT (app.js is built against this comment)
   ====================================================
   The page holds one element <div id="dr" class="dr">. DR.surface.mount() builds everything inside it with
   createElement / createElementNS (no markup strings, ever) and is safe to call twice. render() mounts by
   itself if needed. Every string handed in reaches the page through textContent.

   DR.surface.mount()            build the frame once; listens to resize and visibilitychange itself
   DR.surface.fit()              rescale the 390 x 844 design box: min(w / 390, h / 844) of the area inside the
                                 safe-area insets, centred. Overlays are never scaled (real CSS px and vw / dvh).

   DR.surface.render(view)       the whole resting frame from one plain object. Idempotent; cheap to call again.
     view = {
       mode:    'ROLLING' | 'PARKED',          // case-insensitive; anything else is ROLLING
       line:    'home' | 'none' | 'unset',      // lamp word HOME / NO LINE / NOT SET (unknown -> 'unset')
       muted:   bool,                           // SOUND / MUTED on the mute button(s)
       lit:     bool,                           // false = dark dial; with n === 0 the face reads NO DOCKS YET
       words:   ['UP','DOWN'] | ['YES','NO'],   // [a, b]: a at the right shoulder in ember, b at the left in blue
       u:       int, n: int,                    // docks up / docks; lit && n > 0 -> needle, figure, beam
       plate:   string,                         // '' = blank brass. Shown only in PARKED (ROLLING: always blank)
       tag:     {text, lamp, rule},             // DR.tag(): text '' | 'DEC 1' | 'IN' | 'DUE' | 'LATE';
                                                // lamp = glow; rule = hollow (outlined) letters
       hand:    number | null,                  // the print on the 0..100 dial (share twins only), or null
       notches: [ {up: bool, tag: bool} ],      // oldest first; up = first word; tag = a paper tag (a breath)
       brands:  [ {id, brand, state: 'hot'|'warm'|'never', warmth: 0..1} ],   // board order, left to right
       tacks:   [ {lane, grade: 1|0|null} ],    // lane = a brand id; 1 bright, 0 dull, null plain brass
       field:   <DR.fieldDays(...) result> | null,   // redrawn only when it differs from the last one drawn
       labels:  {field, horizon, ground} | null,     // strings; drawn only in PARKED ('' hides one)
       dock:    bool                            // JUST LEFT A DOCK bar (drawn only in PARKED)
     }
     ROLLING shows only: the figure, the shoulder words, NO DOCKS YET, the tag stamp, the five brands, the
     lamp word, SOUND / MUTED and the lever's two words (SPEC 9.3). The surface enforces this itself: in
     ROLLING the plate, the labels, SHOW and JUST LEFT A DOCK are hidden whatever view says.
     render() also resets the moment-only marks: bridge, arrow, bezel glow and retrace.
     Going ROLLING -> PARKED brightens the plate once.

   The moment's pieces (each one draws only; nothing is remembered as truth):
     needle(v | null)            spring the fat needle to v (0..100); null = plumb on its peg, dulled.
                                 Springs only when the target changes (stiffness 170, damping 18, overshoot
                                 under 3 degrees) and stops itself; snaps when hidden or reduced motion.
     hand(v | null)              the thin brass hand at v; null hides it.
     bridge(a, b | null)         bone-white arc between a and b; b null hides it.
     arrow(v, up | null)         brass arrowhead on the bezel at v, pointing toward the first word if up,
                                 else toward the second; v or up null hides it.
     bezel(level)                bezel glow, 0..1 (0 = off).
     plate(text, {flip, pulse})  the plate's text (still blank while ROLLING); flip / pulse are bools.
     figure(u, n, word | null)   '7 of 11 UP'; u null = blank (never zero); word null = no word.
     beam(v, n)                  light the heat arc around v by 50 / sqrt(n); n 0 = the dark arc.
     tag(text, {lamp, rule})     the tin tag; a change of text flips it.
     retrace(i | null)           notches 0..i-1 lit, i bright, the rest dim; -1 = all dim; null = normal.

   Overlays (cover the viewport; each kind holds one; opening a kind again resolves the old one null):
     halves({a, b, seam, sub, see, drainMs})     -> Promise<'a' | 'b' | null>
         a = top word (ember), b = bottom word (blue), seam = text on the brass seam, see = see-through,
         sub = a small line above the seam's text (the figure a call is made from; SPEC 15.38),
         drainMs > 0 = the seam drains and resolves null after it; 0 / null = no timer.
         A sideways swipe (60 px) resolves null.
     bands({seam, options: [string], drainMs})  -> Promise<index | null>    (swipe or drain -> null)
     card({title, marks: [string], lines: [string], actions: [{id, label}]})  -> Promise<actionId | null>
         marks are stamped labels ('HEARD, NOT YOURS'); lines are plain text, case kept.
         A tap on the dark around the card resolves null. If no action has id 'close', a CLOSE button
         that resolves null is added at the end.
     entry({title, kind: 'number' | 'text', hint, max})  -> Promise<string | null>
         OK (or Enter) resolves the input's raw value (not trimmed, not upper-cased); CANCEL resolves null.
     counter({u, n, word, question})        -> Promise<null>   needle, beam, figure, question; no hand, no
         print, no tacks. The corner mark turns it 180 degrees; any other tap resolves.
     closeAll()                  resolve every open overlay with null and clear its timers.
     busy() -> bool              true while any overlay is open.
     While an overlay is open a second mute button shows in its corner (rule 0.7); it emits 'mute'.

   Touches: DR.surface.on(name, cb) -> off(). cb gets no argument unless noted.
     ROLLING: 'stage'  (any tap above the strip except the mute), 'mute', 'lever'.
     PARKED:  'dial', 'rail' ({i, hold}), 'tag', 'grass', 'tack' (i = index into view.tacks), 'ground',
              'line' (the lamp), 'show', 'mute', 'lever', 'dock'. A tap on the plate or the board reports nothing.
     'rail': i = the notch nearest the touch (-1 with none). A press held 1 s reports {i, hold: true} at
     once, and its release reports nothing more; a shorter tap reports {i, hold: false}.
*/
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;
  var DR = G.DR || (G.DR = {});

  var NS = 'http://www.w3.org/2000/svg';
  var BOX_W = 390, BOX_H = 844;
  var CX = 164;                        // dial centre in its own 328 x 328 box
  var CUTS_W = 254, NOTCH_W = 12, PITCH = 16, GROUP_GAP = 6;
  var FIELD_W = 358, FIELD_H = 130, FIELD_PX = 2;
  var BOARD_W = 358, LANES = 5;
  var HOLD_MS = 1000, MOVE_PX = 16, SWIPE_PX = 60, GONE_MS = 300, PULSE_MS = 450;
  var LINE_WORD = { home: 'HOME', none: 'NO LINE', unset: 'NOT SET' };
  var CHAR = '#2B221B', WARM = '#B5571A';

  var doc = null, root = null, safe = null, box = null, ov = null, omute = null;
  var R = {};                          // the frame's parts
  var HIT = typeof WeakMap === 'function' ? new WeakMap() : null;
  var scale = 1, mounted = false, hidden = false;
  var listeners = {};
  var S = {
    parked: null, words: ['UP', 'DOWN'], notches: [], lit: null, tagText: null, fieldKey: undefined,
    plateText: '', tacks: [], muted: false, press: null, swallow: false
  };
  var OPEN = {};                       // kind -> {node, resolve, timers}

  /* ---------- small helpers ---------- */

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function int(x) { return num(x) ? Math.max(0, Math.floor(x)) : 0; }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function rm() {
    try { return !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function later(fn, ms) { return G.setTimeout(fn, ms); }
  function el(tag, cls, parent, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (parent) parent.appendChild(e);
    return e;
  }
  function sv(tag, attrs, parent) {
    var e = doc.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function btn(cls, label, parent, text) {
    var b = el('button', cls, parent, text);
    b.setAttribute('type', 'button');
    b.setAttribute('aria-label', label);
    return b;
  }
  function clear(e) { e.textContent = ''; }
  function mark(e, name, i) { if (HIT) HIT.set(e, { name: name, i: i }); else e.__drHit = { name: name, i: i }; }
  function hitOf(t) {
    for (var e = t; e && e !== root; e = e.parentNode) {
      var h = HIT ? HIT.get(e) : e.__drHit;
      if (h) return h;
    }
    return null;
  }
  // A listener that throws must not stop the others; its error is rethrown on its own turn (loud, not lost).
  function emitArg(name, arg) {
    (listeners[name] || []).slice().forEach(function (cb) {
      try { cb(arg); } catch (x) { G.setTimeout(function () { throw x; }, 0); }
    });
  }
  function restart(e, cls) {             // replay a one-shot CSS animation
    e.classList.remove(cls);
    void e.offsetWidth;
    e.classList.add(cls);
  }
  function angle(v) { return DR.angle ? DR.angle(v) : (num(v) ? (v - 50) * 2.4 : 180); }
  function heat(v) { return DR.heat ? DR.heat(v) : '#EFE7D6'; }
  function pt(a, r) {
    var t = a * Math.PI / 180;
    return (CX + r * Math.sin(t)).toFixed(2) + ' ' + (CX - r * Math.cos(t)).toFixed(2);
  }
  function arc(a1, a2, r) {
    return 'M' + pt(a1, r) + 'A' + r + ' ' + r + ' 0 ' + (Math.abs(a2 - a1) > 180 ? 1 : 0) + ' ' + (a2 > a1 ? 1 : 0) + ' ' + pt(a2, r);
  }
  function mix(c1, c2, t) {
    var o = '#';
    t = Math.max(0, Math.min(1, num(t) ? t : 0));
    for (var i = 0; i < 3; i++) {
      var a = parseInt(c1.substr(1 + i * 2, 2), 16), b = parseInt(c2.substr(1 + i * 2, 2), 16);
      o += ('0' + Math.round(a + (b - a) * t).toString(16)).slice(-2);
    }
    return o;
  }
  function wordsOk(w) {
    return Array.isArray(w) && w.length === 2 && typeof w[0] === 'string' && typeof w[1] === 'string';
  }

  /* ---------- the dial (built for the stage, and again for the counter view) ---------- */

  function buildDial(parent, withDefs) {
    var d = {};
    d.svg = sv('svg', { 'class': 'dr-dial', viewBox: '0 0 328 328', role: 'img', 'aria-label': 'Dock read dial' }, parent);
    if (withDefs) {
      var defs = sv('defs', {}, d.svg);
      var bz = sv('linearGradient', { id: 'dr-bz', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      sv('stop', { offset: 0, 'stop-color': '#F6DE8E' }, bz);
      sv('stop', { offset: 0.45, 'stop-color': '#E5B524' }, bz);
      sv('stop', { offset: 1, 'stop-color': '#8A6A1E' }, bz);
      var hb = sv('linearGradient', { id: 'dr-hb', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      sv('stop', { offset: 0, 'stop-color': '#4a4034' }, hb);
      sv('stop', { offset: 1, 'stop-color': '#1c1712' }, hb);
    }
    sv('circle', { cx: CX, cy: CX, r: 159, fill: '#14110E', stroke: 'url(#dr-bz)', 'stroke-width': 10 }, d.svg);
    d.bg = sv('circle', { 'class': 'dr-bg', cx: CX, cy: CX, r: 159, fill: 'none', stroke: '#FFF3C4', 'stroke-width': 10, opacity: 0 }, d.svg);
    sv('circle', { cx: CX, cy: CX, r: 153.5, fill: 'none', stroke: '#000', 'stroke-opacity': 0.7, 'stroke-width': 1.5 }, d.svg);
    var sgs = sv('g', { 'class': 'dr-sgs' }, d.svg);
    d.segs = [];
    for (var i = 0; i < 60; i++) {
      var a = -120 + i * 4;
      d.segs.push(sv('path', { 'class': 'dr-seg', d: arc(a + 0.35, a + 3.65, 136), fill: 'none', 'stroke-width': 14, stroke: heat((i + 0.5) / 60 * 100) }, sgs));
    }
    d.bw = sv('path', { 'class': 'dr-bw', d: '', fill: 'none', stroke: '#EFE7D6', 'stroke-width': 14, opacity: 0 }, d.svg);
    var tks = sv('g', { 'class': 'dr-tks' }, d.svg);
    for (var k = 0; k <= 20; k++) {
      var b = -120 + k * 12, big = k % 5 === 0;
      sv('path', { d: 'M' + pt(b, big ? 111 : 117) + 'L' + pt(b, 125), stroke: '#EFE7D6', 'stroke-width': big ? 3 : 1.5 }, tks);
    }
    sv('path', { d: 'M164 19l6.5 9-6.5 9-6.5-9z', fill: '#E5B524', stroke: '#8A6A1E' }, d.svg);   // EVEN diamond
    d.nd0 = sv('text', { 'class': 'dr-nd0', x: CX, y: 96, 'text-anchor': 'middle' }, d.svg);
    var t1 = sv('tspan', { x: CX }, d.nd0); t1.textContent = 'NO DOCKS';
    var t2 = sv('tspan', { x: CX, dy: 36 }, d.nd0); t2.textContent = 'YET';
    d.fig = sv('text', { 'class': 'dr-fig', x: CX, y: 266, 'text-anchor': 'middle' }, d.svg);
    d.ph = sv('g', { 'class': 'dr-ph', opacity: 0 }, d.svg);
    d.ph.style.transform = 'rotate(180deg)';
    sv('line', { x1: CX, y1: CX, x2: CX, y2: 14, stroke: '#E5B524', 'stroke-width': 3 }, d.ph);
    sv('path', { d: 'M164 20l7 10-7 10-7-10z', fill: '#14110E', stroke: '#E5B524', 'stroke-width': 2.5 }, d.ph);
    d.ar = sv('g', { 'class': 'dr-ar', opacity: 0 }, d.svg);
    sv('path', { d: 'M156 -4L176 5L156 14Z', fill: '#FFF3C4', stroke: '#17120D', 'stroke-width': 1.5 }, d.ar);
    d.ng = sv('g', { transform: 'rotate(180 164 164)' }, d.svg);
    d.nd = sv('path', { 'class': 'dr-nd peg', d: 'M156 164L161.5 26L166.5 26L172 164L169 186L159 186Z', stroke: '#0D0B09', 'stroke-width': 1 }, d.ng);
    sv('circle', { cx: 174.5, cy: 288, r: 4.5, fill: '#E5B524', stroke: '#8A6A1E' }, d.svg);   // the peg pin
    sv('circle', { cx: CX, cy: CX, r: 17, fill: 'url(#dr-hb)', stroke: '#8A6A1E', 'stroke-width': 3 }, d.svg);
    sv('circle', { cx: CX, cy: CX, r: 5, fill: '#E5B524' }, d.svg);
    return d;
  }

  function drawFigure(d, u, n, word) {
    clear(d.fig);
    if (u === null || u === undefined) return;
    var a = sv('tspan', { 'font-size': 52 }, d.fig); a.textContent = String(int(u));
    var o = sv('tspan', { 'class': 'dr-of', 'font-size': 24, dx: 8 }, d.fig); o.textContent = 'of';
    var b = sv('tspan', { 'font-size': 52, dx: 8 }, d.fig); b.textContent = String(int(n));
    if (word !== null && word !== undefined && word !== '') {
      var w = sv('tspan', { 'font-size': 28, dx: 9 }, d.fig); w.textContent = String(word);
    }
  }
  function drawBeam(d, v, n) {
    n = int(n);
    var hw = n ? 50 / Math.sqrt(n) : 0, on = n ? (0.34 + 0.66 * (1 - hw / 50)) : 0;
    for (var i = 0; i < 60; i++) {
      var sv0 = (i + 0.5) / 60 * 100;
      d.segs[i].style.opacity = String(n ? (Math.abs(sv0 - v) <= hw + 0.9 ? +on.toFixed(3) : 0.13) : 0.18);
    }
  }

  /* ---------- the needle spring: stiffness 170, damping 18; runs only on a real change ---------- */

  var nd = { a: 180, v: 0, t: 180, raf: 0, last: 0, dir: 1 };
  function drawNeedle() { R.dial.ng.setAttribute('transform', 'rotate(' + nd.a.toFixed(2) + ' 164 164)'); }
  function needleTo(t) {
    if (Math.abs(t) === 180) t = nd.a < 0 ? -180 : 180;                    // the peg, on the side it hangs
    else if (Math.abs(nd.a) > 179.5 && !nd.raf) nd.a = t < 0 ? -180 : 180;   // leave the peg on the near side
    if (t === nd.t && !nd.raf && nd.a === t) return;                        // no real change: no script runs
    nd.t = t; nd.dir = t >= nd.a ? 1 : -1;
    if (rm() || hidden || !G.requestAnimationFrame) { stopNeedle(); return; }
    if (!nd.raf) { nd.last = 0; nd.raf = G.requestAnimationFrame(stepNeedle); }
  }
  function stepNeedle(ts) {
    var dt = nd.last ? Math.min(0.034, (ts - nd.last) / 1000) : 0.016;
    nd.last = ts;
    for (var i = 0; i < 2; i++) { nd.v += (170 * (nd.t - nd.a) - 18 * nd.v) * dt / 2; nd.a += nd.v * dt / 2; }
    if ((nd.a - nd.t) * nd.dir > 2.6) { nd.a = nd.t + 2.6 * nd.dir; nd.v = 0; }      // overshoot under 3 degrees
    if (Math.abs(nd.t - nd.a) < 0.06 && Math.abs(nd.v) < 0.6) { nd.a = nd.t; nd.v = 0; nd.raf = 0; drawNeedle(); return; }
    drawNeedle();
    nd.raf = G.requestAnimationFrame(stepNeedle);
  }
  function stopNeedle() {
    if (nd.raf && G.cancelAnimationFrame) G.cancelAnimationFrame(nd.raf);
    nd.raf = 0; nd.a = nd.t; nd.v = 0;
    if (R.dial) drawNeedle();
  }

  /* ---------- mount and fit ---------- */

  function mount() {
    if (mounted) return;
    doc = G.document;
    root = doc.getElementById('dr');
    if (!root) { root = el('div', 'dr', doc.body); root.setAttribute('id', 'dr'); }
    root.classList.add('dr');
    root.classList.add('rolling');
    clear(root);
    safe = el('div', 'dr-safe', root);
    box = el('div', 'dr-box', safe);
    var stage = el('div', 'dr-stage', box);
    R.stage = stage;
    R.glow = el('div', 'dr-glow', stage);

    // top line: lamp, SHOW, mute
    var top = el('div', 'dr-top', stage);
    R.lamp = btn('dr-lamp unset', 'The line home', top);
    el('i', 'dr-lampdot', R.lamp);
    R.lampWord = el('span', 'dr-lampword', R.lamp, 'NOT SET');
    mark(R.lamp, 'line');
    R.show = btn('dr-show', 'Show the count across a counter', top, 'SHOW');
    R.show.hidden = true;
    mark(R.show, 'show');
    R.mute = btn('dr-mute', 'Mute sound and voice', top, 'SOUND');
    mark(R.mute, 'mute');

    // the dial
    R.dial = buildDial(stage, true);
    mark(R.dial.svg, 'dial');
    R.ewD = el('span', 'dr-ew dn', stage, 'DOWN');
    R.ewU = el('span', 'dr-ew up', stage, 'UP');

    // the plate
    R.plate = el('div', 'dr-pl dr-plate', stage);
    R.plateSpan = el('span', '', R.plate);

    // the field window, behind the rail
    R.fieldw = el('div', 'dr-fieldw', stage);
    mark(R.fieldw, 'grass');
    R.canvas = el('canvas', 'dr-field', R.fieldw);
    R.canvas.width = FIELD_W * FIELD_PX;
    R.canvas.height = FIELD_H * FIELD_PX;
    R.labHz = el('div', 'dr-lab hz', R.fieldw);
    R.labField = el('div', 'dr-lab hd', R.fieldw);

    // the rail: knife, cuts, tin tag
    R.rail = el('div', 'dr-rail', stage);
    mark(R.rail, 'rail');
    var knife = el('div', 'dr-knife', R.rail);
    var ks = sv('svg', { viewBox: '0 0 16 30', width: 20, height: 38, 'aria-hidden': 'true' }, knife);
    sv('path', { d: 'M5 1h6a2 2 0 0 1 2 2v15H3V3a2 2 0 0 1 2-2z', fill: '#6e2b19' }, ks);
    sv('rect', { x: 3, y: 1, width: 10, height: 4, rx: 1.5, fill: '#E5B524' }, ks);
    sv('rect', { x: 3, y: 15, width: 10, height: 4, fill: '#E5B524' }, ks);
    sv('path', { d: 'M4.5 19h7l-.6 11h-5.8z', fill: '#cfd6d8' }, ks);
    sv('path', { d: 'M8 19v11', stroke: '#7b8487' }, ks);
    R.cuts = el('div', 'dr-cuts', R.rail);
    R.tag = btn('dr-tag', 'The tin tag: the next print', R.rail);
    R.tagSpan = el('span', '', R.tag);
    mark(R.tag, 'tag');

    // the board and his ground
    R.board = el('div', 'dr-board', stage);
    R.ground = el('div', 'dr-ground', stage);
    mark(R.ground, 'ground');
    R.labYr = el('div', 'dr-lab yr', R.ground);
    R.tacks = el('div', 'dr-tacks', R.ground);

    // the strip: the lever, and in PARKED the brass bar
    R.strip = el('div', 'dr-strip', box);
    mark(R.strip, 'strip');
    R.lever = btn('dr-lever', 'Rolling or parked', R.strip);
    el('b', 'r', R.lever, 'ROLLING');
    el('b', 'p', R.lever, 'PARKED');
    mark(R.lever, 'lever');
    R.dock = btn('dr-dock', 'Just left a dock', R.strip);
    el('span', '', R.dock, 'JUST LEFT');
    el('span', '', R.dock, 'A DOCK');
    R.dock.hidden = true;
    mark(R.dock, 'dock');

    // the overlay layer: never scaled
    ov = el('div', 'dr-ov', root);
    omute = btn('dr-omute', 'Mute sound and voice', root, 'SOUND');
    omute.hidden = true;
    omute.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); emitArg('mute'); });

    box.addEventListener('click', onClick);
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', endPress);
    box.addEventListener('pointercancel', endPress);
    root.addEventListener('contextmenu', function (e) { if (e && e.preventDefault) e.preventDefault(); });
    if (G.addEventListener) {
      G.addEventListener('resize', fit);
      G.addEventListener('orientationchange', fit);
    }
    if (doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
    mounted = true;
    onVis();
    fit();
  }

  function fit() {
    if (!mounted) return;
    var w = safe.clientWidth, h = safe.clientHeight;
    if (!w || !h) return;
    scale = Math.min(w / BOX_W, h / BOX_H);
    box.style.transform = 'translate(' + ((w - BOX_W * scale) / 2).toFixed(1) + 'px,' +
      ((h - BOX_H * scale) / 2).toFixed(1) + 'px) scale(' + scale.toFixed(4) + ')';
  }

  function onVis() {
    hidden = !!(doc && doc.hidden);
    root.classList.toggle('hid', hidden);
    if (hidden) stopNeedle();
  }

  /* ---------- touches ---------- */

  function onClick(e) {
    var h = hitOf(e.target);
    var name = h ? h.name : '';
    if (name === 'mute') return emitArg('mute');
    if (name === 'lever') return emitArg('lever');
    if (name === 'dock') { if (S.parked) emitArg('dock'); return; }
    if (name === 'strip') return;
    if (!S.parked) return emitArg('stage');
    if (name === 'rail') {
      if (S.swallow) { S.swallow = false; return; }
      return emitArg('rail', { i: nearestNotch(e.clientX), hold: false });
    }
    if (name === 'tack') return emitArg('tack', h.i);
    if (name === 'dial' || name === 'tag' || name === 'grass' || name === 'ground' || name === 'line' || name === 'show') return emitArg(name);
  }
  function onDown(e) {
    S.swallow = false;
    endPress();
    if (!S.parked) return;
    var h = hitOf(e.target);
    if (!h || h.name !== 'rail') return;
    var p = { x: e.clientX, y: e.clientY, i: nearestNotch(e.clientX), t: 0 };
    p.t = later(function () {
      if (S.press !== p) return;
      S.press = null; S.swallow = true;
      emitArg('rail', { i: p.i, hold: true });
    }, HOLD_MS);
    S.press = p;
  }
  function onMove(e) {
    var p = S.press;
    if (p && (Math.abs(e.clientX - p.x) > MOVE_PX || Math.abs(e.clientY - p.y) > MOVE_PX)) endPress();
  }
  function endPress() {
    if (S.press) { G.clearTimeout(S.press.t); S.press = null; }
  }

  // Notch layout: 16 px pitch, a 6 px breath after every fifth, tightening to fit the 254 px of rail.
  function notchLayout(n) {
    var groups = n > 0 ? Math.floor((n - 1) / 5) : 0, room = CUTS_W - NOTCH_W;
    var pitch = n > 1 ? Math.min(PITCH, room / ((n - 1) + groups * GROUP_GAP / PITCH)) : PITCH;
    var gap = pitch * GROUP_GAP / PITCH, lefts = [];
    for (var i = 0; i < n; i++) lefts.push(i * pitch + Math.floor(i / 5) * gap);
    return lefts;
  }
  function nearestNotch(clientX) {
    var n = S.notches.length;
    if (!n || !num(clientX)) return n ? n - 1 : -1;
    var r = R.cuts.getBoundingClientRect(), sc = r && r.width ? r.width / CUTS_W : scale;
    var x = (clientX - (r ? r.left : 0)) / (sc || 1), lefts = notchLayout(n), best = 0, bd = Infinity;
    for (var i = 0; i < n; i++) {
      var d = Math.abs(x - (lefts[i] + NOTCH_W / 2));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* ---------- the frame's parts ---------- */

  function setMute(m) {
    S.muted = m;
    [R.mute, omute].forEach(function (b) {
      b.textContent = m ? 'MUTED' : 'SOUND';
      b.classList.toggle('off', m);
      b.setAttribute('aria-label', m ? 'Sound is muted: turn sound on' : 'Mute sound and voice');
    });
  }

  function needle(v) {
    if (!mounted) mount();
    var on = num(v);
    R.dial.nd.classList.toggle('peg', !on);
    needleTo(on ? angle(Math.max(0, Math.min(100, v))) : 180);
  }
  function hand(v) {
    if (!mounted) mount();
    var ph = R.dial.ph;
    if (!num(v)) { ph.setAttribute('opacity', 0); ph.style.transform = 'rotate(180deg)'; return; }
    ph.setAttribute('opacity', 1);
    ph.style.transform = 'rotate(' + angle(Math.max(0, Math.min(100, v))).toFixed(2) + 'deg)';
  }
  function bridge(a, b) {
    if (!mounted) mount();
    var bw = R.dial.bw;
    if (!num(a) || !num(b)) { bw.setAttribute('opacity', 0); bw.setAttribute('d', ''); return; }
    var a1 = angle(a), a2 = angle(b);
    if (Math.abs(a2 - a1) <= 0.5) { bw.setAttribute('opacity', 0); bw.setAttribute('d', ''); return; }
    bw.setAttribute('d', arc(Math.min(a1, a2), Math.max(a1, a2), 136));
    bw.setAttribute('opacity', 0.95);
  }
  function arrow(v, up) {
    if (!mounted) mount();
    var ar = R.dial.ar;
    if (!num(v) || (up !== true && up !== false)) { ar.setAttribute('opacity', 0); ar.removeAttribute('transform'); return; }
    var a = angle(Math.max(0, Math.min(100, v))).toFixed(2);
    ar.setAttribute('transform', 'rotate(' + a + ' 164 164)' + (up ? '' : ' translate(328 0) scale(-1 1)'));
    ar.setAttribute('opacity', 1);
  }
  function bezel(level) {
    if (!mounted) mount();
    var l = num(level) ? Math.max(0, Math.min(1, level)) : 0;
    R.dial.bg.setAttribute('opacity', +l.toFixed(3));
  }
  function plate(text, o) {
    if (!mounted) mount();
    o = o || {};
    S.plateText = str(text);
    var shown = S.parked ? S.plateText : '';
    R.plateSpan.textContent = shown;
    R.plate.classList.toggle('two', shown.length > 20 && shown.length <= 44);
    R.plate.classList.toggle('three', shown.length > 44);
    if (o.flip && !rm()) restart(R.plate, 'flip');
    if (o.pulse && !rm()) {
      R.plate.classList.add('pulse');
      later(function () { R.plate.classList.remove('pulse'); }, PULSE_MS);
    }
  }
  function figure(u, n, word) {
    if (!mounted) mount();
    drawFigure(R.dial, num(u) ? u : null, n, word);
  }
  function beam(v, n) {
    if (!mounted) mount();
    drawBeam(R.dial, num(v) ? v : 50, n);
  }
  function tag(text, o) {
    if (!mounted) mount();
    o = o || {};
    var t = str(text);
    R.tagSpan.textContent = t;
    R.tag.classList.toggle('in', !!o.lamp);
    R.tag.classList.toggle('rule', !!o.rule && !o.lamp);
    R.tag.classList.toggle('blank', t === '');
    if (S.tagText !== null && S.tagText !== t && !rm()) restart(R.tag, 'fl');
    S.tagText = t;
  }
  function retrace(i) {
    if (!mounted) mount();
    S.lit = i === null || i === undefined ? null : Math.floor(i);
    drawNotches();
  }
  function drawNotches() {
    clear(R.cuts);
    var n = S.notches.length, lefts = notchLayout(n);
    S.notches.forEach(function (c, i) {
      var cls = 'dr-n ' + (c.up ? 'up' : 'dn') + (c.tag ? ' tg' : '');
      if (S.lit !== null) cls += i < S.lit ? '' : i === S.lit ? ' hi' : ' dim';
      var e = el('i', cls, R.cuts);
      e.style.left = lefts[i].toFixed(1) + 'px';
    });
  }
  function drawBrands(list) {
    clear(R.board);
    (Array.isArray(list) ? list : []).slice(0, LANES).forEach(function (b) {
      var s = el('span', 'dr-brand ' + (b.state === 'hot' ? 'hot' : b.state === 'warm' ? 'warm' : 'never'), R.board, str(b.brand));
      if (b.state === 'warm') s.style.color = mix(CHAR, WARM, b.warmth);
    });
    S.brandIds = (Array.isArray(list) ? list : []).slice(0, LANES).map(function (b) { return b.id; });
  }
  function drawTacks(list) {
    clear(R.tacks);
    list = Array.isArray(list) ? list : [];
    S.tacks = list;
    var cell = BOARD_W / LANES, per = {}, seen = {};
    list.forEach(function (t) { per[t.lane] = (per[t.lane] || 0) + 1; });
    list.forEach(function (t, i) {
      var col = (S.brandIds || []).indexOf(t.lane);
      if (col < 0) return;
      var cnt = per[t.lane], k = seen[t.lane] = (seen[t.lane] || 0) + 1;
      var pitch = cnt > 1 ? Math.min(17, (cell - 16) / (cnt - 1)) : 0;
      var x = cell * (col + 0.5) - (cnt - 1) * pitch / 2 + (k - 1) * pitch;
      var e = el('div', 'dr-tk' + (t.grade === 1 ? ' won' : t.grade === 0 ? ' lost' : ''), R.tacks);
      e.style.left = x.toFixed(1) + 'px';
      mark(e, 'tack', i);
    });
  }
  function setLabel(e, text, show) {
    e.textContent = show ? str(text) : '';
    e.hidden = !show || str(text) === '';
  }

  /* ---------- the field: one straw stroke per standing flag, seeded so stalks stay put ---------- */

  function seedOf(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; }
    h = (h >>> 0) % 2147483646;
    return h + 1;
  }
  function rng(seed) {
    var s = seed;
    return function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
  }
  function drawField(f) {
    var x = R.canvas.getContext ? R.canvas.getContext('2d') : null;
    if (!x) return;
    x.setTransform(FIELD_PX, 0, 0, FIELD_PX, 0, 0);
    x.clearRect(0, 0, FIELD_W, FIELD_H);
    x.lineCap = 'round';
    if (!f || typeof f !== 'object') return;
    var rows = Array.isArray(f.rows) ? f.rows : [], far = f.far || null;
    var slots = [];                                                    // back to front
    if (far && far.n > 0) slots.push({ far: far });
    rows.forEach(function (r, k) {
      if (r.gapBefore && slots.length) slots.push({ gap: true });       // bare ground between far-apart days
      slots.push({ row: r, front: k === rows.length - 1 });
    });
    var FRONT = 126, BACK = 34, ns = slots.length;
    var pitch = ns > 1 ? Math.max(4, Math.min(num(f.pitch) ? f.pitch : 9, (FRONT - BACK) / (ns - 1))) : 9;
    var backY = FRONT - (ns - 1) * pitch;

    drawBales(x, f, ns ? backY - 3 : 104);

    slots.forEach(function (s, j) {
      if (s.gap) return;
      var y = FRONT - (ns - 1 - j) * pitch, depth = ns > 1 ? j / (ns - 1) : 1;
      var hh = 8 + 12 * depth;
      if (s.far) {
        var rf = rng(seedOf('far'));
        x.strokeStyle = 'rgba(125,110,74,.3)'; x.lineWidth = 2;
        for (var q = 0; q < s.far.n; q++) {
          var fx = 4 + (q + 0.15 + 0.7 * rf()) / s.far.n * 350, fdx = (rf() - 0.5) * 3;
          x.beginPath(); x.moveTo(fx, y); x.lineTo(fx + fdx, y - 6 * (0.8 + 0.4 * rf())); x.stroke();
        }
        return;
      }
      var r = s.row, n = int(r.n), tall = Array.isArray(r.tall) ? r.tall : [], isTall = {};
      tall.forEach(function (i) { isTall[i] = 1; });
      var rnd = rng(seedOf(r.d)), m = n - tall.length, k = 0, t = 0;
      var bw = tall.length * 3.1;
      var cx = tall.length ? 4 + (tall[0] + tall.length / 2) / Math.max(1, n) * 350 : 0;
      cx = Math.max(8 + bw / 2, Math.min(350 - bw / 2, cx));
      var oldA = (0.35 + 0.3 * depth).toFixed(2);
      for (var i = 0; i < n; i++) {
        var px, h, high = !!isTall[i];
        if (high) { px = cx - bw / 2 + t * 3.1 + rnd() * 1.5; t++; }
        else { px = 4 + (k + 0.15 + 0.7 * rnd()) / Math.max(1, m) * 350; k++; }
        h = hh * (0.8 + 0.4 * rnd()) * (high ? 1.75 : 1);
        var dx = (rnd() - 0.5) * 5;
        x.strokeStyle = high ? '#FFD98A' : s.front ? '#E0BC5E' : 'rgba(125,110,74,' + oldA + ')';
        x.lineWidth = 2;
        x.beginPath(); x.moveTo(px, y); x.lineTo(px + dx, y - h); x.stroke();
      }
    });
  }
  function drawBales(x, f, baseY) {
    var bales = Array.isArray(f.bales) ? f.bales : [], stack = f.stack || null;
    if (!bales.length && !stack) return;
    var rnd = rng(seedOf('bales'));
    // stubble: every cut stalk of the drawn bale days, low and dim, at the front
    var stub = 0;
    bales.forEach(function (b) { stub += int(b.n); });
    stub = Math.min(stub, 1500);
    x.strokeStyle = 'rgba(125,110,74,.4)'; x.lineWidth = 1.5;
    for (var s = 0; s < stub; s++) {
      var sx = 4 + rnd() * 350, sy = 96 + rnd() * 31;
      x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + (rnd() - 0.5), sy - 2.5); x.stroke();
    }
    var count = bales.length + (stack ? 1 : 0), slot = 340 / Math.max(1, count), at = 9;
    function bale(bx, by, n, colour) {
      var w = Math.min(30, 10 + Math.sqrt(Math.max(1, n)) * 2.2), h = 7 + Math.min(8, Math.sqrt(Math.max(1, n)));
      x.fillStyle = colour; x.fillRect(bx, by - h, w, h);
      x.fillStyle = 'rgba(18,14,10,.55)';
      x.fillRect(bx + w * 0.3, by - h, 1.2, h); x.fillRect(bx + w * 0.7, by - h, 1.2, h);
      return w;
    }
    if (stack) {                                    // the older days, as one stack
      var sn = Math.max(1, Math.round(stack.n / Math.max(1, stack.days)));
      bale(at, baseY, sn, '#7f7048'); bale(at + 12, baseY, sn, '#7f7048'); bale(at + 6, baseY - 9, sn, '#8a7a4f');
      at += slot;
    }
    bales.forEach(function (b, i) {
      var newest = i === bales.length - 1;
      bale(at + rnd() * Math.max(0, slot - 30), baseY - (i % 2 ? 5 : 0), int(b.n), newest ? '#D9B866' : '#9c8a57');
      at += slot;
    });
  }

  /* ---------- render: the whole resting frame ---------- */

  function render(v) {
    if (!mounted) mount();
    v = v && typeof v === 'object' ? v : {};
    var parked = String(v.mode || '').toUpperCase() === 'PARKED';
    var wasParked = S.parked;
    S.parked = parked;
    root.classList.toggle('parked', parked);
    root.classList.toggle('rolling', !parked);

    var lit = !!v.lit, n = int(v.n), u = Math.min(int(v.u), n);
    root.classList.toggle('lit', lit);
    root.classList.toggle('dark', !lit);

    var line = Object.prototype.hasOwnProperty.call(LINE_WORD, v.line) ? v.line : 'unset';
    R.lampWord.textContent = LINE_WORD[line];
    R.lamp.className = 'dr-lamp ' + line;
    R.lamp.setAttribute('aria-label', 'The line home: ' + LINE_WORD[line]);
    setMute(!!v.muted);
    R.show.hidden = !parked;

    var words = wordsOk(v.words) ? v.words : ['UP', 'DOWN'];
    S.words = words;
    R.ewU.textContent = words[0];
    R.ewD.textContent = words[1];

    var live = lit && n > 0, val = live ? 100 * u / n : null;
    R.dial.nd0.setAttribute('visibility', !lit && n === 0 ? 'visible' : 'hidden');
    figure(live ? u : null, n, words[0]);
    beam(live ? val : 50, live ? n : 0);
    needle(val);
    R.glow.className = 'dr-glow' + (live ? (val > 50 ? ' up' : val < 50 ? ' dn' : ' even') : '');
    hand(num(v.hand) ? v.hand : null);
    bridge(null, null);
    arrow(null, null);
    bezel(0);

    plate(v.plate, { pulse: parked && wasParked === false });
    var tg = v.tag && typeof v.tag === 'object' ? v.tag : {};
    tag(tg.text, { lamp: !!tg.lamp, rule: !!tg.rule });

    S.notches = (Array.isArray(v.notches) ? v.notches : []).map(function (c) { return { up: !!(c && c.up), tag: !!(c && c.tag) }; });
    S.lit = null;
    drawNotches();
    drawBrands(v.brands);
    drawTacks(v.tacks);

    var key;
    try { key = JSON.stringify(v.field || null); } catch (e) { key = 'x'; }
    if (key !== S.fieldKey) { S.fieldKey = key; drawField(v.field || null); }

    var lb = parked && v.labels && typeof v.labels === 'object' ? v.labels : null;
    setLabel(R.labField, lb && lb.field, !!lb);
    setLabel(R.labHz, lb && lb.horizon, !!lb);
    setLabel(R.labYr, lb && lb.ground, !!lb);
    R.dock.hidden = !(parked && v.dock);
    R.strip.classList.toggle('two', parked && !!v.dock);
  }

  /* ---------- overlays: real pixels, never scaled ---------- */

  function syncOv() {
    var any = busy();
    omute.hidden = !any;
    root.classList.toggle('ov', any);
  }
  function busy() { for (var k in OPEN) if (Object.prototype.hasOwnProperty.call(OPEN, k)) return true; return false; }
  function openOv(kind, node, resolve) {
    if (!mounted) mount();
    if (OPEN[kind]) finish(kind, null);
    var rec = { node: node, resolve: resolve, timers: [] };
    OPEN[kind] = rec;
    ov.appendChild(node);
    syncOv();
    return rec;
  }
  function finish(kind, value) {
    var rec = OPEN[kind];
    if (!rec) return;
    delete OPEN[kind];
    rec.timers.forEach(function (t) { G.clearTimeout(t); });
    rec.node.classList.add('gone');
    later(function () { if (rec.node.parentNode) rec.node.parentNode.removeChild(rec.node); }, GONE_MS);
    syncOv();
    rec.resolve(value === undefined ? null : value);
  }
  function live(kind, rec) { return OPEN[kind] === rec; }
  function swipeAway(node, kind, recRef) {
    var p = null;
    node.addEventListener('pointerdown', function (e) { p = { x: e.clientX, y: e.clientY }; });
    node.addEventListener('pointermove', function (e) {
      if (!p || !live(kind, recRef.rec)) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.2) { p = null; finish(kind, null); }
    });
    node.addEventListener('pointerup', function () { p = null; });
    node.addEventListener('pointercancel', function () { p = null; });
  }
  function seamPlate(parent, text, sub) {
    var pl = el('div', 'dr-pl dr-seamq', parent);
    var t = str(text), u = str(sub);
    pl.classList.toggle('two', t.length > 20);
    if (u) { pl.classList.add('sub'); el('small', 'dr-sub', pl, u); }   // the figure the question is about
    el('span', '', pl, t);
    return pl;
  }
  function drain(rec, kind, bar, ms) {
    if (!(num(ms) && ms > 0)) { bar.hidden = true; return; }
    bar.style.transitionDuration = Math.round(ms) + 'ms';
    void bar.offsetWidth;
    bar.style.transform = 'scaleX(0)';
    rec.timers.push(later(function () { finish(kind, null); }, ms));
  }

  function halves(o) {
    o = o || {};
    return new Promise(function (res) {
      if (!mounted) mount();
      var node = el('div', 'dr-halves' + (o.see ? ' see' : ''));
      node.setAttribute('role', 'dialog');
      node.setAttribute('aria-label', str(o.seam));
      var a = btn('dr-h up', str(o.a), node, str(o.a));
      var b = btn('dr-h dn', str(o.b), node, str(o.b));
      var seam = el('div', 'dr-seam', node);
      var bar = el('i', 'dr-drain', seam);
      seamPlate(seam, o.seam, o.sub);
      var ref = {};
      var rec = ref.rec = openOv('halves', node, res);
      a.addEventListener('click', function () { if (live('halves', rec)) finish('halves', 'a'); });
      b.addEventListener('click', function () { if (live('halves', rec)) finish('halves', 'b'); });
      swipeAway(node, 'halves', ref);
      drain(rec, 'halves', bar, o.drainMs);
    });
  }

  function bands(o) {
    o = o || {};
    return new Promise(function (res) {
      if (!mounted) mount();
      var opts = Array.isArray(o.options) ? o.options : [];
      var node = el('div', 'dr-bands');
      node.setAttribute('role', 'dialog');
      node.setAttribute('aria-label', str(o.seam));
      var seam = el('div', 'dr-bseam', node);
      seamPlate(seam, o.seam);
      var bar = el('i', 'dr-drain', seam);
      var list = el('div', 'dr-blist n' + opts.length, node);
      var ref = {};
      var rec = ref.rec = openOv('bands', node, res);
      opts.forEach(function (t, i) {
        var bt = btn('dr-band', str(t), list, str(t));
        bt.addEventListener('click', function () { if (live('bands', rec)) finish('bands', i); });
      });
      swipeAway(node, 'bands', ref);
      drain(rec, 'bands', bar, o.drainMs);
    });
  }

  function card(o) {
    o = o || {};
    return new Promise(function (res) {
      if (!mounted) mount();
      var node = el('div', 'dr-scrim');
      var panel = el('div', 'dr-card', node);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', str(o.title));
      el('div', 'dr-ctitle', panel, str(o.title));
      var marks = Array.isArray(o.marks) ? o.marks : [];
      if (marks.length) {
        var mk = el('div', 'dr-marks', panel);
        marks.forEach(function (m) { el('span', 'dr-mark', mk, str(m)); });
      }
      (Array.isArray(o.lines) ? o.lines : []).forEach(function (l) { el('p', 'dr-line', panel, str(l)); });
      var acts = el('div', 'dr-acts', panel);
      var rec = openOv('card', node, res);
      var list = Array.isArray(o.actions) ? o.actions.slice() : [];
      var hasClose = list.some(function (a) { return a && a.id === 'close'; });
      list.forEach(function (a) {
        if (!a) return;
        var bt = btn('dr-act' + (a.id === 'close' ? ' quiet' : ''), str(a.label), acts, str(a.label));
        bt.addEventListener('click', function () { if (live('card', rec)) finish('card', a.id); });
      });
      if (!hasClose) {
        var cl = btn('dr-act quiet', 'Close', acts, 'CLOSE');
        cl.addEventListener('click', function () { if (live('card', rec)) finish('card', null); });
      }
      node.addEventListener('click', function (e) { if (e.target === node && live('card', rec)) finish('card', null); });
    });
  }

  function entry(o) {
    o = o || {};
    return new Promise(function (res) {
      if (!mounted) mount();
      var node = el('div', 'dr-scrim');
      var panel = el('div', 'dr-card dr-entry', node);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', str(o.title));
      el('div', 'dr-ctitle', panel, str(o.title));
      if (o.hint) el('p', 'dr-line', panel, str(o.hint));
      var input = el('input', 'dr-input' + (o.kind === 'number' ? ' num' : ''), panel);
      input.setAttribute('type', 'text');
      input.setAttribute('inputmode', o.kind === 'number' ? 'decimal' : 'text');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', o.kind === 'number' ? 'off' : 'characters');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', str(o.title));
      if (num(o.max) && o.max > 0) input.setAttribute('maxlength', String(Math.floor(o.max)));
      var acts = el('div', 'dr-acts', panel);
      var ok = btn('dr-act', 'OK', acts, 'OK');
      var no = btn('dr-act quiet', 'Cancel', acts, 'CANCEL');
      var rec = openOv('entry', node, res);
      ok.addEventListener('click', function () { if (live('entry', rec)) finish('entry', String(input.value)); });
      no.addEventListener('click', function () { if (live('entry', rec)) finish('entry', null); });
      input.addEventListener('keydown', function (e) {
        if (e && e.key === 'Enter' && live('entry', rec)) { if (e.preventDefault) e.preventDefault(); finish('entry', String(input.value)); }
      });
      try { input.focus(); } catch (x) { /* focus is best effort */ }
    });
  }

  function counter(o) {
    o = o || {};
    return new Promise(function (res) {
      if (!mounted) mount();
      var node = el('div', 'dr-counter');
      node.setAttribute('role', 'dialog');
      node.setAttribute('aria-label', 'The count, for the counter');
      var inner = el('div', 'dr-cvin', node);
      var d = buildDial(inner, false);
      var u = int(o.u), n = int(o.n), has = n > 0;
      d.nd0.setAttribute('visibility', has ? 'hidden' : 'visible');
      d.svg.classList.toggle('lit', has);
      drawBeam(d, has ? 100 * Math.min(u, n) / n : 50, has ? n : 0);
      var a = has ? angle(100 * Math.min(u, n) / n) : 180;
      d.ng.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' 164 164)');
      d.nd.classList.toggle('peg', !has);
      var fig = el('div', 'dr-cfig', inner);
      if (has) {
        el('span', 'big', fig, String(Math.min(u, n)));
        el('span', 'of', fig, 'of');
        el('span', 'big', fig, String(n));
        if (o.word) el('span', 'w', fig, str(o.word));
      }
      var q = el('div', 'dr-pl dr-cq', inner);
      q.classList.toggle('two', str(o.question).length > 20);
      el('span', '', q, str(o.question));
      var flip = btn('dr-cflip', 'Turn it around for the person across the counter', node, '↻');
      var rec = openOv('counter', node, res);
      flip.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        node.classList.toggle('flipped');
      });
      node.addEventListener('click', function (e) {
        if (e && e.target === flip) return;
        if (live('counter', rec)) finish('counter', null);
      });
    });
  }

  function closeAll() {
    Object.keys(OPEN).forEach(function (k) { finish(k, null); });
  }

  function on(name, cb) {
    if (typeof cb !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(cb);
    return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== cb; }); };
  }

  DR.surface = {
    mount: mount, fit: fit, render: render,
    needle: needle, hand: hand, bridge: bridge, arrow: arrow, bezel: bezel,
    plate: plate, figure: figure, beam: beam, tag: tag, retrace: retrace,
    halves: halves, bands: bands, card: card, entry: entry, counter: counter,
    closeAll: closeAll, busy: busy, on: on
  };
})();
