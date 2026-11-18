/* DOCK READ sound: everything that makes or takes sound (SPEC 0.7, 0.12, 9.4, 9.8, 9.11).
   Rule 0.7: nothing sounds, speaks or buzzes until unlock() has been called from his tap in this visit
   (a hidden page ends the visit), and nothing sounds while muted.
   Rule 0.12: the phone's own voice is used only with a voice whose localService is true; with none,
   nothing is said.
   askMic() is the only function here that may trigger the microphone prompt. record() returns null
   unless the microphone is already granted.
   Every tunable number is a named constant just below. None of them has been tried on his phone or in
   his truck (SPEC 13). */
(function () {
  'use strict';

  /* ---------- tunables ---------- */
  var VOICE_WAIT_MS = 2500;        // a home clip must answer inside this to be played (9.8 step 2)
  var CACHE_WAIT_MS = 400;         // with no line: how long the cache lookup alone may take (9.8 step 1)
  var SPEECH_BASE_MS = 1000;       // the phone's voice: give up after BASE + WORD x words (9.8)
  var SPEECH_WORD_MS = 400;
  var SPEECH_RATE = 0.96;          // the mockup's rate
  var MIC_SKIP_MS = 300;           // voice gate: ignore the first 300 ms (9.4)
  var MIC_FLOOR_MS = 300;          // then take the noise floor over the next 300 ms
  var MIC_GATE_MIN = 0.03;         // the gate is max(MIC_GATE_MIN, MIC_GATE_X x floor), RMS of -1..1 samples
  var MIC_GATE_X = 2.2;
  var MIC_START_MS = 250;          // speech starts when the level stays above the gate this long
  var MIC_END_MS = 1400;           // speech ends after this long back under the gate
  var MIC_OPEN_MS = 6000;          // default: from the moment the stream is live, he has this long to start
  var MIC_MAX_MS = 20000;          // default: speech is cut at this length
  var REC_LIMIT_MS = 29500;        // no take runs past this from the recorder's start, whatever the caller asks;
                                   // home refuses a breath over 30 s (SPEC 15.7)
  var REC_STOP_WAIT_MS = 2000;     // a recorder that never reports its stop is given up on after this
  var CLIP_END_SLACK_MS = 500;     // a clip whose end is never reported resolves at its length + this
  var CLIP_UNKNOWN_MS = 60000;     // and one with no length at all, after this
  var MIC_TICK_MS = 50;            // how often the level is read
  var MIC_FFT = 2048;              // analyser size
  var MIC_BITRATE = 24000;         // recorder bits per second
  var MIC_PICK = 'Speakerphone';   // an input whose label holds this is asked for with {ideal: id}
  var MIME_OPUS = 'audio/webm;codecs=opus';
  var MIME_MP4 = 'audio/mp4';
  var LEVEL_SPAN = 2;              // onLevel(x): x = level / (gate x LEVEL_SPAN), 0..1; 0.5 = at the gate

  var G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var DR = G.DR || (G.DR = {});

  var AC = null;                   // the one AudioContext, made inside his tap
  var unlocked = false;            // unlock() called in this visit
  var isMuted = false;
  var sources = new Set();         // every sounding node, so hush can stop them
  var waiters = new Set();         // resolvers of say()/play() still running; hush resolves them
  var gen = 0;                     // bumped by hush: anything started before it does not sound
  var micOk = false;               // askMic() granted in this page (for browsers with no permission query)
  var rec = null;                  // the recording in progress: {end(keep)}
  var voices = [];

  function hidden() { var d = G.document; return !!(d && (d.hidden || d.visibilityState === 'hidden')); }
  function nav() { return G.navigator || null; }
  function now() { return Date.now(); }
  function store() { return G.DR && G.DR.store ? G.DR.store : null; }
  function canSound() { return unlocked && !isMuted && !hidden(); }

  function ctx() {
    if (AC) return AC;
    var C = G.AudioContext || G.webkitAudioContext;
    if (!C) return null;
    try { AC = new C(); } catch (e) { AC = null; }
    return AC;
  }

  function resume(a) {
    try { if (a && a.state === 'suspended' && a.resume) { var p = a.resume(); if (p && p.catch) p.catch(function () {}); } } catch (e) { /* nothing */ }
  }

  // Context for making sound: only after unlock, never when muted or hidden.
  function ac() {
    if (!canSound()) return null;
    var a = ctx();
    resume(a);
    return a;
  }

  function track(node) {
    sources.add(node);
    var prev = node.onended;
    node.onended = function () { sources.delete(node); if (typeof prev === 'function') prev.apply(this, arguments); };
    return node;
  }

  function waiter(resolve) {
    var w = function () { if (waiters.has(w)) { waiters.delete(w); resolve(); } };
    waiters.add(w);
    return w;
  }

  /* ---------- the mockup's recipes ---------- */

  function tone(f, d, ty, g, f2) {
    var a = ac(); if (!a) return;
    try {
      var o = a.createOscillator(), v = a.createGain(), t = a.currentTime;
      o.type = ty;
      o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      v.gain.setValueAtTime(g, t);
      v.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(v); v.connect(a.destination);
      track(o);
      o.start(t); o.stop(t + d + 0.03);
    } catch (e) { /* no sound is fine */ }
  }

  function noise(d, fr, g, ty) {
    var a = ac(); if (!a) return;
    try {
      var n = Math.max(1, a.sampleRate * d | 0), b = a.createBuffer(1, n, a.sampleRate), ch = b.getChannelData(0);
      for (var i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / n);
      var s = a.createBufferSource(), fl = a.createBiquadFilter(), v = a.createGain();
      s.buffer = b; fl.type = ty; fl.frequency.value = fr; v.gain.value = g;
      s.connect(fl); fl.connect(v); v.connect(a.destination);
      track(s);
      s.start();
    } catch (e) { /* no sound is fine */ }
  }

  function tick() { noise(0.05, 2600, 0.4, 'highpass'); tone(1900, 0.04, 'square', 0.05, 800); }
  function bell() { tone(196, 0.7, 'sine', 0.24); tone(392, 0.7, 'sine', 0.15); }
  function click() { tone(1800, 0.06, 'triangle', 0.2, 900); }
  function knock() { tone(150, 0.13, 'sine', 0.45, 70); noise(0.03, 1400, 0.22, 'highpass'); }
  function breath() { noise(0.5, 700, 0.16, 'bandpass'); }
  function swish() { noise(0.6, 1800, 0.14, 'bandpass'); }

  function buzz(pattern) {
    if (!canSound()) return;
    try { var n = nav(); if (n && typeof n.vibrate === 'function') n.vibrate(pattern); } catch (e) { /* nothing */ }
  }

  /* ---------- unlock, mute, hush ---------- */

  function unlock() {
    unlocked = true;
    var a = ctx();
    resume(a);
    loadVoices();
  }

  function hush() {
    gen++;
    sources.forEach(function (s) { try { s.stop(); } catch (e) { /* already stopped */ } });
    sources.clear();
    try { if (G.speechSynthesis) G.speechSynthesis.cancel(); } catch (e) { /* nothing */ }
    var ws = Array.from(waiters);
    ws.forEach(function (w) { w(); });
  }

  function mute(on) {
    isMuted = !!on;
    if (isMuted) hush();
  }

  function muted() { return isMuted; }

  /* ---------- the voice ---------- */

  function loadVoices() {
    try {
      var ss = G.speechSynthesis;
      if (ss && typeof ss.getVoices === 'function') { var v = ss.getVoices(); if (v && v.length) voices = Array.from(v); }
    } catch (e) { /* nothing */ }
  }

  // A voice on this phone only (rule 0.12). English first, then any local voice.
  function localVoice() {
    loadVoices();
    var local = voices.filter(function (v) { return v && v.localService === true; });
    function lang(v) { return String(v.lang || '').toLowerCase().replace('_', '-'); }
    return local.filter(function (v) { return lang(v) === 'en-us'; })[0]
      || local.filter(function (v) { return lang(v).indexOf('en') === 0; })[0]
      || local[0] || null;
  }

  function timeout(p, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = G.setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      Promise.resolve(p).then(function (v) {
        if (!done) { done = true; G.clearTimeout(t); resolve(v || null); }
      }, function () {
        if (!done) { done = true; G.clearTimeout(t); resolve(null); }
      });
    });
  }

  // Steps 1 and 2 of 9.8: a cached clip, else (line home) home's clip inside VOICE_WAIT_MS. A later
  // answer is the store's to cache; it is never played.
  function clipFor(text) {
    var s = store();
    if (!s || typeof s.voiceClip !== 'function') return Promise.resolve(null);
    var line = 'none';
    try { line = typeof s.line === 'function' ? s.line() : 'none'; } catch (e) { line = 'none'; }
    var home = line === 'home';
    var p;
    try { p = s.voiceClip(text, home ? VOICE_WAIT_MS : 0); } catch (e) { p = null; }
    return timeout(p, home ? VOICE_WAIT_MS : CACHE_WAIT_MS);
  }

  function decode(a, buf) {
    return new Promise(function (resolve, reject) {
      try {
        var copy = buf.slice ? buf.slice(0) : buf;
        var r = a.decodeAudioData(copy, resolve, reject);
        if (r && typeof r.then === 'function') r.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  // Plays a decoded buffer through the context; resolves on its end, on hush, after maxMs, or at its
  // length + CLIP_END_SLACK_MS if the end is never reported.
  function playBuffer(a, audio, maxMs, myGen) {
    return new Promise(function (resolve) {
      if (myGen !== gen || !canSound()) { resolve(); return; }
      var cap = null;
      var w = waiter(function () { if (cap !== null) G.clearTimeout(cap); resolve(); });
      try {
        var s = a.createBufferSource();
        s.buffer = audio;
        s.connect(a.destination);
        track(s);
        var prev = s.onended;
        s.onended = function () { if (typeof prev === 'function') prev.apply(this, arguments); w(); };
        s.start();
        // Some phones never fire onended (a route change, a suspended context), and a flow waits on it.
        var d = audio && typeof audio.duration === 'number' && isFinite(audio.duration) && audio.duration >= 0
          ? audio.duration * 1000 + CLIP_END_SLACK_MS : CLIP_UNKNOWN_MS;
        var lim = maxMs > 0 ? Math.min(maxMs, d) : d;
        cap = G.setTimeout(function () { try { s.stop(); } catch (e) { /* nothing */ } w(); }, lim);
      } catch (e) { w(); }
    });
  }

  function speak(text, myGen) {
    return new Promise(function (resolve) {
      var ss = G.speechSynthesis, U = G.SpeechSynthesisUtterance;
      var v = localVoice();
      if (!ss || !U || !v || myGen !== gen || !canSound()) { resolve(); return; }
      var cap = null;
      var w = waiter(function () { if (cap !== null) G.clearTimeout(cap); resolve(); });
      try {
        var u = new U(text);
        u.voice = v;
        if (v.lang) u.lang = v.lang;
        u.rate = SPEECH_RATE;
        u.onend = function () { w(); };
        u.onerror = function () { w(); };
        var words = String(text).trim().split(/\s+/).filter(Boolean).length;
        cap = G.setTimeout(function () { w(); }, SPEECH_BASE_MS + SPEECH_WORD_MS * words);
        ss.cancel();
        ss.speak(u);
      } catch (e) { w(); }
    });
  }

  function say(text) {
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!text || !canSound()) return Promise.resolve();
    var myGen = gen;
    return new Promise(function (resolve) {
      var w = waiter(resolve);   // hush resolves it at once, even while the clip is still being looked for
      clipFor(text).then(function (buf) {
        if (myGen !== gen || !canSound()) return;
        var a = ac();
        if (buf && a) {
          return decode(a, buf).then(function (audio) {
            return playBuffer(a, audio, 0, myGen);
          }, function () {
            return speak(text, myGen);
          });
        }
        return speak(text, myGen);
      }).catch(function () { /* say never throws */ }).then(w);
    });
  }

  function warm(texts) {
    var s = store();
    if (!s || typeof s.voiceClip !== 'function') return;
    var line = 'none';
    try { line = typeof s.line === 'function' ? s.line() : 'none'; } catch (e) { return; }
    if (line !== 'home') return;
    (Array.isArray(texts) ? texts : [texts]).forEach(function (t) {
      t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
      if (!t) return;
      try {
        var p = s.voiceClip(t, VOICE_WAIT_MS);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* quietly */ }
    });
  }

  // His own breath, through the same context.
  function play(blob, opts) {
    var maxMs = opts && typeof opts.maxMs === 'number' && opts.maxMs > 0 ? opts.maxMs : 0;
    if (!blob || !canSound()) return Promise.resolve();
    var a = ac();
    if (!a) return Promise.resolve();
    var myGen = gen;
    return new Promise(function (resolve) {
      var w = waiter(resolve);
      Promise.resolve()
        .then(function () { return blob.arrayBuffer(); })
        .then(function (buf) { if (myGen !== gen) return null; return decode(a, buf); })
        .then(function (audio) { if (audio && myGen === gen) return playBuffer(a, audio, maxMs, myGen); })
        .catch(function () { /* a clip that will not play is silence */ })
        .then(w);
    });
  }

  /* ---------- the microphone ---------- */

  function micState() {
    var n = nav();
    if (!n || !n.permissions || typeof n.permissions.query !== 'function') return Promise.resolve(micOk ? 'granted' : 'unknown');
    return Promise.resolve()
      .then(function () { return n.permissions.query({ name: 'microphone' }); })
      .then(function (s) {
        var v = s && s.state;
        return v === 'granted' || v === 'prompt' || v === 'denied' ? v : (micOk ? 'granted' : 'unknown');
      })
      .catch(function () { return micOk ? 'granted' : 'unknown'; });
  }

  function baseAudio() { return { channelCount: 1, echoCancellation: false, noiseSuppression: false }; }

  function stopStream(stream) {
    try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* nothing */ } }); } catch (e) { /* nothing */ }
  }

  // The only function that may trigger the prompt. The stream it opens is closed at once.
  function askMic() {
    var n = nav(), md = n && n.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') return Promise.resolve('denied');
    return Promise.resolve()
      .then(function () { return md.getUserMedia({ audio: baseAudio() }); })
      .then(function (stream) { stopStream(stream); micOk = true; return 'granted'; })
      .catch(function () {
        return micState().then(function (s) { return s === 'granted' ? 'granted' : 'denied'; });
      });
  }

  function constraintError(e) {
    var name = e && e.name;
    return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError';
  }

  // Opens the stream: the Speakerphone input if one is labelled so, else the default; on a constraint
  // error, once more with the default.
  function openStream(md) {
    var pick = Promise.resolve(null);
    if (typeof md.enumerateDevices === 'function') {
      pick = Promise.resolve()
        .then(function () { return md.enumerateDevices(); })
        .then(function (list) {
          var hit = (list || []).filter(function (d) {
            return d && d.kind === 'audioinput' && typeof d.label === 'string' && d.label.indexOf(MIC_PICK) >= 0 && d.deviceId;
          })[0];
          return hit ? hit.deviceId : null;
        })
        .catch(function () { return null; });
    }
    return pick.then(function (id) {
      var first = baseAudio();
      if (id) first.deviceId = { ideal: id };
      return md.getUserMedia({ audio: first }).catch(function (e) {
        if (!constraintError(e)) throw e;
        return md.getUserMedia({ audio: baseAudio() });
      });
    });
  }

  function recMime() {
    var R = G.MediaRecorder;
    try { if (R && typeof R.isTypeSupported === 'function' && R.isTypeSupported(MIME_OPUS)) return MIME_OPUS; } catch (e) { /* nothing */ }
    return MIME_MP4;
  }

  function cancelRecord() {
    if (rec) rec.end(false);
  }

  // One breath. Resolves {blob, mime, ms} when he spoke, else null. Never throws.
  // opts.raw: no voice gate; the take simply runs maxMs (MIC CHECK, SPEC 15.6), so his voice at the
  // first instant or a loud idle cab cannot leave it empty.
  function record(opts) {
    opts = opts || {};
    var raw = opts.raw === true;
    var openMs = typeof opts.openMs === 'number' && opts.openMs > 0 ? opts.openMs : MIC_OPEN_MS;
    var maxMs = typeof opts.maxMs === 'number' && opts.maxMs > 0 ? opts.maxMs : MIC_MAX_MS;
    var onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null;
    cancelRecord();
    var n = nav(), md = n && n.mediaDevices, R = G.MediaRecorder;
    if (!md || typeof md.getUserMedia !== 'function' || !R || hidden()) return Promise.resolve(null);

    var my = { end: function () {} };
    rec = my;
    var cancelled = false;
    my.end = function () { cancelled = true; };

    return micState().then(function (s) {
      if (s !== 'granted' || cancelled || hidden()) return null;
      return openStream(md).then(function (stream) {
        if (cancelled || hidden()) { stopStream(stream); return null; }
        return gate(stream, my, openMs, maxMs, onLevel, raw);
      });
    }).catch(function () { return null; }).then(function (r) {
      if (rec === my) rec = null;
      return r || null;
    });
  }

  function gate(stream, my, openMs, maxMs, onLevel, raw) {
    return new Promise(function (resolve) {
      var a = ctx();
      var R = G.MediaRecorder;
      var mime = recMime();
      var recorder = null, src = null, an = null, timer = null, finished = false;
      var chunks = [];
      var t0 = now(), recAt = null;
      var floorSum = 0, floorN = 0, gateLv = null;
      var aboveSince = null, belowSince = null, speechAt = null;
      var buf = null;
      var done = false, stopAt = null;

      function finish(v) {
        if (done) return;
        done = true;
        resolve(v);
      }

      function take() {
        var type = (recorder && recorder.mimeType) || mime;
        var blob = null;
        try { blob = chunks.length ? new Blob(chunks, { type: type }) : null; } catch (e) { blob = null; }
        return blob && blob.size > 0 ? { blob: blob, mime: type, ms: Math.round(recAt === null ? 0 : stopAt - recAt) } : null;
      }

      function close(keep) {
        if (finished) return;
        finished = true;
        if (timer !== null) G.clearInterval(timer);
        timer = null;
        stopAt = now();
        try { if (src) src.disconnect(); } catch (e) { /* nothing */ }
        if (onLevel) { try { onLevel(0); } catch (e) { /* nothing */ } }
        if (!keep || !recorder || recorder.state === 'inactive') {
          if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* nothing */ } }
          stopStream(stream);
          finish(null);
          return;
        }
        recorder.onstop = function () { finish(take()); };
        // A recorder that never reports its stop must not hold the flow: keep what it gathered.
        G.setTimeout(function () {
          if (done) return;
          recorder.ondataavailable = null; recorder.onstop = null;
          finish(take());
        }, REC_STOP_WAIT_MS);
        try { recorder.stop(); } catch (e) { finish(null); }
        stopStream(stream);   // the stream is stopped the moment the breath ends
      }
      my.end = function (keep) { close(!!keep); };

      try {
        recorder = new R(stream, { mimeType: mime, audioBitsPerSecond: MIC_BITRATE });
        recorder.ondataavailable = function (e) { if (e && e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.start();
        recAt = now();
      } catch (e) { close(false); return; }
      try {
        if (!a) throw new Error('no context');
        resume(a);
        src = a.createMediaStreamSource(stream);
        an = a.createAnalyser();
        an.fftSize = MIC_FFT;
        src.connect(an);   // never to the speakers
        buf = new Float32Array(an.fftSize);
      } catch (e) {
        // the gate cannot run without a level; a raw take does not need one
        an = null;
        if (!raw) { close(false); return; }
      }

      function level() {
        an.getFloatTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
      }

      timer = G.setInterval(function () {
        if (finished) return;
        if (hidden()) { close(false); return; }
        var t = now() - t0, lv;
        if (raw) {
          if (an && onLevel) { try { onLevel(Math.min(1, level() / (MIC_GATE_MIN * LEVEL_SPAN))); } catch (e) { /* nothing */ } }
          if (now() - recAt >= Math.min(maxMs, REC_LIMIT_MS)) close(true);
          return;
        }
        if (now() - recAt >= REC_LIMIT_MS) { close(speechAt !== null); return; }
        try { lv = level(); } catch (e) { close(false); return; }
        if (t < MIC_SKIP_MS) return;
        if (t < MIC_SKIP_MS + MIC_FLOOR_MS) { floorSum += lv; floorN++; return; }
        if (gateLv === null) gateLv = Math.max(MIC_GATE_MIN, MIC_GATE_X * (floorN ? floorSum / floorN : 0));
        if (onLevel) { try { onLevel(Math.min(1, lv / (gateLv * LEVEL_SPAN))); } catch (e) { /* nothing */ } }
        var above = lv > gateLv;
        if (speechAt === null) {
          if (above) {
            if (aboveSince === null) aboveSince = t;
            if (t - aboveSince >= MIC_START_MS) { speechAt = aboveSince; belowSince = null; }
          } else {
            aboveSince = null;
          }
          if (speechAt === null && t >= openMs) { close(false); return; }
        }
        if (speechAt !== null) {
          if (above) belowSince = null;
          else if (belowSince === null) belowSince = t;
          if (belowSince !== null && t - belowSince >= MIC_END_MS) { close(true); return; }
          if (t - speechAt >= maxMs) { close(true); return; }
        }
      }, MIC_TICK_MS);
    });
  }

  /* ---------- a hidden page: everything stops, and the visit ends ---------- */

  try {
    var d = G.document;
    if (d && typeof d.addEventListener === 'function') {
      d.addEventListener('visibilitychange', function () {
        if (hidden()) { unlocked = false; hush(); cancelRecord(); }
      });
    }
    if (G.speechSynthesis && typeof G.speechSynthesis.addEventListener === 'function') {
      G.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    }
  } catch (e) { /* nothing */ }

  DR.sound = {
    unlock: unlock,
    tick: tick, bell: bell, click: click, knock: knock, breath: breath, swish: swish, buzz: buzz,
    say: say, warm: warm,
    hush: hush, mute: mute, muted: muted,
    askMic: askMic, record: record, cancelRecord: cancelRecord, play: play, micState: micState
  };
})();
