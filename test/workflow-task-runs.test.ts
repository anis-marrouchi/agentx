import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RunStore, WorkflowDispatcher, WorkflowStore, workflowSchema, type AgentExecuteResponse } from "../src/workflows"
import { closeStaleWraps, finishWrap, isReadOnlyToolUse, startWrap, TASK_WORKFLOW_ID } from "../src/workflows/required"

// workflows.required (#883): task runs are kept apart from workflow runs,
// so a paused workflow run is still found however many tasks ran since,
// and ended task runs are removed after workflows.required.retentionDays.

let dir: string
let runs: RunStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-task-runs-"))
  runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const outcome = { durationMs: 10, readOnly: false, exemptQuestions: true }
const task = (id: string) => startWrap(runs, { runId: id, agentId: "builder", channel: "telegram", message: `task ${id}` })
const age = (path: string, days: number) => { const t = new Date(Date.now() - days * 86_400_000); utimesSync(path, t, t) }

describe("task runs live in their own folder", () => {
  it("are written to _tasks, found by id, and left out of the workflow run list", () => {
    task("t1")
    finishWrap(runs, "t1", outcome)
    expect(existsSync(join(runs.tasksDir, "t1.jsonl"))).toBe(true)
    expect(readdirSync(runs.runsDir)).toEqual([])
    expect(runs.get("t1")?.status).toBe("completed")
    expect(runs.list()).toEqual([])
    expect(runs.list({ workflowId: TASK_WORKFLOW_ID }).map((r) => r.id)).toEqual(["t1"])
    expect(runs.list({ tasks: "include" }).map((r) => r.id)).toEqual(["t1"])
  })

  it("a workflow paused on a signal resumes after more than 500 task runs", async () => {
    const store = new WorkflowStore({ baseDir: dir })
    store.save(workflowSchema.parse({
      id: "signal-demo", version: 2, title: "signal", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "wait", type: "signal.wait", config: { name: "approved", scope: "workflow" } },
        { id: "ok", type: "action.send", config: { channel: "fake", chatId: "c", text: "got {{wait.name}}" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "wait" }, { from: "wait", to: "ok" }, { from: "ok", to: "done" }],
    }))
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({ trigger: { source: "manual" }, entityRef: { backend: "manual", id: "e-sig" }, event: { id: "evt-1", payload: {} } })
    await new Promise((r) => setTimeout(r, 40))
    const paused = runs.list()[0]
    expect(paused.pausedAt?.kind).toBe("signalWait")
    // The paused run is older than every task run that follows.
    age(join(runs.runsDir, `${paused.id}.jsonl`), 1)

    for (let i = 0; i < 510; i++) { task(`t${i}`); finishWrap(runs, `t${i}`, outcome) }
    expect(runs.list({ workflowId: TASK_WORKFLOW_ID }).length).toBe(510)

    dispatcher.emitSignal({ name: "approved", scope: "workflow", workflowId: "signal-demo" })
    await new Promise((r) => setTimeout(r, 60))
    expect(runs.get(paused.id)?.status).toBe("completed")
    expect(sends[0].text).toBe("got approved")
  }, 30_000)

  it("moves task runs an older version wrote with the workflow runs, once", () => {
    task("old")
    finishWrap(runs, "old", outcome)
    // As 0.133.0 wrote it: in _runs.
    const body = readFileSync(join(runs.tasksDir, "old.jsonl"), "utf-8")
    rmSync(join(runs.tasksDir, "old.jsonl"))
    writeFileSync(join(runs.runsDir, "old.jsonl"), body)
    // Not counted with the workflow runs even before it is moved.
    expect(runs.list()).toEqual([])
    expect(runs.get("old")?.status).toBe("completed")

    expect(runs.moveTaskRuns()).toBe(1)
    expect(existsSync(join(runs.tasksDir, "old.jsonl"))).toBe(true)
    expect(runs.list()).toEqual([])
    expect(runs.get("old")?.status).toBe("completed")
    expect(runs.moveTaskRuns()).toBe(0)
  })
})

describe("the boot sweep and retention", () => {
  it("the boot sweep reads only task runs still open", () => {
    for (let i = 0; i < 20; i++) { task(`done${i}`); finishWrap(runs, `done${i}`, outcome) }
    task("cut")
    expect(runs.openTaskRunIds()).toEqual(["cut"])
    expect(closeStaleWraps(runs)).toBe(1)
    expect(runs.get("cut")?.status).toBe("canceled")
    expect(runs.openTaskRunIds()).toEqual([])
  })

  it("removes ended task runs past the retention, keeps young and open ones and workflow runs", () => {
    task("old"); finishWrap(runs, "old", outcome)
    task("young"); finishWrap(runs, "young", outcome)
    task("open")
    const wf = runs.create({ workflowId: "wf", initialPending: [], entityRef: { backend: "manual", id: "x" } })
    runs.setStatus(wf.id, "completed")
    age(join(runs.tasksDir, "old.jsonl"), 40)
    age(join(runs.tasksDir, "open.jsonl"), 40)
    age(join(runs.runsDir, `${wf.id}.jsonl`), 40)

    expect(runs.pruneTaskRuns(0)).toBe(0)
    expect(runs.pruneTaskRuns(30)).toBe(1)
    expect(runs.get("old")).toBeNull()
    expect(runs.get("young")).not.toBeNull()
    expect(runs.get("open")?.status).toBe("running")
    expect(runs.get(wf.id)).not.toBeNull()
  })
})

describe("tools that change nothing", () => {
  it("a write verb after or / and is not read-only", () => {
    for (const n of ["mcp__x__get_or_create_label", "mcp__x__findOrCreateUser", "mcp__x__read_and_delete"]) {
      expect(isReadOnlyToolUse(n), n).toBe(false)
    }
    expect(isReadOnlyToolUse("mcp__x__get_order")).toBe(true)
    expect(isReadOnlyToolUse("mcp__x__list_open_issues")).toBe(true)
  })
})
