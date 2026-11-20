import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2009 part 1, B1: the agent memory index reaches a start once, in the
// task text next to Claude Code's auto-memory block, on fresh starts only.
// It is no longer in the cached system prompt (it changes on every memory
// write) nor merged into the workspace CLAUDE.md. Every engine sees it:
// codex-cli and opencode do not read CLAUDE.md, and a task worktree reads
// the repo's CLAUDE.md, not the workspace's.

const calls = vi.hoisted(() => [] as Array<{ context: string; system: string; resume?: string; cwd?: string }>)
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any, _providers: any, _onDelta: any, historyContext: string, resumeSessionId?: string) => {
      calls.push({ context: historyContext ?? "", system: task.systemPromptAppend ?? "", resume: resumeSessionId, cwd: task.cwd })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"

const FACT = "unique_fact_2009"
let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-start-memory-"))
  process.chdir(dir)
  calls.length = 0
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(tier: "claude-code" | "codex-cli" | "opencode" = "claude-code"): AgentRegistry {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier, workspace: dir } },
  })
  const r = new AgentRegistry(config, () => {})
  r.agentMemory.save({ agentId: "ops", type: "project", name: FACT, description: "where the nightly report goes", body: "body" })
  return r
}

const run = (r: AgentRegistry) => r.execute({ message: "hello", agentId: "ops", context: { channel: "telegram", chatId: "chat-1" } })
const count = (s: string) => s.split(FACT).length - 1

describe("agent memory index at the start (#2009 B1)", () => {
  it("appears once per fresh start, in the task text, never in the system prompt", async () => {
    await run(registry())
    expect(calls).toHaveLength(1)
    expect(count(calls[0].context)).toBe(1)
    expect(calls[0].context).toContain(join(dir, ".agentx-memory.md"))
    expect(count(calls[0].system)).toBe(0)
  })

  it("is absent on a resumed session", async () => {
    const r = registry()
    ;(r as any).sessions.setClaudeSessionId("ops", "telegram", "chat-1", "sess-1")
    await run(r)
    expect(calls[0].resume).toBe("sess-1")
    expect(count(calls[0].context)).toBe(0)
    expect(count(calls[0].system)).toBe(0)
  })

  it("is present for codex-cli and opencode, which do not read CLAUDE.md", async () => {
    await run(registry("codex-cli"))
    await run(registry("opencode"))
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(count(c.context)).toBe(1)
      expect(count(c.system)).toBe(0)
    }
  })

  it("is present in a task-worktree run, which starts fresh in another folder", async () => {
    const wt = join(dir, "repo-worktree")
    mkdirSync(wt, { recursive: true })
    const r = registry()
    ;(r as any).sessions.setClaudeSessionId("ops", "telegram", "chat-1", "sess-1")
    ;(r as any).inTaskWorktree = async (def: any, task: any) => ({ def, task: { ...task, cwd: wt }, fresh: true })
    await run(r)
    expect(calls[0].cwd).toBe(wt)
    expect(calls[0].resume).toBeUndefined()
    expect(count(calls[0].context)).toBe(1)
    expect(count(calls[0].system)).toBe(0)
  })
})
