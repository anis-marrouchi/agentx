// --- Projects page ---
//
// Read-only aggregated view: one row per project (rule file or
// workflow-tagged or channel-route), expandable to show its bound
// agents, workflows, channels, and contacts.
//
// Data source: GET /api/admin/projects (daemon, aggregator in
// src/daemon/projects-api.ts). Follows the topbar mesh selector via
// the existing /api/admin/* proxy contract.
//
// Scope is intentionally tight for v1:
//   - list view + detail panel
//   - links cross-navigate to /workflows, /admin/agents/<id>, etc.
//   - no editing controls yet — those land once read view is shaped

import { renderShell, esc, type TopbarPeer } from ".."

export interface ProjectsPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderProjectsPage(opts: ProjectsPageOpts = {}): string {
  const body = `<div class="ax-pj__root">
  <aside class="ax-pj__list">
    <header>
      <h2>Projects</h2>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="pj-new" class="ax-pj__icon" title="New project">+</button>
        <button id="pj-refresh" class="ax-pj__icon" title="Refresh (r)">↻</button>
      </div>
    </header>
    <div class="ax-pj__search">
      <input id="pj-filter" type="search" placeholder="Filter by project key…" autocomplete="off" />
    </div>
    <ul id="pj-list" class="ax-pj__cards" aria-live="polite"></ul>
    <div id="pj-empty" class="ax-pj__empty" hidden>
      <p>No projects yet.</p>
      <p class="hint">Add a rule under <code>.agentx/projects/&lt;org&gt;/&lt;project&gt;.yaml</code>
      OR set <code>project: org/repo</code> on a workflow to make it visible here.</p>
    </div>
    <div id="pj-warn" class="ax-pj__warn" hidden></div>
  </aside>

  <section class="ax-pj__detail">
    <header id="pj-detail-head">
      <span class="hint">Select a project to inspect.</span>
    </header>
    <div id="pj-detail-body" class="ax-pj__detail-body"></div>
  </section>
</div>`

  return renderShell({
    title: "AgentX · Projects",
    activeTab: "projects",
    subtitle: "Projects",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: PROJECTS_PAGE_CSS,
    scripts: `<script>${PROJECTS_PAGE_SCRIPT}</script>`,
  })
}

const PROJECTS_PAGE_CSS = `
.ax-pj__root {
  display: grid;
  grid-template-columns: 360px 1fr;
  height: calc(100vh - var(--ax-topbar-h, 48px));
  background: var(--ax-bg);
}
.ax-pj__list {
  border-right: 1px solid var(--ax-border);
  display: flex; flex-direction: column;
  background: var(--ax-bg-elev);
  min-height: 0;
}
.ax-pj__list > header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--ax-border);
}
.ax-pj__list > header h2 { margin: 0; font-size: 14px; }
.ax-pj__icon {
  background: transparent; color: var(--ax-fg-muted, var(--ax-fg));
  border: 1px solid transparent; border-radius: 4px;
  padding: 4px 8px; cursor: pointer; font-size: 14px;
}
.ax-pj__icon:hover { background: var(--ax-surface); }
.ax-pj__search { padding: 10px 14px; border-bottom: 1px solid var(--ax-border); }
.ax-pj__search input {
  width: 100%; font: inherit; font-size: 12px;
  padding: 6px 8px; border: 1px solid var(--ax-border);
  border-radius: 4px; background: var(--ax-bg); color: var(--ax-fg);
}
.ax-pj__cards {
  list-style: none; margin: 0; padding: 0;
  flex: 1; overflow-y: auto;
}
.ax-pj__card {
  padding: 12px 18px; border-bottom: 1px solid var(--ax-border);
  cursor: pointer; transition: background 0.1s;
}
.ax-pj__card:hover { background: var(--ax-surface); }
.ax-pj__card.is-active { background: var(--ax-surface); box-shadow: inset 3px 0 0 var(--ax-accent); }
.ax-pj__card-title { font-weight: 500; font-size: 13px; margin-bottom: 4px; }
.ax-pj__card-meta {
  display: flex; gap: 6px; flex-wrap: wrap;
  font-size: 11px; color: var(--ax-fg-muted, var(--ax-fg));
}
.ax-pj__card-meta .stat { padding: 1px 6px; border-radius: 3px; background: var(--ax-bg); border: 1px solid var(--ax-border); }
.ax-pj__card-meta .stat.zero { opacity: 0.4; }
.ax-pj__detail {
  display: flex; flex-direction: column; min-height: 0;
}
.ax-pj__detail > header {
  padding: 18px 24px; border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; justify-content: space-between;
}
.ax-pj__detail > header h2 { margin: 0; font-size: 18px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ax-pj__kind {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
  padding: 2px 8px; border-radius: 3px; font-weight: 500;
  border: 1px solid transparent;
}
.ax-pj__kind--gitlab { color: #fc6d26; background: rgba(252, 109, 38, 0.1); border-color: rgba(252, 109, 38, 0.3); }
.ax-pj__kind--github { color: #c9d1d9; background: rgba(110, 118, 129, 0.2); border-color: rgba(110, 118, 129, 0.4); }
.ax-pj__kind--jira   { color: #2684ff; background: rgba(38, 132, 255, 0.1); border-color: rgba(38, 132, 255, 0.3); }
.ax-pj__kind--linear { color: #5e6ad2; background: rgba(94, 106, 210, 0.1); border-color: rgba(94, 106, 210, 0.3); }
.ax-pj__kind--other  { color: var(--ax-fg-muted, var(--ax-fg)); background: var(--ax-bg); border-color: var(--ax-border); }
.ax-pj__keyhint { font-size: 12px; font-weight: normal; color: var(--ax-fg-muted, var(--ax-fg)); font-family: var(--ax-mono, monospace); }
.ax-pj__home {
  font-size: 12px; text-decoration: none; padding: 2px 6px;
  color: var(--ax-fg-muted, var(--ax-fg)); border: 1px solid var(--ax-border);
  border-radius: 3px;
}
.ax-pj__home:hover { color: var(--ax-accent); border-color: var(--ax-accent); }
.ax-pj__section h3 {
  display: flex; align-items: center; gap: 8px;
}
.ax-pj__btn {
  font: inherit; font-size: 11px;
  padding: 3px 8px; border: 1px solid var(--ax-border);
  border-radius: 3px; background: var(--ax-bg); color: var(--ax-fg);
  cursor: pointer; text-transform: none; letter-spacing: 0;
  margin-left: auto;
}
.ax-pj__btn:hover { border-color: var(--ax-accent); color: var(--ax-accent); }
.ax-pj__unlink {
  margin-left: auto;
  background: transparent; border: 1px solid transparent;
  color: var(--ax-fg-muted, var(--ax-fg));
  cursor: pointer; font-size: 14px; padding: 0 6px; border-radius: 3px;
}
.ax-pj__unlink:hover { color: var(--ax-err, #ef4444); border-color: var(--ax-err, #ef4444); }
/* Workflow picker modal */
.ax-pj__modal-bg {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.ax-pj__modal {
  background: var(--ax-bg-elev); border: 1px solid var(--ax-border);
  border-radius: 6px; min-width: 480px; max-width: 720px;
  max-height: 80vh; display: flex; flex-direction: column;
}
.ax-pj__modal-head {
  padding: 14px 18px; border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; justify-content: space-between;
}
.ax-pj__modal-head h3 { margin: 0; font-size: 14px; }
.ax-pj__modal-body { padding: 14px 18px; overflow-y: auto; }
.ax-pj__modal-search input {
  width: 100%; font: inherit; font-size: 13px;
  padding: 6px 10px; border: 1px solid var(--ax-border);
  border-radius: 4px; background: var(--ax-bg); color: var(--ax-fg);
  margin-bottom: 12px;
}
.ax-pj__pick {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 4px; cursor: pointer;
  border: 1px solid transparent;
}
.ax-pj__pick:hover { background: var(--ax-bg); border-color: var(--ax-border); }
.ax-pj__pick .pname { font-weight: 500; flex: 1; }
.ax-pj__pick .pmeta { font-size: 11px; color: var(--ax-fg-muted, var(--ax-fg)); }
.ax-pj__pick .ptag {
  font-size: 11px; padding: 1px 6px; border-radius: 3px;
  background: var(--ax-warn, #facc15); color: #1a1a1a;
}
/* Form fields */
.ax-pj__form { display: flex; flex-direction: column; gap: 12px; }
.ax-pj__fld { display: flex; flex-direction: column; gap: 4px; }
.ax-pj__fld-label { font-size: 12px; font-weight: 500; color: var(--ax-fg-muted, var(--ax-fg)); }
.ax-pj__fld input, .ax-pj__fld select {
  font: inherit; font-size: 13px;
  padding: 6px 10px; border: 1px solid var(--ax-border);
  border-radius: 4px; background: var(--ax-bg); color: var(--ax-fg);
}
.ax-pj__fld-hint { font-size: 11px; color: var(--ax-fg-muted, var(--ax-fg)); }
.ax-pj__form-actions {
  display: flex; gap: 8px; align-items: center;
  margin-top: 8px; padding-top: 14px;
  border-top: 1px solid var(--ax-border);
}
.ax-pj__btn--primary {
  background: var(--ax-accent, #6366f1); color: white;
  border-color: var(--ax-accent, #6366f1);
}
.ax-pj__btn--primary:hover { opacity: 0.9; }
.ax-pj__btn--danger { color: var(--ax-err, #ef4444); border-color: var(--ax-err, #ef4444); }
.ax-pj__btn--danger:hover { background: var(--ax-err, #ef4444); color: white; }
.ax-pj__fld textarea {
  font: inherit; font-family: var(--ax-mono, monospace); font-size: 12px;
  padding: 6px 10px; border: 1px solid var(--ax-border);
  border-radius: 4px; background: var(--ax-bg); color: var(--ax-fg);
  resize: vertical;
}
.ax-pj__clause {
  border: 1px solid var(--ax-border); border-radius: 4px;
  padding: 12px; margin-bottom: 12px; background: var(--ax-bg);
}
.ax-pj__clause h4 {
  margin: 0 0 10px 0; font-size: 12px;
  font-family: var(--ax-mono, monospace);
  color: var(--ax-accent); text-transform: lowercase;
}
.ax-pj__form details summary {
  cursor: pointer; padding: 6px 0; font-weight: 500;
  border-bottom: 1px solid var(--ax-border); margin-bottom: 12px;
}
.ax-pj__detail-body { padding: 24px; overflow-y: auto; flex: 1; }
.ax-pj__section {
  margin-bottom: 28px;
}
.ax-pj__section h3 {
  font-size: 13px; text-transform: uppercase; letter-spacing: 0.6px;
  color: var(--ax-fg-muted, var(--ax-fg)); margin: 0 0 10px 0;
}
.ax-pj__row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border: 1px solid var(--ax-border);
  border-radius: 4px; margin-bottom: 6px; background: var(--ax-bg);
}
.ax-pj__row .name { font-weight: 500; }
.ax-pj__row .meta { font-size: 11px; color: var(--ax-fg-muted, var(--ax-fg)); }
.ax-pj__row a { color: var(--ax-accent); text-decoration: none; }
.ax-pj__row a:hover { text-decoration: underline; }
.ax-pj__empty, .ax-pj__warn {
  padding: 18px; font-size: 12px; color: var(--ax-fg-muted, var(--ax-fg));
}
.ax-pj__warn { color: var(--ax-warn, #facc15); border-top: 1px solid var(--ax-border); }
.ax-pj__hint { font-size: 11px; color: var(--ax-fg-muted, var(--ax-fg)); margin-top: 4px; }
`

const PROJECTS_PAGE_SCRIPT = `
(function(){
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
  const state = { rows: [], warnings: [], selectedKey: null, filter: "" };

  async function load() {
    const r = await fetch("/api/admin/projects");
    const data = await r.json().catch(() => ({}));
    state.rows = Array.isArray(data.projects) ? data.projects : [];
    state.warnings = Array.isArray(data.warnings) ? data.warnings : [];
    if (!state.selectedKey && state.rows[0]) state.selectedKey = state.rows[0].project;
    render();
  }

  function render() {
    renderList();
    renderDetail();
    renderWarnings();
  }

  function renderList() {
    const list = $("#pj-list");
    const empty = $("#pj-empty");
    const needle = state.filter.toLowerCase();
    const visible = state.rows.filter(p => !needle || p.project.toLowerCase().includes(needle));
    if (visible.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = visible.map(p => {
      const isActive = p.project === state.selectedKey;
      const wfCount = p.workflows.length;
      const agentCount = p.agents.length;
      const contactCount = p.contacts.length;
      return '<li class="ax-pj__card ' + (isActive ? 'is-active' : '') + '" data-key="' + esc(p.project) + '">'
        + '<div class="ax-pj__card-title">' + esc(p.project) + '</div>'
        + '<div class="ax-pj__card-meta">'
        +   '<span class="stat ' + (agentCount === 0 ? 'zero' : '') + '" title="Agents bound to this project">' + agentCount + ' agents</span>'
        +   '<span class="stat ' + (wfCount === 0 ? 'zero' : '') + '" title="Workflows tagged with this project">' + wfCount + ' workflows</span>'
        +   '<span class="stat ' + (contactCount === 0 ? 'zero' : '') + '" title="Contacts associated with this project">' + contactCount + ' contacts</span>'
        +   (p.channels.length ? '<span class="stat" title="Channels carrying this project">' + esc(p.channels.join(", ")) + '</span>' : '')
        + '</div>'
        + '</li>';
    }).join("");
    list.querySelectorAll(".ax-pj__card").forEach(el => {
      el.addEventListener("click", () => {
        state.selectedKey = el.dataset.key;
        render();
      });
    });
  }

  function renderDetail() {
    const head = $("#pj-detail-head");
    const body = $("#pj-detail-body");
    const p = state.rows.find(r => r.project === state.selectedKey);
    if (!p) {
      head.innerHTML = '<span class="hint">Select a project to inspect.</span>';
      body.innerHTML = "";
      return;
    }
    const kindBadge = '<span class="ax-pj__kind ax-pj__kind--' + esc(p.kind || 'other') + '">' + esc(p.kind || 'other') + '</span>';
    const homeLink = p.homeUrl ? ' <a href="' + esc(p.homeUrl) + '" target="_blank" rel="noopener" class="ax-pj__home" title="Open project home">↗</a>' : '';
    const heading = p.displayName ? esc(p.displayName) + ' <span class="ax-pj__keyhint">' + esc(p.project) + '</span>' : esc(p.project);
    const canEdit = !!p.rulePath;  // only rule-backed projects are mutable
    const editBtn = canEdit
      ? '<button class="ax-pj__btn" data-action="edit-project" data-project="' + esc(p.project) + '" style="margin-left:auto">Edit</button>'
      : '<span class="ax-pj__hint" style="margin-left:auto">no rule file</span>';
    head.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%">'
      + '<h2>' + kindBadge + ' ' + heading + homeLink + '</h2>'
      + editBtn
      + '</div>'
      + '<div class="ax-pj__hint">'
      +   (p.runbook ? 'runbook: <code>' + esc(p.runbook) + '</code>' : '<em>no runbook</em>')
      +   (p.rulePath ? ' · rule: <code>' + esc(p.rulePath.split('/').slice(-3).join('/')) + '</code>' : '')
      + '</div>';

    let html = "";

    // Channels
    html += '<section class="ax-pj__section">'
      + '<h3>Channels (' + p.channels.length + ')'
      +   (p.rulePath ? '   <button class="ax-pj__btn" data-action="edit-clauses" data-project="' + esc(p.project) + '" title="Edit channel-clause filters (actions / labels / states / authors)">Edit clauses</button>' : '')
      + '</h3>';
    if (p.channels.length === 0) html += '<div class="ax-pj__hint">No channel route configured. ' + (p.rulePath ? 'Click <strong>Edit clauses</strong> above to add a gitlab or github clause, or' : 'A') + ' add a route under <code>channels.gitlab.routes</code> or <code>channels.github.routes</code>.</div>';
    else html += p.channels.map(c => {
      const cl = p.clauses && p.clauses[c];
      const summary = cl ? Object.keys(cl).join(", ") : "no rules";
      return '<div class="ax-pj__row"><span class="name">' + esc(c) + '</span><span class="meta">' + esc(summary) + '</span></div>';
    }).join("");
    html += '</section>';

    // Agents
    html += '<section class="ax-pj__section">'
      + '<h3>Agents (' + p.agents.length + ')'
      +   (p.rulePath ? '   <button class="ax-pj__btn" data-action="set-agent" data-project="' + esc(p.project) + '" title="Bind a default agent (writes rule.agent)">Set default agent</button>' : '')
      + '</h3>';
    if (p.agents.length === 0) html += '<div class="ax-pj__hint">No agents bound. Click <strong>Set default agent</strong> above, or add a channel route in agentx.json.</div>';
    else html += p.agents.map(a => {
      const canUnbind = a.via === "rule.agent" && p.rulePath;
      return '<div class="ax-pj__row">'
        + '<span class="name"><a href="/admin/agents/' + esc(a.agentId) + '">' + esc(a.agentId) + '</a></span>'
        + '<span class="meta">' + esc(a.channel) + (a.gitlabUsername ? ' · @' + esc(a.gitlabUsername) : '') + ' · via ' + esc(a.via) + '</span>'
        + (canUnbind ? '<button class="ax-pj__unlink" data-action="unbind-agent" data-project="' + esc(p.project) + '" title="Clear rule.agent">×</button>' : '')
        + '</div>';
    }).join("");
    html += '</section>';

    // Workflows
    html += '<section class="ax-pj__section">'
      + '<h3>Workflows (' + p.workflows.length + ')'
      + '   <button class="ax-pj__btn" data-action="add-workflow" data-project="' + esc(p.project) + '" title="Tag a workflow with this project">+ Add workflow</button>'
      + '</h3>';
    if (p.workflows.length === 0) html += '<div class="ax-pj__hint">No workflows tagged with this project. Click <strong>+ Add workflow</strong> above, or set <code>project: ' + esc(p.project) + '</code> in a workflow YAML.</div>';
    else html += p.workflows.map(w =>
      '<div class="ax-pj__row">'
      + '<span class="name"><a href="/workflows#' + esc(w.id) + '">' + esc(w.title || w.id) + '</a></span>'
      + '<span class="meta">' + esc(w.id) + (w.trigger ? ' · ' + esc(w.trigger) : '') + ' · ' + esc(w.status) + '</span>'
      + '<button class="ax-pj__unlink" data-action="unlink-workflow" data-workflow-id="' + esc(w.id) + '" data-project="' + esc(p.project) + '" title="Strip the project tag from this workflow">×</button>'
      + '</div>').join("");
    html += '</section>';

    // Contacts
    html += '<section class="ax-pj__section">'
      + '<h3>Contacts (' + p.contacts.length + ')'
      +   (p.rulePath ? '   <button class="ax-pj__btn" data-action="add-contact" data-project="' + esc(p.project) + '" title="Link a contact id to this project">+ Add contact</button>' : '')
      + '</h3>';
    if (p.contacts.length === 0) html += '<div class="ax-pj__hint">No contacts associated. Click <strong>+ Add contact</strong> above, or set <code>"project": "' + esc(p.project) + '"</code> on a contact in <code>.agentx/contacts.json</code>.</div>';
    else html += p.contacts.map(c =>
      '<div class="ax-pj__row">'
      + '<span class="name">' + esc(c.name) + '</span>'
      + '<span class="meta">' + esc(c.id) + (c.channels.length ? ' · ' + esc(c.channels.join(", ")) : '') + '</span>'
      + (p.rulePath ? '<button class="ax-pj__unlink" data-action="unlink-contact" data-project="' + esc(p.project) + '" data-contact-id="' + esc(c.id) + '" title="Remove from rule.contacts">×</button>' : '')
      + '</div>').join("");
    html += '</section>';

    body.innerHTML = html;
  }

  function renderWarnings() {
    const w = $("#pj-warn");
    if (!state.warnings.length) { w.hidden = true; return; }
    w.hidden = false;
    w.innerHTML = state.warnings.map(x => '⚠ ' + esc(x)).join("<br>");
  }

  // ── Workflow link/unlink ──────────────────────────────────────────
  // Both go through /api/admin/projects/workflows/{link,unlink} (the
  // existing /api/admin/* proxy + admin-panel forwarder). On success
  // we reload the page state — the aggregator picks up the new tag.

  async function unlinkWorkflow(workflowId, projectKey) {
    if (!confirm("Strip project tag '" + projectKey + "' from workflow '" + workflowId + "'?")) return;
    try {
      const r = await fetch("/api/admin/projects/workflows/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
        body: JSON.stringify({ projectKey, workflowId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      await load();
    } catch (e) {
      alert("Unlink failed: " + (e.message || e));
    }
  }

  async function linkWorkflow(workflowId, projectKey) {
    try {
      const r = await fetch("/api/admin/projects/workflows/link", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
        body: JSON.stringify({ projectKey, workflowId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      closeModal();
      await load();
    } catch (e) {
      alert("Link failed: " + (e.message || e));
    }
  }

  // ── Workflow picker modal ────────────────────────────────────────

  function closeModal() {
    const bg = document.querySelector(".ax-pj__modal-bg");
    if (bg) bg.remove();
  }

  async function openWorkflowPicker(projectKey) {
    // Fetch the full workflow list via the existing /api/workflows
    // endpoint (proxied through the mesh selector — the picker shows
    // workflows from the SELECTED node, not local). Workflows already
    // tagged with this project are still shown but flagged.
    let workflows = [];
    try {
      const r = await fetch("/api/workflows");
      const data = await r.json();
      workflows = Array.isArray(data.workflows) ? data.workflows : [];
    } catch (e) { alert("Could not load workflows: " + e.message); return; }

    // Build modal.
    const bg = document.createElement("div");
    bg.className = "ax-pj__modal-bg";
    bg.innerHTML =
      '<div class="ax-pj__modal" role="dialog" aria-label="Pick workflow">'
      + '<div class="ax-pj__modal-head">'
      +   '<h3>Tag a workflow with <code>' + esc(projectKey) + '</code></h3>'
      +   '<button class="ax-pj__icon" data-pj-close>×</button>'
      + '</div>'
      + '<div class="ax-pj__modal-body">'
      +   '<div class="ax-pj__modal-search"><input type="search" id="pj-pick-search" placeholder="Filter by id or title…" autofocus /></div>'
      +   '<div id="pj-pick-list"></div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
    bg.querySelector("[data-pj-close]").addEventListener("click", closeModal);

    function renderPickList() {
      const needle = (document.getElementById("pj-pick-search").value || "").toLowerCase();
      const filtered = workflows.filter(w =>
        !needle || w.id.toLowerCase().includes(needle) || (w.title || "").toLowerCase().includes(needle));
      const html = filtered.map(w => {
        const alreadyHere = w.project === projectKey;
        const otherProject = w.project && w.project !== projectKey;
        return '<div class="ax-pj__pick" data-wf-id="' + esc(w.id) + '">'
          + '<span class="pname">' + esc(w.title || w.id) + '</span>'
          + '<span class="pmeta">' + esc(w.id) + '</span>'
          + (alreadyHere ? '<span class="ptag">already linked</span>' : "")
          + (otherProject ? '<span class="ptag" title="Currently on ' + esc(w.project) + '">' + esc(w.project) + ' → ' + esc(projectKey) + '</span>' : "")
          + '</div>';
      }).join("") || '<div class="ax-pj__hint">No workflows match.</div>';
      document.getElementById("pj-pick-list").innerHTML = html;
      document.querySelectorAll(".ax-pj__pick").forEach(el => {
        el.addEventListener("click", () => linkWorkflow(el.dataset.wfId, projectKey));
      });
    }
    renderPickList();
    document.getElementById("pj-pick-search").addEventListener("input", renderPickList);
    document.addEventListener("keydown", function escClose(e) {
      if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", escClose); }
    });
  }

  // ── POST helper used by every mutation. Returns parsed json or
  //    throws with the server-side error message.
  async function postJson(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }

  // ── Header edit modal ─────────────────────────────────────────────
  function openHeaderEditModal(projectKey) {
    const p = state.rows.find(r => r.project === projectKey);
    if (!p) return;
    const bg = document.createElement("div");
    bg.className = "ax-pj__modal-bg";
    bg.innerHTML =
      '<div class="ax-pj__modal" role="dialog" aria-label="Edit project header">'
      + '<div class="ax-pj__modal-head">'
      +   '<h3>Edit <code>' + esc(projectKey) + '</code></h3>'
      +   '<button class="ax-pj__icon" data-pj-close>×</button>'
      + '</div>'
      + '<div class="ax-pj__modal-body">'
      +   '<form id="pj-edit-form" class="ax-pj__form">'
      +     fld("Display name", "displayName", p.displayName || "", "Friendly name shown on this page")
      +     fld("Home URL", "homeUrl", p.homeUrl || "", "External link to repo / board")
      +     selFld("Kind", "kind", p.kind || "other", ["gitlab","github","jira","linear","other"])
      +     fld("Runbook path", "runbook", p.runbook || "", "Filesystem path; injected into agent system prefix")
      +     fld("Default agent", "agent", "", "agentId — leave blank to keep / clear field")
      +     '<div class="ax-pj__form-actions">'
      +       '<button type="submit" class="ax-pj__btn ax-pj__btn--primary">Save</button>'
      +       '<button type="button" class="ax-pj__btn" data-pj-close>Cancel</button>'
      +       '<button type="button" class="ax-pj__btn ax-pj__btn--danger" data-pj-delete style="margin-left:auto">Delete project</button>'
      +     '</div>'
      +   '</form>'
      + '</div>'
      + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
    bg.querySelectorAll("[data-pj-close]").forEach(b => b.addEventListener("click", closeModal));
    bg.querySelector("#pj-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const patch = {};
      for (const k of ["displayName", "homeUrl", "kind", "runbook", "agent"]) {
        const v = (f.get(k) || "").toString();
        // Only include fields the operator actually filled — preserves
        // current values on the server when the input was left blank.
        // Exception: when the field had a value before and is now empty,
        // we DO send "" to clear it. We can't distinguish those two
        // cases with FormData alone, so the convention here is: blank
        // submit means clear. Operator wanting to keep a value should
        // close the modal without saving. Documented in the help text
        // above each field.
        patch[k] = v;
      }
      try {
        await postJson("/api/admin/projects/header", { projectKey, patch });
        closeModal();
        await load();
      } catch (err) { alert("Save failed: " + err.message); }
    });
    bg.querySelector("[data-pj-delete]").addEventListener("click", async () => {
      if (!confirm("Delete project '" + projectKey + "'? Rule file will be backed up.")) return;
      try {
        await postJson("/api/admin/projects/delete", { projectKey });
        closeModal();
        state.selectedKey = null;
        await load();
      } catch (err) { alert("Delete failed: " + err.message); }
    });
  }

  function fld(label, name, value, hint) {
    return '<label class="ax-pj__fld">'
      + '<span class="ax-pj__fld-label">' + esc(label) + '</span>'
      + '<input type="text" name="' + esc(name) + '" value="' + esc(value) + '" />'
      + (hint ? '<span class="ax-pj__fld-hint">' + esc(hint) + '</span>' : '')
      + '</label>';
  }
  function selFld(label, name, value, options) {
    const opts = options.map(o => '<option value="' + esc(o) + '"' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>').join("");
    return '<label class="ax-pj__fld">'
      + '<span class="ax-pj__fld-label">' + esc(label) + '</span>'
      + '<select name="' + esc(name) + '">' + opts + '</select>'
      + '</label>';
  }

  // ── Set/unbind default agent ──────────────────────────────────────
  async function setDefaultAgent(projectKey) {
    // Pull agents from the SELECTED node (mesh-aware /api/agents).
    let agents = [];
    try {
      const r = await fetch("/api/agents");
      const data = await r.json();
      agents = Array.isArray(data) ? data : (data.agents || []);
    } catch (e) { alert("Could not load agents: " + e.message); return; }
    const id = prompt("Agent id to set as default for '" + projectKey + "':\\n\\n"
      + "Available: " + agents.map(a => a.id).join(", "));
    if (!id) return;
    try {
      await postJson("/api/admin/projects/header", { projectKey, patch: { agent: id } });
      await load();
    } catch (e) { alert("Set agent failed: " + e.message); }
  }

  async function unbindAgent(projectKey) {
    if (!confirm("Clear default agent on '" + projectKey + "'?")) return;
    try {
      await postJson("/api/admin/projects/header", { projectKey, patch: { agent: "" } });
      await load();
    } catch (e) { alert("Unbind failed: " + e.message); }
  }

  // ── Contact add/remove ───────────────────────────────────────────
  async function addContact(projectKey) {
    const cid = prompt("Contact id to link to '" + projectKey + "':\\n\\n"
      + "Use the id from .agentx/contacts.json (e.g. 'anis', 'omar').");
    if (!cid) return;
    try {
      await postJson("/api/admin/projects/contacts/link", { projectKey, contactId: cid.trim() });
      await load();
    } catch (e) { alert("Link contact failed: " + e.message); }
  }

  async function unlinkContactAction(projectKey, contactId) {
    if (!confirm("Unlink '" + contactId + "' from '" + projectKey + "'?")) return;
    try {
      await postJson("/api/admin/projects/contacts/unlink", { projectKey, contactId });
      await load();
    } catch (e) { alert("Unlink contact failed: " + e.message); }
  }

  // ── Channel-clause editor modal ───────────────────────────────────
  //
  // Renders one section per clause (gitlab.issue, gitlab.merge_request,
  // gitlab.note, gitlab.pipeline, github.issues, github.pull_request).
  // Each list field is a <textarea> where one line = one entry. On
  // save we parse back into the shape the rule expects and POST the
  // entire gitlab + github block. Operator can clear a clause by
  // emptying ALL its textareas (the prune step on the server side
  // drops empty objects).
  //
  // Triggers field on note clauses uses a mini DSL — one line each:
  //     auto                     → { auto-resolve from agentMappings }
  //     @username                → { mention: "@username" }
  //     keyword: phrase          → { keyword: "phrase" }
  // Empty lines ignored. Format is line-oriented to keep the textarea
  // usable; structured editors can land later.

  const CLAUSE_FIELDS = {
    issue:         ["actions", "requireLabels", "excludeLabels", "excludeStates", "excludeAuthors"],
    merge_request: ["actions", "requireLabels", "excludeLabels", "excludeStates", "excludeAuthors"],
    pipeline:      ["actions"],
    issues:        ["actions", "requireLabels", "excludeLabels", "excludeStates", "excludeAuthors"],
    pull_request:  ["actions", "requireLabels", "excludeLabels", "excludeStates", "excludeAuthors"],
  };

  function listToText(arr) { return Array.isArray(arr) ? arr.join("\\n") : ""; }
  function textToList(s) {
    return String(s || "").split("\\n").map(x => x.trim()).filter(x => x.length > 0);
  }
  function triggersToText(trigs) {
    if (!Array.isArray(trigs)) return "";
    return trigs.map(t => {
      if (t === "auto" || (t && t.auto)) return "auto";
      if (t && t.mention) return t.mention;
      if (t && t.keyword) return "keyword: " + t.keyword;
      return "";
    }).filter(Boolean).join("\\n");
  }
  function textToTriggers(s) {
    const out = [];
    for (const line of String(s || "").split("\\n").map(l => l.trim()).filter(Boolean)) {
      if (line === "auto") out.push("auto");
      else if (line.toLowerCase().startsWith("keyword:")) out.push({ keyword: line.slice(8).trim() });
      else if (line.startsWith("@")) out.push({ mention: line });
      else out.push({ keyword: line }); // fallback
    }
    return out;
  }

  function clauseForm(channel, clauseName, current) {
    const cur = current || {};
    let html = '<div class="ax-pj__clause" data-clause="' + esc(channel + "." + clauseName) + '">'
      + '<h4>' + esc(channel) + '.' + esc(clauseName) + '</h4>';
    if (clauseName === "note") {
      html += listFld("Only on (one per line: issue / merge_request / commit / snippet)", "onlyOn", listToText(cur.onlyOn));
      html += listFld("Triggers (auto, @user, or 'keyword: phrase' — one per line)", "triggers", triggersToText(cur.triggers));
      html += listFld("Exclude authors (substring match — one per line)", "excludeAuthors", listToText(cur.excludeAuthors));
    } else {
      const fields = CLAUSE_FIELDS[clauseName] || [];
      for (const f of fields) {
        const labels = {
          actions: "Actions (one per line: open, reopen, update, close, …)",
          requireLabels: "Require labels (at least one must match — one per line)",
          excludeLabels: "Exclude labels (any present blocks — one per line)",
          excludeStates: "Exclude states (one per line: closed, opened, merged, …)",
          excludeAuthors: "Exclude authors (substring match — one per line)",
        };
        html += listFld(labels[f] || f, f, listToText(cur[f]));
      }
    }
    html += '</div>';
    return html;
  }
  function listFld(label, name, value) {
    return '<label class="ax-pj__fld">'
      + '<span class="ax-pj__fld-label">' + esc(label) + '</span>'
      + '<textarea name="' + esc(name) + '" rows="3">' + esc(value) + '</textarea>'
      + '</label>';
  }

  function readClauseFromForm(scopeEl, clauseName) {
    const out = {};
    const fieldNames = clauseName === "note"
      ? ["onlyOn", "triggers", "excludeAuthors"]
      : CLAUSE_FIELDS[clauseName] || [];
    for (const f of fieldNames) {
      const ta = scopeEl.querySelector('textarea[name="' + f + '"]');
      if (!ta) continue;
      const v = ta.value;
      if (f === "triggers") {
        const t = textToTriggers(v);
        if (t.length > 0) out[f] = t;
      } else {
        const list = textToList(v);
        if (list.length > 0) out[f] = list;
      }
    }
    return out;
  }

  function openClauseEditor(projectKey) {
    const p = state.rows.find(r => r.project === projectKey);
    if (!p) return;
    const cur = p.clauses || {};
    const gl = cur.gitlab || {};
    const gh = cur.github || {};

    const bg = document.createElement("div");
    bg.className = "ax-pj__modal-bg";
    bg.innerHTML =
      '<div class="ax-pj__modal" style="min-width:640px" role="dialog" aria-label="Edit channel clauses">'
      + '<div class="ax-pj__modal-head">'
      +   '<h3>Channel clauses · <code>' + esc(projectKey) + '</code></h3>'
      +   '<button class="ax-pj__icon" data-pj-close>×</button>'
      + '</div>'
      + '<div class="ax-pj__modal-body">'
      +   '<form id="pj-clauses-form" class="ax-pj__form">'
      +     '<details open><summary>GitLab</summary>'
      +       clauseForm("gitlab", "issue", gl.issue)
      +       clauseForm("gitlab", "merge_request", gl.merge_request)
      +       clauseForm("gitlab", "note", gl.note)
      +       clauseForm("gitlab", "pipeline", gl.pipeline)
      +     '</details>'
      +     '<details><summary>GitHub</summary>'
      +       clauseForm("github", "issues", gh.issues)
      +       clauseForm("github", "pull_request", gh.pull_request)
      +     '</details>'
      +     '<div class="ax-pj__form-actions">'
      +       '<button type="submit" class="ax-pj__btn ax-pj__btn--primary">Save clauses</button>'
      +       '<button type="button" class="ax-pj__btn" data-pj-close>Cancel</button>'
      +     '</div>'
      +   '</form>'
      + '</div>'
      + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
    bg.querySelectorAll("[data-pj-close]").forEach(b => b.addEventListener("click", closeModal));
    bg.querySelector("#pj-clauses-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      // Read each clause section back into the shape the rule expects.
      // Empty clauses (every textarea blank) drop out via pruneEmpty on
      // the server, so the YAML stays clean.
      const gitlabOut = {
        issue:         readClauseFromForm(bg.querySelector('[data-clause="gitlab.issue"]'), "issue"),
        merge_request: readClauseFromForm(bg.querySelector('[data-clause="gitlab.merge_request"]'), "merge_request"),
        note:          readClauseFromForm(bg.querySelector('[data-clause="gitlab.note"]'), "note"),
        pipeline:      readClauseFromForm(bg.querySelector('[data-clause="gitlab.pipeline"]'), "pipeline"),
      };
      const githubOut = {
        issues:       readClauseFromForm(bg.querySelector('[data-clause="github.issues"]'), "issues"),
        pull_request: readClauseFromForm(bg.querySelector('[data-clause="github.pull_request"]'), "pull_request"),
      };
      // Strip empty inner objects so the rule doesn't end up with
      // ghost-clauses (e.g. issue:{} when no fields were set).
      const cleanInner = (o) => {
        const r = {};
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === "object" && Object.keys(v).length > 0) r[k] = v;
        }
        return r;
      };
      const cleanGl = cleanInner(gitlabOut);
      const cleanGh = cleanInner(githubOut);
      try {
        await postJson("/api/admin/projects/clauses", {
          projectKey,
          gitlab: Object.keys(cleanGl).length > 0 ? cleanGl : null,
          github: Object.keys(cleanGh).length > 0 ? cleanGh : null,
        });
        closeModal();
        await load();
      } catch (err) { alert("Save clauses failed: " + err.message); }
    });
  }

  // ── New project modal ─────────────────────────────────────────────
  function openNewProjectModal() {
    const bg = document.createElement("div");
    bg.className = "ax-pj__modal-bg";
    bg.innerHTML =
      '<div class="ax-pj__modal" role="dialog" aria-label="New project">'
      + '<div class="ax-pj__modal-head">'
      +   '<h3>New project</h3>'
      +   '<button class="ax-pj__icon" data-pj-close>×</button>'
      + '</div>'
      + '<div class="ax-pj__modal-body">'
      +   '<form id="pj-new-form" class="ax-pj__form">'
      +     fld("Project key", "projectKey", "", "org/repo for VCS, or any slug for jira/linear/other")
      +     selFld("Kind", "kind", "gitlab", ["gitlab","github","jira","linear","other"])
      +     fld("Display name", "displayName", "", "Optional human-friendly title")
      +     fld("Home URL", "homeUrl", "", "Optional link to repo / board")
      +     fld("Runbook path", "runbook", "", "Optional filesystem path")
      +     fld("Default agent", "agent", "", "Optional agentId")
      +     '<div class="ax-pj__form-actions">'
      +       '<button type="submit" class="ax-pj__btn ax-pj__btn--primary">Create</button>'
      +       '<button type="button" class="ax-pj__btn" data-pj-close>Cancel</button>'
      +     '</div>'
      +   '</form>'
      + '</div>'
      + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
    bg.querySelectorAll("[data-pj-close]").forEach(b => b.addEventListener("click", closeModal));
    bg.querySelector("#pj-new-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const projectKey = (f.get("projectKey") || "").toString().trim();
      if (!projectKey) { alert("project key required"); return; }
      const body = {
        projectKey,
        kind: (f.get("kind") || "other").toString(),
        displayName: (f.get("displayName") || "").toString() || undefined,
        homeUrl: (f.get("homeUrl") || "").toString() || undefined,
        runbook: (f.get("runbook") || "").toString() || undefined,
        agent: (f.get("agent") || "").toString() || undefined,
      };
      try {
        await postJson("/api/admin/projects/create", body);
        closeModal();
        state.selectedKey = projectKey;
        await load();
      } catch (err) { alert("Create failed: " + err.message); }
    });
  }

  // Delegate clicks for unlink + add buttons since detail re-renders.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const unlinkBtn = t.closest("[data-action='unlink-workflow']");
    if (unlinkBtn) {
      e.preventDefault();
      unlinkWorkflow(unlinkBtn.dataset.workflowId, unlinkBtn.dataset.project);
      return;
    }
    const addBtn = t.closest("[data-action='add-workflow']");
    if (addBtn) {
      e.preventDefault();
      openWorkflowPicker(addBtn.dataset.project);
      return;
    }
    const editBtn = t.closest("[data-action='edit-project']");
    if (editBtn) { e.preventDefault(); openHeaderEditModal(editBtn.dataset.project); return; }
    const editClausesBtn = t.closest("[data-action='edit-clauses']");
    if (editClausesBtn) { e.preventDefault(); openClauseEditor(editClausesBtn.dataset.project); return; }
    const setAgentBtn = t.closest("[data-action='set-agent']");
    if (setAgentBtn) { e.preventDefault(); setDefaultAgent(setAgentBtn.dataset.project); return; }
    const unbindAgentBtn = t.closest("[data-action='unbind-agent']");
    if (unbindAgentBtn) { e.preventDefault(); unbindAgent(unbindAgentBtn.dataset.project); return; }
    const addContactBtn = t.closest("[data-action='add-contact']");
    if (addContactBtn) { e.preventDefault(); addContact(addContactBtn.dataset.project); return; }
    const unlinkContactBtn = t.closest("[data-action='unlink-contact']");
    if (unlinkContactBtn) { e.preventDefault(); unlinkContactAction(unlinkContactBtn.dataset.project, unlinkContactBtn.dataset.contactId); return; }
  });

  document.addEventListener("DOMContentLoaded", () => {
    $("#pj-refresh").addEventListener("click", load);
    $("#pj-new").addEventListener("click", openNewProjectModal);
    $("#pj-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderList(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "r" && !e.metaKey && document.activeElement?.tagName !== "INPUT") load();
    });
    load();
  });
})();
`
