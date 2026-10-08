import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #822 — a /task caller that times out while the agent is busy must not leave
// its request waiting for the slot. A script retrying with `curl -m 30` had
// all 12 attempts run, one after another, once the slot freed.

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
  dir = mkdtempSync(join(tmpdir(), "agentx-caller-gone-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function start(r: AgentRegistry, channel: string, callerSignal?: AbortSignal) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  let didStart = false
  const run = r.execute({
    message: "report", agentId: "secretary", context: { channel, chatId: `${channel}:x` },
    onStart: (id) => { didStart = true; onStart(id) }, callerSignal,
  })
  return { started, run, didStart: () => didStart }
}

describe("a /task caller that leaves while the agent is busy", () => {
  it("drops its waiting request instead of running it when the slot frees", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { secretary: { name: "Secretary", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    })
    const r = new AgentRegistry(config, () => {})
    const busy = start(r, "cron")
    const busyId = await busy.started

    const attempts = [new AbortController(), new AbortController(), new AbortController()]
    const waiting = attempts.map((c) => start(r, "api", c.signal))
    // Every attempt times out on the caller's side while the slot is held.
    for (const c of attempts) c.abort(new Error("caller disconnected"))
    const results = await Promise.all(waiting.map((w) => w.run))

    for (const res of results) expect(res.error).toMatch(/Caller gone/)
    expect(waiting.some((w) => w.didStart())).toBe(false)

    r.cancelRunningTask(busyId, "done")
    await busy.run
  })

  it("still runs a waiting request whose caller is still there", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { secretary: { name: "Secretary", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    })
    const r = new AgentRegistry(config, () => {})
    const busy = start(r, "cron")
    const busyId = await busy.started

    const caller = new AbortController()
    const waiting = start(r, "api", caller.signal)
    r.cancelRunningTask(busyId, "done")
    await busy.run
    const id = await waiting.started
    r.cancelRunningTask(id, "done")
    const res = await waiting.run
    expect(res.error ?? "").not.toMatch(/Caller gone/)
  })
})
