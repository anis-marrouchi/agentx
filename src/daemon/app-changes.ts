import type { IncomingMessage, ServerResponse } from "http"
import type { RequestRecord } from "@/requests/store"
import { readJson } from "./app-fleet"
import { diffHomeOf, handleWallDiff, type Reply, type WallDiffDeps } from "./wall-diff"
import { handleWallAction, type WallActionDeps } from "./wall-actions"

// --- Phone app: the Changes screen (#2101 C1b) ---
//
// Runs behind the device-token check in app-routes.ts, so a paired phone
// (the owner's) reads the same Diff view the Hub reads under /api/admin/
// (#2102, wall-diff.ts), without the dashboard token:
//
//   GET  /api/app/changes?agent=<id>[&pr=<ref>]
//        the diff of the agent's newest open request that lives on a
//        GitHub or GitLab issue, PR or MR, as GET /api/admin/wall/diff
//        answers it, plus request: {id, title}. No such request: request
//        null and no files.
//   POST /api/app/changes/comments  {id, pr?, headSha?, comments}
//        the line comments, sent to the agent exactly as the Hub's
//        POST /api/admin/wall/diff-comments sends them.
//
// Only this computer's requests: an agent on a mesh peer has none here.

export const APP_CHANGES_PATH = "/api/app/changes"
export const APP_CHANGES_COMMENTS_PATH = "/api/app/changes/comments"
const DIFF_COMMENTS_PATH = "/api/admin/wall/diff-comments"
/** As wall-actions.ts takes an agent id. */
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export interface AppChangesDeps {
  /** The Hub's wall deps, built per call (the store may be off). */
  wall(): WallActionDeps
  /** This computer's open requests. */
  open(): RequestRecord[]
}

/** The agent's newest open request with a forge home, or null. */
export function changesRequestFor(agent: string, open: RequestRecord[], gitlabUrl: string | null | undefined): RequestRecord | null {
  const mine = open.filter((r) => r.agentId === agent && diffHomeOf(r, gitlabUrl))
  mine.sort((a, b) => b.updatedAt - a.updatedAt)
  return mine[0] ?? null
}

export async function appChangesReply(q: { agent?: string; pr?: string }, open: RequestRecord[], deps: WallDiffDeps | null | undefined): Promise<Reply> {
  const agent = (q.agent ?? "").trim()
  if (!AGENT_RE.test(agent)) return { status: 400, body: { error: "send ?agent=<agent id>" } }
  const r = deps ? changesRequestFor(agent, open, deps.gitlabUrl) : null
  if (!r) return { status: 200, body: { request: null, prs: [], ref: null, files: [], truncated: false } }
  const reply = await handleWallDiff({ id: r.id, pr: q.pr ?? "" }, deps)
  if (reply.status !== 200) return reply
  return { status: 200, body: { request: { id: r.id, title: r.headline ?? null }, ...(reply.body as object) } }
}

/** Handles /api/app/changes*. Returns false for any other path. */
export async function handleAppChanges(req: IncomingMessage, res: ServerResponse, path: string, method: string, deps: AppChangesDeps): Promise<boolean> {
  if (path !== APP_CHANGES_PATH && path !== APP_CHANGES_COMMENTS_PATH) return false
  let reply: Reply
  if (path === APP_CHANGES_PATH) {
    if (method !== "GET") return json(res, 405, { error: "GET" })
    const q = new URL(req.url ?? "", "http://x").searchParams
    reply = await appChangesReply({ agent: q.get("agent") ?? "", pr: q.get("pr") ?? "" }, deps.open(), deps.wall().diff)
  } else {
    if (method !== "POST") return json(res, 405, { error: "POST" })
    const body = (await readJson(req).catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return json(res, 400, { error: "send JSON" })
    reply = (await handleWallAction("POST", DIFF_COMMENTS_PATH, body, deps.wall())) ?? { status: 404, body: { error: "not found" } }
  }
  return json(res, reply.status, reply.body)
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
