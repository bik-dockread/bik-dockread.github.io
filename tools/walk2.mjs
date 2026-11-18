// walk2.mjs: DOCK READ end to end, the paths walk.mjs never takes (SPEC 9.12). Headless, muted, real time.
//
//   DOCKREAD_PY=<python> node shell/tools/walk2.mjs
//
// Same harness as walk.mjs (walklib.mjs: its own home service on 127.0.0.1:8660 with a temp DOCKREAD_DATA
// and the made-up flags book, DOCKREAD_NET=0, DOCKREAD_JOBS=0, DOCKREAD_PREVIEW=1; its own static server on
// 8918; Chrome --headless=new --mute-audio with its own temp profile; the in-page fake microphone; trusted
// CDP input in real time; any page error, console error, failed request or unexpected 4xx/5xx fails it).
//
// Where a path needs what home's jobs would have made, the walk writes it into the temp home book itself:
// gists in heard_lines, fetched prints in prints, a publisher's schedule in print_dates. Every value is
// made up for the walk and lives only in the temp folder.
//
// Location: Browser.grantPermissions gives the page geolocation, and Emulation.setGeolocationOverride puts
// the phone at a made-up point a few kilometres off a town centre from places.json; a reading with a speed
// is how the moving guard is fired. A second tab, activated, hides the page (document.visibilityState is
// 'hidden'), the same as a phone switching apps.
//
// Screenshots go to tools/out/ as w2-NN-what-WxH.png at 384 x 780 and 750 x 760; the report is
// tools/out/walk2.json (no URL fragment, no storage value, no request header, no coordinate).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, sleep, SHELL } from './walklib.mjs';

const require = createRequire(import.meta.url);
const SIZES = [[384, 780], [750, 760]];
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n) => String(n).padStart(2, '0');
function addMonths(p, k) {
  let y = +p.slice(0, 4), m = +p.slice(5) + k;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}`;
}
const label = (p) => `${MON[+p.slice(5) - 1]} ${p.slice(0, 4)}`;
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date();
const THIS_MONTH = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}`;
const stamp = () => new Date().toISOString();

// The made-up spot: a few kilometres off one town centre in the list. The town the phone should name is
// worked out with geo.js's own nearest(), so the walk checks the page against the shipped code.
const PLACES = JSON.parse(readFileSync(join(SHELL, 'places.json'), 'utf8'));
const BESIDE = PLACES.rows.find((r) => r[0] === 'JOLIET' && r[1] === 'IL');
const SPOT = { latitude: BESIDE[2] / 100 + 0.021, longitude: BESIDE[3] / 100 - 0.034, accuracy: 30 };
const { nearest } = require(join(SHELL, 'js', 'geo.js'));
const TOWN = nearest(SPOT.latitude, SPOT.longitude, PLACES.rows, 1)[0];
const TOWNS5 = nearest(SPOT.latitude, SPOT.longitude, PLACES.rows, 5);

const GISTS = [
  'A host said winter freight slows after the holidays.',
  'A guest talked about small shops trying new software.',
  'Someone on a show said power bills climbed this year.',
];

walk({ name: 'walk2', cleanRe: /^w2-.*\.png$|^walk2\.json$/, sizes: SIZES, main: [384, 780] }, async (H) => {
  const { send, S, ev, waitFor, press, find, tap, count, atLeast, idle, settled, shots, rollingWords, step, seed, report, link, origin } = H;
  if (!TOWN || TOWNS5.length < 5) throw new Error('the made-up spot has no five towns near it');

  /* ---------- small helpers on top of the harness ---------- */

  const all = (fn) => ev(`DR.store.all().then(function (l) { return (${fn})(l); })`);
  const ofType = (t) => all(`function (l) { return l.filter(function (e) { return e.type === ${JSON.stringify(t)}; }).map(function (e) { return { round: e.round, data: e.data }; }); }`);
  const plate = () => ev("document.querySelector('.dr-plate').textContent.replace(/\\s+/g, ' ').trim()");
  const cardIs = (title) => find('.dr-ov .dr-ctitle', title);
  const cardText = () => ev(`(function () { var c = document.querySelector('.dr-ov > :not(.gone) .dr-card'); if (!c) return null;
    function t(s) { return Array.prototype.slice.call(c.querySelectorAll(s)).map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); }); }
    return { title: t('.dr-ctitle')[0] || '', marks: t('.dr-mark'), lines: t('.dr-line'), acts: t('.dr-act') }; })()`);
  const act = (label, ms) => tap(label, '.dr-ov .dr-act', label, { ms: ms || 10000 });
  const band = (label, ms) => tap(label, '.dr-ov .dr-band', label, { ms: ms || 10000 });
  const seam = () => ev("(function () { var s = document.querySelector('.dr-ov > :not(.gone) .dr-bseam'); return s ? s.textContent.replace(/\\s+/g, ' ').trim() : null; })()");
  const parked = "DR.app.mode() === 'PARKED'";
  const rolling = "DR.app.mode() === 'ROLLING'";
  const want = (cond, msg) => { if (!cond) throw new Error(msg); };

  async function typeIn(text) {
    const pt = await waitFor('the entry', find('.dr-ov .dr-input', null), 8000);
    await press(pt[0], pt[1], 60);
    await ev("(function () { var i = document.querySelector('.dr-ov .dr-input'); i.value = ''; return true; })()");
    await send('Input.insertText', { text }, S);
    await waitFor(`"${text}" in the entry`, `document.querySelector('.dr-ov .dr-input').value === ${JSON.stringify(text)}`, 3000);
  }
  async function toParked() {
    if (await ev(parked)) return;
    await tap('the lever', '.dr-lever');
    await waitFor('PARKED', parked, 5000);
    await waitFor('idle in PARKED', idle, 8000);
  }
  async function toRolling() {
    if (await ev(rolling)) return;
    await tap('the lever', '.dr-lever');
    await waitFor('ROLLING and idle', `${rolling} && ${idle}`, 5000);
  }
  async function lineCard() {
    await tap('the LINE lamp', '.dr-lamp');
    await waitFor('the line card', cardIs('THE LINE'), 8000);
  }
  async function syncNow() {
    await lineCard();
    await act('SYNC NOW');
    await waitFor('SYNCED on the line card', `(function () { var l = document.querySelectorAll('.dr-ov > :not(.gone) .dr-line');
      return Array.prototype.some.call(l, function (e) { return e.textContent.trim() === 'SYNCED'; }); })()`, 15000);
    await act('CLOSE');
    await waitFor('idle after the line card', idle, 8000);
  }
  async function dock(word, n) {
    await tap('JUST LEFT A DOCK', '.dr-dock');
    await waitFor('the halves', find('.dr-h', word), 8000);
    await tap(word, '.dr-h', word, { ms: 4000 });
    await waitFor(`notch ${n} cut`, atLeast('notch.cut', n), 8000);
    await waitFor(`dock ${n} to finish (voice, then the breath)`, idle, 40000);
  }
  async function railPoint(i) {        // the centre of notch i on the rail, or a spot clear of the tag when i is null
    await waitFor('no overlay still fading', settled, 5000);   // a fading overlay still takes the tap
    return ev(`(function (i) {
      if (i !== null) { var n = document.querySelectorAll('.dr-cuts .dr-n')[i]; if (!n) return null;
        var r = n.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; }
      var q = document.querySelector('.dr-rail').getBoundingClientRect();
      for (var x = q.left + q.width * 0.35; x > q.left; x -= 6) {
        var y = q.top + q.height / 2, t = document.elementFromPoint(x, y);
        if (t && !t.closest('.dr-tag') && t.closest('.dr-rail')) return [Math.round(x), Math.round(y)];
      }
      return null; })(${i === null ? 'null' : i})`);
  }
  async function notchCard(i, title) {
    const pt = await railPoint(i);
    want(pt, `no notch ${i} on the rail`);
    await press(pt[0], pt[1], 70);
    await waitFor(`the notch card ${title}`, cardIs(title), 8000);
  }
  const geo = (speed) => send('Emulation.setGeolocationOverride', speed === undefined ? SPOT : { ...SPOT, speed }, S);
  async function tackCard(brand) {     // tap tacks until the card for that lane's call opens
    const n = await ev("document.querySelectorAll('.dr-tacks .dr-tk').length");
    for (let i = 0; i < n; i++) {
      await waitFor('no overlay still fading', settled, 5000);
      const pt = await ev(`(function () { var e = document.querySelectorAll('.dr-tacks .dr-tk')[${i}], r = e.getBoundingClientRect();
        for (var fy = 0.5; fy > 0.05; fy -= 0.1) for (var fx = 0.5; fx > 0.05; fx -= 0.1) {
          var x = r.left + r.width * fx, y = r.top + r.height * fy, top = document.elementFromPoint(x, y);
          if (top && (top === e || e.contains(top))) return [Math.round(x), Math.round(y)];
        }
        return null; })()`);
      want(pt, `tack ${i} is covered at every point`);
      await press(pt[0], pt[1], 70);
      await waitFor('a tack card', "document.querySelector('.dr-ov > :not(.gone) .dr-card') !== null", 5000);
      const c = await cardText();
      if (c.title === `${brand} CALL`) return { i, card: c };
      await act('CLOSE');
      await waitFor('idle', idle, 5000);
    }
    throw new Error(`no tack card for ${brand}`);
  }
  const tackClass = (i) => ev(`document.querySelectorAll('.dr-tacks .dr-tk')[${i}].className`);

  /* ---------- the walk ---------- */

  // Home data the jobs would have made, before the phone ever syncs: business applications for the two
  // months before this one, and the publisher's schedule for this month's figure (a confirmed date).
  const BFS_P = THIS_MONTH, BFS_PREV = addMonths(THIS_MONTH, -1);
  seed([
    ["INSERT INTO prints (series, period, value, label, released, by, source, url, excerpt, fetched_at) VALUES (?,?,?,?,?,'fetch',?,'','',?)",
      ['bfs_applications', addMonths(THIS_MONTH, -2), 480000, label(addMonths(THIS_MONTH, -2)), '', 'CENSUS BFS', stamp()]],
    ["INSERT INTO prints (series, period, value, label, released, by, source, url, excerpt, fetched_at) VALUES (?,?,?,?,?,'fetch',?,'','',?)",
      ['bfs_applications', BFS_PREV, 501609, label(BFS_PREV), '', 'CENSUS BFS', stamp()]],
    ['INSERT INTO print_dates (series, period, label, date, time_et, conf, source, fetched_at) VALUES (?,?,?,?,?,?,?,?)',
      ['bfs_applications', BFS_P, label(BFS_P), day(new Date(Date.now() + 10 * 86400000)), '10:00', 'confirmed', 'CENSUS BFS', stamp()]],
  ]);
  await send('Browser.grantPermissions', { origin, permissions: ['geolocation'] });

  let ISM_P = '';
  await step('w2: connect, cold open, gists seeded at home', async () => {
    await send('Page.navigate', { url: link }, S);
    await waitFor('the app to boot', 'window.DR && DR.app && DR.app.ready && DR.app.ready.then(function () { return true; })', 20000);
    await waitFor('the link scrubbed from the address', "location.hash === ''", 5000);
    await waitFor('the line to read HOME', "DR.store.line() === 'home'", 15000);
    await waitFor('the first round, opened by the app itself', atLeast('round.opened', 1), 15000);
    await waitFor('ROLLING and idle', `${rolling} && ${idle}`, 10000);
    const flags = await waitFor('the flags from home', `(function () { var h = DR.store.home(); var f = h && h.field && h.field.flags;
      return f && f.length >= 3 ? f.map(function (x) { return [x[0], x[1]]; }) : null; })()`, 10000);
    flags.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
    const newest = flags.slice(-3);
    seed(newest.map((f, k) => ['INSERT INTO heard_lines (flag_id, line, model, made_at) VALUES (?,?,?,?)', [f[0], GISTS[k], 'walk', stamp()]]));
    const opened = (await ofType('round.opened'))[0].data;
    want(opened.lane === 'macro' && opened.twin === 'ism_new_orders', 'the first round is not macro / ISM');
    ISM_P = opened.aim.period;
    want(/^\d{4}-\d{2}$/.test(ISM_P), 'the first round has no ISM period to wait on');
    want(await ev("DR.geo.state().then(function (s) { return s === 'granted'; })"), 'location was not granted to the page');
    await geo();                                                // set on the page's own session, after it has loaded
    const fix = await ev('DR.geo.town()');
    want(fix && fix.city === TOWN.city && fix.st === TOWN.st, 'the page cannot find the town beside the made-up spot');
  });

  await step('w2: the setup line card: MIC ON, TOWNS ON, MOVING GUARD OFF, SYNC NOW', async () => {
    await tap('the lever', '.dr-lever');
    await waitFor('PARKED', parked, 5000);
    await waitFor('the setup line card', find('.dr-act', 'TOWNS ON'), 8000);
    await act('MIC ON');
    await waitFor('the card back with MIC CHECK', find('.dr-act', 'MIC CHECK'), 10000);
    await act('TOWNS ON');
    await waitFor('the card back with TOWNS OFF', find('.dr-act', 'TOWNS OFF'), 10000);
    let c = await cardText();
    want(c.lines.some((l) => /MIC ON · TOWNS ON · MOVING GUARD ON/.test(l)), 'the status line does not read MIC ON · TOWNS ON · MOVING GUARD ON');
    want(await ev('DR.store.prefs().towns === true'), 'prefs.towns is not on');
    await shots('w2-01-line-card-towns-on');
    // Headless Chrome's location override answers a one-off fix only while no watch is running (with one, a
    // fix times out; a re-sent override answers it with an error), so the town steps run with the guard off.
    await act('MOVING GUARD OFF');
    await waitFor('the card back with MOVING GUARD ON', find('.dr-act', 'MOVING GUARD ON'), 10000);
    c = await cardText();
    want(c.lines.some((l) => /MIC ON · TOWNS ON · MOVING GUARD OFF/.test(l)), 'the status line does not read MOVING GUARD OFF');
    want(await ev('DR.store.prefs().guard === false'), 'prefs.guard is still on');
    await act('SYNC NOW');
    await waitFor('SYNCED', `(function () { var l = document.querySelectorAll('.dr-ov > :not(.gone) .dr-line');
      return Array.prototype.some.call(l, function (e) { return e.textContent.trim() === 'SYNCED'; }); })()`, 15000);
    await act('CLOSE');
    await waitFor('idle after the card', idle, 8000);
    await waitFor('the gists home made', "(function () { var h = DR.store.home(); return h && h.field && h.field.heard && h.field.heard.length === 3; })()", 8000);
  });

  await step('w2: TOWNS ON: a dock names the town beside the phone', async () => {
    await dock('UP', 1);
    const place = await waitFor('notch.place', `DR.store.all().then(function (l) { var p = l.filter(function (e) { return e.type === 'notch.place'; });
      return p.length ? p[0].data : null; })`, 10000);
    want(place.city === TOWN.city && place.st === TOWN.st, `the dock was placed at ${place.city}, ${place.st}, not the nearest town ${TOWN.city}, ${TOWN.st}`);
    want(Object.keys(place).sort().join(',') === 'city,n,st', 'notch.place carries more than n, city and st');
    await waitFor('the breath on that notch', atLeast('breath.kept', 1), 3000);
    report.notes.push(`town fix: the made-up spot named ${place.city}, ${place.st} (the nearest town by geo.js)`);
    await shots('w2-02-dock-with-town');
  });

  await step('w2: a 1 s hold on the rail pulls the freshest notch inside its 60 s', async () => {
    await dock('DOWN', 2);
    const before = await ev('DR.app.view().n');
    const pt = await railPoint(null);
    want(pt, 'no spot on the rail clear of the tag');
    await press(pt[0], pt[1], 1300);
    await waitFor('notch.pull', atLeast('notch.pull', 1), 5000);
    await waitFor('idle after the pull', idle, 5000);
    want((await ev('DR.app.view().n')) === before - 1, 'the pulled notch is still counted');
    want((await ev(count('notch.flip'))) === 0, 'the hold also flipped');
    const pulled = (await ofType('notch.pull'))[0].data.n, cuts = await ofType('notch.cut');
    want(pulled === cuts[1].data.n, 'the hold pulled a notch that is not the freshest');
    await shots('w2-03-after-hold-pull');
    await dock('UP', 3);
    await waitFor('two breaths kept', atLeast('breath.kept', 2), 3000);
  });

  let hiddenBy = '';
  await step('w2: a hidden page ends the dock and writes nothing', async () => {
    const cuts = await ev(count('notch.cut'));
    await tap('JUST LEFT A DOCK', '.dr-dock');
    await waitFor('the halves', find('.dr-h', 'UP'), 8000);
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    try {
      await send('Target.activateTarget', { targetId });
      await waitFor('the page hidden', "document.visibilityState === 'hidden'", 3000);
      hiddenBy = 'a second tab';
      await waitFor('the halves closed while hidden', `DR.app.flow() === null && !DR.surface.busy()`, 3000);
      await sleep(4000);
    } finally {
      const { targetInfos } = await send('Target.getTargets');
      const mine = targetInfos.find((t) => t.type === 'page' && t.targetId !== targetId);
      if (mine) await send('Target.activateTarget', { targetId: mine.targetId });
      await send('Target.closeTarget', { targetId });
    }
    await waitFor('the page visible again', "document.visibilityState === 'visible'", 5000);
    want(await ev(parked), 'a short hide dropped PARKED (only two minutes hidden may)');
    want((await ev(count('notch.cut'))) === cuts, 'a notch was cut by a hidden page');
    report.notes.push(`hidden page: made hidden by ${hiddenBy} (document.visibilityState was 'hidden')`);
  });

  await step('w2: MUTED, on the ROLLING frame and kept', async () => {
    await toRolling();
    await tap('SOUND', '.dr-mute', 'SOUND');
    await waitFor('MUTED', find('.dr-mute', 'MUTED'), 3000);
    want(await ev('DR.store.prefs().muted === true'), 'prefs.muted is not on');
    await rollingWords('muted');
    await shots('w2-04-rolling-muted');
    await tap('MUTED', '.dr-mute', 'MUTED');
    await waitFor('SOUND', find('.dr-mute', 'SOUND'), 3000);
    want(await ev('DR.store.prefs().muted === false'), 'prefs.muted stayed on');
  });

  await step('w2: the notch card after the 60 s window: PREV, NEXT, PLAY, TOWN, DROP BREATH twice', async () => {
    const lastAt = await all("function (l) { var c = l.filter(function (e) { return e.type === 'notch.cut'; }); return Date.parse(c[c.length - 1].at); }");
    const left = lastAt + 61500 - Date.now();
    if (left > 0) await sleep(left);                         // ROLLING meanwhile, so PARKED cannot time out
    await toParked();
    const notches = await ev('DR.app.view().notches.length');
    want(notches === 2, `expected 2 notches on the rail, saw ${notches}`);
    await notchCard(0, 'DOCK 1 OF 2');
    let c = await cardText();
    want(c.marks.includes('YOUR BREATH'), 'the notch card does not say YOUR BREATH');
    want(c.lines.includes(`${TOWN.city}, ${TOWN.st}`), 'the notch card does not show the town');
    want(['NEXT', 'PLAY', 'FLIP', 'PULL', 'TOWN', 'DROP BREATH', 'CLOSE'].every((a) => c.acts.includes(a)) && !c.acts.includes('PREV'), `notch card actions: ${c.acts.join(' | ')}`);
    want((await ev(count('notch.flip'))) === 0, 'opening the card flipped the notch');
    await shots('w2-05-notch-card');
    await act('NEXT');
    await waitFor('DOCK 2 OF 2', cardIs('DOCK 2 OF 2'), 5000);
    want((await cardText()).acts.includes('PREV'), 'no PREV on the second notch');
    await act('PREV');
    await waitFor('DOCK 1 OF 2', cardIs('DOCK 1 OF 2'), 5000);
    await act('PLAY');
    await waitFor('the card back after PLAY', cardIs('DOCK 1 OF 2'), 15000);
    c = await cardText();
    want(!c.lines.includes('NOT ON THIS PHONE'), 'PLAY says the breath is not on this phone');
    await act('TOWN');
    await waitFor('WHICH TOWN?', cardIs('WHICH TOWN?'), 10000);
    c = await cardText();
    const listed = c.acts.filter((a) => /, [A-Z]{2}$/.test(a));
    want(listed.length === 5, `the town picker lists ${listed.length} towns, not 5`);
    want(listed.join('|') === TOWNS5.map((t) => `${t.city}, ${t.st}`).join('|'), 'the town picker is not the five nearest towns');
    want(c.acts.includes('TYPE THREE LETTERS') && c.acts.includes('NO TOWN'), 'the picker lacks TYPE THREE LETTERS or NO TOWN');
    await shots('w2-06-town-picker');
    const first = (await ofType('notch.cut'))[0].data.n, places = await ev(count('notch.place'));
    await act(listed[1]);
    await waitFor('the second town stored on that notch', `DR.store.all().then(function (l) { var p = l.filter(function (e) { return e.type === 'notch.place'; });
      var x = p[p.length - 1]; return p.length === ${places} + 1 && x.data.n === ${JSON.stringify(first)} &&
        x.data.city === ${JSON.stringify(TOWNS5[1].city)} && x.data.st === ${JSON.stringify(TOWNS5[1].st)}; })`, 5000);
    await waitFor('DOCK 1 OF 2 again', cardIs('DOCK 1 OF 2'), 5000);
    want((await cardText()).lines.includes(`${TOWNS5[1].city}, ${TOWNS5[1].st}`), 'the card does not show the new town');
    const b = await all("function (l) { return l.filter(function (e) { return e.type === 'breath.kept' && e.data.of === 'notch'; })[0].data.b; }");
    await act('DROP BREATH');
    await waitFor('DROP THIS BREATH?', cardIs('DROP THIS BREATH?'), 5000);
    await shots('w2-07-drop-confirm');
    want((await ev(count('breath.dropped'))) === 0, 'the first tap dropped the breath');
    await act('DROP IT');
    await waitFor('breath.dropped', atLeast('breath.dropped', 1), 5000);
    want((await ofType('breath.dropped'))[0].data.b === b, 'the wrong breath was dropped');
    await waitFor('DOCK 1 OF 2 without its breath', cardIs('DOCK 1 OF 2'), 5000);
    c = await cardText();
    want(!c.acts.includes('PLAY') && !c.acts.includes('DROP BREATH') && !c.marks.includes('YOUR BREATH'), 'the card still offers the dropped breath');
    want(await ev(`DR.store.getBlob(${JSON.stringify(b)}).then(function (x) { return x === null; })`), 'the dropped breath is still on the phone');
    await shots('w2-08-notch-card-dropped');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
  });

  await step('w2: MOVING GUARD ON from the line card', async () => {
    await lineCard();
    await act('MOVING GUARD ON');
    await waitFor('the card back with MOVING GUARD OFF', find('.dr-act', 'MOVING GUARD OFF'), 10000);
    want(await ev('DR.store.prefs().guard === true'), 'prefs.guard is not on');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
    await sleep(1000);                                          // the guard's first reading (no speed) lands
    want(await ev(parked), 'the guard dropped PARKED with no speed');
  });

  await step('w2: the moving guard ends a dock: ROLLING, nothing cut', async () => {
    const cuts = await ev(count('notch.cut'));
    await tap('JUST LEFT A DOCK', '.dr-dock');
    await waitFor('the halves', find('.dr-h', 'UP'), 8000);
    await geo(10);                                              // 10 m/s, over the 6.7 m/s guard
    await waitFor('ROLLING by the guard', rolling, 3000);
    await rollingWords('guard-dock');                           // at once: the closing halves must not show here
    want(await ev(idle), 'the dock flow or its halves outlived the guard');
    want((await ev(count('notch.cut'))) === cuts, 'the guard let a notch be cut');
    await geo(0);
    report.notes.push('the guard asks for readings up to 5 s old: the walk waits 6 s after a speed before it parks again');
    await shots('w2-09-rolling-after-guard');
  });

  await step('w2: a card action still running when the guard fires leaves no card on ROLLING (15.1)', async () => {
    await sleep(6000);                                          // past the guard's 5 s maximumAge for the speed reading
    await toParked();
    await notchCard(1, 'DOCK 2 OF 2');
    await act('PLAY');
    await waitFor('PLAY running (the card stepped away)', "document.querySelector('.dr-ov > :not(.gone) .dr-card') === null", 3000);
    await geo(10);
    await waitFor('ROLLING by the guard', rolling, 3000);
    await rollingWords('guard-card-at-once');
    const end = Date.now() + 7000;                              // longer than the clip: the card must not come back
    while (Date.now() < end) {
      const bad = await ev(`${rolling} && (DR.surface.busy() || document.querySelector('.dr-ov > :not(.gone)') !== null) || !(${rolling})`);
      if (bad) throw new Error('a card came back on the ROLLING screen (or PARKED came back)');
      await sleep(150);
    }
    await geo(0);
    await rollingWords('guard-card');
  });

  await step('w2: the heard card: HEARD, NOT YOURS; GIST, BY MACHINE; NEXT and PREV', async () => {
    await sleep(6000);                                          // past the guard's 5 s maximumAge for the speed reading
    await toParked();
    await waitFor('no overlay still fading', settled, 5000);
    const pt = await ev("(function () { var r = document.querySelector('.dr-fieldw').getBoundingClientRect(); return [Math.round(r.left + r.width * 0.5), Math.round(r.top + r.height * 0.6)]; })()");
    await press(pt[0], pt[1], 70);
    await waitFor('the heard card', cardIs('HEARD'), 5000);
    let c = await cardText();
    want(c.marks.join('|') === 'HEARD, NOT YOURS|GIST, BY MACHINE', `heard marks: ${c.marks.join(' | ')}`);
    want(GISTS.includes(c.lines[0]), 'the heard card does not show a gist from home');
    const first = c.lines[0];
    await shots('w2-10-heard-card');
    await act('NEXT');
    await waitFor('the next gist', `(function () { var l = document.querySelector('.dr-ov > :not(.gone) .dr-line'); return l && l.textContent !== ${JSON.stringify(first)}; })()`, 5000);
    c = await cardText();
    want(GISTS.includes(c.lines[0]) && c.acts.includes('PREV'), 'NEXT did not show another gist with PREV');
    await act('PREV');
    await waitFor('the first gist again', `(function () { var l = document.querySelector('.dr-ov > :not(.gone) .dr-line'); return l && l.textContent === ${JSON.stringify(first)}; })()`, 5000);
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
  });

  await step('w2: print by hand refused for too many decimals, then taken (15.17)', async () => {
    await tap('the tin tag', '.dr-tag');
    await waitFor('the tag card', find('.dr-act', 'SET PRINT BY HAND'), 8000);
    await act('SET PRINT BY HAND');
    await waitFor('the ISM entry', cardIs(`ISM NEW ORDERS · ${label(ISM_P)}`), 5000);
    await typeIn('55.55');
    await act('OK');
    await waitFor('NOT THAT NUMBER', cardIs('NOT THAT NUMBER'), 5000);
    const c = await cardText();
    want(c.lines.includes('A number from 20 to 80, at most one decimal.'), `the refusal reads: ${c.lines.join(' | ')}`);
    want((await ev(count('print.hand'))) === 0, '55.55 was written');
    await shots('w2-11-hand-refused');
    await act('TRY AGAIN');
    await typeIn('55.5');
    await act('OK');
    await waitFor('print.hand', atLeast('print.hand', 1), 5000);
    const h = (await ofType('print.hand'))[0].data;
    want(h.series === 'ism_new_orders' && h.period === ISM_P && h.value === 55.5, 'the hand print is not ISM 55.5 for the awaited month');
    await waitFor('idle', idle, 8000);
    await waitFor('the tin tag to read IN', "DR.app.view().tag.text === 'IN'", 5000);
  });

  await step('w2: the macro moment, call UP, the why, MONEY', async () => {
    await tap('the dial', '.dr-stage .dr-dial');
    await waitFor('the call halves', find('.dr-h', 'UP'), 60000);
    await tap('UP', '.dr-h', 'UP', { ms: 3000 });
    await waitFor('call.made', atLeast('call.made', 1), 30000);
    await waitFor('the move bands', find('.dr-band', 'MONEY'), 30000);
    await band('MONEY');
    await waitFor('round.closed', atLeast('round.closed', 1), 8000);
  });

  await step('w2: the turn: NEXT reads the next lane, TAKE IT on CRYPTO', async () => {
    await waitFor('the turn bands', find('.dr-band', 'TAKE IT'), 20000);
    want((await seam()) === 'ANYBODY HERE USING AI FOR REAL?', 'the first offer after macro is not the AI question');
    await band('NEXT');
    await waitFor('the next-gen offer', "(function () { var s = document.querySelector('.dr-ov > :not(.gone) .dr-bseam'); return s && s.textContent.trim() === 'KNOW ANYBODY WHO STARTED A BUSINESS THIS YEAR?'; })()", 5000);
    await shots('w2-12-turn-after-next');
    await band('NEXT');
    await waitFor('the crypto offer', "(function () { var s = document.querySelector('.dr-ov > :not(.gone) .dr-bseam'); return s && s.textContent.trim() === 'ANYBODY HERE OWN ANY CRYPTO?'; })()", 5000);
    await band('TAKE IT');
    await waitFor('the crypto round', atLeast('round.opened', 2), 8000);
    const o = (await ofType('round.opened'))[1].data;
    want(o.lane === 'crypto' && o.twin === null && o.origin === 'canon', 'the second round is not canon crypto');
    await waitFor('idle', idle, 15000);
  });

  await step('w2: grading: a later print seeded at home, SYNC NOW, the tack turns dull and reads right', async () => {
    const awaited = addMonths(ISM_P, 1);
    seed([["INSERT INTO prints (series, period, value, label, released, by, source, url, excerpt, fetched_at) VALUES (?,?,?,?,?,'fetch',?,'','',?)",
      ['ism_new_orders', awaited, 52.0, label(awaited), '', 'ISM PDF', stamp()]]]);
    await syncNow();
    await waitFor('call.graded', atLeast('call.graded', 1), 8000);
    const g = (await ofType('call.graded'))[0].data;
    want(g.grade === 0 && g.print.period === awaited && g.print.value === 52 && g.base.value === 55.5, 'the grade is not 0 on the awaited month against his 55.5');
    const { i, card } = await tackCard('MACRO');
    want(/lost/.test(await tackClass(i)), 'the macro tack is not dull');
    want(card.lines.includes(`YOU CALLED UP ON ISM NEW ORDERS ${label(ISM_P)}: 55.5 BY HAND`), `tack card: ${card.lines.join(' | ')}`);
    want(card.lines.includes(`IT DIDN'T STAND ON ${label(awaited)} 52.0`), `tack card: ${card.lines.join(' | ')}`);
    want(card.acts.includes('PLAY YOUR WHY'), 'the tack card has no PLAY YOUR WHY');
    await shots('w2-13-tack-card-dull');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
    // the publisher's own figure for the month he typed arrives later: FETCHED SINCE, and the grade stands
    seed([["INSERT INTO prints (series, period, value, label, released, by, source, url, excerpt, fetched_at) VALUES (?,?,?,?,?,'fetch',?,'','',?)",
      ['ism_new_orders', ISM_P, 55.3, label(ISM_P), '', 'ISM PDF', stamp()]]]);
    await syncNow();
    const again = await tackCard('MACRO');
    want(again.card.lines.includes(`${label(ISM_P)} FETCHED SINCE: 55.3`), `tack card: ${again.card.lines.join(' | ')}`);
    want(!again.card.lines.some((l) => /REVISED SINCE/.test(l)), 'the tack card says REVISED SINCE for a figure he typed');
    want((await ev(count('call.graded'))) === 1, 'the call was graded twice');
    await shots('w2-14-tack-card-fetched-since');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
  });

  await step('w2: CLOSE THE RAIL on CRYPTO (no twin): an own close', async () => {
    await dock('YES', 4);
    await tap('the tin tag', '.dr-tag');
    await waitFor('the crypto tag card', find('.dr-act', 'CLOSE THE RAIL'), 8000);
    const c = await cardText();
    want(c.marks.includes('ONLY YOURS') && c.lines.includes('No print for this one.'), `crypto tag card: ${c.marks.join(' | ')} / ${c.lines.join(' | ')}`);
    await shots('w2-15-crypto-tag-card');
    await act('CLOSE THE RAIL');
    await waitFor('the moment', "DR.app.flow() === 'moment'", 5000);
    await waitFor('WHAT DID THE DOCKS TELL YOU?', `document.querySelector('.dr-plate').textContent.trim() === "WHAT DID THE DOCKS TELL YOU?"`, 30000);
    await shots('w2-16-own-close-plate');
    await waitFor('call.made', atLeast('call.made', 2), 30000);
    await waitFor('the move bands', find('.dr-band', 'HELP'), 30000);
    await band('HELP');
    await waitFor('round.closed', atLeast('round.closed', 2), 8000);
    const made = (await ofType('call.made'))[1].data, closed = (await ofType('round.closed'))[1].data;
    want(made.series === null && made.up === null && made.from === null, 'the crypto call is not an own call');
    want(closed.reason === 'own' && closed.print === null, 'the crypto round did not close as its own');
  });

  await step('w2: TAKE IT on NEXT-GEN, aimed at the confirmed date home has', async () => {
    await waitFor('the turn bands', find('.dr-band', 'TAKE IT'), 20000);
    want((await seam()) === 'POWER BILL UP OR DOWN?', 'the first offer after crypto is not physics');
    for (const q of ['ORDERS UP OR DOWN?', 'ANYBODY HERE USING AI FOR REAL?', 'KNOW ANYBODY WHO STARTED A BUSINESS THIS YEAR?']) {
      await band('NEXT');
      await waitFor(q, `(function () { var s = document.querySelector('.dr-ov > :not(.gone) .dr-bseam'); return s && s.textContent.trim() === ${JSON.stringify(q)}; })()`, 5000);
    }
    await band('TAKE IT');
    await waitFor('the next-gen round', atLeast('round.opened', 3), 8000);
    const o = (await ofType('round.opened'))[2].data;
    want(o.lane === 'nextgen' && o.twin === 'bfs_applications', 'the third round is not next-gen / business applications');
    want(o.aim.period === BFS_P && o.aim.after === BFS_PREV && o.aim.conf === 'confirmed', `next-gen aim: ${o.aim.period} after ${o.aim.after} ${o.aim.conf}`);
    await waitFor('idle', idle, 15000);
  });

  await step("w2: a level twin's moment: the print on the plate, its move, no hand, no arrow (15.15)", async () => {
    await dock('YES', 5);
    seed([["INSERT INTO prints (series, period, value, label, released, by, source, url, excerpt, fetched_at) VALUES (?,?,?,?,?,'fetch',?,'','',?)",
      ['bfs_applications', BFS_P, 512345, label(BFS_P), '', 'CENSUS BFS', stamp()]]]);
    await syncNow();
    await waitFor('the tin tag to read IN', "DR.app.view().tag.text === 'IN'", 5000);
    want((await ev('DR.app.view().hand')) === null, 'a level twin has a hand in the view');
    await tap('the dial', '.dr-stage .dr-dial');
    await waitFor('PRINT 512,345 on the plate', "document.querySelector('.dr-plate').textContent.trim() === 'PRINT 512,345'", 30000);
    await waitFor('its move on the plate', "/^UP \\d+\\.\\d%$/.test(document.querySelector('.dr-plate').textContent.trim())", 10000);
    const mv = await plate();
    want(mv === 'UP 2.1%', `the move reads ${mv}, not UP 2.1%`);
    await waitFor('the call halves', find('.dr-h', 'UP'), 30000);
    const dial = "(function () { return [document.querySelector('.dr-ph').getAttribute('opacity'), document.querySelector('.dr-ar').getAttribute('opacity')]; })()";
    let o = await ev(dial);
    want(o[0] === '0' && o[1] === '0', `hand / arrow opacity ${o.join(' / ')} on a level twin`);
    await shots('w2-17-level-moment-halves');
    await tap('UP', '.dr-h', 'UP', { ms: 3000 });
    await waitFor('call.made', atLeast('call.made', 3), 30000);
    o = await ev(dial);
    want(o[0] === '0' && o[1] === '0', `after the call: hand / arrow opacity ${o.join(' / ')} on a level twin`);
    await waitFor('the move bands', find('.dr-band', 'POSITION'), 30000);
    await band('POSITION');
    await waitFor('round.closed', atLeast('round.closed', 3), 8000);
    const made = (await ofType('call.made'))[2].data;
    want(made.series === 'bfs_applications' && made.from.period === BFS_P && made.from.value === 512345 && made.up === true, 'the next-gen call is wrong');
  });

  const PHYS_P = addMonths(THIS_MONTH, -1);
  await step('w2: TAKE IT on PHYSICS', async () => {
    await waitFor('the turn bands', find('.dr-band', 'TAKE IT'), 20000);
    want((await seam()) === 'ANYBODY HERE OWN ANY CRYPTO?', 'the first offer after next-gen is not crypto');
    await band('NEXT');
    await waitFor('the physics offer', "(function () { var s = document.querySelector('.dr-ov > :not(.gone) .dr-bseam'); return s && s.textContent.trim() === 'POWER BILL UP OR DOWN?'; })()", 5000);
    await band('TAKE IT');
    await waitFor('the physics round', atLeast('round.opened', 4), 8000);
    await waitFor('idle', idle, 15000);
  });

  await step("w2: the tack card's SET <label> BY HAND for the awaited month (15.12)", async () => {
    const awaited = addMonths(BFS_P, 1);
    const { i, card } = await tackCard('NEXT-GEN');
    want(card.lines.includes(`WAITING ON ${label(awaited)}`), `tack card: ${card.lines.join(' | ')}`);
    want(card.acts.includes(`SET ${label(awaited)} BY HAND`), `tack card actions: ${card.acts.join(' | ')}`);
    want(!/won|lost/.test(await tackClass(i)), 'the pending tack is not plain');
    await shots('w2-18-tack-card-waiting');
    await act(`SET ${label(awaited)} BY HAND`);
    await waitFor('the entry for the awaited month', cardIs(`BUSINESS APPLICATIONS · ${label(awaited)}`), 5000);
    await typeIn('520,000');
    await act('OK');
    await waitFor('print.hand for the awaited month', atLeast('print.hand', 2), 5000);
    const roundIds = (await ofType('round.opened'));
    const nextgenRound = await all("function (l) { return l.filter(function (e) { return e.type === 'round.opened' && e.data.lane === 'nextgen'; })[0].round; }");
    const h = (await ofType('print.hand'))[1];
    want(h.data.period === awaited && h.data.value === 520000 && h.round === nextgenRound, 'the hand print is not the awaited month on the next-gen round');
    want(roundIds.length === 4, 'a round opened from the tack card');
    await waitFor('call.graded on home\'s answer', atLeast('call.graded', 2), 10000);
    const g = (await ofType('call.graded'))[1].data;
    want(g.grade === 1 && g.print.period === awaited && g.print.value === 520000, 'the next-gen grade is not 1 on the month typed');
    await waitFor('idle', idle, 5000);
    want(/won/.test(await tackClass(i)), 'the next-gen tack did not turn bright');
    const again = await tackCard('NEXT-GEN');
    want(again.card.lines.includes(`IT STOOD ON ${label(awaited)} 520,000 BY HAND`), `tack card: ${again.card.lines.join(' | ')}`);
    await shots('w2-19-tack-card-bright');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
  });

  await step('w2: the power price typed in cents, refused past one decimal, kept in dollars (15.17)', async () => {
    await tap('the tin tag', '.dr-tag');
    await waitFor('the tag card', find('.dr-act', 'SET PRINT BY HAND'), 8000);
    await act('SET PRINT BY HAND');
    await waitFor('the power entry', cardIs(`POWER PRICE · ${label(PHYS_P)}`), 5000);
    want((await cardText()).lines.includes('3 TO 150 CENTS'), 'the power entry is not hinted in cents');
    await typeIn('18.45');
    await shots('w2-20-power-entry-cents');
    await act('OK');
    await waitFor('NOT THAT NUMBER', cardIs('NOT THAT NUMBER'), 5000);
    want((await cardText()).lines.includes('A number from 3 to 150 cents, at most one decimal.'), 'the cents refusal does not say why');
    await act('TRY AGAIN');
    await typeIn('18.4');
    await act('OK');
    await waitFor('print.hand', atLeast('print.hand', 3), 5000);
    const h = (await ofType('print.hand'))[2].data;
    want(h.series === 'bls_power_price' && h.period === PHYS_P && h.value === 0.184, `the power print is ${h.value} for ${h.period}`);
    await waitFor('PRINT 18.4¢ BY HAND', "document.querySelector('.dr-plate').textContent.trim() === 'PRINT 18.4¢ BY HAND'", 5000);
    await waitFor('idle', idle, 8000);
    await shots('w2-21-power-by-hand');
  });

  await step('w2: the physics moment with no docks, the move left to drain', async () => {
    await waitFor('the tin tag to read IN', "DR.app.view().tag.text === 'IN'", 5000);
    await tap('the dial', '.dr-stage .dr-dial');
    await waitFor('the call halves', find('.dr-h', 'DOWN'), 30000);
    want((await ev("[document.querySelector('.dr-ph').getAttribute('opacity'), document.querySelector('.dr-ar').getAttribute('opacity')].join('/')")) === '0/0', 'a level twin drew a hand or an arrow');
    await tap('DOWN', '.dr-h', 'DOWN', { ms: 3000 });
    await waitFor('call.made', atLeast('call.made', 4), 30000);
    await waitFor('the move bands', find('.dr-band', 'HELP'), 30000);
    await waitFor('round.closed after the bands drain', atLeast('round.closed', 4), 20000);
    want((await ofType('call.move'))[3].data.move === 'none', 'a drained move is not none');
  });

  await step('w2: MY OWN in the turn: a typed question, the word pair', async () => {
    await waitFor('the turn bands', find('.dr-band', 'MY OWN'), 20000);
    want((await seam()) === 'ORDERS UP OR DOWN?', 'the first offer after physics is not macro');
    await band('MY OWN');
    await waitFor('the entry for his own question', cardIs('YOUR OWN QUESTION · MACRO'), 5000);
    await typeIn('any freight moving');
    await shots('w2-22-my-own-entry');
    await act('OK');
    await waitFor('the word pair bands', find('.dr-band', 'YES / NO'), 5000);
    want((await seam()) === 'ANY FREIGHT MOVING?', 'the question was not upper-cased with a ? added');
    await shots('w2-23-my-own-pair');
    await band('YES / NO');
    await waitFor('his own round', atLeast('round.opened', 5), 8000);
    const o = (await ofType('round.opened'))[4].data;
    want(o.origin === 'own' && o.twin === null && o.lane === 'macro' && o.q === 'ANY FREIGHT MOVING?' && o.words.join('/') === 'YES/NO', 'his own round is wrong');
    await waitFor('idle', idle, 15000);
    want(await ev("document.querySelector('.dr-plate').textContent.trim() === 'ANY FREIGHT MOVING?'"), 'the plate does not carry his question');
    await shots('w2-24-my-own-round');
  });

  await step('w2: everything home; the dropped breath is gone from home too', async () => {
    const c = await waitFor('a clean sync', `DR.store.sync().then(function () { var k = DR.store.counts(); return k.unsent === 0 && k.refused === 0 && k.breathsNotHome === 0 ? k : null; })`, 20000);
    report.counts = { unsent: c.unsent, refused: c.refused, breathsNotHome: c.breathsNotHome, registryMismatch: c.registryMismatch };
    const dropped = (await ofType('breath.dropped'))[0].data.b;
    want(await ev(`(function () { var b = (DR.store.home() || {}).breaths || {}; return !Object.prototype.hasOwnProperty.call(b, ${JSON.stringify(dropped)}); })()`), 'home still lists the dropped breath');
    const evs = await all('function (l) { return l.map(function (e) { return e.type; }); }');
    report.order = evs;
    for (const t of evs) report.events[t] = (report.events[t] || 0) + 1;
  });

  await step('w2: #reset keeps the key and the book, and reloads', async () => {
    await toRolling();
    const before = await ev('DR.store.all().then(function (l) { return l.length; })');
    await ev('window.__walkBeforeReset = true');
    // a marker in this app's shell cache: #reset deletes the cache, so the marker must be gone after it
    const marked = await ev(`caches.keys().then(function (k) { var c = k.filter(function (n) { return n.indexOf('dockread-shell-') === 0; });
      if (!c.length) return false; return caches.open(c[0]).then(function (x) { return x.put('/walk-reset-marker', new Response('x')); }).then(function () { return true; }); })`);
    want(marked, 'no dockread-shell- cache to mark before the reset');
    await send('Page.navigate', { url: `${origin}/#reset` }, S);
    await waitFor('the reload', '!window.__walkBeforeReset && window.DR && DR.app && DR.app.ready && DR.app.ready.then(function () { return true; })', 20000);
    await waitFor('#reset scrubbed', "location.hash === ''", 5000);
    await waitFor('ROLLING and idle after the reset', `${rolling} && ${idle}`, 10000);
    want(await ev('DR.store.cfg() !== null'), 'the reset dropped the key');
    want(await ev("caches.match('/walk-reset-marker').then(function (r) { return r === undefined; })"), 'the reset left the shell cache in place');
    want((await ev('DR.store.all().then(function (l) { return l.length; })')) === before, 'the reset changed the book');
    await waitFor('the line to read HOME', "DR.store.line() === 'home'", 15000);
    await rollingWords('after-reset');
    await shots('w2-25-after-reset');
  });

  await step('w2: FORGET THIS KEY asks twice, keeps the book', async () => {
    await toParked();
    const before = await ev('DR.store.all().then(function (l) { return l.length; })');
    await lineCard();
    await act('FORGET THIS KEY');
    await waitFor('FORGET THIS KEY?', cardIs('FORGET THIS KEY?'), 5000);
    want(await ev('DR.store.cfg() !== null'), 'the first tap forgot the key');
    await shots('w2-26-forget-confirm');
    await act('FORGET IT');
    await waitFor('the line card without a key', cardIs('THE LINE'), 5000);
    await waitFor('NOT SET', "DR.store.cfg() === null && DR.store.line() === 'unset'", 5000);
    const c = await cardText();
    want(c.marks.includes('NOT SET') && !c.acts.includes('FORGET THIS KEY') && !c.acts.includes('SYNC NOW'), `line card after forget: ${c.marks.join(' | ')} / ${c.acts.join(' | ')}`);
    want((await ev('DR.store.all().then(function (l) { return l.length; })')) === before, 'forgetting the key changed the book');
    await shots('w2-27-line-card-not-set');
    await act('CLOSE');
    await waitFor('idle', idle, 5000);
    await toRolling();
    await waitFor('the lamp word NOT SET', find('.dr-lampword', 'NOT SET'), 5000);
    await rollingWords('not-set');
  });
});
