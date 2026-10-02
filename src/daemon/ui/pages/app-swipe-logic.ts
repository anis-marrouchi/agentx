// Pure helpers for the phone app's swipe between tabs (#444), shipped to the
// browser with injectFns and tested in node. Each one is self-contained.

/** One element on the way up from the touched element to <main>. */
export interface SwipeNode {
  tag: string
  /** It scrolls sideways itself and has something to scroll. */
  scrollsX: boolean
  /** Its computed touch-action. */
  touchAction: string
  editable: boolean
}

/** May a touch that starts here become a tab swipe? Not on something that
 *  scrolls sideways itself (the conversation strip, a wide code block or
 *  table), keeps the touch for itself (the voice orb), is typed in, or sits
 *  in an open sheet. */
export function swipeMayStart(path: SwipeNode[]): boolean {
  const own = ["INPUT", "TEXTAREA", "SELECT", "DIALOG"]
  return !path.some((n) => n.scrollsX || n.editable || n.touchAction === "none" || n.touchAction === "pan-x" || own.indexOf(n.tag) >= 0)
}

/** Which way the finger is going, once it has moved far enough to tell:
 *  "x" is a tab swipe, "y" is a scroll, "" is too early. Sideways has to
 *  win clearly, so a scroll that drifts is still a scroll. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | "" {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 10 && ay < 10) return ""
  return ax > ay * 1.5 ? "x" : "y"
}

/** How far the panels sit from rest. Past the first or the last tab there is
 *  nothing to pull in, so the panel gives a little and no more. */
export function swipeOffset(index: number, count: number, dx: number): number {
  const atEnd = (dx > 0 && index === 0) || (dx < 0 && index === count - 1)
  return atEnd ? dx / 4 : dx
}

/** The tab to land on when the finger lifts. A quick flick goes the way it
 *  was flicked, so one back towards the start stays; a slow release goes to
 *  the neighbour after a third of the width. `velocity` is px per ms over the
 *  last moment of the touch, signed like `dx`. Never past an end. */
export function swipeLanding(index: number, count: number, dx: number, width: number, velocity: number): number {
  const quick = Math.abs(velocity) > 0.5
  const go = quick ? velocity * dx > 0 && Math.abs(dx) > 30 : Math.abs(dx) > width / 3
  if (!go) return index
  const next = index + (dx < 0 ? 1 : -1)
  return next < 0 || next >= count ? index : next
}
