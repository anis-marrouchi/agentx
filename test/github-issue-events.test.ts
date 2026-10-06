import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { GITHUB_EVENT_DEFAULTS, GitHubAdapter, type GitHubChannelConfig } from "../src/channels/github"
import type { IncomingMessage } from "../src/channels/types"
import { ProjectRulesStore } from "../src/projects/rules"

// One GitHub issue woke the mapped agent several times (#612): once on
// `opened`, again on each `labeled` the owner sweep itself applied, and on
// `closed`. The gate drops AgentX's own changes, the channel's action list
// keeps `closed` out unless a rule asks for it, and a burst of events on one
// issue becomes one run.

const REPO = "acme/api"
const AGENT_LOGIN = "acme-agentx"

function adapter(overrides: Partial<GitHubChannelConfig> = {}): { gh: GitHubAdapter; runs: IncomingMessage[]; logs: string[] } {
  const logs: string[] = []
  const gh = new GitHubAdapter({
    routes: [{ repo: REPO, agent: "coder" }],
    agentMappings: [{ agentId: "coder", githubUsernames: [AGENT_LOGIN] }],
    ...overrides,
  }, (...args) => logs.push(args.join(" ")))
  const runs: IncomingMessage[] = []
  gh.onMessage(async (msg) => { runs.push(msg) })
  return { gh, runs, logs }
}

function issueEvent(action: string, opts: { number?: number; sender?: string; labels?: string[]; state?: string } = {}) {
  const number = opts.number ?? 7
  return {
    action,
    issue: {
      number,
      title: `Issue ${number}`,
      body: "Please look at this.",
      state: opts.state ?? "open",
      html_url: `https://github.com/${REPO}/issues/${number}`,
      user: { login: "alex", id: 1 },
      assignees: [],
      labels: (opts.labels ?? []).map((name) => ({ name })),
    },
    sender: { login: opts.sender ?? "alex", id: 1 },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  }
}

function prEvent(action: string, opts: { sender?: string } = {}) {
  return {
    action,
    pull_request: {
      number: 9,
      title: "Add thing",
      body: "",
      state: "open",
      html_url: `https://github.com/${REPO}/pull/9`,
      head: { ref: "feat" },
      base: { ref: "main" },
      user: { login: "alex", id: 1 },
    },
    sender: { login: opts.sender ?? "alex", id: 1 },
    repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
  }
}

async function deliver(gh: GitHubAdapter, event: "issues" | "pull_request", body: Record<string, unknown>): Promise<void> {
  await gh.handleWebhook({ "x-github-event": event }, body)
}

/** Let the debounce window end and every held run start. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(GITHUB_EVENT_DEFAULTS.debounceSeconds * 1000 + 1)
}

let tmp: string
let store: ProjectRulesStore | undefined

function rules(yamlBody: string): ProjectRulesStore {
  const file = path.join(tmp, "acme", "api.yaml")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, yamlBody, "utf-8")
  store = new ProjectRulesStore(tmp, () => {})
  store.load()
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-gh-events-"))
})

afterEach(() => {
  vi.useRealTimers()
  store?.stop()
  store = undefined
  rmSync(tmp, { recursive: true, force: true })
})

describe("GitHub issue events (#612)", () => {
  it("an issue opened by a person and then labeled by the owner sweep starts one run", async () => {
    const { gh, runs, logs } = adapter()
    await deliver(gh, "issues", issueEvent("opened"))
    await deliver(gh, "issues", issueEvent("labeled", { sender: AGENT_LOGIN, labels: ["agent:coder"] }))
    await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toMatch(/^\[GitHub Issue #7 opened\]/)
    // Dropped by the default action list before the own-change check.
    expect(logs.some((l) => l.includes('action="labeled" not in channels.github.issueActions'))).toBe(true)
  })

  it("the owner sweep's label starts nothing when issueActions lets labeled through", async () => {
    const { gh, runs, logs } = adapter({ issueActions: ["opened", "labeled"] })
    await deliver(gh, "issues", issueEvent("opened"))
    await settle()
    await deliver(gh, "issues", issueEvent("labeled", { sender: AGENT_LOGIN, labels: ["agent:coder"] }))
    await settle()
    expect(runs).toHaveLength(1)
    expect(logs.some((l) => l.includes("ignoreOwnChanges"))).toBe(true)
  })

  it("three events on one issue inside the window become one run with the latest state", async () => {
    const { gh, runs } = adapter({ issueActions: ["opened", "assigned", "labeled"] })
    await deliver(gh, "issues", issueEvent("opened"))
    await vi.advanceTimersByTimeAsync(10_000)
    await deliver(gh, "issues", issueEvent("labeled", { labels: ["bug"] }))
    await vi.advanceTimersByTimeAsync(10_000)
    await deliver(gh, "issues", issueEvent("assigned", { labels: ["bug"] }))
    await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toMatch(/^\[GitHub Issue #7 opened, labeled, assigned\]/)
    expect((runs[0].raw as { action: string }).action).toBe("assigned")
    expect(runs[0].resolvedAgent).toBe("coder")
    // The triage model (#615) reads every collapsed action, not the last.
    expect(runs[0].channelMeta?.eventActions).toEqual(["opened", "labeled", "assigned"])
  })

  it("the window restarts with each event and ends on its own", async () => {
    const { gh, runs } = adapter({ debounceSeconds: 5 })
    await deliver(gh, "issues", issueEvent("opened"))
    await vi.advanceTimersByTimeAsync(4_000)
    await deliver(gh, "issues", issueEvent("reopened"))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(runs).toHaveLength(1)
  })

  it("events on different issues each start their own run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", issueEvent("opened", { number: 1 }))
    await deliver(gh, "issues", issueEvent("opened", { number: 2 }))
    await settle()
    expect(runs.map((r) => r.id).sort()).toEqual([`issue-${REPO}-1`, `issue-${REPO}-2`])
  })

  it("debounceSeconds: 0 starts a run per event", async () => {
    const { gh, runs } = adapter({ debounceSeconds: 0 })
    await deliver(gh, "issues", issueEvent("opened"))
    await deliver(gh, "issues", issueEvent("reopened"))
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(2)
  })

  it("closed does not start a run without a rule, even when the rules store is attached", async () => {
    const { gh, runs, logs } = adapter()
    gh.setProjectRules(rules(`project: other/repo\n`))
    await deliver(gh, "issues", issueEvent("closed", { state: "closed" }))
    await settle()
    expect(runs).toHaveLength(0)
    expect(logs.some((l) => l.includes('action="closed" not in channels.github.issueActions'))).toBe(true)
  })

  it("a rule that lists closed in its actions asks for it explicitly", async () => {
    const { gh, runs } = adapter()
    gh.setProjectRules(rules(`
project: ${REPO}
github:
  issues:
    actions: [opened, closed]
`))
    await deliver(gh, "issues", issueEvent("closed", { state: "closed" }))
    await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toMatch(/^\[GitHub Issue #7 closed\]/)
  })

  it("a rule without an actions list keeps the channel's action list", async () => {
    const { gh, runs } = adapter()
    gh.setProjectRules(rules(`
project: ${REPO}
github:
  issues:
    requireLabels: [bug]
`))
    await deliver(gh, "issues", issueEvent("labeled", { labels: ["bug"] }))
    await deliver(gh, "issues", issueEvent("closed", { labels: ["bug"], state: "closed" }))
    await settle()
    expect(runs).toHaveLength(0)
    await deliver(gh, "issues", issueEvent("opened", { labels: ["bug"] }))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("a rule's own actions list replaces the channel's, and its other filters still apply", async () => {
    const { gh, runs } = adapter()
    gh.setProjectRules(rules(`
project: ${REPO}
github:
  issues:
    actions: [labeled]
    requireLabels: [agent:coder]
`))
    await deliver(gh, "issues", issueEvent("opened"))
    await deliver(gh, "issues", issueEvent("labeled", { labels: ["wontfix"] }))
    await settle()
    expect(runs).toHaveLength(0)
    await deliver(gh, "issues", issueEvent("labeled", { labels: ["agent:coder"] }))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("a label applied by an AgentX account starts nothing even when a rule asks for labeled", async () => {
    const { gh, runs } = adapter()
    gh.setProjectRules(rules(`
project: ${REPO}
github:
  issues:
    actions: [opened, labeled]
`))
    await deliver(gh, "issues", issueEvent("labeled", { sender: AGENT_LOGIN, labels: ["agent:coder"] }))
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("ignoreOwnChanges: false keeps the old behaviour", async () => {
    const { gh, runs } = adapter({ ignoreOwnChanges: false, issueActions: ["assigned"] })
    await deliver(gh, "issues", issueEvent("assigned", { sender: AGENT_LOGIN }))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("an issue opened with the account AgentX posts with still counts", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", issueEvent("opened", { sender: AGENT_LOGIN }))
    await settle()
    expect(runs).toHaveLength(1)
  })

  it("a mesh peer's own label starts nothing", async () => {
    const { gh, runs } = adapter()
    gh.setPeerPostingLogins(() => ["peer-bot"])
    await deliver(gh, "issues", issueEvent("assigned", { sender: "peer-bot" }))
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("stop() drops a run still held for its window", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "issues", issueEvent("opened"))
    await gh.stop()
    await settle()
    expect(runs).toHaveLength(0)
  })
})

describe("GitHub pull request events (#612)", () => {
  it("a pull request opened and then labeled by an AgentX account starts one run", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "pull_request", prEvent("opened"))
    await deliver(gh, "pull_request", prEvent("labeled", { sender: AGENT_LOGIN }))
    await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toMatch(/^\[GitHub PR #9 opened\]/)
    expect(runs[0].channelMeta?.eventActions).toEqual(["opened"])
    expect(runs[0].channelMeta?.project).toBeTruthy()
  })

  it("closed does not start a run unless pullRequestActions lists it", async () => {
    const { gh, runs } = adapter()
    await deliver(gh, "pull_request", prEvent("closed"))
    await settle()
    expect(runs).toHaveLength(0)
    const asked = adapter({ pullRequestActions: ["closed"] })
    await deliver(asked.gh, "pull_request", prEvent("closed"))
    await settle()
    expect(asked.runs).toHaveLength(1)
  })
})
