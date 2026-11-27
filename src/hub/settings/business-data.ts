// --- Settings › Business: what it reads, and the pure sums on it (#2101 ST3a) ---
//
// The org chart comes from GET /api/admin/org (`setup`, `choices`,
// `canEdit`, as the /org editor reads it, org-setup.ts); projects, clients,
// the contact map and the boards from GET /api/admin/state. Plain data: no
// React, so the test reads it without a browser.
import type { AdminState } from "./data"

export interface SetupMember { ref: string; kind: "agent" | "person"; id: string; name: string; title?: string; schedule?: { start: string; end: string; days: string[] } }
export interface SetupRelation { from: string; to: string; type: string }
export interface OrgSetup { members: SetupMember[]; relations: SetupRelation[] }
export interface OrgSetupReply {
  exists?: boolean
  canEdit?: boolean
  setup?: OrgSetup
  choices?: { agents: { ref: string; name: string }[]; people: { ref: string; name: string }[]; roles: { key: string; title: string }[]; types: string[] }
}

export interface Project { id: string; name?: string; pm?: string; lead?: string; client?: string; team?: string[] }
export interface ClientCfg { name?: string; kind?: string; respondWithin?: string; standing?: string[] }
export interface ContactMapping { channel?: string; chatId?: string; username?: string; senderId?: string; client: string; project?: string; displayName?: string }
export interface BoardColumn { id: string; title: string; kind: string; scopedLabel?: string; mapsToLabel?: string; scopedPrefix?: string }
export interface Board { id: string; name: string; source?: { projects?: string[] }; primaryToolLabel?: string; timeRangeDays?: number; closedWindowDays?: number; columns?: BoardColumn[] }
export interface BusinessState extends AdminState {
  business?: { enabled?: boolean; projects?: Project[]; contactMap?: ContactMapping[]; clients?: Record<string, ClientCfg> }
  boards?: Board[]
}

export interface OrgRow { member: SetupMember; depth: number; boss?: string; lines: string[] }

const LINE: Record<string, string> = { "dotted-line": "Dotted line to", "acts-for": "Acts for" }

/** The chart as rows in reading order: each member under its reports-to
 *  boss, with its depth and its other lines in words. A boss loop leaves
 *  members with no top: they come last, at depth 0, so no one is lost. */
export function orgRows(setup: OrgSetup | undefined): OrgRow[] {
  if (!setup) return []
  const byRef = new Map(setup.members.map((m) => [m.ref, m]))
  const boss = new Map<string, string>()
  for (const r of setup.relations) if (r.type === "reports-to" && byRef.has(r.to)) boss.set(r.from, r.to)
  const name = (ref: string) => byRef.get(ref)?.name ?? ref.replace(/^(agent|person):/, "")
  const seen = new Set<string>()
  const out: OrgRow[] = []
  const walk = (m: SetupMember, depth: number) => {
    seen.add(m.ref)
    const lines = setup.relations.filter((r) => r.from === m.ref && r.type !== "reports-to").map((r) => `${LINE[r.type] ?? r.type} ${name(r.to)}`)
    out.push({ member: m, depth, boss: boss.get(m.ref), lines })
    for (const x of setup.members) if (boss.get(x.ref) === m.ref && !seen.has(x.ref)) walk(x, depth + 1)
  }
  for (const m of setup.members) if (!boss.has(m.ref)) walk(m, 0)
  for (const m of setup.members) if (!seen.has(m.ref)) walk(m, 0)
  return out
}

/** The target of a member's first line of a type, or "". */
export function lineTo(setup: OrgSetup | undefined, ref: string, type: string): string {
  return setup?.relations.find((r) => r.from === ref && r.type === type)?.to ?? ""
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export const DAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" }
export { WEEK }

/** "09:00–18:00 · Mon–Fri"; empty when the member keeps the default. */
export function hoursText(s: SetupMember["schedule"]): string {
  if (!s || !s.start || !s.end) return ""
  const d = WEEK.filter((x) => s.days.includes(x))
  const days = d.length === 7 ? "every day" : d.join() === "mon,tue,wed,thu,fri" ? "Mon–Fri" : d.map((x) => DAY_NAMES[x]).join(", ")
  return `${s.start}–${s.end}${days ? " · " + days : ""}`
}

export interface ClientRow { id: string; cfg?: ClientCfg; namedBy: "project" | "contact" | "" }

/** Every client that resolves: set up, or only named by a project or a
 *  contact mapping (as the old Settings lists them), sorted by id. */
export function clientRows(b: BusinessState["business"]): ClientRow[] {
  const ids = new Map<string, ClientRow["namedBy"]>()
  for (const p of b?.projects ?? []) {
    const id = p.client || (p.id.includes("/") ? p.id.slice(0, p.id.indexOf("/")) : p.id)
    if (!ids.has(id)) ids.set(id, "project")
  }
  for (const c of b?.contactMap ?? []) if (c.client && !ids.has(c.client)) ids.set(c.client, "contact")
  for (const id of Object.keys(b?.clients ?? {})) ids.set(id, ids.get(id) ?? "")
  return [...ids.keys()].sort().map((id) => ({ id, cfg: b?.clients?.[id], namedBy: ids.get(id) ?? "" }))
}

export const CLIENT_KIND: Record<string, string> = { client: "Client", own: "Own product", internal: "Internal" }

/** How a mapping matches a chat: "chat -100…", "username alex", "sender 123". */
export function contactKey(c: ContactMapping): [string, string] {
  return c.chatId ? ["chat", c.chatId] : c.username ? ["username", c.username] : c.senderId ? ["sender", c.senderId] : ["", "?"]
}

/** What DELETE business/contact matches on (the old Settings' rule). */
export function contactMatch(c: ContactMapping): Record<string, string> {
  const f: Record<string, string> = {}
  if (c.channel) f.channel = c.channel
  if (c.chatId) f.chatId = c.chatId
  else if (c.username) f.username = c.username
  else if (c.senderId) f.senderId = c.senderId
  return f
}

/** What a column maps a dropped card to, in a few words. */
export function columnMap(c: BoardColumn): string {
  if (c.kind === "scoped-label") return c.scopedLabel || "scoped label"
  if (c.kind === "label") return c.mapsToLabel || "label"
  if (c.kind === "open-backlog") return "prefix " + (c.scopedPrefix || "Status")
  return c.kind
}

/** A comma list, trimmed, empties dropped. */
export const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)
