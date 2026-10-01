// --- The look of the Mac card (card-page.ts) ---
//
// The card has its own small set of tokens, apart from the dashboard's: it
// is a quiet panel on the desktop, not a page of the dashboard. Paper and
// ink neutrals, hairline borders, navy for the one action that matters,
// teal for the small marks (recommended, edited, focus). The dark set is
// the same card remapped, picked by data-theme on <html>.
//
// The window is see-through around the card (card-window.ts), so the round
// corners and the soft shadow are drawn here. CARD_PAD is the room the
// shadow needs; the window is that much larger than the card.

export const CARD_PAD = { top: 8, side: 32, bottom: 60 } as const

// The card's header is its handle: a press in the top CARD_GRIP.height of
// the card drags the window (card-window.ts takes it before the page does).
// The last CARD_GRIP.keep at the right stays with the page, for the button
// that shrinks the card.
export const CARD_GRIP = { height: 56, keep: 52 } as const

export const CARD_CSS = `
:root {
  --ac-paper: #fafaf9; --ac-soft: #f4f4f2; --ac-edge: #e9e9e6;
  --ac-text: #0b1413; --ac-muted: #4a5856; --ac-subtle: #7c8987;
  --ac-primary: #1e3a8a; --ac-primary-deep: #172554;
  --ac-blue: #1e3a8a; --ac-blue-2: #1d4ed8;
  --ac-accent: #14b8a6; --ac-accent-deep: #0f766e;
  --ac-rim: rgba(11,20,19,.10);
  --ac-shadow: 0 0 0 .5px rgba(11,20,19,.05), 0 24px 48px -16px rgba(11,20,19,.30), 0 2px 6px rgba(11,20,19,.06);
  --ac-lift: 0 12px 40px rgba(30,58,138,.20), 0 2px 6px rgba(11,20,19,.06);
  --ac-font: "Geist", -apple-system, BlinkMacSystemFont, "Noto Sans Arabic", system-ui, sans-serif;
  --ac-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: light;
}
[data-theme="dark"] {
  --ac-paper: #111c1b; --ac-soft: #172322; --ac-edge: #263433;
  --ac-text: #e8eeed; --ac-muted: #a7b3b1; --ac-subtle: #83918f;
  --ac-primary: #2563eb; --ac-primary-deep: #1d4ed8;
  --ac-blue: #93c5fd; --ac-blue-2: #60a5fa;
  --ac-accent-deep: #5eead4;
  --ac-rim: rgba(255,255,255,.09);
  --ac-shadow: 0 0 0 .5px rgba(0,0,0,.6), 0 28px 56px -16px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.3);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  font: 13.5px/1.5 var(--ac-font); color: var(--ac-text); font-feature-settings: "ss01", "cv11";
  -webkit-font-smoothing: antialiased; -webkit-user-select: none; user-select: none; cursor: default;
}
.wrap { padding: ${CARD_PAD.top}px ${CARD_PAD.side}px ${CARD_PAD.bottom}px; }
.card {
  background: var(--ac-paper); border: 1px solid var(--ac-rim); border-radius: 18px;
  box-shadow: var(--ac-shadow); overflow: hidden; animation: ac-in .26s cubic-bezier(.65,0,.35,1);
  position: relative; display: flex; flex-direction: column; max-height: calc(100vh - ${CARD_PAD.top + CARD_PAD.bottom}px);
}
.card::before {
  content: ""; position: absolute; top: 6px; left: 50%; width: 32px; height: 4px; margin-left: -16px;
  border-radius: 2px; background: var(--ac-edge);
}
@keyframes ac-in { from { transform: translateY(14px); opacity: 0; } }
.card.still { animation: none; }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
.head { flex: none; display: flex; align-items: center; gap: 10px; padding: 18px 20px 0; cursor: grab; }
.body { padding: 14px 20px 16px; min-height: 0; overflow-y: auto; }
.fold {
  flex: none; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border-radius: 6px;
  border: 1px solid var(--ac-edge); background: var(--ac-soft); color: var(--ac-subtle); cursor: pointer;
}
.fold:hover { color: var(--ac-text); border-color: var(--ac-subtle); }
.folded .fold svg { transform: rotate(180deg); }
.folded .body > :not(h1), .folded .foot { display: none; }
.avatar {
  flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
  font-size: 14px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, var(--ac-blue-2), var(--ac-accent));
}
.who { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.who b { font-size: 13.5px; font-weight: 560; letter-spacing: -.008em; line-height: 1.25; }
.who span { font-size: 12px; line-height: 1.3; color: var(--ac-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label, .kind, .edited { font-family: var(--ac-mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; }
.kind {
  padding: 3px 8px; border-radius: 999px; white-space: nowrap;
  color: var(--ac-muted); background: var(--ac-soft); border: 1px solid var(--ac-edge);
}
.kind.decision {
  color: var(--ac-blue); background: color-mix(in oklab, var(--ac-blue-2) 10%, var(--ac-paper));
  border-color: color-mix(in oklab, var(--ac-blue-2) 22%, var(--ac-edge));
}
h1 { margin: 0; font-size: 18.5px; line-height: 1.3; font-weight: 540; letter-spacing: -.018em; text-wrap: balance; }
h1:dir(rtl) { letter-spacing: 0; }
.context { margin: 6px 0 0; color: var(--ac-muted); white-space: pre-wrap; unicode-bidi: plaintext; text-wrap: pretty; }
.ask { margin: 10px 0 0; font-weight: 500; unicode-bidi: plaintext; }
.label-row { margin-top: 16px; display: flex; align-items: center; gap: 8px; min-height: 18px; }
.label { color: var(--ac-subtle); margin-inline-end: auto; }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ac-accent); }
.rec { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ac-subtle); }
.why { margin: 8px 0 0; font-size: 12px; line-height: 1.4; color: var(--ac-subtle); unicode-bidi: plaintext; }
.options { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.opt {
  display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px 5px 5px; padding-inline: 5px 12px;
  border-radius: 999px; border: 1px solid var(--ac-edge); background: var(--ac-paper); color: var(--ac-text);
  font: inherit; font-size: 13px; line-height: 1.35; text-align: start; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
}
.opt:hover { transform: translateY(-1px); }
.opt .n {
  flex: none; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px;
  border: 1px solid var(--ac-edge); border-bottom-width: 2px; background: var(--ac-soft); color: var(--ac-subtle);
  font-family: var(--ac-mono); font-size: 10.5px;
}
.opt .t { unicode-bidi: plaintext; }
.opt[aria-checked="true"] { background: var(--ac-primary); border-color: var(--ac-primary); color: #fff; }
.opt[aria-checked="true"] .n { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.28); color: #fff; }
.opt[aria-checked="true"] .dot { background: #5eead4; }
.edited { display: none; align-items: center; gap: 5px; color: var(--ac-accent-deep); }
.edited .dot { width: 5px; height: 5px; }
.reset { display: none; border: 0; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--ac-muted); cursor: pointer; }
.reset:hover { color: var(--ac-text); }
.touched .edited { display: inline-flex; }
.touched .reset { display: inline; }
textarea {
  margin-top: 6px; display: block; width: 100%; min-height: 60px; max-height: 240px; resize: none; overflow-y: auto;
  padding: 10px 12px; border: 1px solid var(--ac-edge); border-radius: 10px; background: var(--ac-soft);
  color: var(--ac-text); font: inherit; line-height: 1.45; outline: none; unicode-bidi: plaintext;
  -webkit-user-select: text; user-select: text; cursor: text; transition: border-color .15s ease, box-shadow .15s ease;
}
textarea::placeholder { color: var(--ac-subtle); }
textarea:focus {
  border-color: var(--ac-accent); background: var(--ac-paper);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ac-accent) 18%, transparent);
}
.notes { margin-top: 14px; display: flex; flex-direction: column; gap: 5px; font-size: 12px; line-height: 1.4; color: var(--ac-subtle); }
.notes div { display: flex; gap: 7px; align-items: flex-start; }
.notes svg { flex: none; margin-top: 1.5px; }
.foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ac-edge); background: var(--ac-soft); }
.foot .later { margin-inline-end: auto; }
button.btn {
  display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px;
  font: inherit; font-weight: 500; letter-spacing: -.005em; white-space: nowrap; cursor: pointer;
  background: transparent; color: var(--ac-text); border: 1px solid var(--ac-edge);
  transition: transform .15s ease, background .15s ease, box-shadow .15s ease, border-color .15s ease;
}
button.btn:hover { background: var(--ac-soft); border-color: var(--ac-subtle); }
button.primary, button.primary:hover { background: var(--ac-primary); border-color: transparent; color: #fff; }
button.primary:hover:not(:disabled) { transform: translateY(-1px); background: var(--ac-primary-deep); box-shadow: var(--ac-lift); }
button.primary:disabled { opacity: .55; cursor: not-allowed; }
kbd { font: 11px var(--ac-mono); color: var(--ac-subtle); }
button.primary kbd { color: inherit; opacity: .7; }
`
