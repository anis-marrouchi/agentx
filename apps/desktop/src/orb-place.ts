// Where the orb window sits, as plain rules (no Electron), so they can be
// tested with plain Node (test/orb-place.test.mjs). The place is kept in
// orb-state.json next to the Hub window's window-state.json.

export interface Point {
  x: number
  y: number
}

export interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** Space kept between the orb and the screen edge on the first launch. */
const MARGIN = 24

/** A saved place, or null when the file held something else. */
export function parsePlace(raw: unknown): Point | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: Math.round(o.x as number), y: Math.round(o.y as number) } : null
}

/**
 * The top-left corner for a window of `size`: the saved place when the
 * window still lands on one of the screens' work areas, else the bottom
 * right of the main screen (also after a screen was unplugged).
 */
export function orbPlace(saved: Point | null, size: { width: number; height: number }, areas: readonly Area[], main: Area): Point {
  if (saved && areas.some((a) => fits(saved, size, a))) return saved
  return { x: main.x + main.width - size.width - MARGIN, y: main.y + main.height - size.height - MARGIN }
}

// The orb itself (the top middle of the window) must be on the area.
function fits(p: Point, size: { width: number; height: number }, a: Area): boolean {
  const cx = p.x + size.width / 2
  const cy = p.y + 40
  return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height
}

/**
 * The window's new bounds when its content changes size: the orb keeps its
 * place on screen, so the window grows around the top middle.
 */
export function regrow(now: Area, width: number, height: number): Area {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return { x: Math.round(now.x + (now.width - w) / 2), y: now.y, width: w, height: h }
}
