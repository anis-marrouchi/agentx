// --- Phone app (/app) ---
//
// An installable PWA shell for phones, reached over a private tailnet via
// `tailscale serve`. Deliberately NOT built on renderShell: the desktop
// topbar, mesh selector and assistant drawer don't fit a phone, and the
// shell must render offline, so it loads no web fonts or other pages' JS.
//
// Everything here is static. Nothing device- or fleet-specific is baked into
// the HTML, because the service worker caches it for offline use; live data
// comes from /api/app/*, which is never cached.
//
// Phase 1 of the mobile epic shipped the shell and pairing. Chat is filled
// by app-chat.client.ts, Fleet and Activity by app-fleet.client.ts, Alerts
// by app-alerts.client.ts with its Places card from app-places.client.ts; Chat is voice first (app-voice.client.ts, with
// the orb in app-orb.client.ts); the header's Share camera is
// app-camera.client.ts; a sideways swipe changes tab (app-swipe.client.ts).
// A tab without content yet says so plainly — no simulated data.

import { APP_PHONE_PALETTE_CSS, APP_REDESIGN_CSS } from "./app-redesign.css"
import { APP_SHEET_SCRIPT } from "./app-sheet.client"
import { AX_TOKENS_CSS } from "../tokens"
import { APP_FLEET_SCRIPT } from "./app-fleet.client"
import { APP_FLEET_CSS } from "./app-fleet.css"
import { APP_ALERTS_SCRIPT } from "./app-alerts.client"
import { APP_PLACES_CSS, APP_PLACES_SCRIPT } from "./app-places.client"
import { locationErrorText } from "./app-places-logic"
import { APP_ANNOUNCE_SCRIPT } from "./app-announce.client"
import { APP_CHAT_SCRIPT } from "./app-chat.client"
import { APP_CHAT_VIEW_SCRIPT } from "./app-chat-view.client"
import { APP_CHAT_SHEETS_SCRIPT } from "./app-chat-sheets.client"
import { APP_CHAT_LOG_SCRIPT } from "./app-chat-log.client"
import { APP_CHAT_STRIP_SCRIPT } from "./app-chat-strip.client"
import { APP_CHAT_STRIP_CSS } from "./app-chat-strip.css"
import { nextSpeech, queueSpeech } from "./app-speech-queue"
import { APP_CHAT_CSS } from "./app-chat.css"
import { APP_ORB_SCRIPT } from "./app-orb.client"
import { APP_VOICE_AUDIO_SCRIPT } from "./app-voice-audio.client"
import { APP_VOICE_SCRIPT } from "./app-voice.client"
import { APP_VOICE_CSS } from "./app-voice.css"
import { LOCKED_BODY, LOCKED_CSS, LOCKED_SCRIPT } from "./app-locked.client"
import { injectFns } from "../inject"
import { formatPairInput, mayBounce, parsePairScan } from "./app-pair-logic"
import { SCAN_BODY, SCAN_CSS, SCAN_SCRIPT } from "./app-scan.client"
import { markdownToHtml } from "@/utils/markdown-html"
import { CAMERA_BODY, CAMERA_BUTTON, CAMERA_CSS, CAMERA_SCRIPT } from "./app-camera.client"
import { CAMERA_ASKS_BODY, CAMERA_ASKS_CSS, CAMERA_ASKS_SCRIPT } from "./app-camera-asks.client"
import { cameraConstraints, shareClock, streamLabel, talkRelease } from "./app-camera-logic"
import { APP_SWIPE_CSS, APP_SWIPE_SCRIPT } from "./app-swipe.client"
import { swipeAxis, swipeLanding, swipeMayStart, swipeOffset } from "./app-swipe-logic"

export { APP_SERVICE_WORKER } from "./app-sw"

const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('ax-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();</script>`

function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2979FF">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AgentX">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-192.png">
<title>${title}</title>
${THEME_BOOT}
<style>${AX_TOKENS_CSS}${APP_PHONE_PALETTE_CSS}${BASE_CSS}</style>`
}

const TAB_ICONS: Record<string, string> = {
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z',
  fleet: 'M3 3h18v13H3zM8 21h8M12 16v5',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  alerts: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
}

const TABS = [
  { id: "chat", label: "Chat", soon: "Loading your conversations…" },
  { id: "fleet", label: "Fleet", soon: "Loading your machines…" },
  { id: "activity", label: "Activity", soon: "Loading what your agents are doing…" },
  { id: "alerts", label: "Alerts", soon: "Loading notifications…" },
] as const

export function renderAppPage(): string {
  const tabs = TABS.map((t, i) =>
    `<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}"><span class="tab-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TAB_ICONS[t.id]}"/></svg></span><span>${t.label}</span></button>`,
  ).join("")
  const panels = TABS.map((t, i) =>
    `<section role="tabpanel" id="panel-${t.id}" aria-labelledby="tab-${t.id}" tabindex="0"${i === 0 ? "" : " hidden"}>
      <h2>${t.label}</h2>
      <p class="soon">${t.soon}</p>
    </section>`,
  ).join("")

  return `<!doctype html>
<html lang="en">
<head>${head("AgentX")}<style>${APP_CSS}${APP_FLEET_CSS}${APP_CHAT_CSS}${APP_CHAT_STRIP_CSS}${APP_VOICE_CSS}${CAMERA_CSS}${CAMERA_ASKS_CSS}${APP_SWIPE_CSS}${APP_PLACES_CSS}${APP_REDESIGN_CSS}</style></head>
<body>
<header class="bar">
  <div>
    <h1>AgentX</h1>
    <p id="who" class="who">Connecting…</p>
  </div>
  <div class="bar-btns">${CAMERA_BUTTON}<button type="button" id="theme" class="icon-btn" aria-label="Switch to light theme"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z"/></svg></button></div>
</header>
<p id="offline" class="offline" role="status" hidden>Offline. Showing the saved app; live data needs a connection.</p>
${CAMERA_ASKS_BODY}
<main>${panels}</main>
<nav class="tabs" role="tablist" aria-label="Sections">${tabs}</nav>
${CAMERA_BODY}
<script>${APP_SCRIPT}</script>
<script>${injectFns({ swipeMayStart, swipeAxis, swipeOffset, swipeLanding })}${APP_SWIPE_SCRIPT}</script>
<script>${APP_SHEET_SCRIPT}</script>
<script>${APP_FLEET_SCRIPT}</script>
<script>${APP_ALERTS_SCRIPT}</script>
<script>${injectFns({ locationErrorText })}${APP_PLACES_SCRIPT}</script>
<script>${APP_ANNOUNCE_SCRIPT}</script>
<script>${injectFns({ markdownToHtml })}${APP_CHAT_VIEW_SCRIPT}${APP_CHAT_LOG_SCRIPT}${APP_CHAT_SHEETS_SCRIPT}${APP_CHAT_SCRIPT}</script>
<script>${injectFns({ queueSpeech, nextSpeech })}${APP_ORB_SCRIPT}${APP_VOICE_AUDIO_SCRIPT}${APP_VOICE_SCRIPT}</script>
<script>${APP_CHAT_STRIP_SCRIPT}</script>
<script>${injectFns({ cameraConstraints, shareClock, streamLabel, talkRelease })}${CAMERA_SCRIPT}</script>
<script>${CAMERA_ASKS_SCRIPT}</script>
</body>
</html>`
}

/** Where the QR code lands. The token rides in the URL fragment, which the
 *  browser never sends to the server or to `tailscale serve`, so it can't end
 *  up in an access log; the page trades it for an HttpOnly cookie. */
export function renderAppPairPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Pair · AgentX")}</head>
<body>
<main class="card">
  <h1>Pairing this phone…</h1>
  <p id="msg" role="status">One moment.</p>
</main>
<script>${PAIR_SCRIPT}</script>
</body>
</html>`
}

/** Served with 401 when /app is opened without a valid device token. Holds
 *  the pairing-code form, which is how an installed app pairs itself. */
export function renderAppLockedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Not paired · AgentX")}<style>${LOCKED_CSS}${SCAN_CSS}</style></head>
<body>${LOCKED_BODY}${SCAN_BODY}
<script>${injectFns({ mayBounce, formatPairInput, parsePairScan })}</script>
<script>${LOCKED_SCRIPT}</script>
<script>${SCAN_SCRIPT}</script>
</body>
</html>`
}

export function renderAppManifest(): string {
  return JSON.stringify({
    id: "/app",
    name: "AgentX",
    short_name: "AgentX",
    description: "Talk to your agents and watch your fleet.",
    start_url: "/app",
    scope: "/app",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#2979FF",
    icons: [
      { src: "/app/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  })
}

const APP_SCRIPT = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
  function select(tab, focus, keepHash) {
    document.querySelector('.tabs').style.setProperty('--tab-position', String(tabs.indexOf(tab)));
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    document.dispatchEvent(new CustomEvent('ax-tab'));
    if (focus) tab.focus();
    if (keepHash) return;
    try { history.replaceState(null, '', '#' + tab.dataset.tab); } catch (e) {}
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t, false); });
    t.addEventListener('keydown', function (ev) {
      var next = null;
      if (ev.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (ev.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (ev.key === 'Home') next = tabs[0];
      else if (ev.key === 'End') next = tabs[tabs.length - 1];
      if (next) { ev.preventDefault(); select(next, true); }
    });
  });
  // #chat=<id> (a notification's link) opens Chat; the Chat script reads
  // the id, so the hash is left as it is.
  function fromHash() {
    var name = location.hash.split('=')[0];
    var t = tabs.filter(function (t) { return '#' + t.dataset.tab === name; })[0];
    if (t) select(t, false, true);
  }
  fromHash();
  window.addEventListener('hashchange', fromHash);

  var root = document.documentElement;
  var themeBtn = document.getElementById('theme');
  function paintTheme() {
    var dark = root.getAttribute('data-theme') === 'dark';
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  themeBtn.addEventListener('click', function () {
    var t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('ax-theme', t); } catch (e) {}
    paintTheme();
  });
  paintTheme();

  var offline = document.getElementById('offline');
  var who = document.getElementById('who');
  function setOnline(on) { offline.hidden = on; }
  window.addEventListener('online', function () { setOnline(true); loadMe(); });
  window.addEventListener('offline', function () { setOnline(false); });
  function loadMe() {
    fetch('/api/app/me', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.ok ? r.json() : null;
    }).then(function (me) {
      if (!me) return;
      setOnline(true);
      who.textContent = me.device + (me.node ? ' · ' + me.node : '');
    }).catch(function () { setOnline(false); who.textContent = 'Offline'; });
  }
  loadMe();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app' }).catch(function () {});
  }
})();
`

const PAIR_SCRIPT = `
(function () {
  var msg = document.getElementById('msg');
  var m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  if (!m) { msg.textContent = 'This link has no pairing key. Run agentx app pair again and scan the new QR code.'; return; }
  fetch('/api/app/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Authorization': 'Bearer ' + decodeURIComponent(m[1]) },
  }).then(function (r) {
    if (r.ok) { location.replace('/app'); return; }
    msg.textContent = r.status === 401
      ? 'This pairing link is not valid any more. Run agentx app pair again and scan the new QR code.'
      : 'Pairing failed (HTTP ' + r.status + '). Try again.';
  }).catch(function () { msg.textContent = 'Could not reach AgentX. Check this phone is on your tailnet, then try again.'; });
})();
`

const BASE_CSS = `
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); font-family: var(--ax-font); }
body { min-height: 100dvh; -webkit-text-size-adjust: 100%; }
code { font-family: var(--ax-mono); font-size: 0.92em; background: var(--ax-surface-3); padding: 1px 6px; border-radius: 6px; }
.card {
  max-width: 460px; margin: 0 auto;
  padding: calc(40px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
  line-height: 1.55;
}
.card h1 { font-size: 22px; margin: 0 0 12px; }
.muted { color: var(--ax-text-2); }
:focus-visible { outline: 3px solid var(--ax-accent); outline-offset: 2px; }
`

const APP_CSS = `
body { display: flex; flex-direction: column; }
.bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
  background: var(--ax-surface); border-bottom: var(--ax-border-w) solid var(--ax-border);
}
.bar h1 { font-size: 18px; margin: 0; font-weight: 700; }
.bar-btns { display: flex; gap: 8px; }
.who { margin: 2px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.icon-btn {
  min-width: 44px; min-height: 44px; font-size: 20px; line-height: 1;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-pill);
  background: var(--ax-surface-2); color: var(--ax-text); cursor: pointer;
}
.offline {
  margin: 0; padding: 8px 16px; font-size: var(--ax-fs-sm);
  background: var(--ax-amber-t); color: var(--ax-amber-ink); border-bottom: 1px solid var(--ax-amber-e);
}
main {
  flex: 1; overflow-y: auto;
  padding: 16px calc(16px + env(safe-area-inset-right)) 16px calc(16px + env(safe-area-inset-left));
}
main h2 { font-size: 20px; margin: 4px 0 8px; }
.soon { color: var(--ax-text-2); line-height: 1.55; margin: 0; }
.tabs {
  display: grid; grid-template-columns: repeat(4, 1fr);
  position: sticky; bottom: 0;
  padding: 6px calc(6px + env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) calc(6px + env(safe-area-inset-left));
  background: var(--ax-surface); border-top: var(--ax-border-w) solid var(--ax-border);
}
.tabs [role=tab] {
  min-height: 48px; border: 0; border-radius: var(--ax-radius-sm);
  background: transparent; color: var(--ax-text-2);
  font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; cursor: pointer;
}
.tabs [role=tab][aria-selected=true] { background: var(--ax-accent-t); color: var(--ax-accent-2); }
[data-theme="dark"] .tabs [role=tab][aria-selected=true] { color: var(--ax-text); }
`
