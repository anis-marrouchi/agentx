import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The registry side of A2A callbacks (#277): a delegation names its
// caller's running turn, and the callback waits for that chat to be free.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-a2a-turn-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const config = () => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: {
    front: { name: "Front", tier: "claude-code", workspace: dir, maxConcurrent: 2 },
    worker: { name: "Worker", tier: "claude-code", workspace: dir, maxConcurrent: 1 },
  },
})

function start(r: AgentRegistry, agentId: string, context: Record<string, unknown>) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId, context: context as any, onStart })
  return { started, run }
}

const pending = (ms = 500) => new Promise((res) => setTimeout(() => res("pending"), ms))

describe("finding the caller's running turn", () => {
  it("returns the context the turn started with, by task id or by chat", async () => {
    const r = new AgentRegistry(config(), () => {})
    const ctx = { channel: "telegram", chatId: "chat-1", sender: "Sam" }
    const t = start(r, "front", ctx)
    const id = await t.started

    expect(r.findRunningTurn("front", { taskId: id })).toEqual({ taskId: id, context: ctx })
    expect(r.findRunningTurn("front", { channel: "telegram", chatId: "chat-1" })?.taskId).toBe(id)
    expect(r.findRunningTurn("front")?.taskId).toBe(id)
    expect(r.findRunningTurn("front", { taskId: "nope" })).toBeNull()
    expect(r.isChatBusy("front", "telegram", "chat-1")).toBe(true)

    // A second turn makes "the only running turn" ambiguous.
    const t2 = start(r, "front", { channel: "telegram", chatId: "chat-2", sender: "Kim" })
    const id2 = await t2.started
    expect(r.findRunningTurn("front")).toBeNull()

    r.cancelRunningTask(id, "done")
    r.cancelRunningTask(id2, "done")
    await Promise.all([t.run, t2.run])
    expect(r.findRunningTurn("front", { taskId: id })).toBeNull()
    expect(r.isChatBusy("front", "telegram", "chat-1")).toBe(false)
  })

  it("makes a busy callee's a2a run wait for a slot instead of queueing it", async () => {
    const r = new AgentRegistry(config(), () => {})
    const first = start(r, "worker", { channel: "cron", chatId: "daily" })
    const firstId = await first.started

    const delegated = start(r, "worker", { channel: "a2a", chatId: "a2a:front:worker:1", sender: "agent:front" })
    expect(await Promise.race([delegated.run, delegated.started, pending()])).toBe("pending")

    r.cancelRunningTask(firstId, "done")
    await first.run
    const id = await delegated.started
    r.cancelRunningTask(id, "done")
    expect((await delegated.run).error ?? "").not.toMatch(/__queued__/)
  })
})
