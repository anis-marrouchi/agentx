import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GITHUB_EVENT_DEFAULTS, GitHubAdapter, mentionsAgent, type GitHubChannelConfig } from "../src/channels/github"
import type { IncomingMessage } from "../src/channels/types"

// One plain owner comment on an issue started a cloud session 8 s later
// (#1719). A comment now starts a run only when it @-mentions the agent;
// adding the trigger label starts one too.

const REPO = "acme/api"
const OWNER = "anis"

function adapter(overrides: Partial<GitHubChannelConfig> = {}): { gh: GitHubAdapter; runs: IncomingMessage[]; logs: string[] } {
  const logs: string[] = []
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "coder-agent" }],
    agentMappings: [{ agentId: "coder-agent", githubUsernames: [] }],
    ...overrides,
  }, (...args) => logs.push(args.join(" ")))
  gh.setAgentMentions((id) => (id === "coder-agent" ? ["@noqta_coder_bot", "coder"] : []))
  const runs: IncomingMessage[] = []
  gh.onMessage(async (msg) => { runs.push(msg) })
  return { gh, runs, logs }
}

let nextId = 100
function commentEvent(body: string, opts: { pr?: boolean } = {}) {
  return {
    action: "created",
    comment: { id: nextId++, body, html_url: "", user: { login: OWNER, id: 1 } },
    issue: {
      number: 7,
      title: "Issue 7",
      state: "open",
      html_url: `https://github.com/${REPO}/issues/7`,
      ...(opts.pr ? { pull_request: {} } : {}),
    },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  }
}

function labeledEvent(kind: "issues" | "pull_request", label: string) {
  const thread = {
    number: 7,
    title: "Thread 7",
    body: "",
    state: "open",
    html_url: `https://github.com/${REPO}/issues/7`,
    user: { login: OWNER, id: 1 },
    assignees: [],
    head: { ref: "feat" },
    base: { ref: "main" },
    labels: [{ name: label }],
  }
  return {
    action: "labeled",
    ...(kind === "issues" ? { issue: thread } : { pull_request: thread }),
    label: { name: label },
    sender: { login: OWNER, id: 1 },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  }
}

async function deliver(gh: GitHubAdapter, event: string, body: Record<string, unknown>): Promise<void> {
  await gh.handleWebhook({ "x-github-event": event }, body)
  await vi.advanceTimersByTimeAsync(GITHUB_EVENT_DEFAULTS.debounceSeconds * 1000 + 1)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("GitHub comments start a run only on an @-mention (#1719)", () => {
  it("a plain comment on an issue starts nothing", async () => {
    const { gh, runs, logs } = adapter()
    await deliver(gh, "issue_comment", commentEvent("Closing test: this should be done now."))
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("does not @-mention coder-agent"))).toBe(true)
  })

  it("a plain comment from the account AgentX posts with starts nothing (#1719, 08:47Z)", async () => {
    const { gh, runs } = adapter({ agentMappings: [{ agentId: "coder-agent", githubUsernames: [OWNER] }] })
    await deliver(gh, "issue_comment", commentEvent("Close test on v0.204.0: this issue should stay closed."))
    expect(runs).toHaveLength(0)
    await deliver(gh, "issue_comment", commentEvent("@coder-agent please check this"))
    expect(runs).toHaveLength(1)
  })

  it("a plain comment on a pull request starts nothing", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issue_comment", commentEvent("Looks good to me.", { pr: true }))
    expect(runs).toHaveLength(0)
  })

  it("naming the agent without @ starts nothing", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issue_comment", commentEvent("coder already fixed this"))
    expect(runs).toHaveLength(0)
  })

  it("an @-mention of the agent starts a run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issue_comment", commentEvent("@coder please take this"))
    expect(runs).toHaveLength(1)
    expect(runs[0].resolvedAgent).toBe("coder-agent")
  })

  it("an @-mention by agent id or configured handle starts a run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issue_comment", commentEvent("Over to @coder-agent."))
    await deliver(gh, "issue_comment", commentEvent("cc @Noqta_Coder_Bot", { pr: true }))
    expect(runs).toHaveLength(2)
  })

  it("a plain review comment and a plain review start nothing; mentioned ones do", async () => {
    const { gh, runs } = adapter()
    const pull_request = { number: 9, title: "Add thing", html_url: "" }
    const repository = { full_name: REPO, html_url: "" }
    const user = { login: OWNER, id: 1 }
    await deliver(gh, "pull_request_review_comment", { action: "created", comment: { id: 1, body: "nit", html_url: "", path: "a.ts", line: 1, user }, pull_request, repository })
    await deliver(gh, "pull_request_review", { action: "submitted", review: { id: 2, body: "Approved.", state: "approved", html_url: "", user }, pull_request, repository })
    expect(runs).toHaveLength(0)
    await deliver(gh, "pull_request_review_comment", { action: "created", comment: { id: 3, body: "@coder rename this", html_url: "", path: "a.ts", line: 1, user }, pull_request, repository })
    await deliver(gh, "pull_request_review", { action: "submitted", review: { id: 4, body: "@coder two changes", state: "changes_requested", html_url: "", user }, pull_request, repository })
    expect(runs).toHaveLength(2)
  })
})

describe("the trigger label starts a run (#1719)", () => {
  it("adding the trigger label to an issue starts a run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", labeledEvent("issues", "agentx"))
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toMatch(/^\[GitHub Issue #7 labeled\]/)
  })

  it("adding the trigger label to a pull request starts a run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "pull_request", labeledEvent("pull_request", "agentx"))
    expect(runs).toHaveLength(1)
  })

  it("counts when the account AgentX posts with adds it", async () => {
    const { gh, runs } = adapter({ agentMappings: [{ agentId: "coder-agent", githubUsernames: [OWNER] }] })
    await deliver(gh, "issues", labeledEvent("issues", "agentx"))
    expect(runs).toHaveLength(1)
  })

  it("any other label starts nothing", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", labeledEvent("issues", "bug"))
    expect(runs).toHaveLength(0)
  })

  it("follows channels.github.triggerLabel", async () => {
    const { gh, runs } = adapter({ triggerLabel: "ai-go" })
    await deliver(gh, "issues", labeledEvent("issues", "agentx"))
    expect(runs).toHaveLength(0)
    await deliver(gh, "issues", labeledEvent("issues", "AI-Go"))
    expect(runs).toHaveLength(1)
  })
})

describe("mentionsAgent", () => {
  it("matches whole handles only", () => {
    expect(mentionsAgent("hi @coder", ["@coder"])).toBe(true)
    expect(mentionsAgent("@coder, look", ["@coder"])).toBe(true)
    expect(mentionsAgent("hi @coder-agent", ["@coder"])).toBe(false)
    expect(mentionsAgent("hi @coders", ["@coder"])).toBe(false)
    expect(mentionsAgent("mail me@coder.dev", ["@coder"])).toBe(false)
    expect(mentionsAgent("", ["@coder"])).toBe(false)
  })
})
