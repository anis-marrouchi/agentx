import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { RunStore, WorkflowDispatcher, WorkflowStore, workflowSchema, type AgentExecuteRequest, type AgentExecuteResponse } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { waitingOn } from "../src/workflows/follow-up"
import { continuedRun, runRecord, startWrap, finishWrap } from "../src/workflows/required"
import { DEFAULT_SIGNAL_SETTINGS } from "../src/agents/signals/policy"
import { SignalService, deliveryOf, type RunningRef, type SignalServiceDeps } from "../src/agents/signals/service"
import { StoppedTaskStore, summarizeStopped } from "../src/agents/signals/store"

// A stop signal on a workflow step (#870). What must hold:
//   - the run pauses at that step (not failed), and the stop is recorded
//     with the agent's resume plan like any task's;
//   - a resume re-enters the step with the plan prepended, and the run
//     goes on to its later steps, which get no plan;
//   - a resume that no longer fits the run (another agent, not paused by a
//     stop, canceled) is refused and changes nothing;
//   - a wrapped task (workflows.required) that was stopped and resumed gets
//     a new run naming the run it continues.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-signals-wf-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
}

/** start → think (builder) → after (builder) → done. The first turn of
 *  `think` is stopped by a signal; every other turn answers. */
function engine(opts: { stopFirst?: boolean; hold?: Promise<void> } = {}) {
  const store = new WorkflowStore({ baseDir: dir })
  store.save(workflowSchema.parse({
    id: "release", title: "Release",
    nodes: [
      { id: "start", type: "trigger.manual", config: {} },
      { id: "think", type: "agent", config: { agentId: "builder", prompt: "Prepare the release notes" } },
      { id: "after", type: "agent", config: { agentId: "builder", prompt: "Publish them" } },
      { id: "done", type: "end", config: {} },
    ],
    edges: [{ from: "start", to: "think" }, { from: "think", to: "after" }, { from: "after", to: "done" }],
  }))
  const runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
  const prompts: string[] = []
  let stopNext = opts.stopFirst ?? true
  const dispatcher = new WorkflowDispatcher({
    store, runs, nodeId: "node-a", timers: new TimerService({ baseDir: resolve(dir, "_t") }), channels: {},
    agents: {
      execute: async (req: AgentExecuteRequest): Promise<AgentExecuteResponse> => {
        prompts.push(req.message)
        if (opts.hold) await opts.hold
        if (stopNext) {
          stopNext = false
          return { content: "", error: "stopped by owner", errorKind: "stopped", runTaskId: "task-1" }
        }
        return { content: "fine" }
      },
    },
  })
  return { dispatcher, runs, prompts }
}

describe("a workflow step stopped by a signal", () => {
  it("pauses the run at that step, and a resume continues it from there", async () => {
    const { dispatcher, runs, prompts } = engine()
    const { run } = await dispatcher.startRun({ workflowId: "release", meta: { followUp: false } })
    await until(() => runs.get(run!.id)?.status !== "running")
    const paused = runs.get(run!.id)!
    expect(paused.status).toBe("paused")
    expect(paused.pausedAt).toEqual({ kind: "agentStop", nodeId: "think", agentId: "builder", taskId: "task-1" })
    expect(paused.history.some((h) => h.status === "failed")).toBe(false)
    expect(waitingOn(paused)).toMatch(/resume signal/)

    const r = await dispatcher.resumeStoppedStep({ runId: run!.id, agentId: "builder", taskId: "task-1", note: "RESUME PLAN: Left: the changelog", by: "owner" })
    expect(r).toEqual({ ok: true, nodeId: "think" })
    await until(() => runs.get(run!.id)?.status !== "running")
    const final = runs.get(run!.id)!
    expect(final.status).toBe("completed")
    // The step re-entered with the plan first; the later step got none.
    expect(prompts).toHaveLength(3)
    expect(prompts[1].startsWith("RESUME PLAN: Left: the changelog")).toBe(true)
    expect(prompts[1]).toContain("Prepare the release notes")
    expect(prompts[2]).toBe("Publish them")
    expect(final.history.map((h) => `${h.nodeId}:${h.status}`)).toEqual(["think:paused", "think:resumed", "think:ok", "after:ok", "done:ok"])
  })

  it("refuses a resume that does not fit the run, and changes nothing", async () => {
    const { dispatcher, runs } = engine()
    const { run } = await dispatcher.startRun({ workflowId: "release", meta: { followUp: false } })
    await until(() => runs.get(run!.id)?.status === "paused")
    const before = runs.get(run!.id)!.history.length

    expect(await dispatcher.resumeStoppedStep({ runId: run!.id, agentId: "writer", note: "x", by: "owner" })).toMatchObject({ ok: false, error: expect.stringMatching(/step "think" of builder/) })
    expect(await dispatcher.resumeStoppedStep({ runId: run!.id, agentId: "builder", taskId: "task-9", note: "x", by: "owner" })).toMatchObject({ ok: false })
    expect(await dispatcher.resumeStoppedStep({ runId: "nope", agentId: "builder", note: "x", by: "owner" })).toMatchObject({ ok: false })
    expect(runs.get(run!.id)!.history.length).toBe(before)

    await dispatcher.cancelRun(run!.id)
    expect(await dispatcher.resumeStoppedStep({ runId: run!.id, agentId: "builder", taskId: "task-1", note: "x", by: "owner" })).toMatchObject({ ok: false, error: expect.stringMatching(/canceled/) })
  })

  it("names the step a running agent is on, for the stop", async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    const { dispatcher, runs } = engine({ stopFirst: false, hold })
    const { run } = await dispatcher.startRun({ workflowId: "release", meta: { followUp: false } })
    await until(() => runs.get(run!.id)?.pending.includes("think") ?? false)
    expect(dispatcher.agentStepOf(run!.id, "builder")).toEqual({ workflowId: "release", nodeId: "think" })
    expect(dispatcher.agentStepOf(run!.id, "writer")).toMatchObject({ error: expect.stringMatching(/not on a step of writer/) })
    expect(dispatcher.agentStepOf("nope", "builder")).toMatchObject({ error: expect.stringMatching(/no workflow run/) })
    release()
    await until(() => runs.get(run!.id)?.status === "completed")
    expect(dispatcher.agentStepOf(run!.id, "builder")).toMatchObject({ error: expect.stringMatching(/completed/) })
  })
})

const STEP_RUN: RunningRef = {
  taskId: "task-1",
  traceId: "trace-1",
  agentId: "builder",
  channel: "workflow",
  chatId: "workflow:run-7",
  sender: "workflow",
  rootId: "root-1",
  originalMessage: "Prepare the release notes",
  origin: { kind: "direct", context: { channel: "workflow", chatId: "workflow:run-7", sender: "workflow" } },
  workflowRunId: "run-7",
}

function harness(over: Partial<SignalServiceDeps> = {}) {
  const viaChat: string[] = []
  const viaWorkflow: Array<{ runId: string; note: string; by: string }> = []
  const told: string[] = []
  let running: RunningRef | null = { ...STEP_RUN }
  const deps: SignalServiceDeps = {
    settings: () => DEFAULT_SIGNAL_SETTINGS,
    store: new StoppedTaskStore(join(dir, "stopped")),
    findRunning: (by) => (running && by.taskId === running.taskId ? running : null),
    stopRun: () => { running = null; return true },
    whenRunEnds: async () => {},
    toolCalls: () => [],
    windDown: async () => ({ content: "Done: draft.\nLeft: changelog.\nNext action: write it.\nHalf-applied: nothing" }),
    resume: async ({ record }) => { viaChat.push(record.id) },
    workflowStep: (runId) => ({ workflowId: "release", nodeId: runId === "run-7" ? "think" : "?" }),
    resumeWorkflowStep: async ({ record, note, by }) => { viaWorkflow.push({ runId: record.workflow!.runId, note, by }) },
    tell: async (_o, text) => { told.push(text) },
    publish: () => {},
    log: () => {},
    ...over,
  }
  return { service: new SignalService(deps), viaChat, viaWorkflow, told }
}

describe("the signal service on a workflow step", () => {
  it("stops it with a plan, and resumes it inside its run", async () => {
    const h = harness()
    const r = await h.service.stop({ kind: "owner" }, { taskId: "task-1" }, "wait for QA")
    if (!r.ok) throw new Error(r.error)
    expect(r.record.workflow).toEqual({ runId: "run-7", workflowId: "release", nodeId: "think" })
    const done = await r.done!
    expect(done.plan?.author).toBe("agent")
    expect(h.told).toEqual([])
    const view = summarizeStopped(done)
    expect(view).toMatchObject({ resumable: true, workflow: { runId: "run-7", nodeId: "think" } })

    const res = await h.service.resume({ kind: "owner" }, "task-1")
    if (!res.ok) throw new Error(res.error)
    expect(h.viaChat).toEqual([])
    expect(h.viaWorkflow).toHaveLength(1)
    expect(h.viaWorkflow[0]).toMatchObject({ runId: "run-7", by: "owner" })
    expect(h.viaWorkflow[0].note).toMatch(/Left: changelog/)
    expect(res.delivery).toMatch(/workflow run run-7, which goes on from step think/)
    // A second resume is refused.
    expect(await h.service.resume({ kind: "owner" }, "task-1")).toMatchObject({ ok: false, status: 409 })
  })

  it("gives the claim back when the run can no longer resume there", async () => {
    let fail = true
    const h = harness({ resumeWorkflowStep: async () => { if (fail) throw new Error("workflow run run-7 is canceled") } })
    const r = await h.service.stop({ kind: "owner" }, { taskId: "task-1" })
    if (!r.ok) throw new Error(r.error)
    await r.done
    expect(await h.service.resume({ kind: "owner" }, "task-1")).toMatchObject({ ok: false, status: 500, error: expect.stringMatching(/canceled/) })
    expect(h.service.get("task-1")?.state).toBe("stopped")
    fail = false
    expect((await h.service.resume({ kind: "owner" }, "task-1")).ok).toBe(true)
  })

  it("refuses, and stops nothing, when the run cannot pause at the step", async () => {
    let stopped = false
    for (const over of [{ workflowStep: undefined }, { workflowStep: () => ({ error: "workflow run run-7 is paused" }) }] as Array<Partial<SignalServiceDeps>>) {
      const h = harness({ ...over, stopRun: () => { stopped = true; return true } })
      const r = await h.service.stop({ kind: "owner" }, { taskId: "task-1" })
      expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/workflow run run-7/) })
    }
    expect(stopped).toBe(false)
  })

  it("says where a workflow step's answer goes", () => {
    expect(deliveryOf(null, { runId: "r", workflowId: "w", nodeId: "n" })).toBe("workflow run r, which goes on from step n")
  })
})

describe("a wrapped task stopped and resumed (#858)", () => {
  it("records the run it continues", () => {
    const runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
    startWrap(runs, { runId: "wrap-1", agentId: "ops", channel: "api", message: "rename the report", taskId: "trace-1" })
    finishWrap(runs, "wrap-1", { error: "stopped by owner", canceled: true, durationMs: 5, readOnly: false, exemptQuestions: false })
    expect(continuedRun(runs, "trace-1")).toBe("wrap-1")
    expect(continuedRun(runs, "trace-x")).toBeNull()
    expect(continuedRun(runs, undefined)).toBeNull()
    const next = startWrap(runs, { runId: "wrap-2", agentId: "ops", channel: "api", message: "rename the report", taskId: "trace-2", continues: "wrap-1" })
    expect(next.meta?.continues).toBe("wrap-1")
    expect(runRecord(next).continues).toBe("wrap-1")
  })
})
