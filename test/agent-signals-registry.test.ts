import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A stop signal (#857) ends a run as `stopped`: not a failure, not a cancel,
// not a restart interruption. The registry also tells the signal service
// what it needs to save and re-enter the run: its trace id, sender, root
// and origin.

const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args) }
})
vi.mock("../src/workflows", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, matchWorkflow: () => ({ workflow: { id: "wf" }, confidence: 1, reasons: [] }) }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { withRoot } from "../src/events/envelope"

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-signal-reg-"))
  process.chdir(dir)
  hang.on = true
})
afterEach(() => {
  hang.on = false
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(): AgentRegistry {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
  })
  return new AgentRegistry(config, () => {})
}

describe("a stop signal in the registry", () => {
  it("ends the run as stopped, with what resume needs", async () => {
    const r = registry()
    const completed: any[] = []
    const startedEvents: any[] = []
    const onDone = (p: any) => completed.push(p)
    const onStarted = (p: any) => startedEvents.push(p)
    getEventBus().on("task:completed", onDone)
    getEventBus().on("task:started", onStarted)
    try {
      let onStart!: (id: string) => void
      const started = new Promise<string>((res) => { onStart = res })
      const run = withRoot({ rootId: "root-x" }, () => r.execute({
        message: "Migrate the billing tables", agentId: "coder",
        context: { channel: "a2a", chatId: "lead", sender: "agent:lead" }, onStart,
      }))
      const id = await started
      // Stopped once its trace is open, so the completion must close it.
      await vi.waitFor(() => expect(startedEvents.some((p) => p.agentId === "coder")).toBe(true))

      const target = r.signalTarget({ taskId: id })
      expect(target).toMatchObject({ taskId: id, agentId: "coder", channel: "a2a", chatId: "lead", sender: "agent:lead", rootId: "root-x", originalMessage: "Migrate the billing tables" })
      expect(target?.origin).toMatchObject({ kind: "direct", context: { channel: "a2a", sender: "agent:lead" } })
      expect(target?.traceId).toBeTruthy()
      // By chat: the agent's only run there.
      expect(r.signalTarget({ agentId: "coder", channel: "a2a", chatId: "lead" })?.taskId).toBe(id)

      const ended = r.whenRunEnds(id, 10_000)
      expect(r.stopRunningTask(id, "stopped by owner: deploy")).toBe(true)
      // A second stop of the same run has nothing to stop.
      expect(r.stopRunningTask(id, "again")).toBe(false)
      const res = await run
      await ended
      expect(res.errorKind).toBe("stopped")
      expect(res.error).toBe("stopped by owner: deploy")
      expect(r.signalTarget({ taskId: id })).toBeNull()
      expect(completed.find((p) => p.agentId === "coder")).toMatchObject({ stopped: true })

      const days = readdirSync(join(dir, ".agentx/task-history/coder"))
      const file = readdirSync(join(dir, ".agentx/task-history/coder", days[0]))[0]
      const record = JSON.parse(readFileSync(join(dir, ".agentx/task-history/coder", days[0], file), "utf-8"))
      expect(record.status).toBe("stopped")
    } finally {
      getEventBus().off("task:completed", onDone)
      getEventBus().off("task:started", onStarted)
    }
  })

  it("marks a workflow step, so the service can refuse to pause it", async () => {
    const r = registry()
    let onStart!: (id: string) => void
    const started = new Promise<string>((res) => { onStart = res })
    const run = r.execute({ message: "step", agentId: "coder", workflowRunId: "wf-1", context: { channel: "workflow", chatId: "workflow:wf-1" }, onStart })
    const id = await started
    expect(r.signalTarget({ taskId: id })?.workflowRunId).toBe("wf-1")
    r.cancelRunningTask(id, "test over")
    await run
  })

  it("whenRunEnds resolves at once for a run that is not going", async () => {
    await expect(registry().whenRunEnds("nope", 60_000)).resolves.toBeUndefined()
  })
})

describe("a stopped run's trace", () => {
  it("is closed as stopped, lists its tool calls, and is not resumed on boot", async () => {
    const { openDb, closeDb } = await import("../src/storage/sqlite")
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getTrace, recordTraceStep, takeInterruptedRuns, traceToolCalls } = await import("../src/storage/traces")
    closeDb()
    const db = openDb({ path: join(dir, "db.sqlite") })!
    const detach = attachSqliteSubscribers(db)
    try {
      const bus = getEventBus()
      const at = new Date().toISOString()
      bus.emit("task:started", { agentId: "coder", channel: "a2a", chatId: "lead", messagePreview: "x", at, taskId: "T1" } as any)
      recordTraceStep(db, "T1", { name: "tool_use", action: "Bash", inputSummary: "psql -c 'alter table invoices'" })
      bus.emit("task:completed", { taskId: "T1", agentId: "coder", channel: "a2a", chatId: "lead", durationMs: 5, error: "stopped by owner", errorKind: "stopped", stopped: true, at } as any)
      expect(getTrace(db, "T1")!.task.status).toBe("stopped")
      expect(traceToolCalls(db, "T1")).toEqual([{ action: "Bash", inputSummary: "psql -c 'alter table invoices'" }])
      expect(takeInterruptedRuns(db).map((r) => r.taskId)).not.toContain("T1")
    } finally {
      detach()
      closeDb()
    }
  })
})
