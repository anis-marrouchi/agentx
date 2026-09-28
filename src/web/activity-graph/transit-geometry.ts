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

/** SVG path for a metro segment: straight runs joined by one 45° leg. */
export function metroPath(sx: number, sy: number, tx: number, ty: number, orientation: Orientation, offset = 0): string {
  if (orientation === "vertical") {
    const p = metroPath(sy, sx, ty, tx, "horizontal", offset)
    return p.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, a, b) => `${b} ${a}`)
  }
  sy += offset; ty += offset
  const dy = ty - sy, dx = tx - sx
  if (Math.abs(dy) < 0.5) return `M ${sx} ${sy} L ${tx} ${ty}`
  const lead = Math.min(18, Math.max(0, dx / 4))
  const leg = Math.min(Math.abs(dy), Math.max(0, dx - 2 * lead))
  const x1 = sx + lead, x2 = x1 + leg
  return `M ${sx} ${sy} L ${x1} ${sy} L ${x2} ${ty} L ${tx} ${ty}`
}
