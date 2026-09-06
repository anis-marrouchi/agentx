// --- Who is the work for? -------------------------------------------------
//
// The principal behind a piece of work is a CLIENT. That concept already
// existed, spread across `business.projects[].client`, `business.contactMap[]`
// and the `orgChart` reportsTo chain, resolved privately inside the activity
// graph panel. This module is the single implementation both that panel and
// the session monitor call, plus the policy layer the monitor needs.
//
// Clients are DERIVED, never declared: one appears the moment a project or a
// contact mentions it. `business.clients` only carries overrides — a display
// name, whether it is a paying client or your own house, how fast a delay
// costs you, and what agents may do for it without asking. A client with no
// entry there still resolves; it just gets defaults.

export interface ContactRule {
  channel?: string
  chatId?: string
  username?: string
  senderId?: string
  client: string
  project?: string
  displayName?: string
}
export interface ProjectRule { id: string; pm?: string; client?: string }
export interface ClientPolicy {
  name?: string
  kind?: "client" | "internal" | "own"
  respondWithin?: string
  standing?: string[]
}
export interface BusinessShape {
  projects?: ProjectRule[]
  contactMap?: ContactRule[]
  orgChart?: Record<string, { reportsTo?: string }>
  clients?: Record<string, ClientPolicy>
}
export interface ResolvedClient {
  id: string
  name: string
  kind: "client" | "internal" | "own"
  /** Minutes before a wait starts costing; undefined = no external clock. */
  respondWithinMinutes?: number
  standing: string[]
  /** True when nothing in config mentions this client — derived only. */
  declared: boolean
}

export const UNMAPPED = "unmapped"

/** Explicit `business.projects[].client` wins; otherwise the leading segment
 *  of the id. Works for "owner/repo" on any forge and for bare internal ids. */
export function clientFromProject(project: string | null | undefined, projects: ProjectRule[] = []): string {
  if (!project) return UNMAPPED
  const hit = projects.find(p => p.id === project)
  if (hit?.client) return hit.client
  const slash = project.indexOf("/")
  return slash > 0 ? project.slice(0, slash) : project
}

/** agent id -> client, from project PMs then transitively down reportsTo.
 *  A mesh dispatch carries no project, so without this it is unattributable. */
export function agentClients(business: BusinessShape): Map<string, string> {
  const out = new Map<string, string>()
  const projects = business.projects ?? []
  const orgChart = business.orgChart ?? {}
  for (const p of projects) {
    if (p.pm) if (!out.has(p.pm)) out.set(p.pm, clientFromProject(p.id, projects))
  }
  const climb = (agentId: string, seen = new Set<string>()): string | undefined => {
    if (out.has(agentId)) return out.get(agentId)
    if (seen.has(agentId)) return undefined
    seen.add(agentId)
    const up = orgChart[agentId]?.reportsTo
    if (!up) return undefined
    const c = climb(up, seen)
    if (c) out.set(agentId, c)
    return c
  }
  for (const agentId of Object.keys(orgChart)) climb(agentId)
  return out
}

/** chatId > username > senderId > channel-default. First match wins. */
export function matchContact(
  channel: string | undefined,
  who: { chatId?: string; username?: string; senderId?: string },
  contactMap: ContactRule[] = [],
): ContactRule | undefined {
  if (!contactMap.length) return undefined
  const pool = contactMap.filter(m => !m.channel || m.channel === channel)
  return pool.find(m => m.chatId && who.chatId && m.chatId === who.chatId)
    ?? pool.find(m => m.username && who.username && m.username === who.username)
    ?? pool.find(m => m.senderId && who.senderId && m.senderId === who.senderId)
    ?? pool.find(m => m.channel && !m.chatId && !m.username && !m.senderId)
}

export interface WorkRef { agentId?: string; channel?: string; project?: string; chatId?: string; username?: string }

/** The one entry point. Conversation rules beat project shape, which beats
 *  the agent's place in the org, because a rule someone wrote by hand is
 *  always more deliberate than a heuristic. */
export function resolveClient(ref: WorkRef, business: BusinessShape): string {
  const contact = matchContact(ref.channel, { chatId: ref.chatId, username: ref.username }, business.contactMap)
  if (contact) return contact.client
  if (ref.project) return clientFromProject(ref.project, business.projects)
  if (ref.agentId) {
    const byAgent = agentClients(business).get(ref.agentId)
    if (byAgent) return byAgent
  }
  return UNMAPPED
}

/** A monitor session id is "<agent>:<channel>:<target...>". Forge targets
 *  carry the project, chat targets carry the chat id. */
export function parseWorkRef(sessionId: string, agentId?: string): WorkRef {
  const parts = String(sessionId || "").split(":")
  if (parts.length < 3) return { agentId }
  const [agent, channel, ...rest] = parts
  const target = rest.join(":")
  const ref: WorkRef = { agentId: agentId || agent, channel }
  if (channel === "gitlab" || channel === "github") {
    // "owner/repo:issue:94" and "owner/repo:pipeline:10897" -> "owner/repo"
    ref.project = target.split(":")[0]
  } else if (channel === "cron" || channel === "api") {
    // Nothing addressable: fall through to the agent's own client.
  } else {
    ref.chatId = target.split("@")[0]
  }
  return ref
}

const KIND_DEFAULT = (id: string): "client" | "internal" | "own" => (id === UNMAPPED ? "internal" : "client")

export function clientPolicy(id: string, business: BusinessShape): ResolvedClient {
  const p = business.clients?.[id]
  return {
    id,
    name: p?.name || id,
    kind: p?.kind ?? KIND_DEFAULT(id),
    respondWithinMinutes: parseDuration(p?.respondWithin),
    standing: p?.standing ?? [],
    declared: Boolean(p),
  }
}

/** Every client the config can produce: from projects, contacts and overrides. */
export function listClients(business: BusinessShape): ResolvedClient[] {
  const ids = new Set<string>()
  for (const p of business.projects ?? []) ids.add(clientFromProject(p.id, business.projects))
  for (const c of business.contactMap ?? []) ids.add(c.client)
  for (const id of Object.keys(business.clients ?? {})) ids.add(id)
  return [...ids].sort().map(id => clientPolicy(id, business))
}

/** "4h", "90m", "2d" -> minutes. Anything else is treated as no clock, so a
 *  typo can never silently become an aggressive deadline. */
export function parseDuration(v: string | undefined): number | undefined {
  const m = /^(\d+)\s*([mhd])$/.exec(String(v ?? "").trim())
  if (!m) return undefined
  const n = Number(m[1])
  return m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440
}

/** Whether an agent may act unattended for this client. Deny by default, and
 *  never for a paying client regardless of what is listed — an outward-facing
 *  mistake on someone else's repo is not ours to make on a timer. */
export function mayProceedUnattended(client: ResolvedClient, capability: string): boolean {
  if (client.kind === "client") return false
  return client.standing.includes("*") || client.standing.includes(capability)
}
