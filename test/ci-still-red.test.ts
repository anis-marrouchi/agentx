import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import { GitHubAdapter, type GitHubChannelConfig } from "../src/channels/github"
import { CiFixLoop, type CiStillRed } from "../src/channels/ci-fix"
import { answerCiStillRed, readCiStillRed, recordCiStillRedStep } from "../src/channels/ci-still-red"
import { decide, listInbox } from "../src/approvals/inbox"
import type { IncomingMessage } from "../src/channels/types"

// #2212: "CI still red after N tries" shows on Needs you (the inbox's `ci`
// kind) once per MR/PR, leaves on green or close, and writes one step on the
// owning agent's last run there.

const REPO = "acme/api"
const HOLD_MS = 30_000
const MARKED = "Fix the thing\n\n<!-- agentx:coder-agent -->"

let dir: string
let mrDetails: Record<string, unknown>
let prDetails: Record<string, unknown>

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), "ci-still-red-"))
  mrDetails = { description: MARKED, source_branch: "feat/x", title: "Add x", web_url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` }
  prDetails = { body: MARKED, title: "Add y", html_url: `https://github.com/${REPO}/pull/7`, head: { ref: "feat/y" }, user: { login: "anis" } }
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url)
    const data = /\/merge_requests\/\d+$/.test(u) ? mrDetails
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

const stateFile = (p: "github" | "gitlab") => join(dir, ".agentx", "state", `ci-fix-${p}.json`)
const ciNeeds = () => listInbox({ root: dir }, { kinds: ["ci"], includeSnoozed: true }).items
const res = () => ({ writeHead: vi.fn(), end: vi.fn() })

async function settle(adapter: GitLabAdapter | GitHubAdapter): Promise<void> {
  await vi.advanceTimersByTimeAsync(HOLD_MS)
  await (adapter as any).ciFix.idle()
  await vi.advanceTimersByTimeAsync(0)
}

// --- GitLab ---

function gitlab(seen: CiStillRed[]) {
  const gl = new GitLabAdapter({
    webhookPort: 0,
    host: "https://gitlab.example.test",
    token: "global",
    routes: [{ project: REPO, agent: "route-agent" }],
    ci: { fixAttempts: 2 },
    ciStateFile: stateFile("gitlab"),
    onCiStillRed: (r) => seen.push(r),
  } as GitLabChannelConfig, () => {})
  gl.onMessage(async (_m: IncomingMessage) => {})
  return gl
}

const pipeline = (status: string, sha: string, id: number) => ({
  object_kind: "pipeline",
  user: { name: "Sam", username: "sam_coder" },
  project: { path_with_namespace: REPO, web_url: `https://gitlab.example.test/${REPO}` },
  object_attributes: { id, ref: "feat/x", sha, status, duration: 42 },
  merge_request: { iid: 12, title: "Add x", url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` },
  builds: [{ id: 501, name: "lint", stage: "test", status: "failed" }],
})
const pipe = (gl: GitLabAdapter, body: unknown) => (gl as any).handlePipeline(body, res())
async function redPast(gl: GitLabAdapter, commits: number): Promise<void> {
  for (let i = 1; i <= commits; i++) {
    await pipe(gl, pipeline("failed", `sha${i}`, 100 + i))
    await settle(gl)
  }
}

describe("GitLab: CI still red on Needs you", () => {
  it("the still-red note adds one item with repo, MR, link, head commit, tries and agent; the step hook fires once", async () => {
    const seen: CiStillRed[] = []
    const gl = gitlab(seen)
    await redPast(gl, 4) // 2 wakes, the note on the 3rd, silence on the 4th
    const items = ciNeeds()
    expect(items).toHaveLength(1)
    const i = items[0]
    expect(i.key).toBe(`ci:gitlab:${REPO}:12`)
    expect(i.title).toContain(`${REPO} MR !12 after 2 tries`)
    expect(i.title).toContain("Add x")
    expect(i.raised_by).toBe("coder-agent")
    expect(i.detail).toContain("sha3")
    expect(i.source).toBe(`https://gitlab.example.test/${REPO}/-/merge_requests/12`)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ provider: "gitlab", repo: REPO, number: 12, sha: "sha3", tries: 2, agentId: "coder-agent" })
  })

  it("a repeated delivery of the red pipeline adds nothing", async () => {
    const seen: CiStillRed[] = []
    const gl = gitlab(seen)
    await redPast(gl, 3)
    await pipe(gl, pipeline("failed", "sha3", 103))
    await settle(gl)
    expect(ciNeeds()).toHaveLength(1)
    expect(seen).toHaveLength(1)
  })

  it("a green pipeline on the head removes it", async () => {
    const gl = gitlab([])
    await redPast(gl, 3)
    expect(ciNeeds()).toHaveLength(1)
    mrDetails = { ...mrDetails, sha: "sha9" }
    await pipe(gl, pipeline("success", "sha9", 200))
    expect(ciNeeds()).toHaveLength(0)
  })

  it("a merged or closed MR removes it, even when a bot merges it", async () => {
    const gl = gitlab([])
    await redPast(gl, 3)
    expect(ciNeeds()).toHaveLength(1)
    await (gl as any).handleMR({
      object_kind: "merge_request",
      user: { name: "Bot", username: "devops-bot" },
      project: { path_with_namespace: REPO },
      object_attributes: { iid: 12, action: "merge", title: "Add x" },
    }, res())
    expect(ciNeeds()).toHaveLength(0)
  })
})

// --- GitHub ---

function github(seen: CiStillRed[]) {
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "route-agent" }],
    ci: { fixAttempts: 2 },
    ciStateFile: stateFile("github"),
    onCiStillRed: (r) => seen.push(r),
  } as GitHubChannelConfig, () => {})
  ;(gh as any).globalToken = "t"
  gh.onMessage(async (_m: IncomingMessage) => {})
  return gh
}

const workflowRun = (conclusion: string, sha: string, id: number) => ({
  action: "completed",
  workflow_run: {
    id, run_attempt: 1, name: "CI", html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    head_sha: sha, head_branch: "feat/y", status: "completed", conclusion,
    pull_requests: [{ number: 7, head: { sha } }],
  },
  repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
})
const hook = (gh: GitHubAdapter, event: string, body: unknown) =>
  gh.handleWebhook({ "x-github-event": event }, body as Record<string, unknown>)
async function ghRedPast(gh: GitHubAdapter, commits: number): Promise<void> {
  for (let i = 1; i <= commits; i++) {
    await hook(gh, "workflow_run", workflowRun("failure", `sha${i}`, i))
    await settle(gh)
  }
}

describe("GitHub: CI still red on Needs you", () => {
  it("the still-red note adds one item; repeats and later reds add nothing", async () => {
    const seen: CiStillRed[] = []
    const gh = github(seen)
    await ghRedPast(gh, 4)
    await hook(gh, "workflow_run", workflowRun("failure", "sha3", 3)) // redelivery
    await settle(gh)
    const items = ciNeeds()
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe(`ci:github:${REPO}:7`)
    expect(items[0].title).toContain(`${REPO} PR #7 after 2 tries: Add y`)
    expect(items[0].source).toBe(`https://github.com/${REPO}/pull/7`)
    expect(items[0].raised_by).toBe("coder-agent")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ provider: "github", number: 7, sha: "sha3", tries: 2 })
  })

  it("a green run on the head removes it", async () => {
    const gh = github([])
    await ghRedPast(gh, 3)
    expect(ciNeeds()).toHaveLength(1)
    await hook(gh, "workflow_run", workflowRun("success", "sha9", 9))
    expect(ciNeeds()).toHaveLength(0)
  })

  it("a closed PR removes it", async () => {
    const gh = github([])
    await ghRedPast(gh, 3)
    await hook(gh, "pull_request", {
      action: "closed",
      pull_request: { number: 7, title: "Add y", body: MARKED, user: { login: "dependabot[bot]" }, merged: true },
      repository: { full_name: REPO },
      sender: { login: "dependabot[bot]" },
    })
    expect(ciNeeds()).toHaveLength(0)
  })
})

// --- The answer, the reader and the step ---

describe("Needs you answer", () => {
  it("yes or no takes it off the list until the next still-red note", async () => {
    const gh = github([])
    await ghRedPast(gh, 3)
    const r = await decide({ root: dir }, `ci:github:${REPO}:7`, "yes")
    expect(r.ok).toBe(true)
    expect(ciNeeds()).toHaveLength(0)
    expect(answerCiStillRed(dir, `github:${REPO}:7`)).toBe(false)
    // Green, then red past the cap again: a new note, back on the list.
    await hook(gh, "workflow_run", workflowRun("success", "sha9", 9))
    for (let i = 10; i <= 12; i++) {
      await hook(gh, "workflow_run", workflowRun("failure", `sha${i}`, i))
      await settle(gh)
    }
    expect(ciNeeds()).toHaveLength(1)
  })

  it("an item that is gone answers nothing waiting", async () => {
    const r = await decide({ root: dir }, `ci:github:${REPO}:7`, "no")
    expect(r).toMatchObject({ ok: false })
  })
})

describe("CiFixLoop still-red details", () => {
  it("keeps the details with the note only, and drops them on close", () => {
    const loop = new CiFixLoop<unknown>({ cap: () => 1, holdSeconds: () => 0 })
    const still = { provider: "github" as const, repo: REPO, number: 7, sha: "s1", agentId: "a" }
    expect(loop.claim("k", still).action).toBe("wake")
    expect(loop.stillRed("k")).toBeUndefined()
    expect(loop.claim("k", still, Date.parse("2026-11-25T22:00:00Z")).action).toBe("note")
    expect(loop.stillRed("k")).toMatchObject({ tries: 1, at: "2026-11-25T22:00:00.000Z" })
    expect(loop.closed("k")).toBe(true)
    expect(loop.has("k")).toBe(false)
    expect(loop.closed("k")).toBe(false)
  })

  it("reads nothing when no state file exists", () => {
    expect(readCiStillRed(dir)).toEqual([])
  })
})

describe("recordCiStillRedStep", () => {
  const red: CiStillRed = { provider: "gitlab", repo: REPO, number: 12, sha: "abcdef1234567890", tries: 3, agentId: "coder-agent", at: "2026-11-25T22:00:00.000Z", url: "https://x/mr/12" }

  it("writes one ci_still_red step on the agent's last run on that MR", () => {
    const emitted: unknown[] = []
    const lastRun = vi.fn(() => [{ taskId: "run-1" }])
    const id = recordCiStillRedStep(red, { db: {} as any, lastRun, emit: (s) => emitted.push(s) })
    expect(id).toBe("run-1")
    expect(lastRun).toHaveBeenCalledWith({}, { agentId: "coder-agent", channel: "gitlab", chatId: `${REPO}:merge_request:12`, limit: 1 })
    expect(emitted).toEqual([expect.objectContaining({ taskId: "run-1", name: "ci_still_red", status: "error", action: `${REPO} MR !12` })])
    expect((emitted[0] as any).outputSummary).toContain("still red after 3 tries on abcdef123456")
  })

  it("writes nothing when the agent has no run there", () => {
    const emit = vi.fn()
    expect(recordCiStillRedStep(red, { db: {} as any, lastRun: () => [], emit })).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })
})
