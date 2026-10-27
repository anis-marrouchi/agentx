import type { AgentHold } from "@/agents/holds"
import { layoutOrg, orgKey, type OrgMemberKind, type OrgRelation, type OrgRelationType } from "./org-layout"

// --- The Org view's data (#1169), from agentx.json, the holds and the daemon ---
//
// A tree drawn from business.orgChart: each agent with its role's title, who
// it reports to, a one-line job and its status. Agents that are not in the
// org chart are listed apart, so a new agent never goes missing from the page.

export type OrgStatus = "working" | "idle" | "paused" | "waiting" | "unknown"

export interface OrgNode {
  id: string
  name: string
  title?: string
  job?: string
  reportsTo?: string
  status: OrgStatus
  /** Runs going on now, when the daemon answered. */
  active?: number
  /** For `paused`: who paused it. For `waiting`: the agent that created it. */
  heldBy?: string
  reports: OrgNode[]
}

/** One box of the diagram (#1419): an agent with its card, or a person. */
export interface OrgBox {
  key: string
  kind: OrgMemberKind
  id: string
  name: string
  title?: string
  job?: string
  status?: OrgStatus
  active?: number
  heldBy?: string
  level: number
  col: number
}

export interface OrgDiagram {
  boxes: OrgBox[]
  edges: OrgRelation[]
  columns: number
  levels: number
}

export interface OrgView {
  roots: OrgNode[]
  /** The same chart laid out for drawing, with people and typed relations. */
  diagram: OrgDiagram
  /** Agents with no entry in business.orgChart. */
  outside: OrgNode[]
  /** False when the daemon did not answer: working and idle are unknown. */
  live: boolean
}

const JOB_MAX = 140

/** The first sentence of `text`, at most JOB_MAX characters. */
export function firstLine(text: string | undefined): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  if (!t) return undefined
  const sentence = t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t
  return sentence.length > JOB_MAX ? `${sentence.slice(0, JOB_MAX - 1).trimEnd()}…` : sentence
}

export function buildOrgView(
  config: { agents?: Record<string, any>; business?: { roles?: Record<string, any>; orgChart?: Record<string, any> } },
  holds: Record<string, AgentHold>,
  live: Array<{ id: string; active?: number }> | null,
): OrgView {
  const agents = config.agents ?? {}
  const roles = config.business?.roles ?? {}
  const chart = config.business?.orgChart ?? {}
  const activeOf = new Map((live ?? []).map((a) => [a.id, a.active ?? 0]))

  const node = (id: string): OrgNode => {
    const a = agents[id] ?? {}
    const entry = chart[id]
    const role = entry ? roles[entry.role] : undefined
    const hold = holds[id]
    const active = activeOf.get(id)
    const job = firstLine(role?.responsibilities?.[0]) ?? firstLine(a.systemPrompt)
    const status: OrgStatus = hold?.kind === "approval" ? "waiting"
      : hold?.kind === "paused" ? "paused"
      : live === null || active === undefined ? "unknown"
      : active > 0 ? "working" : "idle"
    return {
      id,
      name: a.name || id,
      ...(role?.title ? { title: role.title } : entry?.role ? { title: entry.role } : {}),
      ...(job ? { job } : {}),
      ...(entry?.reportsTo ? { reportsTo: entry.reportsTo } : {}),
      status,
      ...(active !== undefined ? { active } : {}),
      ...(hold ? { heldBy: hold.by } : {}),
      reports: [],
    }
  }

  const inChart = Object.keys(chart).filter((id) => agents[id])
  const nodes = new Map(inChart.map((id) => [id, node(id)]))
  const roots: OrgNode[] = []
  for (const n of nodes.values()) {
    const boss = n.reportsTo ? nodes.get(n.reportsTo) : undefined
    // A boss that is not an agent here, or a loop, puts the agent at the top.
    if (boss && !reportsUpTo(nodes, boss.id, n.id)) boss.reports.push(n)
    else roots.push(n)
  }
  const byName = (a: OrgNode, b: OrgNode) => a.name.localeCompare(b.name)
  const sortDeep = (list: OrgNode[]) => { list.sort(byName); for (const n of list) sortDeep(n.reports) }
  sortDeep(roots)
  const outside = Object.keys(agents).filter((id) => !nodes.has(id)).map(node).sort(byName)
  return { roots, outside, diagram: orgDiagram(nodes), live: live !== null }
}

/** The chart's members and relations, laid out. Agents and their
 *  `reportsTo` for now; people and the other relation types come from
 *  the org chart once it holds them (#1418). */
function orgDiagram(nodes: Map<string, OrgNode>): OrgDiagram {
  const members = [...nodes.values()].map((n) => ({ key: orgKey("agent", n.id), name: n.name }))
  const relations: OrgRelation[] = [...nodes.values()].flatMap((n) => n.reportsTo
    ? [{ from: orgKey("agent", n.id), to: orgKey("agent", n.reportsTo), type: "reports-to" as OrgRelationType }]
    : [])
  const layout = layoutOrg(members, relations)
  const boxes = layout.boxes.map(({ key, level, col }): OrgBox => {
    const { reports: _reports, reportsTo: _boss, ...card } = nodes.get(key.slice("agent:".length))!
    return { key, kind: "agent", ...card, level, col }
  })
  return { ...layout, boxes }
}

/** Does `from` reach `target` by following reportsTo? */
function reportsUpTo(nodes: Map<string, OrgNode>, from: string, target: string): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = from
  while (cur && !seen.has(cur)) {
    if (cur === target) return true
    seen.add(cur)
    cur = nodes.get(cur)?.reportsTo
  }
  return false
}
