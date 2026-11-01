import type { AgentHold } from "@/agents/holds"
import { orgRelations, parseMember, relationsProblem, type OrgRelation } from "./relations"
import { layoutOrg, type OrgPlacement } from "./org-layout"
import { departmentsProblem, orgDepartments, type OrgDepartment } from "./departments"

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

/** One card of the Wall's Org chart (#1419): an agent with its status, or a person. */
export interface OrgBox extends OrgPlacement {
  kind: "agent" | "person"
  id: string
  name: string
  title?: string
  status?: OrgStatus
  active?: number
  heldBy?: string
  /** The department it is in (#1681), by id. */
  department?: string
}

/** The chart laid out: cards by level and half-column, and every relation
 *  between two cards. See org-layout.ts. */
export interface OrgDiagram {
  boxes: OrgBox[]
  edges: OrgRelation[]
  columns: number
  levels: number
}

export interface OrgView {
  roots: OrgNode[]
  /** Agents with no entry in business.orgChart. */
  outside: OrgNode[]
  /** False when the daemon did not answer: working and idle are unknown. */
  live: boolean
  /** People from the top-level people list (#1418). `placed` when they are in
   *  business.orgPeople, with their role's title when it has one. */
  people: Array<{ id: string; name: string; placed?: true; title?: string }>
  /** Typed relations, reportsTo included, members as `agent:<id>` / `person:<id>`. */
  relations: OrgRelation[]
  /** Departments (#1681), members and head as `agent:<id>` / `person:<id>`. */
  departments: OrgDepartment[]
  /** The chart for the Wall's Org page (#1419). */
  diagram: OrgDiagram
  /** What is wrong with the relations, when something is; the daemon refuses
   *  to start the business layer on it. Else what is wrong with the
   *  departments, which only the chart shows. */
  problem?: string
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
    business?: { roles?: Record<string, any>; orgChart?: Record<string, any>; orgPeople?: Record<string, any>; relations?: any[]; departments?: Record<string, any> }
  },
  holds: Record<string, AgentHold>,
  live: Array<{ id: string; active?: number }> | null,
): OrgView {
  const agents = config.agents ?? {}
  const roles = config.business?.roles ?? {}
  const chart = config.business?.orgChart ?? {}
  const placed = config.business?.orgPeople ?? {}
  const activeOf = new Map((live ?? []).map((a) => [a.id, a.active ?? 0]))
  const relations = orgRelations(config.business)
  // Each agent's reports-to boss from the typed relations: a bare id for an
  // agent, `person:<id>` for a person, so `agent:` refs and relations nest too.
  const bossOf = new Map<string, string>()
  for (const r of relations) {
    const from = parseMember(r.from), to = parseMember(r.to)
    if (r.type === "reports-to" && from.kind === "agent" && !bossOf.has(from.id)) {
      bossOf.set(from.id, to.kind === "agent" ? to.id : r.to)
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
      id,
      name: a.name || id,
      ...(role?.title ? { title: role.title } : entry?.role ? { title: entry.role } : {}),
      ...(job ? { job } : {}),
      ...(bossOf.has(id) ? { reportsTo: bossOf.get(id) } : {}),
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
  const people = (config.people ?? []).filter((p) => p?.id).map((p) => {
    const role = placed[p.id]?.role
    const title = role ? roles[role]?.title || role : undefined
    return { id: p.id, name: p.name || p.id, ...(placed[p.id] ? { placed: true as const } : {}), ...(title ? { title } : {}) }
  })
  const departments = orgDepartments(config.business)
  const known = [new Set(Object.keys(chart)), new Set(people.map((p) => p.id))] as const
  const problem = relationsProblem(relations, ...known) ?? departmentsProblem(departments, ...known)
  const diagram = orgDiagram(nodes, config.people ?? [], people, relations, departments)
  return { roots, outside, live: live !== null, people, relations, departments, diagram, ...(problem ? { problem } : {}) }
}

const PERSON_TITLE: Record<string, string> = { owner: "Owner", client: "Client", guest: "Guest" }

/** The chart's cards: every agent in business.orgChart, every person in
 *  business.orgPeople, and every person a reports-to, a dotted-line or a
 *  department (#1681) names.
 *  A person only acted for shows as a chip on the agent's card, not as a card. */
function orgDiagram(
  nodes: Map<string, OrgNode>,
  people: Array<{ id: string; name?: string; role?: string }>,
  listed: OrgView["people"],
  relations: OrgRelation[],
  departments: OrgDepartment[],
): OrgDiagram {
  const named = new Set(relations.filter((r) => r.type !== "acts-for").flatMap((r) => [r.from, r.to]))
  const deptOf = new Map<string, string>()
  for (const d of departments) {
    if (d.head) named.add(d.head)
    for (const m of d.members) { named.add(m); if (!deptOf.has(m)) deptOf.set(m, d.id) }
  }
  const cards = new Map<string, Omit<OrgBox, keyof OrgPlacement>>()
  for (const n of nodes.values()) {
    cards.set(`agent:${n.id}`, {
      kind: "agent", id: n.id, name: n.name,
      ...(n.title ? { title: n.title } : {}),
      status: n.status,
      ...(n.active !== undefined ? { active: n.active } : {}),
      ...(n.heldBy ? { heldBy: n.heldBy } : {}),
    })
  }
  const byId = new Map(listed.map((p) => [p.id, p]))
  for (const p of people) {
    const shown = p?.id ? byId.get(p.id) : undefined
    if (!shown || !(shown.placed || named.has(`person:${p.id}`))) continue
    const title = shown.title ?? PERSON_TITLE[p.role ?? ""]
    cards.set(`person:${p.id}`, { kind: "person", id: p.id, name: p.name || p.id, ...(title ? { title } : {}) })
  }
  for (const [key, c] of cards) if (deptOf.has(key)) c.department = deptOf.get(key)
  const layout = layoutOrg([...cards].map(([key, c]) => ({ key, name: c.name, ...(c.department ? { group: c.department } : {}) })), relations)
  // acts-for edges keep a person who has no card, so the agent's chip can name them.
  const edges = [...layout.edges, ...relations.filter((r) => r.type === "acts-for" && cards.has(r.from) && !cards.has(r.to))]
  return { ...layout, edges, boxes: layout.boxes.map((b) => ({ ...cards.get(b.key)!, ...b })) }
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
