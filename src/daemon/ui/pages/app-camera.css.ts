// Styles for the phone app's Share camera sheet (app-camera.client.ts).

export const CAMERA_CSS = `
.cam { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; background: var(--ax-bg); }
.cam[hidden] { display: none; }
.cam-live {
  display: flex; align-items: center; gap: 10px;
  padding: calc(10px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 10px calc(16px + env(safe-area-inset-left));
  background: var(--ax-red); color: #fff; font-weight: 700;
}
.cam-live[hidden] { display: none; }
.cam-dot { width: 12px; height: 12px; border-radius: 50%; background: #fff; flex: none; }
#cam-live-text { flex: 1; }
.cam-stop {
  min-height: 44px; min-width: 88px; border: 2px solid #fff; border-radius: var(--ax-radius-pill);
  background: transparent; color: #fff; font: inherit; font-weight: 700; cursor: pointer;
}
.cam-video { flex: 1; min-height: 0; width: 100%; object-fit: contain; background: #000; }
.cam-video[hidden] { display: none; }
.cam-panel { padding: 16px calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
.cam:not(.is-live) .cam-panel { padding-top: calc(16px + env(safe-area-inset-top)); }
.cam-panel h2 { font-size: 20px; margin: 0 0 8px; }
.cam-msg { margin: 0 0 12px; color: var(--ax-text-2); line-height: 1.5; }
.cam-msg.bad { color: var(--ax-red-ink); }
.cam-field[hidden] { display: none; }
.cam-field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; font-weight: 600; }
.cam-field select, .cam-field input {
  min-height: 44px; font: inherit; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border);
  background: var(--ax-surface-2); color: var(--ax-text); padding: 0 10px;
}
.cam-row { display: flex; gap: 8px; flex-wrap: wrap; }
.cam-primary, .cam-secondary {
  min-height: 48px; padding: 0 18px; border-radius: var(--ax-radius-pill); font: inherit; font-weight: 600; cursor: pointer;
  border: var(--ax-border-w) solid var(--ax-border); background: var(--ax-surface-2); color: var(--ax-text);
}
.cam-primary { background: var(--ax-accent); border-color: var(--ax-accent); color: #fff; }
.cam-primary[disabled], .cam-secondary[disabled] { opacity: .6; cursor: default; }
/* What the watching agent said, newest first (#325 phase 2). */
.cam-reply[hidden] { display: none; }
.cam-reply {
  margin: 0 0 12px; padding: 10px 12px; border-radius: var(--ax-radius-sm); background: var(--ax-surface-2);
  border: var(--ax-border-w) solid var(--ax-border); line-height: 1.5; max-height: 30vh; overflow: auto;
}
.cam-reply strong { display: block; font-size: 13px; color: var(--ax-text-2); margin-bottom: 4px; }
/* Talk: the way to ask by default (#687). Big, one thumb, its state in colour and words. */
.cam-talk[hidden] { display: none; }
.cam-talk {
  display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 64px; margin: 0 0 12px;
  border-radius: var(--ax-radius-pill); border: 2px solid var(--ax-accent); background: var(--ax-accent); color: #fff;
  font: inherit; font-size: 18px; font-weight: 700; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.cam-talk.is-on { background: var(--ax-red); border-color: var(--ax-red); }
.cam-talk[disabled] { opacity: .6; cursor: default; }
.cam-talk:focus-visible { outline: 3px solid var(--ax-text); outline-offset: 2px; }
.cam-mic { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; flex: none; }
/* Keep watching is on: the red bar says so with a second countdown. */
.cam-live.is-stream .cam-dot { animation: cam-pulse 1s ease-in-out infinite; }
@keyframes cam-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .cam-live.is-stream .cam-dot { animation: none; } }
#cam-stream[aria-pressed="true"] { border-color: var(--ax-red); color: var(--ax-red-ink); }
`
