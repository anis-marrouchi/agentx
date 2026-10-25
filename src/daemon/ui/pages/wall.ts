// --- Wall page (#1180) ---
//
// The Wall is the main dashboard view: each request is a post, and the
// runs, hand-offs and plan steps recorded against it are its thread.
// Selecting a post opens it on its own, with its thread, as on X; the nav's
// Running now and Agents open pages of their own, each with a count (#1316).
//
// Read-only over records the daemon already keeps (requests, plan events,
// task traces, the live fleet snapshot). Nothing here writes or notifies.
//
// It reads like a social feed (#1207): each post carries its agent's
// avatar, name and @handle, with an action row under it; tapping an agent
// shows its profile over its own posts.
//
// It is its own space (#1242), as the wiki is: its own document and look
// (wall-space.ts), no dashboard top bar. The dashboard links here, and the
// Wall links back to the dashboard and every classic page.
//
// The HTML is a skeleton; WALL_PAGE_SCRIPT paints it from
// /api/admin/wall?peer=fleet, /api/live and /api/workflows/runs.

import type { TopbarPeer } from ".."
import { WALL_PAGE_SCRIPT } from "./wall.client"
import { renderWallDocument } from "./wall-space"
import { CRON_JOBS_SCRIPT, CRON_VALUE_CSS, CRON_VALUE_SCRIPT } from "../cron-value"
import { WALL_REVIEWS_CSS } from "./wall-reviews.client"
import { WALL_PAGES_CSS } from "./wall-pages.client"

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

/** The status tabs over the feed and the list (#1355): filter value, label. */
export const WALL_STATUS_TABS: Array<[string, string]> = [
  ["open", "Open"], ["in_progress", "Working"], ["waiting", "Waiting"], ["done", "Done"], ["failed", "Failed"], ["", "All"],
]

/** Where the Wall's "Dashboard" link goes: the first classic page. */
export const WALL_DASHBOARD_HREF = "/live"

const NAV_ICON = {
  wall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/></svg>',
  needs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  reviews: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 10l2.5 2.5L16 8"/></svg>',
  failures: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
}

export function renderWallPage(opts: WallPageOpts = {}): string {
  const token = opts.localToken ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>` : ""
  const classic = WALL_CLASSIC_LINKS.map(([label, href]) => `<a href="${href}">${label}</a>`).join("")
  // Take B's three columns (#1242): a nav on the left, the feed in the
  // middle, Running now, Agents and the dashboard links on the right.
  const body = `<div class="ax-wall">
  <nav class="ax-wall__nav" aria-label="Wall">
    <a class="ax-wall__logo" href="/wall">AX<small>wall</small></a>
    <a class="ax-wall__item is-on" data-nav="wall" href="#status=open&amp;view=feed" title="Wall">${NAV_ICON.wall}<span>Wall</span><b class="ax-wall__n" id="nav-n-wall"></b></a>
    <a class="ax-wall__item" data-nav="needs" href="#status=waiting_owner&amp;view=feed" title="Needs you">${NAV_ICON.needs}<span>Needs you</span><b class="ax-wall__n" id="nav-n-needs"></b></a>
    <a class="ax-wall__item" data-nav="running" href="#page=running" title="Running now">${NAV_ICON.live}<span>Running now</span><b class="ax-wall__n" id="nav-n-running"></b></a>
    <a class="ax-wall__item" data-nav="projects" href="#status=open&amp;view=projects" title="Projects">${NAV_ICON.projects}<span>Projects</span><b class="ax-wall__n" id="nav-n-projects"></b></a>
    <a class="ax-wall__item" data-nav="jobs" href="#status=open&amp;view=jobs" title="Jobs">${NAV_ICON.jobs}<span>Jobs</span><b class="ax-wall__n" id="nav-n-jobs"></b></a>
    <a class="ax-wall__item" data-nav="reviews" href="#status=open&amp;view=reviews" title="Reviews">${NAV_ICON.reviews}<span>Reviews</span><b class="ax-wall__n" id="wall-rev-n"></b></a>
    <a class="ax-wall__item" data-nav="failures" href="#status=open&amp;view=failures" title="Failures">${NAV_ICON.failures}<span>Failures</span><b class="ax-wall__n" id="wall-fail-n"></b></a>
    <a class="ax-wall__item" data-nav="agents" href="#page=agents" title="Agents">${NAV_ICON.agents}<span>Agents</span><b class="ax-wall__n" id="nav-n-agents"></b></a>
    <a class="ax-wall__item" data-nav="dashboard" href="${WALL_DASHBOARD_HREF}" title="Dashboard">${NAV_ICON.dashboard}<span>Dashboard</span></a>
    <button type="button" class="ax-wall__item ax-wall__morebtn" data-more-nav aria-label="More pages">${NAV_ICON.more}<span>More</span></button>
    <a class="ax-btn ax-wall__newpost" data-nav="creator" href="#page=creator">New post</a>
    <div class="ax-wall__navfoot">
      <span>The Wall shows the work. It sends something only when you post, comment, call or start a Space.</span>
      <button id="wall-theme" class="ax-btn ax-btn--ghost" type="button">Light / dark</button>
    </div>
  </nav>
  <div class="ax-wall__main">
    <header class="ax-wall__head">
      <div class="ax-wall__titlebar"><button type="button" id="wall-back" class="ax-wall__back" data-back aria-label="Back to the feed" hidden>←</button><h1 id="wall-title">Wall</h1>
        <span class="ax-wall__switch" id="wall-switch" role="tablist" aria-label="Show as"><button type="button" role="tab" data-view="feed" class="is-on">Feed</button><button type="button" role="tab" data-view="list">List</button></span></div>
      <p class="ax-wall__sub"><span id="wall-count" class="ax-wall__count"></span><span class="ax-wall__sync">Last synced <time id="wall-synced">—</time> <button id="wall-refresh" type="button">Refresh</button></span></p>
      <div class="ax-wall__views" id="wall-views" role="tablist" aria-label="Status">
        ${WALL_STATUS_TABS.map(([v, label]) => `<button type="button" role="tab" data-tab="${v}">${label}</button>`).join("")}
        <button type="button" id="wall-search" class="ax-wall__search" aria-expanded="false" aria-controls="wall-filters" title="Search and filters">${NAV_ICON.search}</button>
      </div>
    </header>
    <section class="ax-wall__filters" id="wall-filters" aria-label="Filters">
      <label>Owner <select id="f-owner"><option value="">All</option></select></label>
      <label>Counted for <select id="f-load"><option value="">All</option></select></label>
      <label>Status <select id="f-status">
        <option value="open">Open</option><option value="blocked">Blocked</option><option value="waiting_owner">Waiting on the owner</option><option value="stalled">Stalled</option>
        <option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="done">Done</option><option value="failed">Failed</option><option value="closed">Closed</option><option value="">All</option>
      </select></label>
      <label>No move for <select id="f-idle"><option value="">any time</option><option value="1">1+ day</option><option value="3">3+ days</option><option value="7">7+ days</option></select></label>
      <label>Project <select id="f-project"><option value="">All</option></select></label>
      <label>Node <select id="f-node"><option value="">All</option></select></label>
      <label>Group <select id="f-group"><option value="">All</option></select></label>
      <label>Group the list by <select id="f-grp"><option value="">nothing</option><option value="owner">owner</option><option value="project">project</option><option value="blocked">blocked by</option></select></label>
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
    <form id="wall-compose" class="ax-wall__compose" aria-label="New post">
      <span class="av av--person" aria-hidden="true">You</span>
      <div class="ax-wall__composeb">
        <textarea id="wc-text" rows="2" maxlength="4000" placeholder="Ask the fleet… use @agent to pick who" aria-label="New post: start with @agent"></textarea>
        <div class="ax-wall__composerow"><span id="wc-note" class="wdo__n" role="status"></span><button type="submit" class="ax-btn" id="wc-post">Post</button></div>
      </div>
    </form>
    <section id="wall-profile" class="ax-wall__profile" aria-label="Agent profile" hidden></section>
    <section id="wall-feed" class="ax-wall__feed" aria-label="Posts"></section>
    <section id="wall-list" class="ax-wall__list" aria-label="Posts as a list" hidden></section>
    <section id="wall-projects" class="ax-wall__list" aria-label="Projects" hidden></section>
    <section id="wall-failures" class="ax-wall__failures" aria-label="Failures" hidden></section>
    <section id="wall-jobs" class="ax-wall__failures" aria-label="Recurring jobs" hidden></section>
    <section id="wall-reviews" class="ax-wall__reviews" aria-label="Review queue" hidden></section>
    <section id="wall-post" class="ax-wall__post" aria-label="Post and its thread" hidden></section>
    <section id="wall-running" class="ax-wall__running" aria-label="Running now on every node" hidden></section>
    <section id="wall-agents-page" class="ax-wall__agentlist" aria-label="Every agent" hidden></section>
    <section id="wall-creator" aria-label="New post: give an agent a task" hidden></section>
  </div>
  <aside class="ax-wall__aside">
    <section class="ax-wall__box ax-wall__nodes" aria-labelledby="wall-nodes-h">
      <h2 id="wall-nodes-h">Happening now</h2>
      <div id="wall-nodes"><p class="ax-wall__empty">Loading…</p></div>
    </section>
    <section class="ax-wall__box ax-wall__agents" aria-labelledby="wall-agents-h">
      <h2 id="wall-agents-h">Agents</h2>
      <div id="wall-agents"><p class="ax-wall__empty">Loading…</p></div>
    </section>
    <section class="ax-wall__box ax-wall__about" aria-labelledby="wall-about-h">
      <h2 id="wall-about-h">Quiet by design</h2>
      <p>The Wall is something you open, not something that pings you. It never pings you on its own.</p>
      <details class="ax-wall__classicd"><summary>Dashboard pages</summary><nav class="ax-wall__classic" aria-label="Classic pages">${classic}</nav></details>
    </section>
  </aside>
</div>`

  return renderWallDocument({
    title: "AgentX · Wall",
    body,
    css: WALL_PAGE_CSS + CRON_VALUE_CSS + WALL_REVIEWS_CSS + WALL_PAGES_CSS,
    scripts: token + `<script>${CRON_VALUE_SCRIPT}\n${CRON_JOBS_SCRIPT}\n${WALL_PAGE_SCRIPT}</script>`,
  })
}

const WALL_PAGE_CSS = `
/* A display rule beats the user agent's [hidden] rule: keep hidden hidden. */
.ax-wall [hidden] { display: none !important; }
/* The three-column layout lives in wall-space.ts (#1242). */
.ax-wall__empty, .ax-wall__count { color: var(--ax-muted); font-size: var(--ax-fs-sm); margin: 0; }
.ax-wall__feed .ax-wall__empty, .ax-wall__list > .ax-wall__empty { padding: 32px 16px; text-align: center; }

/* Sticky header: title, post count and sync, then the views as underlined tabs. */
.ax-wall__head { position: sticky; top: 0; z-index: 3; background: color-mix(in srgb, var(--ax-bg) 85%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--ax-border); }
.ax-wall__titlebar { padding: 14px 16px 2px; }
.ax-wall__titlebar h1 { font-size: 20px; font-weight: 800; margin: 0; }
.ax-wall__sub { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; margin: 0; padding: 0 16px 6px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.ax-wall__sub .ax-wall__count { font-size: var(--ax-fs-xs); }
.ax-wall__sync { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; }
.ax-wall__sync.is-stale time { color: var(--ax-warn); }
.ax-wall__sync button { font: inherit; background: none; border: 0; padding: 0; color: var(--ax-accent); cursor: pointer; }
.ax-wall__views { display: flex; overflow-x: auto; scrollbar-width: none; }
.ax-wall__views button { flex: 1 0 auto; font: inherit; font-weight: 600; background: none; border: 0; border-bottom: 3px solid transparent; color: var(--ax-muted); padding: 14px 12px 11px; cursor: pointer; white-space: nowrap; }
.ax-wall__views button:hover { background: var(--ax-surface); }
.ax-wall__views button.is-on { color: var(--ax-text); border-bottom-color: var(--ax-accent); }
.ax-wall__views .ax-wall__search { flex: 0 0 auto; display: inline-flex; align-items: center; padding: 10px 14px; }
.ax-wall__search svg { width: 18px; height: 18px; }
.ax-wall__search[aria-expanded="true"] { color: var(--ax-accent); }
/* Feed or List, a small switch beside the title (#1355). */
.ax-wall__switch { margin-left: auto; display: inline-flex; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); overflow: hidden; }
.ax-wall__switch button { font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; background: none; border: 0; color: var(--ax-muted); padding: 4px 12px; cursor: pointer; }
.ax-wall__switch button.is-on { background: var(--ax-text); color: var(--ax-bg); }

/* The composer at the top of the feed (#1355). */
.ax-wall__compose { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); margin: 0; }
.ax-wall__compose .av { cursor: default; font-size: 12px; }
.ax-wall__composeb { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.ax-wall__compose textarea { width: 100%; font: inherit; font-size: 17px; color: var(--ax-text); background: none; border: 0; resize: vertical; padding: 8px 0; }
.ax-wall__compose textarea:focus { outline: none; }
.ax-wall__composerow { display: flex; gap: 8px; align-items: center; justify-content: flex-end; border-top: 1px solid var(--ax-border); padding-top: 8px; }
.ax-wall__composerow .wdo__n { margin-right: auto; }

/* Filters: a search line; the rest open under "Filters", as on X. */
.ax-wall__filters { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; font-size: var(--ax-fs-xs); color: var(--ax-muted); padding: 10px 16px; border-bottom: 1px solid var(--ax-border); }
.ax-wall__filters label { display: inline-flex; gap: 4px; align-items: center; }
.ax-wall__filters select, .ax-wall__filters input[type=search] { font: inherit; background: var(--ax-surface); color: var(--ax-text); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 4px 10px; max-width: 160px; }
.ax-wall__filters input[type=search] { flex: 1 1 140px; max-width: none; padding: 8px 14px; font-size: var(--ax-fs-sm); }
.ax-wall__filters input[type=search]:focus { outline: none; border-color: var(--ax-accent); background: var(--ax-bg); }
.ax-wall__saved { display: flex; gap: 6px; }
.ax-wall__saved .ax-btn { font-size: var(--ax-fs-xs); padding: 3px 12px; }
.ax-wall__filters input[type=search] { order: -1; flex-basis: 100%; }
/* Closed until the search button opens it (#1355). */
.ax-wall__filters:not(.is-open) { display: none; }

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
.wp__title { font-size: var(--ax-fs); font-weight: 700; line-height: 1.35; margin: 2px 0 0; overflow-wrap: anywhere; }
/* Result first (#1242): the answer is the post, the request opens under it. */
/* Compact in the feed (#1355): at most three lines; the opened post has it all. */
.wp__result { font-size: var(--ax-fs); line-height: 1.4; margin: 2px 0 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
/* A post in the feed opens on its own when selected (#1316). */
.wp[data-post] { cursor: pointer; }
.wp[data-post]:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
.wp__link { color: inherit; text-decoration: none; }
.wp__link:hover { text-decoration: underline; }
.wp--open { padding-top: 16px; }
.wp--open:hover { background: none; }
.wp--open .wp__result { display: block; font-size: 17px; line-height: 1.5; overflow: visible; }
.wp__th { font-size: var(--ax-fs); font-weight: 800; margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--ax-border); }
.ax-wall__back { font: inherit; font-size: 20px; line-height: 1; background: none; border: 0; border-radius: var(--ax-radius-pill); color: var(--ax-text); padding: 6px 10px; margin: 0 8px 0 -10px; cursor: pointer; }
.ax-wall__back:hover { background: var(--ax-surface); }
.ax-wall__titlebar { display: flex; align-items: center; }

/* Markdown in results, thread lines and summaries (#1316). */
.ax-md p { margin: 0 0 6px; white-space: pre-line; }
.ax-md > :last-child { margin-bottom: 0; }
.ax-md h1, .ax-md h2, .ax-md h3, .ax-md h4 { font-size: 1em; font-weight: 800; margin: 8px 0 4px; }
.ax-md ul, .ax-md ol { margin: 0 0 6px; padding-left: 22px; }
.ax-md li.task { list-style: none; margin-left: -18px; }
.ax-md code { font-family: var(--ax-mono); font-size: 0.9em; background: var(--ax-surface-2); border-radius: var(--ax-radius-sm); padding: 0 4px; }
.ax-md pre { background: var(--ax-surface-2); border-radius: var(--ax-radius); padding: 8px 10px; overflow-x: auto; margin: 0 0 6px; }
.ax-md pre code { background: none; padding: 0; white-space: pre; }
.ax-md blockquote { margin: 0 0 6px; padding-left: 10px; border-left: 3px solid var(--ax-border-2); color: var(--ax-muted); }
.ax-md table { border-collapse: collapse; font-size: var(--ax-fs-sm); margin: 0 0 6px; display: block; overflow-x: auto; }
.ax-md th, .ax-md td { border: 1px solid var(--ax-border-2); padding: 3px 8px; text-align: left; }
.ax-md hr { border: 0; border-top: 1px solid var(--ax-border); margin: 8px 0; }
.ax-md a { color: var(--ax-accent); }
.wp__from { color: var(--ax-muted); font-size: var(--ax-fs-xs); margin-top: 2px; }
.wp__from a { color: inherit; }
.wp__ask { margin-top: 6px; border-left: 2px solid var(--ax-border); padding-left: 8px; font-size: var(--ax-fs-sm); }
.wp__ask summary { cursor: pointer; color: var(--ax-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wp__ask summary .k { color: var(--ax-text-2); font-weight: 600; }
.wp__ask[open] summary { white-space: normal; color: var(--ax-text); }
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
.wt .txt { overflow-wrap: anywhere; color: var(--ax-text-2); margin-top: 2px; }
.wt .is-err .txt { color: var(--ax-red-ink, var(--ax-err)); }
.wt .ids { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.wt .ids a, .wt .ids span, .wt .men { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); background: var(--ax-surface-2); border-radius: var(--ax-radius-sm); padding: 0 4px; color: var(--ax-text-2); text-decoration: none; }
.wt .men { background: var(--ax-blue-t, var(--ax-surface-2)); }
.wt .more { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-accent); cursor: pointer; padding: 0; }
.wt .wt { margin-top: 4px; }

/* What the owner does from an open post (#1316): comment, call, Space. */
.wdo { margin: 12px 0 0; padding: 12px 0 0; border-top: 1px solid var(--ax-border); display: flex; flex-direction: column; gap: 8px; }
.wdo__l { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdo__t { width: 100%; font: inherit; color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 8px 10px; resize: vertical; }
.wdo__row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wdo__row .wdo__t { flex: 1; min-width: 160px; width: auto; }
.wdo__sp { display: inline-flex; gap: 6px; align-items: center; }
.wdo__sp select { font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 5px 10px; }
.wdo__n { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wdo__n:empty { display: none; }
.wsp { border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-lg); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.wsp__t { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: var(--ax-fs-sm); max-height: 260px; overflow-y: auto; }

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

/* Side column boxes (the dashboard links are styled in wall-space.ts) */
.ax-wall__nodes > div { display: flex; flex-direction: column; }
/* Happening now (#1355): one line per machine; Running now has the rest. */
.wh { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; font-size: var(--ax-fs-sm); border-top: 1px solid var(--ax-border); min-width: 0; }
.wh:first-child { border-top: 0; }
.wh b { flex: none; }
.wh span { color: var(--ax-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh.is-down b, .wh.is-down span { color: var(--ax-red-ink, var(--ax-err)); }
.ax-wall__classicd { margin-top: 8px; font-size: var(--ax-fs-xs); }
.ax-wall__classicd summary { cursor: pointer; color: var(--ax-accent); margin-bottom: 6px; }
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

/* Running now and Agents as pages (#1316) */
.ax-wall__running { padding: 4px 16px 16px; }
.wag { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.wag__b { flex: 1; min-width: 0; }
.wag .wpf__stats .is-err, .wag .wpf__stats .is-err b { color: var(--ax-red-ink, var(--ax-err)); }
.wag .wpf__links .wa-more { padding: 0; }
.wag__note { padding: 10px 16px 0; }

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

/* Narrow widths: the column order is set in wall-space.ts. */
@media (max-width: 640px) {
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
