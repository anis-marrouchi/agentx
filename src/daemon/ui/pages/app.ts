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
// The bottom tabs are Agents · Chat · Desk · Alerts · More (#2101 C1a);
// Agents is app-agents.client.ts, and Fleet and Activity open from More.
//
// Phase 1 of the mobile epic shipped the shell and pairing. Chat is filled
// by app-chat.client.ts, Fleet and Activity by app-fleet.client.ts, Desk by
// app-desk.client.ts, Alerts
// by app-alerts.client.ts with its Places card from app-places.client.ts
// and its Pinned pages card from app-pins.client.ts (which also fills the
// row of pinned buttons under the header); Chat is voice first (app-voice.client.ts, with
// the orb in app-orb.client.ts); the header's Share camera is
// app-camera.client.ts; a sideways swipe changes tab (app-swipe.client.ts).
// A tab without content yet says so plainly — no simulated data.

import { APP_REDESIGN_CSS } from "./app-redesign.css"
import { APP_SHEET_SCRIPT } from "./app-sheet.client"
import { AX_THEME_BOOT, AX_TOKENS_CSS } from "../tokens"
import { AX_AFFECT_CSS, afLoaderHtml } from "../affect.css"
import { APP_FLEET_SCRIPT } from "./app-fleet.client"
import { APP_FLEET_CSS } from "./app-fleet.css"
import { APP_LIVE_CSS, APP_LIVE_SCRIPT } from "./app-live.client"
import { liveLabel, liveReduce, liveSseFrames } from "./app-live-logic"
import { APP_DESK_SCRIPT } from "./app-desk.client"
import { APP_DESK_CSS } from "./app-desk.css"
import { APP_ALERTS_SCRIPT } from "./app-alerts.client"
import { APP_PLACES_CSS, APP_PLACES_SCRIPT } from "./app-places.client"
import { locationErrorText } from "./app-places-logic"
import { APP_PINS_BAR, APP_PINS_CSS, APP_PINS_SCRIPT } from "./app-pins.client"
import { APP_ANNOUNCE_SCRIPT } from "./app-announce.client"
import { APP_CHAT_SCRIPT } from "./app-chat.client"
import { APP_CHAT_VIEW_SCRIPT } from "./app-chat-view.client"
import { APP_CHAT_SHEETS_SCRIPT } from "./app-chat-sheets.client"
import { APP_CHAT_LOG_SCRIPT } from "./app-chat-log.client"
import { APP_CHAT_STRIP_SCRIPT } from "./app-chat-strip.client"
import { APP_CHAT_STRIP_CSS } from "./app-chat-strip.css"
import { APP_CHAT_HEAD_CSS, APP_CHAT_HEAD_SCRIPT } from "./app-chat-head.client"
import { appPlanHtml, appProofsHtml } from "./app-chat-plan"
import { chEngine, chFace } from "./wall-chat-head.client"
import { APP_CHANGES_CSS, APP_CHANGES_SCRIPT } from "./app-changes.client"
import { APP_AGENTS_CSS, APP_AGENTS_SCRIPT } from "./app-agents.client"
import { haGroups, haListHtml, haRowHref, haRowHtml, haRunsHtml, haStateIcon, haStateWord } from "./hub-agents"
import { HUB_NAV_CSS, HUB_NAV_ICON_NAMES } from "./hub-nav"
import { hubIconMap } from "./hub-lucide"
import { nextSpeech, queueSpeech } from "./app-speech-queue"
import { APP_CHAT_CSS } from "./app-chat.css"
import { APP_ORB_SCRIPT } from "./app-orb.client"
import { APP_VOICE_AUDIO_SCRIPT } from "./app-voice-audio.client"
import { APP_VOICE_SCRIPT } from "./app-voice.client"
import { APP_VOICE_CSS } from "./app-voice.css"
import { APP_DICTATE_CSS, APP_DICTATE_SCRIPT } from "./app-dictate.client"
import { dictateLabel, parseOpenHash } from "./app-voice-reply-logic"
import { LOCKED_BODY, LOCKED_SCRIPT } from "./app-locked.client"
import { PAIR_CSS, PHONE_BASE_CSS } from "./phone-base.css"
import { icon, type IconName } from "../icons"
import { injectFns } from "../inject"
import { formatPairInput, mayBounce, parsePairScan } from "./app-pair-logic"
import { SCAN_BODY, SCAN_CSS, SCAN_SCRIPT } from "./app-scan.client"
import { markdownToHtml } from "@/utils/markdown-html"
import { CAMERA_BODY, CAMERA_BUTTON, CAMERA_CSS, CAMERA_SCRIPT } from "./app-camera.client"
import { CAMERA_ASKS_BODY, CAMERA_ASKS_CSS, CAMERA_ASKS_SCRIPT } from "./app-camera-asks.client"
import { CALLS_BODY, CALLS_CSS, CALLS_SCRIPT } from "./app-calls.client"
import { cameraConstraints, shareClock, streamLabel, talkRelease } from "./app-camera-logic"
import { APP_SWIPE_CSS, APP_SWIPE_SCRIPT } from "./app-swipe.client"
import { swipeAxis, swipeLanding, swipeMayStart, swipeOffset } from "./app-swipe-logic"

export { APP_SERVICE_WORKER } from "./app-sw"

const THEME_BOOT = AX_THEME_BOOT

function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AgentX">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-192.png">
<title>${title}</title>
${THEME_BOOT}
<style>${AX_TOKENS_CSS}${AX_AFFECT_CSS}${BASE_CSS}</style>`
}

// lucide, the same icon for the same meaning as the Hub's side menu
// (hub-nav.ts HUB_PAGE_ICON: agents "bot", Desk "inbox").
const TAB_ICONS: Record<string, IconName> = {
  agents: "bot",
  more: "ellipsis",
  chat: "message-square",
  fleet: "monitor",
  activity: "activity",
  alerts: "bell",
  desk: "inbox",
}

// The bottom tabs (#2101 C1a): Agents · Chat · Desk · Alerts · More.
const TABS = [
  { id: "agents", label: "Agents", soon: "Loading your agents…" },
  { id: "chat", label: "Chat", soon: "Loading your conversations…" },
  { id: "desk", label: "Desk", soon: "Loading what waits for you…" },
  { id: "alerts", label: "Alerts", soon: "Loading notifications…" },
  { id: "more", label: "More", soon: "" },
] as const

/** Pages opened from More: their panels belong to the More tab (#fleet, #activity). */
const MORE_PAGES = [
  { id: "fleet", label: "Fleet", soon: "Loading your machines…", hint: "Your machines, their health and updates" },
  { id: "activity", label: "Activity", soon: "Loading what your agents are doing…", hint: "Runs going now and what waits for approval" },
] as const

export function renderAppPage(): string {
  const tabs = TABS.map((t, i) =>
    `<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}"><span class="tab-icon">${icon(TAB_ICONS[t.id])}</span><span>${t.label}</span></button>`,
  ).join("")
  const more = `<ul class="more-list">${MORE_PAGES.map((p) =>
    `<li><a href="#${p.id}" data-more="${p.id}"><span class="tab-icon">${icon(TAB_ICONS[p.id])}</span><span><b>${p.label}</b><small>${p.hint}</small></span></a></li>`).join("")}</ul>`
  const panels = TABS.map((t, i) =>
    `<section role="tabpanel" id="panel-${t.id}" aria-labelledby="tab-${t.id}" tabindex="0"${i === 0 ? "" : " hidden"}>
      <h2>${t.label}</h2>
      ${t.id === "more" ? more : afLoaderHtml(t.soon)}
    </section>`,
  ).join("") + MORE_PAGES.map((p) =>
    `<section role="tabpanel" id="panel-${p.id}" aria-labelledby="tab-more" tabindex="0" data-more-page hidden>
      <a class="more-back" href="#more">${icon("chevron-left")}More</a>
      <h2>${p.label}</h2>
      ${afLoaderHtml(p.soon)}
    </section>`,
  ).join("")

  return `<!doctype html>
<html lang="en">
<head>${head("AgentX")}<style>${APP_CSS}${APP_FLEET_CSS}${APP_LIVE_CSS}${APP_DESK_CSS}${APP_CHAT_CSS}${APP_CHAT_STRIP_CSS}${APP_VOICE_CSS}${CAMERA_CSS}${CAMERA_ASKS_CSS}${CALLS_CSS}${APP_SWIPE_CSS}${APP_PLACES_CSS}${APP_REDESIGN_CSS}${APP_PINS_CSS}${APP_DICTATE_CSS}${APP_CHAT_HEAD_CSS}${APP_CHANGES_CSS}${HUB_NAV_CSS}${APP_AGENTS_CSS}</style></head>
<body>
<header class="bar">
  <div>
    <h1>AgentX</h1>
    <p id="who" class="who">Connecting…</p>
  </div>
  <div class="bar-btns">${CAMERA_BUTTON}<button type="button" id="theme" class="icon-btn" aria-label="Switch to light theme">${icon("moon", 20, "th-moon")}${icon("sun", 20, "th-sun")}</button></div>
</header>
${APP_PINS_BAR}
<p id="offline" class="offline" role="status" hidden>Offline. Showing the saved app; live data needs a connection.</p>
${CALLS_BODY}
${CAMERA_ASKS_BODY}
<main>${panels}</main>
<nav class="tabs" role="tablist" aria-label="Sections">${tabs}</nav>
${CAMERA_BODY}
<script>${APP_SCRIPT}</script>
<script>${injectFns({ swipeMayStart, swipeAxis, swipeOffset, swipeLanding })}${APP_SWIPE_SCRIPT}</script>
<script>${APP_SHEET_SCRIPT}</script>
<script>${APP_FLEET_SCRIPT}</script>
<script>${injectFns({ liveSseFrames, liveReduce, liveLabel })}${APP_LIVE_SCRIPT}</script>
<script>${injectFns({ parseOpenHash })}${APP_DESK_SCRIPT}</script>
<script>${APP_ALERTS_SCRIPT}</script>
<script>${injectFns({ locationErrorText })}${APP_PLACES_SCRIPT}</script>
<script>${APP_PINS_SCRIPT}</script>
<script>${APP_ANNOUNCE_SCRIPT}</script>
<script>${injectFns({ markdownToHtml })}${APP_CHAT_VIEW_SCRIPT}${APP_CHAT_LOG_SCRIPT}${APP_CHAT_SHEETS_SCRIPT}${APP_CHAT_SCRIPT}</script>
<script>${injectFns({ queueSpeech, nextSpeech })}${APP_ORB_SCRIPT}${APP_VOICE_AUDIO_SCRIPT}${APP_VOICE_SCRIPT}</script>
<script>${injectFns({ dictateLabel })}${APP_DICTATE_SCRIPT}</script>
<script>${APP_CHAT_STRIP_SCRIPT}</script>
<script>${injectFns({ chFace, chEngine, appPlanHtml, appProofsHtml })}${APP_CHANGES_SCRIPT}${APP_CHAT_HEAD_SCRIPT}</script>
<script>var HA_IC = ${JSON.stringify(hubIconMap(HUB_NAV_ICON_NAMES))};${injectFns({ haStateIcon, haStateWord, haRowHref, haGroups, haRunsHtml, haRowHtml, haListHtml })}${APP_AGENTS_SCRIPT}</script>
<script>${injectFns({ cameraConstraints, shareClock, streamLabel, talkRelease })}${CAMERA_SCRIPT}</script>
<script>${CAMERA_ASKS_SCRIPT}</script>
<script>${CALLS_SCRIPT}</script>
</body>
</html>`
}

/** Where the QR code lands. The token rides in the URL fragment, which the
 *  browser never sends to the server or to `tailscale serve`, so it can't end
 *  up in an access log; the page trades it for an HttpOnly cookie. */
export function renderAppPairPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${head("Pair · AgentX")}<style>${PAIR_CSS}</style></head>
<body>
<main class="card">
  <h1>Pairing this phone…</h1>
  <p id="msg" role="status">One moment.</p>
  <form id="retry" class="pair-form" hidden><button type="submit">Try again</button></form>
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
<head>${head("Not paired · AgentX")}<style>${PAIR_CSS}${SCAN_CSS}</style></head>
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
    // The shared palette's ground (#2101). The Android app's own splash and
    // toolbar colour stay in its APK (apps/android res/values/colors.xml).
    background_color: "#FFFFFF",
    theme_color: "#FFFFFF",
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
  var panels = Array.prototype.slice.call(document.querySelectorAll('[role=tabpanel]'));
  // page: a panel opened from More (#fleet, #activity), shown under the More tab.
  function select(tab, focus, keepHash, page) {
    document.querySelector('.tabs').style.setProperty('--tab-position', String(tabs.indexOf(tab)));
    var show = page || tab.getAttribute('aria-controls');
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (p) { p.hidden = p.id !== show; });
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
    if (t) { select(t, false, true); return; }
    var page = name && document.getElementById('panel-' + name.slice(1));
    if (page && page.hasAttribute('data-more-page')) select(document.getElementById('tab-more'), false, true, page.id);
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
  // The key left the address bar above, so Try again re-sends the one kept here.
  var key = decodeURIComponent(m[1]);
  var retry = document.getElementById('retry');
  function pair() {
    retry.hidden = true;
    msg.textContent = 'One moment.';
    fetch('/api/app/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Authorization': 'Bearer ' + key },
    }).then(function (r) {
      if (r.ok) { location.replace('/app'); return; }
      if (r.status === 401) { msg.textContent = 'This pairing link is not valid any more. Run agentx app pair again and scan the new QR code.'; return; }
      msg.textContent = 'Pairing failed (HTTP ' + r.status + ').';
      retry.hidden = false;
    }).catch(function () {
      msg.textContent = 'Could not reach AgentX. Check this phone is on your tailnet.';
      retry.hidden = false;
    });
  }
  retry.addEventListener('submit', function (ev) { ev.preventDefault(); pair(); });
  pair();
})();
`

// The one phone set (phone-base.css.ts), plus the column of the pair and
// "not paired" pages.
const BASE_CSS = PHONE_BASE_CSS + `
.card {
  max-width: 460px; margin: 0 auto;
  padding: calc(40px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
  line-height: 1.55;
}
.card h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
`

const APP_CSS = `
body { display: flex; flex-direction: column; }
.bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
  background: var(--ax-surface); border-bottom: var(--ax-border-w) solid var(--ax-border);
}
.bar h1 { margin: 0; }
[data-theme="dark"] .th-moon, :root:not([data-theme="dark"]) .th-sun { display: none; }
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
  display: grid; grid-template-columns: repeat(5, 1fr);
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
.more-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.more-list a { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 6px 8px; border-radius: var(--ax-radius-sm); color: var(--ax-text); text-decoration: none; }
.more-list a:active { background: var(--ax-surface-2); }
.more-list b { display: block; font-size: 15px; }
.more-list small { display: block; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.more-list .tab-icon svg { width: 22px; height: 22px; stroke-width: 1.8; }
.more-back { display: inline-flex; align-items: center; gap: 2px; min-height: 44px; margin-left: -4px; color: var(--ax-accent-2); text-decoration: none; font-weight: 600; }
[data-theme="dark"] .tabs [role=tab][aria-selected=true] { color: var(--ax-text); }
`
