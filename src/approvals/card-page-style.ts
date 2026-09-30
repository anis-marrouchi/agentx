// --- The look of the Mac card (card-page.ts) ---
//
// The dashboard's own tokens (AX_TOKENS_CSS) and shape language: 2px
// borders, round corners, the hard offset shadow on controls, AgentX blue
// for the one action that matters. Sizes are larger than the dashboard's:
// the card is read at a glance, from across the desk.

export const CARD_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ax-surface); color: var(--ax-text); }
body {
  font: 15px/1.45 var(--ax-font); -webkit-font-smoothing: antialiased;
  -webkit-user-select: none; user-select: none; cursor: default;
}
.card { padding: 28px 20px 14px; display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: center; gap: 10px; -webkit-app-region: drag; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-weight: 700; font-size: 15px;
  background: var(--ax-accent); color: #fff; box-shadow: 0 2px 0 var(--ax-accent-2);
}
.who { display: flex; flex-direction: column; min-width: 0; }
.who b { font-size: 14px; font-weight: 600; }
.who span { font-size: 12.5px; color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind {
  margin-left: auto; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  padding: 4px 10px; border-radius: var(--ax-radius-pill);
  background: var(--ax-accent-t); color: var(--ax-accent-2); border: 1.5px solid var(--ax-blue-e);
}
[data-theme="dark"] .kind { color: var(--ax-blue); }
h1 { margin: 2px 0 0; font-size: 19px; line-height: 1.25; font-weight: 650; letter-spacing: -.01em; }
.context {
  margin: 0; padding: 10px 12px; border-radius: var(--ax-radius-sm);
  background: var(--ax-surface-3); border-left: 4px solid var(--ax-border-2);
  color: var(--ax-text-2); font-size: 14px; white-space: pre-wrap; unicode-bidi: plaintext;
}
.ask { margin: 0; font-size: 16px; font-weight: 550; }
.recommend { margin: -6px 0 0; font-size: 13px; color: var(--ax-text-2); }
.recommend b { color: var(--ax-green-d); font-weight: 600; }
[data-theme="dark"] .recommend b { color: var(--ax-green); }
.options { display: flex; flex-direction: column; gap: 8px; }
.opt {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: start;
  padding: 11px 14px; border-radius: var(--ax-radius-sm); cursor: pointer;
  font: inherit; font-size: 15px; color: var(--ax-text); unicode-bidi: plaintext;
  background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border-2);
  box-shadow: 0 3px 0 var(--ax-border-2); transition: transform .12s, border-color .12s, box-shadow .12s;
}
.opt:hover { border-color: var(--ax-blue-e); }
.opt:active { transform: translateY(2px); box-shadow: 0 1px 0 var(--ax-border-2); }
.opt .n {
  flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  font-size: 12.5px; font-weight: 700; background: var(--ax-surface-3); color: var(--ax-text-2);
}
.opt[aria-checked="true"] {
  border-color: var(--ax-accent); background: var(--ax-accent-t); box-shadow: 0 3px 0 var(--ax-accent-2);
}
.opt[aria-checked="true"] .n { background: var(--ax-accent); color: #fff; }
.label-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: -8px; }
.label { font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ax-text-2); }
.edited { font-size: 12px; color: var(--ax-accent-2); visibility: hidden; }
.edited.on { visibility: visible; }
textarea {
  width: 100%; min-height: 84px; max-height: 240px; resize: none; overflow-y: auto; padding: 11px 13px;
  font: inherit; font-size: 15px; line-height: 1.5; color: var(--ax-text); unicode-bidi: plaintext;
  background: var(--ax-surface-2); border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-sm);
  -webkit-user-select: text; user-select: text; cursor: text;
}
textarea:focus { outline: none; border-color: var(--ax-accent); box-shadow: 0 0 0 4px var(--ax-accent-t); }
.foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1.5px solid var(--ax-border); }
.foot .later { margin-right: auto; }
.note { margin: -4px 0 0; font-size: 12px; color: var(--ax-text-2); text-align: center; }
button.btn {
  font: inherit; font-size: 14px; font-weight: 600; padding: 9px 16px; border-radius: var(--ax-radius-pill);
  cursor: pointer; border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-surface);
  color: var(--ax-text); box-shadow: 0 3px 0 var(--ax-border-2); transition: transform .12s, box-shadow .12s;
}
button.btn:active { transform: translateY(2px); box-shadow: 0 1px 0 var(--ax-border-2); }
button.primary { background: var(--ax-accent); border-color: var(--ax-accent); color: #fff; box-shadow: 0 3px 0 var(--ax-accent-2); }
[data-theme="dark"] button.primary, [data-theme="dark"] .avatar {
  background: var(--ax-blue-d); border-color: var(--ax-blue-d); box-shadow: 0 3px 0 #123f91;
}
button.primary:disabled { opacity: .45; cursor: default; }
button.ghost { border-color: transparent; box-shadow: none; background: transparent; color: var(--ax-text-2); padding: 9px 10px; }
kbd { font: 11px var(--ax-mono); opacity: .7; margin-left: 4px; }
.expires { font-size: 12px; color: var(--ax-text-2); margin-top: -8px; }
`
