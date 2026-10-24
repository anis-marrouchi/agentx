// --- Wall page (#1180) ---
//
// The Wall is the main dashboard view: each request is a post, and the
// runs, hand-offs and plan steps recorded against it are its thread.
// Read-only over records the daemon already keeps (requests, plan events,
// task traces, the live fleet snapshot). Nothing here writes or notifies.
//
// The HTML is a skeleton; WALL_PAGE_SCRIPT paints it from
// /api/admin/wall?peer=fleet, /api/live and /api/workflows/runs.

import { renderShell, type TopbarPeer } from ".."
import { WALL_PAGE_SCRIPT } from "./wall.client"

export interface WallPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
  localToken?: string
}

/** The classic pages, one tap from the Wall (#1180 items 1, 23, 27). */
export const WALL_CLASSIC_LINKS: Array<[string, string]> = [
  ["Live", "/live"], ["Operations", "/mesh"], ["Monitor", "/monitor"], ["Approvals", "/approvals"],
  ["People", "/people"], ["Activity", "/activity"], ["Workflows", "/workflows"], ["Settings", "/admin"],
]

export function renderWallPage(opts: WallPageOpts = {}): string {
  const token = opts.localToken ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>` : ""
  const classic = WALL_CLASSIC_LINKS.map(([label, href]) => `<a href="${href}">${label}</a>`).join("")
  const body = `<div class="ax-wall">
  <div class="ax-wall__bar">
    <nav class="ax-wall__classic" aria-label="Classic pages">${classic}</nav>
    <span class="ax-wall__sync">Last synced <time id="wall-synced">—</time> <button id="wall-refresh" class="ax-btn ax-btn--ghost" type="button">Refresh</button></span>
  </div>
  <section class="ax-wall__nodes" aria-labelledby="wall-nodes-h">
    <h2 id="wall-nodes-h">Running now</h2>
    <div id="wall-nodes"><p class="ax-wall__empty">Loading…</p></div>
  </section>
  <section class="ax-wall__filters" aria-label="Filters">
    <div class="ax-wall__views" role="tablist">
      <button type="button" role="tab" data-view="feed" class="is-on">Feed</button>
      <button type="button" role="tab" data-view="list">List</button>
      <button type="button" role="tab" data-view="failures">Failures <span id="wall-fail-n"></span></button>
    </div>
    <label>Owner <select id="f-owner"><option value="">All</option></select></label>
    <label>Status <select id="f-status">
      <option value="open">Open</option><option value="blocked">Blocked</option><option value="waiting_owner">Waiting on owner</option>
      <option value="in_progress">In progress</option><option value="closed">Closed</option><option value="">All</option>
    </select></label>
    <label>No move for <select id="f-idle"><option value="0">any time</option><option value="1">1+ day</option><option value="3">3+ days</option><option value="7">7+ days</option></select></label>
    <label>Project <select id="f-project"><option value="">All</option></select></label>
    <label>Node <select id="f-node"><option value="">All</option></select></label>
    <label>Group <select id="f-group"><option value="">All</option></select></label>
    <label class="ax-wall__check"><input type="checkbox" id="f-time"> Time flags only</label>
    <input id="f-q" type="search" placeholder="Search" aria-label="Search posts">
    <span class="ax-wall__saved">
      <button type="button" id="v-mine" class="ax-btn ax-btn--ghost">My view</button>
      <button type="button" id="v-save" class="ax-btn ax-btn--ghost">Save as my view</button>
    </span>
  </section>
  <p id="wall-count" class="ax-wall__count"></p>
  <section id="wall-feed" class="ax-wall__feed" aria-label="Posts"></section>
  <section id="wall-list" class="ax-wall__list" aria-label="Posts as a list" hidden></section>
  <section id="wall-failures" class="ax-wall__failures" aria-label="Failures" hidden></section>
</div>`

  return renderShell({
    title: "AgentX · Wall",
    activeTab: "wall",
    subtitle: "Wall",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: WALL_PAGE_CSS,
    scripts: token + `<script>${WALL_PAGE_SCRIPT}</script>`,
  })
}

const WALL_PAGE_CSS = `
.ax-wall { display: flex; flex-direction: column; gap: var(--ax-gap); max-width: 1180px; margin: 0 auto; }
.ax-wall h2 { font-size: var(--ax-fs-sm); text-transform: uppercase; letter-spacing: .06em; color: var(--ax-muted); margin: 0 0 8px; }
.ax-wall__empty, .ax-wall__count { color: var(--ax-muted); font-size: var(--ax-fs-sm); margin: 0; }
.ax-wall__bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
.ax-wall__classic { display: flex; flex-wrap: wrap; gap: 6px; }
.ax-wall__classic a { font-size: var(--ax-fs-xs); padding: 4px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); color: var(--ax-text-2); text-decoration: none; }
.ax-wall__classic a:hover { color: var(--ax-text); border-color: var(--ax-border-2); }
.ax-wall__sync { font-size: var(--ax-fs-xs); color: var(--ax-muted); display: flex; gap: 8px; align-items: center; }
.ax-wall__sync.is-stale time { color: var(--ax-warn); }
.ax-wall__nodes > div { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.wn { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 10px 12px; font-size: var(--ax-fs-sm); }
.wn.is-down { border-color: var(--ax-red); }
.wn header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.wn header b { font-size: var(--ax-fs); }
.wn .ver { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wn ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wn li a { color: var(--ax-text); text-decoration: none; }
.wn li small, .wn .idle { color: var(--ax-muted); }
.wn details { margin-top: 6px; color: var(--ax-text-2); font-size: var(--ax-fs-xs); }
.wn details summary { cursor: pointer; color: var(--ax-muted); }
.ax-wall__filters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: var(--ax-fs-sm); position: sticky; top: 0; background: var(--ax-bg); padding: 8px 0; z-index: 2; }
.ax-wall__filters select, .ax-wall__filters input[type=search] { font: inherit; background: var(--ax-surface); color: var(--ax-text); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); padding: 4px 6px; max-width: 180px; }
.ax-wall__views { display: flex; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); overflow: hidden; }
.ax-wall__views button { font: inherit; background: none; border: 0; color: var(--ax-text-2); padding: 4px 12px; cursor: pointer; }
.ax-wall__views button.is-on { background: var(--ax-accent-t); color: var(--ax-text); }
.ax-wall__saved { display: flex; gap: 6px; margin-left: auto; }
.ax-wall__feed { display: flex; flex-direction: column; gap: 10px; }
.wp { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 12px 14px; }
.wp.is-blocked { border-left: 3px solid var(--ax-amber); }
.wp.is-failed { border-left: 3px solid var(--ax-red); }
.wp__head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wp__title { font-weight: 600; flex: 1 1 280px; overflow-wrap: anywhere; }
.wp__meta, .wp__links { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-top: 6px; }
.wp__meta b { color: var(--ax-text-2); font-weight: 500; }
.wp__links a { color: var(--ax-accent); text-decoration: none; }
.wp__links button { font: inherit; background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 0; }
.wp__block { margin-top: 6px; font-size: var(--ax-fs-sm); color: var(--ax-amber-ink, var(--ax-warn)); }
.wp__flag { margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-warn); }
.wt { list-style: none; margin: 10px 0 0; padding: 0 0 0 12px; border-left: 2px solid var(--ax-border); display: flex; flex-direction: column; gap: 8px; }
.wt li { font-size: var(--ax-fs-sm); }
.wt .who { font-weight: 600; }
.wt time, .wt .k { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wt .txt { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ax-text-2); margin-top: 2px; }
.wt .is-err .txt { color: var(--ax-red-ink, var(--ax-err)); }
.wt .ids { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.wt .ids a, .wt .ids span, .wt .men { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); background: var(--ax-surface-2); border-radius: var(--ax-radius-sm); padding: 0 4px; color: var(--ax-text-2); text-decoration: none; }
.wt .men { background: var(--ax-blue-t, var(--ax-surface-2)); }
.wt .more { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 0; }
.ax-wall__list { overflow-x: auto; }
.wl { width: 100%; border-collapse: collapse; font-size: var(--ax-fs-sm); }
.wl th, .wl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wl th { font-size: var(--ax-fs-xs); color: var(--ax-muted); font-weight: 500; cursor: pointer; white-space: nowrap; }
.wl td.num { text-align: right; font-variant-numeric: tabular-nums; }
.wl a { color: var(--ax-text); }
.wf { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 10px 12px; margin-bottom: 10px; }
.wf h3 { margin: 0 0 6px; font-size: var(--ax-fs); }
.wf ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: var(--ax-fs-sm); }
.wf .err { color: var(--ax-text-2); font-family: var(--ax-mono); font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .ax-wall__filters { position: static; }
  .ax-wall__filters label { flex: 1 1 45%; display: flex; flex-direction: column; gap: 2px; }
  .ax-wall__filters select, .ax-wall__filters input[type=search] { max-width: none; width: 100%; }
  .ax-wall__saved { margin-left: 0; }
  .wl thead { display: none; }
  .wl tr { display: block; border-bottom: 1px solid var(--ax-border); padding: 6px 0; }
  .wl td { display: inline-block; border: 0; padding: 2px 6px 2px 0; }
  .wl td:first-child { display: block; }
}
`
