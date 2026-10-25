import type { ReviewGate } from "./review-gate"
import { summarizeReviews, type FileReviewLedger, type ReviewRecord } from "./review-ledger"

// --- HTTP surface for the review gate (#990) ---
//
//   GET  /api/review-gate/reviews[?days=7&replays=1]  summary + recent reviews
//   POST /api/review-gate/replay  { repo, prs: [n…] }  review past PRs, post nothing
//
// The replay answers as NDJSON, one line per PR as it finishes, with a
// blank line every 30 s so a long review does not hit the client's idle
// timeout. Reviews hold PR numbers and costs: the paths are mesh-gated,
// and the replay is a control post (it spends model budget).

export function isReviewGatePath(path: string): boolean {
  return path === "/api/review-gate/reviews" || path === "/api/review-gate/replay"
}

/** A review without its free text: list replies stay bounded. */
function brief(r: ReviewRecord) {
  return {
    at: r.at, repo: r.repo, pr: r.pr, sha: r.sha.slice(0, 12), state: r.state, reason: r.reason.slice(0, 200),
    reviewer: r.reviewer, model: r.model, unmet: r.unmet, defects: r.defects, costUsd: r.costUsd, minutes: r.minutes,
    sincePushMinutes: r.sincePushMinutes, ...(r.forge ? { forge: r.forge } : {}), ...(r.replay ? { replay: true } : {}),
  }
}

export function reviewsReply(ledger: FileReviewLedger, params: URLSearchParams, now = Date.now()): Record<string, unknown> {
  const days = Math.min(90, Math.max(1, Number(params.get("days")) || 7))
  const records = ledger.read({ from: new Date(now - days * 86_400_000), includeReplays: params.get("replays") === "1" })
  return { days, summary: summarizeReviews(records.filter((r) => !r.replay)), reviews: records.slice(-100).reverse().map(brief) }
}

export interface ReplayLine {
  pr: number
  state?: string
  reason?: string
  unmet?: number
  defects?: number
  flagged?: boolean
  error?: string
}

/** Review each PR at its current head without posting. A PR counts as
 *  flagged when the reviewer found unmet criteria or defects. */
export async function replay(
  gate: ReviewGate,
  repo: string,
  prs: number[],
  write: (line: ReplayLine | { done: true; flagged: number; of: number }) => void,
): Promise<void> {
  let flagged = 0
  for (const pr of prs) {
    try {
      const o = await gate.review(repo, pr, { post: false, replay: true })
      const isFlagged = o.state === "failure" && (o.unmet.length > 0 || o.defects.length > 0)
      if (isFlagged) flagged++
      write({ pr, state: o.state, reason: o.reason, unmet: o.unmet.length, defects: o.defects.length, flagged: isFlagged })
    } catch (e: any) {
      write({ pr, error: e?.message || String(e) })
    }
  }
  write({ done: true, flagged, of: prs.length })
}

export function parseReplayBody(body: Record<string, unknown>): { repo: string; prs: number[]; forge: "github" | "gitlab" } | { error: string } {
  const forge = body.forge === "gitlab" ? "gitlab" : "github"
  if (body.forge !== undefined && body.forge !== "github" && body.forge !== "gitlab") return { error: "forge must be github or gitlab" }
  const repo = typeof body.repo === "string" ? body.repo.trim() : ""
  // A GitLab project can sit in subgroups: group/subgroup/project.
  if (forge === "gitlab" ? !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repo) : !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { error: forge === "gitlab" ? "repo must be group/project" : "repo must be owner/name" }
  }
  const prs = (Array.isArray(body.prs) ? body.prs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (!prs.length || prs.length > 20) return { error: "prs must list 1 to 20 PR numbers" }
  return { repo, prs, forge }
}
