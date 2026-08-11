import { renderShell, esc, type TopbarPeer } from ".."

// --- Task page — watch one agent work ---
//
// Replaces two overlays that showed the same thing in two different ways:
// the full-screen `#task-modal` on Live, and the `#td-panel` right drawer on
// the agent page. Both streamed the same SSE endpoint into a box you couldn't
// link to, couldn't reload, and couldn't keep open next to anything else.
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
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderTaskPage(opts: TaskPageOpts): string {
  const who = opts.agentName || opts.agentId

  const body = `<div class="ax-task-page"
     data-task-id="${esc(opts.taskId)}"
     data-agent-id="${esc(opts.agentId)}"
     data-node-url="${esc(opts.nodeUrl)}">

  <header class="ax-task-page__head">
    <div class="ax-task-page__who">
      <a class="ax-task-page__back" href="/live">← Live</a>
      <span class="ax-mention">@${esc(opts.agentId)}</span>
      <span class="ax-task-page__name">${esc(who)}</span>
    </div>
    <div class="ax-task-page__meta">
      ${opts.channel ? `<span class="ax-badge ax-badge--mono ax-badge--ghost">${esc(opts.channel)}</span>` : ""}
      <span class="ax-badge ax-badge--mono" id="task-status">connecting…</span>
      <span class="ax-mono ax-muted" id="task-elapsed"></span>
    </div>
  </header>

  <div class="ax-task-page__output" id="task-output"></div>

  <footer class="ax-task-page__compose">
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
.ax-task-page {
  display: flex; flex-direction: column; gap: var(--ax-gap);
  max-width: 1000px; margin: 0 auto; min-height: calc(100vh - 130px);
}
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
  flex: 1; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
  background: var(--ax-surface); color: var(--ax-text-2);
  border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius-lg); box-shadow: var(--ax-shadow);
  padding: var(--ax-pad); font-family: var(--ax-mono);
  font-size: var(--ax-fs-sm); line-height: 1.6; min-height: 320px;
}
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

  // Batch appends through requestAnimationFrame — a chatty agent can emit
  // hundreds of chunks a second and one DOM write per chunk drops frames.
  function flush() {
    raf = 0;
    if (!buffer) return;
    var atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
    outputEl.appendChild(document.createTextNode(buffer));
    buffer = '';
    if (atBottom) outputEl.scrollTop = outputEl.scrollHeight;
  }
  function append(text) {
    if (!text) return;
    buffer += text;
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function tickElapsed() {
    if (finished) return;
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var m = Math.floor(s / 60);
    elapsedEl.textContent = m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
  }
  setInterval(tickElapsed, 1000);
  tickElapsed();

  var url = '/api/task/stream?node=' + encodeURIComponent(nodeUrl)
    + '&agent=' + encodeURIComponent(agentId)
    + '&task=' + encodeURIComponent(taskId);
  var es;
  try { es = new EventSource(url); } catch (e) { setStatus('connect failed', 'err'); return; }

  es.addEventListener('start', function (ev) {
    setStatus('live', 'live');
    try {
      var d = JSON.parse(ev.data);
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
    flush();
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
