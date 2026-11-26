// --- Hub chat (#1528; the middle pane since #2101 PR 2) ---
//
// Chat with an agent from the Hub. The chat is the Hub's middle pane
// (#page=chat&agent=<id>, Orca's chat mode), in place of the page it was
// opened from; ← or Escape goes back there. A bare Hub starts in chat.
// Chat also opens from the Chat box in
// the side column, the header's chat button under 1180 px, "/" and the
// agent links (a profile's Chat, a Hub chat run in the left tree).
//
// Each agent keeps its own conversation (R12): switching agent opens that
// agent's last conversation (remembered here, else the newest from
// GET /api/assistant/threads?agent=), and coming back finds the first one
// as it was. An answer reads like Claude Code (R14, wall-chat-fold.ts):
// the tool steps folded under "Worked for …", the answer plainly. Files
// and the mic are wall-chat-input.client.ts, through window.AXHubChat.
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
import { chatAttached, chatContextLine, chatLiveHtml, chatLogHtml } from "./wall-chat-view"
import { cfBase, cfDuration, cfField, cfFoldHtml, cfParseLive, cfStepLine } from "./wall-chat-fold"
import { WALL_CHAT_INPUT_SCRIPT, wallChatInputHtml } from "./wall-chat-input.client"
import { WALL_CHAT_HEAD_SCRIPT, wallChatHeadHtml } from "./wall-chat-head.client"
import { followAttach, followBtnHtml } from "./wall-follow"
export { WALL_CHAT_CSS } from "./wall-chat.css"

const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>'
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

export interface WallChatOpts {
  owner: boolean
  /** dashboard.token is set: someone who is not the owner can sign in. */
  signIn: boolean
}

const SIGN_IN_HREF = `/login?next=${encodeURIComponent(HUB_PATH)}`

/** The header's chat button: the way into the chat at every width (#2101 R24 took the side column's Chat box away). */
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
    <div class="hc__head">${close}${wallChatHeadHtml()}
      <button type="button" class="hc__ib" id="hc-hist" aria-expanded="false" aria-controls="hc-hist-panel">History</button><button type="button" class="hc__ib" id="hc-new">New</button>${x}</div>
    <div class="hc__hist" id="hc-hist-panel" hidden><p class="hc__histe hc__histe--err" id="hc-hist-err" role="alert" hidden></p><p class="hc__histe" id="hc-hist-empty">No past conversations yet.</p><ul id="hc-hist-list"></ul></div>
    <div class="hc__to"><details class="axp-fold hc__sfold" data-fold="chat.agents" open><summary class="axp-fold__h"><span class="axp-fold__t">Agents</span><span class="axp-fold__n" id="hc-strip-n"></span></summary><div class="hc__strip" id="hc-strip" role="group" aria-label="Agents" hidden></div></details><label for="hc-agent">To</label><select id="hc-agent"><option value="">Loading agents…</option></select><select id="hc-node" aria-label="Node" hidden></select></div>
    <div class="hc__work" id="hc-work" aria-label="The request this agent works on" hidden></div>
    <p class="hc__conn" id="hc-conn" role="status" hidden>Connection lost. Reconnecting…</p>
    <div class="hc__log" id="hc-log" aria-live="polite"></div>
    <div class="hc__tabview" id="hc-tabview" role="tabpanel" hidden></div>
    <form class="hc__foot" id="hc-form">
      ${followBtnHtml("hc-jump")}
      ${wallChatInputHtml()}
      <details class="hc__sends"><summary>Goes with it: <span id="hc-ctx">this page</span></summary><code id="hc-ctx-full"></code></details>
    </form>
  </section>`
}


/** The Hub's hash for the chat with `agent` (#2101 R12). */
export function chatHash(agent: string): string {
  return "#page=chat" + (agent ? "&agent=" + encodeURIComponent(agent) : "")
}

export const WALL_CHAT_SCRIPT = String.raw`
// The Hub chat, the middle pane (wall-chat.client.ts).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('hc'), wall = document.querySelector('.ax-wall');
  if (!panel || !wall) return;
  ${injectFns({ markdownToHtml, chatContextLine, chatAttached, chatLiveHtml, chatLogHtml, cfBase, cfField, cfStepLine, cfDuration, cfParseLive, cfFoldHtml, chatHash, followAttach })}
  var THREAD_KEY = 'ax-assistant-thread', NODE_KEY = 'ax-hub-chat-node', SEEN_KEY = 'ax-hub-chat-seen', AGENTS_KEY = 'ax-hub-chat-agents';
  var FOLD = { parse: cfParseLive, html: cfFoldHtml };
  var guest = !$('hc-form');
  var hist = window.history && window.history.pushState ? window.history : null;

  // --- The middle pane and its link: #page=chat&agent=<id> ---
  // fromHash: the page it was opened from, which ← goes back to and which
  // the message's context names. pushed: the chat's hash is a history
  // entry of its own, so ← is the browser's Back.
  var fromHash = '', pushed = false;
  var defaultChat = location.pathname === '${HUB_PATH}' && !location.hash && !location.search;
  var feedHash = '#status=open&view=feed';
  if (defaultChat && hist) {
    fromHash = feedHash;
    hist.replaceState(null, '', chatHash(''));
  }
  function chatRoute(h) {
    var q = new URLSearchParams(String(h || '').replace(/^#/, ''));
    return q.get('page') === 'chat' ? { agent: q.get('agent') || '' } : null;
  }
  function routeTo(agent) {
    if (!hist || panel.hidden) return;
    var h = chatHash(agent || '');
    if (location.hash === h) return;
    if (chatRoute(location.hash)) hist.replaceState(null, '', h);
    else { fromHash = location.hash; hist.pushState(null, '', h); pushed = true; }
  }
  function routeAway() {
    if (!hist || !chatRoute(location.hash)) return;
    if (pushed) { pushed = false; hist.back(); }
    else hist.replaceState(null, '', fromHash || location.pathname + location.search);
  }

  function open(v, quiet) {
    panel.hidden = !v;
    wall.classList.toggle('hc-open', v);
    if ($('hc-btn')) $('hc-btn').setAttribute('aria-expanded', String(v));
    if (v && !guest) { paintCtx(); markSeen(); loadThread(threadId); if (!quiet) routeTo(currentAgent()); }
    // Closed: no stream; a pending answer is read every 10 s, for the dot.
    if (!v) {
      if (!guest) closeStream();
      if (!quiet) routeAway();
    }
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
    open(true); $('hc-text').focus();
  });
  if (guest) {
    if (defaultChat || chatRoute(location.hash)) open(true, true);
    return;
  }

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
    var h = chatRoute(location.hash) ? fromHash : location.hash;
    return Object.assign({ path: location.pathname + h }, c);
  }
  function paintCtx() {
    var c = pageContext();
    $('hc-ctx').textContent = chatContextLine(c);
    $('hc-ctx-full').textContent = JSON.stringify(c, null, 2);
  }
  window.addEventListener('hashchange', function () {
    var r = chatRoute(location.hash);
    // Back from the chat, or a link to it (a profile's Chat, a chat run).
    if (!r) { pushed = false; if (!panel.hidden) open(false, true); return; }
    if (panel.hidden) open(true, true);
    if (r.agent && r.agent !== currentAgent()) switchAgent(r.agent);
    paintCtx();
  });

  // --- Who answers ---
  var agentNames = {}, agentsKnown = false, agentIds = [];
  // Each agent's engine and own model, for the composer's model picker (#2101 P7).
  var agentInfo = {};
  function currentAgent() { return (thread && thread.agentId) || $('hc-agent').value || ''; }
  // The agent strip (#2101): one chip per agent, as on the phone. The
  // picker stays in the page as the strip's value and its fallback, and
  // shows again while the strip is folded (#2352, hub-folds.ts).
  function paintStrip() {
    var s = $('hc-strip');
    if (!s || !agentIds.length) return;
    var cur = currentAgent();
    s.innerHTML = agentIds.map(function (id) {
      return '<button type="button" class="hc__chip" data-agent="' + esc(id) + '" aria-pressed="' + (id === cur) + '">' + esc(agentNames[id] || id) + '</button>';
    }).join('');
    if ($('hc-strip-n')) $('hc-strip-n').textContent = String(agentIds.length);
    s.hidden = false;
  }
  if ($('hc-strip')) $('hc-strip').addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-agent]') : null;
    var id = b && b.getAttribute('data-agent');
    if (id && id !== currentAgent()) switchAgent(id);
  });
  fetch('/api/agents', { headers: headers() }).then(function (r) { return r.json(); }).then(function (d) {
    var list = (Array.isArray(d) ? d : (d.agents || [])).filter(function (a) { return a && (a.id || a.name); });
    list.forEach(function (a) { agentNames[a.id || a.name] = a.name || a.id; agentInfo[a.id || a.name] = { tier: a.tier || '', model: a.model || '' }; });
    agentIds = list.map(function (a) { return a.id || a.name; });    $('hc-agent').innerHTML = list.length
      ? list.map(function (a) { var id = a.id || a.name; return '<option value="' + esc(id) + '">' + esc(agentNames[id]) + ' @' + esc(id) + '</option>'; }).join('')
      : '<option value="">No agents on this node</option>';
    agentsKnown = true;
    var r = chatRoute(location.hash);
    if (r && r.agent && r.agent !== (thread && thread.agentId)) switchAgent(r.agent);
    else if (thread && thread.agentId) $('hc-agent').value = thread.agentId;
    else if (defaultChat && !threadId && list.length) switchAgent(list[0].id || list[0].name);
    paintLog();
    if (window.AXCtx) window.AXCtx.paintWork();
  }).catch(function () { $('hc-agent').innerHTML = '<option value="">Agents unavailable</option>'; });
  // The node picker shows only when there is more than one node to pick.
  // nodeList: the machines that answer, for the header's "computer" (#2101 P5).
  var nodeList = [];
  fetch('/api/monitor?nodes=1', { headers: headers() }).then(function (r) { return r.json(); }).then(function (d) {
    var ns = (d.nodes || []).filter(function (n) { return n.ok; });
    nodeList = ns;
    if (ns.length < 2) { if (loaded) paintLog(); return; }
    $('hc-node').innerHTML = ns.map(function (n) { return '<option value="' + esc(n.url) + '">' + esc(n.name) + '</option>'; }).join('');
    $('hc-node').hidden = false;
  }).catch(function () { /* one node: no picker */ });

  // --- The conversation: it lives on the daemon, the page keeps its id ---
  // threadNode: the node that holds it, as the Hub's proxy names it; its
  // reads go there, and its run streams and stops from there.
  var threadId = read(THREAD_KEY), threadNode = read(NODE_KEY), thread = null, msgs = [], runs = {}, notSent = '', notSentWhy = '', sendError = '', poll = null, busy = false, loaded = false;
  // spoken: the conversation whose next answer is said aloud (the mic).
  var spoken = null, openFolds = {}, openTurns = {}, paintedThread = null;
  // Follow the newest reply; scrolling up stops it and shows Jump to latest (#2101).
  var follow = followAttach($('hc-log'), $('hc-jump'));
  function setThread(id, node) {
    if ((id || null) !== threadId) { closeStream(); runs = {}; }
    threadId = id || null; threadNode = (threadId && node) || null;
    store(THREAD_KEY, threadId); store(NODE_KEY, threadNode);
  }

  // --- Each agent keeps its own conversation (#2101 R12) ---
  // agentId → { t: its open conversation (null: a new one), n: its node }.
  function mem() { try { return JSON.parse(read(AGENTS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function remember(agent, id, node) {
    if (!agent) return;
    var m = mem();
    m[agent] = { t: id || null, n: (id && node) || null };
    store(AGENTS_KEY, JSON.stringify(m));
  }
  /** Opens the agent's conversation: the one it had open here, else its
   *  newest (GET /api/assistant/threads?agent=), else a new one. */
  function switchAgent(agent) {
    if (!agent) return;
    if (thread && thread.agentId) remember(thread.agentId, threadId, threadNode);
    else if (!threadId) remember($('hc-agent').value, null, null);
    $('hc-agent').value = agent;
    notSent = ''; notSentWhy = '';
    // The work line follows the agent in view (wall-context.client.ts, #2101 R15).
    if (window.AXCtx) window.AXCtx.paintWork();
    var m = mem()[agent];
    routeTo(agent);
    if (m && m.t) { setThread(m.t, m.n); thread = null; msgs = []; loaded = false; loadThread(threadId); return; }
    setThread(null); thread = null; msgs = []; loaded = true; paintLog();
    if (m) return;
    var q = '/api/assistant/threads?agent=' + encodeURIComponent(agent);
    if (!$('hc-node').hidden && $('hc-node').value) q += '&node=' + encodeURIComponent($('hc-node').value);
    fetch(q, { headers: headers() }).then(function (r) { return r.ok ? r.json() : { threads: [] }; }).then(function (d) {
      var t = (d.threads || [])[0];
      // Still on that agent, still on a new conversation: open its newest.
      if (!t || threadId || $('hc-agent').value !== agent) return;
      setThread(t.id, d.node || null); loaded = false;
      loadThread(threadId);
    }).catch(function () { /* none to open: a new conversation */ });
  }
  $('hc-agent').addEventListener('change', function () { switchAgent($('hc-agent').value); });

  // --- The pending answer, live: its run's stream (GET /api/task/stream) ---
  // The thread read stays as the fallback: slower while the stream is open,
  // and it settles the answer once the run is done.
  // stopFailed: the run whose Stop did not take, so a repaint keeps saying so.
  // retry/retryTimer (#2101 R21): a dropped connection opens the stream
  // again by itself, with a visible "reconnecting" line, a few times.
  var es = null, streamed = '', live = '', stopFailed = '', retry = 0, retryTimer = 0;
  var RETRY_MS = [1000, 2000, 4000, 8000, 15000, 15000], RETRY_MAX = RETRY_MS.length;
  function connLine(on) { var c = $('hc-conn'); if (c) c.hidden = !on; }
  function closeStream() {
    if (es) { try { es.close(); } catch (e) { /* already closed */ } }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
    es = null; streamed = ''; live = ''; retry = 0; connLine(false);
  }
  function stream(m) {
    var ES = window.EventSource;
    if (!ES || !threadNode || !m.taskId || !thread || streamed === m.taskId) return;
    // A reopen after a drop keeps its count and its "reconnecting" line.
    var tries = retry;
    closeStream();
    retry = tries;
    if (tries) connLine(true);
    streamed = m.taskId;
    var id = threadId;
    try {
      es = new ES('/api/task/stream?node=' + encodeURIComponent(threadNode) + '&agent=' + encodeURIComponent(thread.agentId) + '&task=' + encodeURIComponent(m.taskId));
    } catch (e) { es = null; return; }
    var mine = es;
    function ended() { if (es === mine) { try { es.close(); } catch (e) { /* already closed */ } es = null; } retry = 0; connLine(false); loadThread(id); }
    // Something came through: the connection is back.
    function heard() { if (es === mine) { retry = 0; connLine(false); } }
    es.addEventListener('start', function (ev) {
      heard();
      try { var d = JSON.parse(ev.data); if (d.initial) { live = d.initial; paintLog(); } if (d.done) ended(); } catch (e) { /* not JSON: skip */ }
    });
    es.addEventListener('chunk', function (ev) {
      heard();
      try {
        var text = JSON.parse(ev.data).text || '';
        // The run's end marker: 'end' follows, and the thread read settles it.
        if (!text || text === FINISHED) return;
        var had = live; live += text;
        paintLive(had);
      } catch (e) { /* not JSON: skip */ }
    });
    es.addEventListener('end', ended);
    // Two kinds of error (#2101 R21). The node's own 'event: error' carries
    // data: the run is unknown to it (evicted, or the node restarted), so
    // stop here; streamed keeps the id, so this run is not opened again.
    // A dropped connection carries none: say so and open the stream again
    // after a short wait, a few times. Either way the thread read takes
    // over at its quick pace meanwhile, and settles the answer.
    es.addEventListener('error', function (ev) {
      if (es !== mine) return;
      try { es.close(); } catch (e) { /* already closed */ }
      es = null;
      var dropped = !(ev && ev.data), run = m.taskId;
      if (dropped && retry < RETRY_MAX && id === threadId) {
        connLine(true);
        retryTimer = setTimeout(function () {
          retryTimer = 0;
          var p = pendingMsg();
          // Still this conversation, still this run waiting: open it again.
          if (id !== threadId || !p || p.taskId !== run || es) { connLine(false); return; }
          streamed = ''; stream(p);
        }, RETRY_MS[retry++]);
      } else connLine(false);
      if (id === threadId) { clearTimeout(poll); poll = setTimeout(function () { loadThread(id); }, 1500); }
    });
  }
  var FINISHED = '\n[task finished]\n';
  /** A chunk: repaint the live part alone (the fold, any error line, the
   *  answer so far), so Stop and its label stay as they are. The first
   *  text, or a log without it, repaints it all. */
  function paintLive(had) {
    var log = $('hc-log');
    var b = had && log.querySelector ? log.querySelector('[data-hc-live]') : null;
    if (!b) { paintLog(); return; }
    var p = pendingMsg();
    b.innerHTML = chatLiveHtml(live, { key: String((p && p.taskId) || ''), fold: FOLD, md: markdownToHtml, ms: p && p.createdAt ? Date.now() - p.createdAt : null, open: !!(p && openFolds[p.taskId]) }) || '<div class="b">Thinking…</div>';
    follow.stick();
  }
  // A fold the reader opened stays open across repaints.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.getAttribute || !d.hasAttribute || !d.hasAttribute('data-hc-fold')) return;
    openFolds[d.getAttribute('data-hc-fold')] = !!d.open;
  }, true);
  // An earlier turn the reader opened stays open across repaints.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.hasAttribute || !d.hasAttribute('data-hc-turn')) return;
    openTurns[d.getAttribute('data-hc-turn')] = !!d.open;
  }, true);
  /** The pending answer's Task page on the Hub (wall-task.client.ts). */
  function runHref(m) {
    if (!m || !m.taskId || !threadNode || !thread) return '';
    var q = new URLSearchParams();
    q.set('page', 'task'); q.set('task', m.taskId); q.set('agent', thread.agentId); q.set('node', threadNode);
    var ask = msgs.filter(function (x) { return x.role === 'user'; }).pop();
    if (ask) q.set('ask', chatAttached(String(ask.content)).text.slice(0, 400));
    return '#' + q.toString();
  }
  function pendingMsg() { return msgs.filter(function (m) { return m.status === 'pending'; }).pop(); }
  function agentName() {
    var id = currentAgent();
    return agentNames[id] || id || 'The agent';
  }
  function paintLog() {
    var log = $('hc-log');
    var p = pendingMsg();
    log.innerHTML = chatLogHtml(msgs, {
      agent: agentName(), md: markdownToHtml, notSent: notSent, notSentWhy: notSentWhy, live: p && p.taskId === streamed ? live : '', runHref: runHref(p),
      stopFailed: !!p && p.taskId === stopFailed, runs: runs, fold: FOLD, open: openFolds, now: Date.now(),
      foldTurns: true, openTurns: openTurns,
    });
    // Another conversation opens at its newest; the same one follows only when the reader is at the bottom.
    if (threadId !== paintedThread) { paintedThread = threadId; openTurns = {}; follow.jump(); } else follow.stick();
    paintStrip();
    // The composer names who it goes to and offers that agent's models.
    var hub = window.AXHubChat, cur = currentAgent();
    if (hub && typeof hub.onAgent === 'function') hub.onAgent(cur, agentNames[cur] || cur, agentInfo[cur] || null);
    $('hc-who').textContent = agentsKnown || thread ? agentName() : 'Chat';
    $('hc-sub').textContent = (thread && thread.title) || 'New conversation';
    // The header and the agent's questions (wall-chat-head.client.ts, #2101 P5/P6).
    if (hub && typeof hub.onPaint === 'function') {
      var last = msgs[msgs.length - 1];
      hub.onPaint({
        agent: cur, name: agentNames[cur] || cur, tier: (agentInfo[cur] || {}).tier || '', node: nodeName(),
        pending: p ? String(p.taskId || '') || 'pending' : '', done: !!(last && last.role === 'assistant' && last.status === 'done'),
      });
    }
  }
  /** The computer the conversation runs on, by name. */
  function nodeName() {
    var key = threadId ? threadNode : ($('hc-node').hidden ? '' : $('hc-node').value);
    for (var i = 0; i < nodeList.length; i++) if (key && (nodeList[i].url === key || nodeList[i].name === key)) return nodeList[i].name;
    if (key) return key;
    return nodeList.length === 1 ? nodeList[0].name : '';
  }
  function signedOut() {
    $('hc-log').innerHTML = '<div class="hc__guest"><b>Chat is for the owner</b><a class="ax-btn" href="/login?next=' + encodeURIComponent(location.pathname) + '">Sign in</a></div>';
  }
  // The owner is signed in, but the machine holding the chat refused or did not answer.
  function nodeDown(r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      var why = d.error || 'HTTP ' + r.status;
      $('hc-log').innerHTML = '<div class="hc__guest"><b>That machine did not answer</b>' + esc(why) + '</div>';
      return why;
    });
  }
  // The node answered a read with an error of its own (#2238): say it, not an empty chat.
  function readFailed(r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      $('hc-log').innerHTML = '<div class="hc__guest"><b>This conversation could not be read</b>' + esc(d.error || 'HTTP ' + r.status) + '</div>';
    });
  }
  function loadThread(id) {
    clearTimeout(poll);
    if (!id) { thread = null; msgs = []; loaded = true; paintLog(); return Promise.resolve(); }
    // Placeholders only when the read is slow, so a quick one does not flash.
    var slow = loaded ? null : setTimeout(function () {
      $('hc-log').innerHTML = '<div class="hc__sk hc__sk--me"></div><div class="hc__sk hc__sk--them"></div><div class="hc__sk hc__sk--me"></div>';
    }, 500);
    var at = threadNode ? '&node=' + encodeURIComponent(threadNode) : '';
    return fetch('/api/assistant/thread?id=' + encodeURIComponent(id) + at, { headers: headers() }).then(function (r) {
      clearTimeout(slow);
      // A read of a conversation no longer open: drop it, whatever it says.
      if (id !== threadId) return;
      if (r.status === 401) { signedOut(); return; }
      if (r.status === 502) return nodeDown(r);
      // Gone (deleted, or another node's): start a new one, as before.
      if (r.status === 404) { setThread(null); thread = null; msgs = []; loaded = true; paintLog(); return; }
      if (!r.ok) return readFailed(r);
      return r.json().then(function (d) {
        if (id !== threadId) return;
        thread = d.thread || null; msgs = d.messages || []; runs = d.runs || {}; loaded = true;
        if (d.node && !threadNode) { threadNode = d.node; store(NODE_KEY, threadNode); }
        if (thread && thread.agentId) { $('hc-agent').value = thread.agentId; remember(thread.agentId, id, threadNode); }
        var p = pendingMsg();
        if (p && !panel.hidden) stream(p);
        if (!p) closeStream();
        paintLog();
        if (p) poll = setTimeout(function () { loadThread(id); }, panel.hidden ? 10000 : es ? 5000 : 1500);
        else {
          sayAnswer(id);
          loadLast();
        }
      });
    }).catch(function () { clearTimeout(slow); });
  }
  /** The answer to a spoken message, said back (wall-chat-input.client.ts). */
  function sayAnswer(id) {
    if (spoken !== id) return;
    spoken = null;
    var last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant' || last.status !== 'done' || !last.content) return;
    if (typeof api.onSpokenAnswer === 'function') api.onSpokenAnswer({ threadId: id, node: threadNode, text: last.content });
  }

  function send(text, extra) {
    text = String(text || '').trim();
    extra = extra || {};
    var files = typeof api.attachments === 'function' ? api.attachments() : [];
    if (!text && files.length) text = files.length === 1 ? 'See the attached file.' : 'See the attached files.';
    if (!text || busy) return Promise.resolve(false);
    var agent = $('hc-agent').value;
    if (!agent && !threadId) { $('hc-agent').focus(); return Promise.resolve(false); }
    busy = true; notSent = ''; notSentWhy = ''; sendError = ''; $('hc-send').disabled = true; $('hc-text').value = '';
    follow.jump();
    // A conversation stays on its node; a new one goes to the node picked.
    var node = threadId ? threadNode || undefined : ($('hc-node').hidden ? undefined : $('hc-node').value || undefined);
    var ok = false;
    return fetch('/api/assistant', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        threadId: threadId || undefined, agentId: agent, node: node, message: text, context: pageContext(),
        attachments: files.length ? files : undefined, spoken: extra.spoken ? true : undefined,
        model: (typeof api.model === 'function' && api.model()) || undefined,
      }),
    }).then(function (r) {
      if (r.status === 401) { $('hc-text').value = text; sendError = 'You are signed out.'; signedOut(); return; }
      if (r.status === 502) { $('hc-text').value = text; return nodeDown(r).then(function (why) { sendError = 'That machine did not answer: ' + why; }); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        // The node answered and refused: keep its own words (#2238).
        if (!r.ok || d.error) throw { answered: d.error || ('HTTP ' + r.status) };
        ok = true;
        setThread(d.threadId, d.node || node);
        remember(agent, d.threadId, d.node || node);
        spoken = extra.spoken ? d.threadId : null;
        if (typeof api.onSent === 'function') api.onSent();
        return loadThread(d.threadId);
      });
    }).catch(function (e) {
      // Not taken: say why (the node's error, or that it did not answer), and keep the text to send again.
      notSent = text; notSentWhy = e && e.answered ? String(e.answered) : '';
      sendError = notSentWhy || 'This node does not answer just now.';
      $('hc-text').value = text; paintLog();
    }).then(function () { busy = false; $('hc-send').disabled = false; return ok; });
  }
  // The ask box's files and mic (wall-chat-input.client.ts) use these.
  var api = window.AXHubChat = {
    send: send, headers: headers, agent: currentAgent, follow: follow,
    // Why the last send was not taken, '' when it was (the mic's status line, #2238).
    sendError: function () { return sendError; },
    node: function () { return threadId ? threadNode || '' : ($('hc-node').hidden ? '' : $('hc-node').value || ''); },
    attachments: null, onSent: null, onSpokenAnswer: null, onAgent: null, model: null,
  };
  $('hc-form').addEventListener('submit', function (e) { e.preventDefault(); send($('hc-text').value); });
  $('hc-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('hc-text').value); }
  });
  $('hc-text').addEventListener('focus', paintCtx);
  // Stop ends the run (POST /api/task/action kind=cancel); the thread
  // read then shows how it ended. From the answer's Stop or the header's.
  function stopRun(task, btn) {
    var id = threadId;
    if (!task) return Promise.resolve();
    if (btn) btn.disabled = true;
    stopFailed = '';
    return fetch('/api/task/action?node=' + encodeURIComponent(threadNode || '') + '&task=' + encodeURIComponent(task) + '&kind=cancel', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ reason: 'Stopped from the Hub chat' }),
    }).then(function (r) {
      if (r.status === 401) { signedOut(); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return loadThread(id);
    }).catch(function () {
      stopFailed = task;
      if (btn) { btn.disabled = false; btn.textContent = 'Not stopped. Try again'; } else paintLog();
    });
  }
  api.stop = function () { var p = pendingMsg(); return stopRun(p && p.taskId, null); };
  /** This chat as a source for the right panel's Files tab (wall-context.client.ts, #2101 R17):
   *  its answers' runs and the files its messages carried. Null with no conversation. */
  api.files = function () {
    if (!threadId || !thread) return null;
    var runs = [], attached = [];
    msgs.forEach(function (m) {
      if (m.role === 'assistant' && m.taskId && threadNode) runs.push({ node: threadNode, agent: thread.agentId, task: m.taskId });
      if (m.role === 'user') chatAttached(String(m.content || '')).files.forEach(function (f) { if (attached.indexOf(f) < 0) attached.push(f); });
    });
    return { key: 'chat:' + threadId, kind: 'chat', label: thread.title || 'This chat', runs: runs, attached: attached, ws: threadNode ? { node: threadNode, agent: thread.agentId } : null };
  };
  api.repaint = paintLog;
  $('hc-log').addEventListener('click', function (e) {
    var t = e.target, stop = t.closest('[data-hc-stop]');
    if (stop) stopRun(stop.getAttribute('data-hc-stop'), stop);
    else if (t.closest('[data-hc-retry]')) {
      var last = msgs.filter(function (m) { return m.role === 'user'; }).pop();
      if (last) send(chatAttached(last.content).text);
    } else if (t.closest('[data-hc-other]')) $('hc-agent').focus();
  });

  // --- History, New, and the last conversation under the Chat box ---
  function threads() {
    return fetch('/api/assistant/threads', { headers: headers() }).then(function (r) {
      var err = $('hc-hist-err');
      if (r.ok) { err.hidden = true; return r.json(); }
      if (r.status === 401) { err.hidden = true; return { threads: [] }; }
      // 502 (the machine refused) or the node's own error (#2238): show it, not an empty list.
      return r.json().catch(function () { return {}; }).then(function (d) {
        err.textContent = d.error || 'HTTP ' + r.status; err.hidden = false;
        return { threads: [] };
      });
    })
      .then(function (d) { return d.threads || []; }, function () { return []; });
  }
  function markSeen() { store(SEEN_KEY, String(Date.now())); $('hc-dot').hidden = true; paintLast(lastThread); }
  var lastThread = null;
  function paintLast(t) {
    var p = $('hc-last');
    var unread = !!t && panel.hidden && t.updatedAt > Number(read(SEEN_KEY) || 0);
    $('hc-dot').hidden = !unread;
    if (!p) return;
    if (!t) { p.hidden = true; return; }
    p.innerHTML = (unread ? '<span class="hc__dot"></span><b>' + esc(agentNames[t.agentId] || t.agentId) + ' answered</b> “' : 'Last: ' + esc(agentNames[t.agentId] || t.agentId) + ', “') +
      esc(t.title) + '” · <button type="button" data-hc-open="' + esc(t.id) + '">Open</button>';
    p.hidden = false;
  }
  function loadLast() { return threads().then(function (list) { lastThread = list[0] || null; paintLast(lastThread); return list; }); }
  if ($('hc-last')) $('hc-last').addEventListener('click', function (e) {
    var b = e.target.closest('[data-hc-open]');
    if (!b) return;
    setThread(b.getAttribute('data-hc-open'));
    open(true);
  });
  function paintHist() {
    return threads().then(function (list) {
      $('hc-hist-empty').hidden = list.length > 0 || !$('hc-hist-err').hidden;
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
            if (id === threadId) { if (thread && thread.agentId) remember(thread.agentId, null, null); setThread(null); loadThread(null); }
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
    loaded = false; notSent = ''; notSentWhy = '';
    loadThread(threadId);
  });
  $('hc-new').addEventListener('click', function () {
    remember(currentAgent(), null, null);
    setThread(null); notSent = ''; notSentWhy = ''; loadThread(null);
    $('hc-hist-panel').hidden = true; $('hc-hist').setAttribute('aria-expanded', 'false');
    $('hc-text').focus();
  });

  // The setup wizard's Done link (#2143): #chat=open opens the panel on
  // the conversation the wizard started.
  if (/(^#|&)chat=open(&|$)/.test(location.hash)) open(true);
  loadLast();
  // Opened by its link: #page=chat&agent=<id> (the agent once the list is in).
  if (defaultChat || chatRoute(location.hash)) open(true, true);
})();
` + WALL_CHAT_INPUT_SCRIPT + WALL_CHAT_HEAD_SCRIPT
