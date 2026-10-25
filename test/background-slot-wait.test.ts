import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #1262 — a queued /send/agent or a delegation that calls back has no HTTP
// caller waiting on it. A busy agent used to drop such a message after the
// 25 min slot wait, and the sender had to notice and send it again. It now
// keeps waiting until a slot frees.

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
const realNow = Date.now.bind(Date)
let skew = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-background-slot-"))
  process.chdir(dir)
  hang.on = true
  skew = 0
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew)
})
afterEach(() => {
  vi.restoreAllMocks()
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(logs: string[] = []) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })
  return new AgentRegistry(config, (m: string) => { logs.push(m) })
}

function start(r: AgentRegistry, channel: string, extra: { background?: boolean; callerSignal?: AbortSignal } = {}) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "ops", context: { channel, chatId: `${channel}:x` }, onStart, ...extra })
  return { started, run }
}

const pending = (p: Promise<unknown>) => Promise.race([p, new Promise((res) => setTimeout(() => res("pending"), 1200))])

describe("a background message to a busy agent", () => {
  it("still fails a waiting caller's run after 25 minutes", async () => {
    const r = registry()
    const busy = start(r, "cron")
    const busyId = await busy.started

    const waiting = start(r, "a2a")
    skew = 26 * 60_000
    const res: any = await waiting.run
    expect(res.error).toMatch(/slot wait timed out after 25m/)

    r.cancelRunningTask(busyId, "done")
    await busy.run
  })

  it("keeps waiting past 25 minutes and runs once the slot frees", async () => {
    const logs: string[] = []
    const r = registry(logs)
    const busy = start(r, "cron")
    const busyId = await busy.started

    const waiting = start(r, "a2a", { background: true })
    skew = 26 * 60_000
    expect(await pending(waiting.run)).toBe("pending")
    expect(logs.some((l) => l.includes("still busy — background message waiting for a slot for 26m"))).toBe(true)

    r.cancelRunningTask(busyId, "done")
    await busy.run
    const id = await waiting.started
    r.cancelRunningTask(id, "done")
    const res = await waiting.run
    expect(res.error ?? "").not.toMatch(/slot wait timed out/)
  })

  it("is dropped, not started, when its signal fires while it waits", async () => {
    const r = registry()
    const busy = start(r, "cron")
    const busyId = await busy.started

    const ended = new AbortController()
    let didStart = false
    const waiting = r.execute({
      message: "hello", agentId: "ops", context: { channel: "a2a", chatId: "a2a:x" },
      background: true, callerSignal: ended.signal, onStart: () => { didStart = true },
    })
    ended.abort(new Error("delegation ended"))
    const res = await waiting
    expect(res.error).toMatch(/not started/)
    expect(didStart).toBe(false)

    r.cancelRunningTask(busyId, "done")
    await busy.run
  })

  it("gives up only after the long background limit", async () => {
    const r = registry()
    const busy = start(r, "cron")
    const busyId = await busy.started

    const waiting = start(r, "a2a", { background: true })
    skew = 13 * 60 * 60_000
    const res: any = await waiting.run
    expect(res.error).toMatch(/slot wait timed out after 12h/)

    r.cancelRunningTask(busyId, "done")
    await busy.run
  })
})
