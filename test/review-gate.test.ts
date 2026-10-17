import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { reviewGateConfigSchema, daemonConfigSchema } from "../src/daemon/config"
import {
  acceptanceCriteria, buildReviewPrompt, linkedIssues, matchesPath, parseVerdict, ReviewGate, statusText,
  type CiCheck, type IssueInfo, type PullRequestEvent, type ReviewerRequest, type ReviewerRun, type ReviewGateGitHub,
} from "../src/quality/review-gate"
import { FileReviewLedger, summarizeReviews, type ReviewRecord } from "../src/quality/review-ledger"
import { parseReplayBody, replay } from "../src/quality/review-gate-api"
import { GitHubAdapter } from "../src/channels/github"
import type { IncomingMessage } from "../src/channels/types"

// The pre-merge review gate (#990): a different agent, in a fresh session,
// checks an agent PR against its linked issue and posts `agentx/review`.

const REPO = "acme/api"
const SHA1 = "a".repeat(40)
const SHA2 = "b".repeat(40)
const AUTHOR_NOTE = "AUTHOR-TRANSCRIPT: I decided to skip the retry case"

const ISSUE: IssueInfo = {
  repo: REPO,
  number: 12,
  title: "Retry failed uploads",
  body: "Uploads fail on a flaky network.\n\n## Acceptance criteria\n\n- [ ] A failed upload is retried 3 times\n- [ ] The last error is shown to the user\n\n## Notes\n\n- [ ] not a criterion\n",
  isPullRequest: false,
}
const DIFF = "diff --git a/src/upload.ts b/src/upload.ts\n+export const RETRIES = 3\n"

interface Fake {
  gh: ReviewGateGitHub
  statuses: Array<{ sha: string; state: string; description: string }>
  comments: string[]
  calls: string[]
  pr: { body: string; headSha: string }
  checks: CiCheck[]
}

function fakeGitHub(prBody = `Closes #12\n\n${AUTHOR_NOTE}`): Fake {
  const f: Fake = { statuses: [], comments: [], calls: [], pr: { body: prBody, headSha: SHA1 }, checks: [{ name: "ci", state: "success" }] } as Fake
  f.gh = {
    async getPullRequest(_repo, number) {
      f.calls.push("pr")
      return { number, headSha: f.pr.headSha, title: `Title ${AUTHOR_NOTE}`, body: f.pr.body, authorLogin: "acme-agentx", draft: false, state: "open" }
    },
    async getDiff() { f.calls.push("diff"); return DIFF },
    async getChangedFiles() { f.calls.push("files"); return ["src/upload.ts"] },
    async getIssue(repo, number) { f.calls.push(`issue:${number}`); return number === 12 ? ISSUE : null },
    async getChecks() { f.calls.push("checks"); return f.checks },
    async setStatus(_repo, sha, state, description) { f.statuses.push({ sha, state, description }) },
    async comment(_repo, _n, body) { f.comments.push(body); return undefined },
  }
  return f
}

const APPROVE = JSON.stringify({ verdict: "approve", unmet: [], defects: [], summary: "Meets both criteria." })
const REJECT = JSON.stringify({
  verdict: "request_changes",
  unmet: [{ criterion: "The last error is shown to the user", why: "error is swallowed" }],
  defects: [{ file: "src/upload.ts", line: 1, problem: "RETRIES is never read" }],
  summary: "Retries are declared, not used.",
})

function run(content: string, extra: Partial<ReviewerRun> = {}): ReviewerRun {
  return { content, model: "model-b", tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.12, durationMs: 90_000, ...extra }
}

function gate(opts: {
  config?: Record<string, unknown>
  fake?: Fake
  reply?: (req: ReviewerRequest) => Promise<ReviewerRun>
  agentLogin?: boolean
} = {}) {
  const fake = opts.fake ?? fakeGitHub()
  const records: ReviewRecord[] = []
  const requests: ReviewerRequest[] = []
  const config = reviewGateConfigSchema.parse({ enabled: true, reviewer: { agent: "reviewer" }, ciWaitMinutes: 0, ...opts.config })
  const g = new ReviewGate({
    config: () => config,
    github: fake.gh,
    runReviewer: async (req) => { requests.push(req); return opts.reply ? opts.reply(req) : run(APPROVE) },
    repoAgent: () => "coder",
    agentModel: (id) => (id === "coder" ? "model-a" : "model-b"),
    isAgentLogin: () => opts.agentLogin ?? true,
    ledger: { append: (r) => records.push(r) },
    sleep: async () => {},
  })
  return { g, fake, records, requests, config }
}

function event(action = "opened", sha = SHA1, extra: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return { action, repo: REPO, number: 9, headSha: sha, authorLogin: "acme-agentx", title: "t", body: "Closes #12", ...extra }
}

describe("config", () => {
  it("is off by default, advisory, with budgets set", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n1", name: "demo" }, agents: {} } as any)
    expect(cfg.quality.reviewGate.enabled).toBe(false)
    expect(cfg.quality.reviewGate.mode).toBe("advisory")
    expect(cfg.quality.reviewGate.maxCostPerReview).toBeGreaterThan(0)
    expect(cfg.quality.reviewGate.maxMinutes).toBeGreaterThan(0)
    expect(cfg.quality.reviewGate.paths).toEqual([])
  })
})

describe("gate off", () => {
  it("does nothing: no GitHub call, no reviewer, no ledger row", async () => {
    const t = gate({ config: { enabled: false } })
    expect(t.g.onPullRequest(event())).toBeNull()
    expect(t.fake.calls).toEqual([])
    expect(t.fake.statuses).toEqual([])
    expect(t.requests).toEqual([])
    expect(t.records).toEqual([])
  })

  it("leaves the GitHub adapter's PR runs unchanged", async () => {
    vi.useFakeTimers()
    try {
      const body = {
        action: "opened",
        pull_request: {
          number: 9, title: "Add thing", body: "", state: "open", html_url: `https://github.com/${REPO}/pull/9`,
          head: { ref: "feat", sha: SHA1 }, base: { ref: "main" }, user: { login: "alex", id: 1 },
        },
        sender: { login: "alex", id: 1 },
        repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
      }
      const runsFor = async (wire: boolean): Promise<IncomingMessage[]> => {
        const gh = new GitHubAdapter({ routes: [{ repo: REPO, agent: "coder" }], debounceSeconds: 0 }, () => {})
        const runs: IncomingMessage[] = []
        gh.onMessage(async (m) => { runs.push(m) })
        if (wire) {
          const t = gate({ config: { enabled: false } })
          gh.onPullRequestEvent((e) => { void t.g.onPullRequest(e) })
        }
        await gh.handleWebhook({ "x-github-event": "pull_request" }, body)
        await vi.advanceTimersByTimeAsync(10)
        return runs
      }
      const without = await runsFor(false)
      const withGate = await runsFor(true)
      expect(withGate.length).toBe(without.length)
      expect(withGate.map((r) => r.text)).toEqual(without.map((r) => r.text))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("reviewer input", () => {
  it("holds the issue ACs, the diff and CI, and nothing from the author", async () => {
    const t = gate()
    await t.g.onPullRequest(event())
    expect(t.requests).toHaveLength(1)
    const req = t.requests[0]
    expect(req.prompt).toContain("A failed upload is retried 3 times")
    expect(req.prompt).toContain("The last error is shown to the user")
    expect(req.prompt).toContain(DIFF.trim())
    expect(req.prompt).toContain("- ci: success")
    // Neither the PR title nor its body (the author's own account of the
    // change) reaches the reviewer.
    expect(req.prompt).not.toContain(AUTHOR_NOTE)
    // A different agent from the author, on a session of its own per commit.
    expect(req.agentId).toBe("reviewer")
    expect(req.agentId).not.toBe("coder")
    expect(req.chatId).toContain(SHA1.slice(0, 12))
    expect(req.model).toBe("model-b")
  })

  it("uses the configured reviewer model over the agent's", async () => {
    const t = gate({ config: { reviewer: { agent: "reviewer", model: "model-c" } } })
    await t.g.onPullRequest(event())
    expect(t.requests[0].model).toBe("model-c")
  })

  it("buildReviewPrompt marks a cut diff", () => {
    const p = buildReviewPrompt({ issues: [ISSUE], criteria: ["x"], diff: "d", diffTruncated: true, checks: [] })
    expect(p).toContain("was cut to fit")
    expect(p).toContain("no CI checks reported")
  })
})

describe("statuses", () => {
  it("posts pending, then success on the head commit for an approval", async () => {
    const t = gate()
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("success")
    expect(t.fake.statuses.map((s) => s.state)).toEqual(["pending", "success"])
    expect(t.fake.statuses.every((s) => s.sha === SHA1)).toBe(true)
    expect(t.fake.statuses[1].description).toMatch(/^\[advisory\] approved/)
    expect(t.fake.comments).toEqual([])
  })

  it("posts failure with unmet ACs and file:line defects in a comment", async () => {
    const t = gate({ reply: async () => run(REJECT), config: { mode: "required" } })
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("failure")
    expect(t.fake.statuses.at(-1)).toMatchObject({ state: "failure", description: "1 unmet AC, 1 defect; see the review comment" })
    expect(t.fake.comments[0]).toContain("The last error is shown to the user")
    expect(t.fake.comments[0]).toContain("`src/upload.ts:1` RETRIES is never read")
  })

  it("fails a PR with no linked issue, without running the reviewer", async () => {
    const fake = fakeGitHub("Some change, see the code.")
    const t = gate({ fake })
    const o = await t.g.onPullRequest(event("opened", SHA1, { body: "" }))
    expect(o?.state).toBe("failure")
    expect(o?.reason).toMatch(/^no linked issue\/ACs/)
    expect(t.fake.statuses.at(-1)!.description).toContain("no linked issue/ACs")
    expect(t.requests).toEqual([])
  })

  it("fails a PR whose issue has no acceptance criteria", async () => {
    const fake = fakeGitHub("Closes #12")
    fake.gh.getIssue = async () => ({ ...ISSUE, body: "Just do it." })
    const t = gate({ fake })
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("failure")
    expect(o?.reason).toContain("no linked issue/ACs")
  })

  it("is an error when no reviewer is set or it is the author", async () => {
    const none = gate({ config: { reviewer: {} } })
    expect((await none.g.onPullRequest(event()))?.state).toBe("error")
    const self = gate({ config: { reviewer: { agent: "coder" } } })
    const o = await self.g.onPullRequest(event())
    expect(o?.state).toBe("error")
    expect(o?.reason).toContain("author")
    expect(self.requests).toEqual([])
  })

  it("is an error when the reply holds no verdict, or the reviewer failed", async () => {
    expect((await gate({ reply: async () => run("Looks good to me!") }).g.onPullRequest(event()))?.state).toBe("error")
    expect((await gate({ reply: async () => run("", { error: "rate limited" }) }).g.onPullRequest(event()))?.state).toBe("error")
  })

  it("skips non-agent PRs and drafts", () => {
    expect(gate({ agentLogin: false }).g.onPullRequest(event())).toBeNull()
    expect(gate().g.onPullRequest(event("opened", SHA1, { draft: true }))).toBeNull()
  })

  it("counts a PR signed with the agentx marker as an agent PR", async () => {
    const t = gate({ agentLogin: false })
    expect(await t.g.onPullRequest(event("opened", SHA1, { body: "Closes #12\n\n<!-- agentx:coder -->" }))).not.toBeNull()
  })

  it("passes a PR outside `paths` with an explicit skip, not a review", async () => {
    const t = gate({ config: { paths: ["src/daemon/**"] } })
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("success")
    expect(o?.reason).toMatch(/^skipped/)
    expect(t.requests).toEqual([])
  })
})

describe("budget guard", () => {
  it("over maxCostPerReview is an error with the reason, never success", async () => {
    const t = gate({ config: { maxCostPerReview: 0.05 }, reply: async () => run(APPROVE, { costUsd: 0.2 }) })
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("error")
    expect(o?.reason).toContain("maxCostPerReview")
    expect(t.fake.statuses.at(-1)!.state).toBe("error")
    expect(t.records[0].costUsd).toBe(0.2)
  })

  it("over maxMinutes is an error with the reason, never success", async () => {
    const t = gate({ config: { maxMinutes: 1 }, reply: async () => run(APPROVE, { durationMs: 61_000 }) })
    const o = await t.g.onPullRequest(event())
    expect(o?.state).toBe("error")
    expect(o?.reason).toContain("maxMinutes")
  })

  it("stops the reviewer at maxMinutes", async () => {
    vi.useFakeTimers()
    try {
      const t = gate({
        config: { maxMinutes: 1 },
        reply: (req) => new Promise((resolve) => {
          req.signal.addEventListener("abort", () => resolve(run("", { error: "aborted", durationMs: 60_000 })))
        }),
      })
      const p = t.g.onPullRequest(event())!
      await vi.advanceTimersByTimeAsync(60_001)
      const o = await p
      expect(o?.state).toBe("error")
      expect(o?.reason).toContain("maxMinutes")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("new pushes", () => {
  it("reviews each new head commit; an approval does not carry over", async () => {
    let n = 0
    const t = gate({ reply: async () => run(n++ === 0 ? APPROVE : REJECT) })
    await t.g.onPullRequest(event("opened", SHA1))
    t.fake.pr.headSha = SHA2
    await t.g.onPullRequest(event("synchronize", SHA2))
    expect(t.requests).toHaveLength(2)
    const final = t.fake.statuses.filter((s) => s.state !== "pending")
    expect(final).toEqual([
      expect.objectContaining({ sha: SHA1, state: "success" }),
      expect.objectContaining({ sha: SHA2, state: "failure" }),
    ])
  })

  it("reviews a commit once, and again after an edit adds the issue link", async () => {
    const fake = fakeGitHub("no link yet")
    const t = gate({ fake })
    await t.g.onPullRequest(event())
    expect(t.g.onPullRequest(event("reopened"))).toBeNull()
    fake.pr.body = "Closes #12"
    const o = await t.g.onPullRequest(event("edited"))
    expect(o?.state).toBe("success")
    // An approved commit is not reviewed again on an edit.
    expect(t.g.onPullRequest(event("edited"))).toBeNull()
  })

  it("stops the review of an older commit when a newer one arrives", async () => {
    let release: () => void = () => {}
    const t = gate({
      reply: (req) => req.chatId.includes(SHA1.slice(0, 12))
        ? new Promise((resolve) => {
          req.signal.addEventListener("abort", () => resolve(run("", { error: "aborted" })))
          release = () => resolve(run(APPROVE))
        })
        : Promise.resolve(run(APPROVE)),
    })
    const first = t.g.onPullRequest(event("opened", SHA1))!
    await vi.waitFor(() => expect(t.requests).toHaveLength(1))
    t.fake.pr.headSha = SHA2
    const second = t.g.onPullRequest(event("synchronize", SHA2))!
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a?.reason).toContain("superseded")
    expect(b?.state).toBe("success")
    // Nothing final was posted on the older commit.
    expect(t.fake.statuses.filter((s) => s.sha === SHA1 && s.state !== "pending")).toEqual([])
  })
})

describe("ledger", () => {
  it("records tokens, cost and minutes per PR", async () => {
    const t = gate()
    await t.g.onPullRequest(event())
    expect(t.records).toHaveLength(1)
    expect(t.records[0]).toMatchObject({
      repo: REPO, pr: 9, sha: SHA1, state: "success", reviewer: "reviewer", authorAgent: "coder",
      model: "model-b", costUsd: 0.12, minutes: 1.5, tokens: { input: 1000, output: 200 },
    })
    expect(t.records[0].sincePushMinutes).toBeUndefined()
  })

  it("persists to a file and sums into the report's review line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-ledger-"))
    try {
      const ledger = new FileReviewLedger(path.join(dir, "q", "review-gate.jsonl"))
      const base = { repo: REPO, sha: SHA1, mode: "advisory" as const, reason: "" }
      ledger.append({ ...base, at: "2026-10-10T10:00:00Z", pr: 1, state: "success", costUsd: 0.1, minutes: 2, sincePushMinutes: 4, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } })
      ledger.append({ ...base, at: "2026-10-11T10:00:00Z", pr: 1, state: "failure", costUsd: 0.3, minutes: 3, sincePushMinutes: 12 })
      ledger.append({ ...base, at: "2026-10-12T10:00:00Z", pr: 2, state: "error", minutes: 1 })
      ledger.append({ ...base, at: "2026-10-12T11:00:00Z", pr: 3, state: "failure", replay: true, costUsd: 9 })
      const rows = ledger.read({ from: new Date("2026-10-10T00:00:00Z") })
      expect(rows).toHaveLength(3)
      const s = summarizeReviews(rows)
      expect(s).toMatchObject({ reviews: 3, prs: 2, byState: { success: 1, failure: 1, error: 1 }, costUsd: 0.4, unpriced: 1, minutes: 6, tokens: 15, p90SincePushMinutes: 12 })
      expect(ledger.read({ includeReplays: true })).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("replay", () => {
  it("reviews past PRs without posting and counts the flagged ones", async () => {
    let n = 0
    const t = gate({ reply: async () => run(n++ % 2 ? REJECT : APPROVE) })
    const lines: any[] = []
    await replay(t.g, REPO, [1, 2, 3], (l) => lines.push(l))
    expect(t.fake.statuses).toEqual([])
    expect(t.fake.comments).toEqual([])
    expect(lines.at(-1)).toEqual({ done: true, flagged: 1, of: 3 })
    expect(t.records.every((r) => r.replay)).toBe(true)
  })

  it("validates its body", () => {
    expect(parseReplayBody({ repo: "acme/api", prs: [1, "2"] })).toEqual({ repo: "acme/api", prs: [1, 2] })
    expect(parseReplayBody({ repo: "nope", prs: [1] })).toHaveProperty("error")
    expect(parseReplayBody({ repo: "acme/api", prs: [] })).toHaveProperty("error")
  })
})

describe("helpers", () => {
  it("linkedIssues reads closing keywords, not bare mentions", () => {
    expect(linkedIssues("Closes #12", REPO)).toEqual([{ repo: REPO, number: 12 }])
    expect(linkedIssues("Fixes other/repo#3 and refs #4, #5", REPO)).toEqual([
      { repo: "other/repo", number: 3 }, { repo: REPO, number: 4 }, { repo: REPO, number: 5 },
    ])
    expect(linkedIssues("Part of #987. Resolves: #990", REPO).map((l) => l.number)).toEqual([987, 990])
    expect(linkedIssues("Follow-up to #77, see #78", REPO)).toEqual([])
    expect(linkedIssues("<!-- closes #1 -->", REPO)).toEqual([])
  })

  it("acceptanceCriteria takes the AC section, else every checklist item", () => {
    expect(acceptanceCriteria(ISSUE.body)).toEqual(["A failed upload is retried 3 times", "The last error is shown to the user"])
    expect(acceptanceCriteria("Do:\n- [ ] one\n- [x] two\n- plain")).toEqual(["one", "two"])
    expect(acceptanceCriteria("**Acceptance criteria**\n1. first\n2. second")).toEqual(["first", "second"])
    expect(acceptanceCriteria("nothing here")).toEqual([])
  })

  it("matchesPath handles * and ** and folders", () => {
    expect(matchesPath("src/daemon/index.ts", "src/daemon/**")).toBe(true)
    expect(matchesPath("src/daemon/index.ts", "src/daemon")).toBe(true)
    expect(matchesPath("src/daemon/ui/x.ts", "src/daemon/*.ts")).toBe(false)
    expect(matchesPath("src/daemon/x.ts", "src/daemon/*.ts")).toBe(true)
    expect(matchesPath("docs/a.md", "**/*.md")).toBe(true)
    expect(matchesPath("a.md", "**/*.md")).toBe(true)
    expect(matchesPath("src/agents/x.ts", "src/daemon/**")).toBe(false)
  })

  it("parseVerdict refuses an approval that lists problems", () => {
    expect(parseVerdict(APPROVE)?.approve).toBe(true)
    expect(parseVerdict(JSON.stringify({ verdict: "approve", defects: [{ problem: "x" }] }))?.approve).toBe(false)
    expect(parseVerdict("```json\n" + REJECT + "\n```")?.defects).toEqual([{ file: "src/upload.ts", line: 1, problem: "RETRIES is never read" }])
    expect(parseVerdict("{\"verdict\": \"maybe\"}")).toBeNull()
  })

  it("statusText fits GitHub's 140 characters", () => {
    expect(statusText("x".repeat(300))).toHaveLength(140)
  })
})
