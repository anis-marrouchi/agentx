// --- Phone app: conversation strip and finish banners (app-chat-strip.client.ts) ---
//
// Each chip and banner carries its agent's orb colour as --cs-c; everything
// else is the shared tokens, so both flip with the theme.

export const APP_CHAT_STRIP_CSS = `
.cs { margin: 0 -2px; }
.cs[hidden] { display: none; }
.cs-list {
  list-style: none; margin: 0; padding: 2px; display: flex; gap: 6px;
  overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; scroll-snap-type: x proximity;
}
.cs-list::-webkit-scrollbar { display: none; }
.cs-list li { flex: none; scroll-snap-align: start; }
.cs-chip {
  display: inline-flex; align-items: center; gap: 7px; min-height: 44px; max-width: 62vw; padding: 0 12px;
  font: inherit; font-size: var(--ax-fs-sm); font-weight: 600; color: var(--ax-text); cursor: pointer; white-space: nowrap;
  border: 1.5px solid color-mix(in oklch, var(--cs-c) 45%, var(--ax-border)); border-radius: var(--ax-radius-pill);
  background: color-mix(in oklch, var(--cs-c) 9%, var(--ax-surface));
}
.cs-chip[aria-current="true"] { border-color: var(--cs-c); background: color-mix(in oklch, var(--cs-c) 22%, var(--ax-surface)); }
.cs-name { overflow: hidden; text-overflow: ellipsis; }
.cs-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--cs-c); }
.cs-thinking .cs-dot { animation: cs-pulse 1.4s ease-in-out infinite; }
.cs-answering .cs-dot { box-shadow: 0 0 0 3px color-mix(in oklch, var(--cs-c) 30%, transparent); animation: cs-pulse 0.8s ease-in-out infinite; }
.cs-open .cs-dot { background: transparent; border: 2px solid var(--cs-c); width: 7px; height: 7px; }
.cs-new {
  font-size: var(--ax-fs-xs); font-weight: 700; line-height: 1; padding: 3px 7px;
  border-radius: var(--ax-radius-pill); background: var(--ax-text); color: var(--ax-bg);
}
@keyframes cs-pulse { 50% { opacity: 0.3; } }
.cs-banners {
  position: fixed; z-index: 40; left: 0; right: 0; top: calc(8px + env(safe-area-inset-top));
  display: grid; justify-items: center; padding: 0 calc(12px + env(safe-area-inset-right)) 0 calc(12px + env(safe-area-inset-left));
  pointer-events: none;
}
.cs-banner {
  pointer-events: auto; width: 100%; max-width: 520px; box-sizing: border-box; display: flex; align-items: stretch;
  background: var(--ax-surface); color: var(--ax-text); border: var(--ax-border-w) solid var(--ax-border);
  border-left: 5px solid var(--cs-c); border-radius: var(--ax-radius); box-shadow: var(--ax-shadow-lg);
  animation: cs-in 0.2s ease-out;
}
.cs-banner-open {
  flex: 1; min-width: 0; min-height: 56px; display: grid; gap: 2px; align-content: center; padding: 8px 12px;
  text-align: left; font: inherit; color: inherit; background: none; border: 0; cursor: pointer;
}
.cs-banner-open strong { font-size: var(--ax-fs-sm); }
.cs-banner-open span {
  font-size: var(--ax-fs-xs); color: var(--ax-text-2); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.cs-banner-open span:empty { display: none; }
.cs-banner-x { min-width: 44px; min-height: 44px; font: inherit; font-size: 20px; color: var(--ax-text-2); background: none; border: 0; cursor: pointer; }
@keyframes cs-in { from { transform: translateY(-12px); opacity: 0; } }
.al-finish { margin-top: 12px; min-height: 48px; }
.al-finish p { margin: 0; font-weight: 600; }
.al-finish small { display: block; font-weight: 400; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.al-finish .fx-switch::after { content: ""; position: absolute; inset: -8px; }
@media (prefers-reduced-motion: reduce) {
  .cs-thinking .cs-dot, .cs-answering .cs-dot, .cs-banner { animation: none; }
}
`
