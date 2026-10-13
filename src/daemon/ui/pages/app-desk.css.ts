// --- Phone app: Desk styles (app-desk.client.ts) ---
//
// Built on the shared tokens and the Fleet tab's cards, buttons and sheet;
// every colour flips with the theme.

export const APP_DESK_CSS = `
.dk-figs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 4px 0 8px; }
.dk-fig { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--ax-radius); background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border); min-width: 0; }
.dk-n { font-size: 22px; font-weight: 700; line-height: 1.1; }
.dk-l, .dk-o { font-size: var(--ax-fs-xs); color: var(--ax-text-2); overflow-wrap: anywhere; }
.dk-blockers { margin: 0 0 10px; line-height: 1.45; overflow-wrap: anywhere; }
.dk-view { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.dk-view select { min-height: 44px; flex: 1; font: inherit; font-size: 16px; padding: 0 10px; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface); color: var(--ax-text); }
.dk-cols { position: sticky; top: -16px; z-index: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin: 0 -4px 12px; padding: 8px 4px; background: var(--ax-bg); }
@media (min-width: 560px) { .dk-cols { grid-template-columns: repeat(4, 1fr); } }
.dk-cols [role=tab] { min-width: 0; min-height: 44px; padding: 0 14px; border-radius: var(--ax-radius-pill); border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface-2); color: var(--ax-text); font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; cursor: pointer; white-space: nowrap; }
.dk-cols [role=tab][aria-selected=true] { background: var(--ax-accent-t); border-color: var(--ax-accent); color: var(--ax-accent); }
[data-theme="dark"] .dk-cols [role=tab][aria-selected=true] { color: var(--ax-text); }
.dk-count { font-weight: 400; color: var(--ax-text-2); }
.dk-card h4 { min-width: 0; overflow-wrap: anywhere; }
.dk-col-yours { border-left: 4px solid var(--ax-amber-e, var(--ax-border)); }
.dk-col-quiet { border-style: dashed; }
.dk-col-done { opacity: .85; }
.dk-ask { font-weight: 600; }
.dk-plain { background: var(--ax-surface-3); color: var(--ax-text-2); }
.dk-agent { background: var(--ax-accent-t); color: var(--ax-accent); }
.dk-facts { margin-top: 6px; }
.dk-facts summary { min-height: 36px; font-weight: 500; color: var(--ax-text-2); }
.dk-options { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.dk-opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; min-height: 48px; padding: 10px 14px; text-align: left; font: inherit; cursor: pointer;
  border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border));
  background: color-mix(in oklch, var(--ax-accent) 10%, var(--ax-surface)); color: var(--ax-text); }
.dk-opt strong { color: var(--ax-accent); }
.dk-opt span { font-size: var(--ax-fs-sm); color: var(--ax-text-2); overflow-wrap: anywhere; }
.dk-opt.dk-no { border-color: var(--ax-border); background: var(--ax-surface-2); }
.dk-opt.dk-no strong { color: var(--ax-text); }
.dk-meta { margin-top: 10px; }
`
