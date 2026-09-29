// --- Phone app: Share camera (#325) ---
//
// The camera button in the app's header opens a sheet: pick the machine to
// show the camera on, tap Start. The owner taps every time; nothing opens the
// camera by itself. While it is live a red bar with a Stop button stays on
// screen, and the share stops when the owner taps Stop, when the viewer hangs
// up, when the app goes to the background, or after channels.webrtc.camera
// .maxSeconds.
//
// Signalling goes through /api/app/camera/* (app-camera.ts) to the daemon's
// WebRTC broker and on to the chosen machine, which notifies its owner with a
// /call?watch=1 link. The viewer's page sends the offer and this phone only
// answers, so the share waits as long as the owner takes to open the link.
// Video only: the microphone is never opened.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

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
    <label class="cam-field" id="cam-pick" hidden>Show it on
      <select id="cam-peer"></select>
    </label>
    <div class="cam-row">
      <button type="button" id="cam-start" class="cam-primary" hidden>Start camera</button>
      <button type="button" id="cam-flip" class="cam-secondary" hidden>Flip camera</button>
      <button type="button" id="cam-close" class="cam-secondary">Close</button>
    </div>
  </div>
</div>`

export const CAMERA_CSS = `
.cam { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; background: var(--ax-bg); }
.cam[hidden] { display: none; }
.cam-live {
  display: flex; align-items: center; gap: 10px;
  padding: calc(10px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 10px calc(16px + env(safe-area-inset-left));
  background: var(--ax-red); color: #fff; font-weight: 700;
}
.cam-live[hidden] { display: none; }
.cam-dot { width: 12px; height: 12px; border-radius: 50%; background: #fff; flex: none; }
#cam-live-text { flex: 1; }
.cam-stop {
  min-height: 44px; min-width: 88px; border: 2px solid #fff; border-radius: var(--ax-radius-pill);
  background: transparent; color: #fff; font: inherit; font-weight: 700; cursor: pointer;
}
.cam-video { flex: 1; min-height: 0; width: 100%; object-fit: contain; background: #000; }
.cam-video[hidden] { display: none; }
.cam-panel { padding: 16px calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
.cam:not(.is-live) .cam-panel { padding-top: calc(16px + env(safe-area-inset-top)); }
.cam-panel h2 { font-size: 20px; margin: 0 0 8px; }
.cam-msg { margin: 0 0 12px; color: var(--ax-text-2); line-height: 1.5; }
.cam-msg.bad { color: var(--ax-red-ink); }
.cam-field[hidden] { display: none; }
.cam-field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; font-weight: 600; }
.cam-field select { min-height: 44px; font: inherit; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface-2); color: var(--ax-text); padding: 0 10px; }
.cam-row { display: flex; gap: 8px; flex-wrap: wrap; }
.cam-primary, .cam-secondary {
  min-height: 48px; padding: 0 18px; border-radius: var(--ax-radius-pill); font: inherit; font-weight: 600; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface-2); color: var(--ax-text);
}
.cam-primary { background: var(--ax-accent); border-color: var(--ax-accent); color: #fff; }
`

export const CAMERA_SCRIPT = `
(function () {
  var btn = document.getElementById('cam-btn');
  var sheet = document.getElementById('cam');
  if (!btn || !sheet) return;
  var msg = document.getElementById('cam-msg');
  var pick = document.getElementById('cam-pick');
  var peerSel = document.getElementById('cam-peer');
  var startBtn = document.getElementById('cam-start');
  var flipBtn = document.getElementById('cam-flip');
  var closeBtn = document.getElementById('cam-close');
  var live = document.getElementById('cam-live');
  var liveText = document.getElementById('cam-live-text');
  var video = document.getElementById('cam-video');
  var cfg = null;
  var s = null; // the live share: { callId, peer, stream, pc, es, facing, until, timer, tick }

  function norm(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function say(text, bad) { msg.textContent = text; msg.className = 'cam-msg' + (bad ? ' bad' : ''); }
  // keepalive lets the hangup leave while the page unloads (pagehide).
  function post(body, keepalive) {
    return fetch('/api/app/camera/signal', {
      method: 'POST', credentials: 'same-origin', keepalive: !!keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  function open() {
    sheet.hidden = false;
    closeBtn.focus();
    if (s) return;
    say('Loading your machines…');
    pick.hidden = true; startBtn.hidden = true;
    fetch('/api/app/camera/config', { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    }).then(function (c) {
      cfg = c;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
        say('This browser cannot share its camera here. Open the app over https (tailscale serve).', true); return;
      }
      if (!c.peers.length) { say('No other machine to show it on. Add a mesh peer, then try again.', true); return; }
      peerSel.innerHTML = '';
      c.peers.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.name; o.textContent = p.name;
        peerSel.appendChild(o);
      });
      pick.hidden = false; startBtn.hidden = false;
      say('The camera opens only when you tap Start. The other machine gets a link to watch.');
    }).catch(function (e) { say(e.message || 'Could not load your machines.', true); });
  }

  function close() {
    if (s) return; // while live, only Stop ends it
    sheet.hidden = true;
    btn.focus();
  }

  function start() {
    if (s || !cfg) return;
    var peer = peerSel.value;
    var cam = cfg.camera || null;
    var maxMs = ((cam && cam.maxSeconds) || 600) * 1000;
    var ids = new Uint8Array(8);
    crypto.getRandomValues(ids);
    var callId = 'cam-' + Array.prototype.map.call(ids, function (b) { return (b % 36).toString(36); }).join('');
    startBtn.disabled = true;
    say('Opening the camera…');
    navigator.mediaDevices.getUserMedia(cameraConstraints(cam, 'environment')).then(function (stream) {
      s = { callId: callId, peer: peer, stream: stream, facing: 'environment', until: Date.now() + maxMs, pc: null, es: null };
      video.srcObject = stream; video.hidden = false;
      sheet.classList.add('is-live');
      live.hidden = false; flipBtn.hidden = false; startBtn.hidden = true; pick.hidden = true; closeBtn.hidden = true;
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

  function paintLive() {
    if (!s) return;
    liveText.textContent = 'Camera live on ' + s.peer + ' · ' + shareClock(s.until - Date.now());
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
      if (pc.connectionState === 'connected') say(s.peer + ' is watching. Tap Stop to end.');
      if (pc.connectionState === 'failed') stop('The connection to ' + s.peer + ' failed. Check both are on the tailnet, or add a TURN server.');
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
      post({ kind: 'ring', callId: s.callId, to: s.peer }).then(function () {
        if (s) say('Waiting for ' + s.peer + ' to open the link it was sent…');
      }).catch(function (e) { stop('Could not reach ' + (s ? s.peer : 'the machine') + ': ' + e.message); });
    });
    es.addEventListener('signal', function (evt) {
      var sig; try { sig = JSON.parse(evt.data); } catch (e) { return; }
      if (!s || sig.callId !== s.callId || norm(sig.from) !== norm(s.peer)) return;
      if (sig.kind === 'hangup') { stop(s.peer + ' stopped watching.'); return; }
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
    clearInterval(was.tick); clearTimeout(was.timer);
    post({ kind: 'hangup', callId: was.callId, to: was.peer }, true).catch(function () {});
    try { if (was.es) was.es.close(); } catch (e) {}
    try { if (was.pc) was.pc.close(); } catch (e) {}
    was.stream.getTracks().forEach(function (t) { t.stop(); });
    video.srcObject = null; video.hidden = true;
    sheet.classList.remove('is-live');
    live.hidden = true; flipBtn.hidden = true; closeBtn.hidden = false;
    startBtn.hidden = false; startBtn.disabled = false; pick.hidden = false;
    document.title = 'AgentX';
    say(reason || 'Camera stopped.');
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  startBtn.addEventListener('click', start);
  flipBtn.addEventListener('click', flip);
  document.getElementById('cam-stop').addEventListener('click', function () { stop('Camera stopped.'); });
  sheet.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  // No capture in the background: leaving the app ends the share.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') stop('The app went to the background, so the camera stopped.');
  });
  window.addEventListener('pagehide', function () { stop(); });
})();
`
