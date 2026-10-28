// --- Wall space (#1242) ---
//
// The Wall is its own space, the way the wiki is: its own document, its own
// look, no dashboard top bar. The look follows the mockup the owner approved
// (take B, X-like): a left nav, one feed column, a side column, a system
// font, a white or black page and a blue accent.
//
// The Wall's page CSS and script were written against the dashboard's
// --ax-* tokens. They keep working because this space defines the same
// token names with its own values; the dashboard's tokens, components and
// top bar are not loaded here.

/** Theme: the Wall keeps its own choice; with none, it follows the system. */
const WALL_THEME_KEY = "ax-wall-theme"

export const WALL_SPACE_HEAD = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script>(function(){var t=null;try{t=localStorage.getItem('${WALL_THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})();</script>`

export const WALL_SPACE_CSS = `
:root { color-scheme: light;
  --ax-bg: #fff; --ax-bg-elev: #fff; --ax-surface: #f7f9f9; --ax-surface-2: #eff3f4;
  --ax-border: #eff3f4; --ax-border-2: #cfd9de;
  --ax-text: #0f1419; --ax-text-2: #0f1419; --ax-muted: #536471;
  --ax-accent: #1d9bf0; --ax-accent-ink: #fff; --ax-blue-t: #e8f5fd;
  --ax-green: #00ba7c; --ax-green-d: #00875a;
  --ax-amber: #f59e0b; --ax-amber-ink: #a15c00; --ax-amber-t: #fdf1dc; --ax-warn: #a15c00;
  --ax-red: #f4212e; --ax-red-ink: #d0141f; --ax-red-t: #fde6e8; --ax-err: #d0141f;
  --ax-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --ax-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ax-fs: 15px; --ax-fs-sm: 14px; --ax-fs-xs: 13px;
  --ax-radius-sm: 4px; --ax-radius: 8px; --ax-radius-lg: 16px; --ax-radius-pill: 9999px; }
[data-theme="dark"] { color-scheme: dark;
  --ax-bg: #000; --ax-bg-elev: #000; --ax-surface: #16181c; --ax-surface-2: #202327;
  --ax-border: #2f3336; --ax-border-2: #536471;
  --ax-text: #e7e9ea; --ax-text-2: #d6d9db; --ax-muted: #71767b; --ax-blue-t: #0b2a3f;
  --ax-green-d: #00ba7c;
  --ax-amber-ink: #fbbf24; --ax-amber-t: #3a2a06; --ax-warn: #fbbf24;
  --ax-red-ink: #ff6b74; --ax-red-t: #3a0d11; --ax-err: #ff6b74; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); }
body { font: var(--ax-fs)/1.4 var(--ax-font); -webkit-font-smoothing: antialiased; }
a { color: var(--ax-accent); }
button, input, select { font-family: inherit; }

/* The few shared components the Wall's script draws, in this space's look. */
.ax-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-weight: 700; font-size: var(--ax-fs-sm);
  background: var(--ax-text); color: var(--ax-bg); border: 1px solid transparent; border-radius: var(--ax-radius-pill); padding: 6px 16px; cursor: pointer; text-decoration: none; }
.ax-btn--ghost { background: none; color: var(--ax-text); border-color: var(--ax-border-2); }
.ax-btn--ghost:hover { background: var(--ax-surface); }
.ax-badge { display: inline-block; font-size: 12px; line-height: 1.5; border-radius: var(--ax-radius-pill); padding: 0 9px; background: var(--ax-blue-t); color: var(--ax-accent); white-space: nowrap; }
.ax-badge--live { background: color-mix(in srgb, var(--ax-green) 15%, transparent); color: var(--ax-green-d); }
.ax-badge--warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.ax-badge--err { background: var(--ax-red-t); color: var(--ax-red-ink); }

/* Three columns: nav, feed, side. */
.ax-wall { display: grid; grid-template-columns: 240px minmax(0, 600px) 350px; justify-content: center; align-items: start; min-height: 100vh; }
.ax-wall.is-wide { grid-template-columns: 240px minmax(0, 1fr) 300px; }
/* Settings (#1428) has its section list inside the middle column: wider. */
.ax-wall.is-settings { grid-template-columns: 240px minmax(0, 860px) 300px; }
.ax-wall__nav { grid-column: 1; grid-row: 1 / span 4; position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
.ax-wall__logo { font-weight: 800; font-size: 22px; padding: 8px 12px 16px; color: var(--ax-text); text-decoration: none; }
.ax-wall__logo small { font-weight: 400; color: var(--ax-muted); font-size: 13px; margin-left: 4px; }
.ax-wall__item { display: flex; gap: 14px; align-items: center; padding: 9px 12px; border-radius: var(--ax-radius-pill); color: var(--ax-text); font: inherit; font-size: 17px; text-decoration: none; background: none; border: 0; cursor: pointer; text-align: left; width: max-content; max-width: 100%; }
.ax-wall__item:hover { background: var(--ax-surface); }
.ax-wall__item.is-on { font-weight: 700; }
.ax-wall__item svg { width: 24px; height: 24px; flex: none; }
/* The nav's groups (#1451 frame 0): Work, Automation, Fleet, Owner. */
.ax-wall__navlbl { font-size: 12px; font-weight: 700; color: var(--ax-muted); text-transform: uppercase; letter-spacing: .04em; padding: 14px 12px 4px; margin: 0; }
.ax-wall__item span { white-space: nowrap; }
/* New post opens the Creator (#1355); More is the phone bar's fifth button. */
.ax-wall__morebtn { display: none; }
.ax-wall__newpost { justify-content: center; margin: 12px 0 0; padding: 11px; font-size: 16px; width: 100%; }
/* Counts next to the nav items (#1316); a badge on the icon when the nav is narrow. */
.ax-wall__item { position: relative; }
.ax-wall__n { font-size: var(--ax-fs-xs); font-weight: 700; min-width: 20px; padding: 0 6px; line-height: 20px; text-align: center; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.ax-wall__n:empty { display: none; }
.ax-wall__item.is-on .ax-wall__n { background: var(--ax-accent); color: var(--ax-accent-ink, #fff); }
.ax-wall__navfoot { margin-top: 16px; padding: 12px; font-size: var(--ax-fs-xs); color: var(--ax-muted); border: 1px solid var(--ax-border); border-radius: 12px; display: flex; flex-direction: column; gap: 8px; }
.ax-wall__navfoot .ax-btn { align-self: flex-start; font-size: var(--ax-fs-xs); padding: 3px 12px; }
.ax-wall__main { grid-column: 2; grid-row: 1 / span 4; min-width: 0; min-height: 100vh; border-left: 1px solid var(--ax-border); border-right: 1px solid var(--ax-border); }
.ax-wall__aside { grid-column: 3; grid-row: 1 / span 4; padding: 12px 0 12px 24px; min-width: 0; }
.ax-wall__box { background: var(--ax-surface); border-radius: var(--ax-radius-lg); padding: 12px 16px; margin-bottom: 16px; min-width: 0; }
.ax-wall__box h2 { font-size: 20px; font-weight: 800; margin: 0 0 8px; color: var(--ax-text); }
.ax-wall__about p { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.ax-wall__classic { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.ax-wall__classic a { font-size: var(--ax-fs-xs); padding: 3px 10px; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); color: var(--ax-text); text-decoration: none; background: var(--ax-bg); }
.ax-wall__classic a:hover { border-color: var(--ax-accent); color: var(--ax-accent); }

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

/* Under 1180 px: an icon nav and one column; the dashboard links and
   Running now stay above the feed, the agents below it. */
@media (max-width: 1180px) {
  .ax-wall, .ax-wall.is-wide { grid-template-columns: 72px minmax(0, 600px); }
  .ax-wall.is-settings { grid-template-columns: 72px minmax(0, 1fr); }
  .ax-wall.is-settings .ax-wall__aside { display: none; }
  .ax-wall__nav { padding: 12px 8px; align-items: center; }
  .ax-wall__logo small, .ax-wall__item span, .ax-wall__navfoot { display: none; }
  .ax-wall__nav > .ax-wall__navlbl { font-size: 0; padding: 0; height: 1px; width: 32px; background: var(--ax-border-2); margin: 8px 0; }
  .ax-wall__newpost { width: 48px; height: 48px; padding: 0; font-size: 0; }
  .ax-wall__newpost::before { content: "+"; font-size: 26px; font-weight: 400; }
  .ax-wall__n { position: absolute; top: 4px; right: 0; min-width: 18px; line-height: 18px; padding: 0 4px; font-size: 11px; }
  .ax-wall__n.is-zero { display: none; }
  .ax-wall__logo { padding: 8px 0 16px; }
  .ax-wall__aside { display: contents; }
  .ax-wall__aside > * { grid-column: 2; margin: 12px 16px 0; }
  .ax-wall__about { grid-row: 1; }
  .ax-wall__nodes { grid-row: 2; }
  .ax-wall__main { grid-row: 3; min-height: 0; border-top: 1px solid var(--ax-border); margin-top: 12px; }
  .ax-wall__agents { grid-row: 4; margin-bottom: 16px; }
}
/* Phone: the nav becomes a bar at the bottom, as on X. */
@media (max-width: 640px) {
  body { padding-bottom: 60px; }
  .ax-wall, .ax-wall.is-wide, .ax-wall.is-settings { grid-template-columns: minmax(0, 1fr); }
  .ax-wall__nav { position: fixed; top: auto; bottom: 0; left: 0; right: 0; height: 56px; z-index: 10; flex-direction: row; justify-content: space-around; padding: 0 4px;
    background: color-mix(in srgb, var(--ax-bg) 92%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-top: 1px solid var(--ax-border); overflow: visible; }
  /* Wall, Needs you, Running now, Projects and More (#1355); More opens
     a sheet with the rest, in the nav's groups (#1451 frame 0). New post
     is a round + over the feed. */
  .ax-wall__morebtn { display: flex; }
  .ax-wall__nav > .ax-wall__item:not([data-bar]):not(.ax-wall__morebtn), .ax-wall__nav > .ax-wall__navlbl, .ax-wall__navfoot { display: none; }
  .ax-wall__morebtn[aria-expanded="true"] svg { color: var(--ax-accent); }
  .ax-wall__more:not([hidden]) { display: block; }
  .ax-wall__newpost { position: fixed; right: 16px; bottom: 72px; width: 56px; height: 56px; margin: 0; border-radius: 50%; box-shadow: 0 2px 8px rgb(0 0 0 / 25%); }
  .ax-wall__logo { display: none; }
  .ax-wall__item { padding: 10px; }
  .ax-wall__aside > *, .ax-wall__main { grid-column: 1; }
  .ax-wall__aside > * { margin: 10px 12px 0; padding: 10px 12px; }
  /* The feed first, as in the mockup; the bar's buttons reach the rest. */
  .ax-wall__main { grid-row: 1; border-left: 0; border-right: 0; border-top: 0; margin-top: 0; }
  .ax-wall__nodes { grid-row: 2; }
  .ax-wall__agents { grid-row: 3; margin-bottom: 0; }
  .ax-wall__about { grid-row: 4; margin-bottom: 12px; }
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
<style>${WALL_SPACE_CSS}\n${opts.css}</style>
</head>
<body>
${opts.body}
${opts.scripts}
<script>${WALL_SPACE_SCRIPT}</script>
</body>
</html>`
}
