// #876: workflow runs stuck after a daemon stop or an old child failure.
// A: a parent waits on a child that ended before resumeParent existed.
// B: a run left `running` with steps pending when the daemon stopped.
// C: `workflow resume` only set status=running, so nothing moved.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { rmSync } from "fs"
import { resolve } from "path"
import {
  RunStore,
  WorkflowStore,
  WorkflowDispatcher,
  idempotencyKey,
  workflowSchema,
  type AgentExecuteResponse,
} from "../src/workflows"
import { TimerService } from "../src/workflows/timers"

const TEST_DIR = resolve(__dirname, "../.test-workflow-stuck-runs-876")

const childWf = () => workflowSchema.parse({
  id: "child-two", version: 2, title: "child two", priority: 0, fanOut: false,
  envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
  nodes: [
    { id: "trigger", type: "trigger.manual", config: {} },
    { id: "wait",    type: "signal.wait", config: { name: "never" } },
    { id: "notify",  type: "action.send", config: { channel: "fake", chatId: "c", text: "child sent" } },
    { id: "done",    type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "wait" },
    { from: "wait", to: "notify" },
    { from: "notify", to: "done" },
  ],
})

const parentWf = () => workflowSchema.parse({
  id: "parent-876", version: 2, title: "parent", priority: 0, fanOut: false,
  envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
  nodes: [
    { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
    { id: "call",    type: "subProcess", config: { workflowId: "child-two", awaitCompletion: true } },
    { id: "finish",  type: "action.send", config: { channel: "fake", chatId: "c", text: "child ok" } },
    { id: "alert",   type: "action.send", config: { channel: "fake", chatId: "c", text: "child {{call.status}}" } },
    { id: "done",    type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "call" },
    { from: "call", to: "finish" },
    { from: "call", fromPort: "error", to: "alert" },
    { from: "finish", to: "done" },
    { from: "alert", to: "done" },
  ],
})

/** One daemon "boot" over the same directory. */
function boot(sends: string[], logs: string[] = []) {
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const channels = { fake: { send: async (m: { text: string }) => { sends.push(m.text); return "m" } } }
  const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
  const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base"), tickIntervalMs: 50, sweepIntervalMs: 60_000 })
  const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents, timers, log: (m) => logs.push(m) })
  return { store, runs, timers, dispatcher }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(25)
}

/** First boot: the parent waits on its child, the child waits on a signal. */
async function parentWaitingOnChild(sends: string[]) {
  const first = boot(sends)
  first.store.save(childWf())
  first.store.save(parentWf())
  await first.dispatcher.dispatch({
    trigger: { source: "manual" },
    entityRef: { backend: "manual", id: "e-876" },
    event: { id: "evt-1", payload: {} },
  })
  await sleep(60)
  const parent = first.runs.list().find((r) => r.workflowId === "parent-876")!
  const child = first.runs.list().find((r) => r.workflowId === "child-two")!
  expect(parent.status).toBe("paused")
  expect(parent.pausedAt?.kind).toBe("subProcess")
  expect(child.status).toBe("paused")
  return { first, parentId: parent.id, childId: child.id }
}

/** The child fails on disk the way a pre-#1905 daemon left it: the parent
 *  is never told. */
function failChildSilently(runs: RunStore, childId: string) {
  runs.recordExecution({
    runId: childId,
    entry: { at: new Date().toISOString(), nodeId: "wait", inputKeys: [], status: "failed", idempotencyKey: idempotencyKey(childId, "wait", "old-fail"), note: "action failed (status=1)" },
    nextPending: [],
    status: "failed",
    pausedAt: null,
  })
}

describe("stuck workflow runs (#876)", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  it("A: on start, a parent waiting on a child that already failed takes the error path", async () => {
    const sends: string[] = []
    const { first, parentId, childId } = await parentWaitingOnChild(sends)
    failChildSilently(first.runs, childId)
    await sleep(5)
    expect(first.runs.get(parentId)?.status).toBe("paused")

    const logs: string[] = []
    const second = boot(sends, logs)
    // The started timer service runs the recovery on its first sweep.
    second.timers.start()
    await until(() => second.runs.get(parentId)?.status === "completed")
    second.timers.stop()

    const parent = second.runs.get(parentId)!
    expect(parent.status).toBe("completed")
    expect(parent.pausedAt ?? null).toBeNull()
    expect(sends).toEqual(["child failed"])
    expect(logs.some((l) => l.includes("start-up recovery"))).toBe(true)
  })

  it("B: on start, a child cut off with a step pending walks on, and the parent hears", async () => {
    const sends: string[] = []
    const { first, parentId, childId } = await parentWaitingOnChild(sends)
    // The signal came, `wait` was recorded, then the daemon stopped before
    // `notify` ran.
    first.runs.recordExecution({
      runId: childId,
      entry: { at: new Date().toISOString(), nodeId: "wait", inputKeys: [], status: "resumed", idempotencyKey: idempotencyKey(childId, "wait", "signal"), note: "signal:never" },
      nextPending: ["notify"],
      status: "running",
      pausedAt: null,
    })
    await sleep(5)

    const second = boot(sends)
    const r = await second.dispatcher.recoverStuckRuns()
    expect(r.walked).toBe(1)
    await until(() => second.runs.get(parentId)?.status === "completed")

    const child = second.runs.get(childId)!
    expect(child.status).toBe("completed")
    // The step done before the stop did not run again.
    expect(child.history.filter((h) => h.nodeId === "wait" && h.status !== "paused")).toHaveLength(1)
    expect(second.runs.get(parentId)?.status).toBe("completed")
    expect(sends).toEqual(["child sent", "child ok"])
    // A second pass finds nothing left.
    expect(await second.dispatcher.recoverStuckRuns()).toEqual({ walked: 0, parents: 0 })
  })

  it("B: a run started after boot is not walked by the recovery", async () => {
    const sends: string[] = []
    const second = boot(sends)
    second.store.save(childWf())
    await sleep(5)
    const run = second.runs.create({ workflowId: "child-two", initialPending: ["notify"], entityRef: { backend: "manual", id: "e-new" } })
    expect(run.status).toBe("running")
    expect(await second.dispatcher.recoverStuckRuns()).toEqual({ walked: 0, parents: 0 })
    expect(sends).toEqual([])
  })

  it("C: a parent set to running by the old CLI, still waiting on a failed child, is recovered on start", async () => {
    const sends: string[] = []
    const { first, parentId, childId } = await parentWaitingOnChild(sends)
    failChildSilently(first.runs, childId)
    first.runs.setStatus(parentId, "running")
    await sleep(5)

    const second = boot(sends)
    const r = await second.dispatcher.recoverStuckRuns()
    expect(r.parents).toBe(1)
    await until(() => second.runs.get(parentId)?.status === "completed")
    expect(sends).toEqual(["child failed"])
  })

  it("C: resume on a parent stopped at a failed child runs the step again with a new child", async () => {
    const sends: string[] = []
    const { first, parentId, childId } = await parentWaitingOnChild(sends)
    failChildSilently(first.runs, childId)
    first.runs.setStatus(parentId, "running")
    const before = first.runs.get(parentId)!.updatedAt
    await sleep(5)

    const second = boot(sends)
    const r = await second.dispatcher.resumeRun(parentId)
    expect(r.ok).toBe(true)
    expect(r.action).toContain("runs again")
    await until(() => second.runs.get(parentId)?.pausedAt?.kind === "subProcess" && second.runs.get(parentId)?.pausedAt?.childRunId !== childId)

    const parent = second.runs.get(parentId)!
    expect(parent.status).toBe("paused")
    const p = parent.pausedAt
    expect(p?.kind).toBe("subProcess")
    const newChildId = p?.kind === "subProcess" ? p.childRunId : ""
    expect(newChildId).not.toBe(childId)
    expect(second.runs.get(newChildId)?.status).toBe("paused")
    expect(parent.updatedAt > before).toBe(true)
    expect(parent.history.some((h) => h.nodeId === "call" && (h.note ?? "").includes("runs again"))).toBe(true)
    expect(sends).toEqual([])
  })

  it("C: resume walks a run left running with steps pending, and refuses a run waiting on a signal", async () => {
    const sends: string[] = []
    const { first, parentId, childId } = await parentWaitingOnChild(sends)
    const second = boot(sends)

    // Waiting on a signal: refused, with what it waits for.
    const refused = await second.dispatcher.resumeRun(childId)
    expect(refused.ok).toBe(false)
    expect(refused.action).toContain("signalWait")

    // Cut off before `notify`: resume walks it.
    first.runs.recordExecution({
      runId: childId,
      entry: { at: new Date().toISOString(), nodeId: "wait", inputKeys: [], status: "resumed", idempotencyKey: idempotencyKey(childId, "wait", "signal"), note: "signal:never" },
      nextPending: ["notify"],
      status: "running",
      pausedAt: null,
    })
    // Resuming the parent resumes the child it waits on.
    const r = await second.dispatcher.resumeRun(parentId)
    expect(r.ok).toBe(true)
    expect(r.action).toContain(childId)
    await until(() => second.runs.get(parentId)?.status === "completed")
    expect(sends).toEqual(["child sent", "child ok"])

    expect((await second.dispatcher.resumeRun(parentId)).ok).toBe(false)
    expect((await second.dispatcher.resumeRun("nope")).ok).toBe(false)
  })
})
