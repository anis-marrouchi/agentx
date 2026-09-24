// Transit map layout — places channels, stations (agents), train groups and
// line terminals. Pure so it can be tested; TransitMap.tsx only renders.
// Horizontal (desktop): channels | interchanges | stations | trains | terminals.
// Vertical (phone line view): the same tiers top to bottom, for one line.

import { CHANNELS, STATE_ORDER, type Line, type Train, type Transit } from "./transit"

export type Orientation = "horizontal" | "vertical"
/** "trains", not "group": xyflow styles its built-in "group" node type. */
export type NetKind = "channel" | "station" | "trains" | "terminal" | "district"

export interface NetNode {
  id: string
  kind: NetKind
  /** Top-left, in flow coordinates. */
  x: number
  y: number
  w: number
  h: number
  label: string
  sub?: string
  color?: string
  code?: string
  idle?: boolean
  mesh?: boolean
  interchange?: boolean
  running?: boolean
  delayed?: boolean
  lineId?: string
  trains?: Train[]
  more?: number
}
export interface NetEdge {
  id: string
  source: string
  target: string
  kind: "feeder" | "track"
  color: string
  lineId?: string
  /** Perpendicular shift so parallel lines on one track stay visible. */
  offset: number
  active: boolean
}
export interface Network { nodes: NetNode[]; edges: NetEdge[] }

export interface LayoutOpts {
  orientation: Orientation
  showIdle: boolean
  /** Agents that live on a mesh peer (drawn in the remote district). */
  meshAgents: Set<string>
  agentName: (id: string) => string
  allAgents: string[]
  /** Limit to one line (phone line view). */
  lineId?: string
  /** Peer name(s) shown on the remote district. */
  districtName?: string
}

const SIZE = {
  channel: { w: 104, h: 30 },
  station: { w: 44, h: 44 },
  terminal: { w: 150, h: 38 },
  groupW: { horizontal: 236, vertical: 116 },
  pillH: 30,
}
export const MAX_PILLS = 3

const COL = { horizontal: [0, 250, 480, 640, 960], vertical: [0, 90, 200, 330, 0] }

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

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const code2 = (name: string) => {
  const w = name.replace(/[^\p{L}\p{N}\s-]/gu, "").split(/[\s-]+/).filter(Boolean)
  return ((w.length > 1 ? w[0][0] + w[1][0] : name.slice(0, 2)) || "?").toUpperCase()
}

export function layoutNetwork(transit: Transit, opts: LayoutOpts): Network {
  const H = opts.orientation === "horizontal"
  const lines = transit.lines.filter((l) => l.trains.length && (!opts.lineId || l.id === opts.lineId))
  const lineIdx = new Map(lines.map((l, i) => [l.id, i]))
  const trains = transit.trains.filter((t) => lineIdx.has(t.lineId))

  // One group per (station, line): the trains that line runs through it.
  const groupMap = new Map<string, { agent: string; line: Line; trains: Train[] }>()
  for (const t of trains) {
    const key = `${t.agentId}|${t.lineId}`
    const g = groupMap.get(key) ?? { agent: t.agentId, line: lines[lineIdx.get(t.lineId)!], trains: [] }
    g.trains.push(t)
    groupMap.set(key, g)
  }
  const isMesh = (a: string) => opts.meshAgents.has(a)
  // Keep each station's trains together (fewer crossings): mesh stations
  // first, then stations by the busiest line they serve.
  const stationRank = new Map<string, number>()
  for (const g of groupMap.values()) {
    stationRank.set(g.agent, Math.min(stationRank.get(g.agent) ?? Infinity, lineIdx.get(g.line.id)!))
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    Number(isMesh(b.agent)) - Number(isMesh(a.agent)) ||
    stationRank.get(a.agent)! - stationRank.get(b.agent)! ||
    a.agent.localeCompare(b.agent) ||
    lineIdx.get(a.line.id)! - lineIdx.get(b.line.id)!)

  const pillsOf = (n: number) => Math.min(n, MAX_PILLS)
  const groupH = (n: number) => pillsOf(n) * SIZE.pillH + (pillsOf(n) - 1) * 4
  // Main axis = across the tiers (x on desktop); cross axis = along a tier.
  const gw = SIZE.groupW[opts.orientation]
  const across = (g: { trains: Train[] }) => (H ? groupH(g.trains.length) : gw)
  let cursor = 0
  const groupCross = groups.map((g) => {
    const c = cursor + across(g) / 2
    cursor += across(g) + (H ? 22 : 8)
    return c
  })

  const delegators = [...new Set(trains.map((t) => t.delegator).filter((d): d is string => !!d))]
  const stationIds = [...new Set(groups.map((g) => g.agent))].filter((a) => !delegators.includes(a))
  const want = (agent: string) => mean(groups.flatMap((g, i) => (g.agent === agent ? [groupCross[i]] : [])))
  const gap = H ? 104 : 124
  const meshSt = stationIds.filter(isMesh), localSt = stationIds.filter((a) => !isMesh(a))
  const place = (ids: string[]) => spread(ids.map(want), gap)
  const stationCross = new Map<string, number>()
  meshSt.forEach((a, i) => stationCross.set(a, place(meshSt)[i]))
  const localPlaced = place(localSt)
  const meshBottom = meshSt.length ? Math.max(...meshSt.map((a) => stationCross.get(a)!)) + gap : -Infinity
  const push = localPlaced.length ? Math.max(0, meshBottom - Math.min(...localPlaced)) : 0
  localSt.forEach((a, i) => stationCross.set(a, localPlaced[i] + push))

  // Interchanges sit level with what they feed. One may feed another, so
  // settle the ones whose downstream is known first.
  const pending = new Set(delegators)
  const want2 = new Map<string, number>()
  for (let pass = 0; pass <= delegators.length && pending.size; pass++) {
    for (const d of [...pending]) {
      const down = trains.filter((t) => t.delegator === d).map((t) => t.agentId)
      if (pass < delegators.length && down.some((a) => pending.has(a) && a !== d)) continue
      want2.set(d, mean([
        ...down.map((a) => stationCross.get(a) ?? want2.get(a) ?? want(a)).filter((v) => Number.isFinite(v)),
        ...groups.flatMap((g, i) => (g.agent === d ? [groupCross[i]] : [])),
      ]))
      pending.delete(d)
    }
  }
  spread(delegators.map((d) => want2.get(d) ?? 0), gap).forEach((v, i) => stationCross.set(delegators[i], v))

  // Idle stations sit at the end of the station tier when asked for.
  const idle = opts.showIdle && !opts.lineId
    ? opts.allAgents.filter((a) => !stationCross.has(a))
    : []
  let tail = Math.max(cursor, ...[...stationCross.values()].map((v) => v + gap))
  for (const a of idle) { stationCross.set(a, tail); tail += gap * 0.75 }

  const termCross = spread(lines.map((l) => mean(groups.flatMap((g, i) => (g.line.id === l.id ? [groupCross[i]] : [])))), H ? 54 : 180)

  const used = new Set(trains.map((t) => t.channel))
  const channels = opts.lineId ? CHANNELS.filter((c) => used.has(c.id)) : CHANNELS
  const centre = mean([...stationCross.values()].length ? [...stationCross.values()] : [0])
  const chStep = H ? 50 : 120
  const chCross = channels.map((_, i) => centre + (i - (channels.length - 1) / 2) * chStep)

  const cols = COL[opts.orientation]
  const stationCol = delegators.length ? cols[2] : cols[1] + (H ? 60 : 0)
  const main = {
    channel: cols[0], interchange: cols[1], station: stationCol,
    group: H ? cols[3] + (delegators.length ? 0 : -60) : cols[3],
    terminal: H ? cols[4] + (delegators.length ? 0 : -60) : 0,
  }
  const at = (m: number, c: number, w: number, h: number) =>
    H ? { x: m, y: c - h / 2 } : { x: c - w / 2, y: m }

  const nodes: NetNode[] = []
  const edges: NetEdge[] = []
  const running = (ts: Train[]) => ts.some((t) => t.state === "running")

  channels.forEach((c, i) => {
    const s = SIZE.channel
    nodes.push({ id: `ch:${c.id}`, kind: "channel", ...at(main.channel, chCross[i], s.w, s.h), w: s.w, h: s.h, label: c.label, idle: !used.has(c.id) })
  })

  const stationSub = (a: string) => {
    const mine = trains.filter((t) => t.agentId === a)
    if (delegators.includes(a)) {
      const n = new Set(trains.filter((t) => t.delegator === a).map((t) => t.lineId)).size
      return `Interchange · ${n} ${n === 1 ? "line" : "lines"}`
    }
    if (!mine.length) return "idle"
    const top = STATE_ORDER.find((s) => mine.some((t) => t.state === s))!
    const n = mine.filter((t) => t.state === top).length
    return `${n} ${top === "review" ? "in review" : top}`
  }
  for (const [a, c] of stationCross) {
    const s = SIZE.station
    const mine = trains.filter((t) => t.agentId === a || t.delegator === a)
    nodes.push({
      id: `st:${a}`, kind: "station", ...at(delegators.includes(a) ? main.interchange : main.station, c, s.w, s.h), w: s.w, h: s.h,
      label: opts.agentName(a), code: code2(opts.agentName(a)), sub: stationSub(a),
      mesh: isMesh(a), interchange: delegators.includes(a), idle: !mine.length,
      running: running(mine), delayed: mine.some((t) => t.state === "delayed"),
    })
  }

  groups.forEach((g, i) => {
    const h = H ? groupH(g.trains.length) : groupH(g.trains.length)
    const w = gw
    const sorted = [...g.trains].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.lastAt - a.lastAt)
    const shown = sorted.slice(0, g.trains.length > MAX_PILLS ? MAX_PILLS - 1 : MAX_PILLS)
    const id = `gr:${g.agent}|${g.line.id}`
    nodes.push({
      id, kind: "trains", ...(H ? { x: main.group, y: groupCross[i] - h / 2 } : { x: groupCross[i] - w / 2, y: main.group }),
      w, h, label: g.line.name, color: g.line.color, lineId: g.line.id, trains: shown, more: g.trains.length - shown.length,
    })
    edges.push({ id: `${id}:in`, source: `st:${g.agent}`, target: id, kind: "track", color: g.line.color, lineId: g.line.id, offset: 0, active: running(g.trains) })
    edges.push({ id: `${id}:out`, source: id, target: `tm:${g.line.id}`, kind: "track", color: g.line.color, lineId: g.line.id, offset: 0, active: running(g.trains) })
  })

  lines.forEach((l, i) => {
    const s = SIZE.terminal
    const m = H ? main.terminal : Math.max(...groups.map((g) => groupH(g.trains.length))) + main.group + 60
    nodes.push({ id: `tm:${l.id}`, kind: "terminal", ...at(m, termCross[i], s.w, s.h), w: s.w, h: s.h, label: l.name, code: l.code, color: l.color, lineId: l.id, delayed: l.state === "delays" })
  })

  // Hand-offs: interchange → station, one coloured track per line.
  const handoffs = new Map<string, { from: string; to: string; line: Line; active: boolean }>()
  for (const t of trains) {
    if (!t.delegator) continue
    const key = `${t.delegator}|${t.agentId}|${t.lineId}`
    const h = handoffs.get(key) ?? { from: t.delegator, to: t.agentId, line: lines[lineIdx.get(t.lineId)!], active: false }
    h.active ||= t.state === "running"
    handoffs.set(key, h)
  }
  const perPair = new Map<string, number>()
  for (const h of handoffs.values()) {
    const pair = `${h.from}|${h.to}`
    const k = perPair.get(pair) ?? 0
    perPair.set(pair, k + 1)
    edges.push({ id: `ho:${h.from}|${h.to}|${h.line.id}`, source: `st:${h.from}`, target: `st:${h.to}`, kind: "track", color: h.line.color, lineId: h.line.id, offset: k * 8, active: h.active })
  }
  // Centre parallel tracks on their pair.
  for (const e of edges) if (e.id.startsWith("ho:")) {
    const n = perPair.get(e.id.slice(3).split("|").slice(0, 2).join("|"))!
    e.offset -= ((n - 1) * 8) / 2
  }

  // Feeders: channel → the first station a train reaches.
  const feeders = new Map<string, NetEdge>()
  for (const t of trains) {
    const first = t.delegator ?? t.agentId
    const id = `fd:${t.channel}|${first}`
    const e = feeders.get(id) ?? { id, source: `ch:${t.channel}`, target: `st:${first}`, kind: "feeder" as const, color: "", offset: 0, active: false }
    e.active ||= t.state === "running"
    feeders.set(id, e)
  }
  edges.push(...feeders.values())

  if (meshSt.length) {
    const ms = nodes.filter((n) => n.kind === "station" && n.mesh && !n.interchange)
    const pad = 26
    const x0 = Math.min(...ms.map((n) => n.x)) - (H ? 110 : pad), x1 = Math.max(...ms.map((n) => n.x + n.w)) + (H ? 130 : pad)
    const y0 = Math.min(...ms.map((n) => n.y)) - pad - 20, y1 = Math.max(...ms.map((n) => n.y + n.h)) + pad + 30
    nodes.unshift({ id: "district:mesh", kind: "district", x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: opts.districtName || "mesh", sub: `Remote district · ${meshSt.length} ${meshSt.length === 1 ? "station" : "stations"}` })
  }

  return { nodes, edges }
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
