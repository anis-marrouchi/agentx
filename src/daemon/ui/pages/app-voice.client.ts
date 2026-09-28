// --- Phone app: voice-first Chat (the orb bar) ---
//
// Inlined into /app after the Chat scripts, with APP_ORB_SCRIPT and
// APP_VOICE_AUDIO_SCRIPT ahead of it. Press and hold the orb to talk, let go
// to send, slide off it to cancel. The recording goes to
// POST /api/app/voice/transcribe (app-voice.ts); the words are sent as a
// Chat message through window.AXChat, so Stop, history, polls, buttons and
// coming back to a running answer all work as with typing. When the answer
// is done it is spoken (POST /api/app/voice/speak, or the phone's own voice)
// while the orb pulses; a tap on the orb stops it.
//
// The keyboard button shows the text box; the speaker button turns spoken
// answers off. Both are remembered on this phone.
//
// Answers are said one at a time in the order they finished (#265): the
// one on screen, and those from conversations in the background, which the
// strip (app-chat-strip.client.ts) announces with a "background" event and
// which start with the agent's name. Nothing is said over a recording or
// over another answer. The queue rules are queueSpeech and nextSpeech
// (app-speech-queue.ts); a tap on the orb stops and clears it.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_VOICE_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-chat'), C = window.AXChat, IO = window.AXVoiceIO, O = window.AXOrb;
  if (!panel || !C || !IO || !O) return;
  var cx = panel.querySelector('.cx'), input = document.getElementById('cx-input'), empty = document.getElementById('cx-empty');
  var MAX_MS = 120000, MIN_MS = 350;
  var KEYS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M8 14h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var SPK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path class="vx-waves" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path class="vx-mute" d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var bar = document.createElement('div');
  bar.className = 'vx';
  bar.innerHTML = '<p id="vx-status" class="vx-status" role="status" aria-live="polite"></p><div class="vx-row">' +
    '<button type="button" id="vx-keys" class="vx-side" aria-pressed="false" aria-label="Type a message">' + KEYS + '</button>' +
    '<button type="button" id="vx-orb" class="vx-orb" aria-describedby="vx-status"><canvas aria-hidden="true"></canvas><span class="cx-sr">Hold to talk</span></button>' +
    '<button type="button" id="vx-speaker" class="vx-side" aria-pressed="true" aria-label="Speak answers aloud">' + SPK + '</button></div>';
  cx.appendChild(bar);
  // The text box and Stop move into the bar, above the orb.
  bar.insertBefore(document.getElementById('cx-form'), bar.firstChild);
  var status = document.getElementById('vx-status'), orbBtn = document.getElementById('vx-orb');
  var keysBtn = document.getElementById('vx-keys'), spkBtn = document.getElementById('vx-speaker');
  var orb = O.create(orbBtn.querySelector('canvas'));
  empty.textContent = 'Pick an agent, then hold the orb and speak. Let go to send. Its answer appears here, and is read out when it is done.';

  function recall(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch (e) { return d; } }
  function remember(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch (e) {} }
  var v = { state: 'idle', rec: null, pressed: false, cancel: false, t0: 0, timer: 0, speakOn: recall('ax-voice-speaker', true), typing: recall('ax-voice-typing', false), said: 0 };
  // Answers waiting to be said, oldest first.
  var speech = [], SPEECH_MAX = 5;

  var TEXT = {
    idle: 'Hold to talk', arming: 'Opening the microphone…', listening: 'Listening… let go to send, slide away to cancel',
    cancel: 'Let go to cancel', sending: 'Writing down what you said…', thinking: 'Thinking…', speaking: 'Speaking. Tap the orb to stop.',
  };
  var PHASE = { idle: 'idle', arming: 'listening', listening: 'listening', cancel: 'listening', sending: 'thinking', thinking: 'thinking', speaking: 'speaking' };
  // Every state change goes through here; tests and screenshots drive it too.
  function show(state, msg, bad, meter) {
    v.state = state;
    orb.show(PHASE[state] || 'idle', meter);
    bar.setAttribute('data-state', state);
    status.textContent = msg || (state === 'idle' && !C.target() ? 'Choose an agent, then hold to talk' : TEXT[state] || '');
    status.classList.toggle('vx-bad', !!bad);
    orbBtn.querySelector('.cx-sr').textContent = state === 'speaking' ? 'Stop speaking' : 'Hold to talk';
  }
  function idle(msg, bad) { show(C.busy() ? 'thinking' : 'idle', msg, bad); setTimeout(pump, 0); }
  function tint() { var t = C.target(); orb.tint(O.colorFor(t && t.agent, t && t.color)); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  // --- Typing and the speaker ---
  function setTyping(on, focus) {
    v.typing = on; remember('ax-voice-typing', on);
    cx.classList.toggle('cx-typing-on', on);
    keysBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    keysBtn.setAttribute('aria-label', on ? 'Hide the keyboard' : 'Type a message');
    if (on && focus) input.focus();
  }
  function setSpeaker(on) {
    v.speakOn = on; remember('ax-voice-speaker', on);
    spkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    spkBtn.setAttribute('aria-label', on ? 'Answers are read aloud. Tap to turn off.' : 'Answers are not read aloud. Tap to turn on.');
    spkBtn.classList.toggle('vx-off', !on);
    if (!on) { speech = []; if (v.state === 'speaking') stopSpeaking(); }
  }
  keysBtn.addEventListener('click', function () { setTyping(!v.typing, true); });
  spkBtn.addEventListener('click', function () { IO.unlock(); setSpeaker(!v.speakOn); });

  // --- Hold to talk ---
  function press() {
    IO.unlock();
    if (v.state === 'speaking') { stopSpeaking(); return; }
    if (v.state === 'arming' || v.state === 'listening' || v.state === 'sending') return;
    if (!C.target()) { C.pick(); show('idle', 'Choose an agent first, then hold the orb to talk.'); return; }
    if (!IO.canRecord()) { show('idle', 'This browser can’t record here. Tap the keyboard to type.', true); return; }
    v.pressed = true; v.cancel = false;
    show('arming');
    IO.record().then(function (rec) {
      if (!v.pressed) { rec.stop(false); idle('Hold the orb while you speak, then let go.'); return; }
      v.rec = rec; v.t0 = Date.now();
      buzz(12);
      show('listening', null, false, rec.level);
      v.timer = setTimeout(function () { release(true); }, MAX_MS);
    }).catch(function (e) {
      v.pressed = false;
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      idle(denied ? 'The microphone is blocked. Allow it for this app in the phone’s settings, or tap the keyboard to type.'
        : 'Could not open the microphone. Tap the keyboard to type.', true);
    });
  }
  function release(auto) {
    v.pressed = false;
    clearTimeout(v.timer);
    var rec = v.rec; v.rec = null;
    if (!rec) return;
    var keep = !v.cancel && (auto || Date.now() - v.t0 >= MIN_MS);
    rec.stop(keep).then(function (take) {
      if (!take) { buzz(8); idle(v.cancel ? 'Cancelled.' : 'Hold the orb while you speak, then let go.'); return; }
      buzz([10, 40, 10]);
      transcribe(take);
    });
  }
  function transcribe(take) {
    show('sending');
    fetch('/api/app/voice/transcribe', {
      method: 'POST', credentials: 'same-origin', body: take.blob,
      headers: { 'Content-Type': take.blob.type || 'audio/webm', 'X-Audio-Duration-Ms': String(take.ms) },
    }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (x) {
      if (!x) return;
      if (x.ok && x.j.text) { C.send(x.j.text, { spoken: true }); idle(); return; }
      if (x.status === 503 && x.j.hint) { idle(x.j.error + ' ' + x.j.hint + ' You can type instead.', true); setTyping(true, false); return; }
      idle(x.j.error || ('Speech to text failed (HTTP ' + x.status + ').'), true);
    }).catch(function () { idle('Could not reach AgentX. Check the connection and try again.', true); });
  }
  function inside(ev) {
    var r = orbBtn.getBoundingClientRect(), slack = 48;
    return ev.clientX > r.left - slack && ev.clientX < r.right + slack && ev.clientY > r.top - slack && ev.clientY < r.bottom + slack;
  }
  orbBtn.addEventListener('pointerdown', function (ev) {
    if (ev.button > 0) return;
    ev.preventDefault();
    try { orbBtn.setPointerCapture(ev.pointerId); } catch (e) {}
    press();
  });
  orbBtn.addEventListener('pointermove', function (ev) {
    if (v.state !== 'listening' && v.state !== 'cancel') return;
    var off = !inside(ev);
    if (off !== v.cancel) { v.cancel = off; buzz(6); show(off ? 'cancel' : 'listening', null, false, v.rec && v.rec.level); }
  });
  orbBtn.addEventListener('pointerup', function () { if (v.pressed || v.rec) release(false); });
  orbBtn.addEventListener('pointercancel', function () { v.cancel = true; if (v.pressed || v.rec) release(false); });
  orbBtn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  // Keyboard: hold Space or Enter to talk, Escape cancels.
  orbBtn.addEventListener('keydown', function (ev) {
    if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); press(); }
    else if (ev.key === 'Escape' && v.rec) { v.cancel = true; release(false); }
  });
  orbBtn.addEventListener('keyup', function (ev) { if ((ev.key === ' ' || ev.key === 'Enter') && (v.pressed || v.rec)) release(false); });
  orbBtn.addEventListener('click', function (ev) { ev.preventDefault(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && v.rec) { v.cancel = true; release(false); } });

  // --- Speaking answers, one at a time ---
  function stopSpeaking() { IO.stop(); speech = []; v.said++; idle(); }
  function enqueue(item) {
    if (!v.speakOn) return;
    var r = queueSpeech(speech, item, SPEECH_MAX);
    speech = r.queue;
    if (r.dropped.length) {
      var who = r.dropped.map(function (x) { return x.announce || 'this conversation'; }).join(', ');
      status.textContent = (v.state === 'speaking' ? TEXT.speaking + ' ' : '') + 'Too many answers waiting: skipped the oldest (' + who + ').';
    }
    pump();
  }
  function pump() {
    if (!v.speakOn) { speech = []; return; }
    var r = nextSpeech(speech, v.state !== 'idle' && v.state !== 'thinking');
    speech = r.queue;
    if (r.item) speak(r.item);
  }
  function speak(item) {
    var mine = ++v.said;
    var live = function () { return v.state === 'speaking' && mine === v.said; };
    show('speaking', null, false, null);
    var began = function (meter) { if (live()) show('speaking', null, false, meter); };
    var done = function () { if (live()) idle(); };
    var fallback = function (t) { return IO.speakText(t, began).catch(function () {}); };
    fetch('/api/app/voice/speak', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: item.conversationId, text: item.text, announce: !!item.announce }),
    }).then(function (r) {
      if (!live()) return null;
      if (r.ok && (r.headers.get('content-type') || '').indexOf('audio/') === 0) {
        return r.arrayBuffer().then(function (buf) { return live() ? IO.playAudio(buf, began) : null; });
      }
      return r.json().catch(function () { return {}; }).then(function (j) { return j.text && live() ? fallback(j.text) : null; });
    }).catch(function () {}).then(done);
  }
  // A background answer: read the saved text without marking it read.
  function background(d) {
    if (!v.speakOn || !d.conversationId) return;
    fetch('/api/app/conversations/' + encodeURIComponent(d.conversationId) + '?peek=1', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
        var last = c && (c.messages || []).filter(function (m) { return m.role === 'assistant'; }).pop();
        if (!last || last.status !== 'done' || !last.content) return;
        enqueue({ key: d.conversationId + ':' + last.at, conversationId: d.conversationId, text: last.content.slice(0, 8000), announce: d.agentName || c.agentName || c.agent });
      }).catch(function () {});
  }

  document.addEventListener('ax-chat', function (ev) {
    var d = ev.detail || {};
    if (d.type === 'target') { tint(); if (v.state === 'idle') idle(); }
    else if (d.type === 'busy') {
      if (d.on && (v.state === 'idle' || v.state === 'sending')) show('thinking');
      else if (!d.on && v.state === 'thinking') idle();
    } else if (d.type === 'final') {
      // Answers to what this phone just sent, spoken or typed; not one it
      // came back to later.
      if (d.own && d.ok && d.content && d.conversationId) enqueue({ key: d.conversationId + ':f' + Date.now(), conversationId: d.conversationId, text: d.content.slice(0, 8000) });
    } else if (d.type === 'background') background(d);
  });
  // Any tap in Chat unlocks audio, so a typed message's answer can play too.
  panel.addEventListener('pointerdown', function () { IO.unlock(); });

  setTyping(v.typing, false);
  setSpeaker(v.speakOn);
  tint();
  idle();
  window.AXVoice = { show: show, orb: orb, state: function () { return v.state; }, queued: function () { return speech.length; } };
})();
`
