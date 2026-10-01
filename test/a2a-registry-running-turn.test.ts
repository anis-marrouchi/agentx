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
import { cycleRefusal, SyncWaits } from "../src/daemon/delegation-wiring"
import { warmProcessChat } from "../src/agents/runtime"
import { persistentCallerEnv } from "../src/agents/claude-process-factory"
import { callerHeaders } from "../src/calls/service"

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
    // Named by neither: no guess.
    expect(r.findRunningTurn("front")).toBeNull()
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

  // A warm process cannot name its task: the id changes every turn. It
  // names the pair it was started with, so a run with no chat has to be
  // found by that same pair (#410).
  it("finds a run with no chat by the pair its warm process sends", async () => {
    const r = new AgentRegistry(config(), () => {})
    for (const ctx of [{}, { channel: "api" }, { channel: "api", sender: "curl" }, { channel: "gitlab", group: "g/p#1", sender: "sam" }]) {
      const t = start(r, "front", ctx)
      const id = await t.started
      const proof = warmProcessChat(ctx)
      expect(callerHeaders(persistentCallerEnv({}, { agentId: "front", ...proof })))
        .toEqual({ "X-AgentX-Channel": proof.channel, "X-AgentX-Chat": proof.chatId })
      expect(r.findRunningTurn("front", proof)?.taskId).toBe(id)
      // Another channel or chat names nothing.
      expect(r.findRunningTurn("front", { channel: "telegram", chatId: proof.chatId })).toBeNull()
      expect(r.findRunningTurn("front", { channel: proof.channel, chatId: "other" })).toBeNull()
      r.cancelRunningTask(id, "done")
      await t.run
      expect(r.findRunningTurn("front", proof)).toBeNull()
    }
  })

  it("names no run when two runs share the warm process's pair", async () => {
    const r = new AgentRegistry(config(), () => {})
    const a = start(r, "front", {})
    const b = start(r, "front", { channel: "api" })
    const [aId, bId] = [await a.started, await b.started]
    expect(r.findRunningTurn("front", warmProcessChat({}))).toBeNull()
    expect(r.findRunningTurn("front", { taskId: aId })?.taskId).toBe(aId)
    r.cancelRunningTask(aId, "done")
    r.cancelRunningTask(bId, "done")
    await Promise.all([a.run, b.run])
  })

  it("refuses A -> B -> A at once when A's only slot is the turn waiting on B", async () => {
    const r = new AgentRegistry(config(), () => {})
    const waits = new SyncWaits()
    // worker (one slot) is mid-turn, synchronously waiting on front's run.
    const w = start(r, "worker", { channel: "cron", chatId: "daily" })
    const wId = await w.started
    const f = start(r, "front", { channel: "a2a", chatId: "a2a:worker:front:1", sender: "agent:worker" })
    const fId = await f.started
    waits.begin(wId, fId)

    // front now asks worker back: it could never start.
    const caller = { agentId: "front", taskId: fId, context: {} }
    expect(cycleRefusal("worker", { meshForwarded: false }, caller, r, waits)).toMatch(/waiting on this request/)
    // front has a free slot, so worker asking front again is only a wait.
    expect(cycleRefusal("front", { meshForwarded: false }, { agentId: "worker", taskId: wId, context: {} }, r, waits)).toBeNull()

    r.cancelRunningTask(wId, "done")
    r.cancelRunningTask(fId, "done")
    await Promise.all([w.run, f.run])
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
