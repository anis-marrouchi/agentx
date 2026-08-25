import { renderShell, esc, type TopbarPeer } from ".."

// --- Task page — watch one agent work ---
//
// Replaces the full-screen `#task-modal` on Live, which streamed this SSE
// endpoint into a box you couldn't link to, couldn't reload, and couldn't
// keep open next to anything else.
//
// (An earlier note here claimed it also replaced the agent page's `#td-panel`.
// It doesn't — that drawer is the Test-drive sandbox, a different feature that
// still needs its own page.)
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
// Reads: GET /api/task/stream?node=&agent=&task=   (SSE: start / chunk / end)
// Writes: POST /api/task/action?node=&task=&kind=cancel|followup

export interface TaskPageOpts {
  taskId: string
  agentId: string
  agentName?: string
  nodeUrl: string
  channel?: string
  /** Finished task opened from history: read the stored record once instead
   *  of holding an SSE connection open for a stream that will never arrive. */
  archived?: boolean
  /** The request, when the caller already knows it. A live task's stream never
   *  replays what was asked, so Live passes it through the URL. */
  ask?: string
  askAt?: string
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderTaskPage(opts: TaskPageOpts): string {
  const who = opts.agentName || opts.agentId

  const body = `<div class="ax-task-page"
     data-task-id="${esc(opts.taskId)}"
     data-agent-id="${esc(opts.agentId)}"
     data-node-url="${esc(opts.nodeUrl)}"
     data-archived="${opts.archived ? "1" : ""}"
     data-ask="${esc(opts.ask || "")}"
     data-ask-at="${esc(opts.askAt || "")}">

  <header class="ax-task-page__head">
    <nav class="ax-crumbs" aria-label="Breadcrumb">
      <a href="/live">Live</a>
      <span class="ax-crumbs__sep">/</span>
      <a href="/agents/${esc(opts.agentId)}/history?node=${encodeURIComponent(opts.nodeUrl)}&name=${encodeURIComponent(who)}"><span class="ax-mention">@${esc(opts.agentId)}</span></a>
      <span class="ax-crumbs__sep">/</span>
      <span class="ax-crumbs__here">Task</span>
    </nav>
    <div class="ax-task-page__meta">
      ${opts.channel ? `<span class="ax-badge ax-badge--mono ax-badge--ghost">${esc(opts.channel)}</span>` : ""}
      <span class="ax-badge ax-badge--mono" id="task-status">connecting…</span>
      <span class="ax-mono ax-muted" id="task-elapsed"></span>
    </div>
  </header>

  <section class="ax-task-page__ask" id="task-ask" hidden>
    <div class="ax-task-page__ask-head">
      <span class="ax-ev__label ax-ev__label--soft">request</span>
      <span class="ax-task-page__ask-who" id="task-ask-who"></span>
      <span class="ax-task-page__ask-when" id="task-ask-when"></span>
    </div>
    <div class="ax-task-page__ask-body" id="task-ask-body"></div>
  </section>

  <div class="ax-task-page__output" id="task-output"></div>

  <footer class="ax-task-page__compose"${opts.archived ? " hidden" : ""}>
    <textarea id="task-input" class="ax-task-page__input" rows="2"
      placeholder="Send a message to this chat — the current turn keeps running, your message dispatches as the next turn. ⌘/Ctrl+Enter to send."></textarea>
    <div class="ax-task-page__actions">
      <span class="ax-task-page__hint" id="task-hint"></span>
      <button type="button" id="task-stop" class="ax-btn ax-btn--danger">✕ stop</button>
      <button type="button" id="task-send" class="ax-btn ax-btn--primary">send →</button>
    </div>
  </footer>
</div>`

  return renderShell({
    title: `AgentX · ${who}`,
    activeTab: "live",
    subtitle: "Task",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: TASK_PAGE_CSS,
    scripts: `<script>${TASK_PAGE_JS}</script>`,
  })
}

const TASK_PAGE_CSS = `
/* The shell gives <main> no padding, so page content butted straight against
   the sticky topbar. Breathe. */
.ax-task-page {
  display: flex; flex-direction: column; gap: var(--ax-gap);
  max-width: 1000px; margin: 0 auto; padding: 22px var(--ax-pad) var(--ax-pad);
  min-height: calc(100vh - 130px);
}
/* Breadcrumb, not a back button — it says where you are, and every step up is
   somewhere you can actually go. */
.ax-crumbs { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-sm); min-width: 0; }
.ax-crumbs a { color: var(--ax-text-2); font-weight: 600; text-decoration: none; }
.ax-crumbs a:hover { color: var(--ax-accent); text-decoration: none; }
.ax-crumbs__sep { color: var(--ax-border-2); }
.ax-crumbs__here { color: var(--ax-text); font-weight: 700; }
.ax-task-page__head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--ax-gap); flex-wrap: wrap;
}
.ax-task-page__who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ax-task-page__back { font-size: var(--ax-fs-sm); font-weight: 600; white-space: nowrap; }
.ax-task-page__name { color: var(--ax-text-2); }
.ax-task-page__meta { display: flex; align-items: center; gap: 8px; }
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
.ax-ev__text pre.ax-ev__code code { background: none; border: none; padding: 0; }
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

`

const TASK_PAGE_JS = `
(function () {
  var root = document.querySelector('.ax-task-page');
  if (!root) return;
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

  var buffer = '';
  var raf = 0;
  var startedAt = Date.now();
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

  // --- Minimal markdown for assistant replies ---
  //
  // Agents answer in markdown, and the stream used to render it as literal
  // characters: **bold**, backticks and fenced blocks all showed as source.
  //
  // Deliberately small and dependency-free — this is a self-hosted dashboard
  // with a strict no-CDN posture, and a full parser is not worth a bundle for
  // bold/code/lists/headings/links, which is what replies actually contain.
  //
  // SECURITY: escape first, THEN apply markup. Agent output is text from the
  // outside world (a Telegram message can steer what an agent echoes), so it
  // must never be able to inject HTML. Fenced blocks are extracted before any
  // inline pass so their contents are never treated as markup.
  function mdToHtml(src) {
    var fences = [];
    var text = String(src == null ? '' : src).replace(/\\u0060\\u0060\\u0060([\\s\\S]*?)\\u0060\\u0060\\u0060/g, function (_m, code) {
      fences.push(code.replace(/^[a-zA-Z0-9_-]*\\n/, ''));
      return '\\u0000FENCE' + (fences.length - 1) + '\\u0000';
    });

    text = esc(text);

    // Block level, line by line.
    var lines = text.split('\\n');
    var out = [];
    var listOpen = null;
    var para = [];
    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.join('\\n') + '</p>');
      para = [];
    }
    // Note: closing a list must NOT flush the open paragraph — closeList()
    // runs before every plain line, so doing both here emitted one <p> per
    // line and defeated the grouping entirely. Callers flush explicitly.
    function closeList() { if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var h = ln.match(/^(#{1,4})\\s+(.*)$/);
      if (h) { flushPara(); closeList(); out.push('<h' + (h[1].length + 2) + '>' + inline(h[2]) + '</h' + (h[1].length + 2) + '>'); continue; }
      var ul = ln.match(/^\\s*[-*]\\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listOpen !== 'ul') { closeList(); out.push('<ul>'); listOpen = 'ul'; }
        out.push('<li>' + inline(ul[1]) + '</li>'); continue;
      }
      var ol = ln.match(/^\\s*\\d+\\.\\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listOpen !== 'ol') { closeList(); out.push('<ol>'); listOpen = 'ol'; }
        out.push('<li>' + inline(ol[1]) + '</li>'); continue;
      }
      closeList();
      if (ln.trim() === '') { flushPara(); continue; }
      // Consecutive non-blank lines are ONE paragraph, not one each. Agents
      // dump JSON and log tails into replies; a <p> per line turned those into
      // a column of double-spaced fragments. Blank lines still break.
      para.push(inline(ln));
    }
    flushPara();
    closeList();

    var html = out.join('\\n');
    // Restore fenced blocks last so nothing inside them was ever parsed.
    html = html.replace(/(?:<p>)?\\u0000FENCE(\\d+)\\u0000(?:<\\/p>)?/g, function (_m, n) {
      return '<pre class="ax-ev__code">' + esc(fences[Number(n)]) + '</pre>';
    });
    return html;
  }

  function inline(s) {
    return s
      .replace(/\\u0060([^\\u0060]+)\\u0060/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>')
      // Links: only http(s), and the label is already escaped.
      .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,
               '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

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
      '<div class="ax-ev__head"><span class="ax-ev__label ax-ev__label--tool">tool call</span>' +
      '<span class="ax-ev__tool">' + esc(name) + '</span></div>' +
      (args ? '<pre class="ax-ev__code">' + esc(args) + '</pre>' : ''));
  }
  function toolResult(text) {
    closeText();
    var isErr = text.indexOf('[error] ') === 0;
    var body = isErr ? text.slice(8) : text;
    block('ax-ev--tool-result' + (isErr ? ' is-err' : ''),
      label('result', isErr ? 'tool error' : 'tool result') +
      '<pre class="ax-ev__code ' + (isErr ? 'ax-ev__code--err' : 'ax-ev__code--muted') + '">' +
      esc(body) + '</pre>');
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
    if (openText) openText.innerHTML = mdToHtml(openRaw);
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
    var atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 60;
    lineBuf += buffer;
    buffer = '';
    var lines = lineBuf.split('\\n');
    lineBuf = lines.pop();
    for (var i = 0; i < lines.length; i++) processLine(lines[i]);
    if (atBottom) outputEl.scrollTop = outputEl.scrollHeight;
  }
  function append(text) {
    if (!text) return;
    buffer += text;
    if (!raf) raf = requestAnimationFrame(flush);
  }
  /** Render whatever partial line is left. Call when the stream ends. */
  function drain() {
    flush();
    if (lineBuf) { processLine(lineBuf); lineBuf = ''; }
    renderOpenText();
  }

  /** Render the request that started this run. Hidden until we have one —
   *  an empty labelled box is worse than no box. */
  function showAsk(message, sender, startedAt) {
    var text = (message || '').trim();
    if (!text) return;
    document.getElementById('task-ask-body').innerHTML = mdToHtml(text);
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
  setInterval(tickElapsed, 1000);
  tickElapsed();

  // A request handed over by the caller renders immediately, before any
  // stream data arrives — so the page never shows work without the ask.
  var seededAsk = root.getAttribute('data-ask');
  if (seededAsk) showAsk(seededAsk, '', root.getAttribute('data-ask-at'));

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
    return;
  }

  var url = '/api/task/stream?node=' + encodeURIComponent(nodeUrl)
    + '&agent=' + encodeURIComponent(agentId)
    + '&task=' + encodeURIComponent(taskId);
  var es;
  try { es = new EventSource(url); } catch (e) { setStatus('connect failed', 'err'); return; }

  es.addEventListener('start', function (ev) {
    setStatus('live', 'live');
    try {
      var d = JSON.parse(ev.data);
      if (d.message || d.sender) showAsk(d.message, d.sender, d.startedAt);
      if (d.initial) append(d.initial);
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

  function action(kind, message) {
    var q = '/api/task/action?node=' + encodeURIComponent(nodeUrl)
      + '&task=' + encodeURIComponent(taskId) + '&kind=' + encodeURIComponent(kind);
    return fetch(q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message ? { message: message } : {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  sendBtn.addEventListener('click', function () {
    var text = (inputEl.value || '').trim();
    if (!text) { inputEl.focus(); return; }
    sendBtn.disabled = true;
    hintEl.textContent = 'queuing…';
    action('followup', text).then(function (r) {
      sendBtn.disabled = false;
      if (r && r.error) { hintEl.textContent = 'failed: ' + r.error; return; }
      inputEl.value = '';
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
})();
`
