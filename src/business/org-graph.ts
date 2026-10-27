// --- The org chart as members and typed relations (#1418) ---
//
// A member is `agent:<id>` (an agent in business.orgChart) or `person:<id>`
// (a person from the top-level `people` list). Members are linked by typed
// relations:
//
//   reports-to   line manager; at most one per member, no cycles. The only
//                relation chainOfCommand / escalationChain follow.
//   dotted-line  a secondary manager for one topic or project; many allowed,
//                never used for escalation.
//   acts-for     an agent works on behalf of a person; agent -> person only.
//
// `orgChart.<agent>.reportsTo` still works unchanged and is read as a
// `reports-to` relation; a bare id there means an agent.
//
// Organization throws on the first problem; the Org view draws what is valid
// and skips the rest, so a typo never blanks the page.

export const RELATION_TYPES = ["reports-to", "dotted-line", "acts-for"] as const
export type RelationType = (typeof RELATION_TYPES)[number]
export type MemberKind = "agent" | "person"
export type MemberRef = `${MemberKind}:${string}`

export interface OrgRelation {
  from: MemberRef
  to: MemberRef
  type: RelationType
}

export interface OrgPerson {
  id: string
  name: string
  role?: string
}

export interface OrgGraph {
  /** Agents in business.orgChart. */
  agents: Set<string>
  /** People named by at least one valid relation, from the `people` list. */
  people: Map<string, OrgPerson>
  /** Valid relations, `orgChart.reportsTo` first, duplicates dropped. */
  relations: OrgRelation[]
  /** Each member's line manager (its one `reports-to`). */
  managerOf: Map<MemberRef, MemberRef>
  /** What is wrong, in plain words. Empty when the chart is valid. */
  problems: string[]
}

export interface OrgGraphInput {
  orgChart?: Record<string, { reportsTo?: string }>
  relations?: Array<{ from: string; to: string; type: string }>
}

const REF_RE = /^(agent|person):(\S+)$/

/** `agent:x` / `person:y`; a bare id gets `bare` (agent for legacy reportsTo),
 *  or null when a prefix is required. */
export function parseMemberRef(raw: string, bare: MemberKind | null = null): { kind: MemberKind; id: string } | null {
  const s = String(raw ?? "").trim()
  const m = s.match(REF_RE)
  if (m) return { kind: m[1] as MemberKind, id: m[2] }
  if (bare && s && !s.includes(":") && !/\s/.test(s)) return { kind: bare, id: s }
  return null
}

export function memberRef(kind: MemberKind, id: string): MemberRef {
  return `${kind}:${id}`
}

export function refKind(ref: MemberRef): MemberKind {
  return ref.startsWith("person:") ? "person" : "agent"
}

export function refId(ref: MemberRef): string {
  return ref.slice(ref.indexOf(":") + 1)
}

export function resolveOrgGraph(business: OrgGraphInput, people: ReadonlyArray<{ id: string; name?: string; role?: string }> = []): OrgGraph {
  const chart = business.orgChart ?? {}
  const agents = new Set(Object.keys(chart))
  const known = new Map(people.map((p) => [p.id, p]))
  const graph: OrgGraph = { agents, people: new Map(), relations: [], managerOf: new Map(), problems: [] }
  const seen = new Set<string>()

  // A member that exists, or a problem saying why not.
  const check = (raw: string, bare: MemberKind | null, where: string): MemberRef | null => {
    const parsed = parseMemberRef(raw, bare)
    if (!parsed) {
      graph.problems.push(`${where}: "${raw}" is not a member; write it as agent:<id> or person:<id>`)
      return null
    }
    if (parsed.kind === "agent" && !agents.has(parsed.id)) {
      graph.problems.push(`${where}: unknown agent "${parsed.id}" (not in business.orgChart)`)
      return null
    }
    if (parsed.kind === "person" && !known.has(parsed.id)) {
      graph.problems.push(`${where}: unknown person "${parsed.id}" (not in people)`)
      return null
    }
    return memberRef(parsed.kind, parsed.id)
  }

  const add = (from: MemberRef, to: MemberRef, type: RelationType, where: string) => {
    if (from === to) { graph.problems.push(`${where}: ${from} cannot relate to itself`); return }
    if (type === "acts-for" && (refKind(from) !== "agent" || refKind(to) !== "person")) {
      graph.problems.push(`${where}: acts-for links an agent to a person (agent:<id> acts-for person:<id>)`)
      return
    }
    const key = `${from} ${type} ${to}`
    if (seen.has(key)) return
    if (type === "reports-to") {
      const boss = graph.managerOf.get(from)
      if (boss) { graph.problems.push(`${where}: ${from} already reports to ${boss}; a member has one reports-to (use dotted-line for a second manager)`); return }
      graph.managerOf.set(from, to)
    }
    seen.add(key)
    graph.relations.push({ from, to, type })
    for (const ref of [from, to]) {
      if (refKind(ref) === "person") {
        const p = known.get(refId(ref))!
        graph.people.set(p.id, { id: p.id, name: p.name || p.id, ...(p.role ? { role: p.role } : {}) })
      }
    }
  }

  for (const [agentId, entry] of Object.entries(chart)) {
    if (!entry?.reportsTo) continue
    const where = `Agent "${agentId}" reports to`
    const to = check(entry.reportsTo, "agent", where)
    if (to) add(memberRef("agent", agentId), to, "reports-to", where)
  }

  for (const [i, r] of (business.relations ?? []).entries()) {
    const where = `business.relations[${i}]`
    if (!(RELATION_TYPES as readonly string[]).includes(r.type)) {
      graph.problems.push(`${where}: unknown relation type "${r.type}" (use ${RELATION_TYPES.join(", ")})`)
      continue
    }
    const from = check(r.from, null, where)
    const to = check(r.to, null, where)
    if (from && to) add(from, to, r.type as RelationType, where)
  }

  // A reports-to loop, across people and agents, is reported once and its
  // links dropped, so every member of it sits at the top of the Org view.
  for (const start of [...graph.managerOf.keys()]) {
    const path: MemberRef[] = []
    let cur: MemberRef | undefined = start
    while (cur && !path.includes(cur)) { path.push(cur); cur = graph.managerOf.get(cur) }
    if (cur) {
      const loop = path.slice(path.indexOf(cur))
      graph.problems.push(`Reporting cycle detected involving ${loop.join(" -> ")} -> ${cur}`)
      for (const m of loop) graph.managerOf.delete(m)
      graph.relations = graph.relations.filter((r) => !(r.type === "reports-to" && loop.includes(r.from)))
    }
  }
  return graph
}
