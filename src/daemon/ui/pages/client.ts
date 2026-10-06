// --- A client's page, "Your project" (/member for a person in the client role) (#453) ---
//
// The owner decided that a client gets a page of their own, not the
// teammate's "My work" as it is. Same door as a teammate (member.ts: the
// pairing page, the waiting page, one key per machine, the service worker),
// then this page instead of the work page. It shows what the client asked
// for and where it stands, in their words: no agent ids, no "owner", no
// cards about what the owner's agents are busy with for other people.
//
// Case 2 of #445 (the client's shared folder, their consent, a pause they
// control) is not built yet; the sections for it come here when it is.
//
// No backticks, backslashes or dollar-brace inside the client script: it
// sits in a TS template literal.

import { AX_TOKENS_CSS } from "../tokens"
import { injectFns } from "../inject"
import { ageText, memberBar, memberHead } from "./member"
import { connectionNote, plainPreview } from "./member-logic"
import { clientRequestState, clientSentState, clientSummary } from "./client-logic"
import { BASE_CSS, WORK_CSS } from "./member-styles"

export const CLIENT_MANIFEST_PATH = "/member/client.webmanifest"
export const CLIENT_PAGE_TITLE = "Your project"

export function renderClientManifest(): string {
  return JSON.stringify({
    id: "/member?client",
    name: `${CLIENT_PAGE_TITLE} · AgentX`,
    short_name: CLIENT_PAGE_TITLE,
    description: "What you asked for, and where it stands.",
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

const CLIENT_CSS = `
.about { margin-top: 32px; padding: 16px 20px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-surface); font-size: 15px; color: var(--ax-text-2); }
.wrap .about h2 { margin: 0 0 6px; }
.about p + p { margin-top: 6px; }
`

export function renderClientPage(): string {
  return `<!doctype html>
<html lang="en">
<head>${memberHead(`${CLIENT_PAGE_TITLE} · AgentX`, { manifest: CLIENT_MANIFEST_PATH, appTitle: CLIENT_PAGE_TITLE })}<style>${AX_TOKENS_CSS}${BASE_CSS}${WORK_CSS}${CLIENT_CSS}</style></head>
<body>
${memberBar("Connecting…", `
  <button type="button" id="theme" class="icon-btn" aria-label="Switch theme">◐</button>`, CLIENT_PAGE_TITLE)}
<p id="offline" class="strip" role="status" hidden><span id="offline-text"></span><button type="button" id="retry" hidden>Try now</button></p>
<aside id="install" class="install" aria-label="Keep this window" hidden>To keep this window on your desktop: in Edge or Chrome open the browser menu, then <b>Apps</b>, then <b>Install this site as an app</b>.</aside>
<main class="wrap">
  <p id="sum" class="sum" aria-live="polite">Loading…</p>
  <section aria-labelledby="h-asked"><h2 id="h-asked">What you asked for <span class="n">(last 7 days)</span></h2><ul id="asked" class="rows" role="list"></ul></section>
  <section class="about" aria-labelledby="h-about"><h2 id="h-about">About this page</h2>
    <p>This page shows what you asked us for and where it stands. Nothing else of yours is here, and nothing of yours is read through it.</p>
    <p>Something looks wrong? Ask the person who invited you.</p>
  </section>
  <p id="updated" class="foot"></p>
</main>
<script>${injectFns({ ageText, connectionNote, plainPreview, clientSentState, clientRequestState, clientSummary })}${CLIENT_SCRIPT}</script>
</body>
</html>`
}

/** Fills the summary line and "What you asked for". One round every 30
 *  seconds; a failed round is tried again after 20, and the strip says
 *  whether the browser is offline or the server is not answering, like the
 *  teammate's page (member-work.client.ts). A request that gets no answer
 *  in 15 seconds counts as failed. A 401 or 403 means this machine's key
 *  ended: /member then shows the pairing page. */
export const CLIENT_SCRIPT = `
(function () {
  var POLL_S = 30, RETRY_S = 20, GIVE_UP_MS = 15000;
  var who = document.getElementById('who');
  var strip = document.getElementById('offline');
  var stripText = document.getElementById('offline-text');
  var retry = document.getElementById('retry');
  var install = document.getElementById('install');
  var updated = document.getElementById('updated');
  var theme = document.getElementById('theme');
  var sum = document.getElementById('sum');
  var asked = document.getElementById('asked');
  var failed = navigator.onLine === false, loaded = false, named = false, busy = false, timer = null;
  theme.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('ax-theme', cur); } catch (e) {}
  });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/member/sw.js', { scope: '/member' }); } catch (e) {} }
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && /Windows|Macintosh|Linux/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent)) install.hidden = false;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showConn() {
    var note = connectionNote(failed, navigator.onLine !== false, RETRY_S, loaded);
    strip.hidden = !note;
    if (!note) return;
    if (stripText.textContent !== note.text) stripText.textContent = note.text;
    retry.hidden = !note.retry;
  }
  window.addEventListener('online', function () { failed = false; showConn(); load(); });
  window.addEventListener('offline', function () { failed = true; showConn(); });
  retry.addEventListener('click', function () { load(); });
  function get(url) {
    var ac = new AbortController();
    var giveUp = setTimeout(function () { ac.abort(); }, GIVE_UP_MS);
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal }).then(function (r) {
      if (r.status === 401 || r.status === 403) { location.replace('/member'); return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { clearTimeout(giveUp); return j; }, function (e) { clearTimeout(giveUp); throw e; });
  }
  function where(r) {
    var label = esc(r.where && r.where.label || r.channel || '');
    if (!label) return '';
    return r.where && r.where.url ? '<a href="' + esc(r.where.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
  }
  function delivered(ev) {
    if (!ev) return '';
    var s = String(ev);
    var isLink = s.slice(0, 7).toLowerCase() === 'http://' || s.slice(0, 8).toLowerCase() === 'https://';
    return isLink
      ? '<p class="note"><a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">What was delivered</a></p>'
      : '<p class="note"><b>What was delivered:</b> ' + esc(s) + '</p>';
  }
  function row(text, note, place, st, when) {
    return '<li class="row"><p class="text">' + esc(plainPreview(text)) + '</p>' + note +
      (place ? '<p class="meta"><span>asked on ' + place + '</span></p>' : '') +
      '<p class="side"><span class="state ' + st.tone + '">' + esc(st.label) + '</span><span class="moved">' + when + '</span></p></li>';
  }
  function sent(r, now) {
    var st = clientSentState(r);
    var when = st.tone === 'work' ? 'started ' + ageText(r.startedAt, now) : ageText(r.finishedAt || r.startedAt, now);
    return row(r.messagePreview, delivered(r.request && r.request.evidence), where(r), st, when);
  }
  function request(r, now) {
    var st = clientRequestState(r.state);
    return row(r.text, delivered(r.evidence), where(r), st, ageText(r.closedAt || r.updatedAt || r.createdAt, now));
  }
  function show(w, now) {
    var runs = w.runs || [];
    var covered = {};
    runs.forEach(function (r) { if (r.request && r.request.id) covered[r.request.id] = true; });
    // A request waiting on the owner's side with no turn of the list: shown here, not in a section of its own.
    var asks = (w.open || []).filter(function (r) { return (r.state === 'waiting_owner' || r.state === 'needs_attention') && !covered[r.id]; });
    var others = (w.other || []).concat(asks);
    var tones = runs.map(function (r) { return clientSentState(r).tone; }).concat(others.map(function (r) { return clientRequestState(r.state).tone; }));
    sum.textContent = clientSummary(tones);
    asked.innerHTML = runs.map(function (r) { return sent(r, now); }).join('') + others.map(function (r) { return request(r, now); }).join('') ||
      '<li class="blank"><p>Nothing here yet. When you ask us for something on WhatsApp, Telegram, GitLab or GitHub, it appears here as soon as work on it starts.</p><p>You see when it is being worked on, when it waits on us, and when it is finished.</p></li>';
  }
  function loadName() {
    if (named) return;
    get('/api/member/me').then(function (me) {
      if (!me) return;
      named = true;
      who.textContent = me.name + ' · ' + me.device;
    }).catch(function () { /* the next round asks again */ });
  }
  function load() {
    if (busy) return;
    busy = true; retry.disabled = true; clearTimeout(timer);
    loadName();
    get('/api/member/work').then(function (w) {
      if (!w) return;
      failed = false;
      var now = Date.now();
      show(w, now);
      updated.textContent = 'Updated ' + new Date(now).toLocaleTimeString() + '. This page refreshes by itself.';
      loaded = true;
    }).catch(function () { failed = true; }).then(function () {
      busy = false; retry.disabled = false; showConn();
      timer = setTimeout(load, (failed ? RETRY_S : POLL_S) * 1000);
    });
  }
  showConn();
  load();
})();
`
