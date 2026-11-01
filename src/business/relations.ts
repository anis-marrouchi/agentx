// --- Org members and typed relations (#1418) ---
//
// A member is `agent:<id>` or `person:<id>`; a bare id is an agent, so the
// legacy `orgChart.<agent>.reportsTo: "<agent>"` keeps its meaning. People come
// from the top-level `people` list. Relation types, confirmed by the owner:
//   reports-to   line manager; at most one per member, no cycles; drives escalation
//   dotted-line  a second manager for one topic or project; many allowed
//   acts-for     an agent works on behalf of a person; agent → person only

export const RELATION_TYPES = ["reports-to", "dotted-line", "acts-for"] as const
export type RelationType = typeof RELATION_TYPES[number]

export interface OrgMember { kind: "agent" | "person"; id: string }
/** A relation with both ends written in full: `agent:<id>` or `person:<id>`. */
export interface OrgRelation { from: string; to: string; type: RelationType }

export function parseMember(ref: string): OrgMember {
  const m = String(ref).match(/^(agent|person):(.+)$/)
  return m ? { kind: m[1] as OrgMember["kind"], id: m[2] } : { kind: "agent", id: String(ref) }
}

/** The member in full, `agent:<id>` or `person:<id>`. */
export function memberKey(ref: string): string {
  const m = parseMember(ref)
  return `${m.kind}:${m.id}`
}

/** Every relation in `business`: each orgChart `reportsTo` read as reports-to,
 *  then `business.relations`, written in full and without repeats. */
export function orgRelations(business: {
  orgChart?: Record<string, { reportsTo?: string }>
  relations?: Array<{ from: string; to: string; type: RelationType }>
} | undefined): OrgRelation[] {
  const out: OrgRelation[] = []
  const seen = new Set<string>()
  const add = (from: string, to: string, type: RelationType) => {
    const r = { from: memberKey(from), to: memberKey(to), type }
    const k = `${r.type} ${r.from} ${r.to}`
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }
  for (const [agentId, entry] of Object.entries(business?.orgChart ?? {})) {
    if (entry?.reportsTo) add(agentId, entry.reportsTo, "reports-to")
  }
  for (const r of business?.relations ?? []) add(r.from, r.to, r.type)
  return out
}

/** The first thing wrong with `relations`, or undefined when they hold. */
export function relationsProblem(
  relations: OrgRelation[],
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
): string | undefined {
  const known = (key: string) => {
    const m = parseMember(key)
    return m.kind === "agent" ? agents.has(m.id) : people.has(m.id)
  }
  const boss = new Map<string, string>()
  for (const r of relations) {
    for (const end of [r.from, r.to]) {
      if (!known(end)) {
        const m = parseMember(end)
        return m.kind === "agent"
          ? `Org relation ${r.type} names "${m.id}", which is not an agent in business.orgChart`
          : `Org relation ${r.type} names "${m.id}", which is not a person in people`
      }
    }
    if (r.from === r.to) return `"${r.from}" cannot have a ${r.type} relation to itself`
    if (r.type === "acts-for" && !(r.from.startsWith("agent:") && r.to.startsWith("person:"))) {
      return `acts-for goes from an agent to a person, not "${r.from}" to "${r.to}"`
    }
    if (r.type === "reports-to") {
      const had = boss.get(r.from)
      if (had && had !== r.to) return `"${r.from}" reports to both "${had}" and "${r.to}"; reports-to allows one`
      boss.set(r.from, r.to)
    }
  }
  for (const start of boss.keys()) {
    const seen = new Set<string>()
    for (let cur: string | undefined = start; cur; cur = boss.get(cur)) {
      if (seen.has(cur)) return `Reporting cycle detected involving "${start}"`
      seen.add(cur)
    }
  }
  return undefined
}

// --- Departments (#1681) ---
//
// business.departments: { <id>: { name, head?, members[] } }. Head and
// members are written like the ends of a relation, and must name an agent
// in business.orgChart or a person in `people`. The head is a person or an
// agent; a department without one is allowed (the band says so).

/** A department with every member written in full; the head is not repeated in members. */
export interface OrgDepartment { id: string; name: string; head?: string; members: string[] }

/** Every department in `business`, in the order written. */
export function orgDepartments(business: {
  departments?: Record<string, { name?: string; head?: string; members?: string[] }>
} | undefined): OrgDepartment[] {
  return Object.entries(business?.departments ?? {}).map(([id, d]) => {
    const head = d?.head ? memberKey(d.head) : undefined
    const members = [...new Set((d?.members ?? []).map(memberKey))].filter((m) => m !== head)
    return { id, name: String(d?.name || id), ...(head ? { head } : {}), members }
  })
}

/** The first thing wrong with `departments`, or undefined when they hold. */
export function departmentsProblem(
  departments: OrgDepartment[],
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
): string | undefined {
  for (const d of departments) {
    for (const ref of [...(d.head ? [d.head] : []), ...d.members]) {
      const m = parseMember(ref)
      const as = ref === d.head ? "head" : "member"
      if (m.kind === "agent" && !agents.has(m.id)) return `Department "${d.name}" has ${as} "${m.id}", which is not an agent in business.orgChart`
      if (m.kind === "person" && !people.has(m.id)) return `Department "${d.name}" has ${as} "${m.id}", which is not a person in people`
    }
  }
  return undefined
}

/** A member for people to read: an agent's id, or a person's name from `people`. */
export function memberLabel(ref: string, people: ReadonlyArray<{ id: string; name?: string }> = []): string {
  const m = parseMember(ref)
  if (m.kind === "agent") return m.id
  return people.find((p) => p.id === m.id)?.name || m.id
}

/** The first thing wrong with the org relations or departments of a whole agentx.json, or
 *  undefined. For writers (admin POST, CLI) to refuse a bad ref before it is
 *  saved, instead of the daemon refusing it at the next start. */
export function configRelationsProblem(cfg: {
  people?: Array<{ id: string }>
  business?: {
    orgChart?: Record<string, { reportsTo?: string }>
    relations?: OrgRelation[]
    departments?: Record<string, { name?: string; head?: string; members?: string[] }>
  }
} | undefined): string | undefined {
  const agents = new Set(Object.keys(cfg?.business?.orgChart ?? {}))
  const people = new Set((cfg?.people ?? []).map((p) => p?.id).filter(Boolean))
  return relationsProblem(orgRelations(cfg?.business), agents, people)
    ?? departmentsProblem(orgDepartments(cfg?.business), agents, people)
}
