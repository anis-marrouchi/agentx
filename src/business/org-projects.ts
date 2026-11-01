import { clientFromProject } from "./clients"
import { memberKey, parseMember } from "./relations"

// --- Projects on the Org page (#1687) ---
//
// Each business.projects entry with who runs it and who works on it:
//   pm    — an agent id, as before. It drives the PM gate (organization.ts
//           pmFor, intent/decide.ts) and agent → client attribution
//           (clients.ts agentClients), so it never takes a `person:` id.
//   lead  — optional `person:<id>`: the human who leads the project.
//   team  — optional members, written like relations: `agent:<id>`,
//           `person:<id>`, or a bare agent id. One member can be on
//           several projects.
//   name  — optional display name; the id when unset.
// A project only groups cards on the Projects view; it changes no reporting
// line. An unknown id in `team` or `lead` is reported, never fatal.

export interface OrgProject {
  id: string
  name: string
  /** The client it belongs to: `client`, else the id's first segment. */
  client: string
  /** The PM agent in full (`agent:<id>`). */
  pm?: string
  /** The lead in full. Written bare, it is read as a person. */
  lead?: string
  /** Members in full, without repeats, in the order written. */
  team: string[]
}

type ProjectInput = { id: string; name?: string; pm?: string; client?: string; lead?: string; team?: string[] }

/** The lead in full: `person:<id>` for a bare id, since a lead is a human. */
export function leadKey(ref: string): string {
  return /^(agent|person):/.test(ref) ? memberKey(ref) : `person:${ref}`
}

/** Every project in `business`, refs written in full, sorted by client then name. */
export function orgProjects(business: { projects?: ProjectInput[] } | undefined): OrgProject[] {
  const list = (business?.projects ?? []).filter((p) => p?.id)
  return list
    .map((p) => ({
      id: p.id,
      name: p.name?.trim() || p.id,
      client: clientFromProject(p.id, list),
      ...(p.pm ? { pm: memberKey(p.pm) } : {}),
      ...(p.lead ? { lead: leadKey(p.lead) } : {}),
      team: [...new Set((p.team ?? []).filter(Boolean).map(memberKey))],
    }))
    .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The first thing wrong with the projects' `lead` and `team`, or undefined.
 *  `pm` is not checked here: the Organization refuses an unknown PM as before. */
export function projectsProblem(
  projects: OrgProject[],
  agents: ReadonlySet<string>,
  people: ReadonlySet<string>,
): string | undefined {
  const what = (key: string) => {
    const m = parseMember(key)
    if (m.kind === "agent") return agents.has(m.id) ? undefined : `"${m.id}", which is not an agent in business.orgChart`
    return people.has(m.id) ? undefined : `"${m.id}", which is not a person in people`
  }
  for (const p of projects) {
    if (p.lead) {
      if (parseMember(p.lead).kind !== "person") return `Project ${p.name} is led by "${p.lead}"; a lead is a person (person:<id>), the PM is the agent`
      const bad = what(p.lead)
      if (bad) return `Project ${p.name} is led by ${bad}`
    }
    for (const m of p.team) {
      const bad = what(m)
      if (bad) return `Project ${p.name} has ${bad} in its team`
    }
  }
  return undefined
}
