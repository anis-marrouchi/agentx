// --- Wall space (#1242) ---
//
// The Wall (Hub) is its own space, the way the wiki is: its own document and
// layout, no dashboard top bar. The layout follows the mockup the owner
// approved (take B): a left nav, one feed column, a side column.
//
// Its colours, type, borders and radius come from the one shared style set,
// AX_TOKENS_CSS in ../tokens.ts, like every dashboard page and the phone app
// (#2101, Orca look). This file defines no --ax-* values of its own.

import { AX_THEME_BOOT, AX_TOKENS_CSS } from "../tokens"
import { AX_AFFECT_CSS } from "../affect.css"

/** Theme: the shared key; the boot in tokens.ts moves an old Hub choice. */
const WALL_THEME_KEY = "ax-theme"

export const WALL_SPACE_HEAD = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/assets/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
${AX_THEME_BOOT}`

export const WALL_SPACE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); }
body { font: var(--ax-fs)/1.4 var(--ax-font); -webkit-font-smoothing: antialiased; }
a { color: var(--ax-accent); font-weight: inherit; }
a:hover { text-decoration: none; }
button, input, select { font-family: inherit; }

/* The few shared components the Wall's script draws, in this space's look. */
.ax-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-weight: 600; font-size: var(--ax-fs-sm);
  background: var(--ax-primary); color: var(--ax-primary-fg); border: 1px solid transparent; border-radius: var(--ax-radius-sm); padding: 6px 14px; cursor: pointer; text-decoration: none; }
.ax-btn--ghost { background: none; color: var(--ax-text); border-color: var(--ax-border-2); }
.ax-btn--ghost:hover { background: var(--ax-surface); }
.ax-badge { display: inline-block; font-size: 12px; line-height: 1.5; border-radius: var(--ax-radius-pill); padding: 0 9px; background: var(--ax-blue-t); color: var(--ax-accent); white-space: nowrap; }
.ax-badge--live { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green-d); }
.ax-badge--warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.ax-badge--err { background: var(--ax-red-t); color: var(--ax-red-ink); }

/* Two columns, like Orca (#2101 R24): the side menu and the page, which
   takes the full width. No page has a side summary column any more: what
   one said that the page did not is a line under its header. Only the
   contextual panel with tabs (wall-context.client.ts) adds a column, when
   something is selected. */
.ax-wall { display: grid; grid-template-columns: var(--axp-nav-w, 280px) minmax(0, 1fr); align-items: start; min-height: 100vh; }
.ax-wall__nav { grid-column: 1; grid-row: 1 / span 4; position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
.ax-wall__logo { font-weight: 600; font-size: 16px; letter-spacing: -.01em; padding: 8px 10px 14px; color: var(--ax-text); text-decoration: none; }
.ax-wall__logo small { font-weight: 400; color: var(--ax-muted); font-size: 13px; margin-left: 4px; }
.ax-wall__item { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-radius: var(--ax-radius-sm); color: var(--ax-text-2); font: inherit; font-size: 14px; text-decoration: none; background: none; border: 0; cursor: pointer; text-align: left; width: max-content; max-width: 100%; }
.ax-wall__item:hover { background: var(--ax-surface-3); color: var(--ax-text); }
.ax-wall__item.is-on { font-weight: 500; color: var(--ax-text); background: var(--ax-surface-3); box-shadow: inset 2px 0 0 var(--ax-accent); }
.ax-wall__item.is-on svg { color: var(--ax-accent); }
.ax-wall__item svg { width: 18px; height: 18px; flex: none; }
/* The nav's groups (#1451 frame 0): Work, Automation, Fleet, Owner. */
.ax-wall__navgroup summary { cursor: pointer; padding: 8px 10px; color: var(--ax-text-2); font-size: 13px; border-radius: var(--ax-radius-sm); }
.ax-wall__navgroup summary:hover, .ax-wall__navgroup summary:focus-visible { background: var(--ax-surface-2); }
.ax-wall__navgroup > .ax-wall__item { display: flex; margin-left: 10px; }
.ax-wall__nav > .ax-wall__shortcut { display: none; }
.ax-wall__navlbl { font-size: 11px; font-weight: 500; color: var(--ax-muted); text-transform: none; letter-spacing: 0; padding: 14px 10px 4px; margin: 0; }
.ax-wall__item span { white-space: nowrap; }
/* Wide nav: each row fills the column, so the open page's band is one width (#2101). */
@media (min-width: 1181px) { .ax-wall__item { width: auto; } }
/* More is the phone bar's fifth button. */
.ax-wall__morebtn { display: none; }
/* Counts next to the nav items (#1316); a badge on the icon when the nav is narrow. */
.ax-wall__item { position: relative; }
.ax-wall__n { font-size: var(--ax-fs-xs); font-weight: 700; min-width: 20px; padding: 0 6px; line-height: 20px; text-align: center; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.ax-wall__n:empty { display: none; }
.ax-wall__item.is-on .ax-wall__n { background: var(--ax-accent); color: var(--ax-on-accent); }
.ax-wall__main { grid-column: 2; grid-row: 1 / span 4; min-width: 0; min-height: 100vh; border-left: 1px solid var(--ax-border); border-right: 1px solid var(--ax-border); }
/* The page's own reading width inside the full-width middle (#2101 R24). */
.ax-wall__main > :is(.ax-wall__compose, .ax-wall__feed, .ax-wall__post, .ax-wall__profile, .ax-wall__goal) { max-width: 760px; margin-left: auto; margin-right: auto; }
.ax-wall__box { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 12px 16px; margin-bottom: 16px; min-width: 0; }
.ax-wall__box h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; color: var(--ax-text); }

/* The phone's More sheet (#1451 frame 0); only the phone bar opens it. */
.ax-wall__more { display: none; position: fixed; inset: 0 0 56px; z-index: 11; }
.ax-wall__morescrim { position: absolute; inset: 0; width: 100%; border: 0; padding: 0; background: rgb(15 20 25 / 40%); cursor: pointer; }
.ax-wall__moresheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: calc(100% - 24px); overflow-y: auto; background: var(--ax-bg); border-radius: var(--ax-radius-lg) var(--ax-radius-lg) 0 0; padding: 8px 16px 12px; box-shadow: 0 -6px 24px rgb(0 0 0 / 22%); display: flex; flex-direction: column; gap: 2px; }
.ax-wall__grab { width: 36px; height: 4px; border-radius: var(--ax-radius-pill); background: var(--ax-border-2); align-self: center; margin-bottom: 4px; }
.ax-wall__moresheet .ax-wall__navlbl { padding-left: 0; }
.ax-wall__moregrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 8px; }
.ax-wall__moreitem { display: flex; gap: 8px; align-items: center; min-height: 44px; padding: 0 12px; border-radius: var(--ax-radius-pill); color: var(--ax-text); text-decoration: none; font-size: 16px; }
.ax-wall__moreitem:hover, .ax-wall__moreitem:focus-visible { background: var(--ax-surface); }
.ax-wall__moreitem.is-on { font-weight: 700; }
.ax-wall__moren { font-size: var(--ax-fs-xs); font-weight: 700; min-width: 20px; padding: 0 6px; line-height: 20px; text-align: center; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.ax-wall__morefoot { display: flex; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--ax-border); padding-top: 10px; margin-top: 6px; }
.ax-wall__morefoot .ax-btn { font-size: var(--ax-fs-xs); padding: 6px 12px; min-height: 36px; }

/* Under 1180 px: an icon nav (the switcher and Desk · Jobs · Workflows ·
   Mobile app · Settings as icons, hub-nav.ts) and the page; no side column. */
@media (max-width: 1180px) {
  .ax-wall { grid-template-columns: 72px minmax(0, 1fr); }
  .ax-wall__nav { padding: 12px 8px; align-items: center; }
  .ax-wall__logo small, .ax-wall__nav > .ax-wall__item span, .ax-wall__nav > .lt { display: none; }
  .ax-wall__n { position: absolute; top: 4px; right: 0; min-width: 18px; line-height: 18px; padding: 0 4px; font-size: 11px; }
  .ax-wall__n.is-zero { display: none; }
  .ax-wall__logo { padding: 8px 0 16px; }
}
/* Phone: the nav becomes a bar at the bottom, as on X. */
@media (max-width: 640px) {
  body { padding-bottom: 60px; }
  .ax-wall, .ax-wall.is-wide, .ax-wall.is-settings { grid-template-columns: minmax(0, 1fr); }
  .ax-wall__nav { position: fixed; top: auto; bottom: 0; left: 0; right: 0; height: 56px; z-index: 10; flex-direction: row; justify-content: space-around; padding: 0 4px;
    background: color-mix(in srgb, var(--ax-bg) 92%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-top: 1px solid var(--ax-border); overflow: visible; }
  /* Wall, Needs you, Running now, Projects and More (#1355); More opens
     a sheet with the rest, in the nav's groups (#1451 frame 0). */
  .ax-wall__morebtn, .ax-wall__nav > .ax-wall__shortcut { display: flex; }
  .ax-wall__navgroup { display: none; }
  .ax-wall__nav > .ax-wall__item:not([data-bar]):not(.ax-wall__morebtn), .ax-wall__nav > .ax-wall__navlbl { display: none; }
  .ax-wall__morebtn[aria-expanded="true"] svg { color: var(--ax-accent); }
  .ax-wall__more:not([hidden]) { display: block; }
  .ax-wall__logo { display: none; }
  /* Each bar button says what it is under its icon (#2101 P2), as the
     phone app's tabs do: 11 px words, the count on the icon. */
  .ax-wall__nav > .ax-wall__item { padding: 6px 4px 4px; flex: 1 1 0; min-width: 0; flex-direction: column; justify-content: center; align-items: center; gap: 2px; }
  .ax-wall__nav > .ax-wall__item[data-bar] span, .ax-wall__nav > .ax-wall__morebtn span { display: block; font-size: 11px; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .ax-wall__nav > .ax-wall__item.is-on { box-shadow: none; background: none; color: var(--ax-accent); }
  .ax-wall__nav > .ax-wall__item .ax-wall__n { right: calc(50% - 22px); top: 0; }
  .ax-wall__main { grid-column: 1; }
  /* The page only; the bar's buttons reach the rest. */
  .ax-wall__main { grid-row: 1; border-left: 0; border-right: 0; border-top: 0; margin-top: 0; }
}
`

/** Theme toggle. Display only; the nav opens pages (#1316, wall.client.ts). */
export const WALL_SPACE_SCRIPT = `
(function () {
  // The nav's button and the phone's More sheet both switch it (#1451).
  document.querySelectorAll('[data-wall-theme]').forEach(function (t) {
    t.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('${WALL_THEME_KEY}', next); } catch (e) {}
    });
  });
})();
`

export interface WallDocumentOpts {
  title: string
  body: string
  css: string
  scripts: string
  /** More tags for <head>, after the page's styles (the React Hub, #2218). */
  head?: string
}

/** A whole HTML document for the Wall space, outside the dashboard shell. */
export function renderWallDocument(opts: WallDocumentOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${opts.title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</title>
${WALL_SPACE_HEAD}
<style>${AX_TOKENS_CSS}\n${AX_AFFECT_CSS}\n${WALL_SPACE_CSS}\n${opts.css}</style>
${opts.head ?? ""}
</head>
<body>
${opts.body}
${opts.scripts}
<script>${WALL_SPACE_SCRIPT}</script>
</body>
</html>`
}
