// --- Hub chat panel (#1528, option A of notes/design/hub-chat-panel.md) ---
//
// Ask an agent from the Hub. A Chat box is the first box of the side
// column; asking there opens the panel, which takes the side column's
// place (full height, sticky), so the feed and the open post stay where
// they are. Under 1180 px the Hub has no side column: a chat button sits in
// the header and the panel opens over the right of the page, full screen
// on a phone.
//
// One back end, the classic drawer's (assistant.ts): POST /api/assistant,
// GET /api/assistant/thread and /threads, POST /api/assistant/delete, and
// the same localStorage key for the open conversation, so a question asked
// on a classic page continues here and back. The panel reads the
// conversation again every 1.5 s while an answer is pending, as the drawer
// does. Each message carries the Hub's window.axPageContext
// (wall.client.ts). The routes are the owner's alone (#1608); anyone else
// gets "Chat is for the owner" and a sign-in link when the dashboard has
// one. Chat and New post stay apart: an answer has no "Post as a task".
//
// Its own <script>, outside WALL_PAGE_SCRIPT: the Hub is one document, so
// the panel is mounted once and a page change never redraws it.

import { markdownToHtml } from "@/utils/markdown-html"
import { injectFns } from "../inject"
import { HUB_PATH } from "../hub-name"
import { chatContextLine, chatLogHtml } from "./wall-chat-view"

const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>'
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

export interface WallChatOpts {
  owner: boolean
  /** dashboard.token is set: someone who is not the owner can sign in. */
  signIn: boolean
}

const SIGN_IN_HREF = `/login?next=${encodeURIComponent(HUB_PATH)}`

/** Who may chat, in one line, for anyone who is not the owner. */
function guestLine(o: WallChatOpts): string {
  return o.signIn
    ? `Chat is for the owner · <a href="${SIGN_IN_HREF}">Sign in</a>`
    : "Chat is for the owner. This Hub has no sign-in: open it on the machine that serves it."
}

/** The Chat box, first in the side column. */
export function wallChatQuickHtml(o: WallChatOpts): string {
  const head = `<h2 id="hc-quick-h">${ICON_CHAT}Chat${o.owner ? '<kbd title="Press / to ask">/</kbd>' : ""}</h2>`
  if (!o.owner) return `<section class="ax-wall__box hcq" id="hc-quick" aria-labelledby="hc-quick-h">${head}<p>${guestLine(o)}</p></section>`
  return `<section class="ax-wall__box hcq" id="hc-quick" aria-labelledby="hc-quick-h">${head}
      <form id="hc-quick-form"><input id="hc-quick-text" autocomplete="off" placeholder="Ask about this page…" aria-label="Ask an agent about this page"><button class="ax-btn" type="submit">Ask</button></form>
      <p id="hc-last" hidden></p>
    </section>`
}

/** The header's chat button, shown under 1180 px where there is no side column. */
export function wallChatButtonHtml(): string {
  return `<button type="button" class="hc-btn" id="hc-btn" aria-label="Chat" aria-controls="hc" aria-expanded="false">${ICON_CHAT}<span class="hc__dot" id="hc-dot" hidden></span></button>`
}

/** The panel itself, hidden until opened. */
export function wallChatPanelHtml(o: WallChatOpts): string {
  const close = `<button type="button" class="hc__back" id="hc-back" aria-label="Back to the page">←</button>`
  const x = `<button type="button" class="hc__x" id="hc-close" aria-label="Close">×</button>`
  if (!o.owner) {
    return `<section class="hc" id="hc" aria-label="Chat" hidden>
    <div class="hc__head">${close}<div class="hc__title"><b>Chat</b><small>Signed out</small></div>${x}</div>
    <div class="hc__log"><div class="hc__guest">${ICON_LOCK}<b>Chat is for the owner</b>Only the owner talks to the agents from the Hub. Everything else on these pages stays readable.${o.signIn ? `<a class="ax-btn" href="${SIGN_IN_HREF}">Sign in</a>` : "<span>This Hub has no sign-in: open it on the machine that serves it.</span>"}</div></div>
  </section>`
  }
  return `<section class="hc" id="hc" aria-label="Chat" hidden>
    <div class="hc__head">${close}<div class="hc__title"><b>Chat</b><small id="hc-sub">New conversation</small></div>
      <button type="button" class="hc__ib" id="hc-hist" aria-expanded="false" aria-controls="hc-hist-panel">History</button><button type="button" class="hc__ib" id="hc-new">New</button>${x}</div>
    <div class="hc__hist" id="hc-hist-panel" hidden><p class="hc__histe hc__histe--err" id="hc-hist-err" role="alert" hidden></p><p class="hc__histe" id="hc-hist-empty">No past conversations yet.</p><ul id="hc-hist-list"></ul></div>
    <div class="hc__to"><label for="hc-agent">To</label><select id="hc-agent"><option value="">Loading agents…</option></select><select id="hc-node" aria-label="Node" hidden></select></div>
    <div class="hc__log" id="hc-log" aria-live="polite"></div>
    <form class="hc__foot" id="hc-form">
      <details class="hc__sends"><summary>Goes with it: <span id="hc-ctx">this page</span></summary><code id="hc-ctx-full"></code></details>
      <div class="hc__row"><textarea id="hc-text" rows="1" maxlength="4000" placeholder="Message…" aria-label="Message"></textarea><button class="ax-btn" id="hc-send" type="submit">Send</button></div>
    </form>
  </section>`
}

export const WALL_CHAT_SCRIPT = String.raw`
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('hc'), wall = document.querySelector('.ax-wall');
  if (!panel || !wall) return;
  ${injectFns({ markdownToHtml, chatContextLine, chatLogHtml })}
  var THREAD_KEY = 'ax-assistant-thread', SEEN_KEY = 'ax-hub-chat-seen';
  var guest = !$('hc-form');

  function open(v) {
    panel.hidden = !v;
    wall.classList.toggle('hc-open', v);
    if ($('hc-btn')) $('hc-btn').setAttribute('aria-expanded', String(v));
    if (v && !guest) { paintCtx(); markSeen(); loadThread(threadId); }
  }
  if ($('hc-btn')) $('hc-btn').addEventListener('click', function () { open(panel.hidden); });
  $('hc-close').addEventListener('click', function () { open(false); });
  $('hc-back').addEventListener('click', function () { open(false); });
  // Another Hub dialog (a workflow, a settings confirm, the More sheet) is
  // open or holds the focus: Escape is its own, the panel stays.
  function otherDialog(t) {
    var inPanel = function (n) { return panel.contains ? panel.contains(n) : false; };
    var d = t && t.closest ? t.closest('[role="dialog"], [aria-modal="true"], dialog') : null;
    if (d && !inPanel(d)) return true;
    var ms = document.querySelectorAll ? document.querySelectorAll('[aria-modal="true"], dialog[open]') : [];
    for (var i = 0; i < ms.length; i++) if (!inPanel(ms[i]) && ms[i].getClientRects && ms[i].getClientRects().length) return true;
    return false;
  }
  // Capture phase: this runs before the page's own Escape handlers close
  // their dialog, so it still sees that dialog open.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden && !e.defaultPrevented && !otherDialog(e.target)) open(false);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') return;
    // '/' asks, unless the cursor is already in a field.
    var t = e.target || {}, tag = String(t.tagName || '').toLowerCase();
    if (e.key !== '/' || guest || e.metaKey || e.ctrlKey || e.altKey || tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    e.preventDefault();
    var q = $('hc-quick-text');
    if (panel.hidden && q && q.offsetParent) q.focus();
    else { open(true); $('hc-text').focus(); }
  });
  if (guest) return;

  function headers(h) {
    h = h || {};
    h['X-Requested-With'] = 'agentx-board';
    if (window.AX_LOCAL_TOKEN) h.Authorization = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode: not kept */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // --- What goes with a message: the Hub's own page context ---
  function pageContext() {
    var c = {};
    try { if (typeof window.axPageContext === 'function') c = window.axPageContext() || {}; } catch (e) { c = {}; }
    return Object.assign({ path: location.pathname + location.hash }, c);
  }
  function paintCtx() {
    var c = pageContext();
    $('hc-ctx').textContent = chatContextLine(c);
    $('hc-ctx-full').textContent = JSON.stringify(c, null, 2);
  }
  window.addEventListener('hashchange', function () { if (!panel.hidden) paintCtx(); });

  // --- Who answers ---
  var agentNames = {};
  fetch('/api/agents', { headers: headers() }).then(function (r) { return r.json(); }).then(function (d) {
    var list = (Array.isArray(d) ? d : (d.agents || [])).filter(function (a) { return a && (a.id || a.name); });
    list.forEach(function (a) { agentNames[a.id || a.name] = a.name || a.id; });
    $('hc-agent').innerHTML = list.length
      ? list.map(function (a) { var id = a.id || a.name; return '<option value="' + esc(id) + '">' + esc(agentNames[id]) + ' @' + esc(id) + '</option>'; }).join('')
      : '<option value="">No agents on this node</option>';
    if (thread && thread.agentId) $('hc-agent').value = thread.agentId;
    paintLog();
  }).catch(function () { $('hc-agent').innerHTML = '<option value="">Agents unavailable</option>'; });
  // The node picker shows only when there is more than one node to pick.
  fetch('/api/monitor', { headers: headers() }).then(function (r) { return r.json(); }).then(function (d) {
    var ns = (d.nodes || []).filter(function (n) { return n.ok; });
    if (ns.length < 2) return;
    $('hc-node').innerHTML = ns.map(function (n) { return '<option value="' + esc(n.url) + '">' + esc(n.name) + '</option>'; }).join('');
    $('hc-node').hidden = false;
  }).catch(function () { /* one node: no picker */ });

  // --- The conversation: it lives on the daemon, the page keeps its id ---
  var threadId = read(THREAD_KEY), thread = null, msgs = [], notSent = '', poll = null, busy = false, loaded = false;
  function setThread(id) { threadId = id || null; store(THREAD_KEY, threadId); }
  function agentName() {
    var id = (thread && thread.agentId) || $('hc-agent').value;
    return agentNames[id] || id || 'The agent';
  }
  function paintLog() {
    var log = $('hc-log');
    log.innerHTML = chatLogHtml(msgs, { agent: agentName(), md: markdownToHtml, notSent: notSent });
    log.scrollTop = log.scrollHeight;
    $('hc-sub').textContent = (thread && thread.title) || 'New conversation';
  }
  function signedOut() {
    $('hc-log').innerHTML = '<div class="hc__guest"><b>Chat is for the owner</b><a class="ax-btn" href="/login?next=' + encodeURIComponent(location.pathname) + '">Sign in</a></div>';
  }
  function loadThread(id) {
    clearTimeout(poll);
    if (!id) { thread = null; msgs = []; loaded = true; paintLog(); return Promise.resolve(); }
    // Placeholders only when the read is slow, so a quick one does not flash.
    var slow = loaded ? null : setTimeout(function () {
      $('hc-log').innerHTML = '<div class="hc__sk hc__sk--me"></div><div class="hc__sk hc__sk--them"></div><div class="hc__sk hc__sk--me"></div>';
    }, 500);
    return fetch('/api/assistant/thread?id=' + encodeURIComponent(id), { headers: headers() }).then(function (r) {
      clearTimeout(slow);
      // A read of a conversation no longer open: drop it, whatever it says.
      if (id !== threadId) return;
      if (r.status === 401) { signedOut(); return; }
      if (!r.ok) { setThread(null); thread = null; msgs = []; loaded = true; paintLog(); return; }
      return r.json().then(function (d) {
        if (id !== threadId) return;
        thread = d.thread || null; msgs = d.messages || []; loaded = true;
        if (thread && thread.agentId) $('hc-agent').value = thread.agentId;
        paintLog();
        if (msgs.some(function (m) { return m.status === 'pending'; })) poll = setTimeout(function () { loadThread(id); }, 1500);
        else loadLast();
      });
    }).catch(function () { clearTimeout(slow); });
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    var agent = $('hc-agent').value;
    if (!agent && !threadId) { $('hc-agent').focus(); return; }
    busy = true; notSent = ''; $('hc-send').disabled = true; $('hc-text').value = '';
    var node = $('hc-node').hidden ? undefined : $('hc-node').value || undefined;
    return fetch('/api/assistant', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ threadId: threadId || undefined, agentId: agent, node: node, message: text, context: pageContext() }),
    }).then(function (r) {
      if (r.status === 401) { $('hc-text').value = text; signedOut(); return; }
      return r.json().then(function (d) {
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        setThread(d.threadId);
        return loadThread(d.threadId);
      });
    }).catch(function () {
      // The node did not take it: say so, and keep the text to send again.
      notSent = text; $('hc-text').value = text; paintLog();
    }).then(function () { busy = false; $('hc-send').disabled = false; });
  }
  $('hc-form').addEventListener('submit', function (e) { e.preventDefault(); send($('hc-text').value); });
  $('hc-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('hc-text').value); }
  });
  $('hc-text').addEventListener('focus', paintCtx);
  $('hc-quick-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('hc-quick-text').value;
    $('hc-quick-text').value = '';
    open(true);
    send(t);
  });
  $('hc-log').addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-hc-retry]')) {
      var last = msgs.filter(function (m) { return m.role === 'user'; }).pop();
      if (last) send(last.content);
    } else if (t.closest('[data-hc-other]')) $('hc-agent').focus();
  });

  // --- History, New, and the last conversation under the Chat box ---
  function threads() {
    return fetch('/api/assistant/threads', { headers: headers() }).then(function (r) { return r.ok ? r.json() : { threads: [] }; })
      .then(function (d) { return d.threads || []; }, function () { return []; });
  }
  function markSeen() { store(SEEN_KEY, String(Date.now())); $('hc-dot').hidden = true; paintLast(lastThread); }
  var lastThread = null;
  function paintLast(t) {
    var p = $('hc-last');
    if (!t) { p.hidden = true; return; }
    var unread = panel.hidden && t.updatedAt > Number(read(SEEN_KEY) || 0);
    $('hc-dot').hidden = !unread;
    p.innerHTML = (unread ? '<span class="hc__dot"></span><b>' + esc(agentNames[t.agentId] || t.agentId) + ' answered</b> “' : 'Last: ' + esc(agentNames[t.agentId] || t.agentId) + ', “') +
      esc(t.title) + '” · <button type="button" data-hc-open="' + esc(t.id) + '">Open</button>';
    p.hidden = false;
  }
  function loadLast() { return threads().then(function (list) { lastThread = list[0] || null; paintLast(lastThread); return list; }); }
  $('hc-last').addEventListener('click', function (e) {
    var b = e.target.closest('[data-hc-open]');
    if (!b) return;
    setThread(b.getAttribute('data-hc-open'));
    open(true);
  });
  function paintHist() {
    return threads().then(function (list) {
      $('hc-hist-empty').hidden = list.length > 0;
      $('hc-hist-list').innerHTML = list.map(function (t) {
        return '<li' + (t.id === threadId ? ' class="is-on"' : '') + '><button type="button" class="hc__histt" data-hc-thread="' + esc(t.id) + '">' + esc(t.title) +
          '<small>' + esc(agentNames[t.agentId] || t.agentId) + '</small></button><button type="button" class="hc__histx" data-hc-del="' + esc(t.id) + '" aria-label="Delete">×</button></li>';
      }).join('');
      lastThread = list[0] || null;
      paintLast(lastThread);
    });
  }
  $('hc-hist').addEventListener('click', function () {
    var show = $('hc-hist-panel').hidden;
    $('hc-hist-panel').hidden = !show;
    $('hc-hist').setAttribute('aria-expanded', String(show));
    if (show) paintHist();
  });
  $('hc-hist-list').addEventListener('click', function (e) {
    var del = e.target.closest('[data-hc-del]'), pick = e.target.closest('[data-hc-thread]');
    if (del) {
      var id = del.getAttribute('data-hc-del'), err = $('hc-hist-err');
      err.hidden = true;
      fetch('/api/assistant/delete', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ threadId: id }) })
        .then(function (r) {
          if (r.status === 401) { $('hc-hist-panel').hidden = true; $('hc-hist').setAttribute('aria-expanded', 'false'); signedOut(); return; }
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok || (d && d.error)) throw new Error((d && d.error) || ('HTTP ' + r.status));
            if (id === threadId) { setThread(null); loadThread(null); }
            return paintHist();
          });
        })
        // Not deleted: say so and keep the conversation, in the list and open.
        .catch(function () { err.textContent = 'Not deleted. Try again.'; err.hidden = false; });
      return;
    }
    if (!pick) return;
    setThread(pick.getAttribute('data-hc-thread'));
    $('hc-hist-panel').hidden = true; $('hc-hist').setAttribute('aria-expanded', 'false');
    loaded = false; notSent = '';
    loadThread(threadId);
  });
  $('hc-new').addEventListener('click', function () {
    setThread(null); notSent = ''; loadThread(null);
    $('hc-hist-panel').hidden = true; $('hc-hist').setAttribute('aria-expanded', 'false');
    $('hc-text').focus();
  });

  loadLast();
})();
`

export const WALL_CHAT_CSS = `
/* Hub chat panel (#1528, option A): the Chat box, then the panel in the side column's place. */
.hcq h2 { display: flex; align-items: center; gap: 8px; }
.hcq h2 svg { width: 20px; height: 20px; }
.hcq h2 kbd { margin-left: auto; font: 600 11px var(--ax-mono); color: var(--ax-muted); border: 1px solid var(--ax-border-2); border-radius: 5px; padding: 1px 6px; }
.hcq form { display: flex; gap: 8px; }
.hcq input { flex: 1; min-width: 0; font: inherit; font-size: 14.5px; padding: 8px 14px; border-radius: var(--ax-radius-pill); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.hcq p { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); overflow-wrap: anywhere; }
.hcq p a, .hcq p button { font: inherit; font-weight: 600; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: none; }
.hc__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ax-accent); margin-right: 4px; }
.hc-btn { display: none; margin-left: 8px; position: relative; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: var(--ax-text); cursor: pointer; }
.hc-btn:hover { background: var(--ax-surface); }
.hc-btn svg { width: 22px; height: 22px; }
.hc-btn .hc__dot { position: absolute; top: 6px; right: 6px; width: 9px; height: 9px; margin: 0; border: 2px solid var(--ax-bg); }

.hc { grid-column: 3; grid-row: 1 / span 4; position: sticky; top: 0; height: 100vh; margin-left: 24px; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--ax-bg); border-left: 1px solid var(--ax-border); border-right: 1px solid var(--ax-border); }
@media (min-width: 1181px) { .ax-wall.hc-open .ax-wall__aside { display: none; } }
.hc__head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--ax-border); }
.hc__title { flex: 1; min-width: 0; }
.hc__title b { display: block; font-size: 17px; font-weight: 800; }
.hc__title small { display: block; color: var(--ax-muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc__ib { font: inherit; font-size: 12.5px; font-weight: 700; color: var(--ax-text); background: none; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 3px 10px; cursor: pointer; }
.hc__ib[aria-expanded="true"] { background: var(--ax-blue-t); }
.hc__x, .hc__back { font: inherit; font-size: 22px; line-height: 1; background: none; border: 0; color: var(--ax-muted); padding: 0 2px 2px; cursor: pointer; }
.hc__back { display: none; color: var(--ax-text); }
.hc__hist { border-bottom: 1px solid var(--ax-border); max-height: 40vh; overflow-y: auto; }
.hc__histe { margin: 0; padding: 10px 14px; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.hc__histe--err { color: var(--ax-red-ink); }
.hc__hist ul { list-style: none; margin: 0; padding: 0; }
.hc__hist li { display: flex; align-items: center; border-top: 1px solid var(--ax-border); }
.hc__hist li.is-on { background: var(--ax-blue-t); }
.hc__histt { flex: 1; min-width: 0; text-align: left; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: none; border: 0; padding: 8px 14px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc__histt small { margin-left: 6px; color: var(--ax-muted); }
.hc__histx { font: inherit; font-size: 16px; background: none; border: 0; color: var(--ax-muted); padding: 0 12px; cursor: pointer; }
.hc__to { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--ax-border); font-size: 13px; color: var(--ax-muted); }
.hc__to select { min-width: 0; font: inherit; font-size: 13.5px; font-weight: 700; color: var(--ax-text); background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 3px 10px; }
.hc__to select:first-of-type { flex: 1; }
.hc__log { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.hc__me { align-self: flex-end; max-width: 86%; }
.hc__me .b { background: var(--ax-accent); color: #fff; border-radius: 18px 18px 4px 18px; padding: 8px 13px; font-size: 14.5px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
.hc__them { max-width: 94%; min-width: 0; }
.hc__them .b { background: var(--ax-surface-2); border-radius: 18px 18px 18px 4px; padding: 8px 13px; font-size: 14.5px; line-height: 1.45; overflow-wrap: anywhere; }
.hc__them .b p { margin: 0 0 6px; } .hc__them .b p:last-child { margin: 0; }
.hc__them .b ul, .hc__them .b ol { margin: 0 0 6px; padding-left: 18px; }
.hc__them .b code { font-family: var(--ax-mono); font-size: 12.5px; background: var(--ax-bg); border-radius: 4px; padding: 0 4px; }
.hc__them .b pre { overflow-x: auto; background: var(--ax-bg); border-radius: 8px; padding: 8px; }
.hc__them .b table { display: block; overflow-x: auto; border-collapse: collapse; }
.hc__them .b th, .hc__them .b td { border: 1px solid var(--ax-border); padding: 3px 6px; }
.hc__wait .b { color: var(--ax-muted); }
.hc__meta { font-size: 12px; color: var(--ax-muted); margin: 3px 0 0 2px; }
.hc__live { display: inline-flex; align-items: center; gap: 6px; color: var(--ax-green-d); font-weight: 700; }
.hc__live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ax-green); }
.hc__err .b { background: var(--ax-red-t); color: var(--ax-red-ink); }
.hc__err .b b { display: block; margin-bottom: 2px; }
.hc__btnrow { display: flex; gap: 8px; }
.hc__btnrow .ax-btn { font-size: 12.5px; padding: 3px 12px; }
.hc__empty { margin: auto 6px; text-align: center; color: var(--ax-muted); font-size: 14px; line-height: 1.5; }
.hc__empty b { display: block; color: var(--ax-text); font-size: 17px; margin-bottom: 4px; }
.hc__sk { height: 34px; border-radius: 18px; background: var(--ax-surface-2); }
.hc__sk--me { width: 60%; align-self: flex-end; }
.hc__sk--them { width: 84%; height: 96px; }
.hc__guest { margin: auto 8px; text-align: center; color: var(--ax-muted); font-size: 14px; line-height: 1.5; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.hc__guest svg { width: 30px; height: 30px; }
.hc__guest b { color: var(--ax-text); font-size: 17px; }
.hc__foot { border-top: 1px solid var(--ax-border); padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 7px; }
.hc__sends { font-size: 12px; color: var(--ax-muted); }
.hc__sends summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc__sends code { display: block; max-height: 30vh; overflow: auto; margin-top: 6px; padding: 8px 10px; background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: 10px; font-family: var(--ax-mono); font-size: 11.5px; color: var(--ax-text); white-space: pre-wrap; }
.hc__row { display: flex; gap: 8px; align-items: flex-end; }
.hc__row textarea { flex: 1; min-width: 0; resize: none; font: inherit; font-size: 14.5px; padding: 9px 14px; border-radius: 20px; border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); min-height: 40px; max-height: 140px; }
.hc__row .ax-btn { height: 36px; }
.hc__row .ax-btn[disabled] { opacity: .45; }

/* Under 1180 px there is no side column: a button in the header, the panel over the page. */
@media (max-width: 1180px) {
  .hc-btn { display: inline-flex; }
  .hcq { display: none; }
  .hc { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100vw; height: auto; margin: 0; z-index: 20; box-shadow: -6px 0 24px rgb(0 0 0 / 18%); }
}
/* Phone: full screen, with ← back to the page. */
@media (max-width: 640px) {
  .hc { left: 0; width: auto; border: 0; box-shadow: none; }
  .hc-btn { margin-left: auto; }
  .hc__back { display: block; }
  .hc__x { display: none; }
  .hc__foot { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
}
`
