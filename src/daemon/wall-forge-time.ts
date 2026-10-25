import type { ForgeConnectors } from "@/requests/checkers/issue"
import { OPEN_STATES } from "@/requests/store"
import type { WallPost } from "./wall-api"

// --- The Wall's forge time: logged vs estimate (#1189) ---
//
// For a post whose home is a GitLab issue or merge request, the forge's own
// time tracking (GET .../time_stats), next to the request's estimate and
// run time. Read only: nothing is written to GitLab or to AgentX. A home
// on another forge, or on a node without a GitLab connector, gets no forge
// time (null). A forge that cannot be read gets "unknown", never a flag.
//
// The page refreshes every minute, so answers are cached, and one Wall
// read waits at most BUDGET_MS for the forge: what is not back by then is
// "unknown" this time and is filled from the cache on the next refresh.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OK_TTL_MS = 5 * MINUTE
const ERROR_TTL_MS = MINUTE
const TIMEOUT_MS = 10_000
const BUDGET_MS = 4_000
/** GitLab homes read per Wall read; the rest are "unknown" until cached. */
const MAX_READS = 40
const CONCURRENCY = 4
const CACHE_MAX = 2_000

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

type Answer = ForgeTimeStats | { error: string }

export interface WallForgeTimeSource {
  /** Sets `forgeTime` on every post: null when its home has no time tracking. */
  annotate(posts: WallPost[], now: number, staleAfterHours: number): Promise<WallPost[]>
}

/** The cached, time-boxed source of forge time for the Wall. */
export function wallForgeTime(
  gitlabUrl: string, read: ForgeTimeReader,
  opts: { budgetMs?: number; maxReads?: number; clock?: () => number } = {},
): WallForgeTimeSource {
  const clock = opts.clock ?? Date.now
  const cache = new Map<string, { at: number; answer: Answer }>()
  const inFlight = new Map<string, Promise<Answer>>()
  let running = 0
  const queue: Array<() => void> = []

  const fetchOne = (key: string, ref: GitlabRef): Promise<Answer> => {
    const had = inFlight.get(key)
    if (had) return had
    const p = new Promise<Answer>((resolve) => {
      const go = () => {
        running++
        read(ref).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }))
          .then((answer) => {
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
            cache.set(key, { at: clock(), answer })
            resolve(answer)
          })
          .finally(() => { running--; inFlight.delete(key); queue.shift()?.() })
      }
      if (running < CONCURRENCY) go()
      else queue.push(go)
    })
    inFlight.set(key, p)
    return p
  }

  const fresh = (key: string): Answer | null => {
    const c = cache.get(key)
    if (!c) return null
    const ttl = "error" in c.answer ? ERROR_TTL_MS : OK_TTL_MS
    return clock() - c.at < ttl ? c.answer : null
  }

  return {
    async annotate(posts, now, staleAfterHours) {
      const budget = opts.budgetMs ?? BUDGET_MS
      const maxReads = opts.maxReads ?? MAX_READS
      let reads = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<null>((r) => { timer = setTimeout(() => r(null), budget) })
      try {
        await Promise.all(posts.map(async (post) => {
          const ref = gitlabRefOf(post, gitlabUrl)
          if (!ref) { post.forgeTime = null; return }
          const key = refLabel(ref)
          let answer: Answer | null = fresh(key)
          if (!answer) {
            if (!inFlight.has(key) && reads >= maxReads) {
              post.forgeTime = unknown(key, "not read yet (many GitLab homes); shown on a later refresh")
              return
            }
            if (!inFlight.has(key)) reads++
            answer = await Promise.race([fetchOne(key, ref), deadline])
          }
          if (!answer) { post.forgeTime = unknown(key, "GitLab did not answer in time"); return }
          if ("error" in answer) { post.forgeTime = unknown(key, answer.error); return }
          post.forgeTime = {
            ref: key,
            loggedMinutes: Math.round(answer.spentSeconds / 60),
            estimateMinutes: answer.estimateSeconds > 0 ? Math.round(answer.estimateSeconds / 60) : null,
            flags: forgeTimeFlags(post, answer, now, staleAfterHours),
            unknown: null,
          }
        }))
      } finally {
        clearTimeout(timer)
      }
      return posts
    },
  }
}

const unknown = (ref: string, why: string): WallForgeTime => ({ ref, loggedMinutes: null, estimateMinutes: null, flags: [], unknown: why })
