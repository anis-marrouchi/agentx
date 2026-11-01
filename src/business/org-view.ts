import type { AgentHold } from "@/agents/holds"
import { meshPeerNames, orgRelations, parseMember, relationsProblem, remoteAgent, type OrgRelation } from "./relations"
import { layoutOrg, type OrgPlacement } from "./org-layout"
import { departmentBoxes, departmentsProblem, orgDepartments, type DepartmentBox, type OrgDepartment, type Outsider } from "./departments"
import { orgProjects, projectsProblem } from "./org-projects"

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
  /** Clients and guests a relation joins it to: a line on the card, never a card. */
  worksWith?: Array<{ key: string; name: string; role: Outsider["role"] }>
  /** For an agent on another node (`agent:<node>/<id>`): where it is and how
   *  that node last answered. Shown, never routed to, not counted as staff. */
  remote?: RemoteSeen
}

/** A mesh peer as the daemon's /mesh lists it: whether it answers now, and
 *  the agents it last said it hosts (kept while it is down). */
export interface MeshPeerSeen { peer: string; healthy: boolean; skills?: Array<{ id: string; name?: string }> }

/** An agent on another node as last seen: `up` its node answers and lists it,
 *  `down` its node listed it before but does not answer now, `unseen` neither
 *  (or the daemon did not answer). The last two draw a grey card. */
export interface RemoteSeen { node: string; agent: string; seen: "up" | "down" | "unseen" }

/** An agent a mesh peer hosts that the chart does not place. */
export interface MeshAgent { node: string; id: string; name: string; healthy: boolean }

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
   *  business.orgPeople, with their role's title when it has one. `outsider`
   *  for a client or guest: not personnel, so never a card (Anis 11-01). */
  people: Array<{ id: string; name: string; placed?: true; title?: string; outsider?: Outsider["role"] }>
  /** Typed relations, reportsTo included, members as `agent:<id>` / `person:<id>`. */
  relations: OrgRelation[]
  /** Departments (#1681), members and head as `agent:<id>` / `person:<id>`. */
  departments: OrgDepartment[]
  /** The Departments view (#1681): a box per department, head on top, and
   *  `rest`, every card and agent outside the chart no department holds. */
  byDepartment: { boxes: DepartmentBox[]; rest: string[] }
  /** The chart for the Wall's Org page (#1419). */
  diagram: OrgDiagram
  /** Agents on mesh peers: `live` false when the daemon gave no peer list,
   *  `others` the agents peers host that no relation or department places. */
  mesh: { live: boolean; others: MeshAgent[] }
  /** The Projects view (#1687): each project with its lead, PM and team. */
  projects: OrgProjectView[]
  /** Chart members on no project as PM, lead or team (#1687). */
  notInProject: OrgProjectCard[]
  /** What is wrong with the relations, when something is; the daemon refuses
   *  to start the business layer on it. Else what is wrong with the
   *  departments or the projects' lead and team, which only the page shows. */
  problem?: string
}

/** One member's card on the Projects view (#1687). */
export interface OrgProjectCard {
  key: string
  kind: "agent" | "person"
  id: string
  name: string
  title?: string
  status?: OrgStatus
}

/** One project on the Projects view (#1687). An unknown id leaves no card;
 *  `problem` names it. The team leaves out the lead and the PM, shown above it. */
export interface OrgProjectView {
  id: string
  name: string
  client: string
  lead?: OrgProjectCard
  pm?: OrgProjectCard
  team: OrgProjectCard[]
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
    mesh?: { peers?: Array<{ name: string }> }
    business?: { roles?: Record<string, any>; orgChart?: Record<string, any>; orgPeople?: Record<string, any>; relations?: any[]; departments?: Record<string, any>; projects?: any[] }
  },
  holds: Record<string, AgentHold>,
  live: Array<{ id: string; active?: number }> | null,
  mesh: MeshPeerSeen[] | null = null,
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
      bossOf.set(from.id, to.kind === "agent" && !remoteAgent(r.to) ? to.id : r.to)
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
    const outsider = outsiderRole(p.role)
    return {
      id: p.id, name: p.name || p.id,
      ...(placed[p.id] ? { placed: true as const } : {}), ...(title ? { title } : {}), ...(outsider ? { outsider } : {}),
    }
  })
  const departments = orgDepartments(config.business)
  const known = [new Set(Object.keys(chart)), new Set(people.map((p) => p.id)), meshPeerNames(config)] as const
  const outsiders = new Map(people.flatMap((p) => (p.outsider ? [[p.id, { name: p.name, role: p.outsider }] as const] : [])))
  const list = orgProjects(config.business)
  const problem = relationsProblem(relations, ...known) ?? departmentsProblem(departments, ...known, outsiders) ?? projectsProblem(list, known[0], known[1])
  const diagram = orgDiagram(nodes, config.people ?? [], people, relations, departments, mesh)
  // People first, then agents, each by name; agents outside the chart last.
  const everyone = [...diagram.boxes].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1))
    .map((b) => b.key).concat(outside.map((n) => `agent:${n.id}`))
  const byDepartment = departmentBoxes(departments, everyone)
  const placedRemote = new Set(diagram.boxes.filter((b) => b.remote).map((b) => b.id))
  const others = (mesh ?? []).flatMap((p) => (p.skills ?? []).filter((s) => s?.id && !placedRemote.has(`${p.peer}/${s.id}`))
    .map((s) => ({ node: String(p.peer), id: String(s.id), name: String(s.name || s.id), healthy: p.healthy })))
    .sort((a, b) => a.node.localeCompare(b.node) || a.name.localeCompare(b.name))
  const { projects, notInProject } = projectsView(list, diagram, [...nodes.values(), ...outside], config.people ?? [], people)
  return { roots, outside, live: live !== null, people, relations, departments, byDepartment, diagram, mesh: { live: mesh !== null, others }, projects, notInProject, ...(problem ? { problem } : {}) }
}

/** The card of `agent:<node>/<id>` from the mesh peers' last answers. */
function remoteCard(key: string, mesh: MeshPeerSeen[] | null): Omit<OrgBox, keyof OrgPlacement> | undefined {
  const r = remoteAgent(key)
  if (!r) return undefined
  const peer = mesh?.find((p) => p.peer === r.node)
  const skill = peer?.skills?.find((s) => s?.id === r.id)
  const seen: RemoteSeen["seen"] = !skill ? "unseen" : peer!.healthy ? "up" : "down"
  return { kind: "agent", id: `${r.node}/${r.id}`, name: skill?.name || r.id, remote: { node: r.node, agent: r.id, seen } }
}

/** The Projects view (#1687): cards from the chart when the member has one,
 *  else from the agents and people lists. Members in no project are the
 *  chart's cards that no project names. */
function projectsView(
  list: ReturnType<typeof orgProjects>,
  diagram: OrgDiagram,
  agents: OrgNode[],
  people: Array<{ id: string; name?: string; role?: string }>,
  listed: OrgView["people"],
): Pick<OrgView, "projects" | "notInProject"> {
  const boxes = new Map(diagram.boxes.map((b) => [b.key, b]))
  const agentOf = new Map(agents.map((n) => [n.id, n]))
  const cardOf = (key: string): OrgProjectCard | undefined => {
    const b = boxes.get(key)
    if (b) return { key, kind: b.kind, id: b.id, name: b.name, ...(b.title ? { title: b.title } : {}), ...(b.status ? { status: b.status } : {}) }
    const m = parseMember(key)
    if (m.kind === "agent") {
      const n = agentOf.get(m.id)
      return n ? { key, kind: "agent", id: n.id, name: n.name, ...(n.title ? { title: n.title } : {}), status: n.status } : undefined
    }
    const p = people.find((x) => x.id === m.id)
    if (!p) return undefined
    const title = listed.find((x) => x.id === m.id)?.title ?? PERSON_TITLE[p.role ?? ""]
    return { key, kind: "person", id: p.id, name: p.name || p.id, ...(title ? { title } : {}) }
  }
  const named = new Set<string>()
  const projects = list.map((p) => {
    const lead = p.lead ? cardOf(p.lead) : undefined
    const pm = p.pm ? cardOf(p.pm) : undefined
    for (const k of [p.lead, p.pm, ...p.team]) if (k) named.add(k)
    const team = p.team.filter((k) => k !== p.lead && k !== p.pm).map(cardOf).filter((c): c is OrgProjectCard => !!c)
    return { id: p.id, name: p.name, client: p.client, ...(lead ? { lead } : {}), ...(pm ? { pm } : {}), team }
  })
  const notInProject = diagram.boxes.filter((b) => !named.has(b.key)).map((b) => cardOf(b.key)!)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "person" ? -1 : 1) || a.name.localeCompare(b.name))
  return { projects, notInProject }
}

const PERSON_TITLE: Record<string, string> = { owner: "Owner" }

/** `client` or `guest`: a person outside the organisation. Owners and members
 *  are personnel; a person written with no role is a member. */
function outsiderRole(role: string | undefined): Outsider["role"] | undefined {
  return role === "client" || role === "guest" ? role : undefined
}

/** The chart's cards: every agent in business.orgChart, every person in
 *  business.orgPeople, and every person a reports-to, a dotted-line or a
 *  department (#1681) names, when they are personnel (owner or member).
 *  A person only acted for shows as a chip on the agent's card, not as a card;
 *  a client or guest as a "works with" line (worksWith). */
function orgDiagram(
  nodes: Map<string, OrgNode>,
  people: Array<{ id: string; name?: string; role?: string }>,
  listed: OrgView["people"],
  relations: OrgRelation[],
  departments: OrgDepartment[],
  mesh: MeshPeerSeen[] | null,
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
    // Only personnel get a card: a client or guest never does (Anis 11-01).
    if (!shown || shown.outsider || !(shown.placed || named.has(`person:${p.id}`))) continue
    const title = shown.title ?? PERSON_TITLE[p.role ?? ""]
    cards.set(`person:${p.id}`, { kind: "person", id: p.id, name: p.name || p.id, ...(title ? { title } : {}) })
  }
  // Agents on other nodes: a card for each one a relation or department names.
  for (const key of named) {
    const card = !cards.has(key) && remoteCard(key, mesh)
    if (card) cards.set(key, card)
  }
  for (const [key, c] of cards) if (deptOf.has(key)) c.department = deptOf.get(key)
  // A reports-to or dotted-line to a client or guest is a line on the other
  // end's card, "works with Zahra (guest)", and no node or arrow.
  for (const r of relations) {
    if (r.type === "acts-for") continue
    for (const [mine, theirs] of [[r.from, r.to], [r.to, r.from]]) {
      const card = cards.get(mine), them = parseMember(theirs)
      const o = card && them.kind === "person" ? byId.get(them.id) : undefined
      if (!card || !o?.outsider || card.worksWith?.some((w) => w.key === theirs)) continue
      ;(card.worksWith ??= []).push({ key: theirs, name: o.name, role: o.outsider })
    }
  }
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
