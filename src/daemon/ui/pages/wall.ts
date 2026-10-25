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
// It is its own space (#1242), the way the wiki is: its own page shell,
// tokens and type taken from the approved take B mockup (left nav, feed
// column, side column), with no dashboard top bar. The left nav links back
// to the dashboard and the classic pages, and the dashboard keeps its Wall
// tab. Theme follows the dashboard's stored choice (`ax-theme`).
//
// The HTML is a skeleton; WALL_PAGE_SCRIPT paints it from
// /api/admin/wall?peer=fleet, /api/live and /api/workflows/runs.

import { WALL_PAGE_SCRIPT } from "./wall.client"
import { CRON_JOBS_SCRIPT, CRON_VALUE_CSS, CRON_VALUE_SCRIPT } from "../cron-value"
import { WALL_REVIEWS_CSS } from "./wall-reviews.client"

export interface WallPageOpts {
  localToken?: string
}

/** The classic pages, one tap from the Wall (#1180 items 1, 23, 27). */
export const WALL_CLASSIC_LINKS: Array<[string, string]> = [
  ["Live", "/live"], ["Operations", "/mesh"], ["Monitor", "/monitor"], ["Approvals", "/approvals"],
  ["People", "/people"], ["Activity", "/activity"], ["Workflows", "/workflows"], ["Settings", "/admin"],
]

/** Where "Back to the dashboard" goes: its first page after the Wall. */
export const WALL_DASHBOARD_HREF = "/live"

// Line icons for the left nav, 24px grid, drawn with currentColor.
const ICON: Record<string, string> = {
  "/wall": '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  "/live": '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  "/mesh": '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  "/monitor": '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  "/approvals": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  "/people": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  "/activity": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  "/workflows": '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6h4a4 4 0 0 1 4 4v0M8 18h4a4 4 0 0 0 4-4"/>',
  "/admin": '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
}
const icon = (k: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ""}</svg>`

export function renderWallPage(opts: WallPageOpts = {}): string {
  const token = opts.localToken ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>` : ""
  const classic = WALL_CLASSIC_LINKS.map(([label, href]) => `<a href="${href}" title="${label}">${icon(href)}<span>${label}</span></a>`).join("")
  // Take B (#1242): left nav, feed column, side column. The feed column
  // spans every side row; the last row takes the slack so the side boxes
  // stay packed at the top.
  const body = `<div class="ax-wall">
  <nav class="ax-wall__nav" aria-label="Wall and classic pages">
    <a class="ax-wall__brand" href="/wall" aria-label="AgentX Wall"><span class="ax-wall__mark">ax</span><span>AgentX</span></a>
    <a href="/wall" class="is-on" aria-current="page" title="Wall">${icon("/wall")}<span>Wall</span></a>
    <div class="ax-wall__classic">${classic}</div>
    <a href="${WALL_DASHBOARD_HREF}" class="ax-wall__back" title="Back to the dashboard">${icon("dashboard")}<span>Back to the dashboard</span></a>
    <button type="button" id="wall-theme" class="ax-wall__theme" aria-label="Switch light or dark" title="Switch light or dark">${icon("theme")}<span>Theme</span></button>
  </nav>
  <section class="ax-wall__box ax-wall__side" aria-label="Sync">
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
  <main class="ax-wall__main">
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
  </main>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX · Wall</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${WALL_THEME_BOOT}
<style>${WALL_TOKENS_CSS}${WALL_SHELL_CSS}${WALL_PAGE_CSS}${CRON_VALUE_CSS}${WALL_REVIEWS_CSS}</style>
</head>
<body class="ax-wall-space">
${body}
${token}<script>${WALL_THEME_SCRIPT}</script>
<script>${CRON_VALUE_SCRIPT}\n${CRON_JOBS_SCRIPT}\n${WALL_PAGE_SCRIPT}</script>
</body>
</html>`
}

// Same key and default as the dashboard's bootstrap, so switching theme in
// either space carries over to the other.
const WALL_THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('ax-theme');if(t!=='light'&&t!=='dark'){t='dark';localStorage.setItem('ax-theme',t)}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','dark')}})();</script>`
const WALL_THEME_SCRIPT = `(function(){var b=document.getElementById('wall-theme');if(!b)return;b.addEventListener('click',function(){var r=document.documentElement;var t=r.getAttribute('data-theme')==='dark'?'light':'dark';r.setAttribute('data-theme',t);try{localStorage.setItem('ax-theme',t)}catch(e){}});})();`

// Take B tokens. The Wall's own palette and type, under the --ax-* names
// its post, cron and review styles already read, so nothing below changes
// name. Light is white with a soft grey side column; dark is near-black.
const WALL_TOKENS_CSS = `
:root {
  --ax-bg: #ffffff; --ax-bg-elev: #f7f9f9; --ax-surface: #f7f9f9; --ax-surface-2: #eff3f4; --ax-surface-3: #e7ecef;
  --ax-border: #eff3f4; --ax-border-2: #cfd9de; --ax-text: #0f1419; --ax-text-2: #536471; --ax-muted: #536471;
  --ax-blue: #1d9bf0; --ax-blue-d: #1a8cd8; --ax-blue-t: #e8f5fd; --ax-accent: #1d9bf0; --ax-accent-2: #1a8cd8; --ax-accent-t: #e8f5fd;
  --ax-green: #00ba7c; --ax-green-d: #00875a; --ax-amber: #ffad1f; --ax-amber-t: #fff6e5; --ax-amber-ink: #8a5a00;
  --ax-red: #f4212e; --ax-red-t: #fee8ea; --ax-red-ink: #b0101b;
  --ax-ok: var(--ax-green); --ax-warn: var(--ax-amber-ink); --ax-err: var(--ax-red); --ax-info: var(--ax-blue);
  --ax-radius: 12px; --ax-radius-lg: 16px; --ax-radius-sm: 6px; --ax-radius-pill: 9999px;
  --ax-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --ax-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ax-fs: 15px; --ax-fs-sm: 14px; --ax-fs-xs: 13px;
  color-scheme: light;
}
[data-theme="dark"] {
  --ax-bg: #000000; --ax-bg-elev: #16181c; --ax-surface: #16181c; --ax-surface-2: #202327; --ax-surface-3: #2f3336;
  --ax-border: #2f3336; --ax-border-2: #536471; --ax-text: #e7e9ea; --ax-text-2: #a3abb3; --ax-muted: #8b98a5;
  --ax-blue-t: #0b2537; --ax-accent-t: #0b2537;
  --ax-green: #00ba7c; --ax-green-d: #3fd39f; --ax-amber: #ffd400; --ax-amber-t: #2a2410; --ax-amber-ink: #ffd400;
  --ax-red: #f4212e; --ax-red-t: #2a0c10; --ax-red-ink: #ff7b84;
  color-scheme: dark;
}
`

// The space itself: body, left nav, buttons and badges. No dashboard chrome.
const WALL_SHELL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body.ax-wall-space { background: var(--ax-bg); color: var(--ax-text); font-family: var(--ax-font); font-size: var(--ax-fs); line-height: 1.35; -webkit-font-smoothing: antialiased; }
.ax-wall-space a { color: inherit; }
.ax-wall-space :focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 2px; }

.ax-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-weight: 700; font-size: var(--ax-fs-sm);
  border-radius: var(--ax-radius-pill); padding: 6px 16px; border: 1px solid transparent; background: var(--ax-text); color: var(--ax-bg); cursor: pointer; text-decoration: none; }
.ax-btn:hover { opacity: .88; }
.ax-btn--ghost { background: transparent; color: var(--ax-text); border-color: var(--ax-border-2); }
.ax-btn--ghost:hover { opacity: 1; background: color-mix(in srgb, var(--ax-text) 8%, transparent); }
.ax-badge { display: inline-block; font-size: var(--ax-fs-xs); font-weight: 600; line-height: 1.5; border-radius: var(--ax-radius-pill); padding: 0 8px; background: var(--ax-surface-2); color: var(--ax-text-2); white-space: nowrap; }
.ax-badge--live { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green-d); }
.ax-badge--warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.ax-badge--err { background: var(--ax-red-t); color: var(--ax-red-ink); }

/* Left nav: brand, Wall, the classic pages, back to the dashboard, theme. */
.ax-wall__nav { grid-column: 1; grid-row: 1 / -1; position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 16px; align-self: start; }
.ax-wall__classic { display: contents; }
.ax-wall__nav > a, .ax-wall__nav .ax-wall__classic a, .ax-wall__theme { display: flex; align-items: center; gap: 18px; width: max-content; max-width: 100%; padding: 11px 16px 11px 12px; border-radius: var(--ax-radius-pill);
  font: inherit; font-size: 19px; color: var(--ax-text); text-decoration: none; background: none; border: 0; cursor: pointer; }
.ax-wall__nav > a:hover, .ax-wall__nav .ax-wall__classic a:hover, .ax-wall__theme:hover { background: color-mix(in srgb, var(--ax-text) 9%, transparent); }
.ax-wall__nav > a.is-on { font-weight: 700; }
.ax-wall__nav svg { width: 26px; height: 26px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ax-wall__nav > a.is-on svg { stroke-width: 2.6; }
.ax-wall__brand { font-weight: 800; }
.ax-wall__mark { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: var(--ax-text); color: var(--ax-bg); font-family: var(--ax-mono); font-size: 14px; font-weight: 700; }
.ax-wall__nav > a.ax-wall__back { margin-top: 14px; width: 100%; justify-content: center; background: var(--ax-accent); color: #fff; font-weight: 700; font-size: 16px; padding: 14px 16px; }
.ax-wall__nav > a.ax-wall__back:hover { background: var(--ax-accent-2); }
.ax-wall__back svg { display: none; }
.ax-wall__theme { margin-top: auto; font-size: var(--ax-fs); color: var(--ax-text-2); }
`

const WALL_PAGE_CSS = `
/* A display rule beats the user agent's [hidden] rule: keep hidden hidden. */
.ax-wall [hidden] { display: none !important; }
/* Take B (#1242): left nav, feed column, side column. The feed column
   spans every side row; the last row takes the slack so the side boxes
   stay packed at the top. The List view widens the feed column. */
.ax-wall { display: grid; grid-template-columns: 260px minmax(0, 600px) 350px; grid-template-rows: auto auto auto 1fr; column-gap: 28px;
  justify-content: center; align-items: start; max-width: 1290px; margin: 0 auto; min-height: 100vh; }
.ax-wall.is-wide { grid-template-columns: 260px minmax(0, 1fr) 300px; max-width: none; }
.ax-wall__main { grid-column: 2; grid-row: 1 / span 4; min-width: 0; border-left: 1px solid var(--ax-border); border-right: 1px solid var(--ax-border); min-height: 100vh; }
.ax-wall__nodes { grid-column: 3; grid-row: 1; margin-top: 12px; }
.ax-wall__agents { grid-column: 3; grid-row: 2; }
.ax-wall__side { grid-column: 3; grid-row: 3; background: none; border: 1px solid var(--ax-border); }
.ax-wall__box { background: var(--ax-surface); border-radius: var(--ax-radius-lg); padding: 12px 16px; margin-bottom: 16px; min-width: 0; }
.ax-wall__box h2 { font-size: 20px; font-weight: 800; margin: 0 0 8px; color: var(--ax-text); }
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
.ax-wall__sync { font-size: var(--ax-fs-xs); color: var(--ax-muted); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
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

/* Narrower desktop: the left nav folds to an icon rail, as on X. */
@media (max-width: 1280px) {
  .ax-wall { grid-template-columns: 76px minmax(0, 600px) 330px; column-gap: 20px; }
  .ax-wall.is-wide { grid-template-columns: 76px minmax(0, 1fr) 280px; }
  .ax-wall__nav { align-items: center; padding: 8px 4px 16px; }
  .ax-wall__nav span:not(.ax-wall__mark) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .ax-wall__nav > a, .ax-wall__nav .ax-wall__classic a, .ax-wall__theme { padding: 12px; gap: 0; }
  .ax-wall__nav > a.ax-wall__back { width: auto; padding: 12px; }
  .ax-wall__back svg { display: block; }
}
/* Tablet: icon rail plus one column. Sync and Running now first, then the
   feed, then the agents. */
@media (max-width: 1000px) {
  .ax-wall, .ax-wall.is-wide { grid-template-columns: 76px minmax(0, 1fr); grid-template-rows: none; column-gap: 0; }
  .ax-wall__nav { grid-row: 1 / span 4; }
  .ax-wall__side, .ax-wall__nodes, .ax-wall__agents, .ax-wall__main { grid-column: 2; grid-row: auto; margin: 0; border-radius: 0; }
  .ax-wall__side { order: 1; border-width: 0 0 1px; } .ax-wall__nodes { order: 2; } .ax-wall__main { order: 3; min-height: 0; } .ax-wall__agents { order: 4; }
  .ax-wall__main { border-right: 0; }
  .ax-wall__side, .ax-wall__nodes, .ax-wall__agents { border-left: 1px solid var(--ax-border); }
}
/* Phone: one column, and the nav becomes a tab bar along the bottom. */
@media (max-width: 640px) {
  body.ax-wall-space { padding-bottom: calc(60px + env(safe-area-inset-bottom)); }
  .ax-wall, .ax-wall.is-wide { grid-template-columns: minmax(0, 1fr); }
  .ax-wall__side, .ax-wall__nodes, .ax-wall__agents, .ax-wall__main { grid-column: 1; border-left: 0; }
  .ax-wall__nav { position: fixed; top: auto; left: 0; right: 0; bottom: 0; height: auto; z-index: 10; flex-direction: row; align-items: center; gap: 0; padding: 4px 4px calc(4px + env(safe-area-inset-bottom));
    overflow-x: auto; overflow-y: hidden; background: color-mix(in srgb, var(--ax-bg) 92%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-top: 1px solid var(--ax-border); }
  .ax-wall__brand { display: none !important; }
  .ax-wall__nav > a, .ax-wall__nav .ax-wall__classic a, .ax-wall__theme { flex: 1 1 0; min-width: 0; justify-content: center; padding: 9px 0; }
  .ax-wall__nav > a.ax-wall__back { flex: 1 1 0; margin: 0; padding: 9px 0; background: none; color: var(--ax-accent); }
  .ax-wall__theme { margin: 0; }
  .ax-wall__nav svg { width: 22px; height: 22px; }
  .ax-wall__views { overflow-x: auto; scrollbar-width: none; }
  .ax-wall__views button { flex: 1 0 auto; white-space: nowrap; padding: 12px 12px 9px; }
  .ax-wall__box { padding: 10px 12px; }
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
