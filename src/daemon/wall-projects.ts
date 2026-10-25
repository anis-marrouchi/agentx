import { homedir } from "os"
import type { RequestRecord } from "@/requests/store"
import { OPEN_STATES } from "@/requests/store"
import { worktreeKey } from "./concurrent-runs"

// --- The Wall's projects: mapping and overview (#1190) ---
//
// Requests have no project field. A post's project comes from a read-only
// mapping in `dashboard.wall.projects`: its home repo, its agent, or that
// agent's workspace folder, checked in that order. With the mapping set,
// work no entry claims is "Other" on the overview (its home repo stays on
// the post as `repo`). With no mapping, a post's project is its home repo,
// as before, and work with no repo is "Other".
//
// Stalled: an open post with no move for more than twice its project's
// normal rhythm (`rhythmHours` on the entry, else `dashboard.wall.rhythmHours`,
// else the requests' staleAfterHours). Nothing here writes or notifies.
//
// Across the mesh each node maps its own posts; the node showing the Wall
// then applies its own mapping to a peer's post when one of its entries
// claims it (by repo or agent), so one config can name the whole fleet's
// projects. Throughput (#1192), blocks (#1193) and capacity (#1191) read
// the same `project` field.

const HOUR = 3_600_000

export interface WallProjectEntry {
  name: string
  /** Home repos, as "group/project". */
  repos?: string[]
  agents?: string[]
  /** Workspace folders: an agent working in one, or under it, is in the project. */
  workspaces?: string[]
  rhythmHours?: number
}

export interface WallProjectsConfig {
  rhythmHours?: number
  projects?: WallProjectEntry[]
}

export interface WallProject {
  name: string | null
  rhythmHours: number
}

export interface WallProjects {
  /** The project a request belongs to, and its normal rhythm in hours. */
  of(r: Pick<RequestRecord, "agentId" | "askedAgent">, repo: string | null): WallProject
  /** The configured project that claims this repo or one of these agents.
   *  Null: no entry does (the post keeps what its own node said). */
  claim(agents: string[], repo: string | null): WallProject | null
  /** The configured project names, in config order. */
  names: string[]
}

/** The repo of a forge chat ("group/project:issue:12"), or null. */
export function repoOfChat(chatId: string | null | undefined): string | null {
  const m = chatId?.match(/^([^:\s]+\/[^:\s]+):(?:issue|merge_request|pull)(?::|$)/)
  return m ? m[1] : null
}

const folder = (p: string): string | null => worktreeKey(p.startsWith("~/") ? homedir() + p.slice(1) : p)

/** The mapping, built once per Wall read. An empty config maps nothing. */
export function wallProjects(cfg: WallProjectsConfig | undefined, defaultRhythmHours: number, workspaceOf: (agent: string) => string | null | undefined = () => null): WallProjects {
  const entries = cfg?.projects ?? []
  const fallback = cfg?.rhythmHours ?? defaultRhythmHours
  const byRepo = new Map<string, WallProjectEntry>()
  const byAgent = new Map<string, WallProjectEntry>()
  const byFolder: Array<[string, WallProjectEntry]> = []
  // The first entry to name a repo, agent or folder wins.
  for (const e of entries) {
    for (const r of e.repos ?? []) if (!byRepo.has(r.toLowerCase())) byRepo.set(r.toLowerCase(), e)
    for (const a of e.agents ?? []) if (!byAgent.has(a)) byAgent.set(a, e)
    for (const w of e.workspaces ?? []) { const f = folder(w); if (f) byFolder.push([f, e]) }
  }
  const inFolder = (agent: string): WallProjectEntry | null => {
    const ws = workspaceOf(agent)
    const f = ws ? folder(ws) : null
    if (!f) return null
    return byFolder.find(([root]) => f === root || f.startsWith(`${root}/`))?.[1] ?? null
  }
  const claim = (agents: string[], repo: string | null): WallProject | null => {
    const e = (repo ? byRepo.get(repo.toLowerCase()) : undefined)
      ?? agents.map((a) => byAgent.get(a)).find(Boolean)
      ?? agents.map(inFolder).find(Boolean)
    return e ? { name: e.name, rhythmHours: e.rhythmHours ?? fallback } : null
  }
  return {
    names: [...new Set(entries.map((e) => e.name))],
    claim,
    // The owner it was handed to comes before the agent it was asked of.
    of: (r, repo) => claim([...new Set([r.askedAgent ?? r.agentId, r.agentId])], repo)
      ?? { name: entries.length ? null : repo, rhythmHours: fallback },
  }
}

/** Open, with no move for more than twice its normal rhythm. */
export function isStalled(p: { state: string; lastMoveAt: number; rhythmHours: number }, now: number): boolean {
  return (OPEN_STATES as readonly string[]).includes(p.state) && now - p.lastMoveAt > 2 * p.rhythmHours * HOUR
}

/** A peer's post seen through this node's mapping: renamed, with its
 *  rhythm and stalled mark redone, when an entry here claims it. */
export function claimPost<T extends { owner: string; agentId: string; repo?: string | null; project: string | null; state: string; lastMoveAt: number; rhythmHours?: number; stalled?: boolean }>(
  p: T, projects: WallProjects | null | undefined, now: number,
): T {
  const c = projects?.claim([...new Set([p.owner, p.agentId])], p.repo ?? null)
  if (!c) return p
  return { ...p, project: c.name, rhythmHours: c.rhythmHours, stalled: isStalled({ state: p.state, lastMoveAt: p.lastMoveAt, rhythmHours: c.rhythmHours }, now) }
}

export interface WallProjectRow {
  /** Null: "Other", work with no project. */
  project: string | null
  open: number
  inProgress: number
  blocked: number
  stalled: number
}

/** One row per project with its open work counted; configured projects
 *  with nothing open still get a row, and "Other" comes last. */
export function projectOverview(
  posts: Array<{ state: string; project: string | null; blocked: unknown; stalled: boolean }>, names: string[] = [],
): WallProjectRow[] {
  const rows = new Map<string | null, WallProjectRow>()
  const row = (project: string | null) => {
    let r = rows.get(project)
    if (!r) rows.set(project, r = { project, open: 0, inProgress: 0, blocked: 0, stalled: 0 })
    return r
  }
  for (const n of names) row(n)
  for (const p of posts) {
    if (!(OPEN_STATES as readonly string[]).includes(p.state)) continue
    const r = row(p.project)
    r.open++
    if (p.state === "in_progress") r.inProgress++
    if (p.blocked) r.blocked++
    if (p.stalled) r.stalled++
  }
  const order = new Map(names.map((n, i) => [n, i] as const))
  return [...rows.values()].sort((a, b) => {
    if (a.project === null || b.project === null) return a.project === null ? 1 : -1
    const x = order.get(a.project) ?? Infinity
    const y = order.get(b.project) ?? Infinity
    return x !== y ? x - y : a.project.localeCompare(b.project)
  })
}
