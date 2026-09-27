// --- Phone app: Alerts tab ---
//
// Vanilla browser JS inlined into /app (app.ts). Turns notifications on or
// off for this phone (the browser's Push API, then /api/app/push/*) and
// lists recent pushes from /api/app/alerts. Reuses the fx-* styles from
// app-fleet.css.ts.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_ALERTS_SCRIPT = `
(function () {
  var panel = document.getElementById('panel-alerts');
  if (!panel) return;
  panel.innerHTML = '<h2>Alerts</h2>' +
    '<div class="fx-card"><div class="fx-row"><h3>Notifications on this phone</h3><span id="al-pill" class="fx-pill"></span></div>' +
    '<p id="al-text" class="fx-muted">Checking…</p>' +
    '<div class="fx-row fx-gap"><button type="button" id="al-btn" class="fx-btn fx-primary" hidden></button></div>' +
    '<p id="al-error" class="fx-error fx-bad" role="alert"></p></div>' +
    '<h3 class="fx-sub">Recent</h3><ul id="al-list" class="fx-list"></ul>';
  var pill = document.getElementById('al-pill');
  var text = document.getElementById('al-text');
  var btn = document.getElementById('al-btn');
  var err = document.getElementById('al-error');
  var list = document.getElementById('al-list');
  var server = null;
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('not paired'); }
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }
  // The VAPID key arrives base64url-encoded; the Push API wants bytes.
  function keyBytes(b64) {
    var s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  // The key this phone subscribed with. When the computer's keys are
  // replaced, the old subscription can never be delivered to, so it is
  // dropped and the card offers Turn on again.
  function savedKey() { try { return localStorage.getItem('ax-push-key'); } catch (e) { return null; } }
  function saveKey(k) { try { if (k) localStorage.setItem('ax-push-key', k); else localStorage.removeItem('ax-push-key'); } catch (e) {} }
  function register(sub) {
    var body = sub.toJSON();
    body.publicKey = server.publicKey;
    return api('POST', '/api/app/push/subscribe', body).then(function () { saveKey(server.publicKey); });
  }
  function currentSub() {
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); });
  }
  function show(state, message, action) {
    pill.textContent = state === 'on' ? 'On' : state === 'off' ? 'Off' : 'Unavailable';
    pill.className = 'fx-pill ' + (state === 'on' ? 'fx-on' : state === 'off' ? 'fx-warn' : 'fx-off');
    text.textContent = message;
    btn.hidden = !action;
    if (action) { btn.textContent = action; btn.className = 'fx-btn ' + (action === 'Turn off' ? 'fx-danger-o' : 'fx-primary'); }
  }

  function refresh() {
    err.textContent = '';
    if (!supported()) {
      show('na', 'This browser can’t receive notifications here. On an iPhone, add the app to the Home Screen first (Share, then Add to Home Screen), then open it from there.');
      return Promise.resolve();
    }
    return api('GET', '/api/app/push').then(function (s) {
      server = s;
      if (!s.available) { show('na', s.reason || 'Notifications are not set up on this computer.'); return; }
      if (Notification.permission === 'denied') {
        show('na', 'Notifications are blocked for this app. Allow them in the phone’s settings for this app, then come back.');
        return;
      }
      return currentSub().then(function (sub) {
        var offer = function () { show('off', 'Turn on to get a notification when an agent needs you.', 'Turn on'); };
        if (!sub) { offer(); return; }
        if (savedKey() !== s.publicKey) {
          // Made with keys this computer no longer has: it can't be used.
          saveKey(null);
          return sub.unsubscribe().then(offer, offer);
        }
        // The computer may have lost it (the phone was re-paired): send it again.
        var sync = s.subscriptions > 0 ? Promise.resolve() : register(sub);
        return sync.then(function () { show('on', 'This phone gets a notification when an agent needs you.', 'Turn off'); });
      });
    }).catch(function (e) { show('na', 'Could not check notifications: ' + e.message); });
  }

  function turnOn() {
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('Notifications were not allowed.');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      // A subscription made with older keys can't be reused; replace it.
      return reg.pushManager.getSubscription().then(function (old) {
        return old ? old.unsubscribe() : null;
      }).then(function () {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(server.publicKey) });
      });
    }).then(register);
  }
  function turnOff() {
    return currentSub().then(function (sub) {
      if (!sub) return null;
      var endpoint = sub.endpoint;
      saveKey(null);
      return sub.unsubscribe().then(function () { return api('POST', '/api/app/push/unsubscribe', { endpoint: endpoint }); });
    });
  }
  btn.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    err.textContent = '';
    (btn.textContent === 'Turn off' ? turnOff() : turnOn())
      .catch(function (e) { err.textContent = e.message; })
      .then(refresh)
      .then(function () { busy = false; btn.disabled = false; });
  });

  function loadRecent() {
    return api('GET', '/api/app/alerts').then(function (b) {
      var items = b.items || [];
      if (!items.length) { list.innerHTML = '<li class="fx-muted">No notifications yet.</li>'; return; }
      list.innerHTML = items.map(function (it) {
        // Only web links: a button URL comes from an agent's message.
        var link = /^https?:/i.test(it.url || '')
          ? ' <a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">Open</a>' : '';
        return '<li><div class="fx-row"><strong>' + esc(it.title) + '</strong><span class="fx-muted">' + esc(ago(it.at)) + '</span></div>' +
          '<p>' + esc(it.body) + link + '</p></li>';
      }).join('');
    }).catch(function (e) { list.innerHTML = '<li class="fx-bad">Could not load notifications: ' + esc(e.message) + '</li>'; });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'agentx-push') loadRecent();
      if (d.type === 'agentx-open' && d.url) location.href = d.url;
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadRecent(); });
  refresh();
  loadRecent();
})();
`
