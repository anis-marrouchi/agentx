// --- Phone app: Desk styles (app-desk.client.ts) ---
//
// Cards, pills and buttons are the Fleet and Activity ones (app-fleet.css.ts);
// only the column switch and the answer buttons are new.

export const APP_DESK_CSS = `
.dk-figures { margin: 0 0 4px; line-height: 1.5; }
.dk-cols {
  position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
  padding: 8px 0; margin: 0 0 8px; background: var(--ax-bg);
}
.dk-col {
  min-width: 0; min-height: 52px; padding: 4px 2px; font: inherit; font-size: var(--ax-fs-xs); font-weight: 600; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm);
  background: var(--ax-surface); color: var(--ax-text-2);
}
.dk-col[aria-pressed=true] { background: var(--ax-accent-t); border-color: var(--ax-accent); color: var(--ax-accent); }
.dk-answers { display: grid; gap: 8px; margin-top: 12px; }
.dk-opt { width: 100%; min-height: 48px; padding: 8px 14px; text-align: left; border-radius: var(--ax-radius-sm); overflow-wrap: anywhere; }
.dk-opt small { display: block; margin-top: 2px; font-weight: 400; color: var(--ax-text-2); }
.dk-opt em { font-style: normal; font-weight: 400; color: var(--ax-text-2); }
/* Go through them (#2499 part 2, app-desk-wizard.client.ts). */
.dk-wiz-head { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
.dk-wiz-head strong { flex: 1; }
.dk-wiz-back { min-width: 44px; min-height: 44px; padding: 0; display: inline-grid; place-items: center; }
.dk-wiz-back svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.dk-ghost { background: transparent; border-color: transparent; color: var(--ax-text-2); }
.dk-wiz h5 { margin: 14px 0 4px; font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-text-2); }
.dk-wiz-list { margin: 8px 0; padding-left: 18px; line-height: 1.5; overflow-wrap: anywhere; }
.dk-wiz-confirm { margin-top: 12px; padding-top: 12px; border-top: var(--ax-border-w) solid var(--ax-border); }
.dk-wiz-confirm p { margin: 0 0 4px; }
.dk-wiz-in { animation: dk-wiz-in 200ms cubic-bezier(0.23, 1, 0.32, 1); }
@keyframes dk-wiz-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .dk-wiz-in { animation: none; } }
/* The card a notification opened (#2103). */
.dk-wanted { outline: 2px solid var(--ax-accent, #2f6fed); outline-offset: 2px; }
`
