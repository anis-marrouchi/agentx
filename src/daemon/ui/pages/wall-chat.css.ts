// --- Hub chat: its styles (#1528; middle pane and transcript, #2101 PR 2) ---

export const WALL_CHAT_CSS = `
/* Hub chat (#1528): the Chat box in the side column; the chat itself is the
   middle pane (#2101 PR 2), in place of the page it was opened from. */
.hcq h2 { display: flex; align-items: center; gap: 8px; }
.hcq h2 svg { width: 20px; height: 20px; }
.hcq h2 kbd { margin-left: auto; font: 600 11px var(--ax-mono); color: var(--ax-muted); border: 1px solid var(--ax-border-2); border-radius: 5px; padding: 1px 6px; }
.hcq form { display: flex; gap: 8px; }
.hcq input { flex: 1; min-width: 0; font: inherit; font-size: 14.5px; padding: 8px 14px; border-radius: var(--ax-radius-pill); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.hcq p { margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); overflow-wrap: anywhere; }
.hcq p a, .hcq p button { font: inherit; font-weight: 600; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: none; }
.hc__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ax-accent); margin-right: 4px; }
.hc-btn { display: none; margin-left: 8px; position: relative; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: var(--ax-text); cursor: pointer; }
.hc-btn:hover { background: var(--ax-surface); }
.hc-btn svg { width: 22px; height: 22px; }
.hc-btn .hc__dot { position: absolute; top: 6px; right: 6px; width: 9px; height: 9px; margin: 0; border: 2px solid var(--ax-bg); }

.hc { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--ax-bg); }
.ax-wall.hc-open .ax-wall__main > :not(#hc) { display: none !important; }
.hc__head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--ax-border); }
.hc__title { flex: 1; min-width: 0; }
.hc__title b { display: block; font-size: 17px; font-weight: 800; }
.hc__title small { display: block; color: var(--ax-muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc__ib { font: inherit; font-size: 12.5px; font-weight: 700; color: var(--ax-text); background: none; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 3px 10px; cursor: pointer; }
.hc__ib[aria-expanded="true"] { background: var(--ax-blue-t); }
.hc__x, .hc__back { font: inherit; font-size: 22px; line-height: 1; background: none; border: 0; color: var(--ax-muted); padding: 0 2px 2px; cursor: pointer; }
.hc__back { display: none; color: var(--ax-text); }
.hc__hist { border-bottom: 1px solid var(--ax-border); max-height: 40vh; overflow-y: auto; }
.hc__histe { margin: 0; padding: 10px 14px; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.hc__histe--err { color: var(--ax-red-ink); }
.hc__hist ul { list-style: none; margin: 0; padding: 0; }
.hc__hist li { display: flex; align-items: center; border-top: 1px solid var(--ax-border); }
.hc__hist li.is-on { background: var(--ax-blue-t); }
.hc__histt { flex: 1; min-width: 0; text-align: left; font: inherit; font-size: var(--ax-fs-sm); color: var(--ax-text); background: none; border: 0; padding: 8px 14px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc__histt small { margin-left: 6px; color: var(--ax-muted); }
.hc__histx { font: inherit; font-size: 16px; background: none; border: 0; color: var(--ax-muted); padding: 0 12px; cursor: pointer; }
.hc__to { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--ax-border); font-size: 13px; color: var(--ax-muted); }
.hc__to select { min-width: 0; font: inherit; font-size: 13.5px; font-weight: 700; color: var(--ax-text); background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 3px 10px; }
.hc__to select:first-of-type { flex: 1; }
.hc__log { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.hc__me { align-self: flex-end; max-width: 86%; }
.hc__me .b { background: var(--ax-accent); color: #fff; border-radius: 18px 18px 4px 18px; padding: 8px 13px; font-size: 14.5px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
.hc__them { max-width: 94%; min-width: 0; }
.hc__them .b { background: var(--ax-surface-2); border-radius: 18px 18px 18px 4px; padding: 8px 13px; font-size: 14.5px; line-height: 1.45; overflow-wrap: anywhere; }
.hc__them .b p { margin: 0 0 6px; } .hc__them .b p:last-child { margin: 0; }
.hc__them .b ul, .hc__them .b ol { margin: 0 0 6px; padding-left: 18px; }
.hc__them .b code { font-family: var(--ax-mono); font-size: 12.5px; background: var(--ax-bg); border-radius: 4px; padding: 0 4px; }
.hc__them .b pre { overflow-x: auto; background: var(--ax-bg); border-radius: 8px; padding: 8px; }
.hc__them .b table { display: block; overflow-x: auto; border-collapse: collapse; }
.hc__them .b th, .hc__them .b td { border: 1px solid var(--ax-border); padding: 3px 6px; }
.hc__wait .b { color: var(--ax-muted); }
.hc__meta { font-size: 12px; color: var(--ax-muted); margin: 3px 0 0 2px; }
.hc__live { display: inline-flex; align-items: center; gap: 6px; color: var(--ax-green-d); font-weight: 700; }
.hc__live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ax-green); }
.hc__stop, .hc__run { font: inherit; font-weight: 700; color: var(--ax-accent); background: none; border: 0; padding: 0; margin-left: 10px; cursor: pointer; text-decoration: none; }
.hc__stop[disabled] { opacity: .45; cursor: default; }
.hc__err .b { background: var(--ax-red-t); color: var(--ax-red-ink); }
.hc__err .b b { display: block; margin-bottom: 2px; }
.hc__btnrow { display: flex; gap: 8px; }
.hc__btnrow .ax-btn { font-size: 12.5px; padding: 3px 12px; }
.hc__empty { margin: auto 6px; text-align: center; color: var(--ax-muted); font-size: 14px; line-height: 1.5; }
.hc__empty b { display: block; color: var(--ax-text); font-size: 17px; margin-bottom: 4px; }
.hc__sk { height: 34px; border-radius: 18px; background: var(--ax-surface-2); }
.hc__sk--me { width: 60%; align-self: flex-end; }
.hc__sk--them { width: 84%; height: 96px; }
.hc__guest { margin: auto 8px; text-align: center; color: var(--ax-muted); font-size: 14px; line-height: 1.5; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.hc__guest svg { width: 30px; height: 30px; }
.hc__guest b { color: var(--ax-text); font-size: 17px; }
.hc__foot { border-top: 1px solid var(--ax-border); padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 7px; }
.hc__sends { font-size: 12px; color: var(--ax-muted); }
.hc__sends summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc__sends code { display: block; max-height: 30vh; overflow: auto; margin-top: 6px; padding: 8px 10px; background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: 10px; font-family: var(--ax-mono); font-size: 11.5px; color: var(--ax-text); white-space: pre-wrap; }
.hc__row { display: flex; gap: 8px; align-items: flex-end; }
.hc__row textarea { flex: 1; min-width: 0; resize: none; font: inherit; font-size: 14.5px; padding: 9px 14px; border-radius: 20px; border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); min-height: 40px; max-height: 140px; }
.hc__row .ax-btn { height: 36px; }
.hc__row .ax-btn[disabled] { opacity: .45; }

/* The transcript (#2101 R14): work folded under "Worked for …", one line a step. */
.hc__them > [data-hc-live] { display: flex; flex-direction: column; gap: 8px; }
.hc__fold { font-size: 13px; color: var(--ax-muted); margin: 0 0 6px; }
.hc__fold summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-weight: 600; }
.hc__fold summary::-webkit-details-marker { display: none; }
.hc__fold summary::before { content: "›"; display: inline-block; transition: transform .15s; }
.hc__fold[open] summary::before { transform: rotate(90deg); }
.hc__fold.is-live summary { color: var(--ax-green-d); }
.hc__foldnow { font-weight: 400; color: var(--ax-muted); font-family: var(--ax-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.hc__foldbad { color: var(--ax-red-ink); }
.hc__steps { margin: 6px 0 0; padding: 0 0 0 16px; border-left: 2px solid var(--ax-border); list-style: none; display: flex; flex-direction: column; gap: 3px; }
.hc__step { font-family: var(--ax-mono); font-size: 12px; color: var(--ax-text); overflow-wrap: anywhere; }
.hc__step.is-err { color: var(--ax-red-ink); }
.hc__notice { background: var(--ax-red-t); color: var(--ax-red-ink); border-radius: 12px; padding: 8px 12px; font-size: 13.5px; overflow-wrap: anywhere; white-space: pre-wrap; }
.hc__notice b { display: block; margin-bottom: 2px; }
.hc__files { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.hc__file { font-size: 12px; background: var(--ax-surface-2); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-pill); padding: 2px 10px; }

/* The ask box (#2101 R14): files waiting to go, the mic, a voice status line. */
.hc__files--draft { justify-content: flex-start; margin: 0; }
.hc__file button { font: inherit; background: none; border: 0; color: var(--ax-muted); padding: 0 0 0 6px; cursor: pointer; }
.hc__file.is-wait { opacity: .6; }
.hc__tool { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--ax-border-2); background: none; color: var(--ax-text); cursor: pointer; }
.hc__tool svg { width: 18px; height: 18px; }
.hc__tool:hover { background: var(--ax-surface); }
.hc__tool.is-on { background: var(--ax-red-t); color: var(--ax-red-ink); border-color: transparent; }
.hc__voice { margin: 0; font-size: 12.5px; color: var(--ax-muted); }
.hc__voice.is-err { color: var(--ax-red-ink); }

/* Under 1180 px there is no side column: a button in the header opens the chat. */
@media (max-width: 1180px) {
  .hc-btn { display: inline-flex; }
  .hcq { display: none; }
}
/* Phone: the whole screen, with ← back to the page. */
@media (max-width: 640px) {
  .hc { height: 100dvh; }
  .hc-btn { margin-left: auto; }
  .hc__back { display: block; }
  .hc__x { display: none; }
  .hc__foot { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
}
`
