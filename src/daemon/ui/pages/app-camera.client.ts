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
// Video only: the microphone is never opened.
//
// With an agent as the destination (phase 2) the daemon's bot is the viewer.
// It keeps only the newest frame; Look now hands one to the agent with an
// optional question, and its answer shows on the sheet. Answers to frames
// the agent got by itself (frameIntervalSeconds) are picked up by a poll.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export { CAMERA_CSS } from "./app-camera.css"

export const CAMERA_BUTTON = `<button type="button" id="cam-btn" class="icon-btn" aria-label="Share camera" aria-haspopup="dialog">📷</button>`

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
    <label class="cam-field" id="cam-ask" hidden>Ask the agent something (optional)
      <input id="cam-note" type="text" maxlength="300" autocomplete="off" placeholder="What is this cable for?">
    </label>
    <div class="cam-row">
      <button type="button" id="cam-start" class="cam-primary" hidden>Start camera</button>
      <button type="button" id="cam-look" class="cam-primary" hidden>Look now</button>
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
  var cfg = null;
  var s = null; // the live share: { callId, peer, agent, stream, pc, es, facing, until, timer, tick, poll, shown }

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
      if (agent) { lookBtn.hidden = false; ask.hidden = false; replyBox.hidden = true; replyBox.innerHTML = ''; }
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
    liveText.textContent = (s.agent ? agentName(s.agent) + ' is watching' : 'Camera live on ' + s.peer) + ' · ' + shareClock(s.until - Date.now());
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
        say(s.agent ? who() + ' can see the camera. Tap Look now to ask what it sees.' : who() + ' is watching. Tap Stop to end.');
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

  // The owner asks the agent what it sees: one turn, its answer on the sheet.
  function look() {
    if (!s || !s.agent || lookBtn.disabled) return;
    var text = note.value.trim();
    lookBtn.disabled = true;
    say('Asking ' + who() + '…');
    api('POST', '/api/app/camera/look', { callId: s.callId, note: text }).then(function (r) {
      if (!s) return;
      note.value = '';
      showReply(r.reply);
      say('Tap Look now again for a fresh look.');
    }).catch(function (e) { if (s) say(e.message || 'No answer.', true); })
      .then(function () { lookBtn.disabled = false; });
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
  function pollReplies() {
    if (!s || !s.agent || document.visibilityState !== 'visible') return;
    api('GET', '/api/app/camera/watch?callId=' + encodeURIComponent(s.callId)).then(function (r) {
      if (!s || !r.watch) return;
      (r.watch.replies || []).forEach(function (rep) { if (rep.at > (s.shown || 0)) showReply(rep); });
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
  lookBtn.addEventListener('click', look);
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
