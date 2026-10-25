import type { ForgeConnectors } from "@/requests/checkers/issue"
import { OPEN_STATES } from "@/requests/store"
import type { WallPost } from "./wall-api"
import { forgeCache, isForgeError, type ForgeCacheOptions } from "./wall-forge-cache"

// --- The Wall's forge time: logged vs estimate (#1189) ---
//
// For a post whose home is a GitLab issue or merge request, the forge's own
// time tracking (GET .../time_stats), next to the request's estimate and
// run time. Read only: nothing is written to GitLab or to AgentX. A home
// on another forge, or on a node without a GitLab connector, gets no forge
// time (null). A forge that cannot be read gets "unknown", never a flag.
// Reads are cached and time-boxed (wall-forge-cache.ts).

const HOUR = 3_600_000
const TIMEOUT_MS = 10_000

export interface GitlabRef {
  project: string
  kind: "issue" | "merge_request"
  iid: number
}

export interface ForgeTimeStats {
  estimateSeconds: number
  spentSeconds: number
}

export type ForgeTimeReader = (ref: GitlabRef) => Promise<ForgeTimeStats | { error: string }>

export interface WallForgeTime {
  /** "group/project#12" (issue) or "group/project!12" (merge request). */
  ref: string
  /** Null: the forge could not be read (see `unknown`). */
  loggedMinutes: number | null
  /** Null: no estimate set on the forge, or the forge could not be read. */
  estimateMinutes: number | null
  /** Mismatches, in words. Empty: nothing to flag, or unknown. */
  flags: string[]
  /** Why the forge's time is unknown. Null: it was read. */
  unknown: string | null
}

export const refLabel = (r: GitlabRef): string => `${r.project}${r.kind === "issue" ? "#" : "!"}${r.iid}`

/** The GitLab issue or merge request a post lives on: its home link on the
 *  connector's host, else its GitLab chat ("group/project:issue:12").
 *  Null: not a GitLab home this node can read. */
export function gitlabRefOf(post: Pick<WallPost, "home" | "group">, gitlabUrl: string): GitlabRef | null {
  let host: string
  try { host = new URL(gitlabUrl).host.toLowerCase() } catch { return null }
  const link = post.home?.link ?? ""
  const m = link.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/(issues|merge_requests)\/(\d+)(?:[/?#]|$)/)
  if (m && m[1].toLowerCase() === host) return { project: m[2], kind: m[3] === "issues" ? "issue" : "merge_request", iid: Number(m[4]) }
  if (post.group.channel === "gitlab") {
    const c = post.group.chatId.match(/^([^:\s]+\/[^:\s]+):(issue|merge_request):(\d+)$/)
    if (c) return { project: c[1], kind: c[2] as GitlabRef["kind"], iid: Number(c[3]) }
  }
  return null
}

/** Logged vs estimate, flagged: no time on active or done work, over the
 *  estimate, or time logged on a post with no recent move. */
export function forgeTimeFlags(
  post: Pick<WallPost, "state" | "runs" | "lastMoveAt">, stats: ForgeTimeStats, now: number, staleAfterHours: number,
): string[] {
  const flags: string[] = []
  const open = (OPEN_STATES as readonly string[]).includes(post.state)
  const logged = Math.round(stats.spentSeconds / 60)
  const estimate = Math.round(stats.estimateSeconds / 60)
  const active = post.state === "in_progress" && post.runs > 0
  if (stats.spentSeconds <= 0) {
    if (active) flags.push("no time logged on active work")
    else if (post.state === "done") flags.push("closed with no time logged")
  }
  if (stats.estimateSeconds > 0 && stats.spentSeconds > stats.estimateSeconds) flags.push(`over estimate: ${hm(logged)} logged of ${hm(estimate)}`)
  if (open && stats.spentSeconds > 0 && now - post.lastMoveAt > staleAfterHours * HOUR) {
    flags.push(`time logged, no move for ${Math.floor((now - post.lastMoveAt) / (24 * HOUR)) || "<1"} d`)
  }
  return flags
}

/** "1 h 30 min", "45 min". */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`
}

/** The time_stats reader over GitLab's REST API. */
export function gitlabTimeReader(gitlab: NonNullable<ForgeConnectors["gitlab"]>, doFetch: typeof fetch = fetch): ForgeTimeReader {
  const base = `${gitlab.url.replace(/\/$/, "")}/api/v4/projects`
  const headers: Record<string, string> = gitlab.token ? { "PRIVATE-TOKEN": gitlab.token } : {}
  return async (ref) => {
    const url = `${base}/${encodeURIComponent(ref.project)}/${ref.kind === "issue" ? "issues" : "merge_requests"}/${ref.iid}/time_stats`
    let res: Response
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { error: `could not be reached: ${String(e?.message ?? e).slice(0, 120)}` }
    }
    if (!res.ok) return { error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    const body: any = await res.json().catch(() => null)
    const estimate = Number(body?.time_estimate)
    const spent = Number(body?.total_time_spent)
    if (!Number.isFinite(estimate) || !Number.isFinite(spent)) return { error: "no time stats in the answer" }
    return { estimateSeconds: Math.max(0, estimate), spentSeconds: Math.max(0, spent) }
  }
}

export interface WallForgeTimeSource {
  /** Sets `forgeTime` on every post: null when its home has no time tracking. */
  annotate(posts: WallPost[], now: number, staleAfterHours: number): Promise<WallPost[]>
}

/** The cached, time-boxed source of forge time for the Wall. */
export function wallForgeTime(gitlabUrl: string, read: ForgeTimeReader, opts: ForgeCacheOptions = {}): WallForgeTimeSource {
  const cache = forgeCache<GitlabRef, ForgeTimeStats>(read, opts)
  return {
    async annotate(posts, now, staleAfterHours) {
      const refs = new Map<string, GitlabRef>()
      const keys = posts.map((post) => {
        const ref = gitlabRefOf(post, gitlabUrl)
        if (!ref) return null
        const key = refLabel(ref)
        refs.set(key, ref)
        return key
      })
      const reads = await cache.readAll(refs)
      posts.forEach((post, i) => {
        const key = keys[i]
        const got = key ? reads.get(key) : undefined
        if (!key || !got) { post.forgeTime = null; return }
        if (got.kind === "skipped") { post.forgeTime = unknown(key, "not read yet (many GitLab homes); shown on a later refresh"); return }
        if (got.kind === "late") { post.forgeTime = unknown(key, "GitLab did not answer in time"); return }
        if (isForgeError(got.answer)) { post.forgeTime = unknown(key, got.answer.error); return }
        const answer = got.answer
        post.forgeTime = {
          ref: key,
          loggedMinutes: Math.round(answer.spentSeconds / 60),
          estimateMinutes: answer.estimateSeconds > 0 ? Math.round(answer.estimateSeconds / 60) : null,
          flags: forgeTimeFlags(post, answer, now, staleAfterHours),
          unknown: null,
        }
      })
      return posts
    },
  }
}

const unknown = (ref: string, why: string): WallForgeTime => ({ ref, loggedMinutes: null, estimateMinutes: null, flags: [], unknown: why })
