// Map perspective — pure snapshot → graph transform. No React here so the
// shape can be unit-tested: channels on the left, then agents that delegate
// (orchestrators), then the agents doing the work (mesh peers in their own
// cluster), projects on the right. Edges are the dispatches in the window;
// an agent-started dispatch is a delegation edge between two agents.

import type { FleetDispatch, FleetSnapshot } from "./api"

export type MapNodeKind = "channel" | "agent" | "project"
export type MapEdgeKind = "dispatch" | "delegation" | "work"
export type Orientation = "horizontal" | "vertical"

export interface MapNode {
  id: string
  kind: MapNodeKind
  label: string
  sub?: string
  color: string
  count: number
  active: number
  mesh: boolean
  x: number
  y: number
}
export interface MapEdge {
  id: string
  source: string
  target: string
  kind: MapEdgeKind
  count: number
  active: boolean
  dispatchIds: string[]
}
export interface MapCluster { id: string; label: string; x: number; y: number; w: number; h: number }
export interface MapGraph { nodes: MapNode[]; edges: MapEdge[]; clusters: MapCluster[] }

/** The channels an operator expects to see, in ring order. Unknown ids
 *  still render (after these) when they carry traffic. */
export const MAP_CHANNELS: Array<{ id: string; label: string; color: string }> = [
  { id: "whatsapp", label: "WhatsApp", color: "#25d366" },
  { id: "telegram", label: "Telegram", color: "#0088cc" },
  { id: "voice", label: "Voice", color: "#e5534b" },
  { id: "desktop", label: "Desktop", color: "#8957e5" },
  { id: "api", label: "Web API", color: "#3a7bd5" },
  { id: "gitlab", label: "GitLab", color: "#fc6d26" },
  { id: "github", label: "GitHub", color: "#6e7681" },
  { id: "cron", label: "Cron", color: "#6b7280" },
  { id: "mesh", label: "Mesh (A2A)", color: "#bf8700" },
]
/** Agent-to-agent transports collapse into the one Mesh node. */
const MESH_CHANNELS = new Set(["mesh", "a2a", "mcp"])

export function mapChannelId(channelId: string): string {
  return MESH_CHANNELS.has(channelId) ? "mesh" : channelId
}

/** Agent that started this dispatch, if it was a delegation. */
export function delegatorOf(d: FleetDispatch): string | null {
  if (d.initiatorKind !== "a2a") return null
  if (!d.initiatorId || d.initiatorId.startsWith("__")) return null
  return d.initiatorId
}

/** "noqta/minbar" → "minbar"; "mtgl/_mesh" → "mtgl"; "unmapped/*" → "unmapped". */
export function projectLabel(projectId: string): { key: string; label: string; sub?: string } {
  const [head, ...rest] = projectId.split("/")
  if (head === "unmapped") return { key: "unmapped", label: "Unmapped" }
  const tail = rest.join("/")
  if (!tail || tail.startsWith("_")) return { key: `${head}/_`, label: head, sub: "client" }
  return { key: projectId, label: rest[rest.length - 1], sub: head }
}

// Layout constants — node boxes are sized in styles.css to match.
const H = { colGap: 340, rowGap: 64, clusterGap: 56 }
const V = { perRow: 3, cellW: 124, cellH: 84, tierGap: 70, clusterGap: 40 }
const NODE = { horizontal: { w: 180, h: 46 }, vertical: { w: 112, h: 58 } }
const PAD = 16

interface Acc { node: Omit<MapNode, "x" | "y">; nodeHits: Map<string, number> }

export function buildMapGraph(
  snap: FleetSnapshot,
  dispatches: FleetDispatch[],
  opts: { showIdle: boolean; orientation: Orientation },
): MapGraph {
  const local = snap.localNodeId
  const accs = new Map<string, Acc>()
  const edges = new Map<string, MapEdge>()
  const colorOf = new Map(snap.channels.map((c) => [c.id, c.color]))
  const agentName = new Map(snap.agents.map((a) => [a.id, a.name]))

  const touch = (id: string, make: () => Omit<MapNode, "x" | "y">): Acc => {
    let a = accs.get(id)
    if (!a) { a = { node: make(), nodeHits: new Map() }; accs.set(id, a) }
    return a
  }
  const channelNode = (id: string) => touch(`ch:${id}`, () => {
    const def = MAP_CHANNELS.find((c) => c.id === id)
    const label = def?.label ?? snap.channels.find((c) => c.id === id)?.label ?? id
    return { id: `ch:${id}`, kind: "channel", label, color: def?.color ?? colorOf.get(id) ?? "#6b7280", count: 0, active: 0, mesh: false }
  })
  const agentNode = (id: string) => touch(`ag:${id}`, () => ({
    id: `ag:${id}`, kind: "agent", label: agentName.get(id) || id, color: "#3a7bd5", count: 0, active: 0, mesh: false,
  }))
  const projectNode = (projectId: string, clientColor: string) => {
    const p = projectLabel(projectId)
    return touch(`pj:${p.key}`, () => ({
      id: `pj:${p.key}`, kind: "project", label: p.label, sub: p.sub,
      color: p.key === "unmapped" ? "#d29922" : clientColor, count: 0, active: 0, mesh: false,
    }))
  }
  const edge = (source: string, target: string, kind: MapEdgeKind, d: FleetDispatch) => {
    const id = `${source}->${target}`
    let e = edges.get(id)
    if (!e) { e = { id, source, target, kind, count: 0, active: false, dispatchIds: [] }; edges.set(id, e) }
    e.count++
    e.dispatchIds.push(d.id)
    if (d.active) e.active = true
  }
  const bump = (a: Acc, d: FleetDispatch) => { a.node.count++; if (d.active) a.node.active++ }

  if (opts.showIdle) {
    for (const c of MAP_CHANNELS) channelNode(c.id)
    for (const a of snap.agents) agentNode(a.id)
  }

  const clientColor = new Map(snap.clients.map((c) => [c.id, c.color]))
  for (const d of dispatches) {
    const agent = agentNode(d.agentId)
    bump(agent, d)
    if (d.nodeId) agent.nodeHits.set(d.nodeId, (agent.nodeHits.get(d.nodeId) || 0) + 1)

    const from = delegatorOf(d)
    if (from) {
      const src = agentNode(from)
      if (d.active) src.node.active++
      edge(src.node.id, agent.node.id, "delegation", d)
    } else {
      const ch = channelNode(mapChannelId(d.channelId))
      bump(ch, d)
      edge(ch.node.id, agent.node.id, "dispatch", d)
    }

    const pj = projectNode(d.projectId, clientColor.get(d.clientId) || "#6b7280")
    bump(pj, d)
    edge(agent.node.id, pj.node.id, "work", d)
  }

  // Which node an agent runs on: where most of its dispatches ran. Agents
  // seen only as delegators stay local — that's where the call came from.
  const withEdges = new Set<string>()
  for (const e of edges.values()) { withEdges.add(e.source); withEdges.add(e.target) }
  const kept: Array<Omit<MapNode, "x" | "y">> = []
  for (const a of accs.values()) {
    if (a.node.kind === "agent") {
      const home = [...a.nodeHits.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
      if (home && local && home !== local) { a.node.mesh = true; a.node.sub = home }
    }
    if (opts.showIdle || a.node.count > 0 || withEdges.has(a.node.id)) kept.push(a.node)
  }

  const byWeight = (x: { count: number; label: string }, y: { count: number; label: string }) =>
    y.count - x.count || x.label.localeCompare(y.label)
  const channelOrder = (id: string) => {
    const i = MAP_CHANNELS.findIndex((c) => `ch:${c.id}` === id)
    return i < 0 ? MAP_CHANNELS.length : i
  }
  const channels = kept.filter((n) => n.kind === "channel").sort((a, b) => channelOrder(a.id) - channelOrder(b.id) || a.label.localeCompare(b.label))
  const delegators = new Set([...edges.values()].filter((e) => e.kind === "delegation").map((e) => e.source))
  const orchestrators = kept.filter((n) => n.kind === "agent" && !n.mesh && delegators.has(n.id)).sort(byWeight)
  const localAgents = kept.filter((n) => n.kind === "agent" && !n.mesh && !delegators.has(n.id)).sort(byWeight)
  const meshAgents = kept.filter((n) => n.kind === "agent" && n.mesh).sort(byWeight)
  const projects = kept.filter((n) => n.kind === "project").sort(byWeight)

  const placed = opts.orientation === "horizontal"
    ? layoutColumns(channels, orchestrators, localAgents, meshAgents, projects)
    : layoutRows(channels, orchestrators, localAgents, meshAgents, projects)

  return { nodes: placed.nodes, edges: [...edges.values()], clusters: placed.clusters }
}

type Bare = Omit<MapNode, "x" | "y">

function meshCluster(nodes: MapNode[], size: { w: number; h: number }): MapCluster[] {
  const mesh = nodes.filter((n) => n.mesh)
  if (!mesh.length) return []
  const xs = mesh.map((n) => n.x), ys = mesh.map((n) => n.y)
  const x = Math.min(...xs) - PAD, y = Math.min(...ys) - PAD - 18
  const w = Math.max(...xs) + size.w + PAD - x, h = Math.max(...ys) + size.h + PAD - y
  const peers = [...new Set(mesh.map((n) => n.sub).filter(Boolean))]
  return [{ id: "cluster:mesh", label: `Mesh · ${peers.join(", ")}`, x, y, w, h }]
}

function layoutColumns(channels: Bare[], orchestrators: Bare[], localAgents: Bare[], meshAgents: Bare[], projects: Bare[]) {
  const column = (list: Bare[], x: number, extraGapAt = -1): MapNode[] => {
    const gap = extraGapAt >= 0 && extraGapAt < list.length ? H.clusterGap : 0
    const height = Math.max(0, list.length - 1) * H.rowGap + gap
    return list.map((n, i) => ({ ...n, x, y: i * H.rowGap + (extraGapAt >= 0 && i >= extraGapAt ? gap : 0) - height / 2 }))
  }
  const lead = orchestrators.length ? 1 : 0
  const nodes = [
    ...column(channels, 0),
    ...column(orchestrators, H.colGap),
    ...column([...localAgents, ...meshAgents], H.colGap * (1 + lead), meshAgents.length ? localAgents.length : -1),
    ...column(projects, H.colGap * (2 + lead)),
  ]
  return { nodes, clusters: meshCluster(nodes, NODE.horizontal) }
}

function layoutRows(channels: Bare[], orchestrators: Bare[], localAgents: Bare[], meshAgents: Bare[], projects: Bare[]) {
  const nodes: MapNode[] = []
  let top = 0
  const block = (list: Bare[], gapAfter: number) => {
    if (!list.length) return
    list.forEach((n, i) => {
      const row = Math.floor(i / V.perRow)
      const inRow = Math.min(V.perRow, list.length - row * V.perRow)
      const col = i % V.perRow
      nodes.push({ ...n, x: (col - (inRow - 1) / 2) * V.cellW - NODE.vertical.w / 2, y: top + row * V.cellH })
    })
    top += Math.ceil(list.length / V.perRow) * V.cellH + gapAfter
  }
  block(channels, V.tierGap)
  block(orchestrators, V.tierGap)
  block(localAgents, meshAgents.length ? V.clusterGap : V.tierGap)
  block(meshAgents, V.tierGap)
  block(projects, 0)
  return { nodes, clusters: meshCluster(nodes, NODE.vertical) }
}

/** Latest dispatches behind a node or edge, newest first. */
export function itemsFor(sel: { nodeId?: string; edge?: MapEdge }, dispatches: FleetDispatch[], limit = 25): FleetDispatch[] {
  let hit: (d: FleetDispatch) => boolean
  if (sel.edge) {
    const ids = new Set(sel.edge.dispatchIds)
    hit = (d) => ids.has(d.id)
  } else if (sel.nodeId) {
    const [kind, ...rest] = sel.nodeId.split(":")
    const id = rest.join(":")
    if (kind === "ch") hit = (d) => !delegatorOf(d) && mapChannelId(d.channelId) === id
    else if (kind === "ag") hit = (d) => d.agentId === id || delegatorOf(d) === id
    else hit = (d) => projectLabel(d.projectId).key === id
  } else return []
  return dispatches.filter(hit).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

/** Issue / MR / PR number named by a dispatch: the subject first
 *  ("issue:152", "MR #51", "pull:16"), then only the leading header of a
 *  relayed webhook ("[GitLab ns/repo MR !51 update]") — a body can mention
 *  any number of unrelated MRs. */
function forgeRef(d: FleetDispatch): { kind: "issue" | "mr"; n: string } | null {
  const s = d.subject.match(/\b(issue|merge_request|pull|MR|Issue)s?[:\s]+[#!]?(\d+)/)
  const m = s ?? d.inputPreview.match(/^\[(?:GitLab|GitHub) \S+ (issue|merge_request|pull|MR|Issue)s? [#!]?(\d+)/i)
  if (!m) return null
  return { kind: /^issue/i.test(m[1]) ? "issue" : "mr", n: m[2] }
}

/** Link for a dispatch's issue / MR / PR, when it names one. */
export function linkFor(d: FleetDispatch, forges: FleetSnapshot["forges"] = {}): string | null {
  const project = d.projectId
  if (!project.includes("/") || project.split("/")[1].startsWith("_")) return null
  const ref = forgeRef(d)
  if (!ref) return null
  if (d.channelId === "github" || /\bpull:\d+/.test(d.subject)) {
    return `${forges.github || "https://github.com"}/${project}/${ref.kind === "mr" ? "pull" : "issues"}/${ref.n}`
  }
  const gitlab = forges.gitlab?.replace(/\/+$/, "")
  if (!gitlab) return null
  return `${gitlab}/${project}/-/${ref.kind === "mr" ? "merge_requests" : "issues"}/${ref.n}`
}
