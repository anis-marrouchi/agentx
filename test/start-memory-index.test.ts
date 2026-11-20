import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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

// A home folder of the test's own for Claude Code's auto-memory, so no real
// ~/.claude file is read or written.
const fakeHome = vi.hoisted(() => ({ path: "" }))
vi.mock("../src/agents/claude-md-chain", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    withClaudeMdFiles: (task: any, ws: any, sources: any, _home: any, ...rest: any[]) =>
      real.withClaudeMdFiles(task, ws, sources, fakeHome.path || undefined, ...rest),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { autoMemoryPath } from "../src/agents/claude-md-chain"
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
  fakeHome.path = ""
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

// Review of PR #2035, item 1: Claude Code's auto-memory MEMORY.md lists its
// newest notes last, and many are 15-21k characters. A top-kept cap hid
// them, so only the agent memory index is capped by default; auto-memory
// keeps Claude Code's own 200-line rule until #2002 step 4's hand trim.
describe("auto-memory at the start (review item 1)", () => {
  it("a large auto-memory index is rendered whole by default", async () => {
    fakeHome.path = join(dir, "home")
    const file = autoMemoryPath(dir, fakeHome.path)
    mkdirSync(join(file, ".."), { recursive: true })
    const lines = Array.from({ length: 150 }, (_, i) => `- [Note ${i + 1}](note_${i + 1}.md) — what the agent learned about topic ${i + 1}, with some detail`)
    writeFileSync(file, lines.join("\n") + "\n")
    expect(lines.join("\n").length).toBeGreaterThan(12_000)
    await run(registry())
    expect(calls[0].context).toContain("- [Note 1](note_1.md)")
    expect(calls[0].context).toContain("- [Note 150](note_150.md)")
    expect(calls[0].context).not.toContain("more notes not shown here")
  })
})
