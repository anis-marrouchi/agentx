// --- Follow the newest reply, and a button back to it (#2101, Anis 11-25) ---
//
// Orca's chat area: while a reply streams the view follows it. Scrolling up
// stops following and shows a round "Jump to latest" button, centred above
// the composer. Pressing it goes back to the bottom and follows again.
// Used by the Hub chat (#hc-log) and the Task page (#task-output).
//
// Shipped to the browser through injectFns: each function stands alone.

/** The button, hidden until the reader scrolls up. */
export function followBtnHtml(id: string): string {
  return '<button type="button" class="ax-jump" id="' + String(id).replace(/[^\w-]/g, "") +
    '" aria-label="Jump to latest" title="Jump to latest" hidden>' +
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></button>'
}

export interface Follow {
  /** After new content: go to the bottom when following. */
  stick(): void
  /** Go to the bottom and follow again (the button, a sent message, a new thread). */
  jump(): void
  following(): boolean
  /** Remove the listeners. */
  stop(): void
}

/**
 * Watch `scroller`: following while it sits at the bottom, not following
 * once the reader scrolls up; `btn` shows only while not following.
 */
export function followAttach(scroller: HTMLElement | null, btn: HTMLElement | null): Follow {
  let on = true
  // No scroll box (a signed-out panel): nothing to follow.
  if (!scroller) return { stick() {}, jump() {}, following() { return true }, stop() {} }
  const near = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  const show = () => { if (btn) btn.hidden = on }
  const onScroll = () => { on = near(); show() }
  const toEnd = () => { scroller.scrollTop = scroller.scrollHeight }
  const onClick = (e: Event) => { e.preventDefault(); on = true; toEnd(); show() }
  scroller.addEventListener("scroll", onScroll, { passive: true })
  if (btn) btn.addEventListener("click", onClick)
  show()
  return {
    stick() { if (on) toEnd(); else show() },
    jump() { on = true; toEnd(); show() },
    following() { return on },
    stop() { scroller.removeEventListener("scroll", onScroll); if (btn) btn.removeEventListener("click", onClick) },
  }
}

/** The button's look, shared by both pages. Its parent is position: relative. */
export const FOLLOW_CSS = `
.ax-jump { position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); z-index: 3;
  width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; cursor: pointer;
  border: 1px solid var(--ax-border, rgba(127,127,127,.35)); background: var(--ax-surface, #fff); color: var(--ax-text, inherit);
  box-shadow: 0 2px 10px rgba(0,0,0,.14); }
.ax-jump:hover { background: var(--ax-surface-2, var(--ax-surface, #f4f4f5)); }
.ax-jump:focus-visible { outline: 2px solid var(--ax-accent, #2563eb); outline-offset: 2px; }
.ax-jump[hidden] { display: none; }
`
