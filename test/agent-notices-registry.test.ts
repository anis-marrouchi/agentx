import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Notices survive a daemon restart (#2121): they are on disk, and a run
// waiting for its slot does not take them until it starts.

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
  dir = mkdtempSync(join(tmpdir(), "agentx-notices-registry-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function config() {
  return daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })
}

function start(r: AgentRegistry, channel: string, message = "hello") {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message, agentId: "ops", context: { channel, chatId: `${channel}:x` }, onStart })
  return { started, run }
}

describe("notices across a daemon restart (#2121)", () => {
  it("a notice sent before a restart waits in the workspace for the next registry", () => {
    const logs: string[] = []
    const a = new AgentRegistry(config(), () => {})
    a.notices.add("ops", "devops", "Mac on battery.")
    expect(existsSync(join(dir, ".agentx", "notices.json"))).toBe(true)
    const b = new AgentRegistry(config(), (...m: unknown[]) => logs.push(m.join(" ")))
    expect(b.notices.count("ops")).toBe(1)
    expect(logs.some((l) => l.includes("[notices] 1 notice(s) kept from before the restart"))).toBe(true)
  })

  it("a run waiting for its slot leaves the notices on disk until it starts", async () => {
    const r = new AgentRegistry(config(), () => {})
    const busy = start(r, "cron")
    const busyId = await busy.started
    r.notices.add("ops", "devops", "Mac on battery.")

    const waiting = start(r, "a2a")
    const early = await Promise.race([waiting.run, new Promise((res) => setTimeout(() => res("pending"), 700))])
    expect(early).toBe("pending")
    expect(r.notices.count("ops")).toBe(1)
    expect(new AgentRegistry(config(), () => {}).notices.count("ops")).toBe(1)

    r.cancelRunningTask(busyId, "done")
    await busy.run
    const waitingId = await waiting.started
    expect(r.notices.count("ops")).toBe(0)
    r.cancelRunningTask(waitingId, "done")
    await waiting.run
  })

  it("a person's chat never takes them", async () => {
    const r = new AgentRegistry(config(), () => {})
    r.notices.add("ops", "devops", "x")
    const chat = start(r, "telegram")
    const id = await chat.started
    expect(r.notices.count("ops")).toBe(1)
    r.cancelRunningTask(id, "done")
    await chat.run
  })
})
