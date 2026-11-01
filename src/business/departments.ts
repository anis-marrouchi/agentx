import { memberKey, parseMember } from "./relations"

// --- Departments of the org chart (#1681) ---
//
// business.departments groups org members under a name, headed by one
// member: `{ dev: { name: "Dev", head: "person:anis", members: [...] } }`.
// Members and the head are written like relations (relations.ts):
// `agent:<id>`, `person:<id>`, or a bare agent id. A department only groups
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

/** The first thing wrong with `departments`, or undefined when they hold. */
export function departmentsProblem(
  departments: OrgDepartment[],
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
): string | undefined {
  const unknown = (key: string) => {
    const m = parseMember(key)
    return m.kind === "agent" ? !agents.has(m.id) : !people.has(m.id)
  }
  const what = (key: string) => {
    const m = parseMember(key)
    return m.kind === "agent" ? `"${m.id}", which is not an agent in business.orgChart` : `"${m.id}", which is not a person in people`
  }
  const inDept = new Map<string, string>()
  for (const d of departments) {
    if (d.head && unknown(d.head)) return `Department ${d.name} is headed by ${what(d.head)}`
    for (const m of d.members) {
      if (unknown(m)) return `Department ${d.name} lists ${what(m)}`
      const had = inDept.get(m)
      if (had) return `"${m}" is in both department ${had} and ${d.name}; a member is in one department`
      inDept.set(m, d.name)
    }
  }
  return undefined
}
