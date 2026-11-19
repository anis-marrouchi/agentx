import { describe, it, expect, afterEach, vi } from "vitest"
import { GitLabAdapter } from "../src/channels/gitlab"
import { GitHubAdapter } from "../src/channels/github"
import { detectAgentxMarker, markBody } from "../src/channels/outbound-marker"
import { STATUS_TAG, isStatusComment } from "../src/channels/status-tag"

// Editing an agent's own comment on GitLab and GitHub, the status tag the
// forge channels drop, and the GitLab assignment prompt. Kept from the
// request status tests when request status was removed (#1950).

const CHAT = "acme/shop:issue:7"

describe("editing the comment on the forge", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  const stubFetch = (ok = true) => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers })
      return { ok, status: ok ? 200 : 403, text: async () => "", json: async () => ({}) }
    }))
  }

  const gitlab = (mappings: any[] = [{ agentId: "coder", gitlabUsernames: ["coder-bot"], keywords: [], token: "agent-token" }]) =>
    new GitLabAdapter({
      enabled: true, webhookPort: 0, host: "https://gitlab.example", token: "global-token",
      routes: [], agentMappings: mappings,
    } as any, () => {})

  it("GitLab: edits the note with the agent's own token and keeps the signature", async () => {
    stubFetch()
    expect(await gitlab().editComment(CHAT, "555", "**Done**", "coder")).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("PUT")
    expect(calls[0].url).toBe("https://gitlab.example/api/v4/projects/acme%2Fshop/issues/7/notes/555")
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("agent-token")
    expect(detectAgentxMarker(calls[0].body.body)).toBe("coder")
  })

  it("GitLab: edits a merge request note on the merge request path", async () => {
    stubFetch()
    await gitlab().editComment("acme/shop:merge_request:12", "9", "x", "coder")
    expect(calls[0].url).toContain("/merge_requests/12/notes/9")
  })

  it("GitLab: sends the edit to the peer that holds the token, and that peer never forwards again", async () => {
    stubFetch()
    const adapter = gitlab([{ agentId: "coder", gitlabUsernames: [], keywords: [], node: "clawd" }])
    const forwarded: any[] = []
    adapter.setEditCommentForwarder(async (...args) => { forwarded.push(args); return true })
    expect(await adapter.editComment(CHAT, "555", "x", "coder")).toBe(true)
    expect(forwarded).toEqual([["clawd", CHAT, "555", "coder", "x"]])
    expect(calls).toHaveLength(0)
    // On the peer (localOnly): no second hop.
    await adapter.editComment(CHAT, "555", "x", "coder", true)
    expect(forwarded).toHaveLength(1)
  })

  it("GitLab: reports a refused edit and rejects an id that is not a note id", async () => {
    stubFetch(false)
    expect(await gitlab().editComment(CHAT, "555", "x", "coder")).toBe(false)
    expect(await gitlab().editComment(CHAT, "../../users", "x", "coder")).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("GitLab: an assignment always asks the agent to acknowledge it in a comment (#1950)", async () => {
    stubFetch()
    const adapter = gitlab() as any
    adapter.usernameToAgent.set("coder-bot", "coder") // built by start() in the daemon
    const got: string[] = []
    adapter.onMessage(async (m: any) => { got.push(m.text) })
    await adapter.handleIssue({
      object_kind: "issue",
      user: { username: "sami", name: "Sami", id: 77 },
      project: { path_with_namespace: "acme/shop", id: 1, web_url: "https://gitlab.example/acme/shop" },
      object_attributes: { iid: 21, id: 1021, title: "Checkout fails", description: "It fails.", action: "update", state: "opened", url: "https://gitlab.example/acme/shop/-/issues/21" },
      assignees: [{ username: "coder-bot" }],
      changes: { assignees: { previous: [], current: [{ username: "coder-bot" }] } },
      labels: [],
    }, { writeHead: () => {}, end: () => {} })
    expect(got.join("\n")).toContain("Please acknowledge this assignment in a comment, then start working on the issue.")
  })

  it("GitHub: a status comment signed by another agent starts no turn; a review signed by it still does", async () => {
    stubFetch()
    const adapter = new GitHubAdapter({
      token: "t", routes: [{ repo: "acme/shop", agent: "coder" }],
      agentMappings: [{ agentId: "coder", githubUsernames: ["owner"] }],
    } as any, () => {})
    const got: string[] = []
    adapter.onMessage(async (m: any) => { got.push(m.text) })
    const comment = (id: number, body: string, login = "owner") => ({
      action: "created",
      comment: { id, body, user: { login, id: 1 } },
      issue: { number: 3, title: "Checkout fails" },
      repository: { full_name: "acme/shop", html_url: "u" },
    })
    const status = markBody(`Status: **Done**\n${STATUS_TAG}`, "devops")
    expect(isStatusComment(status)).toBe(true)
    await (adapter as any).handleIssueComment(comment(1, status))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual([])
    await (adapter as any).handleIssueComment(comment(2, markBody("@coder Verdict: NOT READY", "devops")))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toHaveLength(1)
    // Typed by someone AgentX does not post as: an ordinary comment.
    await (adapter as any).handleIssueComment(comment(3, `@coder ${status}`, "outsider"))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toHaveLength(2)
  })

  it("GitHub: edits the comment in place with the same signature", async () => {
    stubFetch()
    const adapter = new GitHubAdapter({ enabled: true, token: "gh-token", routes: [], agentMappings: [] } as any, () => {})
    ;(adapter as any).globalToken = "gh-token"
    expect(await adapter.editComment("acme/shop:issue:3", "888", "**Done**", "coder")).toBe(true)
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/shop/issues/comments/888")
    expect(detectAgentxMarker(calls[0].body.body)).toBe("coder")
  })
})
