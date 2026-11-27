// --- The feed in React: what it reads and the sums on it (#2101) ---
//
// The rules are the old feed's own: the state set, its groups and order,
// tab membership and counts, one relative time, and the excerpt all come
// from wall-feed-model.ts, which the old Hub injects into its script. This
// file only adds what React needs around them: the post's shape, which run
// of the live snapshot works on a post, the search box, and the address.
//
// Plain data and pure functions, so the tests check them without a browser.
import type { WallOwnerCard, WallPost } from "../../daemon/wall-api"
import { fdCounts, fdGroupPosts, fdInTab, fdState, fdStates } from "../../daemon/ui/pages/wall-feed-model"
import { wsFold } from "../../daemon/ui/pages/wall-sidebar"
import { ltRequestId, type LtTask } from "../../daemon/ui/pages/wall-tree"
import { buildHash } from "../router"

/** The review id (pages.ts); the old feed stays on `#status=open`. */
export const FEED_PAGE = "feed-preview"
/** Every node's posts, quick (what is cached now), as the old feed reads them. */
export const FEED_URL = "/api/admin/wall?peer=fleet&days=7&quick=1"
/** After this long without a good read, "Synced" turns into "Not synced since". */
export const FEED_STALE_MS = 120_000

/** The part of a Wall post the feed draws. */
export type FeedPost = Pick<WallPost,
  "id" | "state" | "headline" | "need" | "owner" | "project" | "lastMoveAt" | "runs" | "runMs" | "lastFailure" | "lastRun" | "result" | "blocked"
> & {
  ownerCards?: WallOwnerCard[]
  goal?: WallPost["goal"]
  /** Set on posts read across the mesh: the node that keeps it. */
  node?: { name?: string; peer?: string | null } | null
  /** Open copies folded into this one (wsFold). */
  copies?: string[]
}
export interface FeedReply { posts?: FeedPost[]; pending?: boolean; owner?: boolean }

/** The live snapshot's part the feed reads: who runs what, on which node. */
export interface FeedLive { nodes?: { url?: string; name?: string; agents?: { id: string; name?: string; runningTasks?: LtTask[] }[] }[] }

/** The status tabs, as on the old feed (WALL_STATUS_TABS in wall.ts). */
export const FEED_TABS: ReadonlyArray<readonly [string, string]> = [
  ["open", "Open"], ["in_progress", "Working"], ["waiting", "Waiting"], ["failed", "Failed"], ["done", "Done"], ["", "All"],
]

const OPEN = ["in_progress", "waiting_owner", "waiting_other", "needs_attention"]
export const isOpen = (p: { state: string }) => OPEN.includes(p.state)

/** The run of this post going on now, with its node, or null. */
export function liveRunOf(p: FeedPost, live: FeedLive | null | undefined): { node: string; task: string; agent: string } | null {
  for (const n of live?.nodes ?? []) {
    for (const a of n.agents ?? []) {
      for (const t of a.runningTasks ?? []) {
        if (ltRequestId(t) === p.id || (p.lastRun && t.id === p.lastRun.taskId)) return { node: n.url || "", task: t.id, agent: a.id }
      }
    }
  }
  return null
}

/** A post's state in the one set, knowing what runs now. */
export function feedState(p: FeedPost, live: FeedLive | null | undefined): string {
  return fdState(p, !!liveRunOf(p, live))
}

/** Display names from the live snapshot; an agent it does not list keeps its id. */
export function agentNames(live: FeedLive | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of live?.nodes ?? []) for (const a of n.agents ?? []) if (!out[a.id]) out[a.id] = a.name || a.id
  return out
}

/** Does a post match the search words: its title, words, owner, project or id. */
export function feedMatches(p: FeedPost, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [p.headline, p.need, p.owner, p.project, p.id, p.result?.text].filter(Boolean).join(" ").toLowerCase()
  return words.every((w) => hay.includes(w))
}

export interface FeedFilters { status: string; q: string; owner: string; project: string }

/** The filters from the address; the feed opens on Open. */
export function feedFilters(params: URLSearchParams): FeedFilters {
  return { status: params.has("status") ? params.get("status") || "" : "open", q: params.get("q") || "", owner: params.get("owner") || "", project: params.get("project") || "" }
}

/** The address for these filters, on the review id. */
export function feedHash(f: Partial<FeedFilters>): string {
  return buildHash({ page: FEED_PAGE, status: f.status === undefined ? "open" : f.status || "all", q: f.q, owner: f.owner, project: f.project })
}

/** What the feed shows: one post per item (wsFold), the filters other than
 *  status applied, then the groups for the status tab, and each tab's count
 *  over the same posts (so a count never says more than its tab shows). */
export function feedView(posts: FeedPost[], f: FeedFilters, live: FeedLive | null | undefined) {
  const rest = wsFold(posts, isOpen).filter((p) => (!f.owner || p.owner === f.owner) && (!f.project || p.project === f.project) && feedMatches(p, f.q))
  const states = new Map(rest.map((p) => [p.id, feedState(p, live)]))
  const stateOf = (p: FeedPost) => states.get(p.id) as string
  const status = f.status === "all" ? "" : f.status
  const shown = rest.filter((p) => fdInTab(stateOf(p), status))
  return {
    groups: fdGroupPosts(shown, stateOf),
    counts: fdCounts([...states.values()], FEED_TABS.map((t) => t[0])),
    stateOf,
    total: shown.length,
  }
}

/** The state's icon, word and tone (wall-feed-model.ts fdStates). */
export const stateInfo = (s: string) => fdStates()[s] ?? fdStates().cancelled

/** One or two letters for an author: one-word agents get one (C for Coder). */
export function initials(name: string): string {
  const w = String(name).replace(/[-_.@]+/g, " ").trim().split(/\s+/).filter(Boolean)
  if (!w.length) return "?"
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0][0]).toUpperCase()
}

/** "in 4 h", "in 12 min": when a card expires, as the old feed says it. */
export function until(ms: number, now = Date.now()): string {
  const s = (ms - now) / 1000
  if (s <= 0) return "passed"
  if (s < 5400) return "in " + Math.max(1, Math.round(s / 60)) + " min"
  if (s < 129600) return "in " + Math.round(s / 3600) + " h"
  return "in " + Math.round(s / 86400) + " d"
}

/** The exact local time with its UTC offset, for a time's tooltip. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const p2 = (n: number) => (n < 10 ? "0" : "") + n
  let off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  off = Math.abs(off)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} UTC${sign}${p2(Math.floor(off / 60))}:${p2(off % 60)}`
}

/** Whole minutes of run time. */
export const mins = (ms: number | null | undefined) => Math.round((ms || 0) / 60000)

/** The one line under a post that waits on someone else, or "". */
export function waitLine(p: FeedPost, now = Date.now()): string {
  if (p.blocked) return `Waits on ${p.blocked.who}: ${p.blocked.why}`
  const c = p.ownerCards?.[0]
  if (c) return `Waits on you: ${c.title}, ${c.expiresAt <= now ? "its card expired" : "card expires " + until(c.expiresAt, now)}`
  if (p.state === "waiting_owner") return "Waits on you"
  return ""
}

/** The old Hub's address of a post (it opens there until the Task page moves). */
export const postHash = (id: string) => buildHash({ status: "open", post: id })
