// --- Phone app: Share camera (#325) ---
//
// The camera button in the app's header opens a sheet: pick the machine, or
// the agent, to show the camera to, tap Start. The owner taps every time;
// nothing opens the camera by itself. While it is live a red bar with a
// Stop button stays on screen, and the share stops when the owner taps
// Stop, when the viewer hangs up, when the app goes to the background, or
// after the time limit.
//
// Signalling goes through /api/app/camera/* (app-camera.ts) to the daemon's
// WebRTC broker and on to the chosen machine, which notifies its owner with a
// /call?watch=1 link. The viewer's page sends the offer and this phone only
// answers, so the share waits as long as the owner takes to open the link.
// The share is video only: the microphone is never part of it.
//
// With an agent as the destination (phase 2) the daemon's bot is the viewer.
// It keeps only the newest frame; Look now hands one to the agent with an
// optional question, and its answer shows on the sheet. Answers to frames
// the agent got by itself (frameIntervalSeconds) are picked up by a poll.
//
// Voice first (#687): with an agent watching, Talk is the way to ask. Hold
// it and let go to send, or tap once to start and again to send. Only then
// is the microphone opened, through window.AXVoiceIO, and it is released
// after every question; the words go to /api/app/voice/transcribe and on to
// Look now, so one question hands the agent one frame. Type instead shows
// the text box (remembered on this phone, and the only way when the phone
// cannot record or camera.voiceInput is off). Answers are said aloud through
// /api/app/camera/speak, one at a time, unless muted with Answers aloud.
// Keep watching hands the agent a frame every few seconds for a short
// while (camera.bot.streamMaxSeconds), with a countdown in the red bar,
// for a task that needs a stream; it stops by itself.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export { CAMERA_CSS } from "./app-camera.css"

export const CAMERA_BUTTON = `<button type="button" id="cam-btn" class="icon-btn" aria-label="Share camera" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h12v12H3zM15 10l6-3v10l-6-3"/></svg><span>Share camera</span></button>`

export const CAMERA_BODY = `
<div id="cam" class="cam" role="dialog" aria-modal="true" aria-labelledby="cam-title" hidden>
  <div class="cam-live" id="cam-live" role="status" aria-live="polite" hidden>
    <span class="cam-dot" aria-hidden="true"></span>
    <span id="cam-live-text">Camera live</span>
    <button type="button" id="cam-stop" class="cam-stop">Stop</button>
  </div>
  <video id="cam-video" class="cam-video" playsinline muted autoplay hidden></video>
  <div class="cam-panel">
    <h2 id="cam-title">Share camera</h2>
    <p id="cam-msg" class="cam-msg" role="status">Loading your machines…</p>
    <label class="cam-field" id="cam-pick" hidden>Show it to
      <select id="cam-peer"></select>
    </label>
    <div id="cam-reply" class="cam-reply" role="log" aria-live="polite" hidden></div>
    <button type="button" id="cam-talk" class="cam-talk" aria-describedby="cam-msg" hidden><svg class="cam-mic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg><span id="cam-talk-label">Hold to talk</span></button>
    <label class="cam-field" id="cam-ask" hidden>Ask the agent something (optional)
      <input id="cam-note" type="text" maxlength="300" autocomplete="off" placeholder="What is this cable for?">
    </label>
    <div class="cam-row">
      <button type="button" id="cam-start" class="cam-primary" hidden>Start camera</button>
      <button type="button" id="cam-look" class="cam-primary" hidden>Look now</button>
      <button type="button" id="cam-stream" class="cam-secondary" aria-pressed="false" hidden>Keep watching</button>
      <button type="button" id="cam-type" class="cam-secondary" aria-pressed="false" hidden>Type instead</button>
      <button type="button" id="cam-speaker" class="cam-secondary" aria-pressed="true" hidden>Answers aloud: on</button>
      <button type="button" id="cam-flip" class="cam-secondary" hidden>Flip camera</button>
      <button type="button" id="cam-close" class="cam-secondary">Close</button>
    </div>
  </div>
</div>`

export const CAMERA_SCRIPT = `
(function () {
  var btn = document.getElementById('cam-btn');
  var sheet = document.getElementById('cam');
  if (!btn || !sheet) return;
  var msg = document.getElementById('cam-msg');
  var pick = document.getElementById('cam-pick');
  var peerSel = document.getElementById('cam-peer');
  var startBtn = document.getElementById('cam-start');
  var lookBtn = document.getElementById('cam-look');
  var flipBtn = document.getElementById('cam-flip');
  var closeBtn = document.getElementById('cam-close');
  var live = document.getElementById('cam-live');
  var liveText = document.getElementById('cam-live-text');
  var video = document.getElementById('cam-video');
  var replyBox = document.getElementById('cam-reply');
  var ask = document.getElementById('cam-ask');
  var note = document.getElementById('cam-note');
  var talkBtn = document.getElementById('cam-talk');
  var talkLabel = document.getElementById('cam-talk-label');
  var streamBtn = document.getElementById('cam-stream');
  var typeBtn = document.getElementById('cam-type');
  var speakBtn = document.getElementById('cam-speaker');
  var IO = window.AXVoiceIO || null;
  var cfg = null;
  var s = null; // the live share: { callId, peer, agent, stream, pc, es, facing, until, timer, tick, poll, shown, asking, streamUntil, lastAsk }
  var talk = { rec: null, arming: false, pressed: false, t0: 0, mode: null, timer: null };
  var speaking = Promise.resolve(), speakGen = 0;

  function norm(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function say(text, bad) { msg.textContent = text; msg.className = 'cam-msg' + (bad ? ' bad' : ''); }
  function api(method, path, body, keepalive) {
    return fetch(path, {
      method: method, credentials: 'same-origin', keepalive: !!keepalive,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  // keepalive lets the hangup leave while the page unloads (pagehide).
  function post(body, keepalive) { return api('POST', '/api/app/camera/signal', body, keepalive); }
  function agentOf(value) { return value && value.indexOf('bot:') === 0 ? value.slice(4) : null; }
  // Per-phone choices: the text box instead of Talk, answers said aloud.
  function pref(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }
  function camCfg() { return (cfg && cfg.camera) || {}; }
  function canTalk() { return camCfg().voiceInput !== false && !!IO && IO.canRecord(); }
  function typing() { return !canTalk() || pref('ax.cam.type', false); }
  function speakOn() { return !!IO && pref('ax.cam.speak', camCfg().speakAnswers !== false); }
  function streamSeconds() { var b = camCfg().bot; return (b && b.streamMaxSeconds) || 60; }
  function streaming() { return !!(s && s.streamUntil && s.streamUntil > Date.now()); }
  function agentName(id) {
    var a = cfg && cfg.agents ? cfg.agents.filter(function (x) { return x.id === id; })[0] : null;
    return a ? a.name : id;
  }

  // then() runs once the destinations are listed (the Show bar uses it).
  function open(then) {
    sheet.hidden = false;
    closeBtn.focus();
    if (s) return;
    say('Loading your machines…');
    pick.hidden = true; startBtn.hidden = true;
    api('GET', '/api/app/camera/config').then(function (c) {
      cfg = c;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
        say('This browser cannot share its camera here. Open the app over https (tailscale serve).', true); return;
      }
      var agents = c.agents || [];
      if (!c.peers.length && !agents.length) { say('No other machine or agent to show it to. Add a mesh peer, then try again.', true); return; }
      peerSel.innerHTML = '';
      c.peers.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.name; o.textContent = p.name;
        peerSel.appendChild(o);
      });
      agents.forEach(function (a) {
        var o = document.createElement('option');
        o.value = 'bot:' + a.id; o.textContent = 'Agent: ' + a.name;
        peerSel.appendChild(o);
      });
      pick.hidden = false; startBtn.hidden = false;
      say('The camera opens only when you tap Start. A machine gets a link to watch; an agent looks when you tap Look now.');
      if (then) then();
    }).catch(function (e) { say(e.message || 'Could not load your machines.', true); });
  }

  function close() {
    if (s) return; // while live, only Stop ends it
    sheet.hidden = true;
    btn.focus();
  }

  function newCallId() {
    var ids = new Uint8Array(8);
    crypto.getRandomValues(ids);
    return 'cam-' + Array.prototype.map.call(ids, function (b) { return (b % 36).toString(36); }).join('');
  }

  // preset comes from the Show bar: the ask's id and its agent.
  function start(preset) {
    if (s || !cfg) return;
    var peer = preset && preset.peer ? preset.peer : peerSel.value;
    var agent = agentOf(peer);
    var cam = cfg.camera || null;
    var maxMs = ((cam && cam.maxSeconds) || 600) * 1000;
    // An agent's watch has its own limit; the shorter one shows.
    if (agent && cam && cam.bot && cam.bot.maxSessionMinutes) maxMs = Math.min(maxMs, cam.bot.maxSessionMinutes * 60000);
    var callId = preset && preset.callId ? preset.callId : newCallId();
    startBtn.disabled = true;
    say('Opening the camera…');
    navigator.mediaDevices.getUserMedia(cameraConstraints(cam, 'environment')).then(function (stream) {
      s = { callId: callId, peer: peer, agent: agent, stream: stream, facing: 'environment', until: Date.now() + maxMs, pc: null, es: null, shown: 0 };
      video.srcObject = stream; video.hidden = false;
      sheet.classList.add('is-live');
      live.hidden = false; flipBtn.hidden = false; startBtn.hidden = true; pick.hidden = true; closeBtn.hidden = true;
      if (agent) { lookBtn.hidden = false; streamBtn.hidden = false; speakBtn.hidden = false; replyBox.hidden = true; replyBox.innerHTML = ''; layoutAsk(); paintStream(); }
      document.title = '● Camera live · AgentX';
      paintLive();
      s.tick = setInterval(paintLive, 1000);
      s.timer = setTimeout(function () { stop('The share reached its time limit and stopped.'); }, maxMs);
      connect();
    }).catch(function (e) {
      startBtn.disabled = false;
      say(e && e.name === 'NotAllowedError'
        ? 'Camera access was refused. Allow the camera for this app in Settings, then try again.'
        : 'Could not open the camera: ' + (e && e.message ? e.message : e), true);
    });
  }

  function who() { return s.agent ? agentName(s.agent) : s.peer; }
  function paintLive() {
    if (!s) return;
    if (s.streamUntil && !streaming()) {
      s.streamUntil = null;
      paintStream();
      say('Keep watching stopped. ' + who() + ' gets one picture per question again.');
    }
    liveText.textContent = (s.agent ? agentName(s.agent) + ' is watching' : 'Camera live on ' + s.peer) + ' · ' + shareClock(s.until - Date.now()) +
      (streaming() ? ' · continuous ' + shareClock(s.streamUntil - Date.now()) : '');
  }

  function connect() {
    var pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
    s.pc = pc;
    s.stream.getTracks().forEach(function (t) { pc.addTrack(t, s.stream); });
    pc.onicecandidate = function (ev) {
      if (!ev.candidate || !s) return;
      post({ kind: 'ice', callId: s.callId, to: s.peer, candidate: {
        candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment,
      } }).catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (!s) return;
      if (pc.connectionState === 'connected') {
        say(!s.agent ? who() + ' is watching. Tap Stop to end.'
          : typing() ? who() + ' can see the camera. Type a question and tap Look now.'
          : who() + ' can see the camera. Hold Talk and ask, or tap it once to start and again to send.');
        if (s.agent && !s.poll) s.poll = setInterval(pollReplies, 5000);
      }
      if (pc.connectionState === 'failed') stop('The connection to ' + who() + ' failed. Check both are on the tailnet, or add a TURN server.');
    };
    var es = new EventSource('/api/app/camera/events?callId=' + encodeURIComponent(s.callId));
    s.es = es;
    // EventSource retries network drops by itself; an HTTP error (token revoked,
    // calls turned off) closes it for good, so nothing more can arrive.
    es.onerror = function () {
      if (s && s.es === es && es.readyState === EventSource.CLOSED) stop('Lost the link to this computer, so the camera stopped.');
    };
    var rang = false;
    es.addEventListener('ready', function () {
      if (rang || !s) return;
      rang = true;
      // For an agent the ring starts its bot, which offers at once.
      post({ kind: 'ring', callId: s.callId, to: s.peer }).then(function () {
        if (s) say(s.agent ? 'Connecting to ' + who() + '…' : 'Waiting for ' + s.peer + ' to open the link it was sent…');
      }).catch(function (e) { stop('Could not reach ' + (s ? who() : 'the machine') + ': ' + e.message); });
    });
    es.addEventListener('signal', function (evt) {
      var sig; try { sig = JSON.parse(evt.data); } catch (e) { return; }
      if (!s || sig.callId !== s.callId || norm(sig.from) !== norm(s.peer)) return;
      if (sig.kind === 'hangup') { stop(who() + ' stopped watching.'); return; }
      if (sig.kind === 'offer') {
        pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp }).then(function () {
          return pc.createAnswer();
        }).then(function (ans) {
          return pc.setLocalDescription(ans).then(function () {
            return post({ kind: 'answer', callId: s.callId, to: s.peer, sdp: ans.sdp });
          });
        }).catch(function (e) { stop('Could not connect: ' + e.message); });
      } else if (sig.kind === 'ice' && sig.candidate) {
        pc.addIceCandidate(sig.candidate).catch(function () {});
      }
    });
  }

  // The owner asks the agent what it sees: one frame, one turn, its answer
  // on the sheet and said aloud. spoken is the question from Talk.
  function look(spoken) {
    if (!s || !s.agent || s.asking) return;
    var text = typeof spoken === 'string' ? spoken : note.value.trim();
    if (IO) IO.unlock();
    stopSpeaking();
    s.asking = true; lookBtn.disabled = true; talkBtn.disabled = true;
    if (text) s.lastAsk = text;
    say(text ? 'Asking ' + who() + ': “' + text + '”' : 'Asking ' + who() + '…');
    var mine = s;
    api('POST', '/api/app/camera/look', { callId: s.callId, note: text }).then(function (r) {
      if (s !== mine) return;
      if (typeof spoken !== 'string') note.value = '';
      showReply(r.reply);
      speakReply(r.reply);
      say(typing() ? 'Ask again, or tap Look now for a fresh look.' : 'Hold Talk to ask again.');
    }).catch(function (e) { if (s === mine) say(e.message || 'No answer.', true); })
      .then(function () { mine.asking = false; lookBtn.disabled = false; talkBtn.disabled = false; });
  }

  // --- Talk: hold and let go, or tap to start and tap to send ---
  function paintTalk(text) {
    var on = !!(talk.rec || talk.arming);
    talkLabel.textContent = text || (on ? 'Listening…' : 'Hold to talk');
    talkBtn.classList.toggle('is-on', on);
    talkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function talkDown() {
    if (!s || !s.agent || !IO) return;
    IO.unlock();
    // A second tap sends what the first one started.
    if (talk.rec || talk.arming) { if (talk.mode === 'listen') finishTalk(true); return; }
    if (s.asking) return;
    stopSpeaking();
    talk.pressed = true; talk.t0 = Date.now(); talk.mode = null; talk.arming = true;
    paintTalk();
    say('Listening…');
    IO.record().then(function (rec) {
      talk.arming = false;
      if (!s) { rec.stop(false); paintTalk(); return; }
      talk.rec = rec;
      if (talk.mode === 'send' || talk.mode === 'cancel') { finishTalk(talk.mode === 'send'); return; }
      talk.timer = setTimeout(function () { finishTalk(true); }, 60000);
      paintTalk(talk.mode === 'listen' ? 'Listening… tap to send' : null);
    }).catch(function (e) {
      talk.arming = false; talk.pressed = false; talk.mode = null;
      paintTalk();
      if (!s) return;
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      say(denied ? 'The microphone is blocked. Allow it for this app in the phone’s settings, or tap Type instead.'
        : 'Could not open the microphone. Tap Type instead to write your question.', true);
    });
  }
  function talkUp() {
    if (!talk.pressed) return;
    talk.pressed = false;
    talk.mode = talkRelease(Date.now() - talk.t0);
    if (talk.mode === 'send') { if (talk.rec) finishTalk(true); return; }
    paintTalk('Listening… tap to send');
    say('Listening. Tap Talk again when you are done.');
  }
  function finishTalk(keep) {
    if (!talk.rec) { if (talk.arming) talk.mode = keep ? 'send' : 'cancel'; return; }
    var rec = talk.rec;
    talk.rec = null; talk.mode = null; talk.pressed = false;
    clearTimeout(talk.timer);
    paintTalk();
    rec.stop(keep).then(function (take) {
      if (!s) return;
      if (!take) { say(keep ? 'Didn’t catch that. Hold Talk while you speak.' : 'Cancelled.'); return; }
      transcribe(take);
    });
  }
  function transcribe(take) {
    var mine = s;
    mine.asking = true; lookBtn.disabled = true; talkBtn.disabled = true;
    say('Writing down what you said…');
    fetch('/api/app/voice/transcribe', {
      method: 'POST', credentials: 'same-origin', body: take.blob,
      headers: { 'Content-Type': take.blob.type || 'audio/webm', 'X-Audio-Duration-Ms': String(take.ms) },
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (x) {
      mine.asking = false; lookBtn.disabled = false; talkBtn.disabled = false;
      if (s !== mine) return;
      if (x.ok && x.j.text) { look(x.j.text); return; }
      if (x.status === 503 && x.j.hint) { say(x.j.error + ' ' + x.j.hint + ' You can type instead.', true); return; }
      say(x.j.error || ('Speech to text failed (HTTP ' + x.status + ').'), true);
    }).catch(function () {
      mine.asking = false; lookBtn.disabled = false; talkBtn.disabled = false;
      if (s === mine) say('Could not reach AgentX. Check the connection and try again.', true);
    });
  }

  // Talk, or the text box: one or the other shows. An agent's request
  // (the Show bar) fills the box in, so it shows too, next to Talk.
  function layoutAsk() {
    var t = typing();
    talkBtn.hidden = t;
    ask.hidden = !t && !note.value.trim();
    typeBtn.hidden = !canTalk();
    typeBtn.textContent = t ? 'Talk instead' : 'Type instead';
    typeBtn.setAttribute('aria-pressed', t ? 'true' : 'false');
    paintSpeaker();
  }
  function paintSpeaker() {
    var on = speakOn();
    speakBtn.hidden = !IO || !s || !s.agent;
    speakBtn.textContent = 'Answers aloud: ' + (on ? 'on' : 'off');
    speakBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // --- Answers said aloud, one at a time ---
  function stopSpeaking() { speakGen++; if (IO) IO.stop(); }
  function sayAloud(text, gen) {
    return gen === speakGen && text ? IO.speakText(text, function () {}).catch(function () {}) : null;
  }
  function speakReply(r) {
    if (!s || !r || !r.text || !speakOn()) return;
    var gen = speakGen, callId = s.callId;
    speaking = speaking.then(function () {
      if (gen !== speakGen || !s || s.callId !== callId) return null;
      return fetch('/api/app/camera/speak', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: callId, at: r.at }),
      }).then(function (res) {
        if (gen !== speakGen) return null;
        if (res.ok && (res.headers.get('content-type') || '').indexOf('audio/') === 0) {
          return res.arrayBuffer().then(function (buf) { return gen === speakGen ? IO.playAudio(buf, function () {}) : null; })
            .catch(function () { return sayAloud(r.text, gen); });
        }
        return res.json().catch(function () { return {}; }).then(function (j) { return sayAloud(j.text || r.text, gen); });
      }).catch(function () { return sayAloud(r.text, gen); });
    }).catch(function () {});
  }

  // --- Keep watching: a frame every few seconds, for a short while ---
  function paintStream() {
    var on = streaming();
    streamBtn.textContent = on ? 'Stop watching' : streamLabel(streamSeconds());
    streamBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    live.classList.toggle('is-stream', on);
  }
  function toggleStream() {
    if (!s || !s.agent || streamBtn.disabled) return;
    if (IO) IO.unlock();
    var on = streaming(), mine = s;
    streamBtn.disabled = true;
    api('POST', '/api/app/camera/stream', { callId: s.callId, seconds: on ? 0 : streamSeconds(), note: on ? '' : (note.value.trim() || s.lastAsk || '') }).then(function (r) {
      if (s !== mine) return;
      s.streamUntil = r.watch && r.watch.streamUntil ? r.watch.streamUntil : null;
      paintStream(); paintLive();
      say(s.streamUntil ? who() + ' is watching continuously and will speak up. It stops by itself, or tap Stop watching.'
        : who() + ' gets one picture per question again.');
    }).catch(function (e) { if (s === mine) say(e.message || 'Could not change watching.', true); })
      .then(function () { streamBtn.disabled = false; });
  }

  function showReply(r) {
    if (!r || !r.text) return;
    s.shown = Math.max(s.shown || 0, r.at || 0);
    var item = document.createElement('div');
    var head = document.createElement('strong');
    head.textContent = who() + (r.note ? ' · ' + r.note : '') + ' · ' + new Date(r.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var body = document.createElement('span');
    body.textContent = r.text;
    item.appendChild(head); item.appendChild(body);
    replyBox.insertBefore(item, replyBox.firstChild);
    replyBox.hidden = false;
  }

  // Answers to frames the agent got by itself (frameIntervalSeconds).
  // Answers while Keep watching is on come the same way, and are said aloud.
  function pollReplies() {
    if (!s || !s.agent || s.asking || document.visibilityState !== 'visible') return;
    var mine = s;
    api('GET', '/api/app/camera/watch?callId=' + encodeURIComponent(s.callId)).then(function (r) {
      if (s !== mine || !r.watch || s.asking) return;
      (r.watch.replies || []).forEach(function (rep) { if (rep.at > (s.shown || 0)) { showReply(rep); speakReply(rep); } });
      if (s.streamUntil && !r.watch.streamUntil) { s.streamUntil = null; paintStream(); }
    }).catch(function () {});
  }

  function flip() {
    if (!s) return;
    var facing = s.facing === 'environment' ? 'user' : 'environment';
    flipBtn.disabled = true;
    navigator.mediaDevices.getUserMedia(cameraConstraints(cfg.camera || null, facing)).then(function (next) {
      if (!s) { next.getTracks().forEach(function (t) { t.stop(); }); return; }
      var track = next.getVideoTracks()[0];
      var sender = s.pc && s.pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
      return (sender ? sender.replaceTrack(track) : Promise.resolve()).then(function () {
        s.stream.getTracks().forEach(function (t) { t.stop(); });
        s.stream = next; s.facing = facing;
        video.srcObject = next;
      });
    }).catch(function (e) { say('Could not switch cameras: ' + e.message, true); })
      .then(function () { flipBtn.disabled = false; });
  }

  function stop(reason) {
    if (!s) return;
    var was = s;
    finishTalk(false);
    stopSpeaking();
    s = null;
    clearInterval(was.tick); clearTimeout(was.timer); clearInterval(was.poll);
    post({ kind: 'hangup', callId: was.callId, to: was.peer }, true).catch(function () {});
    try { if (was.es) was.es.close(); } catch (e) {}
    try { if (was.pc) was.pc.close(); } catch (e) {}
    was.stream.getTracks().forEach(function (t) { t.stop(); });
    video.srcObject = null; video.hidden = true;
    sheet.classList.remove('is-live');
    live.hidden = true; flipBtn.hidden = true; closeBtn.hidden = false;
    lookBtn.hidden = true; lookBtn.disabled = false; ask.hidden = true;
    talkBtn.hidden = true; talkBtn.disabled = false; paintTalk();
    streamBtn.hidden = true; typeBtn.hidden = true; speakBtn.hidden = true; live.classList.remove('is-stream');
    startBtn.hidden = false; startBtn.disabled = false; pick.hidden = false;
    document.title = 'AgentX';
    say(reason || 'Camera stopped.');
  }

  btn.addEventListener('click', function () { open(); });
  closeBtn.addEventListener('click', close);
  startBtn.addEventListener('click', function () { start(); });
  // The owner tapped Show on an agent's ask: open the camera for that
  // agent, under the ask's id, so the daemon ties the share to the ask.
  document.addEventListener('ax-camera', function (ev) {
    var d = ev.detail || {};
    if (d.type !== 'show' || !d.agentId || !d.callId || s) return;
    var preset = { peer: 'bot:' + d.agentId, callId: d.callId };
    open(function () {
      peerSel.value = preset.peer;
      if (d.reason) note.value = d.reason;
      start(preset);
    });
  });
  lookBtn.addEventListener('click', function () { look(); });
  streamBtn.addEventListener('click', toggleStream);
  typeBtn.addEventListener('click', function () {
    setPref('ax.cam.type', !typing());
    layoutAsk();
    if (typing()) note.focus(); else talkBtn.focus();
  });
  speakBtn.addEventListener('click', function () {
    var on = !speakOn();
    setPref('ax.cam.speak', on);
    if (!on) stopSpeaking(); else if (IO) IO.unlock();
    paintSpeaker();
  });
  talkBtn.addEventListener('pointerdown', function (ev) {
    if (ev.button > 0) return;
    ev.preventDefault();
    try { talkBtn.setPointerCapture(ev.pointerId); } catch (e) {}
    talkDown();
  });
  talkBtn.addEventListener('pointerup', talkUp);
  talkBtn.addEventListener('pointercancel', function () { if (talk.pressed) { talk.pressed = false; finishTalk(false); } });
  talkBtn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  talkBtn.addEventListener('click', function (ev) { ev.preventDefault(); });
  // Keyboard: hold Space or Enter to talk, or press it once to start and
  // again to send; Escape cancels.
  talkBtn.addEventListener('keydown', function (ev) {
    if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); talkDown(); }
    else if (ev.key === 'Escape' && (talk.rec || talk.arming)) { ev.stopPropagation(); talk.pressed = false; finishTalk(false); }
  });
  talkBtn.addEventListener('keyup', function (ev) { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); talkUp(); } });
  flipBtn.addEventListener('click', flip);
  note.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); look(); } });
  document.getElementById('cam-stop').addEventListener('click', function () { stop('Camera stopped.'); });
  sheet.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  // No capture in the background: leaving the app ends the share.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') stop('The app went to the background, so the camera stopped.');
  });
  window.addEventListener('pagehide', function () { stop(); });
})();
`
