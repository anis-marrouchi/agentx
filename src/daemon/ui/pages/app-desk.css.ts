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
.dk-col span { display: block; font-size: 16px; color: var(--ax-text); }
.dk-col[aria-pressed=true] { background: var(--ax-accent-t); border-color: var(--ax-accent); color: var(--ax-accent); }
.dk-answers { display: grid; gap: 8px; margin-top: 12px; }
.dk-opt { width: 100%; min-height: 48px; padding: 8px 14px; text-align: left; border-radius: var(--ax-radius-sm); overflow-wrap: anywhere; }
.dk-opt small { display: block; margin-top: 2px; font-weight: 400; color: var(--ax-text-2); }
.dk-opt em { font-style: normal; font-weight: 400; color: var(--ax-text-2); }
`
