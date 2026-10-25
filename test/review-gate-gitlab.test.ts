import { describe, expect, it } from "vitest"
import { reviewGateConfigSchema } from "../src/daemon/config"
import { ReviewGate, fromJiraMarkup, acceptanceCriteria, linkedIssueKeys, type IssueInfo, type ReviewerRequest } from "../src/quality/review-gate"
import { checkState, createReviewGateGitLab, gitlabStatusState, unifiedDiff } from "../src/quality/review-gate-gitlab"
import { parseReplayBody } from "../src/quality/review-gate-api"
import { mergeRequestEventInfo, type GitLabMREvent } from "../src/channels/gitlab"
import type { ReviewRecord } from "../src/quality/review-ledger"

// The review gate on GitLab merge requests, and Linear/Jira issues as the
// source of acceptance criteria (#1292).

const HOST = "https://gitlab.example.com"
const PROJECT = "group/sub/api"
const SHA = "c".repeat(40)

interface Call { method: string; url: string; body?: any }

function fakeGitLab(routes: Record<string, unknown>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const path = url.replace(`${HOST}/api/v4`, "")
    const key = `${method} ${path.split("?")[0]}`
    if (!(key in routes)) return new Response("{}", { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, client: createReviewGateGitLab(HOST, () => "glpat-test", fetchImpl) }
}

const P = `/projects/${encodeURIComponent(PROJECT)}`

describe("GitLab REST client", () => {
  it("reads a merge request in the gate's terms", async () => {
    const { client, calls } = fakeGitLab({
      [`GET ${P}/merge_requests/5`]: { iid: 5, sha: SHA, title: "Fix", description: "Closes #3", author: { username: "coder-bot" }, draft: false, state: "opened" },
    })
    expect(await client.getPullRequest(PROJECT, 5)).toEqual({ number: 5, headSha: SHA, title: "Fix", body: "Closes #3", authorLogin: "coder-bot", draft: false, state: "open" })
    expect(calls[0].url).toBe(`${HOST}/api/v4/projects/group%2Fsub%2Fapi/merge_requests/5`)
  })

  it("builds a unified diff from the MR's file diffs", async () => {
    const { client } = fakeGitLab({
      [`GET ${P}/merge_requests/5/diffs`]: [
        { old_path: "src/a.ts", new_path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" },
        { old_path: "src/new.ts", new_path: "src/new.ts", diff: "@@ -0,0 +1 @@\n+x\n", new_file: true },
      ],
    })
    const diff = await client.getDiff(PROJECT, 5)
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@")
    expect(diff).toContain("--- /dev/null\n+++ b/src/new.ts")
    expect(await client.getChangedFiles(PROJECT, 5)).toEqual(["src/a.ts", "src/new.ts"])
  })

  it("lists CI without its own status and maps GitLab's states", async () => {
    const { client } = fakeGitLab({
      [`GET ${P}/repository/commits/${SHA}/statuses`]: [
        { name: "test", status: "running" },
        { name: "lint", status: "failed" },
        { name: "agentx/review", status: "running" },
      ],
    })
    expect(await client.getChecks(PROJECT, SHA)).toEqual([{ name: "test", state: "pending" }, { name: "lint", state: "failure" }])
  })

  it("posts the verdict as a commit status, error as failed with its word", async () => {
    const { client, calls } = fakeGitLab({ [`POST ${P}/statuses/${SHA}`]: {} })
    await client.setStatus(PROJECT, SHA, "error", "over budget")
    await client.setStatus(PROJECT, SHA, "pending", "review running")
    expect(calls.map((c) => c.body)).toEqual([
      { state: "failed", name: "agentx/review", description: "error: over budget" },
      { state: "running", name: "agentx/review", description: "review running" },
    ])
  })

  it("signs its notes and returns their link", async () => {
    const { client, calls } = fakeGitLab({ [`POST ${P}/merge_requests/5/notes`]: { id: 77 } })
    const url = await client.comment(PROJECT, 5, "changes needed", "reviewer")
    expect(url).toBe(`${HOST}/${PROJECT}/-/merge_requests/5#note_77`)
    expect(calls[0].body.body).toContain("agentx:reviewer")
  })

  it("answers null for a missing issue", async () => {
    const { client } = fakeGitLab({})
    expect(await client.getIssue(PROJECT, 9)).toBeNull()
  })

  it("maps states both ways", () => {
    expect(gitlabStatusState("success")).toBe("success")
    expect(gitlabStatusState("failure")).toBe("failed")
    expect(checkState("canceled")).toBe("cancelled")
    expect(checkState("success")).toBe("success")
    expect(unifiedDiff({ old_path: "x", new_path: "x", diff: "", deleted_file: true })).toContain("+++ /dev/null")
  })
})

describe("merge request webhooks", () => {
  const event = (attrs: Partial<GitLabMREvent["object_attributes"]>): GitLabMREvent => ({
    object_kind: "merge_request",
    user: { name: "Coder", username: "coder-bot" },
    project: { path_with_namespace: PROJECT },
    object_attributes: { iid: 5, title: "Fix", description: "Closes #3", state: "opened", action: "open", source_branch: "agentx/issue-3", target_branch: "main", url: "", last_commit: { id: SHA }, ...attrs },
  })

  it("names GitLab's actions the way the gate knows them", () => {
    expect(mergeRequestEventInfo(event({}))?.action).toBe("opened")
    expect(mergeRequestEventInfo(event({ action: "update", oldrev: "d".repeat(40) }))?.action).toBe("synchronize")
    expect(mergeRequestEventInfo(event({ action: "update" }))?.action).toBe("edited")
    expect(mergeRequestEventInfo(event({ action: "merge" }))?.action).toBe("closed")
    expect(mergeRequestEventInfo(event({ action: "approved" }))).toBeNull()
    expect(mergeRequestEventInfo(event({ draft: true }))).toMatchObject({ draft: true, repo: PROJECT, number: 5, headSha: SHA, authorLogin: "coder-bot" })
  })
})

describe("tracker issue keys", () => {
  it("reads closing keys whose prefix is configured", () => {
    expect(linkedIssueKeys("Fixes ENG-12\nRefs PROJ-4, ENG-13\nSee OTHER-1\nfixes eng-12", ["ENG", "PROJ"])).toEqual(["ENG-12", "PROJ-4", "ENG-13"])
    expect(linkedIssueKeys("Fixes ENG-12", [])).toEqual([])
    // A bare key in a sentence is a mention, not a link.
    expect(linkedIssueKeys("Like ENG-12 did", ["ENG"])).toEqual([])
  })

  it("reads acceptance criteria out of Jira's wiki markup", () => {
    const body = fromJiraMarkup("Intro\n\nh2. Acceptance criteria\n* Retries 3 times\n* Shows the error\n# numbered too\n\nh2. Notes\n* not one")
    expect(acceptanceCriteria(body)).toEqual(["Retries 3 times", "Shows the error", "numbered too"])
  })
})

describe("the gate with GitLab and trackers", () => {
  const LINEAR: IssueInfo = { repo: "linear", number: 12, key: "ENG-12", title: "Retry uploads", body: "## Acceptance criteria\n- [ ] Retries 3 times", isPullRequest: false }

  function gate(prBody: string, rows: ReviewRecord[] = []) {
    const records: ReviewRecord[] = []
    const requests: ReviewerRequest[] = []
    const statuses: string[] = []
    const g = new ReviewGate({
      config: () => reviewGateConfigSchema.parse({ enabled: true, reviewer: { agent: "reviewer" }, ciWaitMinutes: 0, maxReviewsPerPrPerDay: 1 }),
      github: {
        async getPullRequest(_r, n) { return { number: n, headSha: SHA, title: "t", body: prBody, authorLogin: "coder-bot", draft: false, state: "open" } },
        async getDiff() { return "diff --git a/x b/x\n+x\n" },
        async getChangedFiles() { return ["x"] },
        async getIssue() { return null },
        async getChecks() { return [] },
        async setStatus(_r, _s, state, d) { statuses.push(`${state}: ${d}`) },
        async comment() { return undefined },
      },
      runReviewer: async (req) => { requests.push(req); return { content: '{"verdict":"approve","unmet":[],"defects":[]}', durationMs: 1000, costUsd: 0.01 } },
      repoAgent: () => "coder",
      agentModel: (id) => (id === "coder" ? "model-a" : "model-b"),
      isAgentLogin: () => true,
      ledger: { append: (r) => records.push(r), read: () => rows },
      forge: "gitlab",
      trackers: { prefixes: () => ["ENG"], getIssue: async (k) => (k === "ENG-12" ? LINEAR : null) },
      sleep: async () => {},
    })
    return { g, records, requests, statuses }
  }

  it("reviews against a Linear issue a merge request links by key", async () => {
    const { g, records, requests, statuses } = gate("Fixes ENG-12")
    const o = await g.onPullRequest({ action: "opened", repo: PROJECT, number: 5, headSha: SHA, authorLogin: "coder-bot", title: "t", body: "Fixes ENG-12" })
    expect(o?.state).toBe("success")
    expect(requests[0].prompt).toContain("### ENG-12: Retry uploads")
    expect(records[0]).toMatchObject({ forge: "gitlab", issues: ["ENG-12"] })
    expect(statuses.at(-1)).toContain("approved against ENG-12")
  })

  it("asks for a key in the failure when trackers are on", async () => {
    const { g } = gate("no link")
    const o = await g.onPullRequest({ action: "opened", repo: PROJECT, number: 5, headSha: SHA, authorLogin: "coder-bot", title: "t", body: "no link" })
    expect(o?.reason).toContain("\"Fixes KEY-N\"")
  })

  it("counts only its own forge's reviews toward the daily limit", async () => {
    const at = new Date().toISOString()
    const github: ReviewRecord = { at, repo: PROJECT, pr: 5, sha: "e".repeat(40), mode: "advisory", state: "success", reason: "", reviewerRan: true }
    const { g } = gate("Fixes ENG-12", [github])
    const o = await g.onPullRequest({ action: "opened", repo: PROJECT, number: 5, headSha: SHA, authorLogin: "coder-bot", title: "t", body: "Fixes ENG-12" })
    expect(o?.state).toBe("success")
    const { g: g2 } = gate("Fixes ENG-12", [{ ...github, forge: "gitlab" }])
    const o2 = await g2.onPullRequest({ action: "opened", repo: PROJECT, number: 5, headSha: SHA, authorLogin: "coder-bot", title: "t", body: "Fixes ENG-12" })
    expect(o2?.reason).toMatch(/^review limit/)
  })
})

describe("config and replay", () => {
  it("reviews GitHub only unless told otherwise", () => {
    expect(reviewGateConfigSchema.parse({}).forges).toEqual(["github"])
    expect(reviewGateConfigSchema.parse({ forges: ["github", "gitlab"] }).forges).toEqual(["github", "gitlab"])
  })

  it("replays GitLab projects in subgroups", () => {
    expect(parseReplayBody({ repo: "group/sub/api", prs: [1], forge: "gitlab" })).toEqual({ repo: "group/sub/api", prs: [1], forge: "gitlab" })
    expect(parseReplayBody({ repo: "group/sub/api", prs: [1] })).toHaveProperty("error")
    expect(parseReplayBody({ repo: "o/r", prs: [1], forge: "bitbucket" })).toHaveProperty("error")
  })
})
