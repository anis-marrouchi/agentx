import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A run could hang after "executing task" but before any agent process was
// spawned. Cancel only aborted a controller nothing was listening to, and
// the slot was released in a `finally` the hung run never reached — so the
// run sat in runningTasks until the daemon restarted (#124). What must hold:
//   - cancel ends a run stuck in a pre-spawn step and frees its slot;
//   - a task deadline (timeoutMinutes) does the same without an operator;
//   - the running entry names the step the run is in;
//   - a cancelled run starts no further step, even behind a swallowed error;
//   - a scheduled agent run always carries a deadline, recorded in its run file.

const hang = vi.hoisted(() => ({ on: false, skills: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

vi.mock("../src/agent/skills/loader", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    loadLocalSkills: (...args: any[]) => hang.skills ? new Promise(() => {}) : real.loadLocalSkills(...args),
  }
})
vi.mock("../src/workflows", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, matchWorkflow: () => ({ workflow: { id: "wf" }, confidence: 1, reasons: [] }) }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { untilAborted } from "../src/agents/until-aborted"
import { CronScheduler, AGENT_RUN_TIMEOUT_FLOOR, agentRunTimeout } from "../src/crons/scheduler"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-stuck-run-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  hang.skills = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(extra: Record<string, unknown> = {}): AgentRegistry {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    ...extra,
  })
  return new AgentRegistry(config, () => {})
}

const agentState = (r: AgentRegistry) => r.list().find((a) => a.id === "ops")!

/** Start a run; `started` resolves with its task id once it holds a slot. */
function startRun(r: AgentRegistry, extra: Record<string, unknown> = {}) {
  let onStart!: (taskId: string) => void
  const started = new Promise<string>((resolve) => { onStart = resolve })
  const run = r.execute({ message: "hello", agentId: "ops", context: { channel: "cron", chatId: "cron:x" }, onStart, ...extra })
  return { started, run }
}

describe("a run stuck before spawn", () => {
  it("is ended by cancel, and its slot and entry are released", async () => {
    const r = registry()
    const { started, run } = startRun(r)
    const id = await started
    expect(agentState(r).runningTasks.map((t) => t.id)).toEqual([id])
    await vi.waitFor(() => expect(agentState(r).runningTasks[0].step).toBe("request-gate"))

    expect(r.cancelRunningTask(id, "operator stop")).not.toBeNull()
    const res = await run
    expect(res.error).toMatch(/operator stop/)
    expect(agentState(r).runningTasks).toEqual([])
    expect(agentState(r).active).toBe(0)
    // The entry is gone, so a second cancel reports nothing to cancel.
    expect(r.cancelRunningTask(id)).toBeNull()
  })

  it("is ended by its deadline without an operator", async () => {
    const r = registry()
    const { started, run } = startRun(r, { timeoutMinutes: 0.001 })
    await started
    const res = await run
    expect(res.error).toMatch(/timed out/)
    expect(agentState(r).runningTasks).toEqual([])
    expect(agentState(r).active).toBe(0)
  })
})

describe("a cancelled run", () => {
  it("starts no further step, even after a step that swallows the abort", async () => {
    hang.on = false
    hang.skills = true
    const r = registry({ workflows: { enabled: true, matching: { enabled: true, mode: "auto" } } })
    const autoRun = vi.fn(async () => ({ runId: "r1" }))
    r.setWorkflowAutoRunner(autoRun as any)
    const { started, run } = startRun(r)
    const id = await started
    // "skills" catches every error and carries on, so the run walks on
    // toward workflow auto-run after the cancel lands here.
    await vi.waitFor(() => expect(agentState(r).runningTasks[0].step).toBe("skills"))

    r.cancelRunningTask(id, "operator stop")
    const res = await run
    expect(res.error).toMatch(/operator stop/)
    expect(autoRun).not.toHaveBeenCalled()
    expect(agentState(r).active).toBe(0)
  })
})

describe("untilAborted", () => {
  it("passes a settled result through", async () => {
    await expect(untilAborted(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7)
  })

  it("rejects with the abort reason when the work never settles", async () => {
    const ac = new AbortController()
    const p = untilAborted(new Promise(() => {}), ac.signal)
    ac.abort(new Error("stop"))
    await expect(p).rejects.toThrow("stop")
  })

  it("lets the work settle inside the grace", async () => {
    const ac = new AbortController()
    let finish!: (v: string) => void
    const p = untilAborted(new Promise<string>((res) => { finish = res }), ac.signal, 50)
    ac.abort(new Error("stop"))
    finish("reaped")
    await expect(p).resolves.toBe("reaped")
  })
})

describe("scheduled agent runs carry a deadline", () => {
  it("never goes below the floor, and a longer job timeout wins", () => {
    expect(agentRunTimeout(600)).toBe(AGENT_RUN_TIMEOUT_FLOOR)
    expect(agentRunTimeout(undefined)).toBe(AGENT_RUN_TIMEOUT_FLOOR)
    expect(agentRunTimeout(10_800)).toBe(10_800)
  })

  it("passes the deadline to the run and records it in the run file", async () => {
    const execute = vi.fn(async () => ({ content: "done", duration: 1 }))
    const s: any = new CronScheduler(
      { crons: { brief: { enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "ops", prompt: "p", timeout: 10_800, onError: ["log"] } }, agents: {}, notifications: {} } as any,
      { execute } as any,
    )
    s.scheduleNext = () => {}
    s.running = true
    const logged: any[] = []
    s.logRun = (r: any) => logged.push(r)
    await s.executeJob("brief")

    expect((execute.mock.calls[0] as any[])[0].timeoutMinutes).toBe(180)
    expect(logged[0].timeout).toBe(10_800)
  })
})
