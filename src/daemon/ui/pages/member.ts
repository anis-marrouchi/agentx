// --- A teammate's work page (/member) (#385, #386) ---
//
// A small installable page, built like the phone app (app.ts): static
// HTML the service worker can keep for offline starts, live data from
// /api/member/* only. Three pages: the locked one (type the code the
// owner sent), the waiting one (the owner has not said yes to this machine
// yet) and the work page itself.
//
// No backticks, backslashes or dollar-brace inside the client scripts:
// they sit in TS template literals.

import { AX_TOKENS_CSS } from "../tokens"
import { injectFns } from "../inject"
import { formatPairInput } from "./app-pair-logic"

const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('ax-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})()</script>`

function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2979FF">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="My work">
<link rel="manifest" href="/member/manifest.webmanifest">
<link rel="icon" type="image/png" href="/member/icon-192.png">
<link rel="apple-touch-icon" href="/member/icon-192.png">
<title>${title}</title>
${THEME_BOOT}
<style>${AX_TOKENS_CSS}${BASE_CSS}</style>`
}

export function renderMemberManifest(): string {
  return JSON.stringify({
    id: "/member",
    name: "My work · AgentX",
    short_name: "My work",
    description: "What you asked the agents for, and where it stands.",
    start_url: "/member",
    scope: "/member",
    display: "standalone",
    background_color: "#2979FF",
    theme_color: "#2979FF",
    icons: [
      { src: "/member/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/member/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/member/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  })
}

/** Network-first for the page, cache-first for the manifest and icons,
 *  never anything under /api/. Only a 200 is kept as the saved page: the
 *  locked (401) and waiting (202) pages are shown live and never saved, so
 *  an offline start shows the last work page, which says it is offline. */
export const MEMBER_SERVICE_WORKER = `
var CACHE = 'agentx-member-v1';
var STATIC = ['/member/manifest.webmanifest', '/member/icon-192.png', '/member/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(STATIC); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;
  if (req.mode === 'navigate' && url.pathname === '/member') {
    e.respondWith(fetch(req).then(function (res) {
      if (res.status === 200) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.put('/member', res.clone()); })); }
      if (res.status === 401) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.delete('/member'); })); }
      return res;
    }).catch(function () {
      return caches.match('/member').then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }
  if (STATIC.indexOf(url.pathname) >= 0) {
    e.respondWith(caches.match(url.pathname).then(function (hit) { return hit || fetch(req); }));
  }
});
`

export function renderMemberPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("My work · AgentX")}<style>${WORK_CSS}</style></head>
<body>
<header class="bar">
  <div><h1>My work</h1><p id="who" class="who">Connecting…</p></div>
  <button type="button" id="theme" class="icon-btn" aria-label="Switch theme">◐</button>
</header>
<p id="offline" class="offline" role="status" hidden>Offline. Showing what was last loaded; live state needs a connection.</p>
<p id="install" class="install" hidden>To keep this window on your desktop: in Edge or Chrome open the browser menu, then <b>Apps</b>, then <b>Install this site as an app</b>.</p>
<main>
  <section aria-labelledby="h-open"><h2 id="h-open">Open <span id="n-open" class="count"></span></h2><ul id="open" class="list"><li class="muted">Loading…</li></ul></section>
  <section aria-labelledby="h-recent"><h2 id="h-recent">Finished in the last 7 days</h2><ul id="recent" class="list"><li class="muted">Loading…</li></ul></section>
  <section aria-labelledby="h-runs"><h2 id="h-runs">Latest turns</h2><ul id="runs" class="list"><li class="muted">Loading…</li></ul></section>
  <p id="updated" class="muted small"></p>
</main>
<script>${injectFns({ workState, ageText })}${WORK_SCRIPT}</script>
</body>
</html>`
}

/** Shown with 401 when /member is opened without a valid key. */
export function renderMemberLockedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Pair this machine · AgentX")}<style>${LOCKED_CSS}</style></head>
<body>
<main class="card">
  <h1>Pair this machine</h1>
  <p>The owner sent you a pairing code. Type it below with a name for this machine. The owner then approves the machine, and your work page opens.</p>
  <form id="pair-form" class="pair-form" novalidate>
    <label for="machine">This machine's name</label>
    <input id="machine" name="machine" type="text" maxlength="60" placeholder="Work laptop" autocomplete="off" required>
    <label for="pair-code">Pairing code</label>
    <input id="pair-code" name="code" type="text" placeholder="XXXX-XXXX" maxlength="9"
      autocomplete="one-time-code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
    <button type="submit" id="pair-btn">Pair</button>
    <p id="pair-offline" class="pair-offline" role="status" hidden>You're offline. Pairing needs a connection to the private network.</p>
    <p id="pair-msg" class="pair-msg" role="status" aria-live="polite"></p>
  </form>
  <p class="muted">No code? Ask the owner to run <code>agentx people invite &lt;you&gt;</code>. A code works once, for 10 minutes.</p>
</main>
<script>${injectFns({ formatPairInput })}${LOCKED_SCRIPT}</script>
</body>
</html>`
}

/** Shown with 202 while the owner has not answered the pairing card. */
export function renderMemberWaitingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Waiting for the owner · AgentX")}</head>
<body>
<main class="card">
  <h1>Waiting for the owner</h1>
  <p id="msg" role="status">This machine is paired. The owner has to approve it once; this page opens by itself when they do.</p>
  <p class="muted">If they said no, this page will ask for a new code.</p>
</main>
<script>${WAITING_SCRIPT}</script>
</body>
</html>`
}

// ── Pure helpers, sent to the browser with injectFns ─────────────────────

/** How a request's state reads on the page. */
export function workState(state: string): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  const s = String(state || "")
  if (s === "in_progress") return { label: "In progress", tone: "ok" }
  if (s === "waiting_owner") return { label: "Waiting on the owner", tone: "warn" }
  if (s === "waiting_other") return { label: "Waiting on another agent", tone: "warn" }
  if (s === "needs_attention") return { label: "Stuck: needs attention", tone: "bad" }
  if (s === "done") return { label: "Done", tone: "ok" }
  if (s === "declined") return { label: "Declined", tone: "bad" }
  if (s === "dropped") return { label: "Dropped", tone: "muted" }
  return { label: s.replace(/_/g, " "), tone: "muted" }
}

/** "3 min", "2 h 10 min", "4 d": how long since `at`. */
export function ageText(at: number, now: number): string {
  const ms = Math.max(0, Number(now) - Number(at))
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return min + " min"
  const h = Math.floor(min / 60)
  if (h < 24) return h + " h " + (min % 60) + " min"
  const d = Math.floor(h / 24)
  return d + " d " + (h % 24) + " h"
}

// ── Styles and scripts ───────────────────────────────────────────────────

const BASE_CSS = `
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); font-family: var(--ax-font); }
body { min-height: 100dvh; -webkit-text-size-adjust: 100%; }
code { font-family: var(--ax-mono); font-size: 0.92em; background: var(--ax-surface-3); padding: 1px 6px; border-radius: 6px; }
.card { max-width: 460px; margin: 0 auto; padding: 40px 24px; line-height: 1.55; }
.card h1 { font-size: 22px; margin: 0 0 12px; }
.muted { color: var(--ax-text-2); }
.small { font-size: var(--ax-fs-xs); }
:focus-visible { outline: 3px solid var(--ax-accent); outline-offset: 2px; }
`

const WORK_CSS = `
body { display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; background: var(--ax-surface); border-bottom: var(--ax-border-w) solid var(--ax-border); }
.bar h1 { font-size: 18px; margin: 0; font-weight: 700; }
.who { margin: 2px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.icon-btn { min-width: 44px; min-height: 44px; font-size: 20px; line-height: 1; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-text); cursor: pointer; }
.offline, .install { margin: 0; padding: 8px 16px; font-size: var(--ax-fs-sm); background: var(--ax-amber-t); color: var(--ax-amber-ink); border-bottom: 1px solid var(--ax-amber-e); }
.install { background: var(--ax-surface-2); color: var(--ax-text-2); border-bottom: var(--ax-border-w) solid var(--ax-border); }
main { flex: 1; overflow-y: auto; padding: 16px; max-width: 720px; width: 100%; box-sizing: border-box; margin: 0 auto; }
main h2 { font-size: 16px; margin: 12px 0 8px; }
.count { color: var(--ax-text-2); font-weight: 400; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item { padding: 10px 12px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface); }
.item .text { margin: 0 0 4px; line-height: 1.4; }
.item .meta { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); display: flex; flex-wrap: wrap; gap: 4px 10px; }
.item .note { margin: 6px 0 0; font-size: var(--ax-fs-sm); }
.state { font-weight: 600; }
.state.ok { color: var(--ax-green-ink, var(--ax-text)); }
.state.warn { color: var(--ax-amber-ink); }
.state.bad { color: var(--ax-red-ink); }
[data-theme="dark"] .state.bad { color: var(--ax-red); }
.state.muted { color: var(--ax-text-2); }
a { color: var(--ax-accent); }
`

const LOCKED_CSS = `
.pair-form { display: grid; gap: 10px; margin: 20px 0 24px; }
.pair-form label { font-weight: 600; }
.pair-form input { box-sizing: border-box; width: 100%; min-height: 48px; padding: 10px 14px; font: inherit; font-size: 17px; color: var(--ax-text); background: var(--ax-surface); border: 2px solid var(--ax-border); border-radius: var(--ax-radius-sm); }
.pair-form input#pair-code { min-height: 60px; font: 600 26px/1.2 var(--ax-mono); letter-spacing: 0.12em; text-align: center; text-transform: uppercase; }
.pair-form input:focus { border-color: var(--ax-accent); outline: none; }
.pair-form button { min-height: 52px; border: 0; border-radius: var(--ax-radius-pill); font: inherit; font-size: 17px; font-weight: 700; color: #fff; background: var(--ax-accent); cursor: pointer; }
.pair-form button:disabled { opacity: 0.55; cursor: default; }
.pair-msg { margin: 0; min-height: 1.5em; }
.pair-msg.bad { color: var(--ax-red-ink); }
[data-theme="dark"] .pair-msg.bad { color: var(--ax-red); }
.pair-offline { margin: 0; padding: 8px 12px; border-radius: var(--ax-radius-sm); font-size: var(--ax-fs-sm); background: var(--ax-amber-t); color: var(--ax-amber-ink); border: 1px solid var(--ax-amber-e); }
`

const LOCKED_SCRIPT = `
(function () {
  var form = document.getElementById('pair-form');
  var machine = document.getElementById('machine');
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
    var f = formatPairInput(input.value, input.selectionStart == null ? input.value.length : input.selectionStart);
    if (f.value !== input.value) {
      input.value = f.value;
      try { if (document.activeElement === input) input.setSelectionRange(f.caret, f.caret); } catch (x) {}
    }
    if (msg.className.indexOf('bad') >= 0) say('', false);
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    var code = input.value.replace(/[^A-Z0-9]/g, '');
    var name = machine.value.replace(/\\s+/g, ' ').trim();
    if (!name) { say('Give this machine a name.', true); machine.focus(); return; }
    if (code.length !== 8) { say('The code has 8 letters and digits.', true); input.focus(); return; }
    busy = true; btn.disabled = true; say('Pairing…', false);
    fetch('/api/member/pair-code', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ code: code, machine: name })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    }).then(function (r) {
      if (r.status === 200) { say('Paired. Waiting for the owner…', false); location.replace('/member'); return; }
      busy = false; btn.disabled = false;
      if (r.status === 429) { say('Too many attempts. Wait ' + Math.ceil((r.body.retryAfter || 300) / 60) + ' minutes, then try again.', true); return; }
      say(r.body.error || 'That code did not work.', true);
    }).catch(function () { busy = false; btn.disabled = false; say('No connection. Check the private network and try again.', true); });
  });
})();
`

const WAITING_SCRIPT = `
(function () {
  var msg = document.getElementById('msg');
  function check() {
    fetch('/api/member/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 200) { location.replace('/member'); return; }
      if (r.status === 401) { msg.textContent = 'The owner did not approve this machine. Ask them for a new code.'; setTimeout(function () { location.replace('/member'); }, 4000); return; }
    }).catch(function () {});
  }
  setInterval(check, 5000);
})();
`

const WORK_SCRIPT = `
(function () {
  var who = document.getElementById('who');
  var offline = document.getElementById('offline');
  var install = document.getElementById('install');
  var updated = document.getElementById('updated');
  var theme = document.getElementById('theme');
  theme.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('ax-theme', cur); } catch (e) {}
  });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/member/sw.js', { scope: '/member' }); } catch (e) {} }
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && /Windows|Macintosh|Linux/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent)) install.hidden = false;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function setOnline(on) { offline.hidden = on; }
  window.addEventListener('online', function () { setOnline(true); load(); });
  window.addEventListener('offline', function () { setOnline(false); });
  function where(r) {
    var label = esc(r.where && r.where.label || r.channel);
    return r.where && r.where.url ? '<a href="' + esc(r.where.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
  }
  function item(r, now, closed) {
    var st = workState(r.state);
    var note = '';
    if (r.state === 'waiting_owner' && r.question) note = '<p class="note"><b>The owner is asked:</b> ' + esc(r.question) + '</p>';
    else if (r.state === 'needs_attention' && r.attentionReason) note = '<p class="note">' + esc(r.attentionReason) + '</p>';
    else if (closed && r.evidence) note = /^https?:\\/\\//i.test(r.evidence)
      ? '<p class="note"><a href="' + esc(r.evidence) + '" target="_blank" rel="noopener noreferrer">What was delivered</a></p>'
      : '<p class="note"><b>What was delivered:</b> ' + esc(r.evidence) + '</p>';
    var age = closed ? 'closed ' + ageText(r.closedAt || r.updatedAt, now) + ' ago' : 'for ' + ageText(r.createdAt, now);
    return '<li class="item"><p class="text">' + esc(r.text) + '</p>' +
      '<p class="meta"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span>' + esc(r.agentId) + '</span><span>' + age + '</span><span>asked on ' + where(r) + '</span></p>' + note + '</li>';
  }
  function run(r, now) {
    var mark = r.status === 'ok' ? 'finished' : r.status === 'in-flight' ? 'running' : esc(r.status);
    return '<li class="item"><p class="text">' + esc(r.messagePreview || '') + '</p><p class="meta"><span class="state ' + (r.status === 'ok' ? 'ok' : r.status === 'in-flight' ? 'warn' : 'bad') + '">' + mark + '</span><span>' + esc(r.agentId) + '</span><span>' + ageText(r.startedAt, now) + ' ago</span><span>' + esc(r.channel || '') + '</span></p></li>';
  }
  function fill(id, html, empty) { document.getElementById(id).innerHTML = html || '<li class="muted">' + empty + '</li>'; }
  function load() {
    fetch('/api/member/work', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401 || r.status === 403) { location.replace('/member'); return null; }
      return r.json();
    }).then(function (w) {
      if (!w) return;
      setOnline(true);
      var now = Date.now();
      document.getElementById('n-open').textContent = w.open.length ? '(' + w.open.length + ')' : '';
      fill('open', w.open.map(function (r) { return item(r, now, false); }).join(''), 'Nothing open. What you ask the agents for shows up here while it is being worked on.');
      fill('recent', w.recent.map(function (r) { return item(r, now, true); }).join(''), 'Nothing finished in the last 7 days.');
      fill('runs', w.runs.map(function (r) { return run(r, now); }).join(''), 'No turns recorded yet.');
      updated.textContent = 'Updated ' + new Date(now).toLocaleTimeString();
    }).catch(function () { setOnline(false); });
  }
  fetch('/api/member/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    if (me) who.textContent = me.name + ' · ' + me.device + (me.node ? ' · ' + me.node : '');
  }).catch(function () {});
  load();
  setInterval(load, 30000);
})();
`
