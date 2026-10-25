// --- Wall page (#1180) ---
//
// The Wall is the main dashboard view: each request is a post, and the
// runs, hand-offs and plan steps recorded against it are its thread.
// Read-only over records the daemon already keeps (requests, plan events,
// task traces, the live fleet snapshot). Nothing here writes or notifies.
//
// It reads like a social feed (#1207): each post carries its agent's
// avatar, name and @handle, with an action row under it; tapping an agent
// shows its profile over its own posts.
//
// The HTML is a skeleton; WALL_PAGE_SCRIPT paints it from
// /api/admin/wall?peer=fleet, /api/live and /api/workflows/runs.

import { renderShell, type TopbarPeer } from ".."
import { WALL_PAGE_SCRIPT } from "./wall.client"
import { CRON_JOBS_SCRIPT, CRON_VALUE_CSS, CRON_VALUE_SCRIPT } from "../cron-value"
import { WALL_REVIEWS_CSS } from "./wall-reviews.client"

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
  // A feed column with a side column, read like a social feed (#1207):
  // posts in the middle; Running now, Agents and the classic pages beside.
  const body = `<div class="ax-wall">
  <section class="ax-wall__box ax-wall__side" aria-label="Classic pages">
    <nav class="ax-wall__classic" aria-label="Classic pages">${classic}</nav>
    <span class="ax-wall__sync">Last synced <time id="wall-synced">—</time> <button id="wall-refresh" class="ax-btn ax-btn--ghost" type="button">Refresh</button></span>
  </section>
  <section class="ax-wall__box ax-wall__nodes" aria-labelledby="wall-nodes-h">
    <h2 id="wall-nodes-h">Running now</h2>
    <div id="wall-nodes"><p class="ax-wall__empty">Loading…</p></div>
  </section>
  <section class="ax-wall__box ax-wall__agents" aria-labelledby="wall-agents-h">
    <h2 id="wall-agents-h">Agents</h2>
    <div id="wall-agents"><p class="ax-wall__empty">Loading…</p></div>
  </section>
  <div class="ax-wall__main">
    <header class="ax-wall__head">
      <div class="ax-wall__titlebar"><h1>Wall</h1><p id="wall-count" class="ax-wall__count"></p></div>
      <div class="ax-wall__views" role="tablist">
        <button type="button" role="tab" data-view="feed" class="is-on">Feed</button>
        <button type="button" role="tab" data-view="list">List</button>
        <button type="button" role="tab" data-view="projects">Projects</button>
        <button type="button" role="tab" data-view="failures">Failures <span id="wall-fail-n"></span></button>
        <button type="button" role="tab" data-view="jobs">Jobs</button>
        <button type="button" role="tab" data-view="reviews">Reviews <span id="wall-rev-n"></span></button>
      </div>
    </header>
    <section class="ax-wall__filters" aria-label="Filters">
      <button type="button" id="f-toggle" class="ax-btn ax-btn--ghost ax-wall__ftoggle" aria-expanded="false">Filters</button>
      <label>Owner <select id="f-owner"><option value="">All</option></select></label>
      <label>Counted for <select id="f-load"><option value="">All</option></select></label>
      <label>Status <select id="f-status">
        <option value="open">Open</option><option value="blocked">Blocked</option><option value="waiting_owner">Waiting on the owner</option><option value="stalled">Stalled</option>
        <option value="in_progress">In progress</option><option value="closed">Closed</option><option value="">All</option>
      </select></label>
      <label>No move for <select id="f-idle"><option value="">any time</option><option value="1">1+ day</option><option value="3">3+ days</option><option value="7">7+ days</option></select></label>
      <label>Project <select id="f-project"><option value="">All</option></select></label>
      <label>Node <select id="f-node"><option value="">All</option></select></label>
      <label>Group <select id="f-group"><option value="">All</option></select></label>
      <label>Group blocked by <select id="f-by"><option value="">nothing</option><option value="project">project</option><option value="agent">agent</option></select></label>
      <label class="ax-wall__check"><input type="checkbox" id="f-time"> Time flags only</label>
      <label class="ax-wall__check"><input type="checkbox" id="f-conc"> Concurrent only</label>
      <label class="ax-wall__check"><input type="checkbox" id="f-qa"> Awaiting QA only</label>
      <input id="f-q" type="search" placeholder="Search" aria-label="Search posts">
      <span class="ax-wall__saved">
        <button type="button" id="v-mine" class="ax-btn ax-btn--ghost">My view</button>
        <button type="button" id="v-save" class="ax-btn ax-btn--ghost">Save as my view</button>
      </span>
    </section>
    <section id="wall-profile" class="ax-wall__profile" aria-label="Agent profile" hidden></section>
    <section id="wall-feed" class="ax-wall__feed" aria-label="Posts"></section>
    <section id="wall-list" class="ax-wall__list" aria-label="Posts as a list" hidden></section>
    <section id="wall-projects" class="ax-wall__list" aria-label="Projects" hidden></section>
    <section id="wall-failures" class="ax-wall__failures" aria-label="Failures" hidden></section>
    <section id="wall-jobs" class="ax-wall__failures" aria-label="Recurring jobs" hidden></section>
    <section id="wall-reviews" class="ax-wall__reviews" aria-label="Review queue" hidden></section>
  </div>
</div>`

  return renderShell({
    title: "AgentX · Wall",
    activeTab: "wall",
    subtitle: "Wall",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: WALL_PAGE_CSS + CRON_VALUE_CSS + WALL_REVIEWS_CSS,
    scripts: token + `<script>${CRON_VALUE_SCRIPT}\n${CRON_JOBS_SCRIPT}\n${WALL_PAGE_SCRIPT}</script>`,
  })
}

const WALL_PAGE_CSS = `
/* A display rule beats the user agent's [hidden] rule: keep hidden hidden. */
.ax-wall [hidden] { display: none !important; }
/* Feed column plus side column (#1207). The main column spans every side row;
   the last row takes the slack so the side boxes stay packed at the top. */
.ax-wall { display: grid; grid-template-columns: minmax(0, 620px) 330px; grid-template-rows: auto auto auto 1fr; column-gap: 24px;
  justify-content: center; align-items: start; max-width: 1180px; margin: 0 auto; }
.ax-wall.is-wide { grid-template-columns: minmax(0, 1fr) 300px; }
.ax-wall__main { grid-column: 1; grid-row: 1 / span 4; min-width: 0; border-left: 1px solid var(--ax-border); border-right: 1px solid var(--ax-border); min-height: 70vh; }
.ax-wall__side { grid-column: 2; grid-row: 3; }
.ax-wall__nodes { grid-column: 2; grid-row: 1; }
.ax-wall__agents { grid-column: 2; grid-row: 2; }
.ax-wall__box { background: var(--ax-surface); border-radius: var(--ax-radius-lg); padding: 12px 16px; margin-bottom: 16px; min-width: 0; }
.ax-wall__box h2 { font-size: 19px; font-weight: 800; margin: 0 0 8px; color: var(--ax-text); }
.ax-wall__empty, .ax-wall__count { color: var(--ax-muted); font-size: var(--ax-fs-sm); margin: 0; }
.ax-wall__feed .ax-wall__empty, .ax-wall__list > .ax-wall__empty { padding: 32px 16px; text-align: center; }

/* Sticky header: title, post count, and the views as underlined tabs. */
.ax-wall__head { position: sticky; top: 0; z-index: 3; background: color-mix(in srgb, var(--ax-bg) 86%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--ax-border); }
.ax-wall__titlebar { display: flex; align-items: baseline; gap: 12px; padding: 12px 16px 2px; }
.ax-wall__titlebar h1 { font-size: 20px; font-weight: 800; margin: 0; }
.ax-wall__views { display: flex; }
.ax-wall__views button { flex: 1; font: inherit; font-weight: 600; background: none; border: 0; border-bottom: 3px solid transparent; color: var(--ax-muted); padding: 12px 0 9px; cursor: pointer; }
.ax-wall__views button:hover { background: var(--ax-surface); }
.ax-wall__views button.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }

/* Filters: one row of small pills under the tabs. */
.ax-wall__filters { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: var(--ax-fs-xs); color: var(--ax-muted); padding: 10px 16px; border-bottom: 1px solid var(--ax-border); }
.ax-wall__filters label { display: inline-flex; gap: 4px; align-items: center; }
.ax-wall__filters select, .ax-wall__filters input[type=search] { font: inherit; background: var(--ax-surface); color: var(--ax-text); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 3px 8px; max-width: 160px; }
.ax-wall__filters input[type=search] { flex: 1 1 140px; max-width: none; }
.ax-wall__saved { display: flex; gap: 6px; }
.ax-wall__saved .ax-btn { font-size: var(--ax-fs-xs); }
.ax-wall__ftoggle { display: none; }

/* Avatars: initials on a colour taken from the agent id. */
.av { --av-h: 210; width: 40px; height: 40px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center;
  background: hsl(var(--av-h) 55% 46%); color: #fff; font-weight: 700; font-size: 14px; border: 0; padding: 0; cursor: pointer; text-decoration: none; position: relative; }
.av--sm { width: 28px; height: 28px; font-size: 11px; }
.av--lg { width: 88px; height: 88px; font-size: 30px; border: 4px solid var(--ax-bg); cursor: default; }
.av--person { background: var(--ax-muted); }
.av.is-live::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; background: var(--ax-green); border: 2px solid var(--ax-surface); }

/* Posts */
.wp { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.wp:hover { background: color-mix(in srgb, var(--ax-surface) 55%, transparent); }
.wp.is-blocked, .wp.is-concurrent { box-shadow: inset 3px 0 0 var(--ax-amber); }
.wp.is-failed { box-shadow: inset 3px 0 0 var(--ax-red); }
.wp__b { flex: 1; min-width: 0; }
.wp__by { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.wp__by .name { color: var(--ax-text); font-weight: 700; font-size: var(--ax-fs); background: none; border: 0; padding: 0; font-family: inherit; cursor: pointer; }
.wp__by .name:hover { text-decoration: underline; }
.wp__by .state { margin-left: auto; }
.wp__via { color: var(--ax-muted); font-size: var(--ax-fs-xs); margin-top: 1px; overflow-wrap: anywhere; }
.wp__via b { color: var(--ax-text-2); font-weight: 500; }
.wp__title { font-size: var(--ax-fs); line-height: 1.4; margin: 4px 0 0; overflow-wrap: anywhere; }
.chip { display: inline-block; font-size: var(--ax-fs-xs); line-height: 1.5; border-radius: var(--ax-radius-pill); padding: 0 9px; background: var(--ax-blue-t, var(--ax-surface-2)); color: var(--ax-accent); white-space: nowrap; }
.chip--done { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green); }
.chip--warn { background: var(--ax-amber-t, color-mix(in srgb, var(--ax-amber) 18%, transparent)); color: var(--ax-amber-ink, var(--ax-warn)); }
.chip--err { background: var(--ax-red-t, color-mix(in srgb, var(--ax-red) 15%, transparent)); color: var(--ax-red-ink, var(--ax-err)); }
.chip--ghost { background: var(--ax-surface-2); color: var(--ax-muted); }
.wp__block { margin-top: 6px; font-size: var(--ax-fs-sm); color: var(--ax-amber-ink, var(--ax-warn)); }
.wp__qa { margin-top: 4px; font-size: var(--ax-fs-xs); }
.wp__flag { margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-warn); }
.wp__meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-top: 8px; }
.wp__meta b { color: var(--ax-text-2); font-weight: 500; }
/* The action row, as under a post on a social feed. */
.wp__acts { display: flex; flex-wrap: wrap; gap: 4px 22px; align-items: center; margin-top: 8px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wp__acts a, .wp__acts button, .wp__acts span { display: inline-flex; align-items: center; gap: 5px; color: var(--ax-muted); text-decoration: none; font: inherit; background: none; border: 0; padding: 2px 0; cursor: pointer; }
.wp__acts span { cursor: default; }
.wp__acts a:hover, .wp__acts button:hover { color: var(--ax-accent); }
.wp__acts .is-err { color: var(--ax-red-ink, var(--ax-err)); }
.wp__acts svg { width: 16px; height: 16px; flex: none; }
.wp__acts .home { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
.ax-conc { display: block; margin-top: 4px; font-size: var(--ax-fs-xs); color: var(--ax-amber-ink, var(--ax-warn)); overflow-wrap: anywhere; }
.ax-conc a { color: inherit; font-family: var(--ax-mono); }

/* Decision cards: a quoted card inside the post. */
.wc { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-bg-elev); font-size: var(--ax-fs-sm); }
.wc.is-soon { border-color: var(--ax-red); }
.wc__head { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.wc__head b { overflow-wrap: anywhere; }
.wc__ask { margin: 4px 0 0; color: var(--ax-text-2); overflow-wrap: anywhere; }
.wc__facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 6px 0 0; }
.wc__facts dt { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__facts dd { margin: 0; overflow-wrap: anywhere; }
.wc__facts .k { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wc__foot { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wc__foot a { color: var(--ax-accent); }

/* The thread: replies with small avatars on one line down the left. */
.wt { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; }
.wt > li { display: flex; gap: 10px; position: relative; padding: 6px 0; font-size: var(--ax-fs-sm); }
.wt > li::before { content: ""; position: absolute; left: 13px; top: 0; bottom: 0; border-left: 2px solid var(--ax-border); }
.wt > li:first-child::before { top: 14px; }
.wt > li:last-child::before { bottom: calc(100% - 14px); }
.wt > li > .av { z-index: 1; cursor: default; }
.wt .wr { flex: 1; min-width: 0; }
.wt .who { font-weight: 700; }
.wt time, .wt .k { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wt .txt { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ax-text-2); margin-top: 2px; }
.wt .is-err .txt { color: var(--ax-red-ink, var(--ax-err)); }
.wt .ids { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.wt .ids a, .wt .ids span, .wt .men { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); background: var(--ax-surface-2); border-radius: var(--ax-radius-sm); padding: 0 4px; color: var(--ax-text-2); text-decoration: none; }
.wt .men { background: var(--ax-blue-t, var(--ax-surface-2)); }
.wt .more { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 0; }
.wt .wt { margin-top: 4px; }

/* Agent profile: shown above the feed when the owner filter names one agent. */
.ax-wall__profile { border-bottom: 1px solid var(--ax-border); }
.wpf__banner { height: 96px; background: linear-gradient(120deg, hsl(var(--av-h) 55% 46%), hsl(calc(var(--av-h) + 40) 60% 60%)); }
.wpf { padding: 0 16px 12px; }
.wpf__top { display: flex; justify-content: space-between; align-items: flex-end; margin-top: -44px; }
.wpf__top .ax-btn { margin-bottom: 4px; }
.wpf h2 { margin: 6px 0 0; font-size: 20px; font-weight: 800; }
.wpf .h { color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.wpf__stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wpf__stats b { color: var(--ax-text); }
.wpf__links { display: flex; gap: 14px; margin-top: 8px; font-size: var(--ax-fs-sm); }
.wpf__links a { color: var(--ax-accent); text-decoration: none; }

/* Side column boxes */
.ax-wall__classic { display: flex; flex-wrap: wrap; gap: 6px; }
.ax-wall__classic a { font-size: var(--ax-fs-xs); padding: 3px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); color: var(--ax-text-2); text-decoration: none; background: var(--ax-bg); }
.ax-wall__classic a:hover { color: var(--ax-text); border-color: var(--ax-border-2); }
.ax-wall__sync { font-size: var(--ax-fs-xs); color: var(--ax-muted); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-top: 10px; }
.ax-wall__sync.is-stale time { color: var(--ax-warn); }
.ax-wall__nodes > div { display: flex; flex-direction: column; }
.wn { padding: 8px 0; font-size: var(--ax-fs-sm); border-top: 1px solid var(--ax-border); }
.wn:first-child { border-top: 0; }
.wn header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.wn header b { font-size: var(--ax-fs); }
.wn.is-down header b { color: var(--ax-red-ink, var(--ax-err)); }
.wn .ver { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wn ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wn li a { color: var(--ax-text); text-decoration: none; overflow-wrap: anywhere; }
.wn li small, .wn .idle { color: var(--ax-muted); }
.wn details { margin-top: 4px; color: var(--ax-text-2); font-size: var(--ax-fs-xs); }
.wn details summary { cursor: pointer; color: var(--ax-muted); }
.wa { display: flex; gap: 10px; align-items: center; padding: 7px 0; width: 100%; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; border-radius: var(--ax-radius); }
.wa:hover .wa__n b { text-decoration: underline; }
.wa.is-on .wa__n b { color: var(--ax-accent); }
.wa__n { min-width: 0; font-size: var(--ax-fs-sm); }
.wa__n b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa__n small { display: block; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wa-more { font: inherit; font-size: var(--ax-fs-sm); background: none; border: 0; padding: 6px 0 0; color: var(--ax-accent); cursor: pointer; }

/* List and failures */
.ax-wall__list { overflow-x: auto; }
.wl { width: 100%; border-collapse: collapse; font-size: var(--ax-fs-sm); }
.wl th, .wl td { text-align: left; padding: 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.wl th { font-size: var(--ax-fs-xs); color: var(--ax-muted); font-weight: 500; cursor: pointer; white-space: nowrap; }
.wl td.num { text-align: right; font-variant-numeric: tabular-nums; }
.wl a { color: var(--ax-text); }
.ax-wall__failures { padding: 12px 16px; }
.wf { border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 10px 12px; margin-bottom: 10px; }
.wf h3 { margin: 0 0 6px; font-size: var(--ax-fs); }
.wf ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: var(--ax-fs-sm); }
.wf .err { color: var(--ax-text-2); font-family: var(--ax-mono); font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }

/* One column below desktop width: classic pages and Running now first,
   then the feed, then the agents. */
@media (max-width: 1000px) {
  .ax-wall, .ax-wall.is-wide { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
  .ax-wall__side, .ax-wall__nodes, .ax-wall__agents, .ax-wall__main { grid-column: 1; grid-row: auto; }
  .ax-wall__side { order: 1; } .ax-wall__nodes { order: 2; } .ax-wall__main { order: 3; } .ax-wall__agents { order: 4; margin-top: 16px; }
  .ax-wall__main { border-left: 0; border-right: 0; }
}
@media (max-width: 640px) {
  .ax-wall__box { margin-bottom: 10px; padding: 10px 12px; }
  .ax-wall__nodes > div { flex-direction: row; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory; }
  .wn { flex: 0 0 78%; scroll-snap-align: start; border-top: 0; border-left: 1px solid var(--ax-border); padding: 0 0 0 10px; }
  .wn:first-child { border-left: 0; padding-left: 0; }
  .ax-wall__ftoggle { display: inline-flex; }
  .ax-wall__filters:not(.is-open) > label, .ax-wall__filters:not(.is-open) > input, .ax-wall__filters:not(.is-open) > .ax-wall__saved { display: none; }
  .ax-wall__filters label { flex: 1 1 45%; display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
  .ax-wall__filters select, .ax-wall__filters input[type=search] { max-width: none; width: 100%; }
  .ax-wall__head { position: static; }
  .wp { padding: 12px; gap: 10px; }
  .wp__acts { gap: 4px 16px; }
  .wl thead { display: none; }
  .wl tr { display: block; border-bottom: 1px solid var(--ax-border); padding: 6px 0; }
  .wl td { display: inline-block; border: 0; padding: 2px 6px 2px 0; }
  .wl td:first-child { display: block; }
  .wc__facts { grid-template-columns: 1fr; }
  .wc__facts dd { margin-bottom: 4px; }
}
`
