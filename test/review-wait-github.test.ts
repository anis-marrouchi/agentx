import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitHubAdapter, type GitHubChannelConfig } from "../src/channels/github"
import type { IncomingMessage } from "../src/channels/types"

// #2227: an agent-owned PR all green with no review wakes the reviewer at
// 15 min and tells the owner at 30; a review, a reviewer-signed comment, a
// new push or a close ends the wait.

const REPO = "acme/api"
const SHA = "abc123def4567890"
const MARKED = "Fix the thing\n\n<!-- agentx:coder-agent -->"
let prDetails: Record<string, unknown>
let reviews: unknown[]
let dir: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"))
  prDetails = { body: MARKED, title: "feat: y", head: { ref: "feat/y", sha: SHA, repo: { full_name: REPO } }, user: { login: "anis" } }
  reviews = []
  dir = mkdtempSync(join(tmpdir(), "rw-gh-"))
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url)
    const data = /\/pulls\/\d+\/reviews/.test(u) ? reviews
      : /\/pulls\/\d+$/.test(u) ? prDetails
      : u.includes("/actions/runs?") ? { workflow_runs: [{ status: "completed", conclusion: "success" }] }
      : { id: 999 }
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function github(reviewer: string | null = "pm-agent") {
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "route-agent" }],
    ci: reviewer ? { reviewer } : undefined,
    ciStateFile: join(dir, "ci-fix-github.json"),
    reviewWaitFile: join(dir, "review-wait.json"),
    knownAgentIds: ["coder-agent", "pm-agent"],
  } as GitHubChannelConfig, () => {})
  ;(gh as any).globalToken = "t"
  ;(gh as any).postingLogins.add("anis")
  const runs: IncomingMessage[] = []
  gh.onMessage(async (m) => { runs.push(m) })
  return { gh, runs }
}
const green = (sha = SHA, id = 900) => ({
  action: "completed",
  workflow_run: { id, run_attempt: 1, name: "CI", html_url: "u", head_sha: sha, head_branch: "feat/y", status: "completed", conclusion: "success",
    pull_requests: [{ number: 7, head: { sha } }] },
  repository: { full_name: REPO },
})
const hook = (gh: GitHubAdapter, event: string, body: unknown) => gh.handleWebhook({ "x-github-event": event }, body as Record<string, unknown>)
const at = async (gh: GitHubAdapter, minutes: number) => gh.reviewTick(Date.parse("2026-11-26T12:00:00Z") + minutes * 60_000)

describe("GitHub: green PR with no review", () => {
  it("wakes the reviewer at 15 min and the PR's owner at 30", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    await at(gh, 14)
    expect(runs).toHaveLength(0)
    await at(gh, 15)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["pm-agent"])
    expect(runs[0].text).toContain("GREEN, NO REVIEW")
    await at(gh, 30)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["pm-agent", "coder-agent"])
    await at(gh, 60)
    expect(runs).toHaveLength(2)
  })
  it("is off without a reviewer", async () => {
    const { gh, runs } = github(null)
    await hook(gh, "workflow_run", green())
    await at(gh, 40)
    expect(runs.map((r) => r.text.slice(0, 60))).toEqual([])
  })
  it("a submitted review ends the wait", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    await hook(gh, "pull_request_review", { action: "submitted", review: { id: 1, body: "", state: "approved", html_url: "", user: { login: "someone" } }, pull_request: { number: 7, title: "t", labels: [] }, repository: { full_name: REPO } })
    await at(gh, 40)
    expect(runs.filter((r) => r.text.includes("NO REVIEW"))).toHaveLength(0)
  })
  it("a PR comment signed by the reviewer ends the wait; another agent's does not", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    const comment = (agent: string, id: number) => ({ action: "created", comment: { id, body: `PASS\n\n<!-- agentx:${agent} -->`, user: { login: "anis" } }, issue: { number: 7, title: "t", pull_request: {} }, repository: { full_name: REPO } })
    await hook(gh, "issue_comment", comment("devops-agent", 1))
    expect((gh as any).reviewWait.has(`github:${REPO}:7`)).toBe(true)
    await hook(gh, "issue_comment", comment("pm-agent", 2))
    expect((gh as any).reviewWait.has(`github:${REPO}:7`)).toBe(false)
    await at(gh, 40)
    expect(runs.filter((r) => r.text.includes("NO REVIEW"))).toHaveLength(0)
  })
  it("a new push ends the wait; the new head's green starts it again", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    await hook(gh, "pull_request", { action: "synchronize", pull_request: { number: 7, head: { sha: "fff000", ref: "feat/y" }, user: { login: "bot[bot]" }, labels: [] }, repository: { full_name: REPO } })
    await at(gh, 20)
    expect(runs.filter((r) => r.text.includes("NO REVIEW"))).toHaveLength(0)
  })
  it("never waits on a draft PR (#2368)", async () => {
    prDetails = { ...prDetails, draft: true }
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    expect((gh as any).reviewWait.has(`github:${REPO}:7`)).toBe(false)
    await at(gh, 40)
    expect(runs).toHaveLength(0)
  })
  it("converted_to_draft ends the wait (#2368)", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    expect((gh as any).reviewWait.has(`github:${REPO}:7`)).toBe(true)
    await hook(gh, "pull_request", { action: "converted_to_draft", pull_request: { number: 7, draft: true, head: { sha: SHA, ref: "feat/y" }, user: { login: "bot[bot]" }, labels: [] }, repository: { full_name: REPO } })
    expect((gh as any).reviewWait.has(`github:${REPO}:7`)).toBe(false)
    await at(gh, 40)
    expect(runs.filter((r) => r.text.includes("NO REVIEW"))).toHaveLength(0)
  })
  it("first tick at 45 min wakes only the reviewer", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    await at(gh, 45)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["pm-agent"])
  })
  it("never waits on a PR that already has a review, a release PR, or one no agent owns", async () => {
    reviews = [{ state: "COMMENTED" }]
    let { gh, runs } = github()
    await hook(gh, "workflow_run", green())
    await at(gh, 40)
    expect(runs).toHaveLength(0)
    reviews = []
    prDetails = { ...prDetails, title: "chore(main): release 0.280.0" }
    ;({ gh, runs } = github())
    await hook(gh, "workflow_run", green())
    await at(gh, 40)
    expect(runs).toHaveLength(0)
    prDetails = { ...prDetails, title: "feat: y", body: "no marker" }
    ;({ gh, runs } = github())
    await hook(gh, "workflow_run", green())
    await at(gh, 40)
    expect(runs).toHaveLength(0)
  })
})
