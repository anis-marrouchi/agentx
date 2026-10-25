import type { RequestRecord } from "@/requests/store"
import type { WallDeps } from "./wall-api"
import type { WallProjects } from "./wall-projects"

// --- The Wall's weekly throughput (#1192) ---
//
// Items closed per week, per project and per owner, over the last four
// weeks. A week is a rolling seven days ending now: week 0 is the last
// seven days, week 3 is 22 to 28 days ago. A closure exactly on a
// boundary belongs to the older week. Only `closedAt` and the project
// mapping (#1190, ./wall-projects) are read; nothing is written or sent.
//
// Each node lists its own closures (owner, project, repo, closedAt); the
// node showing the Wall merges every node's list, applies its own mapping
// to the peer closures it claims (as the overview does), then counts.
// Owners with open work but no closure still get a row of zeros.

const DAY = 86_400_000
const WEEK = 7 * DAY
export const THROUGHPUT_WEEKS = 4
/** Closures read per node: far above a month of work on one node. */
const CLOSED_MAX = 5000

export interface WallClosure {
  owner: string
  agentId: string
  /** From the mapping, else the home repo. Null: "Other". */
  project: string | null
  repo: string | null
  closedAt: number
}

export interface WallThroughput {
  /** Each week's [from, to), oldest first. */
  weeks: Array<{ from: number; to: number }>
  /** Closures per week, oldest week first; "Other" (null) last. */
  projects: Array<{ project: string | null; weeks: number[]; total: number }>
  owners: Array<{ owner: string; weeks: number[]; total: number }>
}

/** The home repo of a request, as "group/project" (same rule as the Wall's posts). */
type RepoOf = (r: Pick<RequestRecord, "home" | "chatId">) => string | null

/** This node's closures in the last `weeks`, with their project. */
export function wallClosures(deps: Pick<WallDeps, "store" | "now" | "projects" | "staleAfterHours">, repoOf: RepoOf, weeks = THROUGHPUT_WEEKS): WallClosure[] {
  const since = deps.now - weeks * WEEK
  return deps.store.listClosedSince(since, CLOSED_MAX).filter((r) => r.closedAt != null).map((r) => {
    const repo = repoOf(r)
    const project = deps.projects ? deps.projects.of(r, repo).name : repo
    return { owner: r.askedAgent ?? r.agentId, agentId: r.agentId, project, repo, closedAt: r.closedAt as number }
  })
}

/** A peer's closure seen through this node's mapping, when an entry here claims it. */
export function claimClosure(c: WallClosure, projects: WallProjects | null | undefined): WallClosure {
  const hit = projects?.claim([...new Set([c.owner, c.agentId])], c.repo)
  return hit ? { ...c, project: hit.name } : c
}

/** Which week a closure falls in: 0 = the last seven days; -1 = outside. */
export function weekIndex(closedAt: number, now: number, weeks = THROUGHPUT_WEEKS): number {
  // A clock a little ahead on another node: still this week.
  if (closedAt > now) return 0
  // Exactly seven days ago is already week 1.
  const w = Math.floor((now - closedAt) / WEEK)
  return w < weeks ? w : -1
}

/** Closures counted per week, per project and per owner. Configured
 *  projects and the given owners get a row even with no closures;
 *  "Other" comes last among projects, owners go by total then name. */
export function wallThroughput(
  closures: Array<Pick<WallClosure, "owner" | "project" | "closedAt">>,
  opts: { now: number; weeks?: number; projectNames?: string[]; owners?: string[] },
): WallThroughput {
  const n = opts.weeks ?? THROUGHPUT_WEEKS
  const weeks = Array.from({ length: n }, (_, k) => {
    const i = n - 1 - k
    return { from: opts.now - (i + 1) * WEEK, to: opts.now - i * WEEK }
  })
  const projects = new Map<string | null, number[]>()
  const owners = new Map<string, number[]>()
  const row = <K>(m: Map<K, number[]>, k: K) => {
    let r = m.get(k)
    if (!r) m.set(k, r = new Array(n).fill(0))
    return r
  }
  for (const p of opts.projectNames ?? []) row(projects, p)
  for (const o of opts.owners ?? []) row(owners, o)
  for (const c of closures) {
    const w = weekIndex(c.closedAt, opts.now, n)
    if (w < 0) continue
    const col = n - 1 - w
    row(projects, c.project)[col]++
    row(owners, c.owner)[col]++
  }
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const order = new Map((opts.projectNames ?? []).map((p, i) => [p, i] as const))
  return {
    weeks,
    projects: [...projects].map(([project, w]) => ({ project, weeks: w, total: total(w) })).sort((a, b) => {
      if (a.project === null || b.project === null) return a.project === null ? (b.project === null ? 0 : 1) : -1
      const x = order.get(a.project) ?? Infinity
      const y = order.get(b.project) ?? Infinity
      return x !== y ? x - y : b.total - a.total || a.project.localeCompare(b.project)
    }),
    owners: [...owners].map(([owner, w]) => ({ owner, weeks: w, total: total(w) }))
      .sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner)),
  }
}
