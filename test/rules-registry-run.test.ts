import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// noqta#809: a run gets the Rules Registry rows that fit it, behind
// `rules.enabled`. Checked through a real AgentRegistry with the runtime
// mocked, as event-digest-session.test.ts does.

const calls = vi.hoisted(() => [] as Array<{ context: string; resume?: string }>)
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, _task: any, _providers: any, _onDelta: any, historyContext: string, resumeSessionId?: string) => {
      calls.push({ context: historyContext ?? "", resume: resumeSessionId })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { WorkflowStore } from "../src/workflows"

const FIXTURE = join(__dirname, "fixtures", "rules-registry-page.md")
const HEADER = "[Rules for this run — from the Rules Registry]"
let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-rules-"))
  process.chdir(dir)
  calls.length = 0
  // The page, where `rules.registryAgent` / `rules.registryPage` say.
  const pageDir = join(dir, ".agentx/wiki/agents/pm-agent/graph/decisions")
  mkdirSync(pageDir, { recursive: true })
  const page = readFileSync(FIXTURE, "utf-8").replace("last_updated: 2026-11-20", `last_updated: ${new Date().toISOString().slice(0, 10)}`)
  writeFileSync(join(pageDir, "rules-registry.md"), page)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(rules: Record<string, unknown> = { enabled: true }, crons: Record<string, unknown> = {}): AgentRegistry {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "mac", name: "MacBook-Local" },
    rules,
    crons,
    agents: {
      "marketing-agent": { name: "Nadia", tier: "claude-code", workspace: dir },
      "pm-agent": { name: "Hakim", tier: "claude-code", workspace: dir },
      "coder": { name: "Coder", tier: "codex-cli", workspace: dir },
    },
  })
  return new AgentRegistry(config, () => {})
}

const exec = (r: AgentRegistry, agentId: string, chatId = "c1", extra: Record<string, unknown> = {}) =>
  r.execute({ message: "hello", agentId, context: { channel: "api", chatId }, ...extra } as any)

describe("rules block per run", () => {
  it("is off by default: no block, and the page stays in the owner decisions", async () => {
    await exec(registry({}), "pm-agent")
    expect(calls[0].context).not.toContain(HEADER)
    expect(calls[0].context).toContain("### Rules Registry")
  })

  it("on: the run gets its rules, and the page leaves the owner decisions (pm-agent included)", async () => {
    await exec(registry(), "pm-agent")
    expect(calls[0].context).toContain(HEADER)
    expect(calls[0].context).toContain("- R4: ")
    expect(calls[0].context).toContain("- the-owner-s-word-comes-first: ")
    expect(calls[0].context).not.toContain("- R1: ")
    expect(calls[0].context).not.toContain("### Rules Registry")
  })

  it("a Codex run gets the block too", async () => {
    await exec(registry(), "coder")
    expect(calls[0].context).toContain(HEADER)
    expect(calls[0].context).toContain("- clean-up-before-reporting-done: ")
  })

  it("a resumed session gets it again only when the block changed", async () => {
    const r = registry()
    await exec(r, "pm-agent")
    expect(calls[0].context).toContain(HEADER)
    ;(r as any).sessions.setClaudeSessionId("pm-agent", "api", "c1", "sess-1")
    await exec(r, "pm-agent")
    expect(calls[1].resume).toBe("sess-1")
    expect(calls[1].context).not.toContain(HEADER)
    // The page drops R4: the resumed session is told the new list.
    const p = join(dir, ".agentx/wiki/agents/pm-agent/graph/decisions/rules-registry.md")
    writeFileSync(p, readFileSync(p, "utf-8").split("\n").filter((l) => !l.includes("**R4**")).join("\n"))
    await exec(r, "pm-agent")
    expect(calls[2].resume).toBe("sess-1")
    expect(calls[2].context).toContain(HEADER)
    expect(calls[2].context).not.toContain("- R4: ")
  })

  it("a schedule run reads its job's cron: R8 on pm-agent's weekly job", async () => {
    const r = registry({ enabled: true }, {
      "pm-weekly": { schedule: "0 8 * * 1", agent: "pm-agent", prompt: "score" },
    })
    await r.execute({ message: "score", agentId: "pm-agent", context: { channel: "cron", chatId: "cron:pm-weekly" } } as any)
    expect(calls[0].context).toContain("- R8: ")
  })

  it("a workflow node run reads the workflow's own trigger.cron (R3 daily, R8 weekly)", async () => {
    const spec = { value: "0 6 * * *" }
    vi.spyOn(WorkflowStore.prototype, "get").mockImplementation(() => ({
      id: "wf", nodes: [{ id: "t", type: "trigger.cron", config: { spec: spec.value } }],
    }) as any)
    const r = registry()
    ;(r as any).workflowRuns = { get: (id: string) => (id === "run-1" ? { id, workflowId: "wf" } : null) }

    await exec(r, "marketing-agent", "workflow:run-1", { workflowRunId: "run-1" })
    expect(calls[0].context).toContain("- R3: ")
    expect(calls[0].context).not.toContain("- R8: ")

    spec.value = "0 8 * * 1"
    await exec(r, "pm-agent", "workflow:run-1b", { workflowRunId: "run-1" })
    expect(calls[1].context).toContain("- R8: ")
    expect(calls[1].context).not.toContain("- R3: ")

    // The same agents outside a scheduled workflow: neither.
    await exec(r, "marketing-agent", "c9")
    expect(calls[2].context).not.toContain("- R3: ")
  })

  it("with decision approvals required, an unapproved page sends nothing", async () => {
    await exec(registry({ enabled: true }), "pm-agent")
    expect(calls[0].context).toContain(HEADER)
    const config = daemonConfigSchema.parse({
      jobState: { enabled: false }, node: { id: "mac", name: "MacBook-Local" },
      rules: { enabled: true }, wiki: { decisionApprovals: { required: true } },
      agents: { "pm-agent": { name: "Hakim", tier: "claude-code", workspace: dir } },
    })
    await new AgentRegistry(config, () => {}).execute({ message: "hi", agentId: "pm-agent", context: { channel: "api", chatId: "c2" } } as any)
    expect(calls[1].context).not.toContain(HEADER)
  })
})

