import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import {
  RunStore,
  WorkflowStore,
  WorkflowDispatcher,
  workflowSchema,
  type AgentExecuteResponse,
} from "../src/workflows"
import { TimerService } from "../src/workflows/timers"

// #562: a loop that brings a node back under the same event must run it
// again, while the same event delivered twice still runs a node once.
const TEST_DIR = resolve(__dirname, "../.test-workflow-loop-revisit")

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
}

/** check (agent) → gate: "again" loops back to `loopTo`, anything else ends. */
const loopWf = (withWait: boolean) => workflowSchema.parse({
  id: "loop-wf", version: 2, title: "loop", priority: 0, fanOut: false,
  envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
  nodes: [
    { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
    ...(withWait ? [{ id: "wait", type: "timer.boundary", config: { after: "PT1S" } }] : []),
    { id: "check", type: "agent", config: { agentId: "checker", prompt: "check" } },
    { id: "gate", type: "branch", config: {
      cases: [{ when: { kind: "equals", params: { path: "check.reply", value: "again" } }, to: "again" }],
      default: "end",
    } },
    { id: "done", type: "end", config: {} },
  ],
  edges: [
    ...(withWait
      ? [{ from: "trigger", to: "wait" }, { from: "wait", to: "check" }]
      : [{ from: "trigger", to: "check" }]),
    { from: "check", to: "gate" },
    { from: "gate", fromPort: "again", to: withWait ? "wait" : "check" },
    { from: "gate", fromPort: "end", to: "done" },
  ],
})

/** Agent answers come from `answers` in order; the count is kept. */
const setup = (withWait: boolean, answers: string[]) => {
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  store.save(loopWf(withWait))
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const calls = { n: 0 }
  const agents = {
    execute: async (): Promise<AgentExecuteResponse> => ({ content: answers[calls.n++] ?? "ok" }),
  }
  const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base"), tickIntervalMs: 50 })
  const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels: {}, agents, timers })
  return { store, runs, timers, dispatcher, calls }
}

describe("#562 loop revisit under one event", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("runs a node twice when a loop brings it back in the same walk", async () => {
    const { runs, dispatcher, calls } = setup(false, ["again", "ok"])
    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-loop" },
      event: { id: "evt-1", payload: {} },
    })
    await until(() => runs.list()[0]?.status === "completed")
    const run = runs.list()[0]
    expect(run.status).toBe("completed")
    expect(calls.n).toBe(2)
    expect(run.history.filter((h) => h.nodeId === "check" && h.status === "ok")).toHaveLength(2)
    expect(run.history.some((h) => h.status === "skipped")).toBe(false)
  })

  it("pauses again on a timer node the loop reaches after the timer resumed it (Rafeeq wait_kaggle)", async () => {
    const { runs, timers, dispatcher, calls } = setup(true, ["again", "ok"])
    timers.start()
    try {
      await dispatcher.dispatch({
        trigger: { source: "manual" },
        entityRef: { backend: "manual", id: "e-wait" },
        event: { id: "evt-1", payload: {} },
      })
      await until(() => runs.list()[0]?.status === "completed", 6000)
    } finally { timers.stop() }
    const run = runs.list()[0]
    expect(run.status).toBe("completed")
    expect(calls.n).toBe(2)
    expect(run.history.filter((h) => h.nodeId === "wait" && h.status === "paused")).toHaveLength(2)
    expect(run.history.some((h) => h.status === "skipped")).toBe(false)
  }, 10_000)

  it("still runs a node once when the same event is delivered twice", async () => {
    const { store, runs, dispatcher, calls } = setup(false, ["ok"])
    const wf = store.get("loop-wf")!
    const run = runs.create({ workflowId: wf.id, initialPending: ["check"], entityRef: { backend: "manual", id: "e-dup" } })
    const walk = (dispatcher as unknown as { walk: (w: typeof wf, id: string, ev: string) => Promise<void> }).walk.bind(dispatcher)
    await walk(wf, run.id, "evt-dup")
    expect(calls.n).toBe(1)
    // The same event again finds `check` pending (as after a crash before
    // the walk moved on): it must be dropped, not run a second time.
    runs.setStatus(run.id, "running")
    runs.patch(run.id, { pending: ["check"] })
    await walk(wf, run.id, "evt-dup")
    expect(calls.n).toBe(1)
    const after = runs.get(run.id)!
    expect(after.history.some((h) => h.nodeId === "check" && h.status === "skipped")).toBe(true)
  })
})
