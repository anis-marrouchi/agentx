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
// When set, stands in for the agent process: settles after `agentMs`.
// `until` (epoch ms), when set, overrides it with an absolute end time.
const spawn = vi.hoisted(() => ({ agentMs: 0, until: 0, calls: 0, reapOnAbort: false }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (...args: any[]) => {
      if (!spawn.agentMs) return real.executeTask(...args)
      spawn.calls++
      const ms = spawn.until ? Math.max(0, spawn.until - Date.now()) : spawn.agentMs
      // Like the real runtime: an abort reaps the process and the run
      // returns at once, reading the kill however it reads it.
      const signal: AbortSignal | undefined = args[7]
      return new Promise((res) => {
        const t = setTimeout(() => res({ content: "done", duration: 1 }), ms)
        if (spawn.reapOnAbort) signal?.addEventListener("abort", () => {
          clearTimeout(t)
          res({ content: "", error: "Claude Code timed out after 90m.", errorKind: "timeout", duration: 1 })
        }, { once: true })
      })
    },
  }
})
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
import { getEventBus } from "../src/events/bus"
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

  it("is ended by cancelling its chat, which leaves other chats alone", async () => {
    const r = registry()
    const { started, run } = startRun(r, { context: { channel: "app", chatId: "app:c1" } })
    await started
    expect(r.cancelChatTasks("ops", "app", "app:c2", "client-interrupt")).toBe(0)
    expect(r.cancelChatTasks("other", "app", "app:c1", "client-interrupt")).toBe(0)
    expect(r.cancelChatTasks("ops", "app", "app:c1", "client-interrupt")).toBe(1)
    expect((await run).error).toMatch(/client-interrupt/)
    expect(agentState(r).runningTasks).toEqual([])
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

describe("a run a daemon shutdown cuts off (#297)", () => {
  const REASON = "killed by daemon restart (drain limit 300s)"

  it("reports the restart, not a timeout, and stays open for resume", async () => {
    spawn.agentMs = 60_000
    spawn.reapOnAbort = true
    hang.on = false
    const completed: any[] = []
    const onCompleted = (p: any) => { completed.push(p) }
    getEventBus().on("task:completed", onCompleted)
    try {
      const r = registry()
      const { started, run } = startRun(r)
      await started
      await vi.waitFor(() => expect(agentState(r).runningTasks[0]?.step).toBe("agent"))
      expect(r.runningAgentDrainSeconds()).toEqual([undefined])

      expect(r.interruptRunning(REASON)).toBe(1)
      const res = await run
      expect(res.errorKind).toBe("interrupted")
      expect(res.error).toBe(REASON)
      // The trace subscriber leaves an interrupted run in flight for resume.
      expect(completed.at(-1)).toMatchObject({ agentId: "ops", interrupted: true })
      expect(agentState(r).active).toBe(0)
    } finally {
      getEventBus().off("task:completed", onCompleted)
      spawn.agentMs = 0
      spawn.reapOnAbort = false
    }
  })

  it("reports the restart when it is cut off before spawn", async () => {
    const r = registry()
    const { started, run } = startRun(r)
    await started
    await vi.waitFor(() => expect(agentState(r).runningTasks[0].step).toBe("request-gate"))
    r.interruptRunning(REASON)
    const res = await run
    expect(res.errorKind).toBe("interrupted")
    expect(res.error).toBe(REASON)
  })
})

describe("the pre-spawn deadline (#183)", () => {
  /** A registry whose agent allows `sec` seconds before spawn. The schema
   *  floor is 10 s; tests set the definition directly to stay fast. */
  function withPreSpawn(sec: number, logs: string[] = []): AgentRegistry {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
    })
    const r = new AgentRegistry(config, (...a: unknown[]) => logs.push(a.join(" ")))
    ;(r as any).agents.get("ops").def.preSpawnTimeoutSec = sec
    return r
  }

  it("defaults to 300 s for every agent", () => {
    const config = daemonConfigSchema.parse({ node: { id: "t", name: "t" }, agents: { ops: { name: "Ops", workspace: dir } } })
    expect(config.agents.ops.preSpawnTimeoutSec).toBe(300)
  })

  it("ends an event-driven run stuck before spawn, frees its slot and records timeout with the step", async () => {
    const logs: string[] = []
    const r = withPreSpawn(0.05, logs)
    let onStart!: (taskId: string) => void
    const started = new Promise<string>((resolve) => { onStart = resolve })
    // A GitHub webhook run: no timeoutMinutes, nothing else would end it.
    const run = r.execute({ message: "[GitHub PR #1 assigned]", agentId: "ops", context: { channel: "github", chatId: "o/r:pull:1" }, onStart })
    const id = await started
    const res = await run

    // The run is tried once more (#340); the second stall is reported in
    // plain words that still name the step, never the internal error.
    expect(res.error).toMatch(/couldn't get started.*step "request-gate".*send it again/)
    expect(res.errorKind).toBe("interrupted")
    expect(logs.some((l) => /timed out before spawn after 0s in step "request-gate"; retrying the run once/.test(l))).toBe(true)
    expect(agentState(r).runningTasks).toEqual([])
    expect(agentState(r).active).toBe(0)
    expect(r.cancelRunningTask(id)).toBeNull()
    const record = r.getTaskRecord("ops", id)!
    expect(record.status).toBe("timeout")
    expect(record.step).toBe("request-gate")

    // Trace lines carry the run id, chat and an ISO timestamp.
    const iso = /at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/
    const exec = logs.find((l) => l.includes("executing task"))!
    expect(exec).toContain(`task=${id}`)
    expect(exec).toContain("chat=github:o/r:pull:1")
    expect(exec).toMatch(iso)
    const stepLine = logs.find((l) => l.includes("step request-gate"))!
    expect(stepLine).toContain(`task=${id}`)
    expect(stepLine).toMatch(iso)
  })

  it("is cleared once the agent is spawned", async () => {
    hang.on = false
    spawn.agentMs = 1
    spawn.calls = 0
    // Generous deadline so a loaded machine still spawns in time; the agent
    // then runs on past the point where the deadline would have fired.
    const r = withPreSpawn(2)
    try {
      const { started, run } = startRun(r)
      const id = await started
      spawn.until = Date.now() + 2_500
      const res = await run
      expect(spawn.calls).toBe(1)
      expect(res.error).toBeUndefined()
      expect(res.content).toBe("done")
      expect(r.getTaskRecord("ops", id)!.status).toBeUndefined()
      expect(agentState(r).active).toBe(0)
    } finally {
      spawn.agentMs = 0
      spawn.until = 0
    }
  }, 10_000)
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
