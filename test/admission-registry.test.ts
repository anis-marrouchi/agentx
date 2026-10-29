import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #1521 — every run passes the node admission queue before it takes its
// place: over the node's session cap it waits, unstarted, and starts once a
// running one ends. Runs hang in preparation so they stay "running".

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
const prevEnv = process.env.AGENTX_ADMISSION

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-admission-"))
  process.chdir(dir)
  hang.on = true
  delete process.env.AGENTX_ADMISSION
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env.AGENTX_ADMISSION
  else process.env.AGENTX_ADMISSION = prevEnv
})

function registry(admission: Record<string, unknown> = {}) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: {
      a: { name: "A", tier: "claude-code", workspace: dir, maxConcurrent: 1 },
      b: { name: "B", tier: "claude-code", workspace: dir, maxConcurrent: 1 },
    },
    // Resource checks off: the test machine's load must not decide this.
    admission: {
      maxSessions: 1, ownerExtraSessions: 0, minStartGapSeconds: 0, boot: { windowSeconds: 0 },
      minAvailableMemoryMB: 0, minAvailableMemoryPercent: 0, maxSwapUsedMB: 1e9, minDiskFreeMB: 0, maxLoadPerCpu: 0,
      ...admission,
    },
  })
  return new AgentRegistry(config, () => {})
}

function start(r: AgentRegistry, agentId: string, channel = "api", callerSignal?: AbortSignal) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  let didStart = false
  const run = r.execute({
    message: "report", agentId, context: { channel, chatId: `${channel}:${agentId}` },
    onStart: (id) => { didStart = true; onStart(id) }, callerSignal,
  })
  return { started, run, didStart: () => didStart }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

describe("node admission queue in the registry", () => {
  it("holds a run over the node cap and starts it when the running one ends", async () => {
    const r = registry()
    const first = start(r, "a")
    const firstId = await first.started
    const second = start(r, "b")
    await settle()
    expect(second.didStart()).toBe(false)
    const snap = r.admission.snapshot()
    expect(snap.running.map((x) => x.agentId)).toEqual(["a"])
    expect(snap.waiting.map((x) => x.agentId)).toEqual(["b"])
    expect(snap.waiting[0].blockedBy.join()).toMatch(/session cap: 1\/1/)
    // Waiting at the gate holds no agent slot and is not in flight.
    expect(r.getActiveTaskCount()).toBe(1)

    r.cancelRunningTask(firstId, "done")
    await first.run
    const secondId = await second.started
    expect(r.admission.snapshot().running.map((x) => x.agentId)).toEqual(["b"])
    r.cancelRunningTask(secondId, "done")
    await second.run
    expect(r.admission.snapshot().running).toEqual([])
  })

  it("a caller that leaves while waiting is not started", async () => {
    const r = registry()
    const first = start(r, "a")
    const firstId = await first.started
    const caller = new AbortController()
    const second = start(r, "b", "api", caller.signal)
    await settle()
    caller.abort(new Error("caller disconnected"))
    const res = await second.run
    expect(res.error).toMatch(/Caller gone/)
    expect(r.admission.snapshot().waiting).toEqual([])
    r.cancelRunningTask(firstId, "done")
    await first.run
    // The agent's own slot was given back too: it runs again.
    const again = start(r, "b")
    const againId = await again.started
    r.cancelRunningTask(againId, "done")
    await again.run
  })

  it("a run waiting at the gate does not hold its agent: the agent's next message waits with its own priority", async () => {
    const r = registry()
    const first = start(r, "a")
    const firstId = await first.started
    // b waits at the gate (node full); b's slot stays free, so a second
    // message to b reaches the gate too rather than b's local queue.
    const b1 = start(r, "b", "cron")
    const b2 = start(r, "b", "api")
    await settle()
    const waiting = r.admission.snapshot().waiting
    expect(waiting.map((w) => `${w.agentId}:${w.priority}`)).toEqual(["b:normal", "b:background"])
    r.cancelRunningTask(firstId, "done")
    await first.run
    const b2Id = await b2.started
    expect(b1.didStart()).toBe(false)
    r.cancelRunningTask(b2Id, "done")
    await b2.run
    const b1Id = await b1.started
    r.cancelRunningTask(b1Id, "done")
    await b1.run
  })

  it("on close, a waiting non-chat run is answered as interrupted", async () => {
    const r = registry()
    const first = start(r, "a")
    const firstId = await first.started
    const waiting = start(r, "b", "cron")
    await settle()
    expect(r.admission.close()).toEqual({ kept: 0, refused: 1 })
    const res = await waiting.run
    expect(res.errorKind).toBe("interrupted")
    expect(waiting.didStart()).toBe(false)
    r.cancelRunningTask(firstId, "done")
    await first.run
  })

  it("AGENTX_ADMISSION=off lets everything start", async () => {
    process.env.AGENTX_ADMISSION = "off"
    const r = registry()
    const first = start(r, "a"), second = start(r, "b")
    const ids = await Promise.all([first.started, second.started])
    for (const id of ids) r.cancelRunningTask(id, "done")
    await Promise.all([first.run, second.run])
  })
})
