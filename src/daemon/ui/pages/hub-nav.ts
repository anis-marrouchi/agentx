// --- The Hub's left column as in the v3 mock V1 (#2101 P4) ---
//
// Top: "Jump to an agent or request ⌘K" (the switcher, V3). Then every
// agent grouped by state with filter chips (hub-agents.ts). At the bottom,
// as on the mock: Desk · Jobs · Workflows, plus the new Mobile app page
// (Anis, 2026-11-24, c7127515359) and Settings for the owner. The old page
// menu is gone from view (#2101 R22); every page is in the ⌘K switcher.
//
// Every link is a hash route on the same page, so it works inside the
// Electron window (C3) as in a browser tab.

import { hubIcon } from "./hub-lucide"

// Built once: the same lucide set as the page script's icon map (hub-nav.client.ts).
const ICON = {
  search: hubIcon("search"),
  needs: hubIcon("inbox"),
  jobs: hubIcon("list-checks"),
  workflows: hubIcon("workflow"),
  phone: hubIcon("smartphone"),
  settings: hubIcon("settings"),
  x: hubIcon("x"),
  chevron: hubIcon("chevron-right", "", 14),
}

/** Each page's icon, by its nav key: the side menu, the rail and ⌘K's
 *  Pages use the same one (orca-design C9; the review's NAV_ICON list). */
export const HUB_PAGE_ICON: Record<string, string> = {
  wall: "house", needs: "inbox", jobledger: "list-checks", live: "radio", running: "activity",
  projects: "folder", activity: "history", numbers: "chart-line", jobs: "calendar-clock",
  workflows: "workflow", reviews: "message-square-check", events: "megaphone", failures: "triangle-alert",
  agents: "bot", people: "users", org: "network", operations: "layout-dashboard", cost: "circle-dollar-sign",
  settings: "settings", dashboard: "layout-dashboard", creator: "square-pen", mobile: "smartphone",
}

/** The icons the page script draws with (rows, rail, ⌘K, row menu). */
export const HUB_NAV_ICON_NAMES: readonly string[] = [
  "circle-alert", "circle-x", "loader-circle", "circle-check", "circle", "chevron-right", "square", "ellipsis",
  "message-square-text", "arrow-up-right", "unplug", "message-square", "activity", "history", "copy", "check",
  ...new Set(Object.values(HUB_PAGE_ICON)),
]

/** The search box, the Agents label and the agent list (and its rail form),
 *  at the top of the side menu. One name for the search everywhere: the
 *  box, its tooltip on the rail and the ⌘K dialog (orca-design C17). */
export function hubAgentsNavHtml(): string {
  return `<button type="button" class="ha__k" id="hub-k" aria-haspopup="dialog" aria-controls="hub-k-dlg" aria-label="Search agents and pages" data-tip="Search agents and pages" data-tip-side="right" data-tip-key="K">${ICON.search}<span>Search agents and pages</span><kbd class="ha__kbd" data-mod-key="K">⌘K</kbd></button>
    <p class="ax-wall__navlbl ha__lbl">Agents</p>
    <section class="ha" id="hub-agents" aria-label="Agents, by what they are doing"><div role="status" data-key="loading"><span class="ax-sr">Loading the agents…</span><span class="ax-af-skeleton"></span><span class="ax-af-skeleton"></span><span class="ax-af-skeleton"></span></div></section>
    <div class="ha__rail" id="hub-rail" role="group" aria-label="Agents"></div>`
}

/** The ⌘K dialog. Mounted as a direct child of <body>, never in the sticky
 *  side menu, whose stacking context hid it behind the page (#2353). It
 *  opens with no animation (keyboard, orca-design motion). Also mounts the
 *  one tooltip and the agent row menu, for the same reason. */
export function hubSwitcherHtml(): string {
  return `<div class="hk" id="hub-k-dlg" role="dialog" aria-modal="true" aria-label="Search agents and pages" hidden>
      <button type="button" class="hk__scrim" data-hk-close aria-label="Close" tabindex="-1"></button>
      <div class="hk__box">
        <label class="hk__q">${ICON.search}<input id="hub-k-q" type="search" autocomplete="off" spellcheck="false" placeholder="Search agents and pages" aria-controls="hub-k-list" aria-label="Search agents and pages"></label>
        <div class="hk__list" id="hub-k-list" role="listbox" aria-label="Agents, requests and pages"></div>
        <p class="hk__foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd data-mod-key="1">⌘1</kbd> to <kbd data-mod-key="9">⌘9</kbd> an agent</span><span class="hk__esc"><kbd>esc</kbd> close</span></p>
      </div>
    </div>
    <div class="ax-tip" id="ax-tip" role="tooltip" hidden></div>
    <div class="ha-menu" id="ha-menu" role="menu" aria-label="Agent" hidden></div>`
}

/** Workspace: Waiting on you (the Desk, #2226) · Jobs · Workflows · Mobile
 *  app, then Settings pinned at the bottom (owner only). The simple layout
 *  hides Workflows and Mobile app (hub-layout.ts). On the rail each is its
 *  icon with a tooltip. Light / dark shows on the phone only, where the
 *  status bar that holds Theme is hidden (hub-status.ts). */
export function hubNavFootHtml(owner: boolean, settingsHref: string): string {
  const a = (nav: string, href: string, icon: string, label: string, count = "") =>
    `<a class="hf__item" data-nav="${nav}" href="${href}" aria-label="${label}" data-tip="${label}" data-tip-side="right">${icon}<span>${label}</span>${count}</a>`
  return `<p class="ax-wall__navlbl hf__lbl">Workspace</p>
    <div class="hf" id="hub-foot">
      ${a("needs", "#status=open&amp;view=decide", ICON.needs, "Waiting on you", '<b class="hf__n ax-af-count" data-tone="warn" data-n-for="nav-n-needs" hidden></b>')}
      ${a("jobledger", "#page=jobledger", ICON.jobs, "Jobs")}
      ${a("workflows", "#page=workflows", ICON.workflows, "Workflows")}
      ${a("mobile", "#page=mobile", ICON.phone, "Mobile app")}
    </div>
    <div class="hf hf--set">${owner ? a("settings", settingsHref, ICON.settings, "Settings") : ""}<button type="button" class="hf__item hf__theme" data-wall-theme>${hubIcon("sun-moon")}<span>Light / dark</span></button></div>`
}

/** The X that closes the side menu when it is a Sheet (phone, or the rail
 *  expanded under 1180 px). */
export function hubSheetCloseHtml(): string {
  return `<button type="button" class="axp-btn hub-sheet-x" data-sheet-close aria-label="Close the menu" data-tip="Close">${ICON.x}</button>`
}

/** The rail's Expand menu (641-1180 px): opens the full menu as a Sheet
 *  over the page. On a computer the folded menu's own button unfolds it
 *  (hub-panels.ts hubNavFoldHtml). */
export function hubRailOpenHtml(): string {
  return `<button type="button" class="axp-btn hub-rail-open" data-sheet-open aria-label="Expand menu" aria-expanded="false" aria-controls="wall-nav" data-tip="Expand menu" data-tip-side="right">${hubIcon("panel-left")}</button>`
}

/** The phone top bar's search: the same ⌘K dialog. */
export function hubSearchButtonHtml(): string {
  return `<button type="button" class="axp-btn hub-k-btn" data-hk-open aria-haspopup="dialog" aria-controls="hub-k-dlg" aria-label="Search agents and pages" data-tip="Search agents and pages">${ICON.search}</button>`
}

/** The phone top bar's menu button: the first thing in the titlebar, shown
 *  at 640 px and below only. It opens the side menu as a left Sheet. */
export function hubMenuButtonHtml(): string {
  return `<button type="button" class="axp-btn hub-menu-btn" id="wall-menu-btn" data-sheet-open aria-label="Open the menu" aria-expanded="false" aria-controls="wall-nav" data-tip="Menu">${hubIcon("menu")}</button>`
}

/** The fold chevron that leads a side-menu heading (Machines). */
export const HUB_FOLD_CHEVRON = `<span class="ha__chev" aria-hidden="true">${ICON.chevron}</span>`

/** The same chevron as a CSS mask, for folds drawn by ::before (the
 *  Machines tree inside the side menu, wall.ts .mt). */
export const HUB_CHEVRON_MASK = `url("data:image/svg+xml,${encodeURIComponent(hubIcon("chevron-right", "", 14))}")`

// The docs website page, never the raw .md on GitHub (Anis 2026-11-25).
const PAIR_DOC = "https://agentx-docs.pages.dev/dashboard/mobile-app"

/** The Mobile app page (Anis, 2026-11-24): why to try it, then how. */
export function hubMobilePageHtml(): string {
  return `<section id="wall-mobile" class="hm" aria-labelledby="hm-h" hidden>
      <div class="hm__hero ax-af-card">
        <h2 id="hm-h">Your agents, in your pocket</h2>
        <p class="hm__lede">The same agents and the same chats as here, on your phone. Hold to talk to the agent you are with, answer what waits for you on the Desk with one tap, and get a note when a run ends or an agent asks you something.</p>
        <ul class="hm__why">
          <li><b>Talk, don't type.</b> Hold the button, say it, let go. The agent answers aloud, and the talk stays in its chat.</li>
          <li><b>Say yes from anywhere.</b> Questions and approvals land on the phone's Desk; one tap answers, as here.</li>
          <li><b>See the diff on the go.</b> The Changes screen shows what an agent changed, and your line comment goes back to it.</li>
          <li><b>Nothing to download.</b> No app store, no account. It is a page your own computer serves, added to the home screen, on iPhone and Android.</li>
        </ul>
      </div>
      <h3>Install it in five minutes</h3>
      <ol class="hm__steps">
        <li><b>Link the phone and this computer with Tailscale</b>, a free private network: install it on both and sign in to the same account. Nothing is opened to the internet.</li>
        <li><b>On this computer</b>, give the phone app its private address:
          <pre><code>tailscale serve --bg --set-path /app http://127.0.0.1:4202/app
tailscale serve --bg --set-path /api/app http://127.0.0.1:4202/api/app</code></pre></li>
        <li><b>Pair the phone</b> from the folder that holds <code>agentx.json</code>. A QR code and a pairing code appear:
          <pre><code>agentx app pair --name "My phone"</code></pre></li>
        <li><b>On the phone</b>, point the camera at the QR code and open the link.</li>
        <li><b>Add it to the home screen</b>: iPhone Safari, Share, then Add to Home Screen; Android Chrome, the ⋮ menu, then Install app.</li>
      </ol>
      <p class="hm__note">The app is for your own phone only: it opens chat with every agent of yours. A teammate gets their own work page instead. The pairing code works once, for 10 minutes.</p>
      <p class="hm__links"><a class="ax-btn" href="${PAIR_DOC}" target="_blank" rel="noopener">Full guide, with screenshots</a></p>
    </section>`
}

export const HUB_NAV_CSS = `
/* The side menu (#2101, the approved orca mock; hub-nav.ts, hub-agents.ts).
   Grey chrome, colour only for state (orca-design C6); hairlines (C7). */
.ax-wall__navhead { display: flex; align-items: center; gap: 4px; min-height: 36px; margin: 0 0 8px; }
.ax-wall__navhead .ax-wall__logo { flex: 1; padding: 0 6px; }
.ax-wall__navhead .axp-navfold { position: static; }
/* .axp-btn (hub-panels.ts) shows every button; these show only at their width. */
.axp-btn.hub-rail-open, .axp-btn.hub-sheet-x, .axp-btn.hub-menu-btn, .axp-btn.hub-k-btn, #hub-rail { display: none; }
.ha__k { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; margin: 0 0 12px; padding: 0 6px 0 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-bg); color: var(--ax-muted); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.ha__k:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: 1px; }
@media (hover: hover) { .ha__k:hover { border-color: var(--ax-border-2); color: var(--ax-text-2); } }
.ha__k svg { width: 16px; height: 16px; flex: none; }
.ha__k span { flex: 1; }
.ha__kbd, .hk kbd, .ax-tip kbd { font: 500 11px/1 var(--ax-mono, ui-monospace, monospace); padding: 3px 5px; border: 1px solid var(--ax-border); border-radius: 4px; color: var(--ax-muted); background: var(--ax-surface); }
.ha__lbl, .hf__lbl { padding: 4px 8px 6px; font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.ha { margin: 0 0 6px; }
/* One scroller on a computer (Anis 2026-11-26): the whole menu scrolls, the
   search stays at the top and Settings at the bottom. */
/* The menu is a flex column: its parts keep their height and the menu
   scrolls, at every width (the Sheet too). */
.ax-wall__nav > .ha__k, .ax-wall__nav > .ha__lbl { flex: none; }
.ax-wall__nav > .ha { flex: 1 0 auto; }
@media (min-width: 1181px) {
  .ax-wall__nav { overscroll-behavior: contain; }
  .ax-wall__nav > .ha__k { position: sticky; top: -4px; z-index: 2; box-shadow: 0 0 0 12px var(--ax-bg); }
}
/* Machines that do not answer: said once, with where to look (C15). */
.ha__down { display: flex; gap: 8px; margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); font-size: 12px; line-height: 1.45; color: var(--ax-text-2); }
.ha__down svg { flex: none; width: 14px; height: 14px; margin-top: 2px; color: var(--ax-muted); }
.ha__down a { color: var(--ax-text); text-decoration: underline; text-underline-offset: 2px; }
/* A group: chevron, title, count (C22). */
.ha__h { display: flex; align-items: center; gap: 6px; margin: 6px 0 2px; padding: 6px 8px; border-radius: var(--ax-radius-sm); font-size: 13px; font-weight: 500; color: var(--ax-text); }
.ha__fold > summary { cursor: pointer; list-style: none; }
.ha__fold > summary::-webkit-details-marker { display: none; }
.ha__fold > summary:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: 1px; }
@media (hover: hover) { .ha__fold > summary:hover { background: var(--ax-surface-2); } }
.ha__chev { display: inline-flex; color: var(--ax-muted); transition: transform 150ms ease-out; }
.ha__chev svg { width: 14px; height: 14px; }
details[open] > summary > .ha__chev { transform: rotate(90deg); }
.ha__ht { flex: 1; }
.ha__hn { font-size: 12px; font-weight: 400; color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.ha__m { display: flex; justify-content: space-between; margin: 6px 0 2px; padding: 0 8px 0 12px; font-size: 11px; font-weight: 500; color: var(--ax-muted); }
.ha__more { display: block; width: 100%; margin: 0 0 4px; padding: 4px 8px 4px 46px; border: 0; border-radius: var(--ax-radius-sm); background: none; color: var(--ax-muted); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; }
.ha__more:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: 1px; }
@media (hover: hover) { .ha__more:hover { background: var(--ax-surface-2); color: var(--ax-text); } }
/* An agent: two lines, 44 px (48 on touch; orca-design recipes §3). */
.ha__row { position: relative; display: flex; align-items: center; min-height: 44px; border-radius: var(--ax-radius-sm); }
.ha__link { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: inherit; color: var(--ax-text); text-decoration: none; }
.ha__link:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: -2px; }
@media (hover: hover) { .ha__row:hover { background: var(--ax-surface-2); } }
.ha__row.is-cur { background: var(--ax-surface-3); }
.ha__face { position: relative; flex: none; width: 28px; height: 28px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); display: grid; place-items: center; background: var(--ax-surface); color: var(--ax-text-2); font: 600 10.5px/1 var(--ax-font); letter-spacing: .02em; }
.ha__txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ha__top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ha__name { flex: 0 1 auto; min-width: 0; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ha__top time { margin-left: auto; font-size: 11.5px; color: var(--ax-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* The agent's counts (#2145): icon + number, words in the tooltip. */
.ha__stats { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0; font-size: 11px; color: var(--ax-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ha__stats > span[data-stat] { display: inline-flex; align-items: center; gap: 2px; }
.ha__stats svg { width: 12px; height: 12px; }
.ha__line { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--ax-text-2); }
.ha__lt { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ha__since { display: block; min-width: 0; font-size: 11.5px; color: var(--ax-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ha__n { flex: none; margin-right: 8px; }
/* The one state set (orca-design recipes §9): icon + word, colour for state only. */
.ha__si { display: inline-flex; flex: none; }
.ha__si svg { width: 14px; height: 14px; }
.ha__si.is-needs { color: var(--ax-amber-ink); }
.ha__si.is-failed { color: var(--ax-red-ink); }
.ha__si.is-working { color: var(--ax-text-2); }
.ha__si.is-working svg { animation: ha-spin 1s linear infinite; }
.ha__si.is-done { color: var(--ax-green-d); }
.ha__si.is-idle { color: var(--ax-muted); opacity: .6; }
@keyframes ha-spin { to { transform: rotate(360deg); } }
/* Stop and the row menu: on hover or focus, always on touch (C12). */
.ha__acts { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: none; gap: 2px; padding-left: 4px; background: inherit; border-radius: var(--ax-radius-sm); }
.ha__row:focus-within .ha__acts { display: flex; background: var(--ax-surface-2); }
.ha__row.is-cur:focus-within .ha__acts { background: var(--ax-surface-3); }
@media (hover: hover) { .ha__row:hover .ha__acts { display: flex; } }
.ha__act { all: unset; box-sizing: border-box; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: var(--ax-radius-sm); color: var(--ax-muted); cursor: pointer; }
.ha__act svg { width: 14px; height: 14px; }
.ha__act:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: -2px; }
.ha__act[aria-expanded="true"] { background: var(--ax-surface-3); color: var(--ax-text); }
.ha__act:disabled { opacity: .5; cursor: default; }
@media (hover: hover) { .ha__act:hover { background: var(--ax-surface-3); color: var(--ax-text); } }
@media (pointer: coarse) {
  .ha__row { min-height: 48px; }
  .ha__acts { position: static; display: flex; transform: none; background: none; padding: 0 4px 0 0; }
  .ha__act { width: 36px; height: 36px; }
}
/* A working agent's other runs, under its row (#2328). */
.ha__runs { display: flex; flex-direction: column; margin: -2px 0 4px 46px; }
.ha__run { display: block; padding: 2px 8px; border-radius: var(--ax-radius-sm); font-size: 12px; color: var(--ax-text-2); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
a.ha__run:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: -2px; }
@media (hover: hover) { a.ha__run:hover { background: var(--ax-surface-2); color: var(--ax-text); } }
.ha__run.is-rest { color: var(--ax-muted); }
.ha__rch { font-weight: 600; color: var(--ax-text); }
.ha__empty { margin: 8px; font-size: 13px; color: var(--ax-muted); }
.ax-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .ha__si.is-working svg { animation: none; } .ha__chev { transition: none; } }
/* Workspace: Waiting on you, Jobs, Workflows, Mobile app; Settings pinned at the bottom. */
.hf__lbl { margin: 14px 0 0; }
.hf { display: flex; flex-direction: column; gap: 1px; }
.hf__item { position: relative; display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 8px; border-radius: var(--ax-radius-sm); color: var(--ax-text-2); font-size: 13.5px; text-decoration: none; }
.hf__item:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: -2px; }
@media (hover: hover) { .hf__item:hover { background: var(--ax-surface-2); color: var(--ax-text); } }
.hf__item.is-on { background: var(--ax-surface-3); color: var(--ax-text); font-weight: 500; }
.hf__item svg { width: 16px; height: 16px; flex: none; }
.hf__item span { flex: 1; white-space: nowrap; }
.hf__n[hidden] { display: none; }
button.hf__item { width: 100%; border: 0; background: none; font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
.hf__item.hf__theme { display: none; }
.hf--set { margin: auto -16px -12px; padding: 8px 16px 12px; border-top: 1px solid var(--ax-border); background: var(--ax-bg); position: sticky; bottom: -12px; z-index: 2; }
/* ⌘K: search agents and pages (V3). Opens with no animation (keyboard). */
.hk { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; }
/* display: flex above beats the hidden attribute: closed means gone (#2353). */
.hk[hidden] { display: none; }
.hk__scrim { position: absolute; inset: 0; border: 0; padding: 0; background: var(--ax-overlay, rgb(0 0 0 / 40%)); cursor: default; }
.hk__box { position: relative; width: min(640px, calc(100vw - 24px)); max-height: 72vh; display: flex; flex-direction: column; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); box-shadow: var(--ax-shadow-lg); overflow: hidden; }
.hk__q { flex: none; display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 16px; border-bottom: 1px solid var(--ax-border); }
.hk__q svg { width: 16px; height: 16px; color: var(--ax-muted); }
.hk__q input { flex: 1; border: 0; outline: 0; background: none; color: var(--ax-text); font: inherit; font-size: 16px; }
/* The box is the whole dialog: no ring of its own on the input (Orca's palette). */
.hk__q input:focus, .hk__q input:focus-visible { outline: none; box-shadow: none; }
@media (min-width: 768px) { .hk__q input { font-size: 14px; } }
.hk__list { overflow-y: auto; padding: 4px 8px 8px; }
.hk__h { margin: 10px 8px 4px; font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.hk__hit { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 8px; border-radius: var(--ax-radius-sm); color: var(--ax-text); text-decoration: none; }
.hk__hit.is-sel { background: var(--ax-surface-3); }
@media (hover: hover) { .hk__hit:hover { background: var(--ax-surface-2); } .hk__hit.is-sel:hover { background: var(--ax-surface-3); } }
.hk__hit .ha__name { font-size: 13.5px; font-weight: 500; }
.hk__kbd { margin-left: auto; }
.hk__ico { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; color: var(--ax-muted); }
.hk__ico svg { width: 16px; height: 16px; }
.hk__foot { flex: none; display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0; padding: 8px 16px; border-top: 1px solid var(--ax-border); font-size: 12px; color: var(--ax-muted); }
.hk__foot kbd { margin-right: 2px; }
.hk__esc { margin-left: auto; }
/* The one tooltip and the agent row menu (floating: the only shadows, C7). */
.ax-tip { position: fixed; z-index: 90; max-width: 300px; padding: 5px 8px; border-radius: var(--ax-radius-sm); background: var(--ax-text); color: var(--ax-bg); font-size: 12px; line-height: 1.35; pointer-events: none; }
.ax-tip[hidden] { display: none; }
.ax-tip kbd { margin-left: 6px; background: none; color: inherit; border-color: color-mix(in srgb, var(--ax-bg) 35%, transparent); }
.ha-menu { position: fixed; z-index: 75; min-width: 200px; padding: 4px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-bg); box-shadow: var(--ax-shadow-lg); }
.ha-menu[hidden] { display: none; }
.ha-menu [role="menuitem"] { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border-radius: var(--ax-radius-sm); color: var(--ax-text); font-size: 13.5px; cursor: pointer; }
.ha-menu [role="menuitem"] svg { width: 16px; height: 16px; color: var(--ax-muted); }
.ha-menu [role="menuitem"]:focus, .ha-menu [role="menuitem"]:hover { background: var(--ax-surface-2); }
.ha-menu .is-danger, .ha-menu .is-danger svg { color: var(--ax-red-ink); }
.ha-menu hr { margin: 4px -4px; border: 0; border-top: 1px solid var(--ax-border); }
/* The icon rail (641-1180 px, and the folded menu on a computer; C26):
   56 px, the same agents as faces with their state icon, the same order. */
.ax-wall.is-rail:not(.is-sheet) .ax-wall__nav { padding: 10px 0; align-items: center; overflow-x: hidden; }
.ax-wall.is-rail:not(.is-sheet) .ax-wall__navhead { flex-direction: column; margin: 0 0 6px; }
.ax-wall.is-rail:not(.is-sheet) .ax-wall__logo, .ax-wall.is-rail:not(.is-sheet) .ax-wall__navlbl, .ax-wall.is-rail:not(.is-sheet) #hub-agents,
.ax-wall.is-rail:not(.is-sheet) #wall-machines, .ax-wall.is-rail:not(.is-sheet) .hf__item span { display: none; }
.ax-wall.is-rail:not(.is-sheet) #hub-rail { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; }
.ax-wall.is-rail:not(.is-sheet) .ax-wall__nav > .ha__k { position: static; box-shadow: none; width: 36px; height: 36px; margin: 0 0 8px; padding: 0; justify-content: center; }
.ax-wall.is-rail:not(.is-sheet) .ax-wall__nav > .ha__k span, .ax-wall.is-rail:not(.is-sheet) .ax-wall__nav > .ha__k kbd { display: none; }
.ax-wall.is-rail:not(.is-sheet) .hf { align-items: center; width: 100%; }
.ax-wall.is-rail:not(.is-sheet) .hf:not(.hf--set) { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ax-border); width: 32px; }
.ax-wall.is-rail:not(.is-sheet) .hf__item { width: 36px; height: 36px; padding: 0; justify-content: center; }
.ax-wall.is-rail:not(.is-sheet) .hf__n { position: absolute; top: -2px; right: -4px; }
.ax-wall.is-rail:not(.is-sheet) .hf--set { margin: auto 0 -10px; padding: 8px 0 10px; }
.ha__ri { position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--ax-radius-sm); text-decoration: none; }
.ha__ri .ha__face { width: 32px; height: 32px; font-size: 11px; }
.ha__ri.is-cur { background: var(--ax-surface-3); }
.ha__ri:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: -2px; }
@media (hover: hover) { .ha__ri:hover { background: var(--ax-surface-2); } }
.ha__fsi { position: absolute; right: -4px; bottom: -4px; padding: 1px; border-radius: 50%; background: var(--ax-bg); }
.ha__fsi svg { width: 12px; height: 12px; display: block; }
.ha__rsep { width: 24px; margin: 4px 0; border: 0; border-top: 1px solid var(--ax-border); }
@media (min-width: 641px) and (max-width: 1180px) { .ax-wall.is-rail:not(.is-sheet) .axp-btn.hub-rail-open { display: inline-flex; } }
/* The Sheet: the same menu over the page, from the left (phone, and the
   rail expanded). 300 ms in, 200 ms out (orca-design, Orca's Sheet). */
.hub-scrim { display: none; }
@media (max-width: 1180px) {
  .ax-wall.is-sheet .ax-wall__nav { position: fixed; z-index: 60; top: 0; left: 0; bottom: 0; width: min(320px, 85vw); height: 100%; padding: 12px 16px; border-right: 1px solid var(--ax-border); background: var(--ax-bg); box-shadow: var(--ax-shadow-lg); animation: hub-sheet-in 300ms cubic-bezier(.32, .72, 0, 1); }
  .ax-wall.is-sheet .hub-scrim { display: block; position: fixed; inset: 0; z-index: 59; border: 0; padding: 0; background: var(--ax-overlay, rgb(0 0 0 / 40%)); cursor: default; }
  .ax-wall.is-sheet .axp-btn.hub-sheet-x { display: inline-flex; }
  .ax-wall.is-sheet .axp-navfold, .ax-wall.is-sheet .hub-rail-open { display: none !important; }
  .ax-wall.is-sheet .hf--set { margin: auto -16px -12px; }
}
@keyframes hub-sheet-in { from { transform: translateX(-100%); } }
/* Phone: a top bar (menu, title, search) opens the Sheet; no bottom bar. */
@media (max-width: 640px) {
  .ax-wall:not(.is-sheet) .ax-wall__nav { display: none; }
  .axp-btn.hub-menu-btn, .axp-btn.hub-k-btn { display: inline-flex; min-width: 36px; height: 36px; }
  /* Search sits at the right, beside the chat button (the approved phone mock). */
  .axp-btn.hub-k-btn { margin-left: auto; }
  .hf__item.hf__theme { display: flex; }
  .ax-wall.is-sheet .ax-wall__nav .ha__row { min-height: 48px; }
  /* Stop and the menu always show on touch, so the counts give the name their room. */
  .ax-wall.is-sheet .ax-wall__nav .ha__stats { display: none; }
}
@media (prefers-reduced-motion: reduce) { .ax-wall.is-sheet .ax-wall__nav { animation: none; } }
/* The Mobile app page. */
.hm { max-width: 640px; padding: 8px 24px 40px; }
.hm__hero { padding: 20px 22px; margin: 8px 0 20px; }
.hm h2 { margin: 0 0 8px; font: 600 24px/1.2 var(--ax-font-head, inherit); }
.hm h3 { margin: 18px 0 8px; font-size: 16px; }
.hm__lede { margin: 0 0 12px; color: var(--ax-text-2); font-size: 15px; }
.hm__why { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; color: var(--ax-text-2); }
.hm__why b { color: var(--ax-text); }
.hm__steps { padding-left: 20px; display: grid; gap: 10px; font-size: 14px; }
.hm pre { margin: 6px 0 0; padding: 8px 10px; overflow-x: auto; border-radius: var(--ax-radius-sm); background: var(--ax-surface); border: 1px solid var(--ax-border); font-size: 12.5px; }
.hm__note { font-size: 13px; color: var(--ax-muted); }
.hm__links { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 1180px) { .hm { padding: 8px 16px 32px; } }
`
