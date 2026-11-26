// --- Wall v2 Task page, browser side (#1381) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), nameOf(), headers(), progressHtml(), planHtml(),
// factsHtml(), plainPost() and plainMarkerText().
//
// The classic task page on the Wall: one run, at its own link
// (#page=task&task=<id>&agent=<id>&node=<url>). On top, the request and,
// when the run belongs to a tracked request, its status strip, plan and
// facts as in #1377. Under it, the run's conversation, streaming live
// (GET /api/task/stream), or the stored record of a finished run. Last, a
// steer box: a message goes in as the next turn (POST /api/task/action
// kind=followup), and Stop cancels the turn (kind=cancel). The stream,
// steer box and Stop are TASK_MOUNT_FN below, with its rules: a finished
// cron run can be continued, other finished runs are read-only.
//
// Under the head (#1439): a run a stop paused shows its plan with Resume
// and Drop, as on Live; a live run has Pause, which stops it with a resume
// plan (Stop only ends the turn). Both use wall-live.client.ts's controls.
//
// While Live or a Task is open, the Wall follows /api/live/stream (a
// snapshot every two seconds) instead of its one-minute refresh.

import { followBtnHtml } from "./wall-follow"

// --- The run's stream, steer box and Stop ---
//
// Once the classic /tasks/<id> page's own code (task.ts); that page is gone
// and its address redirects here (classic-routes.ts, #1447).
//
// A running task is a place, not a popup. Giving it a URL means it can be
// shared, bookmarked, reopened after a refresh, and left open on a second
// monitor while you work — none of which a modal allows.
//
// The page does one job: show what this agent is doing right now, and let you
// steer it. Exactly two actions, both about the running turn:
//   send    — queue a message as the next turn (current turn keeps running)
//   stop    — cancel the current turn
//
// A finished scheduled (cron) run keeps `send`: nobody reads a cron chat
// anywhere else, so the message resumes that cron:<jobId> session as a new
// turn and the page moves to it. Finished runs from other channels are
// read-only.
//
// Reads: GET /api/task/stream?node=&agent=&task=   (SSE: start / chunk / end)
// Writes: POST /api/task/action?node=&task=&kind=cancel|followup

/** The run's stream, steer box and Stop, as a function of its root element,
 *  which paintTask() mounts. It returns a function that closes the stream and
 *  the clock. opts.href(id, channel) names where a continued scheduled run's
 *  new turn opens; opts.plain strips internal markers (#1443). */
const TASK_MOUNT_FN = `
function mountTaskPage(root, opts) {
  opts = opts || {};
  var timer = 0, es = null;
  function close() {
    clearInterval(timer);
    if (es) { try { es.close(); } catch (e) {} }
    if (conv) { try { conv.unmount(); } catch (e) {} conv = null; }
    follow.stop();
  }
  var taskId  = root.getAttribute('data-task-id');
  var agentId = root.getAttribute('data-agent-id');
  var nodeUrl = root.getAttribute('data-node-url');

  var outputEl  = document.getElementById('task-output');
  var statusEl  = document.getElementById('task-status');
  var elapsedEl = document.getElementById('task-elapsed');
  var inputEl   = document.getElementById('task-input');
  var hintEl    = document.getElementById('task-hint');
  var sendBtn   = document.getElementById('task-send');
  var stopBtn   = document.getElementById('task-stop');
  var composeEl = root.querySelector('.ax-task-page__compose');
  // Follow the stream; scrolling up stops it and shows Jump to latest (#2101).
  // The React island keeps its own stick-to-bottom with the same 60 px rule,
  // so the button's jump puts it back to following too.
  var follow = followAttach(outputEl, document.getElementById('task-jump'));

  // The Wall passes plainMarkerText (#1443): no internal marker in the text.
  var plain = opts.plain || function (s) { return s; };
  var buffer = '';
  var raf = 0;
  // The run's clock starts when the run did, when that is known.
  var startedAt = Date.parse(root.getAttribute('data-ask-at') || '') || Date.now();
  var finished = false;

  function setStatus(label, kind) {
    statusEl.textContent = label;
    statusEl.className = 'ax-badge ax-badge--mono' + (kind ? ' is-' + kind : '');
  }

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // --- Structured stream rendering ---
  //
  // The daemon emits one line per event with a sigil prefix. Rendering each
  // kind as its own block — tool call, tool result, internal reasoning, reply,
  // error — is what makes a long run scannable: you can find the tool that
  // failed without reading everything above it.

  var openText = null;
  var openRaw = '';
  function block(cls, html) {
    var ev = document.createElement('div');
    ev.className = 'ax-ev ' + cls;
    ev.innerHTML = html;
    outputEl.appendChild(ev);
    return ev;
  }
  function label(kind, text) {
    return '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--' + kind + '">' +
      esc(text) + '</span></div>';
  }
  function systemEvent(text, done) {
    closeText();
    block('ax-ev--system' + (done ? ' is-done' : ''),
      '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--soft">system</span><span>' +
      esc(text) + '</span></div>');
  }
  function toolUse(text) {
    closeText();
    // 'ToolName({...})' — best-effort split on the first paren.
    var o = text.indexOf('('), c = text.lastIndexOf(')');
    var name = o > 0 ? text.slice(0, o) : text;
    var args = (o > 0 && c > o) ? text.slice(o + 1, c) : '';
    block('ax-ev--tool',
      '<details><summary class="ax-ev__head"><span class="ax-ev__label ax-ev__label--tool">tool call</span>' +
      '<span class="ax-ev__tool">' + esc(name) + '</span></summary>' +
      (args ? '<pre class="ax-ev__code">' + esc(args) + '</pre>' : '') + '</details>');
  }
  function toolResult(text) {
    closeText();
    var isErr = text.indexOf('[error] ') === 0;
    // A result's own newlines come as U+2028, to keep it on one line (R16).
    var body = (isErr ? text.slice(8) : text).replace(/\\u2028/g, '\\n');
    block('ax-ev--tool-result' + (isErr ? ' is-err' : ''),
      '<details><summary>' + esc(isErr ? 'tool error' : 'tool result') + '</summary>' +
      '<pre class="ax-ev__code ' + (isErr ? 'ax-ev__code--err' : 'ax-ev__code--muted') + '">' +
      esc(body) + '</pre></details>');
  }
  function thought(text) {
    closeText();
    block('ax-ev--thought', label('soft', 'internal') +
      '<div class="ax-ev__thought">' + esc(text) + '</div>');
  }
  function errorEvent(text) {
    closeText();
    block('ax-ev--error', label('error', 'error') +
      '<pre class="ax-ev__code ax-ev__code--err">' + esc(text) + '</pre>');
  }
  function replyLine(line) {
    if (!openText) {
      openText = block('ax-ev--text', label('text', 'response') + '<div class="ax-ev__text"></div>')
        .querySelector('.ax-ev__text');
      openRaw = '';
    }
    openRaw += (openRaw ? '\\n' : '') + line;
    openText.setAttribute('data-raw', openRaw);
  }
  /** Re-render every open reply block from its accumulated source. Done once
   *  per frame rather than per line — markdown is whole-block by nature
   *  (a fence isn't valid until it closes). */
  function renderOpenText() {
    if (openText) openText.innerHTML = markdownToHtml(plain(openRaw));
  }
  /** Close the current reply block, rendering it on the way out. Every event
   *  that interrupts a reply must go through here — nulling openText without
   *  rendering leaves the block showing its label and nothing else, which is
   *  exactly what happened before this existed. */
  function closeText() { renderOpenText(); openText = null; openRaw = ''; }

  function processLine(line) {
    if (line.indexOf('· ') === 0)   return systemEvent(line.slice(2));
    if (line.indexOf('→ ') === 0)   return toolUse(line.slice(2));
    if (line.indexOf('← ') === 0)   return toolResult(line.slice(2));
    if (line.indexOf('> codex ') === 0) return toolUse(line.slice(8));
    if (line.indexOf('< codex ') === 0) return toolResult(line.slice(8));
    if (line.indexOf('💭 ') === 0)  return thought(line.slice(2));
    if (line.indexOf('[error] ') === 0) return errorEvent(line.slice(8));
    if (line.indexOf('[task finished]') === 0) return systemEvent('task finished', true);
    if (line === '') {
      // Blank line = paragraph break inside a reply. Keep the block open.
      if (openText) { openRaw += '\\n\\n'; }
      return;
    }
    replyLine(line);
  }

  // Batch through requestAnimationFrame — a chatty agent emits hundreds of
  // chunks a second and one DOM write per chunk drops frames. Only the last
  // partial line is held back, so a half-arrived event never renders.
  var lineBuf = '';
  function flush() {
    raf = 0;
    if (!buffer) return;
    lineBuf += buffer;
    buffer = '';
    var lines = lineBuf.split('\\n');
    lineBuf = lines.pop();
    for (var i = 0; i < lines.length; i++) processLine(lines[i]);
    follow.stick();
  }
  function append(text) {
    if (!text) return;
    raw += text;
    if (conv) { conv.append(text); return; }
    if (convWaiting) return; // kept in raw until the bundle loads or fails
    buffer += text;
    if (!raf) raf = requestAnimationFrame(flush);
  }
  /** Render whatever partial line is left. Call when the stream ends. */
  function drain() {
    ended = true;
    if (conv) { conv.end(); return; }
    if (convWaiting) return;
    flush();
    if (lineBuf) { processLine(lineBuf); lineBuf = ''; }
    renderOpenText();
  }

  // --- The conversation, rendered by the React island (#2101 R16) ---
  //
  // The run's output goes to src/web/task-conversation (AI Elements parts:
  // markdown with highlighted code, folded tool steps, edits as diffs). The
  // bundle loads the first time a Task page opens; until it is in, output
  // is kept, then handed over whole. If it fails to load, the renderer
  // above takes the same output: the page never goes blank.
  var raw = '', conv = null, convWaiting = false, ended = false;
  function convStart() {
    outputEl.innerHTML = '';
    buffer = ''; lineBuf = ''; openText = null; openRaw = '';
    conv = window.AXTaskConversation.mount(outputEl, { plain: plain });
    if (raw) conv.append(raw);
    if (ended) conv.end();
  }
  function convFallback() {
    var r = raw;
    raw = '';
    append(r);
    if (ended) drain();
  }
  function convLoad() {
    if (window.AXTaskConversation) { convStart(); return; }
    if (window.AX_TASK_CONVERSATION_FAILED) return;
    convWaiting = true;
    var settled = false;
    function done(ok) {
      if (settled) return;
      settled = true;
      convWaiting = false;
      if (!ok) window.AX_TASK_CONVERSATION_FAILED = true;
      if (ok && window.AXTaskConversation && !closed()) convStart(); else convFallback();
    }
    document.addEventListener('ax:task-conversation-ready', function () { done(true); }, { once: true });
    setTimeout(function () { done(!!window.AXTaskConversation); }, 10000);
    var s = document.getElementById('ax-task-conversation-js');
    if (!s) {
      s = document.createElement('script');
      s.id = 'ax-task-conversation-js';
      s.src = window.AX_TASK_CONVERSATION_SRC || '/assets/task-conversation.global.js';
      document.head.appendChild(s);
    }
    s.addEventListener('error', function () { done(false); });
  }
  function closed() { return outputEl.isConnected === false; }
  /** A start event carries the run's whole output; after a dropped stream
   *  the browser reconnects and gets it again (tsCatchUp, #2175). */
  function catchUp(all) {
    var c = tsCatchUp(raw, all);
    if ('add' in c) { append(c.add); return; }
    if (conv) { raw = c.reset; conv.reset(c.reset); return; }
    outputEl.innerHTML = '';
    buffer = ''; lineBuf = ''; openText = null; openRaw = ''; raw = '';
    append(c.reset);
  }
  // A page where the bundle cannot even be asked for keeps the plain renderer.
  try { convLoad(); } catch (e) { convWaiting = false; window.AX_TASK_CONVERSATION_FAILED = true; }

  /** Render the request that started this run. Hidden until we have one —
   *  an empty labelled box is worse than no box. */
  function showAsk(message, sender, startedAt) {
    var text = plain(message || '').trim();
    if (!text) return;
    document.getElementById('task-ask-body').innerHTML = markdownToHtml(text);
    document.getElementById('task-ask-who').textContent = sender ? 'from ' + sender : '';
    var when = document.getElementById('task-ask-when');
    if (startedAt) {
      var d = new Date(startedAt);
      when.textContent = isNaN(d.getTime()) ? '' : d.toLocaleString();
    }
    document.getElementById('task-ask').hidden = false;
  }

  function tickElapsed() {
    if (finished) return;
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var m = Math.floor(s / 60);
    elapsedEl.textContent = m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
  }
  timer = setInterval(tickElapsed, 1000);
  tickElapsed();

  // A request handed over by the caller renders immediately, before any
  // stream data arrives — so the page never shows work without the ask.
  var seededAsk = root.getAttribute('data-ask');
  if (seededAsk) showAsk(seededAsk, '', root.getAttribute('data-ask-at'));

  function action(kind, message) {
    var q = '/api/task/action?node=' + encodeURIComponent(nodeUrl)
      + '&task=' + encodeURIComponent(taskId) + '&kind=' + encodeURIComponent(kind);
    // agent lets the daemon find the stored record when the task has
    // already finished, so a follow-up on a scheduled run resumes its chat.
    var payload = message ? { message: message, agent: agentId } : {};
    return fetch(q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  /** The Task page for another run of the same agent on this node. */
  function taskHref(id, channel) { return opts.href(id, channel); }

  sendBtn.addEventListener('click', function () {
    var text = (inputEl.value || '').trim();
    if (!text) { inputEl.focus(); return; }
    sendBtn.disabled = true;
    hintEl.textContent = 'queuing…';
    action('followup', text).then(function (r) {
      sendBtn.disabled = false;
      if (r && r.error) { hintEl.textContent = 'failed: ' + r.error; return; }
      inputEl.value = '';
      // A finished scheduled run was continued as a new turn in its chat.
      // Follow that turn: it is where the reply will appear.
      if (r && r.resumed && r.taskId) { location.href = taskHref(r.taskId, r.channel); return; }
      if (r && r.resumed && r.answeredBy === 'attached') { hintEl.textContent = 'answered by the attached session — no new run here'; return; }
      if (r && r.resumed && r.answeredBy) { hintEl.textContent = 'delivered and answered — no new run on this node'; return; }
      if (r && r.resumed) { hintEl.textContent = 'agent busy — queued as the next turn in this chat'; return; }
      hintEl.textContent = 'queued — dispatches as the next turn';
    });
  });

  stopBtn.addEventListener('click', function () {
    stopBtn.disabled = true;
    hintEl.textContent = 'stopping…';
    action('cancel').then(function (r) {
      stopBtn.disabled = false;
      hintEl.textContent = (r && r.error) ? 'failed: ' + r.error : 'stop requested';
    });
  });

  inputEl.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
  });

  // Archived: one fetch of the stored record, no SSE. Opening a stream for a
  // task that ended hours ago would sit "connecting…" forever and then report
  // a disconnect, which reads as breakage rather than as history.
  if (root.getAttribute('data-archived')) {
    finished = true;
    elapsedEl.textContent = '';
    setStatus('loading…', '');
    fetch('/api/task/history?node=' + encodeURIComponent(nodeUrl)
          + '&agent=' + encodeURIComponent(agentId)
          + '&task=' + encodeURIComponent(taskId))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rec) {
        setStatus(rec.ok ? 'archived' : 'failed', rec.ok ? 'done' : 'err');
        showAsk(rec.message, rec.sender, rec.startedAt);
        // A scheduled run's chat has nobody on the other end, so this page is
        // where it continues: Send resumes the cron session with a new turn.
        // Other channels stay read-only — their replies belong in their chat.
        if (rec.channel === 'cron') {
          composeEl.hidden = false;
          stopBtn.style.display = 'none'; // nothing is running to stop
          inputEl.placeholder = 'Continue this scheduled run — your message starts a new turn in the same session. ⌘/Ctrl+Enter to send.';
        }
        var tx = rec.transcript || '';
        if (tx) append(tx);
        // Only append the final reply when the transcript didn't already
        // carry it, so the answer isn't printed twice.
        if (rec.responseText && (!tx || tx.indexOf(rec.responseText) === -1)) {
          append('\\n\\n--- Final reply ---\\n' + rec.responseText);
        }
        if (rec.error) append('\\n\\n[error] ' + rec.error);
        if (rec.durationMs) {
          var s = Math.round(rec.durationMs / 1000);
          elapsedEl.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        }
        drain();
      })
      .catch(function (e) { setStatus(e.message, 'err'); });
    return close;
  }

  var url = '/api/task/stream?node=' + encodeURIComponent(nodeUrl)
    + '&agent=' + encodeURIComponent(agentId)
    + '&task=' + encodeURIComponent(taskId);
  try { es = new EventSource(url); } catch (e) { setStatus('connect failed', 'err'); return close; }

  es.addEventListener('start', function (ev) {
    setStatus('live', 'live');
    try {
      var d = JSON.parse(ev.data);
      if (d.message || d.sender) showAsk(d.message, d.sender, d.startedAt);
      if (d.startedAt) startedAt = Date.parse(d.startedAt) || startedAt;
      if (d.initial) catchUp(d.initial);
      if (d.done) { finished = true; setStatus('finished', 'done'); }
    } catch (e) {}
  });
  es.addEventListener('chunk', function (ev) {
    try { append(JSON.parse(ev.data).text || ''); } catch (e) {}
  });
  es.addEventListener('end', function () {
    finished = true;
    setStatus('finished', 'done');
    try { es.close(); } catch (e) {}
    drain();
  });
  es.addEventListener('error', function () {
    if (!finished) setStatus('disconnected', 'err');
  });
  return close;
}
`

export const WALL_TASK_SCRIPT = String.raw`
  ${TASK_MOUNT_FN}
  /** The query keys of a Task page's hash. */
  var TASK_KEYS = ['task', 'agent', 'node', 'trace', 'ch', 'ask', 'at', 'done'];
  /** The Wall's link to a run's Task page. t: { id, traceId?, channel?, message?, startedAt? } */
  function wallTaskHref(t, agentId, nodeUrl, done) {
    var q = new URLSearchParams();
    q.set('page', 'task');
    q.set('task', t.id);
    q.set('agent', agentId);
    if (nodeUrl) q.set('node', nodeUrl);
    if (t.traceId) q.set('trace', t.traceId);
    if (t.channel) q.set('ch', t.channel);
    // A live run's stream never replays what was asked: carry it, capped.
    var ask = plainMarkerText(t.message || t.messagePreview || '').slice(0, 400);
    if (ask) q.set('ask', ask);
    if (t.startedAt) q.set('at', t.startedAt);
    if (done) q.set('done', '1');
    return '#' + q.toString();
  }
  function readTask(q) {
    var t = {};
    TASK_KEYS.forEach(function (k) { t[k] = q.get(k) || ''; });
    return t.task && t.agent ? t : null;
  }
  function taskKey(t) { return t ? t.node + '|' + t.agent + '|' + t.task : ''; }
  /** The node a run is on, from the live snapshot: index 0 is this one. */
  function taskNode(t) {
    var nodes = (S.live && S.live.nodes) || [];
    var i = nodes.findIndex(function (n) { return n.url === t.node; });
    return { i: i, n: nodes[i] || null };
  }

  function taskSkeleton(t) {
    var who = nameOf(t.agent);
    return '<div class="ax-task-page wtask" id="wtask-root" data-task-id="' + esc(t.task) + '" data-agent-id="' + esc(t.agent) + '" data-node-url="' + esc(t.node) + '"' +
      ' data-archived="' + (t.done ? '1' : '') + '" data-ask="' + esc(t.ask) + '" data-ask-at="' + esc(t.at) + '">' +
      '<header class="wtask__head">' + avatar(t.agent) + '<div class="wtask__who"><div><b id="wtask-name">' + esc(who) + '</b> <span class="h">@' + esc(t.agent) + '</span></div>' +
        '<div class="wtask__meta">' + (t.ch ? '<span class="chip chip--ghost">' + esc(t.ch) + '</span>' : '') +
        '<span class="ax-badge ax-badge--mono" id="task-status">connecting…</span><span class="ax-mono" id="task-elapsed"></span>' +
        '<span id="wtask-where"></span>' +
        // The right panel's Files tab for this run (#2101 R17): wall-context.client.ts
        // handles the press; wflIcon is injected there (wall-files.ts).
        '<button type="button" class="wtask__files" id="wtask-files" data-cx="files" data-src="task" aria-pressed="false" title="The files this run read, changed or was given, and the workspace">' + wflIcon('files') + 'Files</button></div>' +
        '<div class="wtask__turn" id="wtask-turn" hidden></div></div>' +
      '</header>' +
      '<div id="wtask-ops"></div>' +
      '<section class="wsess" id="wtask-before" aria-label="Earlier turns in this chat" hidden></section>' +
      '<section class="ax-task-page__ask" id="task-ask" hidden><div class="ax-task-page__ask-head"><span class="ax-ev__label ax-ev__label--soft">request</span>' +
        '<span class="ax-task-page__ask-who" id="task-ask-who"></span><span class="ax-task-page__ask-when" id="task-ask-when"></span></div>' +
        '<div class="ax-task-page__ask-body" id="task-ask-body"></div></section>' +
      '<div id="wtask-details"></div>' +
      '<h2 class="wtask__h" id="wtask-conv-h">Conversation</h2>' +
      '<div class="ax-task-page__output wtask__out" id="task-output" aria-live="polite"></div>' +
      '<div class="wtask__jump">${followBtnHtml("task-jump")}</div>' +
      '<section class="wsess" id="wtask-after" aria-label="Later turns in this chat" hidden></section>' +
      '<footer class="ax-task-page__compose wtask__steer" id="wtask-steer"' + (t.done ? ' hidden' : '') + '>' +
        '<textarea id="task-input" class="ax-task-page__input" rows="2" aria-label="Steer ' + esc(who) + '" placeholder="Message ' + esc(who) + ': it goes in as the next turn, the current one keeps running. ⌘/Ctrl+Enter sends."></textarea>' +
        '<div class="ax-task-page__actions"><span class="ax-task-page__hint" id="task-hint" role="status"></span>' +
          '<button type="button" id="task-stop" class="ax-btn ax-btn--ghost wtask__stop">Stop</button>' +
          '<button type="button" id="task-send" class="ax-btn">Send</button></div>' +
      '</footer>' +
      '<p class="wtask__ro">This run is finished. Its chat goes on where it came from' + (t.ch ? ' (' + esc(t.ch) + ')' : '') + ', so this page only reads it.</p>' +
    '</div>';
  }

  /** The tracked request the run belongs to, if any: status strip, plan, facts. */
  function taskDetailsHtml() {
    var d = S.taskDetail;
    if (!d || !d.post) return '';
    var p = d.post;
    return '<section class="wtask__req" aria-label="Tracked request"><h2 class="wtask__h">' + esc(p.headline || p.id) +
      ' <a class="wtask__open" href="#post=' + encodeURIComponent(p.id) + '">Open the post</a></h2>' +
      progressHtml(p) + (d.plan && d.plan.length ? planHtml(d.plan) : '') + factsHtml(p) + '</section>';
  }
  async function loadTaskDetail(t) {
    var at = taskNode(t);
    if (!S.live) return;
    S.taskDetail = { loading: true };
    var peer = at.i > 0 ? at.n.url : null;
    var tries = t.trace && t.trace !== t.task ? [t.trace, t.task] : [t.task];
    for (var i = 0; i < tries.length; i++) {
      try {
        var r = await fetch('/api/admin/wall/thread?task=' + encodeURIComponent(tries[i]), { headers: headers(peer) });
        var b = r.ok ? await r.json() : null;
        if (b && b.post) {
          if (taskKey(S.task) !== taskKey(t)) return;
          plainPost(b.post);
          b.post.node = b.post.node || { name: at.n ? at.n.name : '', peer: peer, daemonUrl: t.node };
          S.taskDetail = { post: b.post, plan: b.plan || [] };
          render();
          return;
        }
      } catch (e) { /* not tracked, or the node did not answer: the run alone */ }
    }
    if (taskKey(S.task) === taskKey(t)) S.taskDetail = { none: true };
  }

  // --- The run's session (#2101 R4) ---
  // A follow-up is one turn of a chat. Around the selected run's own stream
  // the page shows the chat's other turns in order, from the server's session
  // read (one agent, one channel, one chatId; GET /api/task/history
  // ?session=1), with older turns paged behind "Load earlier turns".
  function sessionUrl(t, before) {
    return '/api/task/history?session=1&node=' + encodeURIComponent(t.node) + '&agent=' + encodeURIComponent(t.agent) +
      '&task=' + encodeURIComponent(t.task) + (before ? '&before=' + encodeURIComponent(before) : '');
  }
  function sessionTurn(t, want) {
    return tsTurnHtml(t, {
      agent: nameOf(want.agent), md: markdownToHtml, plain: plainMarkerText,
      when: function (iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString(); },
      href: wallTaskHref({ id: t.id, channel: want.ch, message: t.message, startedAt: t.startedAt }, want.agent, want.node, !t.running),
    });
  }
  function paintSession(want) {
    var s = S.taskSession;
    if (!s || s.key !== taskKey(want) || !$('wtask-before')) return;
    // Earlier turns fold to their ask; the newest turn stays open (#2101).
    var newest = s.after.length ? s.after[s.after.length - 1].id : '';
    var open = S.taskTurnOpen || (S.taskTurnOpen = {});
    var turn = function (t) { var h = sessionTurn(t, want); return t.id === newest ? h : tsFoldHtml(t, h, !!open[t.id], plainMarkerText); };
    var before = tsBeforeHtml({ first: s.first, before: s.before, olderBefore: s.olderBefore, loading: s.loading, error: s.error }, turn);
    $('wtask-before').innerHTML = before ? '<h2 class="wtask__h">Earlier in this chat</h2>' + before : '';
    $('wtask-before').hidden = !before;
    $('wtask-after').innerHTML = s.after.length ? '<h2 class="wtask__h">Later in this chat</h2>' + s.after.map(turn).join('') : '';
    $('wtask-after').hidden = !s.after.length;
    var label = tsTurnLabel(s.n, s.total);
    $('wtask-turn').textContent = label;
    $('wtask-turn').hidden = !label;
    // The selected run: its request card says which turn it is, and its
    // stream keeps its own heading.
    var askLabel = document.querySelector('#task-ask .ax-ev__label');
    if (askLabel) askLabel.textContent = label ? 'turn ' + s.n + ' · selected' : 'request';
    $('task-ask').classList.toggle('is-selected', !!label);
    $('wtask-conv-h').textContent = label ? 'Turn ' + s.n + ': its run' : 'Conversation';
  }
  function loadSession(want, before) {
    var key = taskKey(want);
    if (!before) S.taskSession = { key: key, before: [], after: [], first: null, olderBefore: null, n: 0, total: 0 };
    var s = S.taskSession;
    if (before) { s.loading = true; paintSession(want); }
    fetch(sessionUrl(want, before), { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? '' : 'HTTP ' + r.status); return r.json(); })
      .then(function (p) {
        if (S.taskSession !== s) return;
        s.loading = false; s.error = '';
        var turns = p.turns || [];
        if (before) {
          s.before = turns.concat(s.before);
          if (s.before.length && s.before[0].n === 1) s.first = null;
        } else {
          var i = turns.findIndex(function (t) { return t.id === p.selected; });
          s.before = i > 0 ? turns.slice(0, i) : [];
          s.after = i >= 0 ? turns.slice(i + 1) : [];
          s.n = i >= 0 ? turns[i].n : 0;
          s.first = p.first || null;
        }
        s.total = p.session ? p.session.turns : 1;
        s.olderBefore = p.olderBefore || null;
        paintSession(want);
      })
      .catch(function (e) {
        if (S.taskSession !== s) return;
        s.loading = false; s.error = e.message ? 'Could not read this chat: ' + e.message : '';
        paintSession(want);
      });
  }
  // A turn the reader opened stays open when the chat repaints.
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.hasAttribute || !d.hasAttribute('data-turn-fold')) return;
    (S.taskTurnOpen || (S.taskTurnOpen = {}))[d.getAttribute('data-turn-fold')] = !!d.open;
  }, true);
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-session-older]');
    if (!b || !S.task || !S.taskSession || S.taskSession.loading) return;
    loadSession(S.task, b.getAttribute('data-session-older'));
  });

  /** Is this run working now, by the live snapshot? */
  function runsNow(t) {
    var n = taskNode(t).n;
    return !!n && (n.agents || []).some(function (a) {
      return a.id === t.agent && (a.runningTasks || []).some(function (r) { return r.id === t.task; });
    });
  }
  /** Paused: its plan, Resume and Drop. Running: Pause. */
  function taskOpsHtml(t) {
    var x = stoppedOf(t.task, t.node), inner = '';
    if (x) inner = stoppedHtml(x, true);
    else if (runsNow(t)) {
      inner = '<div class="wtask__pause">' + lvBtn('pause', t.node, t.task, 'Pause', 'Pause it?', 'Stop this task and keep a resume plan, so it can be resumed later', true) +
        '<span class="wls__k">Pause keeps a plan to resume from; Stop below only ends the turn.</span></div>';
    }
    return inner || lvState().msg ? '<div class="wlv wtask__ops">' + lvNoteHtml() + inner + '</div>' : '';
  }

  /** Open, keep or close the mounted run as the page changes. */
  function paintTask(page) {
    var want = page === 'task' ? S.task : null;
    if (taskKey(want) !== S.taskMounted) {
      if (S.taskClose) { S.taskClose(); S.taskClose = null; }
      S.taskMounted = taskKey(want);
      S.taskDetail = null;
      S.taskSession = null;
      S.taskTurnOpen = {};
      if (!want) { $('wall-task').innerHTML = ''; return; }
      $('wall-task').innerHTML = taskSkeleton(want);
      S.taskClose = mountTaskPage($('wtask-root'), {
        href: function (id, channel) { return wallTaskHref({ id: id, channel: channel }, want.agent, want.node, false); },
        plain: plainMarkerText,
      });
      loadSession(want);
    }
    if (!want) return;
    if (!S.taskDetail && S.live) loadTaskDetail(want);
    var at = taskNode(want);
    $('wtask-name').textContent = nameOf(want.agent);
    $('wtask-where').textContent = at.n && S.live.nodes.length > 1 ? 'on ' + at.n.name : '';
    $('wtask-details').innerHTML = taskDetailsHtml();
    $('wtask-ops').innerHTML = taskOpsHtml(want);
  }

  /** While Live or a Task is open, or the live tree is on screen (#2101
   *  PR 1c), follow the live snapshot stream. */
  // A dropped stream is reopened after 2 s, 5 s, 10 s, then every 30 s, not
  // at the one-minute refresh: the tree is on every tab (Hakim post-merge
  // review of #2138). A snapshot that arrives starts the waits over.
  var LIVE_RETRY_MS = [2000, 5000, 10000, 30000], liveRetry = 0, liveRetryTimer = null;
  function followLive(page) {
    var want = page === 'live' || page === 'task' || treeShown();
    if (want && !S.liveEs) {
      if (liveRetryTimer) { clearTimeout(liveRetryTimer); liveRetryTimer = null; }
      try {
        var es = S.liveEs = new EventSource('/api/live/stream');
        es.addEventListener('snapshot', function (ev) {
          try { S.live = JSON.parse(ev.data); } catch (e) { return; }
          liveRetry = 0;
          // Only Live and a Task page redraw on every snapshot; elsewhere the
          // tree does, and the feed keeps its place.
          var pg = S.post ? 'post' : S.page;
          if (pg === 'live' || pg === 'task') { render(); return; }
          renderTree();
        });
        es.addEventListener('error', function (ev) {
          // The server's own "event: error" (one snapshot failed) carries
          // data, and the stream goes on: the next snapshot comes in 2 s.
          if (ev && ev.data != null) return;
          // The connection dropped: close it and reopen it soon.
          if (S.liveEs !== es) return;
          es.close();
          S.liveEs = null;
          if (liveRetryTimer) clearTimeout(liveRetryTimer);
          var wait = LIVE_RETRY_MS[Math.min(liveRetry, LIVE_RETRY_MS.length - 1)];
          liveRetry++;
          liveRetryTimer = setTimeout(function () { liveRetryTimer = null; followLive(S.post ? 'post' : S.page); }, wait);
        });
      } catch (e) { S.liveEs = null; }
    } else if (!want) {
      if (liveRetryTimer) { clearTimeout(liveRetryTimer); liveRetryTimer = null; }
      if (S.liveEs) { S.liveEs.close(); S.liveEs = null; }
    }
  }
`

export const WALL_TASK_CSS = `

.ax-task-page { display: flex; flex-direction: column; gap: var(--ax-gap); }
.ax-badge.is-live { border-color: var(--ax-accent); color: var(--ax-accent); }
.ax-badge.is-done { border-color: var(--ax-ok); color: var(--ax-ok); }
.ax-badge.is-err  { border-color: var(--ax-err); color: var(--ax-err); }

/* The output is the page. It grows to fill whatever room is left. */
.ax-task-page__output {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
  background: var(--ax-surface); color: var(--ax-text-2);
  border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius-lg); box-shadow: var(--ax-shadow);
  padding: var(--ax-pad); font-size: var(--ax-fs-sm); line-height: 1.6; min-height: 320px;
}
/* A "display: flex" rule beats the user-agent's [hidden] rule, so an archived
   task still showed a send/stop box that could do nothing. (No backticks in
   this file's CSS comments — it lives in a TS template literal and one
   backtick silently truncates the whole stylesheet.) */
.ax-task-page__compose[hidden] { display: none; }
.ax-task-page__compose {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: var(--ax-pad-sm);
}
.ax-task-page__input {
  width: 100%; resize: vertical; background: var(--ax-bg); color: var(--ax-text);
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius);
  padding: 10px 12px; font: inherit; font-size: var(--ax-fs-sm);
}
.ax-task-page__input:focus { outline: none; border-color: var(--ax-accent); }
.ax-task-page__actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ax-task-page__hint { flex: 1; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
/* The request that started everything. The page used to render the agent's
   work with no sign of what it had been asked — you could read a whole
   transcript without learning why it ran. */
.ax-task-page__ask[hidden] { display: none; }
.ax-task-page__ask {
  background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border);
  border-left-width: 4px; border-left-color: var(--ax-accent);
  border-radius: var(--ax-radius-lg); padding: 14px 16px;
  box-shadow: var(--ax-shadow);
}
.ax-task-page__ask-head { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); }
.ax-task-page__ask-who { color: var(--ax-text-2); font-weight: 600; }
.ax-task-page__ask-when { margin-left: auto; color: var(--ax-muted); font-family: var(--ax-mono); }
.ax-task-page__ask-body {
  margin-top: 8px; font-size: var(--ax-fs-sm); line-height: 1.55; color: var(--ax-text);
  word-break: break-word; max-height: 200px; overflow: auto;
}
/* Same markdown rhythm as a reply block. */
.ax-task-page__ask-body > *:first-child { margin-top: 0; }
.ax-task-page__ask-body > *:last-child { margin-bottom: 0; }
.ax-task-page__ask-body p { margin: 0 0 8px; white-space: pre-wrap; }
.ax-task-page__ask-body ul, .ax-task-page__ask-body ol { margin: 0 0 8px; padding-left: 20px; }
.ax-task-page__ask-body code {
  font-family: var(--ax-mono); font-size: 0.92em; padding: 1px 5px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 5px;
}

/* Markdown inside a reply. Tight vertical rhythm — a reply is a block in a
   stream, not a document, so headings and paragraphs must not push the next
   event off the screen. */
.ax-ev__text > *:first-child { margin-top: 0; }
.ax-ev__text > *:last-child { margin-bottom: 0; }
.ax-ev__text p { margin: 0 0 8px; white-space: pre-wrap; }
.ax-ev__text h3, .ax-ev__text h4, .ax-ev__text h5, .ax-ev__text h6 {
  margin: 12px 0 6px; font-size: var(--ax-fs); font-weight: 700; color: var(--ax-text);
}
.ax-ev__text ul, .ax-ev__text ol { margin: 0 0 8px; padding-left: 20px; }
.ax-ev__text li { margin: 2px 0; }
.ax-ev__text code {
  font-family: var(--ax-mono); font-size: 0.92em; padding: 1px 5px;
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 5px; color: var(--ax-text);
}
.ax-ev__text pre code { background: none; border: none; padding: 0; }
.ax-ev__text strong { color: var(--ax-text); font-weight: 700; }

/* Stream events. The agent's output is not a wall of text — it is a sequence
   of tool calls, results, internal reasoning and replies. Rendering each as
   its own block with a coloured rail makes a long run scannable: you can find
   the tool that failed without reading everything above it. */
.ax-ev { border-left: 2px solid var(--ax-border-2); padding: 2px 0 2px 12px; }
.ax-ev--tool { border-color: var(--ax-info); }
.ax-ev--tool-result { border-color: var(--ax-border-2); }
.ax-ev--tool-result.is-err { border-color: var(--ax-err); }
.ax-ev--thought { border-color: var(--ax-muted); }
.ax-ev--text { border-color: var(--ax-accent); }
.ax-ev--system {
  border-color: var(--ax-border-2); color: var(--ax-muted); font-size: var(--ax-fs-xs);
  font-family: var(--ax-mono); padding-top: 4px; padding-bottom: 4px;
}
.ax-ev--system.is-done { border-color: var(--ax-accent); }
.ax-ev--error { border-color: var(--ax-err); }
.ax-ev__head { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.ax-ev__label { text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; font-family: var(--ax-mono); }
.ax-ev__label--soft { color: var(--ax-muted); }
.ax-ev__label--tool { color: var(--ax-info); }
.ax-ev__label--result { color: var(--ax-muted); }
.ax-ev__label--text { color: var(--ax-accent); }
.ax-ev__label--error { color: var(--ax-err); }
.ax-ev__time { margin-left: auto; font-family: var(--ax-mono); color: var(--ax-muted); }
.ax-ev__tool { font-family: var(--ax-mono); color: var(--ax-info); font-size: var(--ax-fs-xs); }
.ax-ev__code {
  margin: 4px 0 0; padding: 8px 10px; background: var(--ax-bg-elev);
  border: 1px solid var(--ax-border); border-radius: 3px; font-family: var(--ax-mono);
  font-size: var(--ax-fs-xs); white-space: pre-wrap; word-break: break-word;
  line-height: 1.5; color: var(--ax-text-2); max-height: 200px; overflow: auto;
}
.ax-ev__code--muted { color: var(--ax-muted); }
.ax-ev__code--err { color: var(--ax-err); border-color: color-mix(in oklch, var(--ax-err) 35%, var(--ax-border)); }
.ax-ev__thought {
  margin-top: 4px; color: var(--ax-text-2); font-style: italic;
  font-size: var(--ax-fs-sm); line-height: 1.55; text-wrap: pretty;
}
.ax-ev__text {
  margin-top: 4px; color: var(--ax-text); font-size: var(--ax-fs-sm);
  line-height: 1.55; text-wrap: pretty; white-space: pre-wrap; word-break: break-word;
}

/* The Task page (#1381): the classic task page in the Wall's column. */
.wtask { max-width: none; margin: 0; padding: 12px 16px 24px; min-height: 0; gap: 12px; }
.wtask__head { display: flex; gap: 10px; align-items: flex-start; }
.wtask__who { flex: 1; min-width: 0; }
.wtask__who .h { color: var(--ax-muted); }
.wtask__meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wtask__h { font-size: var(--ax-fs); font-weight: 800; margin: 4px 0 0; }
.wtask__open { font-size: var(--ax-fs-xs); font-weight: 400; margin-left: 6px; }
.wtask__req { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px 14px; }
.wtask__req .wtask__h { margin: 0 0 10px; }
.wtask__out { box-shadow: none; min-height: 260px; max-height: 62vh; }
/* A chat box right under the conversation, which scrolls on its own. */
.wtask__stop { color: var(--ax-err); border-color: color-mix(in srgb, var(--ax-err) 45%, var(--ax-border)); }
.wtask__ops.wlv { padding: 0; }
.wtask__ops .wls { margin: 0; }
.wtask__pause { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wtask__ro { margin: 0; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.ax-task-page__compose:not([hidden]) ~ .wtask__ro { display: none; }
/* The run's session (#2101 R4): the chat's other turns, quieter than the
   selected run, which keeps the full stream and the accent. */
.wtask__turn[hidden], .wsess[hidden] { display: none; }
.ax-task-page__ask.is-selected { border-color: var(--ax-accent); }
.ax-task-page__ask.is-selected .ax-ev__label { color: var(--ax-accent); font-weight: 700; }
.wtask__turn { margin-top: 4px; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-accent); }
.wsess { display: flex; flex-direction: column; gap: 8px; }
.wsess__turn {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-surface);
}
.wsess__ask { border-left: 3px solid var(--ax-border-2); padding-left: 10px; }
.wsess__reply { border-left: 2px solid var(--ax-accent); padding-left: 10px; }
.wsess__reply.is-err { border-color: var(--ax-err); }
.wsess__reply.is-running { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wsess__head { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wsess__who { font-weight: 600; }
.wsess__when { margin-left: auto; font-family: var(--ax-mono); color: var(--ax-muted); }
.wsess__body { margin-top: 4px; font-size: var(--ax-fs-sm); line-height: 1.55; color: var(--ax-text); word-break: break-word; max-height: 240px; overflow: auto; }
.wsess__body > *:first-child { margin-top: 0; }
.wsess__body > *:last-child { margin-bottom: 0; }
.wsess__open { align-self: flex-end; font-size: var(--ax-fs-xs); }
.wsess__gap { display: flex; justify-content: center; padding: 2px 0; }
.wsess__none { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
/* An earlier turn folded to its ask (#2101): one click opens it. */
.wsess__fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-surface); font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.wsess__fold > summary::-webkit-details-marker { display: none; }
.wsess__fold > summary::before { content: "›"; color: var(--ax-muted); transition: transform .12s; }
.wsess__fold[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; }
.wsess__fold[open] > summary::before { transform: rotate(90deg); }
.wsess__fold[open] > .wsess__turn { border-top-left-radius: 0; border-top-right-radius: 0; border-top: 0; }
.wsess__foldask { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsess__foldn { flex: none; font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
/* Jump to latest sits on the output's bottom edge, centred (#2101). */
.wtask__jump { position: relative; height: 0; }
.wtask__jump .ax-jump { bottom: 12px; }
@media (max-width: 640px) { .wtask { padding: 10px 12px 18px; } .wtask__out { max-height: none; } .wsess__turn { padding: 8px 10px; } }
`
