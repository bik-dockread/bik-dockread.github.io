// walklib.mjs: the harness both end-to-end walks share (walk.mjs, walk2.mjs). SPEC 9.12.
//
// It starts its own home service on 127.0.0.1:8660 (its own temp data folder, DOCKREAD_NET=0,
// DOCKREAD_JOBS=0, DOCKREAD_PREVIEW=1, a dead model port, and the made-up flags book that
// tests/walk_home.py builds in the temp folder) and its own static server for shell/ on 127.0.0.1:8918,
// and refuses to run if either port is busy. It mints a preview connect link into that temp folder and
// hands it straight to Page.navigate: it is never printed, logged or put in the report. It opens a
// windowless, muted Chrome with its own temp profile and the fake microphone below, and gives the walk
// trusted input (CDP Input.*) in real time.
//
// THE FAKE MICROPHONE lives in the page, not in Chrome's device layer. On this Mac, Chrome's own fake audio
// device (--use-fake-device-for-media-stream with --use-file-for-fake-audio-capture) still passes through the
// macOS microphone permission check, and getUserMedia({audio}) never settles headless (video does): that check
// can also raise a system dialog on the owner's screen. So before any page script runs, FAKE_MIC replaces
// navigator.mediaDevices.getUserMedia / enumerateDevices and the microphone permission query: the query says
// "prompt" until MIC ON asks, then "granted"; each getUserMedia plays the WAV from its start through Web Audio
// into a real MediaStream. Everything after that is the app's own code: sound.js's voice gate, MediaRecorder,
// the blob in IndexedDB, breath.kept, the upload to home.
//
// A walk fails (exit 1) on any page error, console error, failed request, unexpected 4xx/5xx, a "dockread:"
// warning from the app, anything readable on a ROLLING frame that SPEC 9.3 does not allow, or a step that
// does not happen. At the end it stops Chrome, both servers, and deletes its temp folder.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SHELL = resolve(HERE, '..');
export const ROOT = resolve(SHELL, '..');
export const PY = process.env.DOCKREAD_PY || 'python3';      // the Python that runs the home service
export const CHROME = process.env.DOCKREAD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const API_PORT = 8660, SHELL_PORT = 8918;
export const OUT = join(HERE, 'out');
const WAV = join(HERE, 'fake-breath.wav');
export const LANE_BRANDS = ['AI', 'NEXT-GEN', 'CRYPTO', 'MACRO', 'PHYSICS'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
export const say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);

/* ---------- the fake breath: quiet lead-in, one second of tone bursts, then silence ---------- */

function makeWav(path) {
  const rate = 48000, lead = 0.8, burst = 1.0, tail = 3.2;
  const n = Math.round(rate * (lead + burst + tail));
  const pcm = Buffer.alloc(n * 2);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = noise() * 0.002;                                   // a whisper of room noise: the floor
    const b = t - lead;
    if (b >= 0 && b < burst) {
      const k = b % (1 / 3);                                   // three bursts of 0.3 s, 33 ms apart
      if (k < 0.3) {
        const env = Math.min(1, k / 0.02, (0.3 - k) / 0.02);  // soft edges, no clicks
        v += env * 0.35 * (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 330 * t));
      }
    }
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

/* ---------- the fake microphone, put into the page before its own scripts (see the header) ---------- */

export const FAKE_MIC = `(function () {
  var granted = false, buf = null, ac = null, md = navigator.mediaDevices, perms = navigator.permissions;
  if (!md) return;
  var query = perms && perms.query ? perms.query.bind(perms) : null;
  if (perms) perms.query = function (d) {
    if (d && d.name === 'microphone') return Promise.resolve({ state: granted ? 'granted' : 'prompt', onchange: null,
      addEventListener: function () {}, removeEventListener: function () {} });
    return query ? query(d) : Promise.reject(new TypeError('no permissions'));
  };
  function load() {
    if (!ac) ac = new AudioContext();
    if (buf) return Promise.resolve(buf);
    return fetch('/tools/fake-breath.wav').then(function (r) { return r.arrayBuffer(); })
      .then(function (a) { return ac.decodeAudioData(a); }).then(function (b) { buf = b; return b; });
  }
  md.getUserMedia = function (c) {
    if (!c || !c.audio) return Promise.reject(new DOMException('audio only', 'NotAllowedError'));
    return load().then(function (b) {
      granted = true;
      var dst = ac.createMediaStreamDestination(), src = ac.createBufferSource();
      src.buffer = b; src.connect(dst);
      if (ac.state !== 'running') ac.resume();
      src.start();
      window.__walkMicOpened = (window.__walkMicOpened || 0) + 1;
      dst.stream.getTracks().forEach(function (t) {
        var stop = t.stop.bind(t);
        t.stop = function () { try { src.stop(); } catch (e) {} stop(); };
      });
      return dst.stream;
    });
  };
  md.enumerateDevices = function () {
    return Promise.resolve([{ kind: 'audioinput', label: granted ? 'Walk fake breath' : '', deviceId: granted ? 'walk' : '', groupId: '' }]);
  };
})();`;

/* ---------- processes ---------- */

function portBusy(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.setTimeout(1500, () => { s.destroy(); res(true); });
  });
}
async function waitHttp(url, okStatus, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); await r.arrayBuffer(); if (okStatus.includes(r.status)) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}
function stopProc(p, name) {
  return new Promise((res) => {
    if (!p || p.exitCode !== null || p.signalCode) { res(); return; }
    const k = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    p.once('exit', () => { clearTimeout(k); res(); });
    try { p.kill('SIGTERM'); } catch { clearTimeout(k); res(); }
  }).then(() => say(`stopped ${name}`));
}

// Seeds the temp home book directly (what the jobs would have written). Reads statements as JSON on stdin.
const SEED_PY = [
  'import json, sqlite3, sys',
  'c = sqlite3.connect(sys.argv[1], timeout=10)',
  'c.execute("PRAGMA busy_timeout=10000")',
  'for sql, params in json.load(sys.stdin):',
  '    c.execute(sql, params)',
  'c.commit()',
  'c.close()',
].join('\n');

/* ---------- the run ---------- */

// walk({name, cleanRe, sizes, main}, body): body(H) is the walk. H is the harness (see below).
export async function walk(opts, body) {
  const { name, cleanRe, sizes } = opts;
  const MAIN = opts.main || sizes[0];
  const report = { ok: false, walk: name, started: new Date().toISOString(), steps: [], errors: [], warnings: [],
    failedRequests: [], notes: [], rolling: {}, events: {}, order: [], counts: null, shots: [], finished: null };
  const fail = (msg) => { report.errors.push(msg); };
  let chrome = null, svc = null, stat = null, ws = null, TMP = null;
  const svcLog = [];
  const allow4xx = [];           // [{status, re}] a step may expect, e.g. a 404 for a breath home has not been told about

  async function main() {
    mkdirSync(OUT, { recursive: true });
    for (const f of readdirSync(OUT)) if (cleanRe.test(f)) rmSync(join(OUT, f));
    makeWav(WAV);
    if (await portBusy(API_PORT)) throw new Error(`port ${API_PORT} is busy; the walk runs its own service there`);
    if (await portBusy(SHELL_PORT)) throw new Error(`port ${SHELL_PORT} is busy; the walk runs its own static server there`);

    TMP = mkdtempSync(join(tmpdir(), 'dockread-walk-'));
    const DATA = join(TMP, 'data');
    const env = { ...process.env, DOCKREAD_DATA: DATA, DOCKREAD_NET: '0', DOCKREAD_JOBS: '0', DOCKREAD_PREVIEW: '1',
      DOCKREAD_OLLAMA: 'http://127.0.0.1:9', DOCKREAD_PORT: String(API_PORT) };
    for (const k of ['DOCKREAD_REGISTRY', 'DOCKREAD_PLACES']) delete env[k];

    // tests/walk_home.py builds the made-up flags book in TMP and becomes the service (same process)
    svc = spawn(PY, [join(ROOT, 'tests', 'walk_home.py'), TMP], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    svc.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l) { svcLog.push(l); if (svcLog.length > 400) svcLog.shift(); } });
    if (!(await waitHttp(`http://127.0.0.1:${API_PORT}/api/health`, [401], 15000))) throw new Error('the home service did not come up');
    stat = spawn(PY, ['-m', 'http.server', String(SHELL_PORT), '--bind', '127.0.0.1', '--directory', SHELL],
      { cwd: SHELL, stdio: 'ignore' });
    if (!(await waitHttp(`http://127.0.0.1:${SHELL_PORT}/registry.json`, [200], 15000))) throw new Error('the static server did not come up');
    say('home service and static server up');

    // the preview link, minted into the temp folder and read only from there; never printed
    execFileSync(PY, [join(ROOT, 'bin', 'dockread-connect'), 'walk-phone', '--preview'], { env, stdio: 'ignore' });
    const link = readFileSync(join(DATA, 'connect_link.txt'), 'utf8').trim();
    if (!link.startsWith(`http://127.0.0.1:${SHELL_PORT}/#cfg=`)) throw new Error('the connect link is not a preview link');

    const prof = join(TMP, 'profile');
    chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', '--user-data-dir=' + prof,
      '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1', `--window-size=${MAIN[0]},${MAIN[1]}`, 'about:blank'], { stdio: 'ignore' });
    let port = null;
    for (let i = 0; i < 150 && !port; i++) {
      await sleep(100);
      const f = join(prof, 'DevToolsActivePort');
      if (existsSync(f)) { const p = readFileSync(f, 'utf8').split('\n'); if (p[1]) port = p; }
    }
    if (!port) throw new Error('Chrome did not start');

    /* ---------- the DevTools door ---------- */
    let seq = 0; const pending = new Map();
    ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools socket')); });
    const handlers = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id) { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.rej(new Error(p.method + ': ' + d.error.message)) : p.res(d.result); return; }
      for (const h of handlers) h(d);
    };
    const send = (method, params = {}, sessionId) => {
      const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((res, rej) => pending.set(id, { res, rej, method }));
    };
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'page');
    const { sessionId: S } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    handlers.push((d) => {
      if (d.sessionId !== S) return;
      const p = d.params || {};
      if (d.method === 'Runtime.exceptionThrown') {
        fail('page error: ' + String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 300));
      } else if (d.method === 'Runtime.consoleAPICalled') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
        if (p.type === 'error' || p.type === 'assert') fail('console error: ' + text);
        else if (p.type === 'warning') { report.warnings.push(text); if (/^dockread:/.test(text)) fail('the app said: ' + text); }
      } else if (d.method === 'Log.entryAdded') {
        const e = p.entry || {};
        if (e.level === 'error') fail(`console ${e.source}: ${String(e.text).slice(0, 200)}`);
      } else if (d.method === 'Network.loadingFailed') {
        if (!p.canceled) report.failedRequests.push(String(p.errorText).slice(0, 80));
      } else if (d.method === 'Network.responseReceived') {
        const r = p.response || {};
        if (r.status >= 400) {
          const u = String(r.url).replace(/[#?].*$/, '');           // never a fragment or a query in the report
          const path = u.replace(/^https?:\/\/[^/]+/, '');
          // the breath door answers 404 to a breath home has not been told about yet, by design
          const ok = (r.status === 404 && /^\/api\/breath\//.test(path)) ||
            allow4xx.some((a) => a.status === r.status && a.re.test(path));
          if (!ok) fail(`HTTP ${r.status} ${path}`);
        }
      }
    });
    await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Log.enable', {}, S);
    await send('Network.enable', {}, S);
    const metrics = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, S);
    await metrics(...MAIN);

    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
      return r.result.value;
    };
    async function waitFor(what, expr, ms = 20000) {
      const end = Date.now() + ms;
      let v;
      while (Date.now() < end) {
        try { v = await ev(expr); } catch { v = null; }
        if (v) return v;
        await sleep(100);
      }
      let seen = '';
      try {
        seen = await ev(`(function () { var b = Array.prototype.slice.call(document.querySelectorAll('.dr-ov button, .dr-strip button'))
          .filter(function (e) { return !e.closest('[hidden]') && e.getBoundingClientRect().width > 0; })
          .map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); });
          var t = document.querySelector('.dr-ov .dr-ctitle');
          return 'mode ' + DR.app.mode() + ', flow ' + DR.app.flow() + ', busy ' + DR.surface.busy() +
            (t ? ', card ' + t.textContent : '') + ', buttons [' + b.join(' | ') + ']'; })()`);
      } catch { /* the page is gone */ }
      throw new Error(`waited ${ms / 1000}s for ${what} (${seen})`);
    }
    const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, S);
    async function press(x, y, ms) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, S);
      await mouse('mousePressed', x, y); await sleep(ms); await mouse('mouseReleased', x, y);
    }
    // The centre of the first visible element that matches and is on top at that point.
    const FIND = `(function (sel, text) {
      var list = Array.prototype.slice.call(document.querySelectorAll(sel));
      for (var i = 0; i < list.length; i++) {
        var e = list[i], r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || e.closest('[hidden]') || e.closest('.gone')) continue;
        if (text !== null && (e.textContent || '').replace(/\\s+/g, ' ').trim() !== text) continue;
        var x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
        if (!top || !(top === e || e.contains(top))) continue;
        return [Math.round(x), Math.round(y)];
      }
      return null;
    })`;
    const find = (sel, text = null) => `${FIND}(${JSON.stringify(sel)}, ${JSON.stringify(text)})`;
    async function tap(what, sel, text = null, { ms = 15000, hold = 70 } = {}) {
      const pt = await waitFor(what, find(sel, text), ms);
      await press(pt[0], pt[1], hold);
      return pt;
    }
    const count = (type) => `DR.store.all().then(function (l) { return l.filter(function (e) { return e.type === ${JSON.stringify(type)}; }).length; })`;
    const atLeast = (type, n) => `DR.store.all().then(function (l) { return l.filter(function (e) { return e.type === ${JSON.stringify(type)}; }).length >= ${n}; })`;
    const idle = `(DR.app.flow() === null && !DR.surface.busy())`;

    // No picture while an overlay is still fading out (a closed card or band keeps its node for a moment).
    const settled = `(document.querySelectorAll('.dr-ov > .gone').length === 0)`;
    // Resize, then wait until the page has laid itself out at that size (fit() runs on resize).
    async function resize(w, h) {
      await metrics(w, h);
      await waitFor(`the page laid out at ${w} x ${h}`, `innerWidth === ${w} && innerHeight === ${h}`, 5000);
      await ev('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(r, 120); }); }); })');
    }
    async function shots(name) {
      for (const [w, h] of sizes) {
        await resize(w, h);
        await waitFor('no overlay still fading', settled, 5000);
        await ev('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })');
        const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, S);
        const file = `${name}-${w}x${h}.png`;
        writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
        report.shots.push(file);
      }
      await resize(...MAIN);
    }
    // SPEC 9.3: what may read on the ROLLING frame, and nothing else.
    async function rollingWords(tag) {                            // read at once: a closing overlay counts too
      // The dial's figure is one phrase drawn as four tspans (7, of, 11, UP): it is read whole, as he sees it.
      const words = await ev(`(function () {
        var out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), figs = [];
        for (var n = w.nextNode(); n; n = w.nextNode()) {
          var t = n.nodeValue.replace(/\\s+/g, ' ').trim(), e = n.parentElement;
          if (!t || !e || e.closest('[hidden]')) continue;
          var fig = e.closest('.dr-fig');
          if (fig) {
            if (figs.indexOf(fig) >= 0) continue;
            figs.push(fig);
            e = fig;
            t = Array.prototype.map.call(fig.childNodes, function (c) { return c.textContent.trim(); })
              .filter(function (s) { return s; }).join(' ');
          }
          var cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          var r = e.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          var o = 1; for (var p = e; p && p.nodeType === 1; p = p.parentElement) o *= +getComputedStyle(p).opacity;
          if (o < 0.05) continue;
          out.push(t);
        }
        return out;
      })()`);
      const ok = (t) => /^\d+ of \d+( (UP|YES))?$/.test(t) || ['UP', 'DOWN', 'YES', 'NO', 'NO DOCKS YET', 'IN', 'DUE', 'LATE',
        'NO DOCKS', 'YET', 'HOME', 'NO LINE', 'NOT SET', 'SOUND', 'MUTED', 'ROLLING', 'PARKED'].includes(t) || LANE_BRANDS.includes(t) ||
        /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d{1,2}$/.test(t);
      const bad = words.filter((t) => !ok(t));
      report.rolling[tag] = { read: words, notAllowed: bad };
      if (bad.length) fail(`ROLLING frame (${tag}) shows words SPEC 9.3 does not allow: ${bad.join(' | ')}`);
      return words;
    }
    async function step(stepName, fn) {
      const s = Date.now();
      say(stepName);
      try { await fn(); report.steps.push({ name: stepName, ok: true, s: +((Date.now() - s) / 1000).toFixed(1) }); }
      catch (e) { report.steps.push({ name: stepName, ok: false, s: +((Date.now() - s) / 1000).toFixed(1), why: String(e.message).slice(0, 300) }); throw e; }
    }
    function seed(statements) {
      execFileSync(PY, ['-c', SEED_PY, join(DATA, 'dockread.db')], { input: JSON.stringify(statements), stdio: ['pipe', 'ignore', 'pipe'] });
    }

    await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_MIC }, S);
    await body({ send, S, ev, waitFor, press, mouse, find, tap, count, atLeast, idle, settled, resize, shots, rollingWords, step,
      seed, fail, report, allow4xx, link, origin: `http://127.0.0.1:${SHELL_PORT}`, TMP });
  }

  main().then(() => {
    report.ok = report.errors.length === 0 && report.steps.every((s) => s.ok);
  }, (e) => {
    fail('walk stopped: ' + String(e.message).slice(0, 300));
  }).finally(async () => {
    try { ws && ws.close(); } catch { /* gone */ }
    if (chrome) await stopProc(chrome, 'Chrome');
    if (stat) await stopProc(stat, 'static server');
    if (svc) await stopProc(svc, 'home service');
    if (TMP) { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } }
    report.finished = new Date().toISOString();
    report.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    if (report.failedRequests.length) fail('failed requests: ' + report.failedRequests.join(', '));
    report.ok = report.ok && report.errors.length === 0;
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(report, null, 1));
    for (const n of report.notes) console.log('  - ' + n);
    for (const e of report.errors) console.log('  ! ' + e);
    if (!report.ok && svcLog.length) {
      console.log('  last lines from the home service:');
      for (const l of svcLog.slice(-15)) console.log('    ' + l.slice(0, 160));
    }
    const label = name.toUpperCase();
    console.log(report.ok ? `${label} GREEN (${report.seconds}s, ${report.shots.length} screenshots)` : `${label} RED`);
    process.exit(report.ok ? 0 : 1);
  });
}
