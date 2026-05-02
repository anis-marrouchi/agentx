import { renderShell, esc, type TopbarPeer } from ".."

// --- Inbox page ---
//
// Per-actor (or global) list of open user-tasks with an inline form
// renderer. Reads /api/workflows/tasks; submits via
// POST /api/workflows/tasks/:id/submit.
//
// Scope is intentionally tight for Phase 1:
//   - text / long-text / number / boolean / select / multi-select / date
//   - primary + optional secondary action buttons
//   - required-field validation is server-side; the UI just relays errors
//
// No channel-adapter coupling here — the form UI is the same whether the
// renderer ran on Telegram or not.

export interface InboxPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
  /** Optional actor id to pre-filter. When unset, the page shows a prompt
   *  asking the user to pick their actor id. */
  actor?: string
}

export function renderInboxPage(opts: InboxPageOpts = {}): string {
  const body = `<div class="ax-inbox__root" data-actor="${esc(opts.actor ?? "")}">
  <aside class="ax-inbox__list">
    <header>
      <h2>Inbox</h2>
      <button id="inbox-refresh" class="ax-inbox__icon" title="Refresh (r)">↻</button>
    </header>
    <div class="ax-inbox__actor">
      <label>Actor <input id="inbox-actor" type="text" placeholder="actor:<id>" value="${esc(opts.actor ?? "")}" autocomplete="off" /></label>
    </div>
    <ul id="inbox-tasks" class="ax-inbox__cards" aria-live="polite"></ul>
    <div id="inbox-empty" class="ax-inbox__empty" hidden>
      <p>No open tasks.</p>
      <p class="hint">Set the actor filter to see tasks assigned to you, or leave blank for all tasks in the system.</p>
    </div>
  </aside>

  <section class="ax-inbox__detail">
    <header id="inbox-detail-head">
      <span class="hint">Select a task to open its form.</span>
      <button id="inbox-history-toggle" type="button" style="margin-left:auto;font-size:11px;padding:4px 10px;border:1px solid var(--ax-border);border-radius:4px;background:var(--ax-bg);color:var(--ax-fg);cursor:pointer">Show completed history</button>
    </header>
    <div id="inbox-detail-body" class="ax-inbox__detail-body"></div>
    <div id="inbox-history" class="ax-inbox__detail-body" style="display:none;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0;font-family:'IBM Plex Sans',sans-serif;font-size:13px;font-weight:600">Completed user-tasks (most recent first)</h3>
        <span style="font-size:11px;color:var(--ax-muted)">SLA breaches highlighted in red</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;font-family:'IBM Plex Mono',monospace">
        <thead><tr style="text-align:left;color:var(--ax-muted);text-transform:uppercase;letter-spacing:0.04em;font-size:10px"><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">submitted</th><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">workflow</th><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">title</th><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">by</th><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">duration</th><th style="padding:5px 7px;border-bottom:1px solid var(--ax-border)">sla</th></tr></thead>
        <tbody id="inbox-history-rows"></tbody>
      </table>
      <p id="inbox-history-empty" style="font-size:11px;color:var(--ax-muted);font-style:italic;margin:14px 0 0;display:none">no completed user-tasks yet</p>
    </div>
  </section>
</div>

<div id="inbox-toast" class="ax-inbox__toast" hidden></div>`

  return renderShell({
    title: "AgentX · Inbox",
    activeTab: "workflows",
    subtitle: "Inbox",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: INBOX_PAGE_CSS,
    scripts: `<script>${INBOX_PAGE_SCRIPT}</script>`,
  })
}

const INBOX_PAGE_CSS = `
.ax-inbox__root {
  display: grid;
  grid-template-columns: 340px 1fr;
  height: calc(100vh - var(--ax-topbar-h, 48px));
  background: var(--ax-bg);
}
.ax-inbox__list {
  border-right: 1px solid var(--ax-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ax-inbox__list > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ax-border);
}
.ax-inbox__list > header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.ax-inbox__actor {
  padding: 10px 14px;
  border-bottom: 1px solid var(--ax-border);
}
.ax-inbox__actor label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ax-muted); }
.ax-inbox__actor input {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--ax-border);
  border-radius: 6px;
  background: var(--ax-bg);
  color: var(--ax-fg);
}
.ax-inbox__cards { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; }
.ax-inbox__card {
  padding: 10px 12px;
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}
.ax-inbox__card:hover { background: var(--ax-surface-2, rgba(127,127,127,0.08)); }
.ax-inbox__card.is-active { background: var(--ax-surface-2); border-color: var(--ax-border); }
.ax-inbox__card-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.ax-inbox__card-meta { font-size: 11px; color: var(--ax-muted); }
.ax-inbox__card-due { font-size: 11px; color: #d48a00; margin-top: 4px; }
.ax-inbox__empty { padding: 20px; color: var(--ax-muted); text-align: center; font-size: 13px; }
.ax-inbox__detail { display: flex; flex-direction: column; min-height: 0; }
.ax-inbox__detail > header { padding: 14px 18px; border-bottom: 1px solid var(--ax-border); }
.ax-inbox__detail-body { overflow-y: auto; padding: 18px; flex: 1; }
.ax-inbox__form { max-width: 560px; display: grid; gap: 14px; }
.ax-inbox__field { display: flex; flex-direction: column; gap: 4px; }
.ax-inbox__field label { font-size: 12px; color: var(--ax-muted); font-weight: 600; }
.ax-inbox__field input, .ax-inbox__field textarea, .ax-inbox__field select {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--ax-border);
  border-radius: 6px;
  background: var(--ax-bg);
  color: var(--ax-fg);
}
.ax-inbox__field textarea { min-height: 100px; resize: vertical; }
.ax-inbox__field-hint { font-size: 11px; color: var(--ax-muted); }
.ax-inbox__field-error { font-size: 11px; color: #c0392b; }
.ax-inbox__actions { display: flex; gap: 8px; margin-top: 8px; }
.ax-inbox__actions button {
  font: inherit;
  padding: 8px 14px;
  border: 1px solid var(--ax-border);
  border-radius: 6px;
  cursor: pointer;
  background: var(--ax-surface-2);
  color: var(--ax-fg);
}
.ax-inbox__actions button.is-primary {
  background: #2ecc71; color: white; border-color: #27ae60;
}
.ax-inbox__actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.ax-inbox__icon {
  background: none; border: 1px solid transparent; color: var(--ax-fg); cursor: pointer;
  font-size: 14px; padding: 4px 8px; border-radius: 4px;
}
.ax-inbox__icon:hover { background: var(--ax-surface-2); }
.ax-inbox__toast {
  position: fixed; bottom: 16px; right: 16px; padding: 10px 14px;
  background: var(--ax-fg); color: var(--ax-bg); border-radius: 6px;
  font-size: 13px; z-index: 100;
}
`

// Deliberately vanilla JS — no framework dep. Fetches task list, renders
// per-field inputs, POSTs submission.
const INBOX_PAGE_SCRIPT = `
(function(){
  const $ = (sel) => document.querySelector(sel);
  const state = { tasks: [], selected: null, actor: document.querySelector('.ax-inbox__root').dataset.actor || '' };
  const toast = (msg) => {
    const el = $('#inbox-toast');
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 2500);
  };

  async function fetchTasks() {
    const qs = state.actor ? ('?actor=' + encodeURIComponent(state.actor)) : '';
    try {
      const r = await fetch('/api/workflows/tasks' + qs, { credentials: 'same-origin' });
      if (!r.ok) { toast('fetch failed: ' + r.status); return; }
      const data = await r.json();
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      renderList();
      if (state.selected && !state.tasks.find(t => t.id === state.selected)) {
        state.selected = null;
        renderDetail();
      }
    } catch (e) { toast('fetch error: ' + e.message); }
  }

  function renderList() {
    const ul = $('#inbox-tasks');
    const empty = $('#inbox-empty');
    ul.innerHTML = '';
    if (!state.tasks.length) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const t of state.tasks) {
      const li = document.createElement('li');
      li.className = 'ax-inbox__card' + (t.id === state.selected ? ' is-active' : '');
      li.innerHTML =
        '<div class="ax-inbox__card-title">' + escHtml(t.title) + '</div>' +
        '<div class="ax-inbox__card-meta">' + escHtml(t.assignee) + ' · ' + escHtml(t.workflowId) + '</div>' +
        (t.dueAt ? ('<div class="ax-inbox__card-due">due ' + new Date(t.dueAt).toLocaleString() + '</div>') : '');
      li.addEventListener('click', () => { state.selected = t.id; renderList(); renderDetail(); });
      ul.appendChild(li);
    }
  }

  function renderDetail() {
    const head = $('#inbox-detail-head');
    const body = $('#inbox-detail-body');
    const t = state.tasks.find(x => x.id === state.selected);
    if (!t) {
      head.innerHTML = '<span class="hint">Select a task to open its form.</span>';
      body.innerHTML = '';
      return;
    }
    head.innerHTML = '<h2 style="margin:0;font-size:15px">' + escHtml(t.title) + '</h2>' +
      (t.description ? '<p class="hint" style="margin:6px 0 0">' + escHtml(t.description) + '</p>' : '');
    const form = document.createElement('form');
    form.className = 'ax-inbox__form';
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(t, 'primary'); });
    for (const field of (t.form.fields || [])) {
      form.appendChild(renderField(field));
    }
    const actions = document.createElement('div');
    actions.className = 'ax-inbox__actions';
    const primary = document.createElement('button');
    primary.type = 'submit';
    primary.className = 'is-primary';
    primary.textContent = t.form.submitLabel || 'Submit';
    actions.appendChild(primary);
    if (t.form.secondaryAction) {
      const secondary = document.createElement('button');
      secondary.type = 'button';
      secondary.textContent = t.form.secondaryAction.label;
      secondary.addEventListener('click', () => submit(t, 'secondary'));
      actions.appendChild(secondary);
    }
    form.appendChild(actions);
    body.innerHTML = '';
    body.appendChild(form);
  }

  function renderField(field) {
    const wrap = document.createElement('div');
    wrap.className = 'ax-inbox__field';
    const label = document.createElement('label');
    label.textContent = field.label + (field.required ? ' *' : '');
    wrap.appendChild(label);
    let input;
    switch (field.type) {
      case 'long-text':
        input = document.createElement('textarea');
        break;
      case 'number':
        input = document.createElement('input'); input.type = 'number';
        break;
      case 'boolean':
        input = document.createElement('select');
        for (const v of ['', 'yes', 'no']) {
          const o = document.createElement('option'); o.value = v; o.textContent = v || '—';
          input.appendChild(o);
        }
        break;
      case 'date':
        input = document.createElement('input'); input.type = 'date';
        break;
      case 'select':
        input = document.createElement('select');
        if (!field.required) { const o = document.createElement('option'); o.value = ''; o.textContent = '—'; input.appendChild(o); }
        for (const opt of (field.options || [])) {
          const o = document.createElement('option'); o.value = opt; o.textContent = opt;
          input.appendChild(o);
        }
        break;
      case 'multi-select':
        input = document.createElement('select'); input.multiple = true; input.size = Math.min(6, (field.options||[]).length || 3);
        for (const opt of (field.options || [])) {
          const o = document.createElement('option'); o.value = opt; o.textContent = opt;
          input.appendChild(o);
        }
        break;
      case 'file':
        input = document.createElement('input'); input.type = 'text'; input.placeholder = 'URL or path';
        break;
      default:
        input = document.createElement('input'); input.type = 'text';
    }
    input.name = field.key;
    if (field.defaultValue !== undefined && field.type !== 'multi-select') input.value = String(field.defaultValue);
    wrap.appendChild(input);
    if (field.hint) {
      const hint = document.createElement('div');
      hint.className = 'ax-inbox__field-hint';
      hint.textContent = field.hint;
      wrap.appendChild(hint);
    }
    const err = document.createElement('div');
    err.className = 'ax-inbox__field-error';
    err.dataset.for = field.key;
    wrap.appendChild(err);
    return wrap;
  }

  async function submit(task, action) {
    const form = $('.ax-inbox__form');
    if (!form) return;
    const values = {};
    for (const field of (task.form.fields || [])) {
      const el = form.querySelector('[name="' + field.key + '"]');
      if (!el) continue;
      if (field.type === 'multi-select') {
        values[field.key] = Array.from(el.selectedOptions).map(o => o.value);
      } else if (field.type === 'boolean') {
        values[field.key] = el.value;
      } else {
        values[field.key] = el.value;
      }
    }
    form.querySelectorAll('.ax-inbox__field-error').forEach(e => { e.textContent = ''; });
    try {
      const r = await fetch('/api/workflows/tasks/' + encodeURIComponent(task.id) + '/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submittedBy: state.actor || 'anonymous', submission: { action, values } }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data.fieldErrors && Array.isArray(data.fieldErrors)) {
          for (const fe of data.fieldErrors) {
            const node = form.querySelector('[data-for="' + fe.field + '"]');
            if (node) node.textContent = fe.message;
          }
          toast('form has errors');
        } else {
          toast(data.error || 'submit failed');
        }
        return;
      }
      toast('submitted');
      state.selected = null;
      fetchTasks();
    } catch (e) { toast('submit error: ' + e.message); }
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  $('#inbox-actor').addEventListener('change', (e) => {
    state.actor = e.target.value.trim();
    state.selected = null;
    const url = new URL(window.location.href);
    if (state.actor) url.searchParams.set('actor', state.actor); else url.searchParams.delete('actor');
    history.replaceState({}, '', url.toString());
    fetchTasks();
  });
  $('#inbox-refresh').addEventListener('click', fetchTasks);

  // History toggle — surfaces the SLA-aware completion log.
  let historyOpen = false;
  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function fmtTs(s) {
    if (!s) return '—';
    return s.replace('T', ' ').slice(0, 16);
  }
  async function loadHistory() {
    try {
      const r = await fetch('/api/workflows/tasks/history?limit=100');
      const data = await r.json();
      const rows = data.rows || [];
      const tbody = $('#inbox-history-rows');
      const empty = $('#inbox-history-empty');
      if (rows.length === 0) { empty.style.display = ''; tbody.innerHTML = ''; return; }
      empty.style.display = 'none';
      tbody.innerHTML = rows.map(function(r){
        const slaCell = r.dueAt
          ? (r.breachedSla
              ? '<span style="color:var(--ax-err,#e74c3c)">breached</span>'
              : '<span style="color:#2ecc71">on time</span>')
          : '<span style="color:var(--ax-muted)">—</span>';
        const rowStyle = r.breachedSla ? 'background:rgba(231,76,60,0.06)' : '';
        return '<tr style="' + rowStyle + '">' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + escHtml(fmtTs(r.submittedAt)) + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + escHtml(r.workflowId || '') + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + escHtml((r.title || '').slice(0, 60)) + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + escHtml(r.submittedBy || '') + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + escHtml(fmtDuration(r.durationMs)) + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid var(--ax-border)">' + slaCell + '</td>' +
        '</tr>';
      }).join('');
    } catch (e) {
      $('#inbox-history-empty').textContent = 'failed to load: ' + e.message;
      $('#inbox-history-empty').style.display = '';
    }
  }
  $('#inbox-history-toggle').addEventListener('click', () => {
    historyOpen = !historyOpen;
    $('#inbox-history').style.display = historyOpen ? 'block' : 'none';
    $('#inbox-detail-body').style.display = historyOpen ? 'none' : '';
    $('#inbox-history-toggle').textContent = historyOpen ? 'Show open inbox' : 'Show completed history';
    if (historyOpen) loadHistory();
  });

  fetchTasks();
  setInterval(fetchTasks, 10000);
})();
`
