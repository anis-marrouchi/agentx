// --- Follow the newest reply, and a button back to it (#2101, Anis 11-25) ---
//
// Orca's chat area: while a reply streams the view follows it. Scrolling up
// stops following and shows a round "Jump to latest" button, centred above
// the composer. Pressing it goes back to the bottom and follows again.
// Used by the Hub chat (#hc-log) and the Task page (#task-output).
//
// followAttach is shipped to the browser through injectFns and stands alone;
// followBtnHtml is drawn on the server.

import { icon } from "../icons"

/** The button, hidden until the reader scrolls up. */
export function followBtnHtml(id: string): string {
  return '<button type="button" class="ax-jump" id="' + String(id).replace(/[^\w-]/g, "") +
    '" aria-label="Jump to latest" title="Jump to latest" hidden>' +
    icon("arrow-down") + "</button>"
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
 * `pageBelow` (px): at or below that window width, a `scroller` that does
 * not scroll itself hands over to the page's own scroll.
 */
export function followAttach(scroller: HTMLElement | null, btn: HTMLElement | null, pageBelow?: number): Follow {
  let on = true
  // No scroll box (a signed-out panel): nothing to follow.
  if (!scroller) return { stick() {}, jump() {}, following() { return true }, stop() {} }
  // The box that really scrolls (#2306 review C2). On a phone-width Task page
  // the output has no height limit, so the page scrolls, not the output: at
  // or below `pageBelow` px wide, follow the page instead. A box that can
  // scroll itself always wins, and without `pageBelow` only the box counts.
  const win = pageBelow && typeof window !== "undefined" ? window : null
  const page = (): HTMLElement | null =>
    pageBelow && win && win.innerWidth <= pageBelow && typeof document !== "undefined"
      ? ((document.scrollingElement || document.documentElement) as HTMLElement | null) : null
  const box = (): HTMLElement => (scroller.scrollHeight > scroller.clientHeight + 1 ? scroller : page() || scroller)
  const near = () => { const b = box(); return b.scrollHeight - b.scrollTop - b.clientHeight < 60 }
  // A phone-width page opens at its top (#2405 review C1): the header, the
  // request and the plan come first, so it starts not following. ↓ shows once
  // there is text below the screen; one tap, or scrolling to the end, follows.
  on = box() === scroller
  const show = () => { if (btn) btn.hidden = on || near() }
  const onScroll = () => { on = near(); show() }
  const toEnd = () => { const b = box(); b.scrollTop = b.scrollHeight }
  const onClick = (e: Event) => { e.preventDefault(); on = true; toEnd(); show() }
  scroller.addEventListener("scroll", onScroll, { passive: true })
  if (win) win.addEventListener("scroll", onScroll, { passive: true })
  if (btn) btn.addEventListener("click", onClick)
  show()
  return {
    stick() { if (on) toEnd(); else show() },
    jump() { on = true; toEnd(); show() },
    following() { return on },
    stop() {
      scroller.removeEventListener("scroll", onScroll)
      if (win) win.removeEventListener("scroll", onScroll)
      if (btn) btn.removeEventListener("click", onClick)
    },
  }
}

/** The button's look, shared by both pages. Its parent is position: relative. */
export const FOLLOW_CSS = `
.ax-jump { position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); z-index: 3;
  width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; cursor: pointer;
  border: 1px solid var(--ax-border, rgba(127,127,127,.35)); background: var(--ax-surface, #fff); color: var(--ax-text, inherit);
  box-shadow: 0 2px 10px rgba(0,0,0,.14); }
.ax-jump:hover { background: var(--ax-surface-2, var(--ax-surface, #f4f4f5)); }
.ax-jump[hidden] { display: none; }
`
