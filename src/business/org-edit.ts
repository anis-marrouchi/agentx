import { departmentsProblem, orgDepartments, orgNodes, type Outsider } from "./departments"
import { memberKey, meshPeerNames, orgRelations, parseMember, relationsProblem, RELATION_TYPES, type OrgRelation, type RelationType } from "./relations"

// --- Setting up the org chart from the Wall (#1420) ---
//
// Members are agents (business.orgChart, keyed by agent id, each with a
// role) and people (business.orgPeople, keyed by an id from `people`, the
// role optional). A person named in a relation is a member too. Relations
// are #1418's typed ones (relations.ts): an agent's `reports-to` is kept in
// orgChart.<agent>.reportsTo, as before; every other relation goes to
// business.relations.
//
// Each edit is checked before anything is written and refused with a plain
// sentence when it would break the chart. Owner only: the route checks.

export type OrgMemberKind = "agent" | "person"

export interface OrgSetupMember {
  /** `agent:<id>` or `person:<id>`. */
  ref: string
  kind: OrgMemberKind
  id: string
  name: string
  /** Key into business.roles. */
  role?: string
  /** That role's title. */
  title?: string
}

/** The chart as the setup page shows it: who is in it, and every line. */
export interface OrgSetup {
  members: OrgSetupMember[]
  relations: OrgRelation[]
}

/** What the setup page offers in its lists: never free text for members. */
export interface OrgChoices {
  agents: Array<{ ref: string; name: string }>
  people: Array<{ ref: string; name: string }>
  roles: Array<{ key: string; title: string }>
  types: readonly RelationType[]
}

export type OrgEdit =
  | { op: "add-member"; member: string; role?: string }
  | { op: "set-role"; member: string; role?: string }
  | { op: "remove-member"; member: string }
  | { op: "add-relation"; from: string; type: string; to: string }
  | { op: "remove-relation"; from: string; type: string; to: string }

const ROLE_MAX = 80
const DEFAULT_SCHEDULE = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }

export const RELATION_LABEL: Record<RelationType, string> = {
  "reports-to": "reports to",
  "dotted-line": "has a dotted line to",
  "acts-for": "acts for",
}

/** The people listed in `people`. Not the built-in owner: the daemon, the
 *  CLI and the org view accept a listed person only, so a line to an
 *  unlisted owner would be refused at the next start. */
function knownPeople(cfg: any): Map<string, string> {
  const list: any[] = Array.isArray(cfg?.people) ? cfg.people : []
  const out = new Map<string, string>()
  for (const p of list) if (p?.id) out.set(String(p.id), String(p.name || p.id))
  return out
}

function knownAgents(cfg: any): Map<string, string> {
  return new Map(Object.entries(cfg?.agents ?? {}).map(([id, a]: [string, any]) => [id, String(a?.name || id)]))
}

export function orgChoices(cfg: any): OrgChoices {
  const roles = cfg?.business?.roles ?? {}
  return {
    agents: [...knownAgents(cfg)].map(([id, name]) => ({ ref: `agent:${id}`, name })),
    people: [...knownPeople(cfg)].map(([id, name]) => ({ ref: `person:${id}`, name })),
    roles: Object.entries(roles).map(([key, r]: [string, any]) => ({ key, title: String(r?.title || key) })),
    types: RELATION_TYPES,
  }
}

/** Members and relations of the chart in `cfg`. */
export function readOrgSetup(cfg: any): OrgSetup {
  const b = cfg?.business ?? {}
  const roles = b.roles ?? {}
  const agents = knownAgents(cfg)
  const people = knownPeople(cfg)
  const relations = orgRelations(b)
  const member = (kind: OrgMemberKind, id: string, role: string | undefined): OrgSetupMember => ({
    ref: `${kind}:${id}`,
    kind,
    id,
    name: (kind === "agent" ? agents.get(id) : people.get(id)) ?? id,
    ...(role ? { role, title: String(roles[role]?.title || role) } : {}),
  })
  const members = [
    ...Object.entries(b.orgChart ?? {}).map(([id, e]: [string, any]) => member("agent", id, e?.role)),
    ...Object.entries(b.orgPeople ?? {}).map(([id, p]: [string, any]) => member("person", id, p?.role)),
  ]
  const seen = new Set(members.map((m) => m.ref))
  // A person named in a relation or a department (#1681) is in the chart too.
  const named = [...relations.flatMap((r) => [r.from, r.to]), ...orgDepartments(b).flatMap((d) => [...(d.head ? [d.head] : []), ...d.members])]
  for (const end of named) {
    const m = parseMember(end)
    if (m.kind === "person" && !seen.has(end)) { seen.add(end); members.push(member("person", m.id, undefined)) }
  }
  return { members, relations }
}

/** The relations and departments problem of the whole config. `had`: nodes
 *  the chart named before the edit, let through when not in mesh.peers
 *  (#1702), so only a new ref to an unknown node is refused. */
function chartProblem(cfg: any, had: ReadonlySet<string>): string | undefined {
  const b = cfg?.business ?? {}
  const agents = new Set(Object.keys(b.orgChart ?? {}))
  const people = new Set(knownPeople(cfg).keys())
  const peers = new Set([...meshPeerNames(cfg), ...had])
  const list: any[] = Array.isArray(cfg?.people) ? cfg.people : []
  const outsiders = new Map<string, Outsider>(list.flatMap((p) =>
    p?.id && (p.role === "client" || p.role === "guest") ? [[String(p.id), { name: String(p.name || p.id), role: p.role }] as const] : []))
  return relationsProblem(orgRelations(b), agents, people, peers) ?? departmentsProblem(orgDepartments(b), agents, people, peers, outsiders)
}

/** Take `ref` out of every department in the config, as head and as member.
 *  The department stays, without a head when it was the head. Returns the
 *  names of the departments it left. */
function dropFromDepartments(b: any, ref: string): string[] {
  const left: string[] = []
  for (const [id, d] of Object.entries(b.departments ?? {}) as Array<[string, any]>) {
    let hit = false
    if (d?.head && memberKey(d.head) === ref) { delete d.head; hit = true }
    if (Array.isArray(d?.members)) {
      const kept = d.members.filter((m: string) => memberKey(m) !== ref)
      if (kept.length !== d.members.length) { d.members = kept; hit = true }
    }
    if (hit) left.push(String(d?.name || id))
  }
  return left
}

/** The key in business.roles for `text`: an existing key or title, or a new
 *  role with that title. */
function roleKeyFor(cfg: any, text: string): string {
  const roles = (cfg.business.roles = cfg.business.roles || {})
  if (roles[text]) return text
  const lower = text.toLowerCase()
  const found = Object.entries(roles).find(([, r]: [string, any]) => String(r?.title || "").toLowerCase() === lower)
  if (found) return found[0]
  const base = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "role"
  let key = base
  for (let n = 2; roles[key]; n++) key = `${base}-${n}`
  roles[key] = { title: text }
  return key
}

function cleanRole(role: unknown): string {
  const text = String(role ?? "").replace(/\s+/g, " ").trim()
  if (text.length > ROLE_MAX) throw new Error(`Keep the role under ${ROLE_MAX} characters.`)
  return text
}

/** Does `from` reach `target` by following reports-to lines? */
function reportsUpTo(relations: OrgRelation[], from: string, target: string): boolean {
  const seen = new Set<string>()
  for (let cur: string | undefined = from; cur && !seen.has(cur); cur = relations.find((r) => r.type === "reports-to" && r.from === cur)?.to) {
    if (cur === target) return true
    seen.add(cur)
  }
  return false
}

/** Take every relation `drop` picks out of the config, wherever it is
 *  written: orgChart reportsTo or business.relations. Returns how many. */
function dropRelations(b: any, drop: (r: OrgRelation) => boolean): number {
  let n = 0
  for (const [id, e] of Object.entries(b.orgChart ?? {}) as Array<[string, any]>) {
    if (e?.reportsTo && drop({ from: `agent:${id}`, to: memberKey(e.reportsTo), type: "reports-to" })) { delete e.reportsTo; n++ }
  }
  const before = (b.relations ?? []).length
  b.relations = (b.relations ?? []).filter((r: any) => !drop({ from: memberKey(r.from), to: memberKey(r.to), type: r.type }))
  n += before - b.relations.length
  if (b.relations.length === 0) delete b.relations
  return n
}

/**
 * Apply one edit to the raw agentx.json object `cfg`, in place. Throws a
 * plain sentence, and leaves `cfg` as it was, when the edit is refused.
 * Returns a one-line summary of what changed.
 */
export function applyOrgEdit(cfg: any, edit: OrgEdit): string {
  const next = structuredClone(cfg ?? {})
  const b = (next.business = next.business || {})
  const had = orgNodes(next.business)
  const before = chartProblem(next, had)
  const setup = readOrgSetup(next)
  const byRef = new Map(setup.members.map((m) => [m.ref, m]))
  const choices = orgChoices(next)
  const known = new Map([...choices.agents, ...choices.people].map((c) => [c.ref, c.name]))
  const name = (ref: string) => byRef.get(ref)?.name ?? known.get(ref) ?? parseMember(ref).id
  let summary: string

  switch (edit?.op) {
    case "add-member": {
      const ref = /^(agent|person):[^\s:]+$/.test(String(edit.member ?? "").trim()) ? memberKey(String(edit.member).trim()) : ""
      if (!ref) throw new Error("Pick an agent or a person to add.")
      const { kind, id } = parseMember(ref)
      const shown = known.get(ref)
      if (!shown) throw new Error(kind === "agent" ? `There is no agent "${id}" on this computer.` : `There is no person "${id}" in your people list. Add them on the People page first.`)
      if (byRef.has(ref)) throw new Error(`${shown} is already in the org chart.`)
      const role = cleanRole(edit.role)
      if (kind === "agent" && !role) throw new Error(`Give ${shown} a role.`)
      const roleKey = role ? roleKeyFor(next, role) : undefined
      if (kind === "agent") {
        b.orgChart = b.orgChart || {}
        b.orgChart[id] = { role: roleKey, schedule: { ...DEFAULT_SCHEDULE }, utilizationTarget: 0.8 }
      } else {
        b.orgPeople = b.orgPeople || {}
        b.orgPeople[id] = roleKey ? { role: roleKey } : {}
      }
      summary = `${shown} added to the org chart`
      break
    }
    case "set-role": {
      const m = byRef.get(memberKey(String(edit.member ?? "")))
      if (!m) throw new Error(`${edit.member} is not in the org chart.`)
      const role = cleanRole(edit.role)
      if (m.kind === "agent" && !role) throw new Error(`${m.name} needs a role.`)
      const roleKey = role ? roleKeyFor(next, role) : undefined
      if (m.kind === "agent") b.orgChart[m.id].role = roleKey
      else {
        b.orgPeople = b.orgPeople || {}
        b.orgPeople[m.id] = roleKey ? { role: roleKey } : {}
      }
      summary = roleKey ? `${m.name} is now ${b.roles[roleKey]?.title || role}` : `${m.name} has no role now`
      break
    }
    case "remove-member": {
      const m = byRef.get(memberKey(String(edit.member ?? "")))
      if (!m) throw new Error(`${edit.member} is not in the org chart.`)
      const pmOf = m.kind === "agent" ? (b.projects ?? []).find((p: any) => p?.pm === m.id) : undefined
      if (pmOf) throw new Error(`${m.name} is the project manager of "${pmOf.id}". Give that project another manager first.`)
      const dropped = dropRelations(b, (r) => r.from === m.ref || r.to === m.ref)
      const depts = dropFromDepartments(b, m.ref)
      if (m.kind === "agent") delete b.orgChart[m.id]
      else if (b.orgPeople) {
        delete b.orgPeople[m.id]
        if (Object.keys(b.orgPeople).length === 0) delete b.orgPeople
      }
      summary = `${m.name} removed from the org chart` + (dropped ? `, with ${dropped} ${dropped === 1 ? "line" : "lines"}` : "")
        + (depts.length ? ` and out of ${depts.join(", ")}` : "")
      break
    }
    case "add-relation": {
      const type = String(edit.type ?? "").trim() as RelationType
      const raw = [String(edit.from ?? "").trim(), String(edit.to ?? "").trim()]
      if (!raw[0] || !raw[1] || !type) throw new Error("Pick a member, a kind of relation and a target.")
      if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new Error(`"${type}" is not a kind of relation. Pick reports to, dotted line or acts for.`)
      const [from, to] = raw.map(memberKey)
      for (const end of [from, to]) if (!byRef.has(end)) throw new Error(`${name(end)} is not in the org chart. Add them first.`)
      if (from === to) throw new Error(`${name(from)} cannot be linked to themself.`)
      const r: OrgRelation = { from, to, type }
      if (setup.relations.some((x) => x.from === from && x.to === to && x.type === type)) throw new Error(`${name(from)} already ${RELATION_LABEL[type]} ${name(to)}.`)
      if (type === "acts-for" && byRef.get(from)!.kind !== "agent") throw new Error(`Only an agent can act for someone: ${name(from)} is a person.`)
      if (type === "acts-for" && byRef.get(to)!.kind !== "person") throw new Error(`An agent acts for a person: ${name(to)} is an agent.`)
      if (type === "reports-to") {
        const boss = setup.relations.find((x) => x.type === "reports-to" && x.from === from)
        if (boss) throw new Error(`${name(from)} already reports to ${name(boss.to)}. Remove that line first: each member has one boss.`)
        if (reportsUpTo(setup.relations, to, from)) throw new Error(`${name(from)} cannot report to ${name(to)}: ${name(to)} already reports up to ${name(from)}.`)
      }
      // An agent's boss stays where it always was; the rest is typed.
      if (type === "reports-to" && byRef.get(from)!.kind === "agent") {
        const target = parseMember(to)
        b.orgChart[parseMember(from).id].reportsTo = target.kind === "agent" ? target.id : to
      } else {
        b.relations = [...(b.relations ?? []), r]
      }
      summary = `${name(from)} ${RELATION_LABEL[type]} ${name(to)}`
      break
    }
    case "remove-relation": {
      const r = { from: memberKey(String(edit.from ?? "")), to: memberKey(String(edit.to ?? "")), type: String(edit.type ?? "") }
      if (!dropRelations(b, (x) => x.from === r.from && x.to === r.to && x.type === r.type)) {
        throw new Error("That line is not in the org chart any more. Reload the page.")
      }
      summary = `${name(r.from)} no longer ${RELATION_LABEL[r.type as RelationType] ?? r.type} ${name(r.to)}`
      break
    }
    default:
      throw new Error("Unknown change to the org chart.")
  }

  // The same check the daemon runs at start. A problem the chart already
  // had does not block an edit, so the owner can fix things one at a time.
  const after = chartProblem(next, had)
  if (after && after !== before) throw new Error(after)
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, next)
  return summary
}
