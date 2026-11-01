import { memberKey, memberProblem, parseMember } from "./relations"

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
  /** Members whose home is another department and who also work here, in
   *  full, without repeats; left out when there are none. */
  alsoMembers?: string[]
}

/** Every department in `business`, refs written in full, sorted by name. */
export function orgDepartments(business: {
  departments?: Record<string, { name?: string; head?: string; members?: string[]; alsoMembers?: string[] }>
} | undefined): OrgDepartment[] {
  const full = (refs: string[] | undefined) => [...new Set((refs ?? []).filter(Boolean).map(memberKey))]
  return Object.entries(business?.departments ?? {})
    .map(([id, d]) => {
      const also = full(d?.alsoMembers)
      return {
        id,
        name: d?.name?.trim() || id,
        ...(d?.head ? { head: memberKey(d.head) } : {}),
        members: full(d?.members),
        ...(also.length ? { alsoMembers: also } : {}),
      }
    })
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
): string | undefined {
  const outsider = (key: string) => {
    const m = parseMember(key)
    return m.kind === "person" ? outsiders.get(m.id) : undefined
  }
  const notStaff = (o: Outsider) => `${o.name} is a ${o.role}, and only owners and members of the organisation can be in a department`
  const inDept = new Map<string, string>()
  for (const d of departments) {
    const problem = d.head && memberProblem(d.head, `Department ${d.name} is headed by`, agents, people, peers)
    if (problem) return problem
    const head = d.head ? outsider(d.head) : undefined
    if (head) return `Department ${d.name} cannot be headed by ${head.name}: ${notStaff(head)}`
    for (const m of d.members) {
      const problem = memberProblem(m, `Department ${d.name} lists`, agents, people, peers)
      if (problem) return problem
      const o = outsider(m)
      if (o) return `Department ${d.name} cannot list ${o.name}: ${notStaff(o)}`
      const had = inDept.get(m)
      if (had) return `"${m}" is in both department ${had} and ${d.name}; a member is in one department`
      inDept.set(m, d.name)
    }
  }
  // alsoMembers (Anis 11-01): a member works in other departments too, but
  // keeps one home: the department that lists or heads them.
  const home = homeDepartments(departments)
  for (const d of departments) {
    for (const m of d.alsoMembers ?? []) {
      const problem = memberProblem(m, `Department ${d.name} also lists`, agents, people, peers)
      if (problem) return problem
      const o = outsider(m)
      if (o) return `Department ${d.name} cannot also list ${o.name}: ${notStaff(o)}`
      const at = home.get(m)
      if (at === d.id) return `"${m}" is a member of department ${d.name} already; alsoMembers is for members whose home is another department`
      if (!at) return `"${m}" is in alsoMembers of department ${d.name} but has no home; list them in the members of one department first`
    }
  }
  return undefined
}

/** Each member's home department id: the first that lists them in
 *  `members`, else the first they head. */
function homeDepartments(departments: OrgDepartment[]): Map<string, string> {
  const home = new Map<string, string>()
  for (const d of departments) for (const m of d.members) if (!home.has(m)) home.set(m, d.id)
  for (const d of departments) if (d.head && !home.has(d.head)) home.set(d.head, d.id)
  return home
}

/** One box of the Departments view: the name, the head on top and the
 *  members under it (the head is not repeated among them). */
export interface DepartmentBox {
  id: string
  name: string
  head?: string
  members: string[]
  /** Who also works here, with their home department's name, drawn as an
   *  outlined card with a "Home: <name>" chip; left out when none. */
  also?: Array<{ key: string; home: string }>
}

/** The Departments view (#1681): a box per department, then everyone in
 *  `everyone` (card keys, in order) that no department holds or heads.
 *  An also-member with no other home (a problem the page shows) is left out. */
export function departmentBoxes(
  departments: OrgDepartment[],
  everyone: string[],
): { boxes: DepartmentBox[]; rest: string[] } {
  const held = new Set<string>()
  const home = homeDepartments(departments)
  const nameOf = new Map(departments.map((d) => [d.id, d.name]))
  const boxes = departments.map((d) => {
    if (d.head) held.add(d.head)
    for (const m of d.members) held.add(m)
    const also = (d.alsoMembers ?? []).flatMap((key) => {
      const at = home.get(key)
      return at && at !== d.id ? [{ key, home: nameOf.get(at)! }] : []
    })
    return {
      id: d.id, name: d.name, ...(d.head ? { head: d.head } : {}), members: d.members.filter((m) => m !== d.head),
      ...(also.length ? { also } : {}),
    }
  })
  return { boxes, rest: [...new Set(everyone)].filter((k) => !held.has(k)) }
}
