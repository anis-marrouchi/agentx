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
      <button id="pj-refresh" class="ax-pj__icon" title="Refresh (r)">↻</button>
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
.ax-pj__detail > header h2 { margin: 0; font-size: 18px; }
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
    head.innerHTML = '<h2>' + esc(p.project) + '</h2>'
      + '<div class="ax-pj__hint">'
      +   (p.runbook ? 'runbook: <code>' + esc(p.runbook) + '</code>' : '<em>no runbook</em>')
      +   (p.rulePath ? ' · rule: <code>' + esc(p.rulePath.split('/').slice(-3).join('/')) + '</code>' : '')
      + '</div>';

    let html = "";

    // Channels
    html += '<section class="ax-pj__section"><h3>Channels (' + p.channels.length + ')</h3>';
    if (p.channels.length === 0) html += '<div class="ax-pj__hint">No channel route configured. Add a route under <code>channels.gitlab.routes</code> or <code>channels.github.routes</code>.</div>';
    else html += p.channels.map(c => '<div class="ax-pj__row"><span class="name">' + esc(c) + '</span></div>').join("");
    html += '</section>';

    // Agents
    html += '<section class="ax-pj__section"><h3>Agents (' + p.agents.length + ')</h3>';
    if (p.agents.length === 0) html += '<div class="ax-pj__hint">No agents bound. Set <code>agent</code> on the project rule or add a route.</div>';
    else html += p.agents.map(a =>
      '<div class="ax-pj__row">'
      + '<span class="name"><a href="/admin/agents/' + esc(a.agentId) + '">' + esc(a.agentId) + '</a></span>'
      + '<span class="meta">' + esc(a.channel) + (a.gitlabUsername ? ' · @' + esc(a.gitlabUsername) : '') + ' · via ' + esc(a.via) + '</span>'
      + '</div>').join("");
    html += '</section>';

    // Workflows
    html += '<section class="ax-pj__section"><h3>Workflows (' + p.workflows.length + ')</h3>';
    if (p.workflows.length === 0) html += '<div class="ax-pj__hint">No workflows tagged with this project. Set <code>project: ' + esc(p.project) + '</code> on a workflow YAML to associate it here.</div>';
    else html += p.workflows.map(w =>
      '<div class="ax-pj__row">'
      + '<span class="name"><a href="/workflows#' + esc(w.id) + '">' + esc(w.title || w.id) + '</a></span>'
      + '<span class="meta">' + esc(w.id) + (w.trigger ? ' · ' + esc(w.trigger) : '') + ' · ' + esc(w.status) + '</span>'
      + '</div>').join("");
    html += '</section>';

    // Contacts
    html += '<section class="ax-pj__section"><h3>Contacts (' + p.contacts.length + ')</h3>';
    if (p.contacts.length === 0) html += '<div class="ax-pj__hint">No contacts associated. Tag entries in <code>.agentx/contacts.json</code> with <code>"project": "' + esc(p.project) + '"</code>.</div>';
    else html += p.contacts.map(c =>
      '<div class="ax-pj__row">'
      + '<span class="name">' + esc(c.name) + '</span>'
      + '<span class="meta">' + esc(c.id) + (c.channels.length ? ' · ' + esc(c.channels.join(", ")) : '') + '</span>'
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

  document.addEventListener("DOMContentLoaded", () => {
    $("#pj-refresh").addEventListener("click", load);
    $("#pj-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderList(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "r" && !e.metaKey && document.activeElement?.tagName !== "INPUT") load();
    });
    load();
  });
})();
`
