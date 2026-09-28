// --- "Scan QR code" on the locked page (#234) ---
//
// Pairs the installed app from inside itself: the camera reads the QR code
// that `agentx app pair` prints. A link `…/app/pair#token=…` pairs at once
// (POST /api/app/session, the same call the pair page makes); a bare code
// fills the field and submits it. parsePairScan() in app-pair-logic.ts
// decides which, and is injected before this script.
//
// Decoding uses the browser's BarcodeDetector where it can read QR codes
// (Chrome on Android). iOS Safari has none, so the page then loads jsQR
// (Apache-2.0, served at /app/qr.js by app-routes.ts) — only when Scan is
// tapped, never on a normal start.
//
// The camera runs only while the scanner is open: every way out (Close,
// Escape, success, the app going to the background) stops its tracks.
// No backslashes, backticks or dollar-brace in the script: it sits inside a
// TS template literal.

export const SCAN_BODY = `
<div id="scan" class="scan" role="dialog" aria-modal="true" aria-labelledby="scan-title" hidden>
  <video id="scan-video" playsinline muted autoplay></video>
  <div class="scan-frame" aria-hidden="true"></div>
  <div class="scan-top">
    <h2 id="scan-title">Scan the pairing QR code</h2>
    <button type="button" id="scan-close" class="scan-close">Close</button>
  </div>
  <p id="scan-msg" class="scan-msg" role="status" aria-live="polite">Point the camera at the QR code shown by agentx app pair.</p>
</div>`

export const SCAN_CSS = `
.pair-form .scan-btn {
  color: var(--ax-accent-2, var(--ax-accent)); background: transparent; border: 2px solid var(--ax-accent);
}
[data-theme="dark"] .pair-form .scan-btn { color: var(--ax-text); }
.scan { position: fixed; inset: 0; z-index: 50; background: #000; color: #fff; overflow: hidden; }
.scan[hidden] { display: none; }
.scan video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.scan-frame {
  position: absolute; left: 50%; top: 50%; width: min(70vw, 70vh, 320px); aspect-ratio: 1;
  transform: translate(-50%, -50%); border: 3px solid rgba(255,255,255,0.9); border-radius: 20px;
  box-shadow: 0 0 0 100vmax rgba(0,0,0,0.45);
}
.scan-top {
  position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
}
.scan-top h2 { margin: 0; font-size: 17px; font-weight: 700; }
.scan-close {
  min-height: 44px; padding: 0 18px; border: 0; border-radius: var(--ax-radius-pill);
  font: inherit; font-weight: 700; color: #000; background: #fff; cursor: pointer;
}
.scan-msg {
  position: absolute; left: 0; right: 0; bottom: 0; margin: 0; text-align: center; line-height: 1.45;
  padding: 16px calc(20px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left));
  background: rgba(0,0,0,0.6);
}
.scan-msg.bad { color: #ffd0cc; font-weight: 600; }
body.scanning { overflow: hidden; }
`

export const SCAN_SCRIPT = `
(function () {
  var openBtn = document.getElementById('scan-btn');
  var box = document.getElementById('scan');
  var video = document.getElementById('scan-video');
  var smsg = document.getElementById('scan-msg');
  var closeBtn = document.getElementById('scan-close');
  var input = document.getElementById('pair-code');
  var form = document.getElementById('pair-form');
  var pairMsg = document.getElementById('pair-msg');
  var HINT = 'Point the camera at the QR code shown by agentx app pair.';
  var stream = null, timer = null, detector = null, canvas = null, ctx = null, working = false, done = false, jsqr = null, misses = 0;

  // No camera API: plain http, or a browser without it. Typing the code
  // still works, so just don't offer Scan.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { openBtn.hidden = true; return; }

  function say(text, bad) { smsg.textContent = text; smsg.className = bad ? 'scan-msg bad' : 'scan-msg'; }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null;
    working = false;
  }
  function close() {
    stop();
    if (box.hidden) return;
    box.hidden = true;
    document.body.classList.remove('scanning');
    openBtn.focus();
  }

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!jsqr) {
      jsqr = new Promise(function (ok, fail) {
        var s = document.createElement('script');
        s.src = '/app/qr.js';
        s.async = true;
        s.onload = function () { if (window.jsQR) ok(window.jsQR); else fail(new Error('no jsQR')); };
        s.onerror = function () { jsqr = null; fail(new Error('load failed')); };
        document.head.appendChild(s);
      });
    }
    return jsqr;
  }
  function pickDecoder() {
    if (!('BarcodeDetector' in window)) return loadJsQR().then(function () { return null; });
    var BD = window.BarcodeDetector;
    var formats = BD.getSupportedFormats ? BD.getSupportedFormats() : Promise.resolve(['qr_code']);
    return formats.then(function (f) {
      if (f.indexOf('qr_code') < 0) throw new Error('no qr');
      return new BD({ formats: ['qr_code'] });
    }).catch(function () { return loadJsQR().then(function () { return null; }); });
  }

  // One frame. Returns the QR text, or null when there is none yet.
  // Some BarcodeDetector builds claim QR support and never find one, or
  // fail outright; after 3 seconds without a result (or on an error) jsQR
  // reads every other frame too.
  function readFrame() {
    var useDetector = detector && (misses < 24 || misses % 2 === 0 || !window.jsQR);
    if (detector && misses === 24) loadJsQR().catch(function () {});
    if (useDetector) {
      return detector.detect(video).then(function (codes) {
        if (codes.length) return codes[0].rawValue;
        misses++;
        return null;
      }, function () {
        detector = null;
        return loadJsQR().then(function () { return null; });
      });
    }
    misses++;
    if (!window.jsQR) return Promise.resolve(null);
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return Promise.resolve(null);
    var scale = Math.min(1, 720 / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    canvas.width = cw; canvas.height = ch;
    ctx.drawImage(video, 0, 0, cw, ch);
    var found = window.jsQR(ctx.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts: 'attemptBoth' });
    return Promise.resolve(found ? found.data : null);
  }

  function tick() {
    if (working || done || !stream) return;
    working = true;
    readFrame().then(function (text) {
      working = false;
      if (text) handle(text);
    }, function () { working = false; });
  }

  function handle(text) {
    var r = parsePairScan(text);
    if (r.kind === 'none') { say("That QR isn't an AgentX pairing code. Scan the one shown by agentx app pair.", true); return; }
    done = true;
    stop();
    if (r.kind === 'code') {
      close();
      input.value = r.code;
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
      return;
    }
    say('Pairing…', false);
    fetch('/api/app/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Authorization': 'Bearer ' + r.token },
    }).then(function (res) {
      if (res.ok) { say('Paired. Opening the app…', false); location.replace('/app'); return; }
      close();
      pairMsg.className = 'pair-msg bad';
      pairMsg.textContent = res.status === 401
        ? 'That QR code is not valid any more. Run agentx app pair again and scan the new one.'
        : 'Pairing failed (HTTP ' + res.status + '). Try again.';
    }).catch(function () {
      close();
      pairMsg.className = 'pair-msg bad';
      pairMsg.textContent = 'Could not reach AgentX. Pairing needs a connection: check this phone is on your tailnet, then try again.';
    });
  }

  function cameraError(err) {
    stop();
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      say('AgentX may not use the camera. Allow camera access for this app (on iPhone: Settings, then Safari, then Camera), or type the code instead.', true);
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      say('No camera found on this device. Type the code instead.', true);
    } else if (name === 'decoder') {
      say('Could not load the QR reader. Check the connection, or type the code instead.', true);
    } else {
      say('The camera could not start. Close other apps using it, or type the code instead.', true);
    }
  }

  function open() {
    done = false;
    misses = 0;
    box.hidden = false;
    document.body.classList.add('scanning');
    say(HINT, false);
    closeBtn.focus();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (s) {
      if (box.hidden) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      video.srcObject = s;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      return pickDecoder().then(function (d) {
        detector = d;
        if (stream) timer = setInterval(tick, 125);
      }, function () { cameraError({ name: 'decoder' }); });
    }).catch(cameraError);
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  box.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) close(); });
  window.addEventListener('pagehide', close);
})();
`
