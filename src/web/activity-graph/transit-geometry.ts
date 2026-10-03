// Transit map geometry: pure helpers for the layout, the renderer and the
// train card. No React.

export type Orientation = "horizontal" | "vertical"

/** Routes with this many agents collapse their middle hops. */
export const COLLAPSE_AT = 4

/** Agents drawn for a route; `hidden` hops sit between the first two. */
export function drawnRoute(route: string[], expanded: boolean): { agents: string[]; hidden: number } {
  if (expanded || route.length < COLLAPSE_AT) return { agents: route, hidden: 0 }
  return { agents: [route[0], ...route.slice(-2)], hidden: route.length - 3 }
}

/** Push positions apart to at least `gap`, keeping their order and mean. */
export function spread(desired: number[], gap: number): number[] {
  if (!desired.length) return []
  const order = desired.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = order.map(([v]) => v)
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap)
  const shift = (desired.reduce((a, b) => a + b, 0) - out.reduce((a, b) => a + b, 0)) / out.length
  const res = new Array<number>(desired.length)
  order.forEach(([, idx], k) => { res[idx] = out[k] + shift })
  return res
}

/** A level stretch a feeder takes past the interchange columns: at cross
 *  position `c`, from `m0` to `m1` along the main axis. */
export interface Via { m0: number; m1: number; c: number }

/** Corners of a metro segment: straight runs joined by one 45° leg, or by
 *  one leg on each side of `via`. */
export function metroPoints(sx: number, sy: number, tx: number, ty: number, orientation: Orientation, offset = 0, via?: Via): Array<[number, number]> {
  if (orientation === "vertical") return metroPoints(sy, sx, ty, tx, "horizontal", offset, via).map(([a, b]) => [b, a])
  if (via) return [...metroPoints(sx, sy, via.m0, via.c, "horizontal", offset), ...metroPoints(via.m1, via.c, tx, ty, "horizontal", offset)]
  sy += offset; ty += offset
  const dy = ty - sy, dx = tx - sx
  if (Math.abs(dy) < 0.5) return [[sx, sy], [tx, ty]]
  const lead = Math.min(18, Math.max(0, dx / 4))
  const leg = Math.min(Math.abs(dy), Math.max(0, dx - 2 * lead))
  const x1 = sx + lead, x2 = x1 + leg
  return [[sx, sy], [x1, sy], [x2, ty], [tx, ty]]
}

/** SVG path for a metro segment. */
export function metroPath(sx: number, sy: number, tx: number, ty: number, orientation: Orientation, offset = 0, via?: Via): string {
  return "M " + metroPoints(sx, sy, tx, ty, orientation, offset, via).map(([x, y]) => `${x} ${y}`).join(" L ")
}

/** True when the polyline passes within `pad` of the box. */
export function crossesBox(pts: Array<[number, number]>, box: { x: number; y: number; w: number; h: number }, pad = 0): boolean {
  const x0 = box.x - pad, x1 = box.x + box.w + pad, y0 = box.y - pad, y1 = box.y + box.h + pad
  return pts.slice(1).some(([bx, by], i) => {
    const [ax, ay] = pts[i]
    let t0 = 0, t1 = 1
    for (const [p, q] of [[ax - bx, ax - x0], [bx - ax, x1 - ax], [ay - by, ay - y0], [by - ay, y1 - ay]]) {
      if (p === 0) { if (q < 0) return false; continue }
      if (p < 0) t0 = Math.max(t0, q / p); else t1 = Math.min(t1, q / p)
    }
    return t0 <= t1
  })
}
