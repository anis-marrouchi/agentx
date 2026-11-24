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
.vx-talk {
  position: fixed; left: 0; right: 0; z-index: 30; pointer-events: none;
  display: grid; justify-items: center; gap: 14px; padding: 18px 16px 16px;
  border: 1px solid var(--ax-border); border-bottom: 0; border-radius: 28px 28px 0 0;
  background: var(--ax-surface); box-shadow: 0 -12px 32px rgb(0 0 0 / .18);
}
.vx-talk-who { display: inline-flex; align-items: center; gap: 10px; padding: 4px 14px 4px 4px; border-radius: 999px; background: var(--ax-accent-t); color: var(--ax-accent); font-weight: 600; }
.vx-talk-face { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--ax-accent); color: #fff; font-size: 14px; font-weight: 700; }
.vx-wave { display: flex; align-items: center; gap: 5px; height: 40px; }
.vx-wave i { display: block; width: 4px; border-radius: 2px; background: var(--ax-accent); height: calc(6px + 34px * var(--k) * var(--l, .15)); transition: height .08s linear; }
.vx-talk-mic { display: grid; place-items: center; width: 96px; height: 96px; border-radius: 50%; background: var(--ax-accent); box-shadow: 0 0 0 14px var(--ax-accent-t), 0 0 0 30px color-mix(in oklch, var(--ax-accent) 10%, transparent); margin: 14px 0; }
.vx-talk-mic svg { width: 40px; height: 40px; fill: none; stroke: #fff; stroke-width: 1.9; stroke-linecap: round; }
.vx-talk-hint { font-size: 15px; color: var(--ax-text-2); }
.vx-talk[data-state=cancel] .vx-talk-mic { background: var(--ax-red); }
.vx-talk[data-state=cancel] .vx-talk-hint { color: var(--ax-red-ink); }
@media (prefers-reduced-motion: reduce) { .vx-wave i { transition: none; } }
`
