import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ProjectRulesStore } from "../src/projects/rules"

let tmp: string
let store: ProjectRulesStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-rules-"))
})

afterEach(() => {
  store?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

function writeRule(relPath: string, body: string): void {
  const full = path.join(tmp, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, body, "utf-8")
}

describe("ProjectRulesStore", () => {
  it("loads YAML rules from nested dirs and looks up by project key", () => {
    writeRule("ksi/int.ksi.tn.yaml", `
project: ksi/int.ksi.tn
agent: coder-agent
runbook: /workspaces/ksi-v2
gitlab:
  issue:
    actions: [open, reopen]
    requireLabels: ["Triage"]
    excludeStates: [closed]
`)
    store = new ProjectRulesStore(tmp, () => {})
    const result = store.load()
    expect(result.count).toBe(1)
    expect(result.errors).toBe(0)
    const rule = store.find("ksi/int.ksi.tn")
    expect(rule).toBeDefined()
    expect(rule?.runbook).toBe("/workspaces/ksi-v2")
    expect(rule?.gitlab?.issue?.actions).toEqual(["open", "reopen"])
  })

  it("rejects an issue event whose action is not whitelisted", () => {
    writeRule("ksi/int.ksi.tn.yaml", `
project: ksi/int.ksi.tn
gitlab:
  issue:
    actions: [open, reopen]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabIssue("ksi/int.ksi.tn", { action: "update" }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("ksi/int.ksi.tn", { action: "open" }).allow).toBe(true)
  })

  it("rejects when requireLabels is unmet but allows when at least one matches", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  issue:
    requireLabels: ["Triage", "kind/bug"]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabIssue("acme/api", { labels: ["Doing"] }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("acme/api", { labels: ["Triage"] }).allow).toBe(true)
    expect(store.shouldFireGitlabIssue("acme/api", { labels: ["kind/bug", "Doing"] }).allow).toBe(true)
  })

  it("rejects when any excludeLabel is present", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  issue:
    excludeLabels: ["wontfix", "Done"]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabIssue("acme/api", { labels: ["wontfix"] }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("acme/api", { labels: ["bug"] }).allow).toBe(true)
  })

  it("rejects closed issues when state is excluded", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  issue:
    excludeStates: [closed]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabIssue("acme/api", { state: "closed" }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("acme/api", { state: "opened" }).allow).toBe(true)
  })

  it("rejects when author matches an excludeAuthors entry (substring)", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  issue:
    excludeAuthors: ["bot", "noqta-"]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabIssue("acme/api", { authorUsername: "noqta-coder" }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("acme/api", { authorUsername: "renovate-bot" }).allow).toBe(false)
    expect(store.shouldFireGitlabIssue("acme/api", { authorUsername: "anis" }).allow).toBe(true)
  })

  it("triggers: [auto] resolves any known agent mention without enumeration", () => {
    writeRule("mtgl/system-v2.yaml", `
project: mtgl/system-v2
gitlab:
  note:
    triggers:
      - auto
      - keyword: "merge and deploy"
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    const knownAgentMentions = ["@coding-mtgl-v2", "@pm-mtgl", "@devops-noqta"]

    // Mention a known agent — auto matches without manual enumeration.
    expect(store.shouldFireGitlabNote("mtgl/system-v2",
      { text: "@coding-mtgl-v2 what changed?" },
      { knownAgentMentions }).allow).toBe(true)

    // Keyword falls back to the explicit object trigger.
    expect(store.shouldFireGitlabNote("mtgl/system-v2",
      { text: "looks good, merge and deploy" },
      { knownAgentMentions }).allow).toBe(true)

    // Unknown @mention with no keyword — still rejected.
    expect(store.shouldFireGitlabNote("mtgl/system-v2",
      { text: "@random-user any update?" },
      { knownAgentMentions }).allow).toBe(false)
  })

  it("triggers: [auto] without knownAgentMentions falls through (no-op)", () => {
    writeRule("mtgl/system-v2.yaml", `
project: mtgl/system-v2
gitlab:
  note:
    triggers:
      - auto
      - keyword: "ship it"
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    // No knownAgentMentions supplied — auto entry can't match. Mention-only
    // text falls through to "no trigger matched" → reject.
    expect(store.shouldFireGitlabNote("mtgl/system-v2",
      { text: "@coding-mtgl-v2 hi" }).allow).toBe(false)
    // Keyword still works.
    expect(store.shouldFireGitlabNote("mtgl/system-v2",
      { text: "ship it now" }).allow).toBe(true)
  })

  it("triggers: [auto] is case-insensitive on the mention", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  note:
    triggers: [auto]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    const knownAgentMentions = ["@coder"]
    expect(store.shouldFireGitlabNote("acme/api",
      { text: "@CODER fix this" },
      { knownAgentMentions }).allow).toBe(true)
  })

  it("note rule requires a trigger to match (mention OR keyword)", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  note:
    onlyOn: [merge_request]
    triggers:
      - mention: "@coder"
      - keyword: "merge and deploy"
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabNote("acme/api", { noteableType: "merge_request", text: "looks good" }).allow).toBe(false)
    expect(store.shouldFireGitlabNote("acme/api", { noteableType: "merge_request", text: "@coder please" }).allow).toBe(true)
    expect(store.shouldFireGitlabNote("acme/api", { noteableType: "merge_request", text: "ready, MERGE AND DEPLOY now" }).allow).toBe(true)
    expect(store.shouldFireGitlabNote("acme/api", { noteableType: "issue", text: "@coder please" }).allow).toBe(false) // wrong noteableType
  })

  it("pipeline rule restricts to allowed statuses", () => {
    writeRule("acme/api.yaml", `
project: acme/api
gitlab:
  pipeline:
    actions: [failed]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGitlabPipeline("acme/api", { status: "success" }).allow).toBe(false)
    expect(store.shouldFireGitlabPipeline("acme/api", { status: "failed" }).allow).toBe(true)
  })

  it("github PR rule mirrors gitlab issue semantics", () => {
    writeRule("acme/api.yaml", `
project: acme/api
github:
  pull_request:
    actions: [opened, ready_for_review]
    excludeLabels: [draft]
`)
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    expect(store.shouldFireGithubPR("acme/api", { action: "synchronize" }).allow).toBe(false)
    expect(store.shouldFireGithubPR("acme/api", { action: "opened", labels: ["draft"] }).allow).toBe(false)
    expect(store.shouldFireGithubPR("acme/api", { action: "opened", labels: [] }).allow).toBe(true)
  })

  it("returns allow:true for projects that have no rule at all", () => {
    store = new ProjectRulesStore(tmp, () => {})
    store.load()
    // Empty store — every event must pass through (legacy behaviour).
    expect(store.shouldFireGitlabIssue("unconfigured/repo", { action: "close" }).allow).toBe(true)
    expect(store.shouldFireGithubIssue("unconfigured/repo", { action: "deleted" }).allow).toBe(true)
  })

  it("skips files with invalid project field and reports an error", () => {
    writeRule("bad.yaml", "project: not-a-path\n")  // missing slash
    writeRule("good/project.yaml", `
project: good/project
gitlab:
  issue:
    actions: [open]
`)
    const errors: string[] = []
    store = new ProjectRulesStore(tmp, (...args) => errors.push(args.join(" ")))
    const result = store.load()
    expect(result.count).toBe(1)
    expect(result.errors).toBe(1)
    expect(store.find("good/project")).toBeDefined()
    expect(store.find("not-a-path")).toBeUndefined()
  })
})
