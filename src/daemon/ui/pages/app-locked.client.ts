// --- "This phone isn't paired" page: pair with a one-time code ---
//
// A home-screen app on iOS has its own storage, so the cookie the QR link
// set in Safari never reaches it. Typing the code from `agentx app pair`
// here sets the cookie inside the app itself (POST /api/app/pair-code).
//
// It can also scan the QR code from `agentx app pair` with the camera, in
// the app itself: /app/qr.js (jsQR) decodes it, since iOS Safari has no
// BarcodeDetector. The pairing link pairs directly; a bare code is typed in.
//
// Before asking for anything, it checks whether this phone is in fact
// paired: iOS home-screen apps sometimes load a page without its cookie
// and then send it on the next fetch (#234). If GET /api/app/me works, it
// reloads into the app, once.
//
// The service worker keeps a copy of this page for offline starts, so the
// script says plainly when there is no connection instead of failing.
// No backslashes, backticks or dollar-brace in the script: it sits inside a
// TS template literal.

export const LOCKED_BODY = `
<main class="card">
  <h1>This phone isn't paired</h1>
  <p>On the computer running AgentX, open a terminal in the folder that holds <code>agentx.json</code> and run <code>agentx app pair</code>. Scan the QR code it shows, or type the code under it.</p>
  <form id="pair-form" class="pair-form" novalidate>
    <label for="pair-code">Pairing code</label>
    <input id="pair-code" name="code" type="text" placeholder="XXXX-XXXX" maxlength="16"
      autocomplete="one-time-code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
    <button type="submit" id="pair-btn">Pair</button>
    <button type="button" id="scan-btn" class="scan-btn">Scan QR code</button>
    <p id="pair-offline" class="pair-offline" role="status" hidden>You're offline. Pairing needs a connection: turn on Wi-Fi or mobile data and Tailscale, then try again.</p>
    <p id="pair-msg" class="pair-msg" role="status" aria-live="polite"></p>
  </form>
  <div id="scan" class="scan" hidden>
    <video id="scan-video" playsinline muted autoplay></video>
    <button type="button" id="scan-stop" class="scan-stop">Cancel</button>
  </div>
  <p class="muted">Scan QR code opens the camera here and reads the QR code <code>agentx app pair</code> shows. In the browser, the phone's Camera app works too.</p>
  <p class="muted">If this phone was paired before, it may have been removed with <code>agentx app revoke</code>.</p>
</main>`

export const LOCKED_CSS = `
.pair-form { display: grid; gap: 10px; margin: 20px 0 24px; }
.pair-form label { font-weight: 600; }
.pair-form input {
  box-sizing: border-box; width: 100%; min-height: 60px; padding: 10px 14px;
  font: 600 26px/1.2 var(--ax-mono); letter-spacing: 0.12em; text-align: center; text-transform: uppercase;
  color: var(--ax-text); background: var(--ax-surface); border: 2px solid var(--ax-border); border-radius: var(--ax-radius-sm);
}
.pair-form input::placeholder { color: var(--ax-text-3, var(--ax-text-2)); opacity: 0.6; }
.pair-form input:focus { border-color: var(--ax-accent); outline: none; }
.pair-form button {
  min-height: 52px; border: 0; border-radius: var(--ax-radius-pill);
  font: inherit; font-size: 17px; font-weight: 700; color: #fff; background: var(--ax-accent); cursor: pointer;
}
.pair-form button:disabled { opacity: 0.55; cursor: default; }
.pair-form .scan-btn { color: var(--ax-accent); background: transparent; border: 2px solid var(--ax-accent); }
.scan { display: grid; gap: 10px; margin: 0 0 24px; }
.scan[hidden] { display: none; }
.scan video { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--ax-radius-sm); background: #000; }
.scan-stop {
  min-height: 48px; border: 2px solid var(--ax-border); border-radius: var(--ax-radius-pill);
  font: inherit; font-weight: 600; color: var(--ax-text); background: var(--ax-surface); cursor: pointer;
}
.pair-msg { margin: 0; min-height: 1.5em; }
.pair-msg.bad { color: var(--ax-red-ink); }
[data-theme="dark"] .pair-msg.bad { color: var(--ax-red); }
.pair-offline {
  margin: 0; padding: 8px 12px; border-radius: var(--ax-radius-sm); font-size: var(--ax-fs-sm);
  background: var(--ax-amber-t); color: var(--ax-amber-ink); border: 1px solid var(--ax-amber-e);
}
`

/** Pure helpers, kept apart so tests can run them. formatCode turns what
 *  was typed into XXXX-XXXX; parseScan reads a scanned QR code. */
export const LOCKED_HELPERS = `
function formatCode(v) {
  var c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}
function parseScan(text) {
  var t = String(text || '').trim();
  var m = /[#&]token=([^&]+)/.exec(t);
  if (m && t.indexOf('/app/pair') >= 0) {
    try { return { token: decodeURIComponent(m[1]) }; } catch (e) { return null; }
  }
  var code = formatCode(t);
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && t.replace(/[^A-Za-z0-9]/g, '').length === 8 ? { code: code } : null;
}
`

export const LOCKED_SCRIPT = `
(function () {
` + LOCKED_HELPERS + `
  var form = document.getElementById('pair-form');
  var input = document.getElementById('pair-code');
  var btn = document.getElementById('pair-btn');
  var msg = document.getElementById('pair-msg');
  var offline = document.getElementById('pair-offline');
  var busy = false;
  function setOnline(on) { offline.hidden = on; btn.disabled = busy || !on; }
  function say(text, bad) { msg.textContent = text; msg.className = bad ? 'pair-msg bad' : 'pair-msg'; }
  setOnline(navigator.onLine !== false);
  window.addEventListener('online', function () { setOnline(true); });
  window.addEventListener('offline', function () { setOnline(false); });
  input.addEventListener('input', function () {
    var f = formatCode(input.value);
    if (f !== input.value) input.value = f;
    if (msg.className.indexOf('bad') >= 0) say('', false);
  });
  function done() { busy = false; setOnline(navigator.onLine !== false); }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    var code = formatCode(input.value);
    if (!code) { say('Type the code shown by agentx app pair.', true); input.focus(); return; }
    if (navigator.onLine === false) { setOnline(false); return; }
    busy = true; btn.disabled = true; say('Pairing…', false);
    fetch('/api/app/pair-code', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    }).then(function (r) {
      if (r.ok) { say('Paired. Opening the app…', false); location.replace('/app'); return; }
      done();
      if (r.status === 429) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          var m = Math.max(1, Math.ceil(((b && b.retryAfter) || 300) / 60));
          say('Too many attempts. Wait ' + m + (m === 1 ? ' minute' : ' minutes') + ', then try again.', true);
        });
      }
      say("That code didn't work. Check it, or run agentx app pair on the computer for a new one.", true);
      input.focus(); input.select();
    }).catch(function () {
      done();
      say('Could not reach AgentX. Pairing needs a connection: check this phone is on your tailnet, then try again.', true);
    });
  });

  // Already paired after all? One reload per 30 s at most, so a phone that
  // really is locked out can't loop.
  fetch('/api/app/me', { credentials: 'same-origin', headers: { 'X-AgentX-Probe': 'locked' } }).then(function (r) {
    if (!r.ok) return;
    var last = 0;
    try { last = Number(sessionStorage.getItem('ax-heal')) || 0; sessionStorage.setItem('ax-heal', String(Date.now())); } catch (e) {}
    if (Date.now() - last > 30000) { say('This phone is paired. Opening the app…', false); location.replace('/app'); }
  }).catch(function () {});

  function pairWithToken(token) {
    busy = true; btn.disabled = true; say('Pairing…', false);
    fetch('/api/app/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(function (r) {
      if (r.ok) { say('Paired. Opening the app…', false); location.replace('/app'); return; }
      done();
      say('That QR code is not valid any more. Run agentx app pair on the computer for a new one.', true);
    }).catch(function () {
      done();
      say('Could not reach AgentX. Pairing needs a connection: check this phone is on your tailnet, then try again.', true);
    });
  }

  var scanBox = document.getElementById('scan');
  var video = document.getElementById('scan-video');
  var scanBtn = document.getElementById('scan-btn');
  var stream = null;
  var canvas = document.createElement('canvas');
  var ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  function stopScan() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; video.srcObject = null; scanBox.hidden = true; scanBtn.hidden = false;
  }
  function loadDecoder() {
    if (window.jsQR) return Promise.resolve();
    return new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = '/app/qr.js'; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  function tick() {
    if (!stream) return;
    var w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      var k = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      var img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      var hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (hit && hit.data) { stopScan(); onScan(hit.data); return; }
    }
    requestAnimationFrame(tick);
  }
  function onScan(text) {
    var got = parseScan(text);
    if (!got) { say("That QR code isn't from agentx app pair. Scan the one it shows, or type the code.", true); return; }
    if (got.token) { pairWithToken(got.token); return; }
    input.value = got.code;
    if (form.requestSubmit) form.requestSubmit(); else btn.click();
  }
  scanBtn.addEventListener('click', function () {
    if (busy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say("This browser can't open the camera here. Type the code instead.", true);
      return;
    }
    say('', false);
    loadDecoder().then(function () {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    }).then(function (s) {
      stream = s; video.srcObject = s; scanBox.hidden = false; scanBtn.hidden = true;
      var p = video.play(); if (p && p.catch) p.catch(function () {});
      requestAnimationFrame(tick);
    }).catch(function (e) {
      stopScan();
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      say(denied
        ? 'Camera access is off for AgentX. Allow it in Settings, or type the code instead.'
        : (e && e.name ? 'Could not open the camera. Type the code instead.' : 'Could not load the QR reader. Check the connection, or type the code instead.'), true);
    });
  });
  document.getElementById('scan-stop').addEventListener('click', stopScan);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app' }).catch(function () {});
  }
})();
`
