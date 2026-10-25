import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A run cut at its time limit (#1261) gets one more turn on the session it
// wrote to; when that is cut too, or there is no session, the error says
// where the work is. Names and texts are invented.

const calls = vi.hoisted(() => ({ list: [] as Array<{ task: any; resume?: string }>, replies: [] as any[] }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_agent: any, task: any, _p: any, _d: any, _h: any, resume: string | undefined, onEvent?: (e: any) => void) => {
      calls.list.push({ task, resume })
      onEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } })
      return Promise.resolve(calls.replies.shift() ?? { content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { continueTask, cutRecord, cutSession, describeStep } from "../src/agents/timeout-continue"

const TIMEOUT = { content: "", error: "Claude Code timed out after 30m.", errorKind: "timeout", duration: 1 }

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-timeout-continue-"))
  process.chdir(dir)
  calls.list = []
  calls.replies = []
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(): AgentRegistry {
  return new AgentRegistry(daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { builder: { name: "Builder", tier: "claude-code", workspace: dir, maxExecutionMinutes: 30 } },
  }), () => {})
}

const run = (r: AgentRegistry) => r.execute({ message: "Build the release", agentId: "builder", context: { channel: "a2a", chatId: "lead", sender: "agent:lead" } })

describe("a run cut at its time limit", () => {
  it("gets one more turn on its session, and that turn's answer is the run's", async () => {
    calls.replies = [{ ...TIMEOUT, claudeSessionId: "sess-1" }, { content: "Release built.", duration: 1, claudeSessionId: "sess-2" }]
    const res = await run(registry())
    expect(res.error).toBeUndefined()
    expect(res.content).toBe("Release built.")
    expect(calls.list).toHaveLength(2)
    expect(calls.list[1].resume).toBe("sess-1")
    expect(calls.list[1].task.message).toContain("30-minute time limit")
    expect(calls.list[1].task.message).toContain("Bash: pnpm test")
  })

  it("is continued once only, and the error then says where the work is", async () => {
    calls.replies = [{ ...TIMEOUT, claudeSessionId: "sess-1" }, { ...TIMEOUT, claudeSessionId: "sess-1" }]
    const r = registry()
    const res = await run(r)
    expect(calls.list).toHaveLength(2)
    expect(res.errorKind).toBe("timeout")
    expect(res.error).toContain("One extra turn to finish it was cut too.")
    expect(res.error).toContain("sess-1")
    expect(res.error).toContain(`Work dir: ${dir}`)
    expect(res.error).toContain("Last step: Bash: pnpm test")
    // The chat keeps the session, so the next message continues the work.
    expect(r.getSessionStore().getClaudeSessionId("builder", "a2a", "lead")).toBe("sess-1")
  })

  it("is not continued without a session, and says so", async () => {
    calls.replies = [{ ...TIMEOUT }]
    const res = await run(registry())
    expect(calls.list).toHaveLength(1)
    expect(res.error).toContain("No session was kept.")
  })

  it("leaves other failures alone", async () => {
    calls.replies = [{ content: "", error: "boom", duration: 1, claudeSessionId: "sess-1" }]
    const res = await run(registry())
    expect(calls.list).toHaveLength(1)
    expect(res.error).toBe("boom")
  })
})

describe("timeout-continue helpers", () => {
  it("find the session only on a timeout", () => {
    expect(cutSession({ content: "", errorKind: "timeout", claudeSessionId: "a" } as any)).toBe("a")
    expect(cutSession({ content: "", errorKind: "timeout", codexSessionId: "c" } as any)).toBe("c")
    expect(cutSession({ content: "", errorKind: "interrupted", claudeSessionId: "a" } as any)).toBeNull()
  })

  it("describe a step briefly", () => {
    expect(describeStep("Read", { file_path: "/w/a.ts" })).toBe("Read: /w/a.ts")
    expect(describeStep("Think")).toBe("Think")
    expect(describeStep("Bash", { command: "x".repeat(400) }).length).toBe(160)
  })

  it("drop the chat context the session already holds", () => {
    const t = continueTask({ agentId: "a", message: "orig", freshSession: true, context: { channel: "a2a", conversationHistory: [{ role: "user", content: "x" }], mediaPath: "/m" } } as any, 20)
    expect(t.message).not.toContain("orig")
    expect(t.freshSession).toBeUndefined()
    expect(t.context).toEqual({ channel: "a2a" })
  })

  it("say where the work is", () => {
    expect(cutRecord({ sessionId: "s", workspace: "/w", lastStep: "Bash: ls", continued: false }))
      .toBe("Its session s keeps the work so far; the next message in this chat continues it. Work dir: /w. Last step: Bash: ls.")
  })
})
