import { memberKey, memberProblem, meshPeerNames, orgRelations, parseMember, staleRemoteRefs, type RelationType } from "./relations"

// --- Departments of the org chart (#1681) ---
//
// business.departments groups org members under a name, headed by one
// member: `{ dev: { name: "Dev", head: "person:anis", members: [...] } }`.
// Members and the head are written like relations (relations.ts):
// `agent:<id>`, `person:<id>`, `agent:<node>/<id>` for an agent on a mesh
// peer, or a bare agent id. A department only groups
// cards on the chart; it changes no reporting line and no escalation.

export interface OrgDepartment {
  id: string
  name: string
  /** The member heading it, in full (`agent:<id>` / `person:<id>`). */
  head?: string
  /** Members in full, without repeats, in the order written. */
  members: string[]
}

/** Every department in `business`, refs written in full, sorted by name. */
export function orgDepartments(business: {
  departments?: Record<string, { name?: string; head?: string; members?: string[] }>
} | undefined): OrgDepartment[] {
  return Object.entries(business?.departments ?? {})
    .map(([id, d]) => ({
      id,
      name: d?.name?.trim() || id,
      ...(d?.head ? { head: memberKey(d.head) } : {}),
      members: [...new Set((d?.members ?? []).filter(Boolean).map(memberKey))],
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** A person who is not personnel: role `client` or `guest` (Anis 11-01). */
export interface Outsider { name: string; role: "client" | "guest" }

/** The first thing wrong with `departments`, or undefined when they hold.
 *  `outsiders` (person id → name and role) may not head or join one. */
export function departmentsProblem(
  departments: OrgDepartment[],
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
  peers: ReadonlySet<string> = new Set(),
  outsiders: ReadonlyMap<string, Outsider> = new Map(),
  stale: ReadonlySet<string> = new Set(),
): string | undefined {
  const outsider = (key: string) => {
    const m = parseMember(key)
    return m.kind === "person" ? outsiders.get(m.id) : undefined
  }
  const notStaff = (o: Outsider) => `${o.name} is a ${o.role}, and only owners and members of the organisation can be in a department`
  const inDept = new Map<string, string>()
  for (const d of departments) {
    const problem = d.head && memberProblem(d.head, `Department ${d.name} is headed by`, agents, people, peers, stale)
    if (problem) return problem
    const head = d.head ? outsider(d.head) : undefined
    if (head) return `Department ${d.name} cannot be headed by ${head.name}: ${notStaff(head)}`
    for (const m of d.members) {
      const problem = memberProblem(m, `Department ${d.name} lists`, agents, people, peers, stale)
      if (problem) return problem
      const o = outsider(m)
      if (o) return `Department ${d.name} cannot list ${o.name}: ${notStaff(o)}`
      const had = inDept.get(m)
      if (had) return `"${m}" is in both department ${had} and ${d.name}; a member is in one department`
      inDept.set(m, d.name)
    }
  }
  return undefined
}

/** One box of the Departments view: the name, the head on top and the
 *  members under it (the head is not repeated among them). */
export interface DepartmentBox {
  id: string
  name: string
  head?: string
  members: string[]
}

/** The Departments view (#1681): a box per department, then everyone in
 *  `everyone` (card keys, in order) that no department holds or heads. */
export function departmentBoxes(
  departments: OrgDepartment[],
  everyone: string[],
): { boxes: DepartmentBox[]; rest: string[] } {
  const held = new Set<string>()
  const boxes = departments.map((d) => {
    if (d.head) held.add(d.head)
    for (const m of d.members) held.add(m)
    return { id: d.id, name: d.name, ...(d.head ? { head: d.head } : {}), members: d.members.filter((m) => m !== d.head) }
  })
  return { boxes, rest: [...new Set(everyone)].filter((k) => !held.has(k)) }
}

/** The refs to agents on peers that have left mesh.peers, in a whole config:
 *  relation ends, department heads and members. They are warnings, never a
 *  reason to refuse a start, a reload or an unrelated edit. */
export function chartStaleRefs(cfg: {
  mesh?: { peers?: Array<{ name?: string }> }
  business?: {
    orgChart?: Record<string, { reportsTo?: string }>
    relations?: Array<{ from: string; to: string; type: RelationType }>
    departments?: Record<string, { name?: string; head?: string; members?: string[] }>
  }
} | undefined): Set<string> {
  const keys = [
    ...orgRelations(cfg?.business).flatMap((r) => [r.from, r.to]),
    ...orgDepartments(cfg?.business).flatMap((d) => [...(d.head ? [d.head] : []), ...d.members]),
  ]
  return staleRemoteRefs(keys, meshPeerNames(cfg))
}
