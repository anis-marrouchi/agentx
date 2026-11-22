import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import { GitHubAdapter } from "../src/channels/github"
import { CiFixCounter } from "../src/channels/ci-fix"
import type { IncomingMessage } from "../src/channels/types"

// #2102: a red pipeline on an MR/PR wakes the agent that owns it, on the
// MR/PR's chat, at most ci.fixAttempts times per head commit.

const REPO = "acme/api"
const SHA = "abc123def4567890"

type Call = { url: string; method: string; body?: string }
let calls: Call[]
let mrDetails: Record<string, unknown>
let prDetails: Record<string, unknown>
let dir: string

beforeEach(() => {
  calls = []
  mrDetails = { author: { username: "sam_coder" }, assignees: [] }
  prDetails = { user: { login: "coder-bot" } }
  dir = mkdtempSync(join(tmpdir(), "ci-fix-"))
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
    const data = String(url).includes("/merge_requests/") && !String(url).endsWith("/notes") ? mrDetails
      : String(url).includes("/pulls/") ? prDetails
      : { id: 999 }
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
const notePosts = () => calls.filter((c) => c.method === "POST" && /\/notes$|\/comments$/.test(c.url))

function gitlab(fixAttempts?: number) {
  const gl = new GitLabAdapter({
    webhookPort: 0,
    host: "https://gitlab.example.test",
    token: "global",
    routes: [{ project: REPO, agent: "route-agent" }],
    ci: fixAttempts === undefined ? undefined : { fixAttempts },
    ciStateFile: join(dir, "ci-fix-gitlab.json"),
  } as GitLabChannelConfig, () => {})
  ;(gl as any).usernameToAgent.set("sam_coder", "coder-agent")
  ;(gl as any).usernameToAgent.set("dev_ops", "devops-agent")
  const runs: IncomingMessage[] = []
  gl.onMessage(async (m) => { runs.push(m) })
  return { gl, runs }
}

const pipeline = (status: string, opts: { mr?: boolean; sha?: string } = {}) => ({
  object_kind: "pipeline",
  user: { name: "Sam", username: "sam_coder" },
  project: { path_with_namespace: REPO, web_url: `https://gitlab.example.test/${REPO}` },
  object_attributes: { id: 77, ref: "feat/x", sha: opts.sha ?? SHA, status, duration: 42 },
  merge_request: opts.mr === false ? null : { iid: 12, title: "Add x", url: `https://gitlab.example.test/${REPO}/-/merge_requests/12` },
  builds: [
    { id: 501, name: "lint", stage: "test", status: "failed" },
    { id: 502, name: "build", stage: "build", status: "success" },
  ],
})

describe("GitLab: failed MR pipeline", () => {
  it("wakes the MR author's agent on the MR's chat, naming the failed jobs", async () => {
    const { gl, runs } = gitlab()
    await (gl as any).handlePipeline(pipeline("failed"), res())
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

  it("falls to an assignee's agent when the author maps to none", async () => {
    mrDetails = { author: { username: "a_person" }, assignees: [{ username: "dev_ops" }] }
    const { gl, runs } = gitlab()
    await (gl as any).handlePipeline(pipeline("failed"), res())
    expect(runs[0].resolvedAgent).toBe("devops-agent")
  })

  it("falls to the project route when nobody maps", async () => {
    mrDetails = { author: { username: "a_person" }, assignees: [] }
    const { gl, runs } = gitlab()
    await (gl as any).handlePipeline(pipeline("failed"), res())
    expect(runs[0].resolvedAgent).toBe("route-agent")
  })

  it("without an MR, routes as before", async () => {
    const { gl, runs } = gitlab()
    await (gl as any).handlePipeline(pipeline("failed", { mr: false }), res())
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("route-agent")
    expect(runs[0].sender.id).toBe(`${REPO}:pipeline:77`)
    expect(runs[0].text).toBe(`[GitLab Pipeline FAILED] Project: ${REPO}\nRef: feat/x\nDuration: 42s\nPlease investigate the failure.`)
  })

  it("stops waking after 3 tries on one commit and posts one note", async () => {
    const { gl, runs } = gitlab()
    for (let i = 0; i < 5; i++) await (gl as any).handlePipeline(pipeline("failed"), res())
    expect(runs).toHaveLength(3)
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].url).toContain("/merge_requests/12/notes")
    expect(notes[0].body).toContain("still red after 3 tries")
    expect(JSON.parse(readFileSync(join(dir, "ci-fix-gitlab.json"), "utf-8"))[`gitlab:${REPO}:12:${SHA}`]).toEqual({ count: 3, noted: true })
  })

  it("a green MR pipeline resets the count", async () => {
    const { gl, runs } = gitlab(1)
    await (gl as any).handlePipeline(pipeline("failed"), res())
    await (gl as any).handlePipeline(pipeline("success"), res())
    await (gl as any).handlePipeline(pipeline("failed"), res())
    expect(runs).toHaveLength(2)
    expect(notePosts()).toHaveLength(0)
  })

  it("fixAttempts 0 never wakes", async () => {
    const { gl, runs } = gitlab(0)
    await (gl as any).handlePipeline(pipeline("failed"), res())
    expect(runs).toHaveLength(0)
    expect(notePosts()).toHaveLength(0)
  })
})

function github(fixAttempts?: number) {
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "route-agent" }],
    agentMappings: [{ agentId: "coder-agent", githubUsernames: ["coder-bot"] }],
    ci: fixAttempts === undefined ? undefined : { fixAttempts },
    ciStateFile: join(dir, "ci-fix-github.json"),
  }, () => {})
  ;(gh as any).globalToken = "t"
  const runs: IncomingMessage[] = []
  gh.onMessage(async (m) => { runs.push(m) })
  return { gh, runs }
}

const workflowRun = (conclusion: string, prs: number[] = [7]) => ({
  action: "completed",
  workflow_run: {
    id: 900, name: "CI", html_url: `https://github.com/${REPO}/actions/runs/900`,
    head_sha: SHA, head_branch: "feat/y", status: "completed", conclusion,
    pull_requests: prs.map((number) => ({ number })),
  },
  repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
})

const hook = (gh: GitHubAdapter, event: string, body: unknown) =>
  gh.handleWebhook({ "x-github-event": event }, body as Record<string, unknown>)

describe("GitHub: failed workflow run", () => {
  it("wakes the PR author's agent on the PR's chat", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure"))
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("coder-agent")
    expect(runs[0].sender.id).toBe(`${REPO}:pull:7`)
    expect(runs[0].text).toContain(`workflow "CI"`)
    expect(runs[0].text).toContain(`https://github.com/${REPO}/actions/runs/900`)
    expect(runs[0].text).toContain(SHA)
    expect(runs[0].text).toContain("feat/y")
  })

  it("falls to the repo route when the author maps to none", async () => {
    prDetails = { user: { login: "someone" } }
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("failure"))
    expect(runs[0].resolvedAgent).toBe("route-agent")
  })

  it("a success, a run with no PR, and check_suite wake nothing", async () => {
    const { gh, runs } = github()
    await hook(gh, "workflow_run", workflowRun("success"))
    await hook(gh, "workflow_run", workflowRun("failure", []))
    await hook(gh, "check_suite", { action: "completed", check_suite: { conclusion: "failure" }, repository: { full_name: REPO } })
    expect(runs).toHaveLength(0)
  })

  it("stops waking after 3 tries on one commit, posts one note, and a success resets", async () => {
    const { gh, runs } = github()
    for (let i = 0; i < 5; i++) await hook(gh, "workflow_run", workflowRun("failure"))
    expect(runs).toHaveLength(3)
    const notes = notePosts()
    expect(notes).toHaveLength(1)
    expect(notes[0].url).toBe(`https://api.github.com/repos/${REPO}/issues/7/comments`)
    expect(notes[0].body).toContain("still red after 3 tries")

    await hook(gh, "workflow_run", workflowRun("success"))
    await hook(gh, "workflow_run", workflowRun("failure"))
    expect(runs).toHaveLength(4)
  })
})

describe("CiFixCounter", () => {
  it("persists counts across instances", () => {
    const file = join(dir, "c.json")
    const a = new CiFixCounter(file)
    expect(a.attempt("k", 2).action).toBe("wake")
    const b = new CiFixCounter(file)
    expect(b.attempt("k", 2)).toEqual({ action: "wake", count: 2 })
    expect(b.attempt("k", 2)).toEqual({ action: "note", count: 2 })
    expect(new CiFixCounter(file).attempt("k", 2).action).toBe("silent")
  })
})
