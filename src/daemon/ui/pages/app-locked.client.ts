// --- "This phone isn't paired" page: pair with a one-time code ---
//
// A home-screen app on iOS has its own storage, so the cookie the QR link
// set in Safari never reaches it. Typing the code from `agentx app pair`
// here sets the cookie inside the app itself (POST /api/app/pair-code).
//
// The service worker keeps a copy of this page for offline starts, so the
// script says plainly when there is no connection instead of failing.
// No backslashes, backticks or dollar-brace in the script: it sits inside a
// TS template literal.

export const LOCKED_BODY = `
<main class="card">
  <h1>This phone isn't paired</h1>
  <p>On the computer running AgentX, open a terminal in the folder that holds <code>agentx.json</code> and run <code>agentx app pair</code>. Type the code it shows here.</p>
  <form id="pair-form" class="pair-form" novalidate>
    <label for="pair-code">Pairing code</label>
    <input id="pair-code" name="code" type="text" placeholder="XXXX-XXXX" maxlength="16"
      autocomplete="one-time-code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
    <button type="submit" id="pair-btn">Pair</button>
    <p id="pair-offline" class="pair-offline" role="status" hidden>You're offline. Pairing needs a connection: turn on Wi-Fi or mobile data and Tailscale, then try again.</p>
    <p id="pair-msg" class="pair-msg" role="status" aria-live="polite"></p>
  </form>
  <p class="muted">Or scan the QR code it shows with this phone's camera. That pairs the browser; an app added to the home screen needs the code.</p>
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
.pair-msg { margin: 0; min-height: 1.5em; }
.pair-msg.bad { color: var(--ax-red-ink); }
[data-theme="dark"] .pair-msg.bad { color: var(--ax-red); }
.pair-offline {
  margin: 0; padding: 8px 12px; border-radius: var(--ax-radius-sm); font-size: var(--ax-fs-sm);
  background: var(--ax-amber-t); color: var(--ax-amber-ink); border: 1px solid var(--ax-amber-e);
}
`

export const LOCKED_SCRIPT = `
(function () {
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
  input.addEventListener('input', function () { if (msg.className.indexOf('bad') >= 0) say('', false); });
  function done() { busy = false; setOnline(navigator.onLine !== false); }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    var code = input.value.trim();
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app' }).catch(function () {});
  }
})();
`
