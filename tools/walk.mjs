// walk.mjs: DOCK READ end to end, the real thing, headless and muted, in real time (SPEC 9.12).
//
//   DOCKREAD_PY=<python> node shell/tools/walk.mjs
//
// The harness (its own home service on 127.0.0.1:8660 with a temp data folder and the made-up flags book,
// its own static server on 127.0.0.1:8918, a windowless muted Chrome with its own profile, the in-page fake
// microphone, trusted input in real time, and every failure rule) is in walklib.mjs; read its header.
//
// This walk: connect, cold open, the read, the line card (MIC ON), a dock with a thumb and a breath, three
// more docks, a flip, the print by hand, the moment, the call, the why, the move, the turn, TAKE IT, the tack
// card and the counter view, then back to ROLLING, and everything home. walk2.mjs takes the other paths.
// Every step waits on what the page is doing (a state, an overlay, an event in the book), never on a fixed
// sleep, so a tap never lands in the wrong step.
//
// Screenshots go to tools/out/ (git-ignored) at 384 x 780, 384 x 860 and 750 x 760; the JSON report is
// tools/out/walk.json and holds no URL fragment, no storage value and no request header.
import { walk, sleep } from './walklib.mjs';

const SIZES = [[384, 780], [384, 860], [750, 760]];

walk({ name: 'walk', cleanRe: /^\d\d-.*\.png$|^walk\.json$/, sizes: SIZES, main: [384, 860] }, async (H) => {
  const { send, S, ev, waitFor, press, find, tap, atLeast, idle, shots, rollingWords, step, report, link } = H;

  await step('connect and cold open', async () => {
    await send('Page.navigate', { url: link }, S);
    await waitFor('the mic not granted before MIC ON', "DR.sound && DR.sound.micState().then(function (m) { return m !== 'granted'; })", 20000);
    await waitFor('the app to boot', 'window.DR && DR.app && DR.app.ready && DR.app.ready.then(function () { return true; })', 20000);
    await waitFor('the link scrubbed from the address', "location.hash === ''", 5000);
    await waitFor('the line to read HOME', "DR.store.line() === 'home'", 15000);
    await waitFor('the first round, opened by the app itself', atLeast('round.opened', 1), 15000);
    await waitFor('ROLLING and idle', `DR.app.mode() === 'ROLLING' && ${idle}`, 10000);
    await waitFor('the lamp word HOME', find('.dr-lampword', 'HOME'), 5000);
    await rollingWords('cold');
    await shots('01-cold-rolling');
  });

  await step('ROLLING: one tap is the read, and nothing else changes', async () => {
    const before = await ev('DR.store.all().then(function (l) { return l.length; })');
    await tap('the stage', '.dr-stage .dr-dial');
    await sleep(600);
    const after = await ev('DR.store.all().then(function (l) { return l.length; })');
    if (after !== before) throw new Error('the read wrote an event');
    if (!(await ev(`DR.app.mode() === 'ROLLING' && !DR.surface.busy()`))) throw new Error('the read changed the mode or opened something');
  });

  await step('PARKED: the line card opens once; MIC ON', async () => {
    await tap('the lever', '.dr-lever');
    await waitFor('PARKED', "DR.app.mode() === 'PARKED'", 5000);
    await waitFor('the setup line card with MIC ON', find('.dr-act', 'MIC ON'), 8000);
    await shots('02-line-card-setup');
    await tap('MIC ON', '.dr-act', 'MIC ON');
    await waitFor('the card to come back with MIC CHECK', find('.dr-act', 'MIC CHECK'), 10000);
    await shots('03-line-card-mic-on');
    await tap('CLOSE', '.dr-act', 'CLOSE');
    await waitFor('idle after the card', idle, 8000);
  });

  async function dock(word, k, shotName) {
    await tap('JUST LEFT A DOCK', '.dr-dock');
    await waitFor('the halves', find('.dr-h', word), 8000);
    if (shotName) await shots(shotName);
    await tap(word, '.dr-h', word, { ms: 4000 });
    await waitFor(`notch ${k} cut`, atLeast('notch.cut', k), 8000);
    await waitFor(`dock ${k} to finish (voice, then the breath)`, idle, 40000);
  }

  await step('a dock with a thumb and a breath', async () => {
    await dock('UP', 1, '04-dock-halves');
    await waitFor('the breath kept on that notch', atLeast('breath.kept', 1), 2000);
    await shots('05-after-first-dock');
  });

  await step('three more docks', async () => {
    await dock('UP', 2);
    await dock('DOWN', 3);
    await dock('UP', 4);
  });

  await step('a flip inside 60 s of the freshest cut', async () => {
    const pt = await waitFor('a spot on the rail clear of the tag', `(function () {
      var r = document.querySelector('.dr-rail').getBoundingClientRect();
      for (var x = r.left + r.width * 0.35; x > r.left; x -= 6) {
        var y = r.top + r.height / 2, t = document.elementFromPoint(x, y);
        if (t && !t.closest('.dr-tag') && t.closest('.dr-rail')) return [Math.round(x), Math.round(y)];
      }
      return null;
    })()`, 3000);
    await press(pt[0], pt[1], 70);
    await waitFor('notch.flip', atLeast('notch.flip', 1), 5000);
    await waitFor('idle after the flip', idle, 8000);
    await shots('06-rail-after-flip');
  });

  await step('the print by hand', async () => {
    await tap('the tin tag', '.dr-tag');
    await waitFor('the tag card', find('.dr-act', 'SET PRINT BY HAND'), 8000);
    await shots('07-tag-card');
    await tap('SET PRINT BY HAND', '.dr-act', 'SET PRINT BY HAND');
    const pt = await waitFor('the number entry', find('.dr-input', null), 8000);
    await press(pt[0], pt[1], 60);
    await send('Input.insertText', { text: '55.5' }, S);
    await waitFor('55.5 in the entry', "document.querySelector('.dr-input').value === '55.5'", 3000);
    await shots('08-print-entry');
    await tap('OK', '.dr-act', 'OK');
    await waitFor('print.hand', atLeast('print.hand', 1), 8000);
    // the tag card comes back (it loops) or closes; close whatever is open
    await sleep(400);
    if (await ev('DR.surface.busy()')) {
      const close = await ev(find('.dr-act', 'CLOSE'));
      if (close) await press(close[0], close[1], 60);
    }
    await waitFor('idle after the print', idle, 8000);
    await waitFor('the tin tag to read IN', "DR.app.view().tag.text === 'IN'", 5000);
    await shots('09-print-in-parked');
  });

  await step('the moment: bell, retrace, the print, the call halves', async () => {
    await tap('the dial', '.dr-stage .dr-dial');
    await waitFor('the moment to start', "DR.app.flow() === 'moment'", 5000);
    await waitFor('the see-through call halves', find('.dr-h', 'UP'), 60000);
    await shots('10-moment-call-halves');
  });

  await step('the call and the why', async () => {
    await tap('UP for the next print', '.dr-h', 'UP', { ms: 3000 });
    await waitFor('call.made', atLeast('call.made', 1), 30000);
    await waitFor('the why kept on the call', `DR.store.all().then(function (l) { return l.some(function (e) { return e.type === 'breath.kept' && e.data.of === 'call'; }); })`, 5000);
  });

  await step('the move', async () => {
    await waitFor('POSITION, MONEY, HELP', find('.dr-band', 'MONEY'), 30000);
    await shots('11-move-bands');
    await tap('MONEY', '.dr-band', 'MONEY', { ms: 3000 });
    await waitFor('call.move', atLeast('call.move', 1), 5000);
    await waitFor('round.closed', atLeast('round.closed', 1), 8000);
    await waitFor('field.cut', atLeast('field.cut', 1), 8000);
  });

  await step('the turn: TAKE IT', async () => {
    await waitFor('the turn bands', find('.dr-band', 'TAKE IT'), 20000);
    await shots('12-turn-bands');
    await tap('TAKE IT', '.dr-band', 'TAKE IT');
    await waitFor('the next round opened', atLeast('round.opened', 2), 8000);
    await waitFor('idle after the turn', idle, 15000);
    await shots('13-after-turn-parked');
  });

  await step('the tack card and the counter view', async () => {
    await tap('the tack', '.dr-tk', null, { ms: 5000 });
    await waitFor('the tack card', `document.querySelector('.dr-card') !== null && DR.surface.busy()`, 5000);
    await shots('14-tack-card');
    await tap('CLOSE', '.dr-act', 'CLOSE');
    await waitFor('idle', idle, 5000);
    await tap('SHOW', '.dr-show', 'SHOW');
    await waitFor('the counter view', "document.querySelector('.dr-counter') !== null", 5000);
    await shots('15-counter');
    const pt = await ev(`(function () { var r = document.querySelector('.dr-counter').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height * 0.9)]; })()`);
    await press(pt[0], pt[1], 60);
    await waitFor('idle after the counter', idle, 5000);
  });

  await step('nothing can slide the instrument sideways', async () => {
    const got = await ev(`(function () {
      var out = {};
      ['.dr', '.dr-box', '.dr-fieldw'].forEach(function (s) {
        var e = document.querySelector(s);
        e.scrollLeft = 25; e.scrollTop = 25;
        out[s] = [e.scrollLeft, e.scrollTop];
      });
      document.querySelector('.dr-lever').scrollIntoView({ inline: 'end', block: 'end' });
      var b = document.querySelector('.dr-box');
      out.after = [b.scrollLeft, b.scrollTop, window.scrollX, window.scrollY];
      return out;
    })()`);
    for (const k of Object.keys(got)) if (got[k].some((n) => n !== 0)) throw new Error('it scrolled: ' + JSON.stringify(got));
  });

  await step('back to ROLLING', async () => {
    await tap('the lever', '.dr-lever');
    await waitFor('ROLLING', `DR.app.mode() === 'ROLLING' && ${idle}`, 5000);
    await rollingWords('after');
    await shots('16-rolling-after');
  });

  await step('everything is home', async () => {
    const c = await waitFor('a clean sync', `DR.store.sync().then(function () { var k = DR.store.counts(); return k.unsent === 0 && k.refused === 0 && k.breathsNotHome === 0 ? k : null; })`, 20000);
    report.counts = { unsent: c.unsent, refused: c.refused, breathsNotHome: c.breathsNotHome, registryMismatch: c.registryMismatch };
    const home = await ev(`(function () { var h = DR.store.home() || {}, b = h.breaths || {}; return { breaths: Object.keys(b).length, have: Object.keys(b).filter(function (k) { return b[k].have; }).length }; })()`);
    report.homeBreaths = home;
    const evs = await ev(`DR.store.all().then(function (l) { return l.map(function (e) { return e.type; }); })`);
    report.order = evs;
    for (const t of evs) report.events[t] = (report.events[t] || 0) + 1;
    const nb = report.events['breath.kept'] || 0;
    if (nb < 2) throw new Error(`only ${nb} breaths kept`);
    if (home.have < nb) throw new Error(`home holds ${home.have} of ${nb} breaths`);
    const want = ['round.opened', 'notch.cut', 'breath.kept', 'notch.flip', 'print.hand', 'call.made', 'call.move', 'round.closed', 'field.cut'];
    for (const t of want) if (!report.events[t]) throw new Error('no ' + t + ' in the book');
  });
});
