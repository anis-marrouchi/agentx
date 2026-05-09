// --- Workflows page (Phase 2: observability) ---
//
// Read-only view over the workflow definitions + runs under .agentx/workflows/.
// Scope is deliberately tight: list workflows, show per-workflow status,
// inspect recent runs. No visual editor, no manual-run button — those land
// in later phases once the observability surface has proven useful.
//
// Renders a server skeleton; the client JS fetches /api/workflows and
// /api/workflows/runs, paints cards, and streams the selected run's history
// via SSE at /api/workflows/runs/<runId>/stream.
//
// Tab highlight note: the TopbarTab enum does not yet contain "workflows".
// Using "admin" as placeholder — the integration-seam commit adds
// "workflows" to src/daemon/topbar.ts:TopbarTab and this switches over.

import { renderShell, esc, type TopbarPeer } from ".."

export interface WorkflowsPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderWorkflowsPage(opts: WorkflowsPageOpts = {}): string {
  const body = `<div class="ax-wf__root">
  <aside class="ax-wf__list">
    <header>
      <h2>Workflows</h2>
      <div class="ax-wf__header-actions">
        <a id="wf-new" class="ax-wf__icon" href="/workflows/editor?new=1" title="New workflow">+</a>
        <button id="wf-refresh" class="ax-wf__icon" title="Refresh (r)">↻</button>
      </div>
    </header>
    <div class="ax-wf__search">
      <input id="wf-filter" type="search" placeholder="Filter by id or title…" autocomplete="off" />
      <select id="wf-project-filter" class="ax-wf__project-filter" title="Filter by project">
        <option value="">All projects</option>
      </select>
    </div>
    <ul id="wf-list" class="ax-wf__cards" aria-live="polite"></ul>
    <div id="wf-empty" class="ax-wf__empty" hidden>
      <p>No workflows defined.</p>
      <p class="hint">Add a definition under <code>.agentx/workflows/*.json</code>, validate with <code>agentx workflow validate</code>, and reload.</p>
    </div>
    <section class="ax-wf__drafts">
      <header>
        <h3>Drafts</h3>
        <span id="wf-draft-count" class="hint">0</span>
      </header>
      <ul id="wf-draft-list" class="ax-wf__draft-list" aria-live="polite"></ul>
    </section>
  </aside>

  <section class="ax-wf__detail">
    <header id="wf-detail-head">
      <span class="hint">Select a workflow to inspect.</span>
    </header>
    <div id="wf-detail-body" class="ax-wf__detail-body"></div>
  </section>

  <aside id="wf-run-panel" class="ax-wf__run-panel hidden" aria-hidden="true">
    <header>
      <div>
        <h3 id="wf-run-title">Run</h3>
        <span id="wf-run-meta" class="hint"></span>
      </div>
      <button id="wf-run-close" class="ax-wf__icon" title="Close (esc)">×</button>
    </header>
    <div id="wf-run-timeline" class="ax-wf__timeline"></div>
    <footer>
      <span id="wf-run-status" class="ax-wf__status-pill">—</span>
      <span id="wf-run-live" class="hint">—</span>
      <span id="wf-run-actions" class="ax-wf__run-actions">
        <button data-run-action="pause" type="button" title="Pause this run">Pause</button>
        <button data-run-action="resume" type="button" title="Resume a paused run">Resume</button>
        <button data-run-action="cancel" type="button" title="Cancel this run" class="danger">Cancel</button>
      </span>
    </footer>
  </aside>
</div>

<div id="wf-toast" class="ax-wf__toast" hidden></div>`

  return renderShell({
    title: "AgentX · Workflows",
    activeTab: "workflows",
    subtitle: "Workflows",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: WORKFLOWS_PAGE_CSS,
    scripts: `<script>${WORKFLOWS_PAGE_SCRIPT}</script>`,
  })
}

// ───────────────────────── CSS ─────────────────────────

const WORKFLOWS_PAGE_CSS = `
.ax-wf__root {
  display: grid;
  grid-template-columns: 340px 1fr;
  grid-template-rows: 100%;
  height: calc(100vh - var(--ax-topbar-h, 48px));
  background: var(--ax-bg);
}
.ax-wf__list {
  border-right: 1px solid var(--ax-border);
  display: flex; flex-direction: column;
  background: var(--ax-bg-elev);
}
.ax-wf__list > header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--ax-border);
}
.ax-wf__header-actions {
  display: flex; gap: 2px; align-items: center;
}
.ax-wf__header-actions a.ax-wf__icon {
  text-decoration: none;
}
.ax-wf__detail-title { flex: 1; }
.ax-wf__detail-actions { display: flex; gap: 6px; }
.ax-wf__btn {
  font-family: inherit; font-size: 12px;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 4px;
  padding: 5px 10px; cursor: pointer;
  text-decoration: none; display: inline-flex; gap: 4px; align-items: center;
  transition: background 120ms ease, border-color 120ms ease;
}
.ax-wf__btn:hover { background: var(--ax-surface); border-color: var(--ax-border-2); }
.ax-wf__list > header h2 {
  font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.005em;
}
.ax-wf__search { padding: 10px 14px; border-bottom: 1px solid var(--ax-border); }
.ax-wf__search input {
  width: 100%; padding: 7px 10px; font-size: 12px;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 4px;
  font-family: inherit;
}
.ax-wf__cards {
  list-style: none; margin: 0; padding: 8px 0;
  overflow-y: auto; flex: 1 1 auto; min-height: 140px;
}
.ax-wf__card {
  padding: 10px 18px; border-bottom: 1px solid var(--ax-border);
  cursor: pointer; transition: background 120ms ease;
}
.ax-wf__card:hover { background: var(--ax-surface); }
.ax-wf__card.is-active { background: var(--ax-surface); box-shadow: inset 3px 0 0 var(--ax-accent); }
.ax-wf__card-title {
  font-size: 13px; font-weight: 600; letter-spacing: -0.005em;
  color: var(--ax-text); margin-bottom: 3px;
}
.ax-wf__card-id {
  font-family: var(--ax-mono); font-size: 10px; color: var(--ax-muted);
}
.ax-wf__card-meta {
  display: flex; gap: 8px; flex-wrap: wrap;
  margin-top: 6px; font-size: 11px; color: var(--ax-text-2);
}
.ax-wf__card-meta .tag {
  padding: 1px 7px; border-radius: 3px; background: var(--ax-bg);
  border: 1px solid var(--ax-border); font-size: 10px;
  font-family: var(--ax-mono);
}
.ax-wf__card-meta .live {
  color: var(--ax-accent);
  border-color: color-mix(in oklch, var(--ax-accent) 50%, transparent);
}
.ax-wf__drafts {
  border-top: 1px solid var(--ax-border);
  flex: 0 0 min(34vh, 260px);
  display: flex; flex-direction: column;
  background: color-mix(in oklch, var(--ax-bg-elev) 92%, var(--ax-bg));
}
.ax-wf__drafts > header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 18px 8px;
}
.ax-wf__drafts h3 {
  margin: 0; font-size: 11px; font-weight: 650;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--ax-muted);
}
.ax-wf__draft-list {
  list-style: none; margin: 0; padding: 0 0 8px;
  overflow: auto;
}
.ax-wf__draft {
  padding: 9px 18px; cursor: pointer;
  border-top: 1px solid color-mix(in oklch, var(--ax-border) 55%, transparent);
}
.ax-wf__draft:hover { background: var(--ax-surface); }
.ax-wf__draft.is-active { background: var(--ax-surface); box-shadow: inset 3px 0 0 var(--ax-warn); }
.ax-wf__draft-title { font-size: 12px; font-weight: 600; color: var(--ax-text); margin-bottom: 2px; }
.ax-wf__draft-meta {
  display: flex; gap: 6px; flex-wrap: wrap;
  font-family: var(--ax-mono); font-size: 10px; color: var(--ax-muted);
}
.ax-wf__draft-empty { padding: 10px 18px 16px; color: var(--ax-muted); font-size: 11px; }
.ax-wf__draft-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ax-wf__btn.danger:hover { background: color-mix(in oklch, var(--ax-err) 13%, transparent); border-color: var(--ax-err); color: var(--ax-err); }
.ax-wf__btn.primary { border-color: color-mix(in oklch, var(--ax-accent) 55%, var(--ax-border)); color: var(--ax-accent); }

.ax-wf__detail {
  display: flex; flex-direction: column;
  overflow: hidden;
}
.ax-wf__detail > header {
  padding: 16px 22px; border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; gap: 12px;
  background: var(--ax-bg-elev);
}
.ax-wf__detail > header h2 {
  font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em;
}
.ax-wf__detail-body {
  padding: 22px; overflow: auto;
  display: grid; gap: 18px;
  grid-template-columns: 1fr 1fr;
  align-content: start;
}
.ax-wf__panel {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 6px; padding: 14px 16px;
}
.ax-wf__panel h3 {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ax-muted);
  margin: 0 0 10px;
}
.ax-wf__panel--full { grid-column: 1 / -1; }
.ax-wf__states {
  display: flex; flex-wrap: wrap; gap: 6px;
  font-size: 11px;
}
.ax-wf__state {
  font-family: var(--ax-mono); padding: 2px 8px;
  border-radius: 3px; background: var(--ax-surface);
  border: 1px solid var(--ax-border);
}
.ax-wf__state.is-terminal { color: var(--ax-muted); opacity: 0.75; }
.ax-wf__trans {
  font-family: var(--ax-mono); font-size: 11px;
  color: var(--ax-text-2); line-height: 1.8;
}
.ax-wf__trans .arr { color: var(--ax-muted); }
.ax-wf__trans .cond { color: var(--ax-accent); font-size: 10px; }
.ax-wf__runs {
  display: flex; flex-direction: column; gap: 4px;
}
.ax-wf__run-row {
  display: grid;
  grid-template-columns: 76px 1fr 110px 110px 24px;
  gap: 10px; align-items: center;
  padding: 7px 8px; border-radius: 4px;
  font-size: 12px; cursor: pointer;
}
.ax-wf__run-row:hover { background: var(--ax-surface); }
.ax-wf__run-row .id { font-family: var(--ax-mono); color: var(--ax-muted); font-size: 11px; }
.ax-wf__run-row .status { font-size: 10px; text-align: center; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--ax-mono); }
.ax-wf__run-row .status.running { background: color-mix(in oklch, var(--ax-accent) 15%, transparent); color: var(--ax-accent); }
.ax-wf__run-row .status.completed { color: var(--ax-muted); }
.ax-wf__run-row .status.failed { color: var(--ax-err); }
.ax-wf__run-row .status.paused { color: var(--ax-warn); }
.ax-wf__run-row .status.canceled { color: var(--ax-muted); opacity: 0.7; }
.ax-wf__json {
  font-family: var(--ax-mono); font-size: 11px;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 4px;
  padding: 10px 12px; max-height: 280px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
}
/* Editable draft textarea — same look as the JSON pre, just typeable.
 * tab-size keeps indentation legible and resize: vertical lets reviewers
 * grow the panel without leaving the page. */
.ax-wf__editor {
  display: block; width: 100%;
  font-family: var(--ax-mono); font-size: 12px;
  line-height: 1.45; tab-size: 2;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 4px;
  padding: 10px 12px;
  min-height: 320px; max-height: 70vh;
  resize: vertical; overflow: auto;
  white-space: pre; word-break: normal;
  outline: none;
}
.ax-wf__editor:focus {
  border-color: var(--ax-accent, #6366f1);
}
.ax-wf__editor--small {
  min-height: 110px; max-height: 220px;
}
/* Run form lives in the detail header, below the row of buttons */
.ax-wf__run-form {
  grid-column: 1 / -1;
  margin-top: 10px; padding: 12px;
  background: var(--ax-panel, var(--ax-bg)); border: 1px solid var(--ax-border);
  border-radius: 6px;
  display: flex; flex-direction: column; gap: 8px;
}
.ax-wf__run-form label { font-size: 11px; color: var(--ax-muted); }
.ax-wf__run-form code { font-family: var(--ax-mono); font-size: 11px; }
.ax-wf__inline { display: flex; align-items: flex-start; gap: 6px; }
.ax-wf__inline input[type="checkbox"] { margin-top: 3px; }
.ax-wf__run-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ax-wf__run-fields-grid {
  display: grid; grid-template-columns: 1fr; gap: 10px;
}
.ax-wf__run-fld {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 12px;
}
.ax-wf__run-label {
  display: flex; align-items: center; gap: 6px;
  font-weight: 500; color: var(--ax-text);
}
.ax-wf__run-label code {
  background: var(--ax-panel, var(--ax-bg));
  padding: 1px 5px; border-radius: 3px;
}
.ax-wf__run-req { color: var(--ax-err, #ef4444); font-weight: bold; }
.ax-wf__run-fld input[type="text"],
.ax-wf__run-fld input[type="number"],
.ax-wf__run-fld select,
.ax-wf__run-fld textarea {
  font: inherit; font-size: 12px;
  padding: 5px 8px; border: 1px solid var(--ax-border);
  border-radius: 4px; background: var(--ax-bg); color: var(--ax-text);
}
.ax-wf__run-fld textarea {
  font-family: var(--ax-mono); resize: vertical;
}
.ax-wf__run-hint { font-size: 11px; color: var(--ax-muted); }
.ax-wf__run-raw { margin-top: 4px; }
.ax-wf__run-raw summary {
  font-size: 11px; color: var(--ax-muted);
  cursor: pointer; padding: 4px 0;
}
.ax-wf__run-raw[open] summary { color: var(--ax-text); }
/* Tiny re-run button on the run rows */
.ax-wf__btn--xs {
  padding: 2px 6px; font-size: 12px; line-height: 1;
  background: transparent; border: 1px solid var(--ax-border);
  border-radius: 3px; cursor: pointer; color: var(--ax-text);
}
.ax-wf__btn--xs:hover { background: var(--ax-panel, var(--ax-bg)); border-color: var(--ax-accent, #6366f1); }
/* Last-run status colors on the workflow card */
.ax-wf__card-meta .tag.tag--completed { color: var(--ax-ok, #4ade80); }
.ax-wf__card-meta .tag.tag--failed    { color: var(--ax-err, #ef4444); }
.ax-wf__card-meta .tag.tag--running   { color: var(--ax-accent, #6366f1); }
.ax-wf__card-meta .tag.tag--paused    { color: var(--ax-warn, #facc15); }
.ax-wf__card-meta .tag.tag--canceled  { color: var(--ax-muted); opacity: 0.7; }
.ax-wf__card-meta .tag.tag--project {
  color: var(--ax-accent, #6366f1);
  background: color-mix(in srgb, var(--ax-accent, #6366f1) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ax-accent, #6366f1) 30%, transparent);
  font-weight: 500;
}
.ax-wf__project-filter {
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border: 1px solid var(--ax-border);
  border-radius: 4px;
  background: var(--ax-bg);
  color: var(--ax-fg);
  margin-top: 6px;
  width: 100%;
}
/* Runbook framing — tables in WHEN / IN / OUT panels */
.ax-wf__io { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.ax-wf__io th { text-align: left; font-weight: 500; color: var(--ax-muted); font-size: 10px;
  letter-spacing: 0.04em; text-transform: uppercase; padding: 4px 8px;
  border-bottom: 1px solid var(--ax-border); }
.ax-wf__io td { padding: 6px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.ax-wf__io td.ax-wf__io-name { font-family: var(--ax-mono); color: var(--ax-text); font-weight: 500; white-space: nowrap; }
.ax-wf__io td.ax-wf__io-type { font-family: var(--ax-mono); font-size: 11px; color: var(--ax-text-2); }
.ax-wf__pill { display: inline-block; padding: 1px 7px; font-size: 10px; font-family: var(--ax-mono);
  border: 1px solid var(--ax-border); border-radius: 3px; color: var(--ax-text-2); background: var(--ax-surface); }
.ax-wf__pill--req { color: var(--ax-warn, #f59e0b); border-color: color-mix(in oklch, var(--ax-warn, #f59e0b) 40%, var(--ax-border)); }
.ax-wf__hkbd { font-size: 10px; font-family: var(--ax-mono); color: var(--ax-muted);
  font-weight: 400; letter-spacing: 0.04em; padding-left: 8px; }
details.ax-wf__panel { padding: 0; }
details.ax-wf__panel summary { padding: 12px 14px; cursor: pointer; user-select: none; font-weight: 500; }
details.ax-wf__panel[open] summary { border-bottom: 1px solid var(--ax-border); }
details.ax-wf__panel pre { margin: 0; padding: 10px 14px; }

/* run detail drawer */
.ax-wf__run-panel {
  position: fixed; top: var(--ax-topbar-h, 48px); right: 0; bottom: 0;
  width: 420px; background: var(--ax-bg-elev); border-left: 1px solid var(--ax-border);
  transform: translateX(100%); transition: transform 180ms ease;
  display: flex; flex-direction: column; z-index: 40;
}
.ax-wf__run-panel:not(.hidden) { transform: translateX(0); }
.ax-wf__run-panel > header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid var(--ax-border);
}
.ax-wf__run-panel h3 {
  font-size: 13px; font-weight: 600; margin: 0 0 2px;
}
.ax-wf__timeline {
  flex: 1; overflow-y: auto; padding: 12px 18px;
  display: flex; flex-direction: column; gap: 8px;
}
.ax-wf__timeline-entry {
  border-left: 2px solid var(--ax-border);
  padding: 6px 0 10px 12px; position: relative;
}
.ax-wf__timeline-entry::before {
  content: ""; position: absolute; left: -5px; top: 10px;
  width: 8px; height: 8px; background: var(--ax-accent);
  border-radius: 50%;
}
.ax-wf__timeline-entry.result-failed::before { background: var(--ax-err); }
.ax-wf__timeline-entry .time {
  font-family: var(--ax-mono); font-size: 10px; color: var(--ax-muted);
}
.ax-wf__timeline-entry .move {
  font-size: 12px; margin: 2px 0;
}
.ax-wf__timeline-entry .agent {
  font-family: var(--ax-mono); font-size: 10px; color: var(--ax-text-2);
}
.ax-wf__run-panel > footer {
  padding: 12px 18px; border-top: 1px solid var(--ax-border);
  display: flex; justify-content: space-between; align-items: center;
}
.ax-wf__status-pill {
  font-family: var(--ax-mono); font-size: 10px; text-transform: uppercase;
  padding: 2px 8px; border-radius: 3px;
}
.ax-wf__status-pill.running { background: color-mix(in oklch, var(--ax-accent) 15%, transparent); color: var(--ax-accent); }
.ax-wf__status-pill.completed { color: var(--ax-muted); background: var(--ax-surface); }
.ax-wf__status-pill.failed { color: var(--ax-err); background: color-mix(in oklch, var(--ax-err) 15%, transparent); }
.ax-wf__run-actions { display: flex; gap: 4px; margin-left: auto; }
.ax-wf__run-actions button { font-size: 11px; padding: 3px 9px; border-radius: 4px; border: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-fg); cursor: pointer; }
.ax-wf__run-actions button:hover { background: var(--ax-surface); }
.ax-wf__run-actions button.danger:hover { background: color-mix(in oklch, var(--ax-err) 15%, transparent); border-color: var(--ax-err); color: var(--ax-err); }

.ax-wf__icon {
  background: none; border: none; color: var(--ax-muted);
  cursor: pointer; font-size: 18px; padding: 4px 8px;
}
.ax-wf__icon:hover { color: var(--ax-text); }
.ax-wf__empty {
  padding: 40px 22px; color: var(--ax-muted); font-size: 13px;
  text-align: center;
}
.ax-wf__empty .hint { font-size: 11px; margin-top: 6px; }
.ax-wf__empty code {
  font-family: var(--ax-mono); background: var(--ax-surface);
  padding: 1px 6px; border-radius: 3px;
  border: 1px solid var(--ax-border);
}
.ax-wf__toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  padding: 8px 16px; background: var(--ax-bg-elev);
  border: 1px solid var(--ax-border); border-radius: 4px;
  font-size: 12px; z-index: 50;
}
.hint { color: var(--ax-muted); font-size: 11px; }
`

// ───────────────────────── CLIENT JS ─────────────────────────
//
// Kept inline in the module per the existing page convention. All endpoints
// assumed by this script are wired by daemon/workflows-api.ts.

const WORKFLOWS_PAGE_SCRIPT = `
(() => {
  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.from(document.querySelectorAll(sel))

  const state = {
    workflows: [],
    drafts: [],
    runs: [],
    selectedId: null,
    selectedDraftId: null,
    filter: "",
    /** Project filter — "" = all (incl. workflows without project),
     *  "__none__" = only workflows missing the project field,
     *  "<org/repo>" = only that project's workflows.
     *  Populated dynamically from the loaded workflows. */
    projectFilter: "",
    sse: null,
  }

  const token = (typeof localStorage !== "undefined" && localStorage.getItem("ax_token")) || ""
  const headers = () => token ? { "Authorization": "Bearer " + token } : {}

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: headers() })
    if (!res.ok) throw new Error(url + ": " + res.status)
    return res.json()
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", ...headers() },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || (url + ": " + res.status))
    return data
  }

  // --- Rendering -------------------------------------------------------

  function renderProjectFilter() {
    const sel = $("#wf-project-filter")
    if (!sel) return
    // Collect distinct projects from currently loaded workflows. Sorted
    // alphabetically; "(no project)" entry only shown when at least one
    // workflow lacks the field, so the dropdown stays clean for fully-
    // tagged setups.
    const projects = new Set()
    let hasGlobal = false
    for (const wf of state.workflows) {
      if (wf.project) projects.add(wf.project)
      else hasGlobal = true
    }
    const sorted = Array.from(projects).sort()
    const current = state.projectFilter || ""
    sel.innerHTML = '<option value="">All projects</option>'
      + sorted.map(p => '<option value="' + esc(p) + '"' + (p === current ? ' selected' : '') + '>' + esc(p) + '</option>').join("")
      + (hasGlobal ? '<option value="__none__"' + (current === "__none__" ? ' selected' : '') + '>(no project)</option>' : "")
  }

  function renderList() {
    renderProjectFilter()
    const needle = state.filter.toLowerCase()
    const projectFilter = state.projectFilter || ""
    const filtered = state.workflows.filter(wf => {
      const matchesText = !needle || wf.id.toLowerCase().includes(needle) || (wf.title || "").toLowerCase().includes(needle)
      // projectFilter values:
      //   ""           — no filter (all projects + global)
      //   "__none__"   — only workflows without a project field
      //   "<org/repo>" — only workflows whose project field equals this
      let matchesProject = true
      if (projectFilter === "__none__") matchesProject = !wf.project
      else if (projectFilter) matchesProject = wf.project === projectFilter
      return matchesText && matchesProject
    })

    const runsByWorkflow = state.runs.reduce((acc, r) => {
      (acc[r.workflowId] ||= []).push(r); return acc
    }, {})

    if (filtered.length === 0) {
      $("#wf-list").innerHTML = ""
      $("#wf-empty").hidden = state.workflows.length > 0
      return
    }
    $("#wf-empty").hidden = true

    $("#wf-list").innerHTML = filtered.map(wf => {
      const myRuns = runsByWorkflow[wf.id] || []
      const live = myRuns.filter(r => r.status === "running").length
      const lastRun = myRuns[0]
      const isActive = state.selectedId === wf.id
      // V2: trigger is a node inside wf.nodes, not a workflow-level field.
      const triggerNode = (wf.nodes || []).find(n => n && n.type && n.type.indexOf("trigger.") === 0)
      const triggerSource = triggerNode ? (triggerNode.config && triggerNode.config.source) || triggerNode.type.replace("trigger.", "") : "?"
      return \`
        <li class="ax-wf__card \${isActive ? "is-active" : ""}" data-id="\${wf.id}">
          <div class="ax-wf__card-title">\${esc(wf.title || wf.id)}</div>
          <div class="ax-wf__card-id">\${esc(wf.id)} · v\${wf.version}</div>
          <div class="ax-wf__card-meta">
            \${wf.project ? \`<span class="tag tag--project" title="Project">\${esc(wf.project)}</span>\` : ""}
            <span class="tag">\${esc(triggerSource)}</span>
            \${live > 0 ? \`<span class="tag live">\${live} running</span>\` : ""}
            \${lastRun
              ? \`<span class="tag tag--\${esc(lastRun.status)}" title="\${esc(lastRun.id)} · \${esc(new Date(lastRun.updatedAt).toLocaleString())}">last: \${esc(lastRun.status)} · \${relTime(lastRun.updatedAt)}</span>\`
              : \`<span class="tag">no runs</span>\`}
          </div>
        </li>\`
    }).join("")

    $$(".ax-wf__card").forEach(el => {
      el.addEventListener("click", () => select(el.dataset.id))
    })
  }

  function renderDraftList() {
    $("#wf-draft-count").textContent = String(state.drafts.length)
    if (!state.drafts.length) {
      $("#wf-draft-list").innerHTML = \`<li class="ax-wf__draft-empty">No drafts pending review.</li>\`
      return
    }
    $("#wf-draft-list").innerHTML = state.drafts.map(d => {
      const wf = d.workflow || {}
      const isActive = state.selectedDraftId === d.id
      const issues = Array.isArray(d.issues) ? d.issues.length : 0
      return \`<li class="ax-wf__draft \${isActive ? "is-active" : ""}" data-draft="\${esc(d.id)}">
        <div class="ax-wf__draft-title">\${esc(wf.title || d.id)}</div>
        <div class="ax-wf__draft-meta">
          <span>\${esc(d.id)}</span>
          <span>confidence=\${wf.confidence == null ? "—" : Number(wf.confidence).toFixed(2)}</span>
          <span>\${issues ? issues + " issue" + (issues === 1 ? "" : "s") : "valid"}</span>
        </div>
      </li>\`
    }).join("")
    $$(".ax-wf__draft").forEach(el => {
      el.addEventListener("click", () => selectDraft(el.dataset.draft))
    })
  }

  function renderDetail() {
    if (state.selectedDraftId) {
      renderDraftDetail()
      return
    }
    const wf = state.workflows.find(w => w.id === state.selectedId)
    if (!wf) {
      $("#wf-detail-head").innerHTML = \`<span class="hint">Select a workflow to inspect.</span>\`
      $("#wf-detail-body").innerHTML = ""
      return
    }
    // V2: trigger is a node. Pull source + filter from its config.
    const triggerNode = (wf.nodes || []).find(n => n && n.type && n.type.indexOf("trigger.") === 0)
    const triggerCfg = (triggerNode && triggerNode.config) || {}
    const filter = triggerCfg.filter || {}
    const trigFilter = [filter.project, filter.repo, filter.chat].filter(Boolean).join(" / ")
    const triggerSource = triggerNode ? (triggerCfg.source || triggerNode.type.replace("trigger.", "")) : "?"

    const isManual = triggerNode && triggerNode.type === "trigger.manual"
    $("#wf-detail-head").innerHTML = \`
      <div class="ax-wf__detail-title">
        <h2>\${esc(wf.title || wf.id)}</h2>
        <span class="hint">\${esc(wf.id)} · v\${wf.version} · trigger: \${esc(triggerSource)}\${trigFilter ? " · " + esc(trigFilter) : ""}</span>
      </div>
      <div class="ax-wf__detail-actions">
        <a class="ax-wf__btn" href="/workflows/editor?id=\${encodeURIComponent(wf.id)}" title="Open in visual editor">✎ Edit</a>
        <button class="ax-wf__btn primary" id="wf-run-toggle" type="button" title="Trigger this workflow with a JSON payload">▶ Run</button>
      </div>
      <div id="wf-run-form" class="ax-wf__run-form" hidden>
        <div id="wf-run-fields"></div>
        <details class="ax-wf__run-raw">
          <summary>Or edit the raw JSON payload</summary>
          <textarea id="wf-run-payload" class="ax-wf__editor ax-wf__editor--small" spellcheck="false">{}</textarea>
        </details>
        <label class="ax-wf__inline">
          <input type="checkbox" id="wf-run-force" \${isManual ? "" : "checked"} />
          <span>Force (synthesize trigger event — required when trigger is not <code>trigger.manual</code>)</span>
        </label>
        <div class="ax-wf__run-form-actions">
          <button class="ax-wf__btn" id="wf-run-cancel" type="button">Cancel</button>
          <button class="ax-wf__btn primary" id="wf-run-go" type="button">Run now</button>
        </div>
      </div>\`

    // V2: list nodes (with brief type + any agent id) and edges. No more
    // states/transitions — the DAG structure lives in nodes + edges.
    const nodeCount = (wf.nodes || []).length
    const edgeCount = (wf.edges || []).length
    const nodeEntries = (wf.nodes || []).map((n) => {
      const cfg = n.config || {}
      const badge = n.type === "agent" ? (cfg.agentId || "(no agent)")
        : n.type.indexOf("action.") === 0 ? n.type.replace("action.", "")
        : n.type.indexOf("trigger.") === 0 ? (cfg.source || n.type.replace("trigger.", ""))
        : n.type
      return \`<span class="ax-wf__state" title="\${esc(n.type)}">\${esc(n.id)} <span class="hint" style="margin-left:4px">\${esc(badge)}</span></span>\`
    }).join(" ")

    const edgesHtml = (wf.edges || []).map((e) => {
      const label = e.label ? \` <span class="cond">\${esc(e.label)}</span>\` : ""
      const port = e.fromPort ? \` :\${esc(e.fromPort)}\` : ""
      return \`<div><span>\${esc(e.from)}\${port}</span> <span class="arr">→</span> <span>\${esc(e.to)}</span>\${label}</div>\`
    }).join("") || \`<span class="hint">(no edges)</span>\`

    const runs = state.runs.filter(r => r.workflowId === wf.id).slice(0, 50)
    const runsHtml = runs.length ? runs.map(r => {
      // V2: no more run.state. Show the next pending node (if running) or
      // the last executed node (if terminal).
      const last = (r.history && r.history.length) ? r.history[r.history.length - 1] : null
      const position = r.status === "running" && r.pending && r.pending.length
        ? r.pending[0] + " (next)"
        : last ? last.nodeId + " (" + last.status + ")"
        : "—"
      // Re-run button shows for terminal statuses only (running/paused
      // re-runs would race with the in-flight execution). The button
      // refetches the run's stored payload from /api/workflows/runs/:id
      // (slim listing strips context, full detail keeps it) and POSTs
      // the same payload back to /workflows/<id>/run.
      const canRerun = r.status === "completed" || r.status === "failed" || r.status === "canceled"
      const rerunBtn = canRerun
        ? \`<button class="ax-wf__btn ax-wf__btn--xs" data-rerun="\${esc(r.id)}" title="Re-run with the same payload">↻</button>\`
        : \`<span style="width:18px"></span>\`
      return \`<div class="ax-wf__run-row" data-runid="\${r.id}">
        <span class="id">\${r.id.slice(0,8)}</span>
        <span>\${esc(position)} <span class="hint">· \${esc(r.entityRef.id)}</span></span>
        <span class="hint">\${relTime(r.updatedAt)}</span>
        <span class="status \${r.status}">\${r.status}</span>
        \${rerunBtn}
        <span>›</span>
      </div>\`
    }).join("") : \`<span class="hint">No runs yet for this workflow.</span>\`

    // --- Runbook framing (see docs/architecture/three-tier.md) -------------
    // Each workflow renders as a runbook: WHEN, WHAT comes in, HOW, WHAT
    // comes out, WHO owns it. Nodes/Edges/Definition stay visible but as
    // collapsed details — the operator doesn't need to read JSON to
    // understand what the workflow does.
    const inputProps = (triggerCfg.inputSchema && triggerCfg.inputSchema.properties) || {}
    const inputRequired = new Set(Array.isArray(triggerCfg.inputSchema && triggerCfg.inputSchema.required) ? triggerCfg.inputSchema.required : [])
    const inputRows = Object.keys(inputProps).map(k => {
      const p = inputProps[k] || {}
      const enumStr = Array.isArray(p.enum) ? \` <span class="hint">[\${p.enum.map(esc).join(" | ")}]</span>\` : ""
      const def = p.default !== undefined ? \` <span class="hint">default=\${esc(JSON.stringify(p.default))}</span>\` : ""
      const req = inputRequired.has(k) ? \`<span class="ax-wf__pill ax-wf__pill--req">required</span>\` : \`<span class="ax-wf__pill">optional</span>\`
      return \`<tr>
        <td class="ax-wf__io-name">\${esc(k)}</td>
        <td class="ax-wf__io-type">\${esc(String(p.type || "any"))}\${enumStr}\${def}</td>
        <td>\${req}</td>
        <td class="hint">\${esc(p.description || "")}</td>
      </tr>\`
    }).join("")
    const inputsBlock = inputRows
      ? \`<table class="ax-wf__io"><thead><tr><th>field</th><th>type</th><th></th><th>description</th></tr></thead><tbody>\${inputRows}</tbody></table>\`
      : \`<span class="hint">No declared inputSchema. The matcher's payload (message, channel, chatId, agentId) is passed through as-is.</span>\`

    // WHAT comes out — read the end node's output template. Surface the
    // keys + values so operators see what the run resolves to.
    const endNode = (wf.nodes || []).find(n => n && n.type === "end")
    const endOutput = (endNode && endNode.config && endNode.config.output) || null
    let outputBlock
    if (endOutput && typeof endOutput === "object") {
      const outRows = Object.keys(endOutput).map(k => \`<tr><td class="ax-wf__io-name">\${esc(k)}</td><td class="ax-wf__io-type">\${esc(String(endOutput[k]))}</td></tr>\`).join("")
      outputBlock = \`<table class="ax-wf__io"><tbody>\${outRows}</tbody></table>\`
    } else if (typeof endOutput === "string") {
      outputBlock = \`<div class="hint">\${esc(endOutput)}</div>\`
    } else {
      outputBlock = \`<span class="hint">No structured output declared on the end node.</span>\`
    }

    // WHEN — trigger summary + last-fired info from the runs we already have.
    const lastRunForWhen = state.runs.find(r => r.workflowId === wf.id)
    const whenLine = triggerNode
      ? \`<strong>\${esc(triggerNode.type)}</strong>\${triggerCfg.source ? \` · source: <code>\${esc(triggerCfg.source)}</code>\` : ""}\${trigFilter ? \` · filter: <code>\${esc(trigFilter)}</code>\` : ""}\`
      : \`<span class="hint">No trigger node — workflow is unreachable.</span>\`
    const lastFiredLine = lastRunForWhen
      ? \`<span class="hint">last fired \${relTime(lastRunForWhen.updatedAt)} (\${esc(lastRunForWhen.status)}) — \${runs.length} run\${runs.length === 1 ? "" : "s"} on record</span>\`
      : \`<span class="hint">No runs on record yet.</span>\`

    // WHO — ownership + provenance metadata.
    const tagsHtml = (wf.tags || []).map(t => \`<span class="ax-wf__pill">\${esc(t)}</span>\`).join(" ") || \`<span class="hint">(no tags)</span>\`
    const sources = Array.isArray(wf.sourceTaskIds) ? wf.sourceTaskIds : []

    $("#wf-detail-body").innerHTML = \`
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>WHEN <span class="ax-wf__hkbd">trigger</span></h3>
        <div>\${whenLine}</div>
        <div style="margin-top:6px">\${lastFiredLine}</div>
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>WHAT comes in <span class="ax-wf__hkbd">inputSchema</span></h3>
        \${inputsBlock}
      </div>
      <div class="ax-wf__panel">
        <h3>HOW <span class="ax-wf__hkbd">\${nodeCount} nodes · \${edgeCount} edges</span></h3>
        <div class="ax-wf__states">\${nodeEntries}</div>
        <div class="ax-wf__trans" style="margin-top:8px">\${edgesHtml}</div>
      </div>
      <div class="ax-wf__panel">
        <h3>WHAT comes out <span class="ax-wf__hkbd">end.output</span></h3>
        \${outputBlock}
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>WHO <span class="ax-wf__hkbd">ownership</span></h3>
        <div>owner agent: <strong>\${esc(wf.ownerAgent || "(unowned)")}</strong>\${wf.generatedFrom ? \` · generated from: <code>\${esc(wf.generatedFrom)}</code>\` : ""}\${wf.confidence != null ? \` · confidence: \${Number(wf.confidence).toFixed(2)}\` : ""}</div>
        <div style="margin-top:6px">tags: \${tagsHtml}</div>
        \${sources.length ? \`<div style="margin-top:6px" class="hint">absorbed from \${sources.length} task trace\${sources.length === 1 ? "" : "s"}: \${sources.slice(0, 4).map(esc).join(", ")}\${sources.length > 4 ? "..." : ""}</div>\` : ""}
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>Recent runs (\${runs.length})</h3>
        <div class="ax-wf__runs">\${runsHtml}</div>
      </div>
      <details class="ax-wf__panel ax-wf__panel--full">
        <summary>Definition (raw JSON)</summary>
        <pre class="ax-wf__json">\${esc(JSON.stringify(wf, null, 2))}</pre>
      </details>\`

    $$(".ax-wf__run-row").forEach(el => {
      el.addEventListener("click", (ev) => {
        // Re-run button shouldn't open the run drawer for the OLD run.
        // The actual rerun handler attaches separately below.
        const t = ev.target
        if (t && t.tagName === "BUTTON" && t.dataset.rerun) return
        openRun(el.dataset.runid)
      })
    })
    $$("[data-rerun]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation()
        rerunFrom(el.dataset.rerun, wf.id, triggerNode ? triggerNode.id : null)
      })
    })

    // Run button — toggles the inline payload form. Cancel hides it; Run
    // now POSTs to /workflows/<id>/run (proxied by the dashboard) and opens
    // the run drawer on the new runId. The form is built lazily on first
    // open so we have the trigger config + inputSchema in scope.
    const runToggle = $("#wf-run-toggle")
    if (runToggle) runToggle.addEventListener("click", () => {
      const form = $("#wf-run-form")
      const showing = !form.hasAttribute("hidden")
      if (showing) form.setAttribute("hidden", "")
      else {
        form.removeAttribute("hidden")
        if (!form.dataset.built) {
          buildRunForm(triggerNode, triggerCfg)
          form.dataset.built = "1"
        }
      }
    })
    const runCancel = $("#wf-run-cancel")
    if (runCancel) runCancel.addEventListener("click", () => $("#wf-run-form").setAttribute("hidden", ""))
    const runGo = $("#wf-run-go")
    if (runGo) runGo.addEventListener("click", () => runWorkflow(wf.id))
  }

  // Friendly run-form builder: derives input fields from the trigger's
  // inputSchema (if declared) or from a hook-event preset, falling back
  // to the raw JSON textarea when neither path is available. The "Or
  // edit the raw JSON payload" details element is the always-available
  // power-user escape hatch.
  function buildRunForm(triggerNode, triggerCfg) {
    const fieldsEl = $("#wf-run-fields")
    if (!fieldsEl) return
    const schema = pickTriggerSchema(triggerNode, triggerCfg)
    if (!schema) {
      fieldsEl.innerHTML = '<div class="ax-wf__run-hint">No declared inputSchema. Use the raw JSON below to send the payload your trigger expects.</div>'
      return
    }
    const props = schema.properties || {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const rows = Object.keys(props).map(k => renderRunField(k, props[k], required.has(k))).join("")
    fieldsEl.innerHTML = '<div class="ax-wf__run-fields-grid">' + rows + '</div>'
  }

  // Pick an inputSchema for the run form: trigger.config.inputSchema
  // wins, then per-hook-event presets for trigger.hook, otherwise null.
  function pickTriggerSchema(triggerNode, triggerCfg) {
    if (triggerCfg && triggerCfg.inputSchema && triggerCfg.inputSchema.properties) {
      return triggerCfg.inputSchema
    }
    if (triggerNode && triggerNode.type === "trigger.hook" && triggerCfg && triggerCfg.event) {
      return HOOK_EVENT_PRESETS[triggerCfg.event] || null
    }
    return null
  }

  function renderRunField(key, prop, isRequired) {
    const desc = (prop && prop.description) || ""
    const t = (prop && prop.type) || "string"
    const def = prop && prop.default
    const placeholder = def !== undefined ? esc(JSON.stringify(def)) : ""
    let control = ""
    if (Array.isArray(prop && prop.enum)) {
      const opts = prop.enum.map(v => '<option value="' + esc(String(v)) + '">' + esc(String(v)) + '</option>').join("")
      control = '<select data-run-key="' + esc(key) + '" data-run-type="enum">' + (isRequired ? "" : '<option value=""></option>') + opts + '</select>'
    } else if (t === "boolean") {
      control = '<input type="checkbox" data-run-key="' + esc(key) + '" data-run-type="boolean" ' + (def === true ? "checked" : "") + ' />'
    } else if (t === "number" || t === "integer") {
      control = '<input type="number" data-run-key="' + esc(key) + '" data-run-type="number" placeholder="' + placeholder + '" />'
    } else if (t === "array") {
      control = '<input type="text" data-run-key="' + esc(key) + '" data-run-type="list" placeholder="comma,separated,values" />'
    } else if (t === "object") {
      control = '<textarea data-run-key="' + esc(key) + '" data-run-type="json" rows="2" spellcheck="false">{}</textarea>'
    } else {
      control = '<input type="text" data-run-key="' + esc(key) + '" data-run-type="string" placeholder="' + placeholder + '" />'
    }
    const reqMark = isRequired ? '<span class="ax-wf__run-req" title="required">*</span>' : ""
    return '<label class="ax-wf__run-fld">'
      + '<span class="ax-wf__run-label"><code>' + esc(key) + '</code>' + reqMark + ' <span class="hint">' + esc(t) + '</span></span>'
      + control
      + (desc ? '<span class="ax-wf__run-hint">' + esc(desc) + '</span>' : '')
      + '</label>'
  }

  // Hook-event payload presets — when a workflow's trigger.hook fires
  // off on:gitlab-issue (etc.), the payload it sees is hook-specific.
  // Encoding the shape here lets the run form render typed fields even
  // though the workflow author didn't declare a custom inputSchema.
  // Add new entries as new on:* hooks land in src/workflows/hooks.ts.
  const HOOK_EVENT_PRESETS = {
    "on:gitlab-issue": {
      properties: {
        iid:         { type: "number",  description: "Issue iid" },
        title:       { type: "string",  description: "Issue title" },
        description: { type: "string",  description: "Issue body markdown" },
        action:      { type: "string",  enum: ["open", "reopen", "update", "close"] },
        labels:      { type: "array",   description: "Current labels (array of strings)" },
        author:      { type: "string",  description: "Reporter's username" },
        url:         { type: "string",  description: "GitLab URL of the issue" },
        project:     { type: "string",  description: "org/repo path" },
      },
      required: ["iid", "project", "action"],
    },
    "on:gitlab-mr": {
      properties: {
        iid:           { type: "number",  description: "MR iid" },
        title:         { type: "string",  description: "MR title" },
        description:   { type: "string",  description: "MR body" },
        action:        { type: "string",  enum: ["open", "reopen", "update", "approved", "merge", "close"] },
        state:         { type: "string",  enum: ["opened", "merged", "closed"] },
        source_branch: { type: "string" },
        target_branch: { type: "string" },
        labels:        { type: "array" },
        url:           { type: "string" },
        project:       { type: "string" },
      },
      required: ["iid", "project", "action"],
    },
    "on:gitlab-note": {
      properties: {
        noteId:        { type: "string" },
        noteableType:  { type: "string", enum: ["merge_request", "issue"] },
        noteableIid:   { type: "string" },
        text:          { type: "string", description: "Comment body" },
        author:        { type: "string" },
        project:       { type: "string" },
      },
      required: ["noteableType", "noteableIid", "text"],
    },
    "on:gitlab-pipeline": {
      properties: {
        pipelineId: { type: "number" },
        status:     { type: "string", enum: ["success", "failed", "canceled", "running", "pending"] },
        ref:        { type: "string", description: "Branch or tag" },
        project:    { type: "string" },
      },
      required: ["status", "project"],
    },
  }

  /** Re-run a completed run with the same payload it was originally
   *  triggered with. Fetches the full run (the listing /runs?summary=1
   *  strips context) to recover the original trigger payload, then
   *  POSTs to /workflows/<id>/run. Force is set if we synthesized
   *  a non-manual trigger event the first time around. The dispatcher
   *  stores the trigger node's output bundle in run.context keyed by
   *  the node id — so we look up via triggerNodeId, not the literal
   *  string "trigger" (which is just the conventional id). */
  async function rerunFrom(runId, workflowId, triggerNodeId) {
    if (!runId || !workflowId) return
    let payload = {}
    let force = false
    try {
      const detail = await fetchJSON("/api/workflows/runs/" + encodeURIComponent(runId))
      const run = detail.run || detail
      const ctx = run && run.context || {}
      // First preference: index context by the trigger node's id. Falls
      // back to context.trigger for older runs (gitlab-sdlc-loop, etc.).
      const triggerOutput = (triggerNodeId && ctx[triggerNodeId]) || ctx.trigger
      if (triggerOutput && typeof triggerOutput === "object") {
        // Some triggers wrap the input under event.payload; most are flat.
        payload = triggerOutput.event && triggerOutput.event.payload
          ? triggerOutput.event.payload
          : triggerOutput
      }
      // entityRef.backend "channel" means the original was a synthesized
      // event (force-fired). Mirror force=true so the rerun isn't blocked
      // by the daemon's 409 guard for non-manual triggers.
      force = !!(run && run.entityRef && run.entityRef.backend === "channel")
    } catch (e) {
      toast("Couldn't load original run payload: " + e.message + " — re-running with empty payload")
    }
    try {
      const res = await postJSON("/workflows/" + encodeURIComponent(workflowId) + "/run", { payload, force })
      if (res.runId) {
        toast("re-run started: " + res.runId.slice(0, 8))
        await openRun(res.runId)
      } else {
        toast("re-run accepted (no runId returned)")
      }
    } catch (e) {
      toast("re-run failed: " + e.message)
    }
  }

  async function runWorkflow(workflowId) {
    const payloadEl = $("#wf-run-payload")
    const forceEl = $("#wf-run-force")
    let payload = {}
    // Field-form path: collect values from the structured inputs first.
    // Empty values are dropped so the server's default-handling stays
    // intact (don't overwrite a default with "").
    const fieldEls = document.querySelectorAll("[data-run-key]")
    if (fieldEls.length > 0) {
      fieldEls.forEach(el => {
        const k = el.getAttribute("data-run-key")
        const t = el.getAttribute("data-run-type")
        let v
        if (t === "boolean") v = el.checked
        else if (t === "number") {
          const raw = el.value
          if (raw === "") return
          v = Number(raw)
        }
        else if (t === "list") {
          const raw = (el.value || "").trim()
          if (!raw) return
          v = raw.split(",").map(s => s.trim()).filter(Boolean)
        }
        else if (t === "json") {
          try {
            const raw = (el.value || "").trim()
            if (!raw) return
            v = JSON.parse(raw)
          } catch (e) {
            toast("Field '" + k + "' is not valid JSON: " + e.message)
            throw e
          }
        }
        else {
          const raw = (el.value || "").trim()
          if (!raw) return
          v = raw
        }
        if (v !== undefined) payload[k] = v
      })
    }
    // Raw JSON textarea overrides field values when the operator typed
    // anything substantive — power-user escape hatch.
    try {
      const txt = (payloadEl && payloadEl.value || "{}").trim()
      if (txt && txt !== "{}") {
        const fromTextarea = JSON.parse(txt)
        if (fromTextarea && typeof fromTextarea === "object") {
          payload = { ...payload, ...fromTextarea }
        }
      }
    } catch (e) {
      toast("Raw JSON is not valid: " + e.message)
      return
    }
    const force = !!(forceEl && forceEl.checked)
    try {
      const res = await postJSON("/workflows/" + encodeURIComponent(workflowId) + "/run", { payload, force })
      if (res.runId) {
        toast("run started: " + res.runId.slice(0, 8))
        $("#wf-run-form").setAttribute("hidden", "")
        await openRun(res.runId)
      } else {
        toast("run accepted (no runId returned — check /traces)")
      }
    } catch (e) {
      // 409 from the daemon means non-manual trigger without force=true.
      // Hint the operator to flip the checkbox.
      const msg = String(e.message || e)
      if (msg.indexOf("409") >= 0 || msg.toLowerCase().indexOf("trigger is") >= 0) {
        toast("non-manual trigger — tick Force to fire anyway")
      } else {
        toast("run failed: " + msg)
      }
    }
  }

  function renderDraftDetail() {
    const draft = state.drafts.find(d => d.id === state.selectedDraftId)
    if (!draft) {
      $("#wf-detail-head").innerHTML = \`<span class="hint">Select a workflow to inspect.</span>\`
      $("#wf-detail-body").innerHTML = ""
      return
    }
    const wf = draft.workflow || {}
    const issues = Array.isArray(draft.issues) ? draft.issues : []
    const sourceIds = Array.isArray(wf.sourceTaskIds) ? wf.sourceTaskIds : []
    $("#wf-detail-head").innerHTML = \`
      <div class="ax-wf__detail-title">
        <h2>\${esc(wf.title || draft.id)}</h2>
        <span class="hint">\${esc(draft.id)} · status=\${esc(wf.status || "draft")} · state=\${esc(wf.state || "disabled")} · confidence=\${wf.confidence == null ? "—" : Number(wf.confidence).toFixed(2)}</span>
      </div>
      <div class="ax-wf__detail-actions ax-wf__draft-actions">
        <a class="ax-wf__btn" href="/workflows/editor?draft=\${encodeURIComponent(draft.id)}" title="Open this draft in the visual editor">✎ Edit visually</a>
        <button class="ax-wf__btn" id="wf-draft-validate" type="button">Validate</button>
        <button class="ax-wf__btn" id="wf-draft-save" type="button">Save</button>
        <button class="ax-wf__btn" id="wf-draft-replay" type="button">Save &amp; Replay</button>
        <button class="ax-wf__btn primary" id="wf-draft-promote" type="button">Promote</button>
        <button class="ax-wf__btn danger" id="wf-draft-reject" type="button">Reject</button>
      </div>\`

    const issueHtml = issues.length
      ? issues.map(i => \`<div class="ax-wf__trans"><span class="cond">\${esc(i)}</span></div>\`).join("")
      : \`<span class="hint">Draft validates against the workflow schema and lint rules.</span>\`
    const tags = Array.isArray(wf.tags) ? wf.tags : []
    $("#wf-detail-body").innerHTML = \`
      <div class="ax-wf__panel">
        <h3>Review state</h3>
        <div class="ax-wf__trans">
          <div>owner: \${esc(wf.ownerAgent || "—")}</div>
          <div>entity: \${esc(wf.entity || "—")}</div>
          <div>generatedFrom: \${esc(wf.generatedFrom || "—")}</div>
          <div>path: \${esc(draft.path || "—")}</div>
        </div>
      </div>
      <div class="ax-wf__panel">
        <h3>Signals</h3>
        <div class="ax-wf__states">
          \${tags.length ? tags.map(t => \`<span class="ax-wf__state">\${esc(t)}</span>\`).join("") : \`<span class="hint">No tags.</span>\`}
        </div>
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>Source task ids (\${sourceIds.length})</h3>
        <div class="ax-wf__trans">\${sourceIds.length ? sourceIds.slice(0, 25).map(esc).join("<br>") : \`<span class="hint">No source task ids.</span>\`}</div>
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>Validation</h3>
        \${issueHtml}
      </div>
      <div class="ax-wf__panel ax-wf__panel--full">
        <h3>Definition <span class="hint">(JSON; saved as YAML on disk)</span></h3>
        <textarea id="wf-draft-editor" class="ax-wf__editor" spellcheck="false">\${esc(JSON.stringify(wf, null, 2))}</textarea>
      </div>\`

    $("#wf-draft-validate").addEventListener("click", () => validateDraft(draft.id))
    $("#wf-draft-save").addEventListener("click", () => saveDraft(draft.id))
    $("#wf-draft-replay").addEventListener("click", () => replayDraft(draft.id))
    $("#wf-draft-promote").addEventListener("click", () => promoteDraft(draft.id))
    $("#wf-draft-reject").addEventListener("click", () => rejectDraft(draft.id))
  }

  // --- Run drawer ------------------------------------------------------

  async function openRun(runId) {
    state.activeRunId = runId
    const res = await fetchJSON("/api/workflows/runs/" + encodeURIComponent(runId))
    paintRun(res.run || res)
    connectRunStream(runId)
    const panel = $("#wf-run-panel")
    panel.classList.remove("hidden")
    panel.setAttribute("aria-hidden", "false")
  }

  function closeRun() {
    state.activeRunId = null
    if (state.sse) { state.sse.close(); state.sse = null }
    const panel = $("#wf-run-panel")
    panel.classList.add("hidden")
    panel.setAttribute("aria-hidden", "true")
  }

  function paintRun(run) {
    $("#wf-run-title").textContent = run.workflowId + " run"
    $("#wf-run-meta").textContent = run.id.slice(0, 8) + " · " + run.entityRef.backend + ":" + run.entityRef.id + " · home=" + run.homeNode
    const pill = $("#wf-run-status")
    pill.textContent = run.status
    pill.className = "ax-wf__status-pill " + run.status
    // V2: history entries are per-node executions, not state transitions.
    // Each entry has { at, nodeId, status, inputKeys, output?, note? }.
    $("#wf-run-timeline").innerHTML = (run.history || []).map(h => {
      const failed = h.status === "failed" || h.status === "timeout"
      const outputHint = h.output ? Object.keys(h.output).slice(0, 3).map(k => k + "=" + briefVal(h.output[k])).join(" · ") : ""
      return \`<div class="ax-wf__timeline-entry \${failed ? "result-failed" : ""}">
        <div class="time">\${new Date(h.at).toLocaleString()}</div>
        <div class="move"><strong>\${esc(h.nodeId)}</strong> · \${esc(h.status)}</div>
        \${h.inputKeys && h.inputKeys.length ? \`<div class="agent">inputs: \${h.inputKeys.map(esc).join(", ")}</div>\` : ""}
        \${outputHint ? \`<div class="agent">output: \${esc(outputHint)}</div>\` : ""}
        \${h.note ? \`<div class="agent">\${esc(h.note)}</div>\` : ""}
      </div>\`
    }).join("")
  }

  function connectRunStream(runId) {
    if (state.sse) state.sse.close()
    try {
      state.sse = new EventSource("/api/workflows/runs/" + encodeURIComponent(runId) + "/stream")
      $("#wf-run-live").textContent = "live"
      state.sse.onmessage = (evt) => {
        try {
          const run = JSON.parse(evt.data)
          paintRun(run)
        } catch { /* ignore */ }
      }
      state.sse.onerror = () => { $("#wf-run-live").textContent = "disconnected" }
    } catch { $("#wf-run-live").textContent = "sse unavailable" }
  }

  // --- Actions ---------------------------------------------------------

  async function select(id) {
    state.selectedId = id
    state.selectedDraftId = null
    // Keep URL hash in sync so refreshes and editor deep-links stay on the
    // same workflow. Use replaceState so the browser's back button doesn't
    // accumulate selection history.
    try { history.replaceState(null, "", "#" + encodeURIComponent(id)) } catch (_) { /* */ }
    renderList()
    renderDraftList()
    renderDetail()
  }

  async function selectDraft(id) {
    state.selectedDraftId = id
    state.selectedId = null
    try { history.replaceState(null, "", "#draft:" + encodeURIComponent(id)) } catch (_) { /* */ }
    renderList()
    renderDraftList()
    renderDetail()
  }

  async function refresh() {
    try {
      // summary=1 strips the heavy per-run context (webhook payloads can be
      // 10-50KB each — at limit=100 the listing was multi-MB and gating
      // first paint behind the slowest serialization path). Run-detail
      // and SSE stream still return the full shape unchanged.
      const [workflows, runs, drafts] = await Promise.all([
        fetchJSON("/api/workflows"),
        fetchJSON("/api/workflows/runs?limit=100&summary=1"),
        fetchJSON("/api/workflows/drafts"),
      ])
      state.workflows = workflows.workflows || workflows
      state.runs = runs.runs || runs
      state.drafts = drafts.drafts || drafts
      // If the URL hash names a workflow (e.g. /workflows#my-workflow)
      // and nothing is selected yet, auto-select it. Editor's "History"
      // button links here with the hash, so users land on the right detail.
      if (!state.selectedId && location.hash) {
        const fromHash = decodeURIComponent(location.hash.slice(1))
        if (fromHash.startsWith("draft:") && state.drafts.some(d => d.id === fromHash.slice(6))) state.selectedDraftId = fromHash.slice(6)
        else if (state.workflows.some(w => w.id === fromHash)) state.selectedId = fromHash
      }
      renderList()
      renderDraftList()
      // Don't re-render the detail panel when the user is actively editing
      // a draft — the periodic 15s refresh would otherwise reset their
      // unsaved textarea on every tick. Resume rendering as soon as focus
      // leaves the editor.
      const editing = state.selectedDraftId && document.activeElement && document.activeElement.id === "wf-draft-editor"
      if (!editing) renderDetail()
    } catch (e) {
      toast("Failed to load workflows: " + e.message)
    }
  }

  async function validateDraft(id) {
    try {
      const res = await postJSON("/api/workflows/drafts/" + encodeURIComponent(id) + "/validate")
      toast(res.ok ? "draft is valid" : "draft has validation issues")
      await refresh()
      state.selectedDraftId = id
      renderDetail()
    } catch (e) {
      toast("validate failed: " + e.message)
    }
  }

  async function promoteDraft(id) {
    if (!confirm("Promote this draft into the active workflow store?")) return
    try {
      await postJSON("/api/workflows/drafts/" + encodeURIComponent(id) + "/promote", { format: "yaml" })
      toast("draft promoted")
      state.selectedDraftId = null
      await refresh()
    } catch (e) {
      toast("promote failed: " + e.message)
    }
  }

  async function rejectDraft(id) {
    if (!confirm("Reject and archive this draft?")) return
    try {
      await postJSON("/api/workflows/drafts/" + encodeURIComponent(id) + "/reject")
      toast("draft rejected")
      state.selectedDraftId = null
      await refresh()
    } catch (e) {
      toast("reject failed: " + e.message)
    }
  }

  /** Read the textarea, parse as JSON (the editor is JSON; the server
   *  re-serialises to YAML on disk), and PUT to the drafts endpoint. */
  async function persistDraftFromEditor(id) {
    const el = $("#wf-draft-editor")
    if (!el) throw new Error("editor not mounted")
    let workflow
    try {
      workflow = JSON.parse(el.value)
    } catch (e) {
      throw new Error("editor JSON is invalid: " + e.message)
    }
    const res = await fetch("/api/workflows/drafts/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board", ...headers() },
      credentials: "same-origin",
      body: JSON.stringify({ workflow }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const issues = Array.isArray(data.issues) ? "\\n  - " + data.issues.join("\\n  - ") : ""
      throw new Error((data.error || "save failed") + issues)
    }
    return data
  }

  async function saveDraft(id) {
    try {
      const res = await persistDraftFromEditor(id)
      const lint = Array.isArray(res.issues) && res.issues.length ? \` (\${res.issues.length} lint warning\${res.issues.length === 1 ? "" : "s"})\` : ""
      toast("draft saved" + lint)
      await refresh()
      state.selectedDraftId = id
      renderDetail()
    } catch (e) {
      toast("save failed: " + e.message)
    }
  }

  async function replayDraft(id) {
    try {
      await persistDraftFromEditor(id)
    } catch (e) {
      toast("save failed: " + e.message)
      return
    }
    try {
      const res = await postJSON("/api/workflows/drafts/" + encodeURIComponent(id) + "/replay", {})
      toast("replay started: " + (res.runId || "?").slice(0, 8))
      if (res.runId) {
        await openRun(res.runId)
      } else {
        await refresh()
      }
    } catch (e) {
      toast("replay failed: " + e.message)
    }
  }

  function toast(msg) {
    const el = $("#wf-toast")
    el.textContent = msg
    el.hidden = false
    setTimeout(() => { el.hidden = true }, 2400)
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
  }

  function relTime(iso) {
    const d = new Date(iso).getTime()
    const s = Math.floor((Date.now() - d) / 1000)
    if (s < 60) return s + "s ago"
    if (s < 3600) return Math.floor(s/60) + "m ago"
    if (s < 86400) return Math.floor(s/3600) + "h ago"
    return Math.floor(s/86400) + "d ago"
  }

  /** Compact single-line preview of a node-output value for the timeline. */
  function briefVal(v) {
    if (v === null || v === undefined) return ""
    if (typeof v === "string") return v.length > 48 ? v.slice(0, 45) + "…" : v
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    try {
      const s = JSON.stringify(v)
      return s.length > 48 ? s.slice(0, 45) + "…" : s
    } catch { return "?" }
  }

  // --- Bindings --------------------------------------------------------

  // Run lifecycle action — pause / resume / cancel via setStatus on the
  // backend RunStore, mirroring \`agentx workflow pause/resume/cancel\`.
  // Opens a tiny confirm dialog for cancel since it's destructive.
  async function runAction(action) {
    if (!state.activeRunId) return
    if (action === "cancel" && !confirm("Cancel this run? In-flight work will stop.")) return
    const statusByAction = { pause: "paused", resume: "running", cancel: "canceled" }
    const status = statusByAction[action]
    if (!status) return
    try {
      const r = await fetch("/api/workflows/runs/" + encodeURIComponent(state.activeRunId) + "/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
        credentials: "same-origin",
        body: JSON.stringify({ status }),
      })
      if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 120))
      toast(action + "d")
      refresh()
      // Refresh the open run panel so the status pill updates immediately.
      if (state.activeRunId) openRun(state.activeRunId)
    } catch (e) {
      toast("action failed: " + e.message)
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#wf-refresh").addEventListener("click", refresh)
    $("#wf-run-close").addEventListener("click", closeRun)
    $("#wf-filter").addEventListener("input", (e) => {
      state.filter = e.target.value
      renderList()
    })
    const projSel = $("#wf-project-filter")
    if (projSel) {
      projSel.addEventListener("change", (e) => {
        state.projectFilter = e.target.value
        renderList()
      })
    }
    document.querySelectorAll('#wf-run-actions [data-run-action]').forEach((b) => {
      b.addEventListener('click', () => runAction(b.getAttribute('data-run-action')))
    })
    document.addEventListener("keydown", (e) => {
      if (e.key === "r" && !e.metaKey && document.activeElement?.tagName !== "INPUT") refresh()
      if (e.key === "Escape") closeRun()
    })
    refresh()
    // Light polling keeps run counts fresh without needing a global SSE.
    setInterval(refresh, 15000)
  })
})();
`
