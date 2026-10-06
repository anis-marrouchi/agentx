// --- A teammate's work page (/member) (#385, #386) ---
//
// A small installable page, built like the phone app (app.ts): static
// HTML the service worker can keep for offline starts, live data from
// /api/member/* only. Three pages: the locked one (type the code the
// owner sent), the waiting one (the owner has not said yes to this machine
// yet) and the work page itself. The look is the concept the owner
// approved on #443. A client's machine gets the locked and waiting pages
// too, then "Your project" (client.ts) instead of the work page (#453).
//
// No backticks, backslashes or dollar-brace inside the client scripts:
// they sit in TS template literals.

import { AX_TOKENS_CSS } from "../tokens"
import { injectFns } from "../inject"
import { formatPairInput } from "./app-pair-logic"
import { agentLine, connectionNote, freedAgents, plainPreview, requestState, sentState, summaryLine } from "./member-logic"
import { WORK_SCRIPT } from "./member-work.client"
import { BASE_CSS, LOCKED_CSS, WAITING_CSS, WORK_CSS } from "./member-styles"

const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('ax-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})()</script>`

/** The <head> every page under /member shares. A client's page names its
 *  own manifest and app title (client.ts). */
export function memberHead(title: string, opts: { manifest?: string; appTitle?: string } = {}): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2979FF">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${opts.appTitle ?? "My work"}">
<link rel="manifest" href="${opts.manifest ?? "/member/manifest.webmanifest"}">
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
    background_color: "#FFFFFF",
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

/** The top bar every member page shares. */
export function memberBar(who: string, extra = "", heading = "My work"): string {
  return `<header class="bar">
  <img class="mark" src="/member/icon-192.png" alt="" width="36" height="36">
  <div class="grow"><h1>${heading}</h1><p id="who" class="who">${who}</p></div>${extra}
</header>`
}
const head = memberHead
const bar = memberBar

/** The three steps from a code to the work page. */
function pairSteps(at: 0 | 1): string {
  const names = ["Type the code", "The owner says yes", "Your work opens"]
  return `<ol class="steps" role="list" aria-label="Steps">${names.map((n, i) =>
    i < at ? `<li class="done"><span class="sr">Done: </span>${n}</li>` : i === at ? `<li class="now" aria-current="step">${n}</li>` : `<li>${n}</li>`,
  ).join("")}</ol>`
}

export function renderMemberPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("My work · AgentX")}<style>${WORK_CSS}</style></head>
<body>
${bar("Connecting…", `
  <button type="button" id="theme" class="icon-btn" aria-label="Switch theme">◐</button>`)}
<p id="offline" class="strip" role="status" hidden><span id="offline-text"></span><button type="button" id="retry" hidden>Try now</button></p>
<aside id="install" class="install" aria-label="Keep this window" hidden>To keep this window on your desktop: in Edge or Chrome open the browser menu, then <b>Apps</b>, then <b>Install this site as an app</b>.</aside>
<main class="wrap">
  <p id="sum" class="sum" aria-live="polite">Loading…</p>
  <section id="need" class="need" aria-labelledby="h-need" hidden><h2 id="h-need" tabindex="-1">Needs a person</h2><ul id="need-list" role="list"></ul></section>
  <section id="agents-box" aria-labelledby="h-agents" hidden><h2 id="h-agents" tabindex="-1">Your agents</h2><ul id="agents" class="agents" role="list"></ul><button type="button" id="notify" class="notify" hidden>Tell me when an agent is free</button></section>
  <section aria-labelledby="h-sent"><h2 id="h-sent" tabindex="-1">What you sent <span class="n">(last 7 days)</span></h2><ul id="sent" class="rows" role="list"></ul></section>
  <p id="updated" class="foot"></p>
</main>
<script>${injectFns({ workState, ageText, connectionNote, plainPreview, agentLine, sentState, requestState, summaryLine, freedAgents })}${WORK_SCRIPT}</script>
</body>
</html>`
}

/** Shown with 401 when /member is opened without a valid key. */
export function renderMemberLockedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Pair this machine · AgentX")}<style>${LOCKED_CSS}</style></head>
<body>
${bar("This machine is not paired yet")}
<main class="narrow">
  ${pairSteps(0)}
  <div class="card">
    <h2>Pair this machine</h2>
    <p>The owner sent you a pairing code. Type it with a name for this machine. The owner then approves the machine, and your work page opens.</p>
    <form id="pair-form" class="pair-form" novalidate>
      <label for="machine">This machine's name</label>
      <input id="machine" name="machine" type="text" maxlength="60" placeholder="Work laptop" autocomplete="off" required>
      <label for="pair-code">Pairing code</label>
      <input id="pair-code" name="code" type="text" placeholder="XXXX-XXXX" maxlength="9"
        autocomplete="one-time-code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
      <button type="submit" id="pair-btn">Pair this machine</button>
      <p id="pair-offline" class="pair-offline" role="status" hidden>You're offline. Pairing needs a connection to the private network.</p>
      <p id="pair-msg" class="pair-msg" role="status" aria-live="polite"></p>
    </form>
    <p class="help">No code? Ask the person who invited you for one. A code works once, for 10 minutes.</p>
  </div>
</main>
<script>${injectFns({ formatPairInput })}${LOCKED_SCRIPT}</script>
</body>
</html>`
}

/** Shown with 202 while the owner has not answered the pairing card. */
export function renderMemberWaitingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Waiting for the owner · AgentX")}<style>${WAITING_CSS}</style></head>
<body>
${bar("This machine is paired")}
<main class="narrow">
  ${pairSteps(1)}
  <div class="card">
    <h2><span class="pulse" aria-hidden="true"></span>Waiting for the owner</h2>
    <p id="msg" role="status">This machine is paired. The owner has to approve it once; this page opens your work by itself when they do.</p>
    <p class="help">If they say no, this page asks for a new code.</p>
  </div>
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

/** "3 min ago", "2 h 10 min ago", "4 d 1 h ago", or "just now": how long
 *  since `at`. The word "ago" is part of it, so a fresh row never reads
 *  "just now ago". */
export function ageText(at: number, now: number): string {
  const ms = Math.max(0, Number(now) - Number(at))
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return min + " min ago"
  const h = Math.floor(min / 60)
  if (h < 24) return h + " h " + (min % 60) + " min ago"
  const d = Math.floor(h / 24)
  return d + " d " + (h % 24) + " h ago"
}

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

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
      if (r.status === 401) { msg.textContent = 'The owner did not approve this machine. Ask the person who invited you for a new code.'; setTimeout(function () { location.replace('/member'); }, 4000); return; }
    }).catch(function () {});
  }
  setInterval(check, 5000);
})();
`
