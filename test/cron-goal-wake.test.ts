import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #863 review n158092 item 1: the goal check's owner wake must wait for a
// busy owner's slot. Queued, execute() returned at once and the card went
// up with "No recommendation" before the owner ever ran.

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
import { goalCheckWake } from "../src/crons/goal-wake"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-goal-wake-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry() {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })
  return new AgentRegistry(config, () => {})
}

/** A cron run that holds the owner's only slot until cancelled. */
async function busy(r: AgentRegistry) {
  let onStart!: (id: string) => void
  const started = new Promise<string>((res) => { onStart = res })
  const run = r.execute({ message: "busy", agentId: "ops", context: { channel: "cron", chatId: "cron:other" }, onStart })
  return { id: await started, run }
}

describe("the goal-check owner wake on a busy owner", () => {
  it("waits for the slot, then runs the owner's turn; it does not resolve while the owner is busy", async () => {
    const r = registry()
    const held = await busy(r)
    let onStart!: (id: string) => void
    const ownerStarted = new Promise<string>((res) => { onStart = res })
    let startedCount = 0
    const execute = r.execute.bind(r)
    const wake = goalCheckWake({
      getAgent: (id) => r.getAgent(id),
      execute: (task) => execute({ ...task, onStart: (id: string) => { startedCount++; onStart(id) } }),
    })
    let settled = false
    const p = wake("ops", "[Goal check] recommend", "cron-goal:j").then(() => { settled = true }, () => { settled = true })
    await new Promise((res) => setTimeout(res, 800))
    expect(settled).toBe(false)
    expect(startedCount).toBe(0)

    r.cancelRunningTask(held.id, "done")
    await held.run
    const ownerId = await ownerStarted
    expect(settled).toBe(false)
    r.cancelRunningTask(ownerId, "done")
    await p
    expect(startedCount).toBe(1)
  })

  it("still busy at the end of the window: rejects with the busy error, so the card goes up without a recommendation", async () => {
    const r = registry()
    const held = await busy(r)
    const wake = goalCheckWake(r, 600)
    await expect(wake("ops", "[Goal check] recommend", "cron-goal:j")).rejects.toThrow(/busy/)
    r.cancelRunningTask(held.id, "done")
    await held.run
  })

  it("an agent not on this node rejects", async () => {
    await expect(goalCheckWake(registry())("nobody", "x", "c")).rejects.toThrow(/not on this node/)
  })
})
