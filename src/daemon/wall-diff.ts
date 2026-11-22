import type { RequestRecord, RequestStore } from "@/requests/store"
import { capDiff, parseUnifiedDiff } from "./diff-parse"
import { HUB_NAME } from "./ui/hub-name"
import { forgeHomeOf, type ForgeHome } from "./wall-forge-state"

// --- The Hub's Diff view (#2102) ---
//
// A post whose home is a GitHub pull request or a GitLab merge request
// shows its diff, and the owner comments on its lines:
//
//   GET  /api/admin/wall/diff?id=<request id>   {ref, provider, files, truncated}:
//        the diff the review gate reads (its getDiff, review-gate-github.ts
//        and review-gate-gitlab.ts), parsed into files, hunks and numbered
//        lines (diff-parse.ts), at most DIFF_LINES_MAX lines in all.
//   POST /api/admin/wall/diff-comments  {id, comments: [{file, side, line, text, code?}]}
//        the comments as one message to the agent that has the request,
//        exactly as a comment on the post goes (wall-actions.ts).

export const WALL_DIFF_PATH = "/api/admin/wall/diff"
/** The most diff lines one answer carries. */
export const DIFF_LINES_MAX = 3000
export const DIFF_COMMENTS_MAX = 50
export const DIFF_COMMENT_TEXT_MAX = 2000
/** The longest code line a comment quotes. */
const CODE_MAX = 300

/** The pull or merge request a request lives on; null for an issue or none. */
export function mergeHomeOf(r: Pick<RequestRecord, "home" | "channel" | "chatId">, gitlabUrl: string | null | undefined): ForgeHome | null {
  const home = forgeHomeOf({ home: r.home, group: { channel: r.channel, chatId: r.chatId } }, gitlabUrl)
  return home?.ref.mr ? home : null
}

export interface WallDiffDeps {
  store: Pick<RequestStore, "get">
  gitlabUrl: string | null | undefined
  /** The home's unified diff: the review gate's getDiff for its forge. */
  diff: (home: ForgeHome) => Promise<string>
}

export type Reply = { status: number; body: unknown }

export async function handleWallDiff(q: URLSearchParams, deps: WallDiffDeps | null): Promise<Reply> {
  const id = (q.get("id") ?? "").trim()
  if (!id) return { status: 400, body: { error: "send ?id=<post id>" } }
  const r = deps?.store.get(id)
  if (!deps || !r || r.state === "candidate") return { status: 404, body: { error: `no post "${id}" on this computer` } }
  const home = mergeHomeOf(r, deps.gitlabUrl)
  if (!home) return { status: 400, body: { error: "not a merge or pull request" } }
  let text: string
  try {
    text = await deps.diff(home)
  } catch (e: any) {
    return { status: 502, body: { error: `${home.provider === "github" ? "GitHub" : "GitLab"} did not give the diff: ${e?.message ?? e}` } }
  }
  const { files, truncated } = capDiff(parseUnifiedDiff(text), DIFF_LINES_MAX)
  return { status: 200, body: { ref: home.key, provider: home.provider, files, truncated } }
}

export interface DiffComment {
  file: string
  side: "old" | "new"
  line: number
  text: string
  code?: string
}

/** The comments of a diff-comments body, or why they are refused. */
export function parseDiffComments(v: unknown): { comments: DiffComment[] } | { error: string } {
  if (!Array.isArray(v) || v.length < 1 || v.length > DIFF_COMMENTS_MAX) return { error: `send 1 to ${DIFF_COMMENTS_MAX} comments` }
  const comments: DiffComment[] = []
  for (const [i, c] of v.entries()) {
    const n = i + 1
    if (!c || typeof c !== "object") return { error: `comment ${n} is not an object` }
    const file = typeof c.file === "string" ? c.file.trim() : ""
    const text = typeof c.text === "string" ? c.text.trim() : ""
    if (!file || file.length > 500) return { error: `comment ${n} needs its file` }
    if (c.side !== "old" && c.side !== "new") return { error: `comment ${n}: side is old or new` }
    if (!Number.isInteger(c.line) || c.line < 1) return { error: `comment ${n}: line is a positive whole number` }
    if (!text) return { error: `comment ${n} is empty` }
    if (text.length > DIFF_COMMENT_TEXT_MAX) return { error: `comment ${n} is longer than ${DIFF_COMMENT_TEXT_MAX} characters` }
    const code = typeof c.code === "string" ? c.code.replace(/\s+/g, " ").trim().slice(0, CODE_MAX) : ""
    comments.push({ file, side: c.side, line: c.line, text, ...(code ? { code } : {}) })
  }
  return { comments }
}

/** The one message the agent gets: the ref, each comment in order, then
 *  what to do with them. */
export function diffCommentsMessage(home: Pick<ForgeHome, "provider" | "key">, comments: DiffComment[]): string {
  const kind = home.provider === "github" ? "pull request" : "merge request"
  const blocks = comments.map((c, i) => [
    `${i + 1}. \`${c.file}:${c.line}\` (${c.side})`,
    ...(c.code ? [`> ${c.code}`] : []),
    c.text,
  ].join("\n"))
  return [
    `Review comments on ${home.key}, from the ${HUB_NAME}:`,
    ...blocks,
    `Please address ${comments.length === 1 ? "it" : `all ${comments.length} of them`} on the ${kind}'s branch, push, and reply here when done.`,
  ].join("\n\n")
}
