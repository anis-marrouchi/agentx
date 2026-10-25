import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

// --- Review ledger (#990) ---
//
// One JSON line per review the gate ran, finished or not, in
// `.agentx/quality/review-gate.jsonl`. It holds what a review cost (tokens,
// US dollars, minutes) per PR, so the weekly quality report (#988) can show
// review cost as its own line. The file stays on the node: absolute costs
// are never posted to GitHub.

export interface ReviewRecord {
  at: string
  repo: string
  pr: number
  sha: string
  mode: "advisory" | "required"
  state: "success" | "failure" | "error"
  reason: string
  reviewer?: string
  authorAgent?: string
  model?: string
  sameModelAsAuthor?: boolean
  issues?: string[]
  unmet?: number
  defects?: number
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costUsd?: number
  /** The reviewer was started, whether or not it returned: counted by
   *  maxReviewsPerPrPerDay. */
  reviewerRan?: boolean
  /** Reviewer run time. */
  minutes?: number
  /** Time spent waiting for CI before the review started. */
  ciWaitMinutes?: number
  /** From the push to the posted status: the latency the gate promises. */
  sincePushMinutes?: number
  statusPostedAt?: string
  diffTruncated?: boolean
  /** The project's tests before the review (#1285), when configured. */
  tests?: "passed" | "failed" | "skipped"
  /** Run by `agentx review-gate replay`: nothing was posted. */
  replay?: boolean
  /** Set for a GitLab merge request; unset means GitHub. */
  forge?: "gitlab"
}

export interface ReviewLedger {
  append(record: ReviewRecord): void
  /** Records since `from`, for the per-PR review limit after a restart. */
  read?(opts: { from?: Date }): ReviewRecord[]
}

export function reviewLedgerPath(cwd = process.cwd()): string {
  return `${cwd}/.agentx/quality/review-gate.jsonl`
}

export class FileReviewLedger implements ReviewLedger {
  constructor(private path: string, private log: (msg: string) => void = () => {}) {}

  append(record: ReviewRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(record) + "\n")
    } catch (e: any) {
      this.log(`review ledger write failed: ${e?.message || e}`)
    }
  }

  /** Records from `from` (inclusive) to `to` (exclusive), oldest first. */
  read(opts: { from?: Date; to?: Date; includeReplays?: boolean } = {}): ReviewRecord[] {
    if (!existsSync(this.path)) return []
    const from = opts.from?.getTime() ?? -Infinity
    const to = opts.to?.getTime() ?? Infinity
    const out: ReviewRecord[] = []
    for (const line of readFileSync(this.path, "utf-8").split("\n")) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as ReviewRecord
        const t = Date.parse(r.at)
        if (t >= from && t < to && (opts.includeReplays || !r.replay)) out.push(r)
      } catch { /* a torn line from a crash */ }
    }
    return out
  }
}

export interface ReviewCostSummary {
  reviews: number
  prs: number
  byState: Record<"success" | "failure" | "error", number>
  tokens: number
  costUsd: number
  /** Reviews whose cost nobody could price. */
  unpriced: number
  minutes: number
  /** 90th percentile push → status, over reviews that posted one. */
  p90SincePushMinutes?: number
}

/** The review line of the weekly quality report (#988). */
export function summarizeReviews(records: ReviewRecord[]): ReviewCostSummary {
  const byState = { success: 0, failure: 0, error: 0 }
  let tokens = 0, costUsd = 0, unpriced = 0, minutes = 0
  const latencies: number[] = []
  for (const r of records) {
    byState[r.state]++
    if (r.tokens) tokens += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite
    if (r.costUsd !== undefined) costUsd += r.costUsd
    else if (r.minutes !== undefined) unpriced++
    minutes += r.minutes ?? 0
    if (r.sincePushMinutes !== undefined) latencies.push(r.sincePushMinutes)
  }
  latencies.sort((a, b) => a - b)
  return {
    reviews: records.length,
    prs: new Set(records.map((r) => `${r.repo}#${r.pr}`)).size,
    byState,
    tokens,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    unpriced,
    minutes: Math.round(minutes * 100) / 100,
    ...(latencies.length ? { p90SincePushMinutes: latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.9) - 1)] } : {}),
  }
}
