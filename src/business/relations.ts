// --- Org members and typed relations (#1418) ---
//
// A member is `agent:<id>` or `person:<id>`; a bare id is an agent, so the
// legacy `orgChart.<agent>.reportsTo: "<agent>"` keeps its meaning. People come
// from the top-level `people` list. `agent:<node>/<id>` is an agent on the mesh
// peer `<node>` (a name in mesh.peers): it is shown on the chart, never routed
// to, and checked against mesh.peers only, so a start needs no network. A ref
// to a node that is not (or no longer) in mesh.peers does not stop the org
// from loading (#1702): it is shown as "not a peer". Only a writer refuses a
// new one, so a typo is caught before it is saved. Relation types, confirmed by the owner:
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

/** The agent on another node that `ref` names (`agent:<node>/<id>`), else undefined. */
export function remoteAgent(ref: string): { node: string; id: string } | undefined {
  const m = parseMember(ref)
  const r = m.kind === "agent" ? m.id.match(/^([^/]+)\/([^/]+)$/) : null
  return r ? { node: r[1], id: r[2] } : undefined
}

/** What is wrong with a member's ref, or undefined when it names a known
 *  agent, person or mesh peer. `what` says where the ref was written. */
export function memberProblem(
  key: string,
  what: string,
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
  peers: ReadonlySet<string>,
): string | undefined {
  const m = parseMember(key)
  const remote = remoteAgent(key)
  if (remote) return peers.has(remote.node) ? undefined : `${what} "${m.id}", but "${remote.node}" is not a peer in mesh.peers`
  if (m.id.includes("/")) return `${what} "${m.id}"; an agent on another node is written agent:<node>/<id>`
  if (m.kind === "agent") return agents.has(m.id) ? undefined : `${what} "${m.id}", which is not an agent in business.orgChart`
  return people.has(m.id) ? undefined : `${what} "${m.id}", which is not a person in people`
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
  peers: ReadonlySet<string> = new Set(),
): string | undefined {
  const boss = new Map<string, string>()
  for (const r of relations) {
    for (const end of [r.from, r.to]) {
      const problem = memberProblem(end, `Org relation ${r.type} names`, agents, people, peers)
      if (problem) return problem
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

/** A member for people to read: an agent's id, or a person's name from `people`. */
export function memberLabel(ref: string, people: ReadonlyArray<{ id: string; name?: string }> = []): string {
  const m = parseMember(ref)
  if (m.kind === "agent") return m.id
  return people.find((p) => p.id === m.id)?.name || m.id
}

/** The first thing wrong with the org relations of a whole agentx.json, or
 *  undefined. For writers (admin POST, CLI) to refuse a bad ref before it is
 *  saved. `had`: nodes the config already named before this change (see
 *  namedNodes); a ref to one of them is let through even when it is not in
 *  mesh.peers, so a retired node does not block an unrelated edit (#1702). */
export function configRelationsProblem(cfg: {
  people?: Array<{ id: string }>
  mesh?: { peers?: Array<{ name: string }> }
  business?: { orgChart?: Record<string, { reportsTo?: string }>; relations?: OrgRelation[] }
} | undefined, had: Iterable<string> = []): string | undefined {
  return relationsProblem(
    orgRelations(cfg?.business),
    new Set(Object.keys(cfg?.business?.orgChart ?? {})),
    new Set((cfg?.people ?? []).map((p) => p?.id).filter(Boolean)),
    new Set([...meshPeerNames(cfg), ...had]),
  )
}

/** Every node an `agent:<node>/<id>` in `refs` names. */
export function refNodes(refs: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const ref of refs) {
    const r = remoteAgent(ref)
    if (r) out.add(r.node)
  }
  return out
}

/** Every node the org relations of `business` name (orgChart reportsTo and
 *  business.relations). Departments: orgNodes in departments.ts. */
export function namedNodes(business: Parameters<typeof orgRelations>[0]): Set<string> {
  return refNodes(orgRelations(business).flatMap((r) => [r.from, r.to]))
}

/** The names in mesh.peers: the nodes an `agent:<node>/<id>` may name. */
export function meshPeerNames(cfg: { mesh?: { peers?: Array<{ name?: string }> } } | undefined): Set<string> {
  return new Set((cfg?.mesh?.peers ?? []).map((p) => p?.name).filter((n): n is string => !!n))
}
