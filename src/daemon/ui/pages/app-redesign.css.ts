// Approved phone design, Chat 1a (#488). Scoped to the phone pages, leaving
// the desktop tokens alone. System fonts keep the cached app self-contained.

// The colours, for every phone page: the app, and the pairing pages before
// it. Blue text is #1f66e5 on white and #6aa0ff on dark, both above 4.5:1.
export const APP_PHONE_PALETTE_CSS = `
:root {
  --ax-bg: #fff; --ax-surface: #fff; --ax-surface-2: #f4f5f7; --ax-surface-3: #f6f7f9;
  --ax-text: #0b0d10; --ax-text-2: #5a616c; --ax-border: #e5e7eb;
  --ax-accent: #1f66e5; --ax-accent-2: #1f66e5; --ax-accent-t: #e8f0ff;
  --ax-radius: 20px; --ax-radius-sm: 12px; --ax-border-w: 1px;
  --phone-bubble: #e8f0ff; --phone-green: #1e8e4e;
}
:root[data-theme=dark] {
  --ax-bg: #14161a; --ax-surface: #1c1f24; --ax-surface-2: #1b1e23; --ax-surface-3: #101215;
  --ax-text: #f2f4f7; --ax-text-2: #a3aab5; --ax-border: #2a2e35;
  --ax-accent: #6aa0ff; --ax-accent-2: #6aa0ff; --ax-accent-t: #1c2b47;
  --phone-bubble: #1d2f52; --phone-green: #3dbe74;
}
`

// The app's layout: the header, tabs, chat, voice dock, cards and sheets.
export const APP_REDESIGN_CSS = `
[hidden] { display: none !important; }
main > .sw-peek[hidden] { display: block !important; }
main > #panel-chat.sw-peek[hidden] { display: flex !important; }
body { overflow: hidden; font-size: 16px; -webkit-font-smoothing: antialiased; }
/* Pin the shell to the layout viewport so the tab bar never slides below the
 * screen when 100dvh disagrees with it (Android TWA) or the root scrolls (#709). */
body { position: fixed; inset: 0; min-height: 0; }
body > * { flex-shrink: 0; }
.bar { min-height: 56px; gap: 8px; padding: calc(4px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 4px calc(20px + env(safe-area-inset-left)); background: var(--ax-bg); border: 0; }
.bar > div:first-child { min-width: 0; flex: 1; }
.bar h1 { font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.who { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-btns { flex: none; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; gap: 8px; }
.icon-btn svg, .cx-head svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
#cam-btn span { font-size: 14px; font-weight: 500; }
body:has(#tab-chat[aria-selected=false]) > .bar { display: none; }
body:has(#tab-chat[aria-selected=false]) main { padding-top: calc(16px + env(safe-area-inset-top)); }
.cx-msg .md th, .cx-msg .md td { white-space: nowrap; padding: 8px 12px; }
.cx-msg .md table { max-width: 100%; }

.icon-btn, .cam-share { background: var(--ax-surface); }
.offline { background: #ffc94d; color: #2b1d00; font-size: 13px; }
main { flex: 1 1 0; min-width: 0; overflow-x: hidden; padding-top: 8px; }
main h2 { font-size: 28px; font-weight: 600; letter-spacing: -.02em; }
#panel-chat { height: 100%; min-height: 0 !important; }
.cx { min-height: 0; gap: 0; }
.cx-top { display: flex; align-items: center; justify-content: flex-end; flex: none; position: static; margin: 0; padding: 0 0 8px; gap: 6px; }
.cx-head { flex: none; justify-content: flex-end; gap: 8px; }
.cx-head .fx-btn { width: 44px; padding: 10px; min-height: 44px; border-radius: 22px; }
.cs { flex: 1; min-width: 0; }
.cs-list { gap: 8px; touch-action: pan-x; }
.cs-state { font-weight: 400; color: var(--ax-text-2); }
.cs-chip { border-color: var(--ax-border); background: var(--ax-surface); }
.cs-chip[aria-current=true] { border-color: #2979ff; background: var(--ax-accent-t); }
.cx-log { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; gap: 16px; padding: 8px 0 16px; }
#cx-empty { padding: 16px 4px; }
.cx-msg { flex: none; padding: 12px 14px; font-size: 16px; line-height: 1.45; }
.cx-user { max-width: 80%; background: var(--phone-bubble); border: 0; border-radius: 20px 20px 6px 20px; }
.cx-agent { border-radius: 6px 20px 20px 20px; }
.cx-msg .md pre { border: 1px solid var(--ax-border); padding: 10px 12px; touch-action: pan-x; }
.cx-msg .md table { touch-action: pan-x; }
.cx-tools summary { min-height: 44px; }
.vx { flex: none; position: static; margin: 0 -16px -16px; padding: 12px 16px 10px; gap: 12px; border-top: 1px solid var(--ax-border); }
.cx-pick { flex: none; flex-direction: row; align-items: center; gap: 6px; min-height: 44px; max-width: 100%; padding: 0 14px; border-radius: 22px; font-size: 15px; }
.cx-pick-intro { color: var(--ax-text-2); flex: none; }
.cx-pick::after { content: '⌄'; margin-left: 4px; }
.cx-pick-label { font-weight: 600; }
.cx-pick-sub { display: none; }
.vx-row { gap: 32px; }
.vx-side { width: 52px; height: 52px; color: var(--ax-text); }
.vx-orb { position: relative; width: 96px; height: 96px; flex: none; }
.vx-orb canvas { position: absolute; width: 160px; height: 160px; top: -32px; left: -32px; }
.vx-mic { position: absolute; width: 34px; height: 34px; left: 31px; top: 31px; fill: none; stroke: #fff; stroke-width: 1.9; stroke-linecap: round; pointer-events: none; }
.vx-status { font-size: 14px; min-height: 18px; line-height: 1.3; }
.vx .cx-composer { order: 3; }
.cx:not(.cx-typing-on) .cx-composer:has(#cx-stop[hidden]) { display: none; }
.cx-typing-on .vx-row { gap: 24px; }
.cx-typing-on .vx-orb { width: 44px; height: 44px; }
.cx-typing-on .vx-orb canvas { width: 74px; height: 74px; top: -15px; left: -15px; }
.cx-typing-on .vx-mic { width: 22px; height: 22px; top: 11px; left: 11px; }
.cx-typing-on .vx { gap: 8px; }
.cam-primary { background: #1f66e5; border-color: #1f66e5; color: #fff; }
.cx-send { background: #1f66e5; color: #fff; border: 0; border-radius: 22px; }
.tabs { flex: none; position: relative; padding: 2px env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); background: var(--ax-bg); }
.tabs [role=tab] { position: relative; min-width: 0; min-height: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 12px; font-weight: 500; border-radius: 16px; }
.tabs [role=tab][aria-selected=true], [data-theme=dark] .tabs [role=tab][aria-selected=true] { background: transparent; color: var(--ax-accent); font-weight: 600; }
.tab-icon { display: grid; place-items: center; width: 56px; height: 30px; border-radius: 16px; }
.tab-icon svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tabs::before { content: ''; position: absolute; pointer-events: none; top: 4px; width: 56px; height: 30px; border-radius: 16px; background: var(--ax-accent-t); left: calc((var(--tab-position, 0) + .5) * 25% - 28px); }
.tab-icon { position: relative; }
.tabs button:active .tab-icon { background: var(--ax-surface-2); transform: scale(.92); }
.fx-card { border-radius: 16px; padding: 16px; }
.fx-row > h3, .fx-row > h4, .fx-row > strong { min-width: 0; overflow-wrap: anywhere; }
.fx-row > .fx-muted { text-align: right; }
.fx-working { color: var(--ax-accent); font-size: 14px; }
.fx-sub { font-weight: 600; font-size: 14px; margin-top: 24px; }
.fx-machine { display: flex; align-items: center; gap: 12px; }
.fx-machine svg { flex: none; width: 44px; height: 44px; padding: 10px; border-radius: 12px; background: var(--ax-surface-2); fill: none; stroke: currentColor; stroke-width: 1.7; }
.fx-offline { border-style: dashed; background: var(--ax-surface-2); }
.fx-offline .fx-off { background: transparent; color: var(--ax-text-2); }
.fx-on { background: transparent; color: var(--phone-green); }
.fx-switch { height: 44px; border-radius: 22px; }
.fx-switch span { top: 9px; }
.fx-sheet { max-height: 85dvh; border-radius: 24px 24px 0 0; padding: 0 0 env(safe-area-inset-bottom); overscroll-behavior: contain; }
.fx-sheet::backdrop { background: rgb(11 13 16 / .34); }
[data-theme=dark] .fx-sheet { background: #1f2228; }
[data-theme=dark] .fx-sheet::backdrop { background: rgb(0 0 0 / .55); }
.sheet-handle { display: block; width: 100%; height: 44px; padding: 0; border: 0; background: transparent; touch-action: none; cursor: grab; }
.sheet-handle::after { content: ''; display: block; width: 36px; height: 5px; border-radius: 3px; margin: auto; background: var(--ax-text-2); opacity: .5; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 0 20px 8px; gap: 8px; }
.sheet-head h3 { margin: 0; font-size: 20px; }
.cx-sheet { border: 0; border-radius: 0; padding: 0 20px 20px; max-height: 60dvh; background: transparent; }
.cx-sheet li button { min-height: 48px; background: transparent; border: 0; border-bottom: 1px solid var(--ax-border); border-radius: 0; }
#al-list { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: 20px; overflow: hidden; }
#al-list li { padding: 16px; }
#al-list li:first-child { border-top: 0; }
#al-list p { line-height: 1.45; margin: 8px 0 0; overflow-wrap: anywhere; }
#al-list a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ax-accent); }
.tabs .has-unread .tab-icon::after { content: ''; position: absolute; width: 7px; height: 7px; border-radius: 50%; background: #2979ff; top: 6px; margin-left: 24px; }
#al-list .al-unread { background: var(--ax-accent-t); }
.al-item { width: 100%; min-height: 44px; padding: 0; font: inherit; text-align: left; border: 0; color: inherit; background: none; cursor: pointer; }
.al-body { display: block; margin-top: 8px; line-height: 1.45; overflow-wrap: anywhere; }
.al-unread strong::before { content: '●'; color: var(--ax-accent); margin-right: 8px; font-size: 10px; }
main > #panel-chat.sw-peek { height: 100%; padding-top: 8px; }
@media (max-width: 360px) { #cam-btn span { display: none; } .bar { padding-left: 12px; } .bar-btns { gap: 4px; } .vx-row { gap: 24px; } }
@media (max-height: 540px) { .vx { gap: 4px; padding-top: 4px; } .cx-top { padding-bottom: 4px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`
