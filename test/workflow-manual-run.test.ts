import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema, type Workflow } from "../src/workflows"
import { startManualWorkflowRun } from "../src/daemon/workflow-manual-run"

// POST /workflows/:id/run — starts the workflow named in the URL, never
// another one that happens to match the same trigger source.

function wf(id: string, trigger: { type: string; config: Record<string, unknown> }, extra: Partial<Workflow> = {}): Workflow {
  return workflowSchema.parse({
    id,
    version: 2,
    title: id,
    priority: 0,
    fanOut: false,
    nodes: [
      { id: "trigger", ...trigger },
      { id: "done", type: "end", config: {} },
    ],
    edges: [{ from: "trigger", to: "done" }],
    envAllow: [],
    retention: { maxRuns: 500, maxDays: 90 },
    ...extra,
  })
}

describe("startManualWorkflowRun", () => {
  let dir: string
  let store: WorkflowStore
  let runs: RunStore
  let dispatcher: WorkflowDispatcher
  const run = (id: string, body?: { force?: boolean; payload?: Record<string, unknown> }) =>
    startManualWorkflowRun(
      { get: (i) => store.get(i), dispatchWorkflow: (a) => dispatcher.dispatchWorkflow(a) },
      id,
      body,
    )

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-manual-run-"))
    store = new WorkflowStore({ baseDir: dir })
    runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
    dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {},
      agents: { execute: async () => ({ content: "", taskId: "t", durationMs: 1 }) },
    })
    // The trap from the report: a higher-priority manual workflow that
    // declares `source: "manual"` next to one with an empty trigger config.
    store.save(wf("deploy", { type: "trigger.manual", config: { source: "manual" } }, { priority: 10 }))
    store.save(wf("whatsapp-digest", { type: "trigger.manual", config: {} }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs the lower-priority manual workflow named by id, not the higher-priority one", async () => {
    const r = await run("whatsapp-digest", { payload: { msgId: "DEADBEEF0001" } })
    expect(r.status).toBe(200)
    expect(runs.get(String(r.body.runId))?.workflowId).toBe("whatsapp-digest")
    expect(runs.list({ workflowId: "deploy" })).toHaveLength(0)
  })

  it("runs a manual workflow whose trigger config does carry a source", async () => {
    store.save(wf("other", { type: "trigger.manual", config: { source: "manual" } }, { priority: 99 }))
    const r = await run("deploy")
    expect(r.status).toBe(200)
    expect(runs.get(String(r.body.runId))?.workflowId).toBe("deploy")
    expect(runs.list({ workflowId: "other" })).toHaveLength(0)
  })

  it("force on a non-manual trigger targets only the named workflow", async () => {
    const channel = { type: "trigger.channel", config: { source: "whatsapp-message" } }
    store.save(wf("support-a", channel, { priority: 5 }))
    store.save(wf("support-b", channel))

    expect((await run("support-b")).status).toBe(409)
    expect(runs.list({ workflowId: "support-b" })).toHaveLength(0)

    const r = await run("support-b", { force: true, payload: { chatId: "c1" } })
    expect(r.status).toBe(200)
    expect(r.body.source).toBe("whatsapp-message")
    expect(runs.get(String(r.body.runId))?.workflowId).toBe("support-b")
    expect(runs.list({ workflowId: "support-a" })).toHaveLength(0)
  })

  it("returns an error instead of starting anything for unknown or inactive workflows", async () => {
    expect((await run("nope")).status).toBe(404)

    store.save(wf("paused-one", { type: "trigger.manual", config: {} }, { state: "disabled" }))
    const r = await run("paused-one")
    expect(r.status).toBe(409)
    expect(r.body.error).toContain("disabled")
    expect(runs.list({})).toHaveLength(0)
  })

  it("does not resume another workflow's run paused on the same entity", async () => {
    store.save(workflowSchema.parse({
      ...wf("approval", { type: "trigger.manual", config: {} }),
      nodes: [
        { id: "trigger", type: "trigger.manual", config: {} },
        { id: "wait", type: "checkpoint", config: { name: "approve", resumeMatch: {} } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "wait" }, { from: "wait", to: "done" }],
    }))
    const first = await run("approval", { payload: { entityId: "e1" } })
    await new Promise((r) => setTimeout(r, 30))
    expect(runs.get(String(first.body.runId))?.status).toBe("paused")

    const r = await run("whatsapp-digest", { payload: { entityId: "e1" } })
    expect(r.status).toBe(409)
    expect(r.body.runId).toBeUndefined()
    expect(runs.get(String(first.body.runId))?.status).toBe("paused")
    expect(runs.list({ workflowId: "whatsapp-digest" })).toHaveLength(0)
  })

  it("does not answer ok when another workflow's run is live on the same entity", async () => {
    const other = runs.create({ workflowId: "deploy", initialPending: ["done"], entityRef: { backend: "manual", id: "c1" } })
    expect(other.status).toBe("running")

    const r = await run("whatsapp-digest", { payload: { chatId: "c1" } })
    expect(r.status).toBe(409)
    expect(runs.list({ workflowId: "whatsapp-digest" })).toHaveLength(0)

    // The same workflow's own live run still takes the event (202).
    expect((await run("deploy", { payload: { chatId: "c1" } })).status).toBe(202)
  })
})
