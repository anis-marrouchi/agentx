// --- Phone app: Fleet and Activity styles (app-fleet.client.ts) ---
//
// Built on the shared tokens; every colour flips with the theme.

export const APP_FLEET_CSS = `
.fx-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fx-head h2 { margin: 4px 0 0; }
.fx-sub { font-size: 15px; margin: 18px 0 8px; color: var(--ax-text-2); }
.fx-status { margin: 4px 0 12px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); min-height: 1em; }
.fx-bad { color: var(--ax-red-ink, #b3261e); }
.fx-card {
  background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius); padding: 12px 14px; margin: 0 0 12px;
}
.fx-card h3, .fx-card h4 { margin: 0; font-size: 16px; }
.fx-card p { margin: 6px 0 0; line-height: 1.45; overflow-wrap: anywhere; }
.fx-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fx-gap { justify-content: flex-start; flex-wrap: wrap; margin-top: 10px; }
.fx-muted { color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.fx-pill { font-size: var(--ax-fs-xs); font-weight: 600; padding: 2px 8px; border-radius: var(--ax-radius-pill); white-space: nowrap; }
.fx-on { background: var(--ax-green-e); color: var(--ax-text); }
.fx-off { background: var(--ax-red-t); color: var(--ax-red-ink); }
.fx-warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.fx-btn {
  min-height: 44px; padding: 0 14px; font: inherit; font-size: var(--ax-fs-sm); font-weight: 600;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-pill);
  background: var(--ax-surface-2); color: var(--ax-text); cursor: pointer;
}
/* Same tinted fill as the dashboard's .ax-btn--primary: legible in both themes. */
.fx-primary { background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface)); border-color: color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border)); color: var(--ax-accent); }
.fx-danger { background: color-mix(in oklch, var(--ax-red) 15%, var(--ax-surface)); border-color: color-mix(in oklch, var(--ax-red) 50%, var(--ax-border)); color: var(--ax-red-ink); }
.fx-danger-o { color: var(--ax-red-ink); border-color: var(--ax-red-e, var(--ax-border)); }
details { margin-top: 10px; }
summary { min-height: 44px; display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "›"; display: inline-block; width: 12px; font-size: 20px; line-height: 1; color: var(--ax-text-2); transition: transform .15s; }
details[open] > summary::before { transform: rotate(90deg); }
.fx-list { list-style: none; margin: 0; padding: 0; }
.fx-list li { padding: 10px 0; border-top: var(--ax-border-w) solid var(--ax-border); }
.fx-switch {
  position: relative; width: 52px; min-width: 52px; height: 32px; border-radius: 16px; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface-3); padding: 0;
}
.fx-switch span { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: left .15s; }
.fx-switch[aria-checked=true] { background: var(--ax-accent); border-color: var(--ax-accent); }
.fx-switch[aria-checked=true] span { left: 23px; }
.fx-sheet {
  width: 100%; max-width: 520px; margin: auto auto 0; border: 0; padding: 0;
  border-radius: 16px 16px 0 0; background: var(--ax-surface); color: var(--ax-text);
}
.fx-sheet::backdrop { background: rgba(0,0,0,.45); }
.fx-sheet form { padding: 20px calc(20px + env(safe-area-inset-right)) calc(20px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left)); }
.fx-sheet h3 { margin: 0 0 8px; font-size: 18px; }
.fx-sheet p { margin: 0 0 12px; color: var(--ax-text-2); line-height: 1.45; }
.fx-sheet label span { display: block; font-weight: 600; margin-bottom: 6px; }
.fx-sheet textarea {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 10px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); background: var(--ax-bg); color: var(--ax-text);
}
.fx-error:empty { display: none; }
.fx-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
`
