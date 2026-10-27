import type { AgentHold } from "@/agents/holds"
import { memberRef, refId, refKind, resolveOrgGraph, type MemberRef, type OrgRelation } from "./org-graph"

// --- The Org view's data (#1169), from agentx.json, the holds and the daemon ---
//
// A tree drawn from business.orgChart: each agent with its role's title, who
// it reports to, a one-line job and its status. Agents that are not in the
// org chart are listed apart, so a new agent never goes missing from the page.
// People from `people` sit in the tree once a relation names them (#1418);
// dotted-line and acts-for links are listed on the card and in `relations`.

export type OrgStatus = "working" | "idle" | "paused" | "waiting" | "unknown"

export interface OrgNode {
  /** `agent` or `person`; `id` is unique within a kind. */
  kind: "agent" | "person"
  id: string
  name: string
  title?: string
  job?: string
  /** The boss's agent id, when the boss is an agent. */
  reportsTo?: string
  /** The line manager, agent or person. */
  manager?: MemberRef
  /** Secondary managers. */
  dottedLine?: MemberRef[]
  /** For an agent: the people it works on behalf of. */
  actsFor?: MemberRef[]
  /** People always read "unknown": a person has no run status. */
  status: OrgStatus
  /** Runs going on now, when the daemon answered. */
  active?: number
  /** For `paused`: who paused it. For `waiting`: the agent that created it. */
  heldBy?: string
  reports: OrgNode[]
}

export interface OrgView {
  roots: OrgNode[]
  /** Agents with no entry in business.orgChart. */
  outside: OrgNode[]
  /** False when the daemon did not answer: working and idle are unknown. */
  live: boolean
  /** People in the chart, from `people`. */
  people: Array<{ id: string; name: string; role?: string }>
  /** Every valid typed relation, orgChart.reportsTo included. */
  relations: OrgRelation[]
  /** Why some links were skipped. Empty when the chart is valid. */
  problems: string[]
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
  config: {
    agents?: Record<string, any>
    people?: Array<{ id: string; name?: string; role?: string }>
    business?: { roles?: Record<string, any>; orgChart?: Record<string, any>; relations?: Array<{ from: string; to: string; type: string }> }
  },
  holds: Record<string, AgentHold>,
  live: Array<{ id: string; active?: number }> | null,
): OrgView {
  const agents = config.agents ?? {}
  const roles = config.business?.roles ?? {}
  // An org-chart entry for an agent that is not configured is left out.
  const chart = Object.fromEntries(Object.entries(config.business?.orgChart ?? {}).filter(([id]) => agents[id]))
  const graph = resolveOrgGraph({ orgChart: chart, relations: config.business?.relations }, Array.isArray(config.people) ? config.people : [])
  const activeOf = new Map((live ?? []).map((a) => [a.id, a.active ?? 0]))

  const linksOf = (from: MemberRef) => {
    const dotted = graph.relations.filter((r) => r.from === from && r.type === "dotted-line").map((r) => r.to)
    const actsFor = graph.relations.filter((r) => r.from === from && r.type === "acts-for").map((r) => r.to)
    const manager = graph.managerOf.get(from)
    return {
      ...(manager && refKind(manager) === "agent" ? { reportsTo: refId(manager) } : {}),
      ...(manager ? { manager } : {}),
      ...(dotted.length ? { dottedLine: dotted } : {}),
      ...(actsFor.length ? { actsFor } : {}),
    }
  }

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
      kind: "agent",
      id,
      name: a.name || id,
      ...(role?.title ? { title: role.title } : entry?.role ? { title: entry.role } : {}),
      ...(job ? { job } : {}),
      ...(entry ? linksOf(memberRef("agent", id)) : {}),
      status,
      ...(active !== undefined ? { active } : {}),
      ...(hold ? { heldBy: hold.by } : {}),
      reports: [],
    }
  }

  const personNode = (p: { id: string; name: string; role?: string }): OrgNode => ({
    kind: "person",
    id: p.id,
    name: p.name,
    ...(p.role ? { title: p.role } : {}),
    ...linksOf(memberRef("person", p.id)),
    status: "unknown",
    reports: [],
  })

  const nodes = new Map<MemberRef, OrgNode>()
  for (const id of Object.keys(chart)) nodes.set(memberRef("agent", id), node(id))
  for (const p of graph.people.values()) nodes.set(memberRef("person", p.id), personNode(p))
  const roots: OrgNode[] = []
  for (const [key, n] of nodes) {
    // resolveOrgGraph has already broken loops and dropped unknown bosses.
    const boss = graph.managerOf.get(key)
    const parent = boss ? nodes.get(boss) : undefined
    if (parent) parent.reports.push(n)
    else roots.push(n)
  }
  const byName = (a: OrgNode, b: OrgNode) => a.name.localeCompare(b.name)
  const sortDeep = (list: OrgNode[]) => { list.sort(byName); for (const n of list) sortDeep(n.reports) }
  sortDeep(roots)
  const outside = Object.keys(agents).filter((id) => !chart[id]).map(node).sort(byName)
  return {
    roots,
    outside,
    live: live !== null,
    people: [...graph.people.values()],
    relations: graph.relations,
    problems: graph.problems,
  }
}
