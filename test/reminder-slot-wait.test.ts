import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A reminder dispatched to a busy agent must wait for a slot, not be queued:
// the poller would read `__queued__` as a refusal and dispatch it again, and
// the queued answer would be re-routed to "reminder", which has no adapter.

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
  dir = mkdtempSync(join(tmpdir(), "agentx-reminder-slot-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function start(r: AgentRegistry, channel: string) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "ops", context: { channel, chatId: `${channel}:x` }, onStart })
  return { started, run }
}

describe("a reminder dispatched to a busy agent", () => {
  it("waits for the slot instead of being queued", async () => {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    })
    const r = new AgentRegistry(config, () => {})
    const busy = start(r, "cron")
    const busyId = await busy.started

    const reminder = start(r, "reminder")
    const early = await Promise.race([reminder.run, new Promise((res) => setTimeout(() => res("pending"), 700))])
    expect(early).toBe("pending")

    r.cancelRunningTask(busyId, "done")
    await busy.run
    const reminderId = await reminder.started
    r.cancelRunningTask(reminderId, "done")
    const res = await reminder.run
    expect(res.error ?? "").not.toMatch(/__queued__/)
  })
})
