// --- affectUI treatments: the one style source (#2152) ---
//
// The free (MIT) affectUI items, adapted to the AgentX tokens: a card with a
// count-led heading (Decision Inbox), one folded row with an icon + label
// state (Tool Call Card), the eight-ray loader (Thinking Loader), a count,
// a skeleton and an empty state with its action. Source and licence:
// ./LICENSE.affectui (affectUI, MIT, pinned commit 8b396302).
//
// Every surface loads this block once next to AX_TOKENS_CSS: the Hub
// (wall-space.ts), the dashboard pages (shell.ts), the phone app (app.ts).
// The React shell (src/hub) and the conversation island draw inside the Hub
// document and use the same classes; no page keeps its own copy
// (test/affect-style.test.ts).
//
// Colour is for state only (orca-design C6): running = accent, done = ok,
// waiting = warn, failed = err; everything else is grey on hairlines.

export const AX_AFFECT_CSS = `
/* --- affect: card (Decision Inbox) --- */
.ax-af-card { border: var(--ax-border-w, 1px) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); min-width: 0; }
.ax-af-card__head { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 12px; border-bottom: var(--ax-border-w, 1px) solid var(--ax-border); font-size: var(--ax-fs-sm); color: var(--ax-text); }
.ax-af-card__head:last-child { border-bottom: 0; }
.ax-af-card__title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ax-af-card__head > :last-child:not(:first-child) { margin-left: auto; }

/* --- affect: count --- */
.ax-af-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-text-2); font: 600 11px/1 var(--ax-mono); font-variant-numeric: tabular-nums; flex: none; align-self: center; }
.ax-af-count[data-tone="warn"] { background: color-mix(in oklch, var(--ax-warn) 16%, transparent); color: var(--ax-text); }
.ax-af-count:empty, .ax-af-count[data-n="0"] { display: none; }

/* --- affect: row (Tool Call Card, folded) --- */
.ax-af-row { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 32px; padding: 4px 12px; border-bottom: var(--ax-border-w, 1px) solid var(--ax-border); font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.ax-af-row:last-child { border-bottom: 0; }
.ax-af-row__name { font-weight: 600; color: var(--ax-text); flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ax-af-row__meta { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ax-af-row > .ax-af-state { margin-left: auto; }

/* --- affect: state (dot + label) --- */
.ax-af-state { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: var(--ax-fs-xs); color: var(--ax-muted); white-space: nowrap; }
.ax-af-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ax-border-2); flex: none; }
.ax-af-state[data-state="running"]::before { background: var(--ax-accent); animation: ax-af-pulse 1.2s ease-in-out infinite; }
.ax-af-state[data-state="done"] { color: var(--ax-ok); } .ax-af-state[data-state="done"]::before { background: var(--ax-ok); }
.ax-af-state[data-state="waiting"]::before { background: var(--ax-warn); }
.ax-af-state[data-state="error"] { color: var(--ax-err); } .ax-af-state[data-state="error"]::before { background: var(--ax-err); }
@keyframes ax-af-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* --- affect: loader (Thinking Loader, eight rays) --- */
.ax-af-loader { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 3px 8px; border: var(--ax-border-w, 1px) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.ax-af-loader__rays { position: relative; width: 16px; height: 16px; flex: none; }
.ax-af-loader__rays > span { position: absolute; top: 1px; left: 7px; width: 2px; height: 4px; border-radius: 2px; background: var(--ax-accent); transform-origin: 1px 7px; animation: ax-af-ray .8s linear infinite; }
@keyframes ax-af-ray { from { opacity: 1; } to { opacity: .2; } }

/* --- affect: skeleton (shaped like the rows it stands for) --- */
.ax-af-skeleton { display: block; height: 12px; margin: 10px 12px; border-radius: var(--ax-radius-sm, 4px); background: linear-gradient(90deg, var(--ax-surface-2) 25%, var(--ax-surface-3, var(--ax-surface-2)) 50%, var(--ax-surface-2) 75%); background-size: 200% 100%; animation: ax-af-shimmer 1.4s ease-in-out infinite; }
.ax-af-skeleton:nth-child(3n+2) { width: 70%; } .ax-af-skeleton:nth-child(3n) { width: 45%; }
@keyframes ax-af-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* --- affect: empty state (always with an action) --- */
.ax-af-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 16px 12px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.ax-af-empty > strong { color: var(--ax-text); font-weight: 600; }

@media (prefers-reduced-motion: reduce) {
  .ax-af-state[data-state="running"]::before, .ax-af-loader__rays > span, .ax-af-skeleton { animation: none; }
}
`

/** The loader's markup, for the server-rendered pages (the React twin is
 *  src/hub/ui/affect.tsx). `label` is plain text, escaped here. */
export function afLoaderHtml(label: string): string {
  const esc = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  let rays = ""
  for (let i = 0; i < 8; i++) rays += `<span style="rotate:${i * 45}deg;animation-delay:${((i - 8) * 0.1).toFixed(1)}s"></span>`
  return `<span class="ax-af-loader" role="status"><span class="ax-af-loader__rays" aria-hidden="true">${rays}</span>${esc}</span>`
}
