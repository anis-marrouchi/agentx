// Transit map layout — places initiators, channels, stations (agents), train
// groups and line terminals. Pure so it can be tested; TransitMap.tsx only renders.
// Horizontal (desktop): initiators | channels | interchanges | stations | trains | terminals.
// Vertical (phone line view): the same tiers top to bottom, for one line.

import { CHANNELS, STARTER_KIND, STATE_ORDER, channelLabel, type Line, type Train, type Transit } from "./transit"
import type { Starter } from "./api"
import { crossesBox, drawnRoute, metroPoints, spread, type Orientation, type Via } from "./transit-geometry"

export { COLLAPSE_AT, crossesBox, drawnRoute, metroPath, metroPoints, spread, type Orientation } from "./transit-geometry"

/** "trains", not "group": xyflow styles its built-in "group" node type. */
export type NetKind = "starter" | "channel" | "station" | "trains" | "terminal" | "district"

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
  /** Initiator: a person, AgentX or an external system. */
  starterKind?: Starter["kind"]
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
  /** A hand-off track (from → to), clickable for its hops. */
  hop?: { from: string; to: string }
  /** Collapsed middle hops on this track ("+2"), and the trains to expand. */
  hidden?: number
  trainIds?: string[]
  /** Feeder: the channel it starts from. */
  channel?: string
  /** Feeder into a channel: the initiator it starts from. */
  starter?: string
  /** Perpendicular shift so parallel lines on one track stay visible. */
  offset: number
  /** Feeder: the level stretch it takes past stations it does not call at. */
  via?: Via
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
  /** Trains whose long routes are drawn in full. */
  expanded?: Set<string>
}

const SIZE = {
  starter: { w: 124, h: 30 },
  channel: { w: 104, h: 30 },
  station: { w: 44, h: 44 },
  terminal: { w: 150, h: 38 },
  groupW: { horizontal: 236, vertical: 116 },
  pillH: 30,
}
export const MAX_PILLS = 3
/** Room a feeder leaves around a station it does not call at. */
const STATION_CLEAR = 10

const COL = { horizontal: [0, 250, 480, 640, 960], vertical: [0, 90, 200, 330, 0] }
/** How far before the channels the initiators sit. */
const STARTER_GAP = { horizontal: 190, vertical: 64 }
/** Distance between hop columns (interchanges at depth 0, 1, …). */
const HUB_STEP = { horizontal: 200, vertical: 110 }

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

  // Interchanges: agents that hand work on, one column per hop depth.
  const drawn = new Map(trains.map((t) => [t.id, drawnRoute(t.route, !!opts.expanded?.has(t.id))]))
  const depth = new Map<string, number>()
  for (const { agents } of drawn.values()) agents.slice(0, -1).forEach((a, i) => depth.set(a, Math.max(depth.get(a) ?? 0, i)))
  const delegators = [...depth.keys()]
  const hubCols = delegators.length ? Math.max(...depth.values()) + 1 : 0
  const next = (a: string) => [...drawn.values()].flatMap(({ agents }) => agents.flatMap((x, i) => (x === a && i < agents.length - 1 ? [agents[i + 1]] : [])))
  const stationIds = [...new Set(groups.map((g) => g.agent))].filter((a) => !depth.has(a))
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

  // Interchanges sit level with what they feed, deepest column first so
  // each one knows where its downstream landed.
  for (let k = hubCols - 1; k >= 0; k--) {
    const col = delegators.filter((d) => depth.get(d) === k)
    const wantHub = (d: string) => mean([
      ...next(d).map((a) => stationCross.get(a) ?? want(a)).filter((v) => Number.isFinite(v)),
      ...groups.flatMap((g, i) => (g.agent === d ? [groupCross[i]] : [])),
    ])
    spread(col.map((d) => wantHub(d) || 0), gap).forEach((v, i) => stationCross.set(col[i], v))
  }

  // Idle stations sit at the end of the station tier when asked for.
  const idle = opts.showIdle && !opts.lineId
    ? opts.allAgents.filter((a) => !stationCross.has(a))
    : []
  let tail = Math.max(cursor, ...[...stationCross.values()].map((v) => v + gap))
  for (const a of idle) { stationCross.set(a, tail); tail += gap * 0.75 }

  const termCross = spread(lines.map((l) => mean(groups.flatMap((g, i) => (g.line.id === l.id ? [groupCross[i]] : [])))), H ? 54 : 180)

  const used = new Set(trains.map((t) => t.channel))
  // A channel outside the board's list (Slack, say) still gets its node.
  const unlisted = [...used].filter((id) => !CHANNELS.some((c) => c.id === id)).map((id) => ({ id, label: channelLabel(id) }))
  const channels = [...CHANNELS, ...unlisted].filter((c) => !opts.lineId || used.has(c.id))
  const centre = mean([...stationCross.values()].length ? [...stationCross.values()] : [0])
  const chStep = H ? 50 : 120
  const chCross = channels.map((_, i) => centre + (i - (channels.length - 1) / 2) * chStep)

  // Initiators: who or what started the trains shown, each level with the
  // channels its work came in through.
  const chAt = new Map(channels.map((c, i) => [c.id, chCross[i]]))
  const starterWant = (id: string) => mean(trains.filter((t) => t.starter.id === id).map((t) => chAt.get(t.channel) ?? centre))
  const starters = [...new Map(trains.map((t) => [t.starter.id, t.starter])).values()]
    .sort((a, b) => starterWant(a.id) - starterWant(b.id) || a.name.localeCompare(b.name))
  const inStep = H ? 50 : 136
  const inCross = starters.map((_, i) => centre + (i - (starters.length - 1) / 2) * inStep)

  const cols = COL[opts.orientation]
  const extra = Math.max(0, hubCols - 1) * HUB_STEP[opts.orientation]
  const shift = hubCols ? extra : H ? -60 : 0
  const main = {
    starter: cols[0] - STARTER_GAP[opts.orientation],
    channel: cols[0],
    hub: (a: string) => cols[1] + (depth.get(a) ?? 0) * HUB_STEP[opts.orientation],
    station: hubCols ? cols[2] + extra : cols[1] + (H ? 60 : 0),
    group: cols[3] + shift,
    terminal: H ? cols[4] + shift : 0,
  }
  const at = (m: number, c: number, w: number, h: number) =>
    H ? { x: m, y: c - h / 2 } : { x: c - w / 2, y: m }

  const nodes: NetNode[] = []
  const edges: NetEdge[] = []
  const running = (ts: Train[]) => ts.some((t) => t.state === "running")
  const through = (a: string) => trains.filter((t) => drawn.get(t.id)!.agents.includes(a))

  starters.forEach((p, i) => {
    const s = SIZE.starter
    nodes.push({ id: `in:${p.id}`, kind: "starter", ...at(main.starter, inCross[i], s.w, s.h), w: s.w, h: s.h, label: p.name, sub: STARTER_KIND[p.kind], starterKind: p.kind })
  })

  channels.forEach((c, i) => {
    const s = SIZE.channel
    nodes.push({ id: `ch:${c.id}`, kind: "channel", ...at(main.channel, chCross[i], s.w, s.h), w: s.w, h: s.h, label: c.label, idle: !used.has(c.id) })
  })

  const stationSub = (a: string) => {
    const mine = trains.filter((t) => t.agentId === a)
    if (depth.has(a)) {
      const n = new Set(through(a).filter((t) => t.agentId !== a).map((t) => t.lineId)).size
      return `Interchange · ${n} ${n === 1 ? "line" : "lines"}`
    }
    if (!mine.length) return "idle"
    const top = STATE_ORDER.find((s) => mine.some((t) => t.state === s))!
    const n = mine.filter((t) => t.state === top).length
    return `${n} ${top === "review" ? "in review" : top}`
  }
  for (const [a, c] of stationCross) {
    const s = SIZE.station
    const mine = through(a)
    nodes.push({
      id: `st:${a}`, kind: "station", ...at(depth.has(a) ? main.hub(a) : main.station, c, s.w, s.h), w: s.w, h: s.h,
      label: opts.agentName(a), code: code2(opts.agentName(a)), sub: stationSub(a),
      mesh: isMesh(a), interchange: depth.has(a), idle: !mine.length,
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

  // Hand-offs: one coloured track per line for each hop drawn; a collapsed
  // route's first track carries its hidden hops ("+2").
  const handoffs = new Map<string, NetEdge>()
  for (const t of trains) {
    const { agents, hidden } = drawn.get(t.id)!
    const line = lines[lineIdx.get(t.lineId)!]
    for (let i = 0; i < agents.length - 1; i++) {
      const from = agents[i], to = agents[i + 1]
      const id = `ho:${from}|${to}|${line.id}`
      const e = handoffs.get(id) ?? { id, source: `st:${from}`, target: `st:${to}`, kind: "track" as const, color: line.color, lineId: line.id, hop: { from, to }, offset: 0, active: false }
      e.active ||= t.state === "running"
      if (i === 0 && hidden) {
        e.hidden = Math.max(e.hidden ?? 0, hidden)
        e.trainIds = [...(e.trainIds ?? []), t.id]
      }
      handoffs.set(id, e)
    }
  }
  // Feeders: the initiator into the channel the work came through, then the
  // channel into the first agent.
  const feeders = new Map<string, NetEdge>()
  const links = new Map<string, NetEdge>()
  for (const t of trains) {
    const first = drawn.get(t.id)!.agents[0]
    const line = lines[lineIdx.get(t.lineId)!]
    const id = `fd:${t.channel}|${first}|${line.id}`
    const e = feeders.get(id) ?? { id, source: `ch:${t.channel}`, target: `st:${first}`, kind: "feeder" as const, color: line.color, lineId: line.id, channel: t.channel, offset: 0, active: false }
    e.active ||= t.state === "running"
    feeders.set(id, e)
    const lid = `sf:${t.starter.id}|${t.channel}|${line.id}`
    const l = links.get(lid) ?? { id: lid, source: `in:${t.starter.id}`, target: `ch:${t.channel}`, kind: "feeder" as const, color: line.color, lineId: line.id, starter: t.starter.id, offset: 0, active: false }
    l.active ||= t.state === "running"
    links.set(lid, l)
  }
  // Parallel lines on one pair sit side by side, centred on the pair.
  for (const set of [handoffs, feeders, links]) {
    const perPair = new Map<string, Array<NetEdge>>()
    for (const e of set.values()) {
      const pair = `${e.source}|${e.target}`
      perPair.set(pair, [...(perPair.get(pair) ?? []), e])
    }
    for (const es of perPair.values()) es.forEach((e, k) => { e.offset = k * 8 - ((es.length - 1) * 8) / 2 })
    edges.push(...set.values())
  }
  // A feeder that runs past the interchange columns must not look like it
  // calls at one: when its path would touch a station that is not its own,
  // it passes those columns level, through the nearest free gap.
  const stations = nodes.filter((n) => n.kind === "station")
  const nodeAt = new Map(nodes.map((n) => [n.id, n]))
  // Main axis = across the tiers, cross axis = along a tier, as above.
  const box = (n: NetNode) => (H ? { m0: n.x, m1: n.x + n.w, c0: n.y, c1: n.y + n.h } : { m0: n.y, m1: n.y + n.h, c0: n.x, c1: n.x + n.w })
  for (const e of feeders.values()) {
    const s = nodeAt.get(e.source)!, t = nodeAt.get(e.target)!
    const sb = box(s), tb = box(t)
    const pts = (via?: Via) => H
      ? metroPoints(s.x + s.w, s.y + s.h / 2, t.x, t.y + t.h / 2, "horizontal", e.offset, via)
      : metroPoints(s.x + s.w / 2, s.y + s.h, t.x + t.w / 2, t.y, "vertical", e.offset, via)
    const touches = (via?: Via) => stations.some((n) => n.id !== e.target && crossesBox(pts(via), n, STATION_CLEAR))
    const passed = stations.filter((n) => n.id !== e.target && box(n).m1 < tb.m0).map(box)
    if (!passed.length || !touches()) continue
    const m0 = Math.min(...passed.map((b) => b.m0)) - STATION_CLEAR, m1 = Math.max(...passed.map((b) => b.m1)) + STATION_CLEAR
    const from = (sb.c0 + sb.c1) / 2, to = (tb.c0 + tb.c1) / 2
    const ideal = from + (to - from) * (((m0 + m1) / 2 - sb.m1) / Math.max(1, tb.m0 - sb.m1))
    const free = (c: number) => passed.every((b) => c + e.offset < b.c0 - STATION_CLEAR || c + e.offset > b.c1 + STATION_CLEAR)
    // Stay on the channel's side of a station where there is room, so the
    // line does not sweep past that station's name on the way.
    const swept = (c: number) => passed.filter((b) => ((b.c0 + b.c1) / 2 - from) * ((b.c0 + b.c1) / 2 - c) < 0).length
    const gaps = passed.flatMap((b) => [b.c0 - STATION_CLEAR - 1 - e.offset, b.c1 + STATION_CLEAR + 1 - e.offset]).filter(free)
    const c = gaps.sort((a, b) => swept(a) - swept(b) || Math.abs(a - ideal) - Math.abs(b - ideal))[0]
    if (c !== undefined && !touches({ m0, m1, c })) e.via = { m0, m1, c }
  }

  if (meshSt.length) {
    const ms = nodes.filter((n) => n.kind === "station" && n.mesh && !n.interchange)
    const pad = 26
    const x0 = Math.min(...ms.map((n) => n.x)) - (H ? 110 : pad), x1 = Math.max(...ms.map((n) => n.x + n.w)) + (H ? 130 : pad)
    const y0 = Math.min(...ms.map((n) => n.y)) - pad - 20, y1 = Math.max(...ms.map((n) => n.y + n.h)) + pad + 30
    nodes.unshift({ id: "district:mesh", kind: "district", x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: opts.districtName || "mesh", sub: `Remote district · ${meshSt.length} ${meshSt.length === 1 ? "station" : "stations"}` })
  }

  return { nodes, edges }
}
