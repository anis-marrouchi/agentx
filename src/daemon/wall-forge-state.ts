import type Database from "better-sqlite3"
import type { ForgeReader, ParsedRef } from "@/requests/checkers/issue"
import type { IssueState } from "@/requests/checkers"
import { forgeCommentsOn } from "@/storage/forge-comments"
import type { WallPost } from "./wall-api"
import { forgeCache, isForgeError, type ForgeCacheOptions } from "./wall-forge-cache"
import { forgeMismatch, type ForgeMismatch } from "./wall-forge-mismatch"
import { gitlabRefOf } from "./wall-forge-time"

// --- The Wall's forge home: live state, closer, exact comments (#1184) ---
//
// For a post whose home is a GitHub or GitLab issue, pull request or merge
// request: its state on the forge right now (open, closed, merged), who
// closed it and when, and when that was checked, so no agent picks up
// something a person closed. One read-only GET per home, cached and
// time-boxed (wall-forge-cache.ts). A forge that cannot be read gives
// "state unknown", never a guess.
//
// Its milestone and assignees come from the same GET, and a marker shows
// when the forge and the post disagree on open or closed (#1195).
//
// The comments an agent posted there through the daemon are linked by the
// id the forge gave them (storage/forge-comments.ts).

const HOUR = 3_600_000

export interface ForgeHome {
  provider: "github" | "gitlab"
  ref: ParsedRef
  /** "owner/repo#12", "group/project#12" or "group/project!12". */
  key: string
}

export interface WallForgeState {
  provider: "github" | "gitlab"
  ref: string
  /** Null: unknown (see `unknown`). */
  state: IssueState | null
  closedBy: string | null
  closedAt: number | null
  /** Its milestone and assignees on the forge (#1195). Null / empty: none
   *  set, or unknown. */
  milestone: string | null
  assignees: string[]
  /** The forge and the post disagree on open or closed (#1195). */
  mismatch: ForgeMismatch | null
  /** When the forge was read. Null: no answer yet. */
  checkedAt: number | null
  /** Why the state is unknown. Null: it was read. */
  unknown: string | null
}

export interface WallForgeComment {
  agentId: string | null
  at: number
  url: string
}

const GITHUB_URL = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)(?:[/?#]|$)/i
const GITHUB_CHAT = /^([\w.-]+\/[\w.-]+):(issue|pull):(\d+)$/

/** The forge item a post lives on: its home link, else its forge chat.
 *  GitLab homes need this node's GitLab address. Null: no forge home. */
export function forgeHomeOf(post: Pick<WallPost, "home" | "group">, gitlabUrl: string | null | undefined): ForgeHome | null {
  const github = (m: RegExpMatchArray): ForgeHome => {
    const ref = { project: m[1], number: Number(m[3]), mr: m[2] === "pull" }
    return { provider: "github", ref, key: `${ref.project}#${ref.number}` }
  }
  // The home link first, then the chat it came from.
  const link = (post.home?.link ?? "").match(GITHUB_URL)
  if (link) return github(link)
  const gl = gitlabUrl ? gitlabRefOf(post, gitlabUrl) : null
  if (gl) {
    const ref = { project: gl.project, number: gl.iid, mr: gl.kind === "merge_request" }
    return { provider: "gitlab", ref, key: `${ref.project}${ref.mr ? "!" : "#"}${ref.number}` }
  }
  const chat = post.group.channel === "github" ? post.group.chatId.match(GITHUB_CHAT) : null
  return chat ? github(chat) : null
}

/** The chat id the forge channel uses for this home. */
export function forgeChatOf(home: ForgeHome): string {
  const kind = home.ref.mr ? (home.provider === "github" ? "pull" : "merge_request") : "issue"
  return `${home.ref.project}:${kind}:${home.ref.number}`
}

/** The web address of one comment: GitHub #issuecomment-<id>, GitLab #note_<id>. */
export function commentUrl(home: ForgeHome, id: string, gitlabUrl: string | null | undefined): string | null {
  const n = home.ref.number
  if (home.provider === "github") return `https://github.com/${home.ref.project}/${home.ref.mr ? "pull" : "issues"}/${n}#issuecomment-${encodeURIComponent(id)}`
  if (!gitlabUrl) return null
  return `${gitlabUrl.replace(/\/$/, "")}/${home.ref.project}/-/${home.ref.mr ? "merge_requests" : "issues"}/${n}#note_${encodeURIComponent(id)}`
}

/** Agent comments the daemon posted on the post's home while it was open
 *  (and an hour after its close), newest first. */
export function forgeCommentsOf(
  post: Pick<WallPost, "home" | "group" | "createdAt" | "closedAt">, db: Database.Database | null, gitlabUrl: string | null | undefined, now: number,
): WallForgeComment[] {
  const home = db ? forgeHomeOf(post, gitlabUrl) : null
  if (!db || !home) return []
  const to = post.closedAt ? post.closedAt + HOUR : now
  let rows: ReturnType<typeof forgeCommentsOn>
  try { rows = forgeCommentsOn(db, home.provider, forgeChatOf(home), post.createdAt, to) } catch { return [] }
  return rows.flatMap((c) => {
    const url = commentUrl(home, c.commentId, gitlabUrl)
    return url ? [{ agentId: c.agentId, at: c.at, url }] : []
  })
}

interface ForgeStateAnswer { state: IssueState; closedBy: string | null; closedAt: number | null; milestone: string | null; assignees: string[] }

export interface WallForgeStateSource {
  /** Sets `forgeState` on every post: null when it has no forge home. */
  annotate(posts: WallPost[]): Promise<WallPost[]>
}

/** The cached, time-boxed source of forge state for the Wall. `github`:
 *  this node has a GitHub connector; `gitlabUrl`: its GitLab address. */
export function wallForgeState(
  forge: { github: boolean; gitlabUrl: string | null }, read: ForgeReader, opts: ForgeCacheOptions = {},
): WallForgeStateSource {
  const cache = forgeCache<ForgeHome, ForgeStateAnswer>(async (home) => {
    const item = await read(home.provider, home.ref, { notes: false })
    if (isForgeError(item)) return item
    const at = item.closedAt ? Date.parse(item.closedAt) : NaN
    return { state: item.state, closedBy: item.closedBy ?? null, closedAt: Number.isFinite(at) ? at : null, milestone: item.milestone ?? null, assignees: item.assignees ?? [] }
  }, opts)
  const name = (p: ForgeHome["provider"]) => (p === "github" ? "GitHub" : "GitLab")
  return {
    async annotate(posts) {
      const refs = new Map<string, ForgeHome>()
      const homes = posts.map((post) => {
        const home = forgeHomeOf(post, forge.gitlabUrl)
        if (!home || (home.provider === "github" && !forge.github)) return null
        const key = `${home.provider}:${home.key}`
        refs.set(key, home)
        return { home, key }
      })
      const reads = await cache.readAll(refs)
      posts.forEach((post, i) => {
        const h = homes[i]
        const got = h ? reads.get(h.key) : undefined
        if (!h || !got) { post.forgeState = null; return }
        const base = { provider: h.home.provider, ref: h.home.key, state: null, closedBy: null, closedAt: null, milestone: null, assignees: [], mismatch: null, checkedAt: null }
        if (got.kind === "skipped") { post.forgeState = { ...base, unknown: `not read yet (many ${name(h.home.provider)} homes); shown on a later refresh` }; return }
        if (got.kind === "late") { post.forgeState = { ...base, unknown: `${name(h.home.provider)} did not answer in time` }; return }
        if (isForgeError(got.answer)) { post.forgeState = { ...base, checkedAt: got.at, unknown: got.answer.error }; return }
        post.forgeState = { ...base, ...got.answer, mismatch: forgeMismatch(post.state, got.answer.state), checkedAt: got.at, unknown: null }
      })
      return posts
    },
  }
}
