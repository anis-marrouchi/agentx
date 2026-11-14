import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GITHUB_EVENT_DEFAULTS, GitHubAdapter, type GitHubChannelConfig } from "../src/channels/github"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import { noWakeLabelIn } from "../src/channels/no-wake"
import type { IncomingMessage } from "../src/channels/types"

// agentx#1864 was opened with the label `agent:no-wake` and still started a
// cloud session: no code read the label, and with no project rule loaded
// every `opened` passed (noqta/noqta#800). The label now holds on its own.

const REPO = "acme/api"
const NO_WAKE = "agent:no-wake"

describe("noWakeLabelIn", () => {
  it("finds the label by name or title, in any case, and can be renamed or turned off", () => {
    expect(noWakeLabelIn([{ name: "bug" }, { name: "Agent:No-Wake" }], undefined)).toBe("Agent:No-Wake")
    expect(noWakeLabelIn([{ title: NO_WAKE }], undefined)).toBe(NO_WAKE)
    expect(noWakeLabelIn([NO_WAKE], undefined)).toBe(NO_WAKE)
    expect(noWakeLabelIn([{ name: "bug" }], undefined)).toBeNull()
    expect(noWakeLabelIn(undefined, undefined)).toBeNull()
    expect(noWakeLabelIn([{ name: "hold" }], "hold")).toBe("hold")
    expect(noWakeLabelIn([{ name: NO_WAKE }], "")).toBeNull()
  })
})

describe("GitHub: the no-wake label starts nothing, without a project rule", () => {
  function adapter(overrides: Partial<GitHubChannelConfig> = {}) {
    const logs: string[] = []
    const gh = new GitHubAdapter({
      routes: [{ repo: REPO, agent: "coder-agent" }],
      agentMappings: [{ agentId: "coder-agent", githubUsernames: [] }],
      ...overrides,
    }, (...args) => logs.push(args.join(" ")))
    gh.setAgentMentions((id) => (id === "coder-agent" ? ["@coder-agent"] : []))
    const runs: IncomingMessage[] = []
    gh.onMessage(async (msg) => { runs.push(msg) })
    return { gh, runs, logs }
  }

  const thread = (labels: string[]) => ({
    number: 7,
    title: "Thread 7",
    body: "",
    state: "open",
    html_url: `https://github.com/${REPO}/issues/7`,
    user: { login: "anis", id: 1 },
    assignees: [],
    head: { ref: "feat" },
    base: { ref: "main" },
    labels: labels.map((name) => ({ name })),
  })
  const issueEvent = (action: string, labels: string[], label?: string) => ({
    action,
    issue: thread(labels),
    ...(label ? { label: { name: label } } : {}),
    sender: { login: "anis", id: 1 },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  })
  let nextId = 500
  const user = { login: "anis", id: 1 }
  const repository = { full_name: REPO, html_url: `https://github.com/${REPO}` }

  async function deliver(gh: GitHubAdapter, event: string, body: Record<string, unknown>) {
    await gh.handleWebhook({ "x-github-event": event }, body)
  }
  const settle = () => vi.advanceTimersByTimeAsync(GITHUB_EVENT_DEFAULTS.debounceSeconds * 1000 + 1)

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("an issue opened with the label starts no run, and the log says why", async () => {
    const { gh, runs, logs } = adapter()
    await deliver(gh, "issues", issueEvent("opened", ["p2", NO_WAKE]))
    await settle()
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("Issue #7 on acme/api skipped") && l.includes(`labelled "${NO_WAKE}"`))).toBe(true)
  })

  it("an issue opened without the label still starts a run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", issueEvent("opened", ["p2"]))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("adding the label inside the debounce window drops the held run", async () => {
    const { gh, runs, logs } = adapter({ issueActions: ["opened", "labeled"] })
    await deliver(gh, "issues", issueEvent("opened", []))
    await deliver(gh, "issues", issueEvent("labeled", [NO_WAKE], NO_WAKE))
    await settle()
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("held opened dropped"))).toBe(true)
  })

  it("beats the trigger label", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", issueEvent("labeled", [NO_WAKE, "agentx"], "agentx"))
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("a pull request opened with the label starts no run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "pull_request", { action: "opened", pull_request: thread([NO_WAKE]), sender: user, repository })
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("a comment on a labelled issue starts no run, even with an @-mention", async () => {
    const { gh, runs, logs } = adapter()
    const comment = (labels: string[]) => ({
      action: "created",
      comment: { id: nextId++, body: "@coder-agent please look", html_url: "", user },
      issue: { number: 7, title: "Issue 7", state: "open", html_url: "", labels: labels.map((name) => ({ name })) },
      repository,
    })
    await deliver(gh, "issue_comment", comment([NO_WAKE]))
    await settle()
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("skipped: the thread is labelled"))).toBe(true)
    await deliver(gh, "issue_comment", comment([]))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("a review or review comment on a labelled PR starts no run", async () => {
    const { gh, runs } = adapter()
    const pull_request = { number: 9, title: "PR 9", html_url: "", labels: [{ name: NO_WAKE }] }
    await deliver(gh, "pull_request_review", {
      action: "submitted",
      review: { id: nextId++, body: "@coder-agent fix this", state: "changes_requested", html_url: "", user },
      pull_request, repository,
    })
    await deliver(gh, "pull_request_review_comment", {
      action: "created",
      comment: { id: nextId++, body: "@coder-agent here", html_url: "", path: "a.ts", line: 1, user },
      pull_request, repository,
    })
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("noWakeLabel: \"\" turns the check off", async () => {
    const { gh, runs } = adapter({ noWakeLabel: "" })
    await deliver(gh, "issues", issueEvent("opened", [NO_WAKE]))
    await settle()
    expect(runs).toHaveLength(1)
  })
})

describe("GitLab: the no-wake label starts nothing, without a project rule", () => {
  function adapter(overrides: Partial<GitLabChannelConfig> = {}) {
    const logs: string[] = []
    const gl = new GitLabAdapter({
      webhookPort: 0,
      host: "https://gitlab.example.test",
      token: "global",
      routes: [{ project: REPO, agent: "coder-agent" }],
      ...overrides,
    } as GitLabChannelConfig, (...args) => logs.push(args.join(" ")))
    ;(gl as any).usernameToAgent.set("coder_bot", "coder-agent")
    const runs: IncomingMessage[] = []
    gl.onMessage(async (m) => { runs.push(m) })
    return { gl, runs, logs }
  }
  const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
  const user = { username: "sam", name: "Sam" }
  const project = { path_with_namespace: REPO }
  const issue = (labels: string[]) => ({
    object_kind: "issue",
    user, project,
    object_attributes: { iid: 4, title: "Add export", description: "", state: "opened", action: "open", url: "", labels: labels.map((title) => ({ title })) },
  })
  const note = (labels: string[]) => ({
    object_kind: "note",
    user, project,
    object_attributes: { id: Math.floor(Math.random() * 1e6), note: "@coder_bot please look", noteable_type: "Issue", url: "" },
    issue: { iid: 4, title: "Add export", state: "opened", labels: labels.map((title) => ({ title })) },
  })

  afterEach(() => { vi.unstubAllGlobals() })
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })))
  })

  it("an issue opened with the label starts no run, and the log says why", async () => {
    const { gl, runs, logs } = adapter()
    await (gl as any).handleIssue(issue([NO_WAKE]), res())
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("Issue #4 on acme/api skipped") && l.includes(`labelled "${NO_WAKE}"`))).toBe(true)
  })

  it("an MR carrying the label starts no run", async () => {
    const { gl, runs, logs } = adapter()
    await (gl as any).handleMR({
      object_kind: "merge_request",
      user, project,
      object_attributes: { iid: 5, title: "Fix", description: "", state: "opened", action: "open", url: "", source_branch: "f", target_branch: "main", labels: [{ title: NO_WAKE }] },
    }, res())
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes("MR !5 on acme/api skipped"))).toBe(true)
  })

  it("a note on a labelled issue starts no run, even with an @-mention", async () => {
    const { gl, runs, logs } = adapter()
    await (gl as any).handleNote(note([NO_WAKE]), res())
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes(`skipped: labelled "${NO_WAKE}"`))).toBe(true)
    await (gl as any).handleNote(note([]), res())
    expect(runs).toHaveLength(1)
  })
})
