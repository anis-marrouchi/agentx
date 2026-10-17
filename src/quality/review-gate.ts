import type { z } from "zod"
import type { reviewGateConfigSchema } from "@/daemon/config"
import { detectAgentxMarker } from "@/channels/outbound-marker"
import { firstJsonObject } from "@/wiki/model-call"
import type { ReviewLedger, ReviewRecord } from "./review-ledger"

// --- Pre-merge review gate (#990) ---
//
// Before an agent's pull request merges, a different agent checks it
// against the issue it says it fixes. The reviewer starts in a fresh
// session and is given three things only: the linked issue (text and
// acceptance criteria), the diff, and the CI result. Not the PR title or
// body, not the author's transcript: the point is a second reading that
// does not inherit the author's blind spots.
//
// The verdict lands as the commit status `agentx/review` on the head
// commit: success (approve), failure (unmet criteria and defects, listed in
// a PR comment) or error (the review could not be done: no reviewer, over
// budget, an unreadable reply). A status belongs to one commit, so a push
// starts a new review and an earlier approval never covers the new code.
// Every review, finished or not, is written to the review ledger with its
// tokens, cost and minutes, for the weekly quality report (#988).

export type ReviewGateConfig = z.infer<typeof reviewGateConfigSchema>

export const REVIEW_STATUS_CONTEXT = "agentx/review"

/** The channel review runs are dispatched on. */
export const REVIEW_CHANNEL = "review-gate"

/** Pull request actions that start a review. `edited` covers a body that
 *  gained its "Closes #N" after the PR was opened. */
const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"])

/** Start of the failure reason for a PR the gate cannot check. */
export const NO_LINK = "no linked issue/ACs"

export type ReviewState = "success" | "failure" | "error"

export interface PullRequestEvent {
  action: string
  repo: string
  number: number
  headSha: string
  /** When the head commit was pushed (event time), for the latency figure. */
  pushedAt?: number
  draft?: boolean
  authorLogin: string
  title: string
  body: string
}

export interface PullRequestInfo {
  number: number
  headSha: string
  title: string
  body: string
  authorLogin: string
  draft: boolean
  state: string
}

export interface IssueInfo {
  repo: string
  number: number
  title: string
  body: string
  isPullRequest: boolean
}

export interface CiCheck {
  name: string
  /** success | failure | pending | neutral | skipped | cancelled | error … */
  state: string
}

/** What the gate needs from GitHub. Built from REST calls in the daemon. */
export interface ReviewGateGitHub {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>
  getDiff(repo: string, number: number): Promise<string>
  getChangedFiles(repo: string, number: number): Promise<string[]>
  getIssue(repo: string, number: number): Promise<IssueInfo | null>
  getChecks(repo: string, sha: string): Promise<CiCheck[]>
  setStatus(repo: string, sha: string, state: ReviewState | "pending", description: string): Promise<void>
  /** Posts a PR comment; returns its URL when known. */
  comment(repo: string, number: number, body: string, agentId: string): Promise<string | undefined>
}

export interface ReviewerRequest {
  agentId: string
  model?: string
  prompt: string
  /** Unique per reviewed commit, so no earlier session is resumed. */
  chatId: string
  timeoutMinutes: number
  signal: AbortSignal
}

export interface ReviewerRun {
  content: string
  error?: string
  /** Set when the run was stopped for taking longer than maxMinutes. */
  timedOut?: boolean
  model?: string
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Undefined when neither the provider nor the price table knows it. */
  costUsd?: number
  durationMs: number
}

export interface ReviewGateDeps {
  config: () => ReviewGateConfig
  github: ReviewGateGitHub
  runReviewer: (req: ReviewerRequest) => Promise<ReviewerRun>
  /** The agent that wrote PRs on this repo, when the PR body names none. */
  repoAgent: (repo: string) => string | undefined
  /** An agent's configured model, to tell whether reviewer and author share one. */
  agentModel: (agentId: string) => string | undefined
  /** True when the login is an account AgentX posts with (an agent PR). */
  isAgentLogin: (login: string) => boolean
  ledger: ReviewLedger
  log?: (msg: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface Finding {
  file?: string
  line?: number
  problem: string
}

export interface ReviewOutcome {
  state: ReviewState
  /** One line, for the commit status (cut to 140 characters there). */
  reason: string
  unmet: Array<{ criterion: string; why?: string }>
  defects: Finding[]
  summary?: string
  record: ReviewRecord
}

// --- Pure helpers ---

const CLOSING = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references|part of|issue)"
const LINK_RE = new RegExp(`\\b${CLOSING}\\s*:?\\s+((?:[\\w.-]+\\/[\\w.-]+)?#\\d+(?:\\s*(?:,|and)\\s*(?:[\\w.-]+\\/[\\w.-]+)?#\\d+)*)`, "gi")

/** Issues a PR body links with "Closes #12", "Fixes owner/repo#3",
 *  "Refs #4, #5" or "Part of #9", in order and without repeats. A bare
 *  "#12" is not a link: it is too often a mention. */
export function linkedIssues(body: string, repo: string): Array<{ repo: string; number: number }> {
  const out: Array<{ repo: string; number: number }> = []
  const seen = new Set<string>()
  const text = (body || "").replace(/<!--[\s\S]*?-->/g, "")
  for (const m of text.matchAll(LINK_RE)) {
    for (const ref of m[1].matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g)) {
      const r = ref[1] || repo
      const key = `${r.toLowerCase()}#${ref[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ repo: r, number: Number(ref[2]) })
    }
  }
  return out
}

/** The acceptance criteria of an issue: the list items under a heading
 *  that says "acceptance criteria" (or "definition of done"), else every
 *  checklist item in the body. */
export function acceptanceCriteria(body: string): string[] {
  const lines = (body || "").replace(/\r\n/g, "\n").split("\n")
  const item = (l: string) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)?.[1]
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*|\*\*)\s*(acceptance criteria|definition of done)\b/i.test(l))
  if (start >= 0) {
    const level = lines[start].match(/^\s*(#{1,6})/)?.[1].length ?? 6
    const out: string[] = []
    for (const l of lines.slice(start + 1)) {
      const h = l.match(/^\s*(#{1,6})\s/)
      if (h && h[1].length <= level) break
      const it = item(l)
      if (it) out.push(it)
    }
    if (out.length) return out
  }
  return lines.filter((l) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l)).map((l) => item(l)!).filter(Boolean)
}

/** Glob match for the `paths` filter: `**` crosses folders, `*` does not. */
export function matchesPath(file: string, pattern: string): boolean {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*" && pattern[i + 1] === "*") {
      re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*"
      i += pattern[i + 2] === "/" ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  // A folder name matches everything under it.
  return new RegExp(`^${re}(?:/.*)?$`).test(file)
}

export interface PromptInput {
  issues: IssueInfo[]
  criteria: string[]
  diff: string
  diffTruncated: boolean
  checks: CiCheck[]
}

/** The reviewer's whole input. Built from the issue, the diff and CI only:
 *  nothing the author wrote about the change, and no session of theirs. */
export function buildReviewPrompt(input: PromptInput): string {
  const issueText = input.issues
    .map((i) => `### ${i.repo}#${i.number}: ${i.title}\n\n${(i.body || "").trim()}`)
    .join("\n\n")
  const criteria = input.criteria.map((c, n) => `${n + 1}. ${c}`).join("\n")
  const ci = input.checks.length
    ? input.checks.map((c) => `- ${c.name}: ${c.state}`).join("\n")
    : "- no CI checks reported for this commit"
  return [
    "You are reviewing a pull request before it merges. Another agent wrote it. You have not seen their work or their reasoning, and you should not try to guess it: judge only the change in front of you.",
    "",
    "Check the diff against the issue's acceptance criteria. For each criterion, decide whether the diff meets it. Then look for concrete defects the change introduces: wrong behaviour, a missed case the issue names, a broken caller, a test that does not test what it claims. Name each defect by file and line in the new code. Do not report style preferences.",
    "",
    "## Issue",
    "",
    issueText,
    "",
    "## Acceptance criteria",
    "",
    criteria,
    "",
    "## CI result",
    "",
    ci,
    "",
    "## Diff",
    "",
    input.diffTruncated ? "The diff below was cut to fit. Say so in your summary if a criterion depends on the missing part.\n" : "",
    "```diff",
    input.diff,
    "```",
    "",
    "## Reply",
    "",
    "Reply with one JSON object and nothing else:",
    '{"verdict": "approve" | "request_changes", "unmet": [{"criterion": "<criterion text or number>", "why": "<what is missing>"}], "defects": [{"file": "<path>", "line": <line in the new file>, "problem": "<what is wrong>"}], "summary": "<one or two sentences>"}',
    'Use "approve" only when every criterion is met and you found no defect.',
  ].join("\n")
}

export interface Verdict {
  approve: boolean
  unmet: Array<{ criterion: string; why?: string }>
  defects: Finding[]
  summary?: string
}

/** The reviewer's JSON verdict, or null when the reply holds none. An
 *  approval that still lists unmet criteria or defects is not one. */
export function parseVerdict(reply: string): Verdict | null {
  const obj = firstJsonObject(reply || "")
  if (!obj || (obj.verdict !== "approve" && obj.verdict !== "request_changes")) return null
  const unmet = (Array.isArray(obj.unmet) ? obj.unmet : [])
    .map((u: any) => typeof u === "string" ? { criterion: u } : { criterion: String(u?.criterion ?? "").trim(), why: typeof u?.why === "string" ? u.why : undefined })
    .filter((u) => u.criterion)
  const defects = (Array.isArray(obj.defects) ? obj.defects : [])
    .map((d: any) => ({
      file: typeof d?.file === "string" && d.file ? d.file : undefined,
      line: Number.isInteger(Number(d?.line)) && Number(d.line) > 0 ? Number(d.line) : undefined,
      problem: String(d?.problem ?? "").trim(),
    }))
    .filter((d) => d.problem)
  return {
    approve: obj.verdict === "approve" && unmet.length === 0 && defects.length === 0,
    unmet,
    defects,
    summary: typeof obj.summary === "string" ? obj.summary.trim() : undefined,
  }
}

/** The PR comment for a failed review. No cost figures: the repository may
 *  be public, and absolute costs stay on the node. */
export function failureComment(sha: string, v: Pick<ReviewOutcome, "unmet" | "defects" | "summary">): string {
  const lines = [`**AgentX review: changes needed** on \`${sha.slice(0, 7)}\``, ""]
  if (v.summary) lines.push(v.summary, "")
  if (v.unmet.length) {
    lines.push("Acceptance criteria not met:")
    for (const u of v.unmet) lines.push(`- ${u.criterion}${u.why ? ` — ${u.why}` : ""}`)
    lines.push("")
  }
  if (v.defects.length) {
    lines.push("Defects:")
    for (const d of v.defects) lines.push(`- ${d.file ? `\`${d.file}${d.line ? `:${d.line}` : ""}\` ` : ""}${d.problem}`)
    lines.push("")
  }
  lines.push("A new push starts a new review.")
  return lines.join("\n")
}

/** GitHub caps a status description at 140 characters. */
export function statusText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= 140 ? t : `${t.slice(0, 139)}…`
}

// --- The gate ---

interface Running {
  sha: string
  abort: AbortController
}

export class ReviewGate {
  private running = new Map<string, Running>()
  /** Commits already reviewed (or being reviewed), by repo#n@sha. */
  private reviewed = new Map<string, { state: ReviewState | "running"; noLink?: boolean }>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(private deps: ReviewGateDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.log = deps.log ?? (() => {})
  }

  /** Called for every pull_request webhook. Does nothing while the gate is
   *  off. Returns the review promise when one started (tests await it). */
  onPullRequest(event: PullRequestEvent): Promise<ReviewOutcome | null> | null {
    const cfg = this.deps.config()
    if (!cfg.enabled) return null
    const key = `${event.repo}#${event.number}`
    if (event.action === "closed") {
      this.running.get(key)?.abort.abort()
      return null
    }
    if (!REVIEW_ACTIONS.has(event.action) || event.draft) return null
    if (!this.isAgentPR(event)) return null
    const shaKey = `${key}@${event.headSha}`
    const done = this.reviewed.get(shaKey)
    // A commit is reviewed once. An edit may add the missing issue link,
    // so a commit that failed for want of one is looked at again.
    if (done && !(event.action === "edited" && done.noLink)) return null
    const prev = this.running.get(key)
    if (prev && prev.sha !== event.headSha) prev.abort.abort()
    return this.review(event.repo, event.number, { headSha: event.headSha, pushedAt: event.pushedAt, post: true })
      .catch((e: any) => { this.log(`review of ${key} failed: ${e?.message || e}`); return null })
  }

  isAgentPR(event: Pick<PullRequestEvent, "authorLogin" | "body">): boolean {
    return this.deps.isAgentLogin(event.authorLogin) || detectAgentxMarker(event.body) !== null
  }

  /** Review one PR at its head (or the given) commit. `post: false` is the
   *  replay mode: the verdict is returned and recorded, nothing is posted. */
  async review(repo: string, number: number, opts: { headSha?: string; pushedAt?: number; post: boolean; replay?: boolean }): Promise<ReviewOutcome> {
    const cfg = this.deps.config()
    const gh = this.deps.github
    const key = `${repo}#${number}`
    const startedAt = this.now()
    const pr = await gh.getPullRequest(repo, number)
    const sha = opts.headSha || pr.headSha
    const shaKey = `${key}@${sha}`
    const abort = new AbortController()
    if (opts.post) {
      this.running.set(key, { sha, abort })
      this.reviewed.set(shaKey, { state: "running" })
    }
    const authorAgent = detectAgentxMarker(pr.body) ?? this.deps.repoAgent(repo)
    const reviewer = cfg.reviewer.agent
    const record: ReviewRecord = {
      at: new Date(startedAt).toISOString(),
      repo, pr: number, sha,
      mode: cfg.mode,
      state: "error",
      reason: "",
      reviewer, authorAgent,
      ...(opts.replay ? { replay: true } : {}),
    }

    const finish = async (state: ReviewState, reason: string, v?: Partial<Pick<ReviewOutcome, "unmet" | "defects" | "summary">>): Promise<ReviewOutcome> => {
      const outcome: ReviewOutcome = { state, reason, unmet: v?.unmet ?? [], defects: v?.defects ?? [], summary: v?.summary, record }
      record.state = state
      record.reason = reason
      record.unmet = outcome.unmet.length
      record.defects = outcome.defects.length
      const superseded = opts.post && this.running.get(key)?.sha !== sha
      if (opts.post && !superseded) {
        try {
          if (state !== "success" && (outcome.unmet.length || outcome.defects.length || outcome.summary)) {
            await gh.comment(repo, number, failureComment(sha, outcome), reviewer || "review-gate")
          }
          await gh.setStatus(repo, sha, state, statusText(`${cfg.mode === "advisory" ? "[advisory] " : ""}${reason}`))
          record.statusPostedAt = new Date(this.now()).toISOString()
          if (opts.pushedAt) record.sincePushMinutes = round((this.now() - opts.pushedAt) / 60_000)
        } catch (e: any) {
          record.reason = `${reason} (status not posted: ${e?.message || e})`
          this.log(`could not post ${REVIEW_STATUS_CONTEXT} on ${key}@${sha.slice(0, 7)}: ${e?.message || e}`)
        }
      }
      if (opts.post) {
        this.reviewed.set(shaKey, { state, noLink: reason.startsWith(NO_LINK) })
        // Oldest first: forget the oldest commits past a few thousand.
        for (const k of this.reviewed.keys()) {
          if (this.reviewed.size <= 5000) break
          this.reviewed.delete(k)
        }
        if (this.running.get(key)?.sha === sha) this.running.delete(key)
      }
      this.deps.ledger.append(record)
      return outcome
    }

    try {
      if (opts.post) await gh.setStatus(repo, sha, "pending", statusText(`${cfg.mode === "advisory" ? "[advisory] " : ""}review running`))

      if (!reviewer) return await finish("error", "no reviewer agent set (quality.reviewGate.reviewer.agent)")
      if (authorAgent && reviewer === authorAgent) return await finish("error", `reviewer ${reviewer} is the PR's author; pick a different agent`)

      if (cfg.paths.length) {
        const files = await gh.getChangedFiles(repo, number)
        if (!files.some((f) => cfg.paths.some((p) => matchesPath(f, p)))) {
          return await finish("success", "skipped: no changed file under quality.reviewGate.paths")
        }
      }

      const links = linkedIssues(pr.body, repo)
      const issues = (await Promise.all(links.map((l) => gh.getIssue(l.repo, l.number))))
        .filter((i): i is IssueInfo => !!i && !i.isPullRequest)
      if (!issues.length) return await finish("failure", `${NO_LINK}: add \"Closes #N\" to the PR description`)
      const criteria = issues.flatMap((i) => acceptanceCriteria(i.body))
      if (!criteria.length) return await finish("failure", `${NO_LINK}: ${issues.map((i) => `#${i.number}`).join(", ")} has no acceptance criteria`)
      record.issues = issues.map((i) => `${i.repo}#${i.number}`)

      const checks = await this.waitForChecks(repo, sha, cfg.ciWaitMinutes, abort.signal)
      record.ciWaitMinutes = round((this.now() - startedAt) / 60_000)
      if (abort.signal.aborted) return await finish("error", "superseded by a newer push")

      let diff = await gh.getDiff(repo, number)
      const maxBytes = cfg.maxDiffKb * 1024
      const diffTruncated = Buffer.byteLength(diff) > maxBytes
      if (diffTruncated) diff = Buffer.from(diff).subarray(0, maxBytes).toString("utf-8")
      record.diffTruncated = diffTruncated || undefined

      const prompt = buildReviewPrompt({ issues, criteria, diff, diffTruncated, checks })
      const model = cfg.reviewer.model ?? this.deps.agentModel(reviewer)
      const authorModel = authorAgent ? this.deps.agentModel(authorAgent) : undefined
      record.model = model
      if (model && authorModel && sameModel(model, authorModel)) {
        record.sameModelAsAuthor = true
        this.log(`${key}: reviewer and author both use ${model}; set quality.reviewGate.reviewer.model to a different one`)
      }

      const timer = setTimeout(() => abort.abort(new Error("timeout")), cfg.maxMinutes * 60_000)
      let run: ReviewerRun
      try {
        run = await this.deps.runReviewer({
          agentId: reviewer,
          model,
          prompt,
          chatId: `${REVIEW_CHANNEL}:${repo}#${number}@${sha.slice(0, 12)}${opts.replay ? ":replay" : ""}`,
          timeoutMinutes: cfg.maxMinutes,
          signal: abort.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      record.model = run.model ?? model
      record.tokens = run.tokens
      record.costUsd = run.costUsd
      record.minutes = round(run.durationMs / 60_000)

      const timedOut = run.timedOut || (abort.signal.aborted && String((abort.signal.reason as any)?.message) === "timeout") || run.durationMs > cfg.maxMinutes * 60_000
      if (timedOut) return await finish("error", `over budget: review took longer than ${cfg.maxMinutes} min (maxMinutes)`)
      if (abort.signal.aborted) return await finish("error", "superseded by a newer push")
      if (cfg.maxCostPerReview > 0 && run.costUsd !== undefined && run.costUsd > cfg.maxCostPerReview) {
        return await finish("error", `over budget: review cost more than maxCostPerReview (${cfg.maxCostPerReview})`)
      }
      if (run.error) return await finish("error", `reviewer failed: ${run.error}`)

      const verdict = parseVerdict(run.content)
      if (!verdict) return await finish("error", "reviewer reply held no verdict")
      if (verdict.approve) return await finish("success", `approved against ${record.issues.join(", ")}`, verdict)
      const parts = [
        verdict.unmet.length ? `${verdict.unmet.length} unmet AC${verdict.unmet.length > 1 ? "s" : ""}` : "",
        verdict.defects.length ? `${verdict.defects.length} defect${verdict.defects.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean)
      return await finish("failure", `${parts.join(", ") || "changes requested"}; see the review comment`, verdict)
    } catch (e: any) {
      return await finish("error", `review failed: ${e?.message || e}`)
    }
  }

  /** CI checks on the commit, waiting up to `minutes` for pending ones.
   *  Our own status is left out. */
  private async waitForChecks(repo: string, sha: string, minutes: number, signal: AbortSignal): Promise<CiCheck[]> {
    const deadline = this.now() + minutes * 60_000
    for (;;) {
      const checks = (await this.deps.github.getChecks(repo, sha)).filter((c) => c.name !== REVIEW_STATUS_CONTEXT)
      const pending = checks.some((c) => c.state === "pending" || c.state === "queued" || c.state === "in_progress")
      if (!pending || this.now() >= deadline || signal.aborted) return checks
      await this.sleep(Math.min(30_000, Math.max(0, deadline - this.now())))
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Same model name, ignoring case. An alias and its full id do not match. */
function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
