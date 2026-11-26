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

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  desk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  workflows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
}

/** The switcher button and the agent list, at the top of the nav. */
export function hubAgentsNavHtml(): string {
  return `<button type="button" class="ha__k" id="hub-k" aria-haspopup="dialog" aria-controls="hub-k-dlg" title="Jump to an agent or request (⌘K)">${ICON.search}<span>Jump to an agent or request</span><kbd>⌘K</kbd></button>
    <section class="lt ha" id="hub-agents" aria-label="Agents, by what they are doing"><p class="ha__empty">Loading the agents…</p></section>
    <div class="hk" id="hub-k-dlg" role="dialog" aria-modal="true" aria-label="Jump to an agent or request" hidden>
      <button type="button" class="hk__scrim" data-hk-close aria-label="Close"></button>
      <div class="hk__box">
        <label class="hk__q">${ICON.search}<input id="hub-k-q" type="search" autocomplete="off" spellcheck="false" placeholder="Jump to an agent or request" aria-controls="hub-k-list" aria-label="Agent or request"><kbd>esc</kbd></label>
        <div class="hk__list" id="hub-k-list" role="listbox" aria-label="Agents and requests"></div>
        <p class="hk__foot"><span><kbd>↵</kbd> open chat, history kept</span><span><kbd>⌘1</kbd>…<kbd>⌘9</kbd> open that agent</span><span><kbd>⌃Tab</kbd> last agent</span></p>
      </div>
    </div>`
}

/** The row at the bottom of the nav: Desk · Jobs · Workflows · Mobile app, and Settings. */
export function hubNavFootHtml(owner: boolean, settingsHref: string): string {
  const a = (nav: string, href: string, icon: string, label: string, count = "") =>
    `<a class="hf__item" data-nav="${nav}" href="${href}" title="${label}">${icon}<span>${label}</span>${count}</a>`
  return `<div class="hf" id="hub-foot">
      ${a("needs", "#status=open&amp;view=decide", ICON.desk, "Desk", '<b class="hf__n" data-n-for="nav-n-needs" hidden></b>')}
      ${a("jobledger", "#page=jobledger", ICON.jobs, "Jobs")}
      ${a("workflows", "#page=workflows", ICON.workflows, "Workflows")}
      ${a("mobile", "#page=mobile", ICON.phone, "Mobile app")}
      ${owner ? `<a class="hf__item hf__set" data-nav="settings" href="${settingsHref}" title="Settings" aria-label="Settings">${ICON.settings}</a>` : ""}
    </div>`
}

// The docs website page, never the raw .md on GitHub (Anis 2026-11-25).
const PAIR_DOC = "https://agentx-docs.pages.dev/dashboard/mobile-app"

/** The Mobile app page (Anis, 2026-11-24): why to try it, then how. */
export function hubMobilePageHtml(): string {
  return `<section id="wall-mobile" class="hm" aria-labelledby="hm-h" hidden>
      <div class="hm__hero">
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
/* The left column as V1 (#2101 P4, hub-nav.ts, hub-agents.ts). */
.ha__k { display: flex; align-items: center; gap: 8px; width: 100%; margin: 0 0 10px; padding: 7px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-surface); color: var(--ax-muted); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.ha__k:hover, .ha__k:focus-visible { border-color: var(--ax-accent); color: var(--ax-text-2); }
.ha__k svg { width: 15px; height: 15px; flex: none; }
.ha__k span { flex: 1; }
.ha__k kbd, .hk kbd { font: 500 11px/1 var(--ax-font-mono, ui-monospace, monospace); padding: 3px 5px; border: 1px solid var(--ax-border-2); border-radius: 4px; color: var(--ax-muted); background: var(--ax-bg); }
.ha { margin: 0 0 6px; }
/* One scroller on a computer (Anis 2026-11-26): the side menu scrolls as a
   whole, so the wheel works anywhere on it and the last agent is always in
   reach. The agent list was a box of its own between the switcher and the
   foot row (#2101 R27): over the switcher or the foot the wheel did
   nothing, and at a short window the box was a few rows tall. The
   switcher stays pinned at the top and the foot row at the bottom, so the
   menu looks as before. */
@media (min-width: 1181px) {
  .ax-wall__nav { overscroll-behavior: contain; }
  .ax-wall__nav > .ha { flex: 1 0 auto; }
  .ax-wall__nav > .ha__k { position: sticky; top: -4px; z-index: 2; box-shadow: 0 0 0 12px var(--ax-bg); }
  .ax-wall__nav > .hf { position: sticky; bottom: 0; z-index: 2; background: var(--ax-bg); }
}
.ha__chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.ha__chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); background: none; color: var(--ax-text-2); font: inherit; font-size: 12.5px; cursor: pointer; }
.ha__chip b { font-weight: 600; color: var(--ax-text); font-variant-numeric: tabular-nums; }
.ha__chip[aria-pressed="true"] { background: var(--ax-surface-3); border-color: var(--ax-border-2); color: var(--ax-text); }
.ha__cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ha-s); }
.ha__chip.is-working, .ha__row.is-working, .hk__hit.is-working { --ha-s: var(--ax-accent); }
.ha__chip.is-needs, .ha__row.is-needs, .hk__hit.is-needs { --ha-s: var(--ax-amber, #f5a524); }
.ha__chip.is-done, .ha__row.is-done, .hk__hit.is-done { --ha-s: var(--ax-green, #2fbf71); }
.ha__row.is-idle, .hk__hit.is-idle { --ha-s: var(--ax-muted); }
.ha__h { display: flex; justify-content: space-between; margin: 12px 0 4px; padding: 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.ha__h span { font-weight: 500; letter-spacing: 0; }
.ha__m { display: flex; justify-content: space-between; margin: 6px 0 2px; padding: 0 6px 0 12px; font-size: 11px; font-weight: 500; color: var(--ax-muted); }
.ha__m span { font-variant-numeric: tabular-nums; }
/* Needs you and Not working today fold (Anis 2026-11-26): closed on load,
   the arrow leads the heading and turns down when open; the count stays. */
.ha__fold > summary { cursor: pointer; list-style: none; justify-content: flex-start; align-items: center; gap: 6px; border-radius: var(--ax-radius-sm); }
.ha__fold > summary::-webkit-details-marker { display: none; }
.ha__fold > summary::before { content: "›"; flex: none; width: 10px; font-size: 15px; font-weight: 400; line-height: 1; letter-spacing: 0; text-align: center; transition: transform 180ms ease-out; }
.ha__fold[open] > summary::before { transform: rotate(90deg); }
.ha__fold > summary span { margin-left: auto; }
.ha__fold > summary:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: 1px; }
@media (hover: hover) { .ha__fold > summary:hover { color: var(--ax-text-2); } }
@media (prefers-reduced-motion: reduce) { .ha__fold > summary::before { transition: none; } }
/* Working shows 3 rows in the All view, then this (Anis 2026-11-26). */
.ha__more { display: block; margin: 2px 0 4px; padding: 4px 8px 4px 46px; border: 0; border-radius: var(--ax-radius-sm); background: none; color: var(--ax-muted); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; width: 100%; }
.ha__more:focus-visible { outline: 2px solid var(--ax-ring); outline-offset: 1px; }
@media (hover: hover) { .ha__more:hover { background: var(--ax-surface-2); color: var(--ax-text); } }
.ha__row, .hk__hit { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 8px 8px; border-radius: var(--ax-radius-sm); color: var(--ax-text); text-decoration: none; }
.ha__row:hover, .ha__row:focus-visible { background: var(--ax-surface-2); }
.ha__row.is-cur { background: var(--ax-surface-3); box-shadow: inset 3px 0 0 var(--ax-accent); }
.ha__face { position: relative; flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--ha-c, var(--ax-accent)); color: #fff; font: 600 13px/1 var(--ax-font-head, inherit); }
.ha__dot { position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--ha-s); border: 2px solid var(--ax-bg); }
.ha__txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ha__top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ha__name { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ha__node { font-size: 11px; padding: 0 5px; border: 1px solid var(--ax-border); border-radius: 4px; color: var(--ax-muted); white-space: nowrap; }
.ha__top time { margin-left: auto; font-size: 11.5px; color: var(--ax-muted); white-space: nowrap; }
.ha__line { font-size: 12.5px; color: var(--ax-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A working agent (#2270): its dot breathes a soft ring and the run's line
   shimmers, in place of the old sliding stripe. Still under reduced motion. */
.ha__row.is-working .ha__dot::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--ha-s); opacity: 0; animation: ha-ping 2s cubic-bezier(0, 0, .2, 1) infinite; }
@keyframes ha-ping { 0% { transform: scale(.6); opacity: .7; } 80%, 100% { transform: scale(1.5); opacity: 0; } }
.ha__row.is-working .ha__line { color: transparent; background: linear-gradient(100deg, var(--ax-text-2) 0 40%, var(--ax-text) 50%, var(--ax-text-2) 60% 100%); background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; animation: ha-shine 2.4s ease-in-out infinite; }
@keyframes ha-shine { from { background-position: 100% 0; } to { background-position: 0 0; } }
@media (prefers-reduced-motion: reduce) { .ha__row.is-working .ha__dot::after { animation: none; opacity: 0; } .ha__row.is-working .ha__line { animation: none; color: var(--ax-text-2); background: none; } }
.ha__n { align-self: center; min-width: 18px; padding: 0 5px; line-height: 18px; border-radius: var(--ax-radius-pill); background: var(--ax-accent); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
.ha__empty { margin: 8px 6px; font-size: 13px; color: var(--ax-muted); }
.ax-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* The foot row: Desk · Jobs · Workflows · Mobile app · Settings. */
.hf { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; margin-top: auto; padding: 10px 2px 2px; border-top: 1px solid var(--ax-border); }
.hf__item { display: inline-flex; align-items: center; gap: 6px; padding: 5px 7px; border-radius: var(--ax-radius-sm); color: var(--ax-text-2); font-size: 13px; text-decoration: none; }
.hf__item:hover, .hf__item.is-on { background: var(--ax-surface-3); color: var(--ax-text); }
.hf__item svg { width: 15px; height: 15px; }
.hf__set { margin-left: auto; }
.hf__n { min-width: 16px; padding: 0 4px; line-height: 16px; border-radius: var(--ax-radius-pill); background: var(--ax-amber, #f5a524); color: #111; font-size: 10.5px; font-weight: 700; text-align: center; }
/* The ⌘K switcher (V3). */
.hk { position: fixed; inset: 0; z-index: 40; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; }
.hk__scrim { position: absolute; inset: 0; border: 0; padding: 0; background: rgb(5 8 14 / 55%); backdrop-filter: blur(3px); cursor: default; }
.hk__box { position: relative; width: min(640px, calc(100vw - 24px)); max-height: 72vh; display: flex; flex-direction: column; background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: 14px; box-shadow: 0 24px 64px rgb(0 0 0 / 40%); overflow: hidden; }
.hk__q { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.hk__q svg { width: 16px; height: 16px; color: var(--ax-muted); }
.hk__q input { flex: 1; border: 0; outline: 0; background: none; color: var(--ax-text); font: inherit; font-size: 15px; }
.hk__list { overflow-y: auto; padding: 4px 8px 8px; }
.hk__h { margin: 10px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ax-muted); }
.hk__hit { align-items: center; }
.hk__hit.is-sel, .hk__hit:hover { background: var(--ax-accent-t, var(--ax-surface-3)); }
.hk__kbd { margin-left: 6px; font: 500 11px/1 var(--ax-font-mono, ui-monospace, monospace); padding: 3px 5px; border: 1px solid var(--ax-border-2); border-radius: 4px; color: var(--ax-muted); }
.hk__ico { width: 28px; text-align: center; color: var(--ax-muted); font-size: 16px; }
.hk__foot { display: flex; gap: 18px; margin: 0; padding: 8px 16px; border-top: 1px solid var(--ax-border); font-size: 12px; color: var(--ax-muted); }
/* The Mobile app page. */
.hm { max-width: 640px; padding: 8px 24px 40px; }
.hm__hero { padding: 20px 22px; margin: 8px 0 20px; border-radius: 14px; background: linear-gradient(135deg, var(--ax-accent-t, rgb(41 121 255 / 12%)), transparent 70%); border: 1px solid var(--ax-border); }
.hm h2 { margin: 0 0 8px; font: 600 24px/1.2 var(--ax-font-head, inherit); }
.hm h3 { margin: 18px 0 8px; font-size: 16px; }
.hm__lede { margin: 0 0 12px; color: var(--ax-text-2); font-size: 15px; }
.hm__why { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; color: var(--ax-text-2); }
.hm__why b { color: var(--ax-text); }
.hm__steps { padding-left: 20px; display: grid; gap: 10px; font-size: 14px; }
.hm pre { margin: 6px 0 0; padding: 8px 10px; overflow-x: auto; border-radius: var(--ax-radius-sm); background: var(--ax-surface); border: 1px solid var(--ax-border); font-size: 12.5px; }
.hm__note { font-size: 13px; color: var(--ax-muted); }
.hm__links { display: flex; flex-wrap: wrap; gap: 8px; }
/* Under 1180 px the nav is icons only: the switcher is its magnifier and
   the foot row a column of icons (#2101 R22: they are the side menu now). */
@media (max-width: 1180px) {
  .ax-wall__nav > .ha__k { width: 40px; height: 40px; padding: 0; justify-content: center; }
  .ax-wall__nav > .ha__k span, .ax-wall__nav > .ha__k kbd, .hf__item span { display: none; }
  .ax-wall__nav > .hf { flex-direction: column; flex-wrap: nowrap; gap: 4px; padding: 10px 0 2px; }
  .hf__item { position: relative; padding: 8px; }
  .hf__item svg { width: 18px; height: 18px; }
  .hf__set { margin-left: 0; }
  .hf__n { position: absolute; top: 0; right: -4px; }
  .hm { padding: 8px 16px 32px; }
}
/* Phone: the bottom bar and More sheet take over. */
@media (max-width: 640px) {
  .ax-wall__nav > .ha__k, .ax-wall__nav > .hf { display: none; }
}
`
