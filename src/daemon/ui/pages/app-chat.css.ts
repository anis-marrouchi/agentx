// --- Phone app: Chat tab styles (app-chat.client.ts) ---
//
// Built on the shared tokens; every colour flips with the theme. Buttons
// reuse the Fleet tab's .fx-btn family from app-fleet.css.ts.

export const APP_CHAT_CSS = `
body { height: 100dvh; }
main { min-height: 0; }
#panel-chat:not([hidden]) { display: flex; flex-direction: column; min-height: 100%; }
.cx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.cx { display: flex; flex-direction: column; flex: 1; gap: 10px; }
.cx-top {
  position: sticky; top: -16px; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px;
  margin: -16px 0 0; padding: 16px 0 8px; background: var(--ax-bg);
}
.cx-head { display: flex; gap: 8px; align-items: stretch; }
.cx-head .fx-btn { border-radius: var(--ax-radius); min-height: 48px; }
.cx-pick {
  flex: 1; min-width: 0; min-height: 48px; text-align: left; cursor: pointer;
  display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 12px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius);
  background: var(--ax-surface); color: var(--ax-text); font: inherit;
}
.cx-pick-label { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-pick-sub { font-size: var(--ax-fs-xs); color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-sheet {
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius);
  background: var(--ax-surface); padding: 4px 12px 12px; max-height: 60vh; overflow-y: auto;
}
.cx-sheet h3 { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-sm); margin: 12px 0 6px; }
.cx-sheet ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.cx-sheet li button {
  width: 100%; min-height: 48px; display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 12px; text-align: left; cursor: pointer; font: inherit;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm);
  background: var(--ax-surface-2); color: var(--ax-text);
}
.cx-sheet li button:disabled { opacity: 0.55; cursor: not-allowed; }
.cx-sub { display: block; font-size: var(--ax-fs-xs); color: var(--ax-text-2); font-weight: 400; }
.cx-sheet h3 .cx-sub { display: inline; }
.cx-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ax-muted); flex: none; }
.cx-dot.cx-on { background: var(--ax-green); }
.cx-state { font-size: var(--ax-fs-xs); font-weight: 600; padding: 2px 8px; border-radius: var(--ax-radius-pill); background: var(--ax-surface-3); color: var(--ax-text-2); white-space: nowrap; }
.cx-state.cx-busy { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.cx-log { display: flex; flex-direction: column; gap: 10px; flex: 1; }
.cx-msg { max-width: 92%; padding: 10px 12px; border-radius: var(--ax-radius); line-height: 1.5; overflow-wrap: anywhere; }
.cx-user { align-self: flex-end; background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface)); border: var(--ax-border-w) solid color-mix(in oklch, var(--ax-accent) 45%, var(--ax-border)); white-space: pre-wrap; }
.cx-queued { opacity: 0.7; }
.cx-queued::after { content: "Sent when the agent finishes"; display: block; font-size: var(--ax-fs-xs); color: var(--ax-text-2); margin-top: 4px; }
.cx-agent { align-self: flex-start; background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border); }
.cx-msg .md > :first-child { margin-top: 0; }
.cx-msg .md > :last-child { margin-bottom: 0; }
.cx-msg .md pre { overflow-x: auto; background: var(--ax-surface-3); padding: 8px; border-radius: var(--ax-radius-sm); }
.cx-msg .md table { display: block; overflow-x: auto; border-collapse: collapse; }
.cx-msg .md th, .cx-msg .md td { border: 1px solid var(--ax-border); padding: 4px 8px; }
.cx-msg .md a { color: var(--ax-accent); }
.cx-typing { color: var(--ax-text-2); }
.cx-tools { font-size: var(--ax-fs-xs); color: var(--ax-text-2); margin: 0 0 6px; }
.cx-tools summary { min-height: 32px; font-weight: 600; }
.cx-tools ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.cx-tools li { font-family: var(--ax-mono); background: var(--ax-surface-3); border-radius: var(--ax-radius-pill); padding: 2px 8px; }
.cx-tools li.cx-bad { background: var(--ax-red-t); color: var(--ax-red-ink); }
.cx-note { margin: 6px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.cx-bad { color: var(--ax-red-ink); }
.cx-ui { display: grid; gap: 8px; margin-top: 8px; }
.cx-ui:empty { display: none; }
.cx-ui img, .cx-ui video { max-width: 100%; border-radius: var(--ax-radius-sm); }
.cx-ui audio { width: 100%; }
.cx-ui-row { display: flex; flex-wrap: wrap; gap: 6px; }
.cx-ui-btn {
  display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; cursor: pointer; font: inherit; font-weight: 600;
  border: var(--ax-border-w) solid color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border)); border-radius: var(--ax-radius-pill);
  background: color-mix(in oklch, var(--ax-accent) 12%, var(--ax-surface)); color: var(--ax-accent); text-decoration: none;
}
.cx-ui fieldset { border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius-sm); margin: 0; padding: 8px 10px; display: grid; gap: 8px; }
.cx-ui legend { font-weight: 600; padding: 0 4px; }
.cx-ui label { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.cx-composer { position: sticky; bottom: -16px; z-index: 1; display: flex; gap: 8px; align-items: flex-end; margin: 0 0 -16px; padding: 8px 0 16px; background: var(--ax-bg); }
.cx-composer textarea {
  flex: 1; min-width: 0; min-height: 44px; max-height: 40vh; resize: none; padding: 10px 12px; font: inherit; font-size: 16px; box-sizing: border-box;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); color: var(--ax-text);
}
.cx-send {
  min-width: 72px; min-height: 44px; cursor: pointer; font: inherit; font-weight: 700;
  border: var(--ax-border-w) solid color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border)); border-radius: var(--ax-radius);
  background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface)); color: var(--ax-accent);
}
.cx-composer .fx-btn { border-radius: var(--ax-radius); }
`
