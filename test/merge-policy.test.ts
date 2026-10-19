import { describe, expect, it } from "vitest"
import { daemonConfigSchema, mergePolicyConfigSchema } from "../src/daemon/config"
import {
  approvals, classify, decide, isCorePath, MAX_LISTED_FILES, MERGE_POLICY_CONTEXT, MergePolicy,
  type ChangedFile, type MergePolicyGitHub, type MergePolicyState, type PullRequestReview,
} from "../src/quality/merge-policy"
import { createMergePolicyGitHub } from "../src/quality/merge-policy-github"
import { GitHubAdapter } from "../src/channels/github"

// The merge policy (#1047): a PR that touches a core path is labeled, and
// an agent's needs a person's approval of its head commit before
// `agentx/merge-policy` turns green. Edge-only PRs pass at once.

const REPO = "acme/api"
const SHA1 = "a".repeat(40)
const SHA2 = "b".repeat(40)
const AGENT = "acme-agentx"

const CORE = { corePaths: ["src/core/**", "package.json"], edgePaths: [] as string[] }

interface Fake {
  gh: MergePolicyGitHub
  statuses: Array<{ sha: string; state: MergePolicyState; description: string }>
  labels: string[]
  calls: string[]
  pr: { headSha: string; authorLogin: string; body: string; state: string }
  files: ChangedFile[]
  reviews: PullRequestReview[]
}

function fakeGitHub(files: string[] = ["src/core/run.ts"]): Fake {
  const f: Fake = {
    statuses: [], labels: [], calls: [],
    pr: { headSha: SHA1, authorLogin: AGENT, body: "Closes #1", state: "open" },
    files: files.map((path) => ({ path })),
    reviews: [],
  } as unknown as Fake
  f.gh = {
    async getPullRequest() { f.calls.push("pr"); return { ...f.pr, labels: [...f.labels] } },
    async getChangedFiles() { f.calls.push("files"); return f.files },
    async getReviews() { f.calls.push("reviews"); return f.reviews },
    async setStatus(_repo, sha, state, description) { f.statuses.push({ sha, state, description }) },
    async addLabel(_repo, _n, label) { f.calls.push(`+${label}`); f.labels.push(label) },
    async removeLabel(_repo, _n, label) { f.calls.push(`-${label}`); f.labels = f.labels.filter((l) => l !== label) },
  }
  return f
}

function review(login: string, state: string, extra: Partial<PullRequestReview> = {}): PullRequestReview {
  return { login, isBot: false, state, commitId: SHA1, association: "OWNER", ...extra }
}

function policy(opts: { config?: Record<string, unknown>; fake?: Fake } = {}) {
  const fake = opts.fake ?? fakeGitHub()
  const config = mergePolicyConfigSchema.parse({ enabled: true, ...CORE, ...opts.config })
  const p = new MergePolicy({ config: () => config, github: fake.gh, isAgentLogin: (l) => l === AGENT })
  const pr = (action = "opened") => p.onEvent({ kind: "pull_request", action, repo: REPO, number: 7 })
  const rv = (action = "submitted") => p.onEvent({ kind: "pull_request_review", action, repo: REPO, number: 7 })
  return { p, fake, pr, rv }
}

describe("config", () => {
  it("is off by default, with no project-specific paths", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n1", name: "demo" }, agents: {} } as any)
    expect(cfg.quality.mergePolicy).toEqual({
      enabled: false, corePaths: [], edgePaths: [], label: "core-change", requiredApprovals: 1, approvers: [],
    })
  })

  it("refuses zero required approvals", () => {
    expect(() => mergePolicyConfigSchema.parse({ requiredApprovals: 0 })).toThrow()
  })
})

describe("isCorePath and classify", () => {
  it("core patterns match folders and single files", () => {
    expect(isCorePath("src/core/a/b.ts", CORE)).toBe(true)
    expect(isCorePath("package.json", CORE)).toBe(true)
    expect(isCorePath("docs/index.md", CORE)).toBe(false)
  })

  it("with no core and no edge paths, nothing is core", () => {
    expect(isCorePath("src/anything.ts", { corePaths: [], edgePaths: [] })).toBe(false)
  })

  it("with edge paths listed, an unlisted path is core and core beats edge", () => {
    const cfg = { corePaths: ["plugins/core-*/**"], edgePaths: ["plugins/**", "docs/**"] }
    expect(isCorePath("docs/a.md", cfg)).toBe(false)
    expect(isCorePath("plugins/weather/x.ts", cfg)).toBe(false)
    expect(isCorePath("plugins/core-auth/x.ts", cfg)).toBe(true)
    expect(isCorePath("src/new-folder/x.ts", cfg)).toBe(true)
  })

  it("a rename out of core is a core change", () => {
    const c = classify([{ path: "plugins/run.ts", previousPath: "src/core/run.ts" }], CORE)
    expect(c).toEqual({ core: true, coreFiles: ["src/core/run.ts"], truncated: false })
  })

  it("a file list GitHub cut short is core", () => {
    const files = Array.from({ length: MAX_LISTED_FILES }, (_, i) => ({ path: `docs/p${i}.md` }))
    expect(classify(files, CORE)).toMatchObject({ core: true, coreFiles: [], truncated: true })
  })
})

describe("approvals", () => {
  const opts = { headSha: SHA1, authorLogin: AGENT, approvers: [] as string[], isAgentLogin: (l: string) => l === AGENT || l === "pat-owner" }

  it("counts a person's approval of the head commit", () => {
    expect(approvals([review("alice", "APPROVED")], opts).approvedBy).toEqual(["alice"])
  })

  it("ignores an approval of an older commit", () => {
    expect(approvals([review("alice", "APPROVED", { commitId: SHA2 })], opts).approvedBy).toEqual([])
  })

  it("ignores bots, AgentX accounts, the author and people without write access", () => {
    const r = approvals([
      review("ci-bot", "APPROVED", { isBot: true }),
      review("pat-owner", "APPROVED"),
      review(AGENT, "APPROVED"),
      review("stranger", "APPROVED", { association: "NONE" }),
      review("contributor", "APPROVED", { association: "CONTRIBUTOR" }),
    ], opts)
    expect(r.approvedBy).toEqual([])
  })

  it("the latest verdict per person wins; comments change nothing; dismissal cancels", () => {
    expect(approvals([review("alice", "APPROVED"), review("alice", "COMMENTED")], opts).approvedBy).toEqual(["alice"])
    expect(approvals([review("alice", "CHANGES_REQUESTED"), review("alice", "APPROVED")], opts)).toEqual({ approvedBy: ["alice"], changesRequestedBy: [] })
    expect(approvals([review("alice", "APPROVED"), review("alice", "CHANGES_REQUESTED")], opts)).toEqual({ approvedBy: [], changesRequestedBy: ["alice"] })
    expect(approvals([review("alice", "APPROVED"), review("alice", "DISMISSED")], opts).approvedBy).toEqual([])
  })

  it("with approvers set, only those logins count, whatever their association", () => {
    const r = approvals([review("alice", "APPROVED"), review("Bob", "APPROVED", { association: "NONE" })], { ...opts, approvers: ["bob"] })
    expect(r.approvedBy).toEqual(["Bob"])
  })
})

describe("decide", () => {
  const core = { core: true, coreFiles: ["src/core/a.ts", "src/core/b.ts", "src/core/c.ts"], truncated: false }
  const edge = { core: false, coreFiles: [], truncated: false }
  const base = { agentPR: true, approvedBy: [], changesRequestedBy: [], required: 1 }

  it("edge only is success", () => {
    expect(decide({ ...base, classification: edge })).toMatchObject({ state: "success", description: "edge only: merges on green CI" })
  })

  it("a core agent PR waits for a person", () => {
    const o = decide({ ...base, classification: core })
    expect(o.state).toBe("pending")
    expect(o.description).toBe("core: src/core/a.ts, src/core/b.ts +1; needs 1 more human approval of this commit")
  })

  it("a core PR opened by a person passes, still marked core", () => {
    expect(decide({ ...base, agentPR: false, classification: core })).toMatchObject({ state: "success", core: true })
  })

  it("needs as many approvals as configured; changes requested holds it", () => {
    expect(decide({ ...base, classification: core, approvedBy: ["alice"], required: 2 }).state).toBe("pending")
    expect(decide({ ...base, classification: core, approvedBy: ["alice", "bob"], required: 2 }).state).toBe("success")
    expect(decide({ ...base, classification: core, approvedBy: ["alice"], changesRequestedBy: ["bob"] }).state).toBe("pending")
  })
})

describe("MergePolicy", () => {
  it("does nothing while off", () => {
    const t = policy({ config: { enabled: false } })
    expect(t.pr()).toBeNull()
    expect(t.fake.calls).toEqual([])
  })

  it("ignores actions that change nothing it checks", () => {
    const t = policy()
    expect(t.pr("labeled")).toBeNull()
    expect(t.pr("closed")).toBeNull()
    expect(t.rv("unknown")).toBeNull()
  })

  it("edge-only PR: success at once, no label, no review lookup", async () => {
    const t = policy({ fake: fakeGitHub(["docs/guide.md"]) })
    await t.pr()
    expect(t.fake.statuses).toEqual([{ sha: SHA1, state: "success", description: "edge only: merges on green CI" }])
    expect(t.fake.labels).toEqual([])
    expect(t.fake.calls).not.toContain("reviews")
  })

  it("core agent PR: labeled and pending, then success when a person approves", async () => {
    const t = policy()
    await t.pr()
    expect(t.fake.labels).toEqual(["core-change"])
    expect(t.fake.statuses.at(-1)).toMatchObject({ sha: SHA1, state: "pending" })
    t.fake.reviews.push(review("alice", "APPROVED"))
    await t.rv()
    expect(t.fake.statuses.at(-1)).toMatchObject({ sha: SHA1, state: "success", description: "core: src/core/run.ts; approved by alice" })
    expect(t.fake.calls.filter((c) => c === "+core-change")).toHaveLength(1)
  })

  it("a push after the approval asks for a new one", async () => {
    const t = policy()
    t.fake.reviews.push(review("alice", "APPROVED"))
    await t.pr()
    expect(t.fake.statuses.at(-1)?.state).toBe("success")
    t.fake.pr.headSha = SHA2
    await t.pr("synchronize")
    expect(t.fake.statuses.at(-1)).toMatchObject({ sha: SHA2, state: "pending" })
  })

  it("a PR carrying an agent's signature is an agent PR whoever opened it", async () => {
    const t = policy()
    t.fake.pr.authorLogin = "someone"
    t.fake.pr.body = "Fix\n\n<!-- agentx:coder -->"
    await t.pr()
    expect(t.fake.statuses.at(-1)?.state).toBe("pending")
  })

  it("core PR opened by a person: labeled, status success", async () => {
    const t = policy()
    t.fake.pr.authorLogin = "alice"
    t.fake.pr.body = ""
    await t.pr()
    expect(t.fake.labels).toEqual(["core-change"])
    expect(t.fake.statuses.at(-1)?.state).toBe("success")
  })

  it("removes the label once a push leaves only edge files", async () => {
    const t = policy()
    await t.pr()
    t.fake.files = [{ path: "docs/a.md" }]
    await t.pr("synchronize")
    expect(t.fake.labels).toEqual([])
    expect(t.fake.statuses.at(-1)?.state).toBe("success")
  })

  it("puts the label back when someone removes it", async () => {
    const t = policy()
    await t.pr()
    t.fake.labels = []
    await t.pr("unlabeled")
    expect(t.fake.labels).toEqual(["core-change"])
  })

  it("an empty label setting labels nothing", async () => {
    const t = policy({ config: { label: "" } })
    await t.pr()
    expect(t.fake.calls.some((c) => c.startsWith("+"))).toBe(false)
    expect(t.fake.statuses.at(-1)?.state).toBe("pending")
  })

  it("a failed file read is error, never success, and leaves the label alone", async () => {
    const t = policy()
    t.fake.gh.getChangedFiles = async () => { throw new Error("GitHub GET files: 502") }
    await t.pr()
    expect(t.fake.statuses).toEqual([{ sha: SHA1, state: "error", description: "check failed: GitHub GET files: 502" }])
    expect(t.fake.calls.some((c) => c.startsWith("+") || c.startsWith("-"))).toBe(false)
  })

  it("a failed label call still posts the status", async () => {
    const t = policy()
    t.fake.gh.addLabel = async () => { throw new Error("403") }
    await t.pr()
    expect(t.fake.statuses.at(-1)?.state).toBe("pending")
  })

  it("skips a closed PR", async () => {
    const t = policy()
    t.fake.pr.state = "closed"
    expect(await t.pr("edited")).toBeNull()
    expect(t.fake.statuses).toEqual([])
  })

  it("checks one PR at a time, in event order", async () => {
    const t = policy()
    const order: string[] = []
    const files = t.fake.gh.getChangedFiles
    let first = true
    t.fake.gh.getChangedFiles = async (r, n) => {
      const mine = first
      first = false
      order.push(mine ? "start1" : "start2")
      if (mine) await new Promise((res) => setTimeout(res, 20))
      order.push(mine ? "end1" : "end2")
      return files(r, n)
    }
    await Promise.all([t.pr(), t.pr("synchronize")])
    expect(order).toEqual(["start1", "end1", "start2", "end2"])
  })
})

describe("GitHub REST calls", () => {
  function fakeFetch(routes: Record<string, unknown>) {
    const seen: Array<{ method: string; url: string; body?: any }> = []
    const impl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      seen.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const key = Object.keys(routes).find((k) => url.includes(k))
      const value = key ? routes[key] : undefined
      if (value === 404) return new Response("", { status: 404 })
      return new Response(JSON.stringify(value ?? {}), { status: 200 })
    }) as unknown as typeof fetch
    return { impl, seen }
  }

  it("reads renames, reviews and labels, and posts the agentx/merge-policy status", async () => {
    const { impl, seen } = fakeFetch({
      "/pulls/7/files": [{ filename: "a.ts" }, { filename: "b.ts", previous_filename: "src/core/b.ts" }],
      "/pulls/7/reviews": [{ user: { login: "alice", type: "User" }, state: "APPROVED", commit_id: SHA1, author_association: "OWNER" }],
      "/pulls/7": { head: { sha: SHA1 }, user: { login: AGENT }, body: "x", labels: [{ name: "core-change" }], state: "open" },
    })
    const gh = createMergePolicyGitHub(async () => "token", impl)
    expect(await gh.getChangedFiles(REPO, 7)).toEqual([{ path: "a.ts" }, { path: "b.ts", previousPath: "src/core/b.ts" }])
    expect(await gh.getReviews(REPO, 7)).toEqual([{ login: "alice", isBot: false, state: "APPROVED", commitId: SHA1, association: "OWNER" }])
    expect(await gh.getPullRequest(REPO, 7)).toEqual({ headSha: SHA1, authorLogin: AGENT, body: "x", labels: ["core-change"], state: "open" })
    await gh.setStatus(REPO, SHA1, "pending", "core")
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: { state: "pending", description: "core", context: MERGE_POLICY_CONTEXT } })
  })

  it("removing a label that is already gone is fine", async () => {
    const { impl } = fakeFetch({ "/labels/core-change": 404 })
    const gh = createMergePolicyGitHub(async () => "token", impl)
    await expect(gh.removeLabel(REPO, 7, "core-change")).resolves.toBeUndefined()
  })
})

describe("GitHub adapter", () => {
  it("hands every pull_request_review event to the listener", async () => {
    const adapter = new GitHubAdapter({ enabled: true, routes: [] } as any, () => {})
    const seen: unknown[] = []
    adapter.onPullRequestReviewEvent((e) => seen.push(e))
    await adapter.handleWebhook(
      { "x-github-event": "pull_request_review" },
      { action: "submitted", review: { id: 1, body: "", state: "approved", html_url: "", user: { login: "alice", id: 1 } }, pull_request: { number: 7, title: "t", html_url: "" }, repository: { full_name: REPO, html_url: "" } } as any,
    )
    expect(seen).toEqual([{ action: "submitted", repo: REPO, number: 7 }])
  })
})
