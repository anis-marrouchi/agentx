import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { reviewGateConfigSchema } from "../src/daemon/config"
import { ReviewGate, type IssueInfo, type ReviewerRequest, type ReviewGateGitHub } from "../src/quality/review-gate"
import type { ReviewRecord } from "../src/quality/review-ledger"
import { bareEnv, runTestStep, TESTS_STATUS_CONTEXT, type TestStepRequest, type TestStepResult } from "../src/quality/test-step"

// The project's tests before the review (#1285): the gate runs the
// configured command on the PR head, posts `agentx/tests` and a comment on
// failure, and hands the result to the reviewer.

const REPO = "acme/api"
const SHA = "a".repeat(40)
const ISSUE: IssueInfo = {
  repo: REPO, number: 12, title: "Retry uploads", isPullRequest: false,
  body: "## Acceptance criteria\n\n- [ ] A failed upload is retried 3 times\n",
}
const APPROVE = JSON.stringify({ verdict: "approve", unmet: [], defects: [], summary: "ok" })

function setup(opts: { result?: TestStepResult; author?: string; tests?: boolean } = {}) {
  const statuses: Array<{ state: string; description: string; context: string }> = []
  const comments: string[] = []
  const testRuns: TestStepRequest[] = []
  const prompts: ReviewerRequest[] = []
  const records: ReviewRecord[] = []
  const author = opts.author ?? "acme-agentx"
  const gh: ReviewGateGitHub = {
    async getPullRequest(_r, number) {
      return { number, headSha: SHA, title: "t", body: "Closes #12\n<!-- agentx:coder -->", authorLogin: author, draft: false, state: "open" }
    },
    async getDiff() { return "diff --git a/x b/x\n+x\n" },
    async getChangedFiles() { return ["x"] },
    async getIssue(_r, n) { return n === 12 ? ISSUE : null },
    async getChecks() { return [{ name: TESTS_STATUS_CONTEXT, state: "failure" }] },
    async setStatus(_r, _sha, state, description, context = "agentx/review") { statuses.push({ state, description, context }) },
    async comment(_r, _n, body) { comments.push(body); return undefined },
  }
  const config = reviewGateConfigSchema.parse({
    enabled: true, reviewer: { agent: "reviewer" }, ciWaitMinutes: 0,
    ...(opts.tests === false ? {} : { tests: { [REPO]: { checkout: "/repos/api", command: "npm test" } } }),
  })
  const g = new ReviewGate({
    config: () => config,
    github: gh,
    runReviewer: async (req) => { prompts.push(req); return { content: APPROVE, durationMs: 1000, costUsd: 0.01 } },
    repoAgent: () => "coder",
    agentModel: (id) => (id === "coder" ? "model-a" : "model-b"),
    isAgentLogin: (login) => login === "acme-agentx",
    ledger: { append: (r) => records.push(r), read: () => [] },
    runTests: async (req) => { testRuns.push(req); return opts.result ?? { passed: true, summary: "passed in 3 s", output: "ok", durationMs: 3000 } },
    sleep: async () => {},
  })
  return { g, statuses, comments, testRuns, prompts, records }
}

describe("review gate test step", () => {
  it("is off unless a repository has tests configured", () => {
    expect(reviewGateConfigSchema.parse({}).tests).toEqual({})
  })

  it("runs the tests on the PR head and posts agentx/tests before the review", async () => {
    const s = setup()
    const out = await s.g.review(REPO, 9, { headSha: SHA, post: true })
    expect(s.testRuns).toEqual([{ checkout: "/repos/api", command: "npm test", sha: SHA, ref: "pull/9/head", timeoutMinutes: 15 }])
    const tests = s.statuses.filter((x) => x.context === TESTS_STATUS_CONTEXT)
    expect(tests.map((x) => x.state)).toEqual(["pending", "success"])
    expect(tests[1].description).toContain("passed in 3 s")
    // The test status comes before the review's final one.
    expect(s.statuses.findIndex((x) => x.context === TESTS_STATUS_CONTEXT && x.state === "success"))
      .toBeLessThan(s.statuses.findIndex((x) => x.context === "agentx/review" && x.state === "success"))
    // The reviewer sees this run's result, not the stale status from getChecks.
    expect(s.prompts[0].prompt).toMatch(/agentx\/tests[^\n]*success/)
    expect(s.prompts[0].prompt).not.toMatch(/agentx\/tests[^\n]*failure/)
    expect(s.comments).toEqual([])
    expect(out.record.tests).toBe("passed")
  })

  it("comments the end of the output on failure and still reviews", async () => {
    const s = setup({ result: { passed: false, summary: "exit code 1 after 4 s", output: "FAIL upload.test.ts", durationMs: 4000 } })
    const out = await s.g.review(REPO, 9, { headSha: SHA, post: true })
    expect(s.statuses.filter((x) => x.context === TESTS_STATUS_CONTEXT).map((x) => x.state)).toEqual(["pending", "failure"])
    expect(s.comments[0]).toContain("agentx/tests: failed")
    expect(s.comments[0]).toContain("FAIL upload.test.ts")
    expect(s.comments[0]).toContain("npm test")
    expect(s.prompts[0].prompt).toMatch(/agentx\/tests[^\n]*failure/)
    expect(out.record.tests).toBe("failed")
  })

  it("does not run PR code for an author AgentX does not post as, even with a signature", async () => {
    const s = setup({ author: "stranger" })
    const out = await s.g.review(REPO, 9, { headSha: SHA, post: true })
    expect(s.testRuns).toEqual([])
    expect(s.statuses.some((x) => x.context === TESTS_STATUS_CONTEXT)).toBe(false)
    expect(out.record.tests).toBe("skipped")
  })

  it("runs nothing for a repository without tests, or on a replay", async () => {
    const off = setup({ tests: false })
    await off.g.review(REPO, 9, { headSha: SHA, post: true })
    expect(off.testRuns).toEqual([])
    const replay = setup()
    await replay.g.review(REPO, 9, { headSha: SHA, post: false, replay: true })
    expect(replay.testRuns).toEqual([])
  })
})

describe("runTestStep", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

  function repo(): { dir: string; sha: string; worktrees: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "agentx-teststep-"))
    git(dir, "init", "-q")
    writeFileSync(path.join(dir, "ok.txt"), "hello\n")
    git(dir, "add", ".")
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "init")
    return { dir, sha: git(dir, "rev-parse", "HEAD"), worktrees: mkdtempSync(path.join(tmpdir(), "agentx-teststep-wt-")) }
  }

  it("passes, fails and cleans up its worktree", async () => {
    const r = repo()
    try {
      let n = 0
      const makeTempDir = () => path.join(r.worktrees, `w${n++}`)
      const pass = await runTestStep({ checkout: r.dir, command: "test -f ok.txt", sha: r.sha, ref: "pull/1/head", timeoutMinutes: 1 }, { makeTempDir })
      expect(pass.passed).toBe(true)
      expect(pass.summary).toMatch(/^passed in \d+ s$/)
      const fail = await runTestStep({ checkout: r.dir, command: "echo boom; exit 3", sha: r.sha, ref: "pull/1/head", timeoutMinutes: 1 }, { makeTempDir })
      expect(fail.passed).toBe(false)
      expect(fail.summary).toMatch(/^exit code 3 after/)
      expect(fail.output).toContain("boom")
      expect(readdirSync(r.worktrees)).toEqual([])
      expect(git(r.dir, "worktree", "list").split("\n")).toHaveLength(1)
    } finally {
      rmSync(r.dir, { recursive: true, force: true })
      rmSync(r.worktrees, { recursive: true, force: true })
    }
  })

  it("fails with a reason when the commit cannot be fetched", async () => {
    const r = repo()
    try {
      const out = await runTestStep({ checkout: r.dir, command: "true", sha: "f".repeat(40), ref: "pull/1/head", timeoutMinutes: 1 })
      expect(out.passed).toBe(false)
      expect(out.summary).toContain("could not fetch pull/1/head")
      expect(existsSync(r.dir)).toBe(true)
    } finally {
      rmSync(r.dir, { recursive: true, force: true })
      rmSync(r.worktrees, { recursive: true, force: true })
    }
  })

  it("passes no daemon secrets to the command", () => {
    const env = bareEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "y" })
    expect(env).toEqual({ CI: "true", PATH: "/bin", HOME: "/h" })
  })
})
