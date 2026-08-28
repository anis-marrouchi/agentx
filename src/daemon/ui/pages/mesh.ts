import {
  healthStrip,
  pageHead,
  renderShell,
  sectionHead,
  type TopbarPeer,
} from "../index"
import { MESH_CSS } from "./mesh.css"
import { MESH_SHARED_SCRIPT } from "./mesh-shared.client"
import { MESH_ANALYTICS_SCRIPT } from "./mesh-analytics.client"
import { MESH_OPS_SCRIPT } from "./mesh-ops.client"

// --- /mesh — three views over one fleet -------------------------------
//
//   Activity   what ran, where it breaks, and which recurring jobs burn
//              runtime without producing anything.
//   Lifetime   how long a thread lives, where its sessions were cut, and
//              the thread → run → step drill behind any of it.
//   Operations the live snapshot: today's schedules, current work, node
//              reachability, agent inventory.
//
// The split exists because those are three different questions asked at
// three different moments, and answering them on one scroll was the thing
// that made the old page a wall of reading. Only the Operations view
// polls; the analytics views load once per selected window.

const ICONS = {
  activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h3l2-6 4 12 2-6h5"/></svg>`,
  breakage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6l-3 3 3 3v6"/><path d="M5 5l14 14"/></svg>`,
  effort: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4M4 20h16"/><circle cx="9" cy="15" r="2"/><circle cx="15" cy="8" r="2"/></svg>`,
  lifetime: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8v8M13 8v8M19 8v8"/></svg>`,
  cuts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 8l12 10M8 16L20 6"/></svg>`,
  schedules: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  nodes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M7 8l4 8M17 8l-4 8"/></svg>`,
  agents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>`,
}

function head(icon: string, title: string, lead: string, id: string, action = ""): string {
  return sectionHead({ icon, title, lead, actionHtml: action }).replace("<h2>", `<h2 id="${id}">`)
}

const TABS: Array<{ id: string; label: string }> = [
  { id: "activity", label: "Activity" },
  { id: "lifetime", label: "Lifetime" },
  { id: "ops", label: "Operations" },
]

const RANGES = [7, 30, 90]

export function renderMeshPage(opts: { peers?: TopbarPeer[] }): string {
  const chrome =
    pageHead({
      kicker: "Operations",
      title: "Mesh operations",
      lead: `What the fleet actually did, how long it lived, and which of it was worth running.`,
    }) +
    healthStrip([
      { kind: "off", num: "-", label: "Nodes online" },
      { kind: "off", num: "-", label: "Tasks running" },
      { kind: "off", num: "-", label: "Failed today" },
      { kind: "off", num: "-", label: "Jobs needing review" },
    ]).replace('<div class="ax-health-strip">', `<div class="ax-health-strip" id="mx-health">`)

  const toolbar = `<div class="mx-toolbar">
    <div class="mx-tabs" role="tablist" aria-label="Mesh views">
      ${TABS.map((t, i) => `<button class="mx-tab" type="button" role="tab" id="mx-tab-${t.id}" aria-controls="mx-view-${t.id}" aria-selected="${i === 0}" data-view="${t.id}">${t.label}</button>`).join("")}
    </div>
    <div class="mx-range" id="mx-range" role="group" aria-label="History window">
      ${RANGES.map((d) => `<button type="button" data-days="${d}" aria-pressed="${d === 30}">${d}d</button>`).join("")}
    </div>
  </div>
  <p id="mx-analytics-updated" class="mx-updated" aria-live="polite">Reading node histories...</p>`

  const activityView = `<div class="mx-view" id="mx-view-activity" role="tabpanel" aria-labelledby="mx-tab-activity">
    <section class="mx-section" aria-labelledby="mx-lanes-title">
      ${head(ICONS.activity, "What ran", "One lane per origin. Each lane is scaled to its own peak so a quiet channel stays readable next to a busy one.", "mx-lanes-title")}
      <div id="mx-lanes"><div class="mx-empty">Loading activity...</div></div>
      <div class="mx-axis" id="mx-axis"></div>
      <p class="mx-note">Coloured bars are runs that finished; the red cap on a column is the failures inside that day.</p>
    </section>

    <div class="mx-two">
      <section class="mx-section" aria-labelledby="mx-origins-title">
        ${head(ICONS.breakage, "Where it breaks", "Attempts per origin, with the failed share marked on the same bar.", "mx-origins-title")}
        <div class="mx-bars" id="mx-origins"><div class="mx-empty">Loading...</div></div>
      </section>
      <section class="mx-section" aria-labelledby="mx-causes-title">
        ${head(ICONS.breakage, "Why it fails", "Failures grouped by cause class, matched from the recorded error text.", "mx-causes-title")}
        <div class="mx-bars" id="mx-causes"><div class="mx-empty">Loading...</div></div>
        <p class="mx-note" id="mx-cause-note"></p>
      </section>
    </div>

    <section class="mx-section" aria-labelledby="mx-scatter-title">
      ${head(ICONS.effort, "Effort against output", "Every recurring job, plotted as runtime spent against tokens produced on its successful runs. Both axes are logarithmic.", "mx-scatter-title")}
      <div class="mx-scatter" id="mx-scatter"><div class="mx-empty">Loading jobs...</div></div>
      <div class="mx-legend" id="mx-scatter-legend"></div>
      <p class="mx-note">Bubble size is the number of runs. Anything not healthy is labelled on the chart; select it for the attempt history behind the verdict.</p>
    </section>
  </div>`

  const lifetimeView = `<div class="mx-view" id="mx-view-lifetime" role="tabpanel" aria-labelledby="mx-tab-lifetime" hidden>
    <section class="mx-section" aria-labelledby="mx-threads-title">
      ${head(ICONS.lifetime, "Thread lifetimes", "A thread is one agent talking on one channel in one conversation. The bar is its real first-to-last span; each tick is a session cut.", "mx-threads-title")}
      <div class="mx-chips" id="mx-thread-chips"></div>
      <div id="mx-threads"><div class="mx-empty">Loading threads...</div></div>
      <p class="mx-note">Select a thread to walk its runs, then a run to see which tools it touched. Grey ticks are stale cuts, amber ticks are context-full cuts.</p>
    </section>

    <section class="mx-section" aria-labelledby="mx-rot-title">
      ${head(ICONS.cuts, "Session cuts", "Why threads lost their session, across the fleet.", "mx-rot-title")}
      <div class="mx-bars" id="mx-rotations"><div class="mx-empty">Loading...</div></div>
      <p class="mx-note" id="mx-rot-note"></p>
    </section>
  </div>`

  const opsView = `<div class="mx-view" id="mx-view-ops" role="tabpanel" aria-labelledby="mx-tab-ops" hidden>
    <p id="mx-updated" class="mx-updated" aria-live="polite">Connecting to the fleet...</p>

    <section class="mx-section" aria-labelledby="mx-auto-title">
      ${head(ICONS.schedules, "Today's automations", "Persisted attempts are authoritative. Select a schedule to inspect its latest result and runtime.", "mx-auto-title", `<div class="mx-section-actions"><span class="ax-tab-count" id="mx-run-count">0 schedules</span><button class="ax-btn ax-btn--ghost mx-show-all" id="mx-show-all" type="button" hidden>Show all</button></div>`)}
      <div class="ax-stack" id="mx-runs"><div class="mx-empty">Loading schedules...</div></div>
    </section>

    <div class="mx-columns">
      <section class="mx-section" aria-labelledby="mx-active-title">
        ${head(ICONS.activity, "Activity provenance", "Who initiated current work and where it is running.", "mx-active-title", `<span class="ax-tab-count" id="mx-active-count">0 active</span>`)}
        <div class="ax-stack" id="mx-active"><div class="mx-empty">No activity loaded.</div></div>
      </section>
      <section class="mx-section" aria-labelledby="mx-nodes-title">
        ${head(ICONS.nodes, "Nodes", "Reachability and capacity across the fleet.", "mx-nodes-title", `<span class="ax-tab-count" id="mx-node-count">0 nodes</span>`)}
        <div class="ax-stack" id="mx-nodes"><div class="mx-empty">No nodes loaded.</div></div>
      </section>
    </div>

    <section class="mx-section" aria-labelledby="mx-agents-title">
      ${head(ICONS.agents, "Agents and skills", "Runtime, model, installed skills, and task totals by node.", "mx-agents-title", `<span class="ax-tab-count" id="mx-agent-count">0 agents</span>`)}
      <div class="mx-agent-grid" id="mx-agents"><div class="mx-empty">No agents loaded.</div></div>
    </section>
  </div>`

  const body = `${chrome}<main class="mx-content">
  ${toolbar}
  ${activityView}
  ${lifetimeView}
  ${opsView}
</main>
<div class="mx-scrim" id="mx-scrim" hidden></div>
<aside class="mx-drawer" id="mx-drawer" aria-labelledby="mx-drawer-title" aria-hidden="true">
  <header class="mx-drawer__head">
    <div><div class="ax-kicker" id="mx-drawer-kicker">Details</div><h2 id="mx-drawer-title">Selection</h2></div>
    <button class="ax-btn ax-btn--ghost" id="mx-close" type="button" aria-label="Close details">Close</button>
  </header>
  <div class="mx-drawer__body" id="mx-drawer-body"></div>
</aside>`

  return renderShell({
    title: "AgentX · Mesh Operations",
    activeTab: "mesh",
    subtitle: "Operations",
    peers: opts.peers,
    noMain: true,
    body,
    css: MESH_CSS,
    scripts: MESH_SHARED_SCRIPT + MESH_TABS_SCRIPT + MESH_ANALYTICS_SCRIPT + MESH_OPS_SCRIPT,
  })
}

// The history window only affects the two analytics views, so it is hidden
// while Operations is showing rather than sitting there doing nothing.
const MESH_TABS_SCRIPT = `<script>
(function(){
  var tabs=Array.prototype.slice.call(document.querySelectorAll('.mx-tab'));
  var range=document.getElementById('mx-range');
  var stamp=document.getElementById('mx-analytics-updated');
  function select(id){
    tabs.forEach(function(t){
      var on=t.dataset.view===id;
      t.setAttribute('aria-selected',String(on));
      document.getElementById('mx-view-'+t.dataset.view).hidden=!on;
    });
    var analytics=id!=='ops';
    range.hidden=!analytics;stamp.hidden=!analytics;
    try{localStorage.setItem('mx-view',id)}catch(e){}
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(){select(t.dataset.view)});
    t.addEventListener('keydown',function(e){
      var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;
      if(!d)return;
      e.preventDefault();
      var next=tabs[(i+d+tabs.length)%tabs.length];
      next.focus();select(next.dataset.view);
    });
  });
  var saved=null;try{saved=localStorage.getItem('mx-view')}catch(e){}
  select(tabs.some(function(t){return t.dataset.view===saved})?saved:'activity');
})();
</script>`
