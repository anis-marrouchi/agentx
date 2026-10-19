import { describe, expect, it } from "vitest"
import { daemonConfigSchema, mergePolicyConfigSchema } from "../src/daemon/config"
import {
  approvalCardInput, classifyFiles, MERGE_POLICY_CONTEXT, MergePolicy,
  type ApprovalCardRequest, type MergePolicyGitHub, type PolicyReview,
} from "../src/quality/merge-policy"
import { createMergePolicyGitHub } from "../src/quality/review-gate-github"
import { buildCard } from "../src/approvals/cards"
import { cardRuleBreak } from "../src/approvals/screen-gate"

// Merge policy (#1047): a PR that changes a core path waits for a person;
// an edge-only PR merges on green CI.

const REPO = "acme/api"
const SHA1 = "a".repeat(40)
const SHA2 = "b".repeat(40)
const AGENT = "acme-agentx"

interface Fake {
  gh: MergePolicyGitHub
  files: string[]
  reviews: PolicyReview[]
  labels: string[]
  statuses: Array<{ sha: string; state: string; description: string }>
  pr: { headSha: string; author: string; state: string; draft: boolean }
}

function fakeGitHub(files: string[]): Fake {
  const f = { files, reviews: [], labels: [], statuses: [], pr: { headSha: SHA1, author: AGENT, state: "open", draft: false } } as unknown as Fake
  f.gh = {
    async getPullRequest(_repo, number) {
      return { number, headSha: f.pr.headSha, authorLogin: f.pr.author, draft: f.pr.draft, state: f.pr.state, labels: [...f.labels], url: `https://github.com/${REPO}/pull/${number}` }
    },
    async getChangedFiles() { return f.files },
    async getReviews() { return f.reviews },
    async setStatus(_repo, sha, state, description) { f.statuses.push({ sha, state, description }) },
    async addLabel(_repo, _n, label) { if (!f.labels.includes(label)) f.labels.push(label) },
    async removeLabel(_repo, _n, label) { f.labels = f.labels.filter((l) => l !== label) },
  }
  return f
}

function policy(opts: { config?: Record<string, unknown>; fake?: Fake; approvedBy?: string; pending?: boolean; failCard?: boolean } = {}) {
  const fake = opts.fake ?? fakeGitHub(["src/core/engine.ts", "docs/readme.md"])
  const cards: ApprovalCardRequest[] = []
  const cfg = mergePolicyConfigSchema.parse({ enabled: true, mode: "required", corePaths: ["src/core"], ...opts.config })
  const p = new MergePolicy({
    config: () => cfg,
    github: fake.gh,
    isAgentLogin: (login) => login === AGENT,
    cardApproval: (_r, _n, sha) => (opts.approvedBy && sha === SHA1 ? opts.approvedBy : undefined),
    cardPending: () => !!opts.pending,
    raiseCard: (req) => {
      if (opts.failCard) throw new Error("too many cards")
      cards.push(req)
    },
  })
  return { p, fake, cards, cfg }
}

const opened = { action: "opened", repo: REPO, number: 7, headSha: SHA1 }

describe("config", () => {
  it("is off with empty path lists by default: nothing is core", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n1", name: "demo" }, agents: {} } as any).quality.mergePolicy
    expect(cfg).toMatchObject({ enabled: false, mode: "advisory", corePaths: [], edgePaths: [], approvers: [], ownerCard: true, label: "core-change" })
  })
})

describe("classifyFiles", () => {
  it("splits files by the core globs; edge paths carve exceptions out", () => {
    const cfg = { corePaths: ["src/core", "src/*.ts", "**/schema.sql"], edgePaths: ["src/core/fixtures/**"] }
    const out = classifyFiles(["src/core/a.ts", "src/core/fixtures/x.json", "src/index.ts", "src/web/page.ts", "db/v2/schema.sql", "README.md"], cfg)
    expect(out.core).toEqual(["src/core/a.ts", "src/index.ts", "db/v2/schema.sql"])
    expect(out.edge).toEqual(["src/core/fixtures/x.json", "src/web/page.ts", "README.md"])
  })

  it("with no core paths every file is edge", () => {
    expect(classifyFiles(["src/core/a.ts"], { corePaths: [], edgePaths: [] }).core).toEqual([])
  })
})

describe("MergePolicy", () => {
  it("does nothing while off", () => {
    const { p } = policy({ config: { enabled: false } })
    expect(p.onPullRequest(opened)).toBeNull()
    expect(p.onReview({ action: "submitted", repo: REPO, number: 7, state: "approved" })).toBeNull()
  })

  it("passes an edge-only PR and leaves no label", async () => {
    const fake = fakeGitHub(["docs/readme.md", "src/web/page.ts"])
    fake.labels.push("core-change")
    const { p, cards } = policy({ fake })
    const o = await p.onPullRequest(opened)
    expect(o?.state).toBe("success")
    expect(fake.statuses).toEqual([{ sha: SHA1, state: "success", description: "edge only: merges on green CI" }])
    expect(fake.labels).toEqual([])
    expect(cards).toEqual([])
  })

  it("labels a core PR, holds it pending and raises one owner card", async () => {
    const { p, fake, cards } = policy()
    const o = await p.onPullRequest(opened)
    expect(o?.state).toBe("pending")
    expect(fake.labels).toEqual(["core-change"])
    expect(fake.statuses[0]).toMatchObject({ sha: SHA1, state: "pending" })
    expect(fake.statuses[0].description).toContain("core paths changed (1: src/core/engine.ts)")
    expect(cards).toEqual([{ repo: REPO, number: 7, sha: SHA1, core: ["src/core/engine.ts"], url: `https://github.com/${REPO}/pull/7` }])
  })

  it("does not raise a second card while one waits for the commit", async () => {
    const { p, cards } = policy({ pending: true })
    expect((await p.onPullRequest(opened))?.state).toBe("pending")
    expect(cards).toEqual([])
  })

  it("stays pending when the card cannot be raised", async () => {
    const { p, fake } = policy({ failCard: true })
    const o = await p.onPullRequest(opened)
    expect(o).toMatchObject({ state: "pending", cardRaised: false })
    expect(fake.statuses).toHaveLength(1)
  })

  it("raises no card when ownerCard is off", async () => {
    const { p, cards } = policy({ config: { ownerCard: false } })
    expect((await p.onPullRequest(opened))?.state).toBe("pending")
    expect(cards).toEqual([])
  })

  it("advisory mode marks a core PR but never holds it", async () => {
    const { p, fake, cards } = policy({ config: { mode: "advisory" } })
    const o = await p.onPullRequest(opened)
    expect(o?.state).toBe("success")
    expect(fake.statuses[0].description).toMatch(/^\[advisory\] core paths changed/)
    expect(fake.labels).toEqual(["core-change"])
    expect(cards).toEqual([])
  })

  it("passes a core PR the owner approved on the card, for that commit only", async () => {
    const { p, fake } = policy({ approvedBy: "anis" })
    expect(await p.onPullRequest(opened)).toMatchObject({ state: "success", approvedBy: "anis" })
    fake.pr.headSha = SHA2
    expect((await p.onPullRequest({ ...opened, action: "synchronize", headSha: SHA2 }))?.state).toBe("pending")
    expect(fake.statuses.map((s) => [s.sha, s.state])).toEqual([[SHA1, "success"], [SHA2, "pending"]])
  })

  it("re-checks when the owner says YES on the card", async () => {
    const { p, fake } = policy({ approvedBy: "anis" })
    const card = { status: "decided", verdict: "yes", origin: { kind: "merge-policy", repo: REPO, pr: 7, sha: SHA1 } }
    expect(await p.onCard(card)).toMatchObject({ state: "success" })
    expect(p.onCard({ ...card, verdict: "no" })).toBeNull()
    expect(p.onCard({ ...card, origin: { kind: "plan-step" } })).toBeNull()
    expect(fake.statuses).toHaveLength(1)
  })

  it("counts a GitHub approval from a person on the head commit", async () => {
    const { p, fake } = policy()
    fake.reviews.push({ login: "carol", state: "approved", commitId: SHA1 })
    expect(await p.onReview({ action: "submitted", repo: REPO, number: 7, state: "approved" })).toMatchObject({ state: "success", approvedBy: "carol" })
  })

  it("does not count approvals from the author, an agent account, an old commit or a withdrawn review", async () => {
    const cases: PolicyReview[][] = [
      [{ login: AGENT, state: "approved", commitId: SHA1 }],
      [{ login: "carol", state: "approved", commitId: SHA2 }],
      [{ login: "carol", state: "approved", commitId: SHA1 }, { login: "carol", state: "changes_requested", commitId: SHA1 }],
      [{ login: "carol", state: "approved", commitId: SHA1 }, { login: "carol", state: "dismissed", commitId: SHA1 }],
    ]
    for (const reviews of cases) {
      const { p, fake } = policy()
      fake.reviews.push(...reviews)
      expect((await p.onPullRequest(opened))?.state).toBe("pending")
    }
    // A later plain comment does not take an approval back.
    const { p, fake } = policy()
    fake.reviews.push({ login: "carol", state: "approved", commitId: SHA1 }, { login: "carol", state: "commented", commitId: SHA1 })
    expect((await p.onPullRequest(opened))?.state).toBe("success")
  })

  it("only counts listed approvers when approvers is set", async () => {
    const { p, fake } = policy({ config: { approvers: ["Dave"] } })
    fake.reviews.push({ login: "carol", state: "approved", commitId: SHA1 })
    expect((await p.onPullRequest(opened))?.state).toBe("pending")
    fake.reviews.push({ login: "dave", state: "approved", commitId: SHA1 })
    expect(await p.onPullRequest(opened)).toMatchObject({ state: "success", approvedBy: "dave" })
  })

  it("passes a core PR a person opened", async () => {
    const { p, fake, cards } = policy()
    fake.pr.author = "carol"
    expect(await p.onPullRequest(opened)).toMatchObject({ state: "success", approvedBy: "carol" })
    expect(fake.labels).toEqual(["core-change"])
    expect(cards).toEqual([])
  })

  it("skips drafts, closed PRs and actions that change no code", async () => {
    const { p, fake } = policy()
    expect(p.onPullRequest({ ...opened, draft: true })).toBeNull()
    expect(p.onPullRequest({ ...opened, action: "labeled" })).toBeNull()
    expect(p.onReview({ action: "edited", repo: REPO, number: 7, state: "approved" })).toBeNull()
    fake.pr.state = "closed"
    expect(await p.onPullRequest(opened)).toBeNull()
    expect(fake.statuses).toEqual([])
  })

  it("runs one check per PR at a time, in order", async () => {
    const { p, fake } = policy()
    const a = p.onPullRequest(opened)
    fake.reviews.push({ login: "carol", state: "approved", commitId: SHA1 })
    const b = p.onReview({ action: "submitted", repo: REPO, number: 7, state: "approved" })
    await Promise.all([a, b])
    expect(fake.statuses.map((s) => s.state)).toEqual(["success", "success"])
  })

  it("a GitHub failure is logged, not thrown", async () => {
    const fake = fakeGitHub(["src/core/a.ts"])
    fake.gh.getChangedFiles = async () => { throw new Error("GitHub GET /files: 502") }
    const { p } = policy({ fake })
    expect(await p.onPullRequest(opened)).toBeNull()
  })
})

describe("owner card", () => {
  it("is one short yes/no question the approvals store accepts", () => {
    const input = approvalCardInput({ repo: REPO, number: 7, sha: SHA1, core: ["src/core/a.ts", "src/core/b.ts", "src/core/c.ts", "src/core/d.ts"], url: "https://x/pr/7" }, "coder")
    const built = buildCard(input)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(cardRuleBreak(built.card)).toBeNull()
    expect(built.card.ask).toContain("and 1 more")
    expect(built.card.source).toBe("https://x/pr/7")
  })
})

describe("createMergePolicyGitHub", () => {
  it("posts the agentx/merge-policy status, labels, and reads reviews", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined })
      if (url.includes("/reviews")) return new Response(JSON.stringify([{ user: { login: "carol" }, state: "APPROVED", commit_id: SHA1 }]))
      if (init.method === "DELETE") return new Response("", { status: 404 })
      return new Response("{}")
    }) as unknown as typeof fetch
    const gh = createMergePolicyGitHub(async () => "tok", fetchImpl)
    await gh.setStatus(REPO, SHA1, "pending", "waiting")
    await gh.addLabel(REPO, 7, "core-change")
    await gh.removeLabel(REPO, 7, "core change")
    expect(await gh.getReviews(REPO, 7)).toEqual([{ login: "carol", state: "approved", commitId: SHA1 }])
    expect(JSON.parse(calls[0].body!)).toEqual({ state: "pending", description: "waiting", context: MERGE_POLICY_CONTEXT })
    expect(calls[1]).toMatchObject({ method: "POST", url: `https://api.github.com/repos/${REPO}/issues/7/labels` })
    expect(calls[2].url).toBe(`https://api.github.com/repos/${REPO}/issues/7/labels/core%20change`)
  })
})
