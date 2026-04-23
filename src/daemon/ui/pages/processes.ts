import { renderShell, esc, type TopbarPeer } from ".."

// --- Processes dashboard ---
//
// Live view over workflow runs with composition-tree rendering and SLA
// indicators computed from userTasks' dueAt. Reads:
//   GET /api/workflows/runs       — list of recent runs
//   GET /api/workflows/tasks      — open user tasks
//   GET /api/workflows            — workflow definitions (for titles)

export interface ProcessesPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderProcessesPage(opts: ProcessesPageOpts = {}): string {
  const body = `<div class="ax-proc__kpis" id="proc-kpis" hidden></div>
<div class="ax-proc__root">
  <aside class="ax-proc__list">
    <header>
      <h2>Processes</h2>
      <button id="proc-refresh" class="ax-proc__icon" title="Refresh (r)">↻</button>
    </header>
    <div class="ax-proc__filter">
      <label>Status
        <select id="proc-status">
          <option value="">All</option>
          <option value="running">Running</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </label>
    </div>
    <ul id="proc-runs" class="ax-proc__cards" aria-live="polite"></ul>
    <div id="proc-empty" class="ax-proc__empty" hidden>
      <p>No runs yet.</p>
    </div>
  </aside>

  <section class="ax-proc__detail">
    <header id="proc-detail-head">
      <span class="hint">Select a process to see its composition tree and history.</span>
    </header>
    <div id="proc-detail-body" class="ax-proc__detail-body"></div>
  </section>
</div>

<div id="proc-toast" class="ax-proc__toast" hidden></div>`

  return renderShell({
    title: "AgentX · Processes",
    activeTab: "workflows",
    subtitle: "Processes",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: PROC_PAGE_CSS,
    scripts: `<script>${PROC_PAGE_SCRIPT}</script>`,
  })
}

const PROC_PAGE_CSS = `
.ax-proc__root {
  display: grid; grid-template-columns: 360px 1fr;
  height: calc(100vh - var(--ax-topbar-h, 48px));
  background: var(--ax-bg);
}
.ax-proc__list { border-right: 1px solid var(--ax-border); display: flex; flex-direction: column; min-height: 0; }
.ax-proc__list > header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--ax-border); }
.ax-proc__list > header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.ax-proc__filter { padding: 10px 14px; border-bottom: 1px solid var(--ax-border); }
.ax-proc__filter label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ax-muted); }
.ax-proc__filter select { font: inherit; padding: 6px 8px; border: 1px solid var(--ax-border); border-radius: 6px; background: var(--ax-bg); color: var(--ax-fg); }
.ax-proc__cards { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; }
.ax-proc__card { padding: 10px 12px; border-radius: 6px; margin-bottom: 4px; cursor: pointer; border: 1px solid transparent; }
.ax-proc__card:hover { background: var(--ax-surface-2, rgba(127,127,127,0.08)); }
.ax-proc__card.is-active { background: var(--ax-surface-2); border-color: var(--ax-border); }
.ax-proc__card-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.ax-proc__card-meta { font-size: 11px; color: var(--ax-muted); }
.ax-proc__status-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
.ax-proc__status-running { background: #3498db; color: white; }
.ax-proc__status-paused  { background: #f1c40f; color: #333; }
.ax-proc__status-completed { background: #27ae60; color: white; }
.ax-proc__status-failed { background: #e74c3c; color: white; }
.ax-proc__status-canceled { background: #95a5a6; color: white; }
.ax-proc__sla { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ax-proc__sla-green  { background: #27ae60; }
.ax-proc__sla-yellow { background: #f1c40f; }
.ax-proc__sla-red    { background: #e74c3c; }
.ax-proc__empty { padding: 20px; color: var(--ax-muted); text-align: center; font-size: 13px; }
.ax-proc__detail { display: flex; flex-direction: column; min-height: 0; }
.ax-proc__detail > header { padding: 14px 18px; border-bottom: 1px solid var(--ax-border); }
.ax-proc__detail-body { overflow-y: auto; padding: 18px; flex: 1; }
.ax-proc__tree { margin: 0 0 16px; font-family: var(--ax-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.6; }
.ax-proc__tree-row { padding: 2px 0; }
.ax-proc__tree-depth { display: inline-block; color: var(--ax-muted); }
.ax-proc__history { border-top: 1px solid var(--ax-border); padding-top: 12px; }
.ax-proc__history table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ax-proc__history th, .ax-proc__history td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--ax-border); }
.ax-proc__icon { background: none; border: 1px solid transparent; color: var(--ax-fg); cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px; }
.ax-proc__icon:hover { background: var(--ax-surface-2); }
.ax-proc__toast { position: fixed; bottom: 16px; right: 16px; padding: 10px 14px; background: var(--ax-fg); color: var(--ax-bg); border-radius: 6px; font-size: 13px; z-index: 100; }
.ax-proc__kpis {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--ax-border);
  background: var(--ax-surface-2, rgba(127,127,127,0.04));
}
.ax-proc__kpi { padding: 6px 10px; border-radius: 6px; background: var(--ax-bg); border: 1px solid var(--ax-border); }
.ax-proc__kpi-label { font-size: 11px; color: var(--ax-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.ax-proc__kpi-value { font-size: 20px; font-weight: 600; }
.ax-proc__kpi-breakdown { font-size: 11px; color: var(--ax-muted); margin-top: 2px; }
`

const PROC_PAGE_SCRIPT = `
(function(){
  const $ = (sel) => document.querySelector(sel);
  const state = { runs: [], tasks: [], workflows: [], selected: null, filter: '' };
  const toast = (msg) => { const el = $('#proc-toast'); el.textContent = msg; el.hidden = false; setTimeout(() => el.hidden = true, 2500); };

  async function refresh() {
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        fetch('/api/workflows/runs?limit=200', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/workflows/tasks', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ tasks: [] })),
        fetch('/api/workflows', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/workflows/kpis', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null),
      ]);
      state.runs = Array.isArray(r1.runs) ? r1.runs : [];
      state.tasks = Array.isArray(r2.tasks) ? r2.tasks : [];
      state.workflows = Array.isArray(r3.workflows) ? r3.workflows : [];
      renderKpis(r4);
      renderList();
      if (state.selected) renderDetail();
    } catch (e) { toast('refresh failed: ' + e.message); }
  }

  function formatDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return Math.round(ms/100)/10 + 's';
    if (ms < 3600000) return Math.round(ms/6000)/10 + 'm';
    return Math.round(ms/360000)/10 + 'h';
  }

  function renderKpis(kpis) {
    const el = $('#proc-kpis');
    if (!kpis || !kpis.totals) { el.hidden = true; return; }
    const t = kpis.totals;
    const breachPct = t.slaBreachRate == null ? '—' : Math.round(t.slaBreachRate * 100) + '%';
    const topActors = (kpis.byActor || []).slice(0, 3);
    el.hidden = false;
    el.innerHTML =
      kpiCard('Open tasks', t.openTasks, topActors.map(a => a.actorId + ': ' + a.openTasks).join(' · ')) +
      kpiCard('Completed', t.completedTasks, '') +
      kpiCard('Avg duration', formatDuration(t.avgDurationMs), '') +
      kpiCard('SLA breach', breachPct, t.breachedCount + ' tasks');
  }

  function kpiCard(label, value, breakdown) {
    return '<div class="ax-proc__kpi">' +
      '<div class="ax-proc__kpi-label">' + escHtml(label) + '</div>' +
      '<div class="ax-proc__kpi-value">' + escHtml(value) + '</div>' +
      (breakdown ? '<div class="ax-proc__kpi-breakdown">' + escHtml(breakdown) + '</div>' : '') +
      '</div>';
  }

  function workflowTitle(id) {
    const wf = state.workflows.find(w => w.id === id);
    return wf?.title || id;
  }

  function slaForRun(runId) {
    // Worst SLA across open tasks on this run: red > yellow > green > none.
    const tasks = state.tasks.filter(t => t.runId === runId && t.dueAt);
    if (!tasks.length) return null;
    const now = Date.now();
    let worst = 'green';
    for (const t of tasks) {
      const remaining = Date.parse(t.dueAt) - now;
      const windowMs = Math.max(1, Date.parse(t.dueAt) - Date.parse(t.createdAt));
      if (remaining <= 0) { worst = 'red'; break; }
      if (remaining / windowMs < 0.25 && worst !== 'red') worst = 'yellow';
    }
    return worst;
  }

  function renderList() {
    const ul = $('#proc-runs');
    const empty = $('#proc-empty');
    ul.innerHTML = '';
    const filter = state.filter;
    // Only show root runs in the list; children show inside the composition tree.
    const roots = state.runs.filter(r => !r.parentRunId && (!filter || r.status === filter));
    if (!roots.length) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const r of roots) {
      const sla = slaForRun(r.id);
      const li = document.createElement('li');
      li.className = 'ax-proc__card' + (r.id === state.selected ? ' is-active' : '');
      li.innerHTML =
        '<div class="ax-proc__card-title">' +
        '<span>' + escHtml(workflowTitle(r.workflowId)) + '</span>' +
        '<span>' +
        (sla ? '<span class="ax-proc__sla ax-proc__sla-' + sla + '" title="SLA"></span> ' : '') +
        '<span class="ax-proc__status-pill ax-proc__status-' + r.status + '">' + r.status + '</span>' +
        '</span></div>' +
        '<div class="ax-proc__card-meta">' + escHtml(r.id.slice(0, 8)) + ' · depth ' + (r.depth ?? 0) +
          (r.pausedAt ? ' · paused on ' + escHtml(r.pausedAt.kind) : '') + '</div>';
      li.addEventListener('click', () => { state.selected = r.id; renderList(); renderDetail(); });
      ul.appendChild(li);
    }
  }

  function renderDetail() {
    const head = $('#proc-detail-head');
    const body = $('#proc-detail-body');
    const root = state.runs.find(r => r.id === state.selected);
    if (!root) { head.innerHTML = '<span class="hint">Select a process.</span>'; body.innerHTML = ''; return; }

    head.innerHTML =
      '<h2 style="margin:0;font-size:15px">' + escHtml(workflowTitle(root.workflowId)) + '</h2>' +
      '<p class="hint" style="margin:6px 0 0">Run ' + escHtml(root.id) + ' · status <span class="ax-proc__status-pill ax-proc__status-' + root.status + '">' + root.status + '</span></p>';

    // Composition tree — walk all runs whose rootRunId equals root.id.
    const tree = state.runs.filter(r => (r.rootRunId || r.id) === root.id);
    // Build adjacency: parentRunId → children.
    const byParent = new Map();
    for (const r of tree) {
      const key = r.parentRunId || null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    }
    const render = (parentId, depth) => {
      const kids = byParent.get(parentId) || [];
      return kids.map(k => {
        const pad = '  '.repeat(depth);
        const sla = slaForRun(k.id);
        return '<div class="ax-proc__tree-row"><span class="ax-proc__tree-depth">' + pad + '└─ </span>' +
          '<a href="#" data-run="' + k.id + '">' + escHtml(workflowTitle(k.workflowId)) + '</a>' +
          ' <span class="ax-proc__status-pill ax-proc__status-' + k.status + '">' + k.status + '</span>' +
          (sla ? ' <span class="ax-proc__sla ax-proc__sla-' + sla + '" title="SLA"></span>' : '') +
          (k.pausedAt ? ' <span class="hint">paused: ' + escHtml(k.pausedAt.kind) + '</span>' : '') +
          '</div>' + render(k.id, depth + 1);
      }).join('');
    };

    const rootSla = slaForRun(root.id);
    const treeHtml =
      '<div class="ax-proc__tree"><div class="ax-proc__tree-row">' +
      escHtml(workflowTitle(root.workflowId)) +
      ' <span class="ax-proc__status-pill ax-proc__status-' + root.status + '">' + root.status + '</span>' +
      (rootSla ? ' <span class="ax-proc__sla ax-proc__sla-' + rootSla + '"></span>' : '') +
      '</div>' + render(root.id, 1) + '</div>';

    const openTasks = state.tasks.filter(t => (tree.some(r => r.id === t.runId)));
    const tasksHtml = openTasks.length ? ('<h3 style="margin:0 0 6px; font-size: 13px">Open tasks</h3><ul>' +
      openTasks.map(t => {
        const sla = t.dueAt ? (Date.parse(t.dueAt) < Date.now() ? 'red' : 'green') : null;
        return '<li>' + escHtml(t.title) + ' — assignee ' + escHtml(t.assignee) +
          (t.dueAt ? ' · due ' + new Date(t.dueAt).toLocaleString() : '') +
          (sla ? ' <span class="ax-proc__sla ax-proc__sla-' + sla + '"></span>' : '') +
          '</li>';
      }).join('') + '</ul>') : '';

    const historyHtml = '<div class="ax-proc__history"><h3 style="margin:0 0 6px; font-size: 13px">Root run history</h3>' +
      '<table><thead><tr><th>At</th><th>Node</th><th>Status</th><th>Note</th></tr></thead><tbody>' +
      (root.history || []).map(h =>
        '<tr><td>' + escHtml(new Date(h.at).toLocaleTimeString()) + '</td><td>' + escHtml(h.nodeId) + '</td><td>' + escHtml(h.status) + '</td><td>' + escHtml(h.note || '') + '</td></tr>'
      ).join('') +
      '</tbody></table></div>';

    body.innerHTML = treeHtml + tasksHtml + historyHtml;

    body.querySelectorAll('a[data-run]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); state.selected = a.dataset.run; renderList(); renderDetail(); });
    });
  }

  function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  $('#proc-refresh').addEventListener('click', refresh);
  $('#proc-status').addEventListener('change', (e) => { state.filter = e.target.value; renderList(); });
  refresh();
  setInterval(refresh, 5000);
})();
`
