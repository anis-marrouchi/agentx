import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #1258 — a queued /send/agent to a busy agent was refused after the 25 min
// slot wait meant for callers holding a request open, and the message was
// lost. The wait is now per task: a task that names a longer one keeps its
// place until a slot frees.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry, DEFAULT_SLOT_WAIT_MS } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-slot-wait-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function start(r: AgentRegistry, channel: string, slotWaitMs?: number) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  let didStart = false
  const run = r.execute({
    message: "report", agentId: "builder", context: { channel, chatId: `${channel}:x` },
    onStart: (id) => { didStart = true; onStart(id) }, ...(slotWaitMs !== undefined ? { slotWaitMs } : {}),
  })
  return { started, run, didStart: () => didStart }
}

describe("the slot wait of a caller that waits for a busy agent", () => {
  it("defaults to 25 minutes", () => {
    expect(DEFAULT_SLOT_WAIT_MS).toBe(25 * 60_000)
  })

  it("is refused past its own limit, while a longer one keeps its place and runs", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { builder: { name: "Builder", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    })
    const logs: string[] = []
    const r = new AgentRegistry(config, (m) => logs.push(m))
    const busy = start(r, "cron")
    const busyId = await busy.started

    const short = start(r, "a2a", 200)
    const long = start(r, "a2a", 60_000)
    const shortRes = await short.run
    expect(shortRes.error).toMatch(/slot wait timed out/)
    expect(short.didStart()).toBe(false)
    expect(long.didStart()).toBe(false)
    expect(logs.some((l) => /waiting for a slot \(up to 1m\)/.test(l))).toBe(true)

    r.cancelRunningTask(busyId, "done")
    await busy.run
    const id = await long.started
    r.cancelRunningTask(id, "done")
    const longRes = await long.run
    expect(longRes.error ?? "").not.toMatch(/slot wait timed out/)
  })
})
