import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "crypto"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import { GitHubAdapter, type GitHubChannelConfig } from "../src/channels/github"
import { CiFixLoop, ciOwner, issueHomeLinks } from "../src/channels/ci-fix"
import { RequestStore } from "../src/requests/store"
import { closeDb, openDb } from "../src/storage/sqlite"
import type { IncomingMessage } from "../src/channels/types"

// #2102: a red pipeline on an MR/PR wakes the agent that owns it (marker in
// the body, else the request of its agentx/issue-<n> branch, else nobody),
// once per head commit, with every red run of that commit held into one
// wake, at most ci.fixAttempts times per MR/PR until a green run.

const REPO = "acme/api"
const SHA = "abc123def4567890"
const HOLD_MS = 30_000
const MARKED = "Fix the thing\n\n<!-- agentx:coder-agent -->"

type Call = { url: string; method: string; body?: string }
let calls: Call[]
let mrDetails: Record<string, unknown>
let mrList: unknown[]
let prDetails: Record<string, unknown>
let commitRuns: unknown[]
let mrListFails: boolean
let mrReadFails: boolean
let prReadFails: boolean
let dir: string

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  mrDetails = { description: MARKED, source_branch: "feat/x", title: "Add x", web_url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` }
  mrList = []
  prDetails = { body: MARKED, head: { ref: "feat/y" }, user: { login: "anis" } }
  commitRuns = [{ status: "completed", conclusion: "success" }]
  mrListFails = false
  mrReadFails = false
  prReadFails = false
  dir = mkdtempSync(join(tmpdir(), "ci-fix-"))
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body })
    if (mrListFails && u.includes("/merge_requests?")) return { ok: false, status: 500, json: async () => ({}), text: async () => "" }
    if (mrReadFails && /\/merge_requests\/\d+$/.test(u)) return { ok: false, status: 500, json: async () => ({}), text: async () => "" }
    if (prReadFails && /\/pulls\/\d+$/.test(u)) return { ok: false, status: 500, json: async () => ({}), text: async () => "" }
    const data = u.includes("/merge_requests?") ? mrList
      : /\/merge_requests\/\d+$/.test(u) ? mrDetails
      : /\/pulls\/\d+$/.test(u) ? prDetails
      : u.includes("/actions/runs?") ? { workflow_runs: commitRuns }
      : { id: 999 }
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
const notePosts = () => calls.filter((c) => c.method === "POST" && /\/notes$|\/comments$/.test(c.url))
/** Let the hold window end and the wake it starts be sent. */
async function settle(adapter: GitLabAdapter | GitHubAdapter): Promise<void> {
  await vi.advanceTimersByTimeAsync(HOLD_MS)
  await (adapter as any).ciFix.idle()
  await vi.advanceTimersByTimeAsync(0)
}

// --- GitLab ---

function gitlab(opts: { fixAttempts?: number; agentForIssue?: (p: string, n: number) => string | undefined; handler?: (m: IncomingMessage) => Promise<void>; knownAgentIds?: string[]; token?: string; log?: (...args: unknown[]) => void } = {}) {
  const gl = new GitLabAdapter({
    webhookPort: 0,
    host: "https://gitlab.example.test",
    token: "token" in opts ? opts.token : "global",
    routes: [{ project: REPO, agent: "route-agent" }],
    ci: opts.fixAttempts === undefined ? undefined : { fixAttempts: opts.fixAttempts },
    ciStateFile: join(dir, "ci-fix-gitlab.json"),
    ciAgentForIssue: opts.agentForIssue,
    knownAgentIds: opts.knownAgentIds,
  } as GitLabChannelConfig, opts.log ?? (() => {}))
  ;(gl as any).usernameToAgent.set("sam_coder", "author-agent")
  const runs: IncomingMessage[] = []
  gl.onMessage(opts.handler ?? (async (m) => { runs.push(m) }))
  return { gl, runs }
}

const pipeline = (status: string, opts: { mr?: boolean; sha?: string; id?: number } = {}) => ({
  object_kind: "pipeline",
  user: { name: "Sam", username: "sam_coder" },
  project: { path_with_namespace: REPO, web_url: `https://gitlab.example.test/${REPO}` },
  object_attributes: { id: opts.id ?? 77, ref: "feat/x", sha: opts.sha ?? SHA, status, duration: 42 },
  merge_request: opts.mr === false ? null : { iid: 12, title: "Add x", url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` },
  builds: [
    { id: 501, name: "lint", stage: "test", status: "failed" },
    { id: 502, name: "build", stage: "build", status: "success" },
  ],
})

const pipe = (gl: GitLabAdapter, body: unknown) => (gl as any).handlePipeline(body, res())

describe("GitLab: failed MR pipeline", () => {
  it("wakes the agent of the MR description's marker on the MR's chat, naming the failed jobs", async () => {
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed"))
    expect(runs).toHaveLength(0) // held for the window
    await settle(gl)
    expect(runs).toHaveLength(1)
    const m = runs[0]
    expect(m.resolvedAgent).toBe("coder-agent")
    expect(m.sender.id).toBe(`${REPO}:merge_request:12`)
    expect(m.text).toContain("MR !12")
    expect(m.text).toContain("Add x")
    expect(m.text).toContain("feat/x")
    expect(m.text).toContain(SHA)
    expect(m.text).toContain(`lint (stage test): https://gitlab.example.test/${REPO}/-/jobs/501`)
    expect(m.text).not.toContain("jobs/502")
  })

  it("several red pipelines on one commit within the window make one wake listing all", async () => {
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { id: 77 }))
    await vi.advanceTimersByTimeAsync(10_000)
    await pipe(gl, pipeline("failed", { id: 78 }))
    await settle(gl)
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toContain("Pipeline 77")
    expect(runs[0].text).toContain("Pipeline 78")
    // A later red on the same commit: no second wake.
    await pipe(gl, pipeline("failed", { id: 79 }))
    await settle(gl)
    expect(runs).toHaveLength(1)
  })

  it("a repeated delivery (same pipeline id and status) neither wakes nor counts", async () => {
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { id: 77, sha: "c1" }))
    await settle(gl)
    // The fix commit c2 passes and resets, so only the dedup stops the
    // redelivered red of c1.
    mrDetails = { ...mrDetails, sha: "c2" }
    await pipe(gl, pipeline("success", { id: 78, sha: "c2" }))
    await pipe(gl, pipeline("failed", { id: 77, sha: "c1" }))
    await settle(gl)
    expect(runs).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-gitlab.json"), "utf-8"))[`gitlab:${REPO}:12`]).toBeUndefined()
  })

  it("4 reds on 4 commits: wakes on the first 3, one note on the 4th, then silence", async () => {
    const { gl, runs } = gitlab()
    for (let i = 1; i <= 5; i++) {
      await pipe(gl, pipeline("failed", { id: 100 + i, sha: `sha${i}` }))
      await settle(gl)
    }
    expect(runs).toHaveLength(3)
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].url).toContain("/merge_requests/12/notes")
    expect(notes[0].body).toContain("still red after 3 tries")
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-gitlab.json"), "utf-8"))[`gitlab:${REPO}:12`]).toMatchObject({ count: 3, noted: true })
  })

  it("a green pipeline on the MR's head commit resets the count", async () => {
    const { gl, runs } = gitlab({ fixAttempts: 1 })
    await pipe(gl, pipeline("failed", { id: 1, sha: "c1" }))
    await settle(gl)
    mrDetails = { ...mrDetails, sha: "c2" }
    await pipe(gl, pipeline("success", { id: 2, sha: "c2" }))
    await pipe(gl, pipeline("failed", { id: 3, sha: "c3" }))
    await settle(gl)
    expect(runs).toHaveLength(2)
    expect(notePosts()).toHaveLength(0)
  })

  it("a passing branch pipeline on the woken commit does not reset: the loop still stops at the cap", async () => {
    mrList = [{ iid: 12, title: "Add x" }]
    const { gl, runs } = gitlab({ fixAttempts: 2 })
    for (let i = 1; i <= 4; i++) {
      // Each commit: the MR pipeline fails, the branch pipeline passes.
      mrDetails = { ...mrDetails, sha: `c${i}` }
      await pipe(gl, pipeline("failed", { id: 10 * i, sha: `c${i}` }))
      await pipe(gl, pipeline("success", { id: 10 * i + 1, sha: `c${i}`, mr: false })) // inside the hold window
      await settle(gl)
      await pipe(gl, pipeline("success", { id: 10 * i + 2, sha: `c${i}`, mr: false })) // after the wake
    }
    expect(runs).toHaveLength(2)
    expect(notePosts()).toHaveLength(1)
    expect(notePosts()[0].body).toContain("still red after 2 tries")
  })

  it("a late green of an older commit does not reset the count", async () => {
    const { gl, runs } = gitlab({ fixAttempts: 2 })
    mrDetails = { ...mrDetails, sha: "c2" }
    await pipe(gl, pipeline("failed", { id: 1, sha: "c1" }))
    await settle(gl)
    await pipe(gl, pipeline("failed", { id: 2, sha: "c2" }))
    await settle(gl)
    await pipe(gl, pipeline("success", { id: 3, sha: "c1" })) // c1's re-run, head is c2
    mrDetails = { ...mrDetails, sha: "c3" }
    await pipe(gl, pipeline("failed", { id: 4, sha: "c3" }))
    await settle(gl)
    expect(runs).toHaveLength(2)
    expect(notePosts()).toHaveLength(1)
  })

  it("an MR labelled agent:no-wake wakes nobody, posts nothing and counts nothing", async () => {
    mrDetails = { ...mrDetails, labels: ["Doing", "agent:no-wake"] }
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(0)
    expect((gl as any).ciFix.entries[`gitlab:${REPO}:12`]?.count ?? 0).toBe(0)
  })

  it("a marker naming an unregistered agent is ignored: the branch owner, else nobody", async () => {
    mrDetails = { ...mrDetails, description: "<!-- agentx:intruder -->", source_branch: "agentx/issue-12" }
    const { gl, runs } = gitlab({ knownAgentIds: ["coder-agent", "x-agent"], agentForIssue: (_p, n) => (n === 12 ? "x-agent" : undefined) })
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["x-agent"])
  })

  it("without a marker, an agentx/issue-<n> branch wakes the agent of that issue's request", async () => {
    mrDetails = { description: "no marker", source_branch: "agentx/issue-12", title: "Add x" }
    const { gl, runs } = gitlab({ agentForIssue: (p, n) => (p === REPO && n === 12 ? "x-agent" : undefined) })
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["x-agent"])
  })

  it("an MR with neither wakes nobody (not the route, not the author) and posts one note", async () => {
    mrDetails = { description: "by a person", source_branch: "feat/x", author: { username: "sam_coder" } }
    const { gl, runs } = gitlab()
    const route = vi.spyOn(gl as any, "resolveAgent")
    for (let i = 1; i <= 3; i++) {
      await pipe(gl, pipeline("failed", { id: i, sha: `c${i}` }))
      await settle(gl)
    }
    expect(runs).toHaveLength(0)
    expect(route).not.toHaveBeenCalled()
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain("no agent owns this")
  })

  it("a branch pipeline with no merge_request but an open MR for its ref is that MR", async () => {
    mrList = [{ iid: 12, title: "Add x", web_url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` }]
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { mr: false }))
    await settle(gl)
    expect(calls.some((c) => c.url.includes("/merge_requests?state=opened&source_branch=feat%2Fx"))).toBe(true)
    expect(runs).toHaveLength(1)
    expect(runs[0].sender.id).toBe(`${REPO}:merge_request:12`)
    expect(runs[0].resolvedAgent).toBe("coder-agent")
  })

  it("a branch pipeline with no MR routes as before", async () => {
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { mr: false }))
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("route-agent")
    expect(runs[0].sender.id).toBe(`${REPO}:pipeline:77`)
    expect(runs[0].text).toBe(`[GitLab Pipeline FAILED] Project: ${REPO}\nRef: feat/x\nDuration: 42s\nPlease investigate the failure.`)
  })

  it("a branch pipeline whose MR lookup fails wakes nobody and logs it", async () => {
    mrListFails = true
    const lines: string[] = []
    const { gl, runs } = gitlab({ log: (...a) => { lines.push(a.join(" ")) } })
    await pipe(gl, pipeline("failed", { mr: false }))
    await settle(gl)
    expect(runs).toHaveLength(0)
    expect(lines.some((l) => l.includes("Pipeline 77") && l.includes("lookup failed"))).toBe(true)
  })

  // #2130: no token means nothing to look up with, so "no MR", not "error".
  it("with no GitLab token, a failed branch pipeline wakes the route agent as before", async () => {
    const { gl, runs } = gitlab({ token: undefined })
    await pipe(gl, pipeline("failed", { mr: false }))
    await settle(gl)
    expect(calls.some((c) => c.url.includes("/merge_requests?"))).toBe(false)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["route-agent"])
    expect(runs[0].sender.id).toBe(`${REPO}:pipeline:77`)
  })

  // #2130: a fork MR with the same branch name is not this branch's MR.
  it("a branch pipeline ignores an open fork MR with the same branch name", async () => {
    mrList = [
      { iid: 30, title: "Fork x", source_project_id: 2, target_project_id: 1 },
      { iid: 12, title: "Add x", source_project_id: 1, target_project_id: 1 },
    ]
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { mr: false }))
    await settle(gl)
    expect(runs.map((r) => r.sender.id)).toEqual([`${REPO}:merge_request:12`])
    // Only the fork MR: the branch has no MR of its own, the route agent wakes.
    mrList = [{ iid: 30, title: "Fork x", source_project_id: 2, target_project_id: 1 }]
    const only = gitlab()
    await pipe(only.gl, pipeline("failed", { mr: false, id: 78 }))
    await settle(only.gl)
    expect(only.runs.map((r) => r.resolvedAgent)).toEqual(["route-agent"])
  })

  // #2130: MR unreadable, the payload's project ids still mark a fork.
  it("an unreadable MR from a fork (by the payload's project ids) wakes nobody, even on an agentx/issue-<n> branch", async () => {
    mrReadFails = true
    const forkPipeline = (fork: boolean) => {
      const p = pipeline("failed")
      p.object_attributes.ref = "agentx/issue-12"
      p.merge_request = { ...p.merge_request!, ...(fork ? { source_project_id: 2, target_project_id: 1 } : { source_project_id: 1, target_project_id: 1 }) } as any
      return p
    }
    const fork = gitlab({ agentForIssue: () => "x-agent" })
    await pipe(fork.gl, forkPipeline(true))
    await settle(fork.gl)
    expect(fork.runs).toHaveLength(0)
    // The same MR from the project itself: the branch's request owns it.
    const own = gitlab({ agentForIssue: () => "x-agent" })
    await pipe(own.gl, forkPipeline(false))
    await settle(own.gl)
    expect(own.runs.map((r) => r.resolvedAgent)).toEqual(["x-agent"])
  })

  it("a branch pipeline with no MR delivered again wakes the route agent once", async () => {
    const { gl, runs } = gitlab()
    await pipe(gl, pipeline("failed", { mr: false }))
    await pipe(gl, pipeline("failed", { mr: false }))
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("route-agent")
  })

  it("an MR from a fork wakes nobody, even with a marker or an agentx/issue-<n> branch, and posts one note", async () => {
    mrDetails = { ...mrDetails, source_branch: "agentx/issue-12", source_project_id: 2, target_project_id: 1 }
    const { gl, runs } = gitlab({ agentForIssue: () => "x-agent" })
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(1)
    expect(notePosts()[0].body).toContain("no agent owns this")
  })

  it("the count is saved before the wake: a throwing handler still leaves it on file", async () => {
    const { gl } = gitlab({ handler: async () => { throw new Error("boom") } })
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-gitlab.json"), "utf-8"))[`gitlab:${REPO}:12`]).toMatchObject({ count: 1, sha: SHA })
  })

  it("fixAttempts 0 never wakes", async () => {
    const { gl, runs } = gitlab({ fixAttempts: 0 })
    await pipe(gl, pipeline("failed"))
    await settle(gl)
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(0)
  })
})

// --- GitHub ---

function github(opts: { fixAttempts?: number; agentForIssue?: (r: string, n: number) => string | undefined; handler?: (m: IncomingMessage) => Promise<void>; webhookSecret?: string; knownAgentIds?: string[]; ciKnownAgent?: (id: string) => boolean } = {}) {
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "route-agent" }],
    agentMappings: [{ agentId: "author-agent", githubUsernames: ["anis"] }],
    ci: opts.fixAttempts === undefined ? undefined : { fixAttempts: opts.fixAttempts },
    ciStateFile: join(dir, "ci-fix-github.json"),
    ciAgentForIssue: opts.agentForIssue,
    webhookSecret: opts.webhookSecret,
    knownAgentIds: opts.knownAgentIds,
    ciKnownAgent: opts.ciKnownAgent,
  } as GitHubChannelConfig, () => {})
  ;(gh as any).globalToken = "t"
  const runs: IncomingMessage[] = []
  gh.onMessage(opts.handler ?? (async (m) => { runs.push(m) }))
  return { gh, runs }
}

const workflowRun = (conclusion: string, opts: { prs?: number[]; id?: number; attempt?: number; name?: string; sha?: string; head?: string } = {}) => {
  const id = opts.id ?? 900
  return {
    action: "completed",
    workflow_run: {
      id, run_attempt: opts.attempt ?? 1, name: opts.name ?? "CI", html_url: `https://github.com/${REPO}/actions/runs/${id}`,
      head_sha: opts.sha ?? SHA, head_branch: "feat/y", status: "completed", conclusion,
      pull_requests: (opts.prs ?? [7]).map((number) => ({ number, head: { sha: opts.head ?? opts.sha ?? SHA } })),
    },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  }
}

const hook = (gh: GitHubAdapter, event: string, body: unknown) =>
  gh.handleWebhook({ "x-github-event": event }, body as Record<string, unknown>)

describe("GitHub: failed workflow run", () => {
  it("wakes the agent of the PR body's marker on the PR's chat", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("coder-agent")
    expect(runs[0].sender.id).toBe(`${REPO}:pull:7`)
    expect(runs[0].text).toContain(`workflow "CI"`)
    expect(runs[0].text).toContain(`https://github.com/${REPO}/actions/runs/900`)
    expect(runs[0].text).toContain(SHA)
    expect(runs[0].text).toContain("feat/y")
  })

  it("several red workflows on one commit within the window make one wake listing all", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure", { id: 901, name: "Lint" }))
    await hook(gh, "workflow_run", workflowRun("failure", { id: 902, name: "Tests" }))
    await vi.advanceTimersByTimeAsync(20_000)
    await hook(gh, "workflow_run", workflowRun("failure", { id: 903, name: "Build" }))
    await settle(gh)
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toContain("3 workflows failed")
    for (const id of [901, 902, 903]) expect(runs[0].text).toContain(`/actions/runs/${id}`)
    // A re-run attempt red on the same commit: no second wake.
    await hook(gh, "workflow_run", workflowRun("failure", { id: 901, attempt: 2, name: "Lint" }))
    await settle(gh)
    expect(runs).toHaveLength(1)
  })

  it("a repeated delivery (same run id and attempt) neither wakes nor counts", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure", { id: 1, sha: "c1" }))
    await settle(gh)
    // The fix commit c2 passes and resets, so only the dedup stops the
    // redelivered red of c1.
    await hook(gh, "workflow_run", workflowRun("success", { id: 2, sha: "c2" }))
    await hook(gh, "workflow_run", workflowRun("failure", { id: 1, sha: "c1" }))
    await settle(gh)
    expect(runs).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-github.json"), "utf-8"))[`github:${REPO}:7`]).toBeUndefined()
  })

  it("4 reds on 4 commits: wakes on the first 3, one note on the 4th, then silence", async () => {
    const { gh, runs } = github()
    for (let i = 1; i <= 5; i++) {
      await hook(gh, "workflow_run", workflowRun("failure", { id: i, sha: `sha${i}` }))
      await settle(gh)
    }
    expect(runs).toHaveLength(3)
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].url).toBe(`https://api.github.com/repos/${REPO}/issues/7/comments`)
    expect(notes[0].body).toContain("still red after 3 tries")
  })

  it("a success on the head commit resets once every run of that commit is green", async () => {
    const { gh, runs } = github({ fixAttempts: 2 })
    await hook(gh, "workflow_run", workflowRun("failure", { id: 1, sha: "c1" }))
    await settle(gh)
    // The fix commit c2: one workflow passes while another is red, no reset.
    commitRuns = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }]
    await hook(gh, "workflow_run", workflowRun("success", { id: 2, sha: "c2" }))
    await hook(gh, "workflow_run", workflowRun("failure", { id: 3, sha: "c2" }))
    await settle(gh)
    expect(runs).toHaveLength(2)
    // c3: every run green, reset.
    commitRuns = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]
    await hook(gh, "workflow_run", workflowRun("success", { id: 4, sha: "c3" }))
    await hook(gh, "workflow_run", workflowRun("failure", { id: 5, sha: "c4" }))
    await settle(gh)
    expect(runs).toHaveLength(3)
    expect(notePosts()).toHaveLength(0)
  })

  it("a late green of an older commit, or a green on the woken commit, does not reset", async () => {
    const { gh, runs } = github({ fixAttempts: 2 })
    await hook(gh, "workflow_run", workflowRun("failure", { id: 1, sha: "c1" }))
    await settle(gh)
    await hook(gh, "workflow_run", workflowRun("failure", { id: 2, sha: "c2" }))
    await settle(gh)
    await hook(gh, "workflow_run", workflowRun("success", { id: 3, sha: "c1", head: "c2" })) // late, c1
    await hook(gh, "workflow_run", workflowRun("success", { id: 4, sha: "c2" })) // c2 woke the agent
    await hook(gh, "workflow_run", workflowRun("failure", { id: 5, sha: "c3" }))
    await settle(gh)
    expect(runs).toHaveLength(2)
    expect(notePosts()).toHaveLength(1)
  })

  it("a PR labelled agent:no-wake wakes nobody and posts nothing", async () => {
    prDetails = { ...prDetails, labels: [{ name: "agent:no-wake" }] }
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(0)
  })

  it("a marker naming an agent on a mesh peer wakes it (#2227: webhook node hosts other agents)", async () => {
    prDetails = { ...prDetails, body: "<!-- agentx:dev-session -->" }
    const { gh, runs } = github({ knownAgentIds: ["atlas"], ciKnownAgent: (id) => id === "dev-session" })
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["dev-session"])
    expect(notePosts()).toHaveLength(0)
  })

  it("a marker naming an unregistered agent wakes nobody", async () => {
    prDetails = { ...prDetails, body: "<!-- agentx:intruder -->" }
    const { gh, runs } = github({ knownAgentIds: ["coder-agent"] })
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs).toHaveLength(0)
    expect(notePosts()[0]?.body).toContain("no agent owns this")
  })

  it("without a marker, an agentx/issue-12 branch wakes the agent of the request on issue 12", async () => {
    prDetails = { body: "no marker", head: { ref: "agentx/issue-12" }, user: { login: "anis" } }
    const { gh, runs } = github({ agentForIssue: (r, n) => (r === REPO && n === 12 ? "x-agent" : undefined) })
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs.map((r) => r.resolvedAgent)).toEqual(["x-agent"])
  })

  it("an owner or contributor PR with neither wakes nobody, posts one note, never asks the route", async () => {
    prDetails = { body: "a person's PR", head: { ref: "feat/y" }, user: { login: "anis" } }
    const { gh, runs } = github()
    const route = vi.spyOn(gh as any, "resolveAgent")
    for (let i = 1; i <= 3; i++) {
      await hook(gh, "workflow_run", workflowRun("failure", { id: i, sha: `c${i}` }))
      await settle(gh)
    }
    expect(runs).toHaveLength(0)
    expect(route).not.toHaveBeenCalled()
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain("no agent owns this")
  })

  it("a PR from a fork wakes nobody, even with a marker or an agentx/issue-<n> branch, and posts one comment", async () => {
    prDetails = { ...prDetails, head: { ref: "agentx/issue-12", repo: { full_name: "someone/api" } } }
    const { gh, runs } = github({ agentForIssue: () => "x-agent" })
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(1)
    expect(notePosts()[0].body).toContain("no agent owns this")
  })

  // #2130: PR unreadable, the run's head_repository decides; null is a deleted fork.
  it("an unreadable PR whose run head_repository is null or another repo wakes nobody", async () => {
    prReadFails = true
    const run = (headRepo: { full_name: string } | null, id: number) => {
      const r = workflowRun("failure", { id, sha: `s${id}` }) as any
      r.workflow_run.head_branch = "agentx/issue-12"
      r.workflow_run.head_repository = headRepo
      return r
    }
    const deleted = github({ agentForIssue: () => "x-agent" })
    await hook(deleted.gh, "workflow_run", run(null, 1))
    await settle(deleted.gh)
    expect(deleted.runs).toHaveLength(0)
    const fork = github({ agentForIssue: () => "x-agent" })
    await hook(fork.gh, "workflow_run", run({ full_name: "Someone/API" }, 2))
    await settle(fork.gh)
    expect(fork.runs).toHaveLength(0)
    // Its own repo (any case): the branch's request owns it.
    const own = github({ agentForIssue: () => "x-agent" })
    await hook(own.gh, "workflow_run", run({ full_name: "ACME/api" }, 3))
    await settle(own.gh)
    expect(own.runs.map((r) => r.resolvedAgent)).toEqual(["x-agent"])
  })

  it("a run with no PR and check_suite wake nothing", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure", { prs: [] }))
    await hook(gh, "check_suite", { action: "completed", check_suite: { conclusion: "failure" }, repository: { full_name: REPO } })
    await settle(gh)
    expect(runs).toHaveLength(0)
  })

  it("the count is saved before the wake: a throwing handler still leaves it on file", async () => {
    const { gh } = github({ handler: async () => { throw new Error("boom") } })
    await hook(gh, "workflow_run", workflowRun("failure"))
    await settle(gh)
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-github.json"), "utf-8"))[`github:${REPO}:7`]).toMatchObject({ count: 1, sha: SHA })
  })

  it("the webhook signature check accepts a valid one and rejects a wrong or short one", async () => {
    const secret = "whsec"
    const { gh } = github({ webhookSecret: secret })
    const raw = JSON.stringify({ zen: "hi" })
    const good = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
    const verify = (sig?: string) => (gh as any).verifySignature(raw, sig)
    expect(verify(good)).toBe(true)
    expect(verify(good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"))).toBe(false)
    expect(verify("sha256=abc")).toBe(false)
    expect(verify(undefined)).toBe(false)
  })
})

// --- Pieces ---

describe("ciOwner", () => {
  it("marker, then branch request, never anything else", () => {
    const forIssue = (n: number) => (n === 5 ? "req-agent" : undefined)
    expect(ciOwner({ body: MARKED, branch: "agentx/issue-5", agentForIssue: forIssue })).toEqual({ agentId: "coder-agent", via: "marker" })
    expect(ciOwner({ body: "> <!-- agentx:quoted -->", branch: "agentx/issue-5", agentForIssue: forIssue })).toEqual({ agentId: "req-agent", via: "branch" })
    expect(ciOwner({ body: "<!-- agentx:unknown -->", branch: "agentx/issue-6", agentForIssue: forIssue })).toBeUndefined()
    expect(ciOwner({ body: "", branch: "agentx/issue-5-extra", agentForIssue: forIssue })).toBeUndefined()
    expect(ciOwner({ body: MARKED, branch: "agentx/issue-5", agentForIssue: forIssue, knownAgentIds: ["req-agent"] })).toEqual({ agentId: "req-agent", via: "branch" })
    expect(ciOwner({ body: MARKED, knownAgentIds: ["coder-agent"] })).toEqual({ agentId: "coder-agent", via: "marker" })
  })

  it("a marker naming an agent a mesh peer hosts owns the PR (#2227)", () => {
    const onPeer = (id: string) => id === "coder-agent"
    expect(ciOwner({ body: MARKED, knownAgentIds: ["atlas"], isKnownAgent: onPeer })).toEqual({ agentId: "coder-agent", via: "marker" })
    expect(ciOwner({ body: "<!-- agentx:intruder -->", knownAgentIds: ["atlas"], isKnownAgent: onPeer })).toBeUndefined()
  })
})

describe("CiFixLoop", () => {
  it("persists counts across instances", () => {
    const file = join(dir, "c.json")
    const opts = { file, cap: () => 2, holdSeconds: () => 30 }
    const a = new CiFixLoop(opts)
    expect(a.claim("k").action).toBe("wake")
    const b = new CiFixLoop(opts)
    expect(b.claim("k")).toEqual({ action: "wake", count: 2 })
    expect(b.claim("k")).toEqual({ action: "note", count: 2 })
    expect(new CiFixLoop(opts).claim("k").action).toBe("silent")
  })
})

describe("RequestStore.newestOpenOnIssue", () => {
  it("finds the open request homed on the issue, by any of its link forms", () => {
    const cwd = process.cwd()
    closeDb()
    process.chdir(mkdtempSync(join(tmpdir(), "ci-fix-req-")))
    try {
      const store = new RequestStore(openDb({ quiet: true })!)
      const now = Date.now()
      store.addCandidate({ id: "r1", runId: "t1", channel: "telegram", chatId: "c", sender: "anis", agentId: "coder", text: "fix it", now })
      store.progress("r1", now)
      store.setHome("r1", { kind: "issue", link: `https://github.com/${REPO}/issues/12` }, now)
      expect(store.newestOpenOnIssue(issueHomeLinks("github", "ACME/api", 12))?.agentId).toBe("coder")
      expect(store.newestOpenOnIssue(issueHomeLinks("github", REPO, 13))).toBeNull()
      store.close("r1", "done", "shipped", now)
      expect(store.newestOpenOnIssue(issueHomeLinks("github", REPO, 12))).toBeNull()
    } finally {
      closeDb()
      process.chdir(cwd)
    }
  })
})
