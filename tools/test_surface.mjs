// Tests for shell/js/surface.js (SPEC 9.11, 9.12). Node, no packages.
// It loads core.js and surface.js into a vm context with a hand-written fake DOM whose elements throw on
// innerHTML, outerHTML, insertAdjacentHTML and document.write, and walks what he sees and every touch.
// Uncaught errors are fatal. Run: node shell/tools/test_surface.mjs   (exit 1 on any failure)
process.env.TZ = 'America/New_York';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const CORE = fs.readFileSync(path.join(SHELL, 'js', 'core.js'), 'utf8');
const SURF = fs.readFileSync(path.join(SHELL, 'js', 'surface.js'), 'utf8');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(SHELL, 'registry.json'), 'utf8'));

let passed = 0, failed = 0;
function fail(name, msg) { failed++; console.log('FAIL ' + name + ': ' + msg); }
process.on('uncaughtException', e => { console.log('FATAL uncaught: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', e => { console.log('FATAL unhandled rejection: ' + (e && e.stack || e)); process.exit(1); });
async function t(name, fn) {
  try { const r = await fn(); if (r === false) fail(name, 'returned false'); else passed++; }
  catch (e) { fail(name, e && e.message ? e.message : String(e)); }
}
function ok(c, what) { if (!c) throw new Error(what || 'not true'); }
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((what ? what + ': ' : '') + 'got ' + sa + ' want ' + sb);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── the fake page ─────────────────────────────────────────────────────── */
class ClassList {
  constructor(owner) { this.set = new Set(); this.owner = owner; }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}
class Ctx2D {
  constructor() { this.ops = []; this.path = []; this.strokeStyle = ''; this.fillStyle = ''; this.lineWidth = 1; this.lineCap = 'butt'; }
  setTransform(...a) { this.ops.push(['setTransform', a]); }
  clearRect(...a) { this.ops.push(['clearRect', a]); }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push(['M', x, y]); }
  lineTo(x, y) { this.path.push(['L', x, y]); }
  stroke() { this.ops.push(['stroke', this.lineWidth, this.strokeStyle, this.path.slice()]); }
  fillRect(...a) { this.ops.push(['fillRect', this.fillStyle, a]); }
}
let page;
class FakeEl {
  constructor(tag, ns) {
    this.tagName = String(tag).toUpperCase(); this.ns = ns || null;
    this.children = []; this.parentNode = null; this.ownText = ''; this.attrs = {};
    this.listeners = {}; this.classList = new ClassList(this); this.style = {};
    this.hidden = false; this.value = ''; this.width = 0; this.height = 0;
    this.rect = null; this.clientWidth = 0; this.clientHeight = 0; this.ctx = null;
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) {
    if (this.ns) throw new TypeError('className is read-only on an SVG element');
    this.classList = new ClassList(this);
    String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.ownText = String(v); }
  get innerHTML() { throw new Error('innerHTML was read'); }
  set innerHTML(v) { throw new Error('innerHTML was written'); }
  get outerHTML() { throw new Error('outerHTML was read'); }
  set outerHTML(v) { throw new Error('outerHTML was written'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML was called'); }
  get firstChild() { return this.children[0] || null; }
  get offsetWidth() { return 0; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) {
    if (k === 'style') throw new Error("setAttribute('style') was called");
    this.attrs[k] = String(v);
    if (k === 'class') { this.classList = new ClassList(this); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    if (k === 'id') page.ids.set(String(v), this);
  }
  getAttribute(k) { return k === 'class' ? this.className : (Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  getContext(k) { if (this.tagName !== 'CANVAS' || k !== '2d') return null; this.ctx = this.ctx || new Ctx2D(); return this.ctx; }
  focus() { page.focused = this; }
}
function makeStyleProxy(el) {
  // el.style.<prop> only; cssText is a forbidden sink
  return new Proxy({}, {
    set(o, k, v) { if (k === 'cssText') throw new Error('cssText was written'); o[k] = String(v); return true; },
    get(o, k) { if (k === 'cssText') throw new Error('cssText was read'); return o[k]; },
  });
}
function newPage(opts = {}) {
  page = { ids: new Map(), raf: [], rafId: 0, reduced: !!opts.reduced, focused: null, docListeners: {}, winListeners: {} };
  const mk = (tag, ns) => { const e = new FakeEl(tag, ns); e.style = makeStyleProxy(e); return e; };
  const body = mk('body');
  const rootEl = mk('div'); rootEl.setAttribute('id', 'dr'); body.appendChild(rootEl);
  const document = {
    body, hidden: false,
    getElementById: id => page.ids.get(id) || null,
    createElement: tag => mk(tag),
    createElementNS: (ns, tag) => mk(tag, ns),
    addEventListener(tp, f) { (page.docListeners[tp] = page.docListeners[tp] || []).push(f); },
    write() { throw new Error('document.write was called'); },
    writeln() { throw new Error('document.writeln was called'); },
  };
  const win = {
    document, console, Promise, Math, JSON, Date, Set, Map, WeakMap, Proxy, Object, Array, String, Number, Boolean,
    setTimeout, clearTimeout, parseInt, parseFloat, isFinite, isNaN, TypeError, Error,
    requestAnimationFrame(cb) { page.rafId++; page.raf.push({ id: page.rafId, cb }); return page.rafId; },
    cancelAnimationFrame(id) { page.raf = page.raf.filter(r => r.id !== id); },
    matchMedia: q => ({ matches: /reduced-motion/.test(q) ? page.reduced : false }),
    addEventListener(tp, f) { (page.winListeners[tp] = page.winListeners[tp] || []).push(f); },
  };
  win.window = win; win.globalThis = win;
  page.win = win; page.doc = document; page.root = rootEl;
  vm.createContext(win);
  vm.runInContext(CORE, win, { filename: 'core.js' });
  vm.runInContext(SURF, win, { filename: 'surface.js' });
  win.DR.setRegistry(REGISTRY);
  page.DR = win.DR; page.S = win.DR.surface;
  return page;
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
function all(cls, from) { const out = []; walk(from || page.root, e => { if (e.classList.contains(cls)) out.push(e); }); return out; }
function one(cls, from) { const a = all(cls, from); if (a.length !== 1) throw new Error('want one .' + cls + ', found ' + a.length); return a[0]; }
function fire(target, type, extra = {}) {
  const ev = Object.assign({ type, target, defaultPrevented: false, _stop: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; } }, extra);
  for (let e = target; e && !ev._stop; e = e.parentNode) {
    ev.currentTarget = e;
    for (const f of (e.listeners[type] || []).slice()) f.call(e, ev);
  }
  return ev;
}
const tap = (target, extra) => fire(target, 'click', extra || {});
function runRaf(max = 2000) {    // step the spring frame by frame at 60 fps; returns the frames it took
  let ts = 1000, n = 0;
  while (page.raf.length && n < max) { const q = page.raf; page.raf = []; ts += 16.7; q.forEach(r => r.cb(ts)); n++; }
  return n;
}
function needleAngle() {
  const g = page.S && findNeedleGroup();
  const m = /rotate\(([-0-9.]+) 164 164\)/.exec(g.getAttribute('transform'));
  return m ? +m[1] : NaN;
}
function findNeedleGroup() { const nd = all('dr-nd')[0]; return nd.parentNode; }
function record() { const got = []; ['stage', 'dial', 'rail', 'tag', 'grass', 'tack', 'ground', 'lever', 'dock', 'mute', 'line', 'show'].forEach(n => page.S.on(n, a => got.push(a === undefined ? [n] : [n, a]))); return got; }
function visible(e) { for (let x = e; x; x = x.parentNode) if (x.hidden) return false; return true; }

const BRANDS = [
  { id: 'ai', brand: 'AI', state: 'never', warmth: 0 }, { id: 'nextgen', brand: 'NEXT-GEN', state: 'warm', warmth: 1 },
  { id: 'crypto', brand: 'CRYPTO', state: 'warm', warmth: 0 }, { id: 'macro', brand: 'MACRO', state: 'hot', warmth: 1 },
  { id: 'physics', brand: 'PHYSICS', state: 'never', warmth: 0 }];
function view(over) {
  return Object.assign({
    mode: 'ROLLING', line: 'home', muted: false, lit: false, words: ['UP', 'DOWN'], u: 0, n: 0,
    plate: 'ORDERS UP OR DOWN?', tag: { text: 'DEC 1', lamp: false, rule: true }, hand: null, notches: [],
    brands: BRANDS, tacks: [], field: null, labels: { field: '381 HEARD', horizon: 'THE EAR KEPT 6,532', ground: 'YOURS 171' },
    dock: true }, over || {});
}
function notches(spec) { return spec.split('').map(c => ({ up: c === 'u' || c === 'U', tag: c === 'U' || c === 'D' })); }

/* ── the tests ─────────────────────────────────────────────────────────── */

await t('mount builds inside #dr, every button has type and aria-label, twice is safe', () => {
  newPage();
  page.S.mount(); page.S.mount();
  ok(page.root.classList.contains('dr'), 'root class dr');
  eq(all('dr-box').length, 1, 'one design box');
  let buttons = 0;
  walk(page.root, e => {
    if (e.tagName !== 'BUTTON') return;
    buttons++;
    eq(e.getAttribute('type'), 'button', 'type on ' + e.className);
    ok((e.getAttribute('aria-label') || '').length > 0, 'aria-label on ' + e.className);
  });
  ok(buttons >= 7, 'buttons: ' + buttons);
  eq(all('dr-seg').length, 60, 'sixty heat segments');
});

await t('fit scales the 390 x 844 box to the safe area and centres it', () => {
  newPage(); page.S.mount();
  const safe = one('dr-safe'); safe.clientWidth = 390; safe.clientHeight = 1688;
  page.S.fit();
  eq(one('dr-box').style.transform, 'translate(0.0px,422.0px) scale(1.0000)');
  safe.clientWidth = 750; safe.clientHeight = 760;
  page.S.fit();
  const s = 760 / 844;
  eq(one('dr-box').style.transform, 'translate(' + ((750 - 390 * s) / 2).toFixed(1) + 'px,0.0px) scale(' + s.toFixed(4) + ')');
});

await t('ROLLING dark: NO DOCKS YET, no figure, needle on its peg, blank plate, nothing parked', () => {
  newPage();
  page.S.render(view());
  const r = page.root;
  ok(r.classList.contains('rolling') && !r.classList.contains('parked'), 'mode classes');
  ok(!r.classList.contains('lit'), 'dark');
  eq(one('dr-nd0').getAttribute('visibility'), 'visible', 'NO DOCKS YET');
  eq(one('dr-nd0').textContent, 'NO DOCKSYET');
  eq(one('dr-fig').textContent, '', 'no figure');
  ok(one('dr-nd').classList.contains('peg'), 'dull needle');
  eq(needleAngle(), 180, 'plumb');
  eq(page.raf.length, 0, 'no spring at rest');
  eq(one('dr-plate').children[0].textContent, '', 'plate is blank brass while ROLLING');
  ok(!visible(one('dr-show')), 'no SHOW'); ok(!visible(one('dr-dock')), 'no JUST LEFT A DOCK');
  all('dr-lab').forEach(l => { ok(!visible(l) || l.textContent === '', 'label hidden: ' + l.className); });
  eq(one('dr-lampword').textContent, 'HOME'); ok(one('dr-lamp').classList.contains('home'));
  eq(one('dr-mute').textContent, 'SOUND');
});

await t('the shoulder words, the lamp words and MUTED', () => {
  newPage();
  page.S.render(view({ words: ['YES', 'NO'], line: 'none', muted: true }));
  const ew = all('dr-ew');
  eq(ew.find(e => e.classList.contains('up')).textContent, 'YES');
  eq(ew.find(e => e.classList.contains('dn')).textContent, 'NO');
  eq(one('dr-lampword').textContent, 'NO LINE');
  eq(one('dr-mute').textContent, 'MUTED'); ok(one('dr-mute').classList.contains('off'));
  page.S.render(view({ line: 'unset' }));
  eq(one('dr-lampword').textContent, 'NOT SET');
  page.S.render(view({ line: 'garbage' }));
  eq(one('dr-lampword').textContent, 'NOT SET', 'unknown line reads NOT SET');
});

await t('ROLLING with docks: the figure, the beam, the needle springs and stops itself', () => {
  newPage();
  page.S.render(view({ lit: true, u: 7, n: 11, notches: notches('uuuuuuudddd') }));
  ok(page.root.classList.contains('lit'));
  eq(one('dr-nd0').getAttribute('visibility'), 'hidden');
  const fig = one('dr-fig');
  eq(fig.children.map(c => c.textContent), ['7', 'of', '11', 'UP'], 'figure');
  eq(fig.children.map(c => c.getAttribute('font-size')), ['52', '24', '52', '28'], 'figure sizes');
  ok(page.raf.length === 1, 'the spring started');
  const frames = runRaf();
  ok(frames > 5 && frames < 400, 'frames ' + frames);
  eq(page.raf.length, 0, 'the spring stopped itself');
  const v = 700 / 11;
  ok(Math.abs(needleAngle() - (v - 50) * 2.4) < 0.01, 'needle at ' + needleAngle());
  ok(!one('dr-nd').classList.contains('peg'), 'lit needle');
  ok(all('dr-glow')[0].classList.contains('up'), 'cab glow in ember');
  // same view again: no real change, no script runs
  page.S.render(view({ lit: true, u: 7, n: 11, notches: notches('uuuuuuudddd') }));
  eq(page.raf.length, 0, 'no spring without a change');
  eq(one('dr-plate').children[0].textContent, '', 'still a blank plate');
});

await t('the spring overshoots under 3 degrees', () => {
  newPage();
  page.S.render(view({ lit: true, u: 1, n: 2 }));         // from the peg to 0 degrees
  runRaf();
  page.S.needle(100);                                      // 0 -> 120 degrees
  let max = -1e9, ts = 1000;
  while (page.raf.length) { const q = page.raf; page.raf = []; ts += 16.7; q.forEach(r => r.cb(ts)); max = Math.max(max, needleAngle()); }
  ok(max - 120 < 3, 'overshoot ' + (max - 120).toFixed(2));
  eq(needleAngle(), 120);
});

await t('the beam lights 50 / sqrt(n) around v; no docks = the dark arc at 18 percent', () => {
  newPage();
  page.S.render(view({ lit: true, u: 7, n: 11 }));
  const v = 700 / 11, hw = 50 / Math.sqrt(11), on = +(0.34 + 0.66 * (1 - hw / 50)).toFixed(3);
  const segs = all('dr-seg');
  let lit = 0;
  segs.forEach((s, i) => {
    const sv = (i + 0.5) / 60 * 100, want = Math.abs(sv - v) <= hw + 0.9 ? on : 0.13;
    eq(+s.style.opacity, want, 'segment ' + i);
    if (want === on) lit++;
  });
  ok(lit > 10 && lit < 25, 'lit segments ' + lit);
  page.S.beam(50, 1);
  eq(all('dr-seg').filter(s => +s.style.opacity === 0.34).length, 60, 'one dock lights the whole arc dimly');
  page.S.beam(50, 0);
  eq(all('dr-seg').every(s => +s.style.opacity === 0.18), true, 'dark arc');
  page.S.beam(80, 30);
  const hw30 = 50 / Math.sqrt(30);
  eq(all('dr-seg').filter(s => +s.style.opacity > 0.5).length,
     segs.filter((s, i) => Math.abs((i + 0.5) / 60 * 100 - 80) <= hw30 + 0.9).length, 'thirty docks: tight beam');
});

await t('PARKED: the plate lights and brightens once, labels rise, SHOW and JUST LEFT A DOCK', async () => {
  newPage();
  page.S.render(view());
  page.S.render(view({ mode: 'PARKED' }));
  const pl = one('dr-plate');
  eq(pl.children[0].textContent, 'ORDERS UP OR DOWN?');
  ok(pl.classList.contains('pulse'), 'brightens once');
  await sleep(500);
  ok(!pl.classList.contains('pulse'), 'and only once');
  ok(visible(one('dr-show')), 'SHOW'); ok(visible(one('dr-dock')), 'JUST LEFT A DOCK');
  eq(one('dr-dock').textContent, 'JUST LEFTA DOCK');
  ok(one('dr-strip').classList.contains('two'), 'lever shares the strip');
  const labs = all('dr-lab');
  eq(labs.find(l => l.classList.contains('hd')).textContent, '381 HEARD');
  eq(labs.find(l => l.classList.contains('hz')).textContent, 'THE EAR KEPT 6,532');
  eq(labs.find(l => l.classList.contains('yr')).textContent, 'YOURS 171');
  labs.forEach(l => ok(visible(l), 'visible ' + l.className));
  page.S.render(view({ mode: 'PARKED' }));
  ok(!pl.classList.contains('pulse'), 'no pulse when already parked');
  page.S.render(view({ mode: 'parked', labels: null, dock: false }));
  all('dr-lab').forEach(l => ok(!visible(l), 'labels null hides them'));
  ok(!visible(one('dr-dock')));
  page.S.render(view({ mode: 'ROLLING' }));
  eq(pl.children[0].textContent, '', 'back to blank');
  page.S.plate("WHAT'D THEY SAY?", { flip: true });
  eq(pl.children[0].textContent, '', 'plate() while ROLLING stays blank');
});

await t('plate sizes: one line, two past 20 characters, three past 44', () => {
  newPage();
  page.S.render(view({ mode: 'PARKED' }));
  const pl = one('dr-plate');
  page.S.plate('WHY?', { flip: true });
  ok(!pl.classList.contains('two') && pl.classList.contains('flip'));
  page.S.plate('KNOW ANYBODY WHO STARTED A BUSINESS THIS YEAR?');
  ok(pl.classList.contains('three'), 'three lines past 44');
  page.S.plate('WHAT DID THE DOCKS TELL YOU?');
  ok(pl.classList.contains('two') && !pl.classList.contains('three'), 'two lines');
});

await t('the tin tag: blank, a date by rule (hollow), a confirmed date (solid), IN, DUE, LATE, and the flip', () => {
  newPage();
  page.S.render(view({ tag: { text: '', lamp: false, rule: false } }));
  const tg = one('dr-tag');
  eq(tg.textContent, ''); ok(tg.classList.contains('blank'));
  ok(!tg.classList.contains('fl'), 'first draw does not flip');
  page.S.render(view({ tag: { text: 'DEC 1', lamp: false, rule: true } }));
  eq(tg.textContent, 'DEC 1'); ok(tg.classList.contains('rule'), 'hollow'); ok(tg.classList.contains('fl'), 'flips on change');
  page.S.tag('DEC 1', { rule: false });
  ok(!tg.classList.contains('rule'), 'confirmed = solid');
  for (const w of ['IN', 'DUE', 'LATE']) {
    page.S.tag(w, { lamp: true, rule: false });
    eq(tg.textContent, w); ok(tg.classList.contains('in'), w + ' glows');
  }
  // the four texts as DR.tag makes them
  const DR = page.DR;
  const round = { twin: 'ism_new_orders', aim: { after: '2026-09', period: '2026-11', label: 'NOV 2026', date: '2026-12-01', time_et: '10:00', conf: 'rule' }, openedAt: '2026-11-01T12:00:00.000Z', hands: [] };
  eq(DR.tag(round, {}, '2026-11-17T12:00:00.000Z'), { text: 'DEC 1', lamp: false, rule: true });
  eq(DR.tag(round, {}, '2026-12-03T12:00:00.000Z').text, 'LATE');
  eq(DR.tag(round, { ism_new_orders: [{ period: '2026-11', label: 'NOV 2026', value: 55.5 }] }, '2026-12-03T12:00:00.000Z').text, 'IN');
  eq(DR.tag({ twin: null, aim: { date: '2026-12-01', conf: 'own' } }, {}, '2026-12-02T12:00:00.000Z').text, 'DUE');
});

await t('notches: slants, flips, paper tags, the tightening pitch, and the retrace', () => {
  newPage();
  page.S.render(view({ mode: 'PARKED', lit: true, u: 2, n: 3, notches: notches('uDu') }));
  let ns = all('dr-n');
  eq(ns.length, 3);
  eq(ns.map(n => n.classList.contains('up') ? 'up' : 'dn'), ['up', 'dn', 'up']);
  eq(ns.map(n => n.classList.contains('tg')), [false, true, false], 'paper tag on the breath');
  eq(ns.map(n => n.style.left), ['0.0px', '16.0px', '32.0px'], '16 px pitch');
  // a flip is a new view with that notch the other way
  page.S.render(view({ mode: 'PARKED', lit: true, u: 1, n: 3, notches: notches('uDd') }));
  ns = all('dr-n');
  ok(ns[2].classList.contains('dn'), 'flipped');
  page.S.render(view({ notches: notches('uuuuuuu') }));
  eq(all('dr-n')[5].style.left, (5 * 16 + 6).toFixed(1) + 'px', 'a breath after every fifth');
  page.S.render(view({ notches: notches('u'.repeat(60)) }));
  const lefts = all('dr-n').map(n => parseFloat(n.style.left));
  ok(lefts[59] <= 254 - 12 + 0.1, 'sixty fit the rail: ' + lefts[59]);
  page.S.render(view({ notches: notches('uuud') }));
  page.S.retrace(1);
  eq(all('dr-n').map(n => n.classList.contains('hi') ? 'hi' : n.classList.contains('dim') ? 'dim' : 'lit'), ['lit', 'hi', 'dim', 'dim']);
  page.S.retrace(-1);
  ok(all('dr-n').every(n => n.classList.contains('dim')), 'all dim');
  page.S.retrace(null);
  ok(all('dr-n').every(n => !n.classList.contains('dim') && !n.classList.contains('hi')), 'normal');
});

await t('brands: hot breathes, warm cools to char, never is a scribed outline', () => {
  newPage();
  page.S.render(view());
  const b = all('dr-brand');
  eq(b.map(x => x.textContent), ['AI', 'NEXT-GEN', 'CRYPTO', 'MACRO', 'PHYSICS']);
  eq(b.map(x => ['hot', 'warm', 'never'].find(c => x.classList.contains(c))), ['never', 'warm', 'warm', 'hot', 'never']);
  eq(b[1].style.color, '#b5571a', 'full warm');
  eq(b[2].style.color, '#2b221b', 'cold char');
  page.S.render(view({ brands: BRANDS.map(x => x.id === 'nextgen' ? Object.assign({}, x, { warmth: 0.5 }) : x) }));
  eq(all('dr-brand')[1].style.color, '#703d1b', 'half way');
});

await t('tacks: under their lane, bright, dull or plain', () => {
  newPage();
  page.S.render(view({ tacks: [{ lane: 'macro', grade: 1 }, { lane: 'macro', grade: 0 }, { lane: 'ai', grade: null }, { lane: 'nope', grade: 1 }] }));
  const tk = all('dr-tk');
  eq(tk.length, 3, 'unknown lane draws nothing');
  eq(tk.map(x => x.classList.contains('won') ? 'won' : x.classList.contains('lost') ? 'lost' : 'plain'), ['won', 'lost', 'plain']);
  const cell = 358 / 5;
  eq(tk.map(x => x.style.left), [(cell * 3.5 - 8.5).toFixed(1) + 'px', (cell * 3.5 + 8.5).toFixed(1) + 'px', (cell * 0.5).toFixed(1) + 'px']);
});

await t('ROLLING touches: the stage is one target; mute and lever still answer', () => {
  newPage();
  page.S.render(view({ notches: notches('uu') }));
  const got = record();
  [one('dr-dial'), one('dr-rail'), one('dr-tag'), one('dr-fieldw'), one('dr-ground'), one('dr-plate'), one('dr-lamp'), one('dr-board')]
    .forEach(e => tap(e, { clientX: 10 }));
  eq(got, Array(8).fill(['stage']));
  got.length = 0;
  tap(one('dr-mute')); tap(one('dr-lever')); tap(one('dr-dock')); tap(one('dr-strip'));
  eq(got, [['mute'], ['lever']], 'the dock bar is dead while ROLLING');
});

await t('PARKED touches: dial, tag, grass, tack, ground, line, show, lever, dock, mute; plate and board report nothing', () => {
  newPage();
  page.S.render(view({ mode: 'PARKED', lit: true, u: 1, n: 1, notches: notches('u'), tacks: [{ lane: 'ai', grade: null }, { lane: 'macro', grade: 1 }] }));
  const got = record();
  const svgKid = one('dr-dial').children.find(c => c.classList.contains('dr-sgs')).children[3];
  tap(svgKid); tap(one('dr-tag').children[0]); tap(one('dr-fieldw')); tap(all('dr-tk')[1]); tap(one('dr-ground'));
  tap(one('dr-lampword')); tap(one('dr-show')); tap(one('dr-lever')); tap(one('dr-dock')); tap(one('dr-mute'));
  tap(one('dr-plate')); tap(one('dr-board'));
  eq(got, [['dial'], ['tag'], ['grass'], ['tack', 1], ['ground'], ['line'], ['show'], ['lever'], ['dock'], ['mute']]);
});

await t('the rail: nearest notch under scale, and the 1 s hold', async () => {
  newPage();
  page.S.render(view({ mode: 'PARKED', notches: notches('uuuuuuu') }));
  const got = record();
  const cuts = one('dr-cuts'), sc = 0.9;
  cuts.rect = { left: 100, top: 500, width: 254 * sc, height: 46 * sc };
  const xOf = i => 100 + ((i < 5 ? i * 16 : i * 16 + 6) + 6) * sc;
  tap(one('dr-rail'), { clientX: xOf(2) }); tap(one('dr-rail'), { clientX: xOf(5) + 3 }); tap(one('dr-rail'), { clientX: 0 });
  tap(one('dr-rail'), { clientX: 9999 });
  eq(got, [['rail', { i: 2, hold: false }], ['rail', { i: 5, hold: false }], ['rail', { i: 0, hold: false }], ['rail', { i: 6, hold: false }]]);
  got.length = 0;
  // a hold: reported at one second, the release reports nothing more
  fire(one('dr-rail'), 'pointerdown', { clientX: xOf(6), clientY: 520 });
  await sleep(1080);
  fire(one('dr-rail'), 'pointerup', {}); tap(one('dr-rail'), { clientX: xOf(6) });
  eq(got, [['rail', { i: 6, hold: true }]]);
  got.length = 0;
  // a short press is a tap; a press that moves is no hold
  fire(one('dr-rail'), 'pointerdown', { clientX: xOf(1), clientY: 520 });
  await sleep(200); fire(one('dr-rail'), 'pointerup', {}); tap(one('dr-rail'), { clientX: xOf(1) });
  fire(one('dr-rail'), 'pointerdown', { clientX: xOf(3), clientY: 520 });
  fire(one('dr-rail'), 'pointermove', { clientX: xOf(3) + 40, clientY: 520 });
  await sleep(1080);
  eq(got, [['rail', { i: 1, hold: false }]]);
  // a bare rail reports -1
  page.S.render(view({ mode: 'PARKED', notches: [] }));
  got.length = 0;
  tap(one('dr-rail'), { clientX: 120 });
  eq(got, [['rail', { i: -1, hold: false }]]);
  // ROLLING: no hold at all
  page.S.render(view({ notches: notches('u') }));
  got.length = 0;
  fire(one('dr-rail'), 'pointerdown', { clientX: 120, clientY: 520 });
  await sleep(1080);
  eq(got, [], 'no hold while ROLLING');
});

await t('the moment marks: hand, bridge, arrow, bezel; render clears them', () => {
  newPage();
  page.S.render(view({ mode: 'PARKED', lit: true, u: 7, n: 11, hand: 55.5 }));
  const ph = one('dr-ph');
  eq(ph.getAttribute('opacity'), '1'); eq(ph.style.transform, 'rotate(' + ((55.5 - 50) * 2.4).toFixed(2) + 'deg)');
  page.S.bridge(700 / 11, 55.5);
  const bw = one('dr-bw');
  eq(bw.getAttribute('opacity'), '0.95'); ok(/^M.*A136 136 0 0 1 /.test(bw.getAttribute('d')), bw.getAttribute('d'));
  page.S.arrow(55.5, true);
  eq(one('dr-ar').getAttribute('transform'), 'rotate(13.20 164 164)');
  page.S.arrow(55.5, false);
  eq(one('dr-ar').getAttribute('transform'), 'rotate(13.20 164 164) translate(328 0) scale(-1 1)');
  page.S.bezel(0.6); eq(one('dr-bg').getAttribute('opacity'), '0.6');
  page.S.bezel(7); eq(one('dr-bg').getAttribute('opacity'), '1');
  page.S.figure(null, 11, 'UP'); eq(one('dr-fig').textContent, '', 'blank, never zero');
  page.S.figure(3, 4, null); eq(one('dr-fig').children.map(c => c.textContent), ['3', 'of', '4'], 'no word');
  page.S.needle(null); ok(one('dr-nd').classList.contains('peg'));
  page.S.render(view({ mode: 'PARKED', lit: true, u: 7, n: 11, hand: null }));
  eq(ph.getAttribute('opacity'), '0'); eq(bw.getAttribute('opacity'), '0'); eq(one('dr-ar').getAttribute('opacity'), '0');
  eq(one('dr-bg').getAttribute('opacity'), '0');
  page.S.arrow(50, null); eq(one('dr-ar').getAttribute('opacity'), '0', 'a call with no twin has no arrow');
});

await t('halves: a, b, the drain, a swipe, closeAll; busy() and the overlay mute', async () => {
  newPage(); page.S.render(view({ mode: 'PARKED' }));
  ok(!page.S.busy());
  let p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'ORDERS UP OR DOWN?', see: false, drainMs: 8000 });
  ok(page.S.busy(), 'busy');
  const om = one('dr-omute'); ok(visible(om), 'a mute over the halves');
  const got = record(); tap(om); eq(got, [['mute']]);
  ok(visible(om), 'the overlay mute does not resolve the halves');
  const bar = all('dr-drain')[0];
  eq(bar.style.transitionDuration, '8000ms'); eq(bar.style.transform, 'scaleX(0)');
  eq(all('dr-h').map(h => h.textContent), ['UP', 'DOWN']);
  eq(all('dr-seamq')[0].textContent, 'ORDERS UP OR DOWN?');
  tap(all('dr-h')[0]);
  eq(await p, 'a'); ok(!page.S.busy(), 'not busy after'); ok(!visible(om), 'overlay mute gone');
  p = page.S.halves({ a: 'YES', b: 'NO', seam: 'Q?', drainMs: 8000 });
  tap(all('dr-h').filter(h => !h.parentNode.classList.contains('gone'))[1]);
  eq(await p, 'b');
  p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'Q?', drainMs: 40 });
  eq(await p, null, 'the drain');
  p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'NEXT PRINT?', see: true, drainMs: null });
  const node = all('dr-halves').find(h => !h.classList.contains('gone'));
  ok(node.classList.contains('see'), 'see-through');
  ok(!visible(all('dr-drain').find(d => d.parentNode.parentNode === node)), 'no timer, no drain bar');
  fire(node, 'pointerdown', { clientX: 100, clientY: 300 });
  fire(node, 'pointermove', { clientX: 130, clientY: 305 });
  ok(page.S.busy(), 'a short slide is not a swipe');
  fire(node, 'pointermove', { clientX: 180, clientY: 310 });
  eq(await p, null, 'a sideways swipe');
  p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'NEXT PRINT?', sub: 'FROM NOV 2026 55.5 BY HAND', see: true, drainMs: null });
  const callNode = all('dr-halves').find(h => !h.classList.contains('gone'));
  const subs = all('dr-sub').filter(s => s.parentNode.parentNode.parentNode === callNode);
  eq(subs.map(s => s.textContent), ['FROM NOV 2026 55.5 BY HAND'], 'the seam carries the figure a call is made from (SPEC 15.38)');
  ok(subs[0].parentNode.classList.contains('sub'), 'and its plate is marked, so the dial plate can rest under it');
  tap(all('dr-h').filter(h => !h.parentNode.classList.contains('gone'))[0]);
  eq(await p, 'a');
  p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'ORDERS UP OR DOWN?', see: false, drainMs: null });
  const plainNode = all('dr-halves').find(h => !h.classList.contains('gone'));
  eq(all('dr-sub').filter(s => s.parentNode.parentNode.parentNode === plainNode).length, 0, 'a dock question has no small line');
  tap(all('dr-h').filter(h => !h.parentNode.classList.contains('gone'))[0]);
  eq(await p, 'a');
  p = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'Q?' });
  page.S.closeAll();
  eq(await p, null, 'closeAll');
  await sleep(350);
  eq(all('dr-halves').length, 0, 'removed from the page');
  const p1 = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'Q?' });
  const p2 = page.S.halves({ a: 'UP', b: 'DOWN', seam: 'Q?' });
  eq(await p1, null, 'a second halves resolves the first');
  page.S.closeAll(); eq(await p2, null);
});

await t('bands: an index, the drain, a swipe, closeAll', async () => {
  newPage(); page.S.render(view({ mode: 'PARKED' }));
  let p = page.S.bands({ seam: 'POSITION, MONEY OR HELP?', options: ['POSITION', 'MONEY', 'HELP'], drainMs: 8000 });
  const live = () => all('dr-bands').find(b => !b.classList.contains('gone'));
  eq(all('dr-band', live()).map(b => b.textContent), ['POSITION', 'MONEY', 'HELP']);
  all('dr-band', live()).forEach(b => { eq(b.getAttribute('type'), 'button'); eq(b.getAttribute('aria-label'), b.textContent); });
  tap(all('dr-band', live())[2]);
  eq(await p, 2);
  p = page.S.bands({ seam: 'Q?', options: ['TAKE IT', 'NEXT', 'MY OWN'], drainMs: 30 });
  eq(await p, null, 'drain');
  p = page.S.bands({ seam: 'Q?', options: ['UP / DOWN', 'YES / NO'] });
  const n = live();
  fire(n, 'pointerdown', { clientX: 300, clientY: 300 }); fire(n, 'pointermove', { clientX: 200, clientY: 300 });
  eq(await p, null, 'swipe');
  p = page.S.bands({ seam: 'Q?', options: ['A', 'B'] });
  page.S.closeAll(); eq(await p, null, 'closeAll');
});

await t('card: title, marks, lines, an action, the dark around it, the CLOSE it adds', async () => {
  newPage(); page.S.render(view({ mode: 'PARKED' }));
  let p = page.S.card({ title: 'HEARD', marks: ['HEARD, NOT YOURS', 'GIST, BY MACHINE'], lines: ['A data center is a token factory.', '14 NOV'], actions: [{ id: 'play', label: 'PLAY' }] });
  const card = () => all('dr-card').find(c => !c.parentNode.classList.contains('gone'));
  eq(one('dr-ctitle', card()).textContent, 'HEARD');
  eq(all('dr-mark', card()).map(m => m.textContent), ['HEARD, NOT YOURS', 'GIST, BY MACHINE']);
  eq(all('dr-line', card()).map(m => m.textContent), ['A data center is a token factory.', '14 NOV']);
  eq(all('dr-act', card()).map(m => m.textContent), ['PLAY', 'CLOSE'], 'a CLOSE is added');
  ok(page.S.busy());
  tap(all('dr-act', card())[0]); eq(await p, 'play');
  p = page.S.card({ title: 'T', actions: [{ id: 'flip', label: 'FLIP' }, { id: 'close', label: 'CLOSE' }] });
  eq(all('dr-act', card()).map(m => m.textContent), ['FLIP', 'CLOSE'], 'no second CLOSE');
  tap(all('dr-act', card())[1]); eq(await p, 'close');
  p = page.S.card({ title: 'T', actions: [] });
  tap(all('dr-act', card())[0]); eq(await p, null, 'the added CLOSE resolves null');
  p = page.S.card({ title: 'T', lines: ['x'], actions: [] });
  tap(card().children[1]); ok(page.S.busy(), 'a tap on the card itself does nothing');
  tap(card().parentNode); eq(await p, null, 'the dark around it');
  p = page.S.card({ title: '<b>not markup</b>', lines: ['<img src=x>'] });
  eq(one('dr-ctitle', card()).textContent, '<b>not markup</b>', 'text, never markup');
  page.S.closeAll(); eq(await p, null);
});

await t('entry: OK, Enter, CANCEL, closeAll; the input', async () => {
  newPage(); page.S.render(view({ mode: 'PARKED' }));
  let p = page.S.entry({ title: 'ISM NEW ORDERS · NOV 2026', kind: 'number', hint: 'THE PRINT', max: 8 });
  const inp = () => all('dr-input').find(i => !i.parentNode.parentNode.classList.contains('gone'));
  const i1 = inp();
  eq(i1.getAttribute('inputmode'), 'decimal'); eq(i1.getAttribute('maxlength'), '8'); ok(page.focused === i1, 'focused');
  i1.value = '55.5';
  tap(all('dr-act', i1.parentNode)[0]); eq(await p, '55.5');
  p = page.S.entry({ title: 'YOUR OWN', kind: 'text', max: 48 });
  const i2 = inp(); eq(i2.getAttribute('inputmode'), 'text');
  i2.value = 'any freight moving';
  fire(i2, 'keydown', { key: 'a' }); ok(page.S.busy());
  fire(i2, 'keydown', { key: 'Enter' }); eq(await p, 'any freight moving', 'raw, not upper-cased');
  p = page.S.entry({ title: 'T', kind: 'text' });
  tap(all('dr-act', inp().parentNode)[1]); eq(await p, null, 'CANCEL');
  p = page.S.entry({ title: 'T', kind: 'text' });
  page.S.closeAll(); eq(await p, null);
});

await t('counter: needle, beam and count; no hand; the corner turns it; a tap closes', async () => {
  newPage(); page.S.render(view({ mode: 'PARKED', lit: true, u: 7, n: 11, hand: 55.5 }));
  let p = page.S.counter({ u: 7, n: 11, word: 'UP', question: 'ORDERS UP OR DOWN?' });
  const cv = all('dr-counter')[0];
  eq(one('dr-cfig', cv).children.map(c => c.textContent), ['7', 'of', '11', 'UP']);
  eq(one('dr-cq', cv).textContent, 'ORDERS UP OR DOWN?');
  eq(one('dr-ph', cv).getAttribute('opacity'), '0', 'no hand in the counter view');
  eq(one('dr-bw', cv).getAttribute('opacity'), '0', 'no bridge');
  ok(/^rotate\(32\.73 164 164\)$/.test(one('dr-nd', cv).parentNode.getAttribute('transform')), one('dr-nd', cv).parentNode.getAttribute('transform'));
  ok(all('dr-seg', cv).some(s => +s.style.opacity > 0.3), 'the beam');
  ok(!/55\.5/.test(cv.textContent), 'no print');
  ok(visible(one('dr-omute')), 'mute still there');
  const flip = one('dr-cflip', cv);
  tap(flip); ok(cv.classList.contains('flipped'), 'turned'); ok(page.S.busy(), 'turning does not close');
  tap(flip); ok(!cv.classList.contains('flipped'), 'turned back');
  tap(one('dr-cvin', cv)); eq(await p, null);
  p = page.S.counter({ u: 0, n: 0, word: 'UP', question: 'Q?' });
  const cv2 = all('dr-counter').find(c => !c.classList.contains('gone'));
  eq(one('dr-nd0', cv2).getAttribute('visibility'), 'visible'); eq(one('dr-cfig', cv2).textContent, '');
  page.S.closeAll(); eq(await p, null);
});

await t('the field: one stroke per standing flag, seeded, drawn only on change, bales after a cut', () => {
  newPage();
  const DR = page.DR;
  const flags = []; let id = 1;
  const day = (d, n, h0 = 9, step = 7) => { for (let k = 0; k < n; k++) { const m = h0 * 60 + k * step; flags.push([id++, d + 'T' + String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00-05:00', '']); } };
  day('2026-10-20', 49); day('2026-10-22', 2); day('2026-10-25', 17); day('2026-11-10', 34);
  day('2026-11-14', 11, 9, 1);   // a burst: 11 taps in 11 minutes
  day('2026-11-16', 5);
  const f = DR.fieldDays(flags, null, '2026-11-17T12:00:00.000Z');
  eq(f.standing, 118);
  page.S.render(view({ field: f }));
  const ctx = one('dr-field').ctx;
  const strokes = ops => ops.filter(o => o[0] === 'stroke' && o[1] === 2);
  eq(strokes(ctx.ops).length, f.standing, 'exactly one stroke per standing flag');
  eq(strokes(ctx.ops).filter(o => o[2] === '#FFD98A').length, 11, 'the tall bunch');
  eq(strokes(ctx.ops).filter(o => o[2] === '#E0BC5E').length, 5, 'the newest row brightest');
  const tallH = strokes(ctx.ops).filter(o => o[2] === '#FFD98A').map(o => o[3][0][2] - o[3][1][2]);
  ok(Math.min(...tallH) > 12 * 0.8 * 1.75 - 6, 'taller: ' + Math.min(...tallH).toFixed(1));
  const first = JSON.stringify(ctx.ops);
  page.S.render(view({ field: f, mode: 'PARKED' }));
  eq(JSON.stringify(ctx.ops), first, 'not redrawn when nothing changed');
  page.S.render(view({ field: DR.fieldDays(flags.slice(0, 50), null, '2026-11-17T12:00:00.000Z') }));
  ctx.ops = [];
  page.S.render(view({ field: f }));
  eq(JSON.stringify(ctx.ops), first, 'seeded: the same stalks in the same places');
  // a later day does not move the old rows' stalks
  const more = flags.concat([[999, '2026-11-17T08:00:00-05:00', '']]);
  ctx.ops = [];
  page.S.render(view({ field: DR.fieldDays(more, null, '2026-11-17T12:00:00.000Z') }));
  eq(strokes(ctx.ops).length, f.standing + 1);
  // the cut: no standing, one bale per day
  const cut = DR.fieldDays(flags, '2026-11-17T00:00:00.000Z', '2026-11-17T12:00:00.000Z');
  ctx.ops = [];
  page.S.render(view({ field: cut }));
  eq(cut.standing, 0); eq(cut.baled, 118);
  eq(strokes(ctx.ops).length, 0, 'no standing strokes after the cut');
  eq(ctx.ops.filter(o => o[0] === 'fillRect').length, cut.bales.length * 3, 'one bale (and two twine bands) per day');
  // the old days as one stack, past fourteen
  const many = []; for (let d = 1; d <= 20; d++) many.push([d, '2026-10-' + String(d).padStart(2, '0') + 'T09:00:00-05:00', '']);
  const st = DR.fieldDays(many, '2026-11-01T00:00:00.000Z', '2026-11-17T12:00:00.000Z');
  ctx.ops = []; page.S.render(view({ field: st }));
  eq(ctx.ops.filter(o => o[0] === 'fillRect').length, (14 + 3) * 3, 'fourteen bales and a stack of three');
  // far rows past twenty days
  const far = []; for (let d = 0; d < 25; d++) far.push([d, new Date(Date.UTC(2026, 9, 1 + d, 14)).toISOString().slice(0, 10) + 'T09:00:00-05:00', '']);
  const ff = DR.fieldDays(far, null, '2026-11-17T12:00:00.000Z');
  ctx.ops = []; page.S.render(view({ field: ff }));
  ok(ff.far && ff.far.n === 5, 'far row');
  eq(strokes(ctx.ops).length, 25, 'far row strokes counted too');
  ctx.ops = []; page.S.render(view({ field: null }));
  eq(strokes(ctx.ops).length, 0, 'no field, bare ground');
});

await t('hidden page: animations pause and the spring snaps; reduced motion snaps too', () => {
  newPage();
  page.S.render(view({ lit: true, u: 1, n: 4 }));
  ok(page.raf.length === 1, 'spring running');
  page.doc.hidden = true; (page.docListeners.visibilitychange || []).forEach(f => f());
  ok(page.root.classList.contains('hid'), 'hid class');
  eq(page.raf.length, 0, 'spring stopped');
  ok(Math.abs(needleAngle() - (25 - 50) * 2.4) < 0.01, 'snapped to its mark');
  page.S.needle(90);
  eq(page.raf.length, 0, 'no spring on a hidden page'); ok(Math.abs(needleAngle() - 96) < 0.01);
  page.doc.hidden = false; (page.docListeners.visibilitychange || []).forEach(f => f());
  ok(!page.root.classList.contains('hid'));
  newPage({ reduced: true });
  page.S.render(view({ lit: true, u: 3, n: 4, mode: 'PARKED' }));
  eq(page.raf.length, 0, 'reduced motion: no spring');
  ok(Math.abs(needleAngle() - 60) < 0.01);
  ok(!one('dr-plate').classList.contains('pulse'), 'reduced motion: no pulse');
  page.S.tag('IN', { lamp: true }); page.S.tag('DUE', { lamp: true });
  ok(!one('dr-tag').classList.contains('fl'), 'reduced motion: no flip');
});

await t('listeners: on() returns off(); a throwing listener does not stop the others', async () => {
  newPage(); page.S.render(view());
  const got = [];
  const off = page.S.on('stage', () => got.push(1));
  page.S.on('stage', () => got.push(2));
  tap(one('dr-dial')); off(); tap(one('dr-dial'));
  eq(got, [1, 2, 2]);
});

await t('no forbidden sink in surface.js, and no network, storage or sound', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'cssText', "setAttribute('style'",
                     'fetch(', 'XMLHttpRequest', 'localStorage', 'indexedDB', 'AudioContext', 'speechSynthesis', 'navigator.vibrate']) {
    ok(SURF.indexOf(bad) < 0, 'surface.js holds ' + bad);
  }
  for (const name of ['mount', 'fit', 'render', 'needle', 'hand', 'bridge', 'arrow', 'bezel', 'plate', 'figure', 'beam', 'tag',
                      'retrace', 'halves', 'bands', 'card', 'entry', 'counter', 'closeAll', 'busy', 'on']) {
    newPage(); ok(typeof page.S[name] === 'function', 'DR.surface.' + name);
  }
});

await t('copy speaks to him: no on-screen string in surface.js says HIS (SPEC 15.10)', () => {
  const lits = SURF.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || [];
  eq(lits.filter(x => /\bHIS\b/.test(x)), []);
});

await sleep(400);   // let the overlays' fade timers run out
console.log('surface: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
