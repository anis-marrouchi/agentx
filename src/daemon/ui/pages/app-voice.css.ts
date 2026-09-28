// --- Phone app: the voice bar under the Chat log (app-voice.client.ts) ---
//
// The orb sits at the bottom, pinned like the text box it replaces. The
// text box (with Send) shows only in typing mode; Stop stays in voice mode.

export const APP_VOICE_CSS = `
.vx {
  position: sticky; bottom: -16px; z-index: 1; display: grid; justify-items: center; gap: 4px;
  margin: 0 0 -16px; padding: 8px 0 12px; background: var(--ax-bg);
}
.vx .cx-composer { position: static; width: 100%; margin: 0; padding: 0 0 4px; background: transparent; }
.cx:not(.cx-typing-on) .vx .cx-composer { justify-content: center; padding: 0; }
.cx:not(.cx-typing-on) #cx-input, .cx:not(.cx-typing-on) #cx-send { display: none; }
.vx-status {
  margin: 0; min-height: 1.5em; max-width: 34ch; text-align: center;
  font-size: var(--ax-fs-sm); color: var(--ax-text-2); line-height: 1.45;
}
.vx-status.vx-bad { color: var(--ax-red-ink); }
.vx-row { display: flex; align-items: center; justify-content: center; gap: 12px; }
.vx-side {
  width: 48px; height: 48px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: 50%;
  background: var(--ax-surface); color: var(--ax-text-2);
}
.vx-side svg { width: 24px; height: 24px; }
.vx-side[aria-pressed=true] { color: var(--ax-accent); border-color: color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border)); }
#vx-speaker .vx-mute { display: none; }
#vx-speaker.vx-off { color: var(--ax-text-2); border-color: var(--ax-border); }
#vx-speaker.vx-off .vx-waves { display: none; }
#vx-speaker.vx-off .vx-mute { display: inline; }
.vx-orb {
  width: 150px; height: 150px; padding: 0; border: 0; border-radius: 50%; background: transparent; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  transition: opacity 0.15s ease;
}
.vx-orb canvas { width: 100%; height: 100%; display: block; pointer-events: none; }
.vx[data-state=cancel] .vx-orb { opacity: 0.4; }
.vx[data-state=cancel] .vx-status { color: var(--ax-red-ink); }
.cx-typing-on .vx-orb { width: 88px; height: 88px; }
.cx-typing-on .vx-row { gap: 16px; }
@media (prefers-reduced-motion: reduce) { .vx-orb { transition: none; } }
`
