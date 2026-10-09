import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { RunStore, WorkflowDispatcher, WorkflowStore, workflowSchema, type AgentExecuteResponse } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import {
  closeStaleWraps, endedWithoutFailing, finishWrap, isReadOnlyToolUse, liveStep, pruneTaskRuns, reportStep, requiredFor, runRecord, shouldWrap,
  startWrap, TASK_WORKFLOW_ID, toolUsesOf, wrapHintText, writePlan,
} from "../src/workflows/required"
import { handleFollowUpApi, type FollowUpApiDeps } from "../src/workflows/follow-up-api"
import { daemonConfigSchema } from "../src/daemon/config"
import { renderLivePage } from "../src/daemon/ui/pages/live"
import { buildAgentContext } from "../src/agents/context"

// workflows.required (#858): every task runs inside a workflow run — the
// one-step linear template, or a plan the agent writes and may change —
// and every run records its steps, their times and where it failed.

let dir: string
let runs: RunStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-wf-required-"))
  runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const start = (id = "run-1", message = "Fix the login page") =>
  startWrap(runs, { runId: id, agentId: "builder", channel: "telegram", chatId: "c1", message, taskId: "t1" })
const outcome = (o: Partial<Parameters<typeof finishWrap>[2]> = {}) =>
  ({ durationMs: 1200, readOnly: false, exemptQuestions: true, inputTokens: 900, outputTokens: 80, ...o })

describe("the setting", () => {
  it("is off by default, with plain questions exempt", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.workflows.required).toEqual({ enabled: false, agents: {}, exemptQuestions: true, retention: { maxRuns: 2000, maxDays: 30 } })
  })

  it("needs the engine, and a per-agent value wins over the global one", () => {
    expect(requiredFor({ enabled: false, required: { enabled: true } }, "a")).toBe(false)
    expect(requiredFor({ enabled: true, required: { enabled: true } }, "a")).toBe(true)
    expect(requiredFor({ enabled: true, required: { enabled: true, agents: { a: false } } }, "a")).toBe(false)
    expect(requiredFor({ enabled: true, required: { enabled: false, agents: { a: true } } }, "a")).toBe(true)
    expect(requiredFor({ enabled: true, required: { enabled: false, agents: { a: true } } }, "b")).toBe(false)
    expect(requiredFor({ enabled: true }, "a")).toBe(false)
  })

  it("never wraps a turn that is already a workflow step", () => {
    expect(shouldWrap({ context: { channel: "telegram" } })).toBe(true)
    expect(shouldWrap({ workflowRunId: "r", context: { channel: "telegram" } })).toBe(false)
    expect(shouldWrap({ context: { channel: "workflow" } })).toBe(false)
  })
})

describe("the linear wrap", () => {
  it("records the turn as the reply step, with its time and tokens", () => {
    const run = start()
    expect(run).toMatchObject({ id: "run-1", workflowId: TASK_WORKFLOW_ID, status: "running", pending: ["reply"] })
    expect(run.meta?.wrap).toMatchObject({ agentId: "builder", mode: "linear" })
    expect(liveStep(run)).toBe("reply")

    const done = finishWrap(runs, "run-1", outcome())
    expect(done).not.toBe("discarded")
    const final = runs.get("run-1")!
    expect(final.status).toBe("completed")
    expect(final.history.map((h) => [h.nodeId, h.status])).toEqual([["reply", "ok"], ["done", "ok"]])
    expect(final.history[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(final.history[0].output).toMatchObject({ turnMs: 1200, inputTokens: 900, outputTokens: 80 })

    const rec = runRecord(final)
    expect(rec).toMatchObject({ v: 1, mode: "linear", agentId: "builder", status: "completed", failedAt: null, revisions: 0, tokens: { input: 900, output: 80 } })
    expect(rec.steps.map((s) => s.id)).toEqual(["reply", "done"])
    expect(rec.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("marks the run failed at the reply when the turn fails", () => {
    start()
    finishWrap(runs, "run-1", outcome({ error: "model overloaded" }))
    const final = runs.get("run-1")!
    expect(final.status).toBe("failed")
    expect(runRecord(final)).toMatchObject({ failedAt: "reply", steps: [{ id: "reply", status: "failed", note: "model overloaded" }] })
  })

  it("leaves no run for a plain question, unless the exemption is off", () => {
    start("q1")
    expect(finishWrap(runs, "q1", outcome({ readOnly: true }))).toBe("discarded")
    expect(runs.get("q1")).toBeNull()
    expect(existsSync(resolve(dir, "_runs", "q1.jsonl"))).toBe(false)

    start("q2")
    expect(finishWrap(runs, "q2", outcome({ readOnly: true, exemptQuestions: false }))).toMatchObject({ status: "completed" })
    start("q3")
    expect(finishWrap(runs, "q3", outcome({ readOnly: false }))).toMatchObject({ status: "completed" })
    // A failed question is kept: where it failed is worth a record.
    start("q4")
    expect(finishWrap(runs, "q4", outcome({ readOnly: true, error: "boom" }))).toMatchObject({ status: "failed" })
  })
})

describe("a plan the agent writes", () => {
  it("records the plan, each step's time, and a revision mid-run", () => {
    start()
    const p = writePlan(runs, "run-1", { steps: ["Read the error log", "Patch the form", "Deploy"] })
    expect(p.ok).toBe(true)
    let run = runs.get("run-1")!
    expect(run.meta?.wrap?.mode).toBe("plan")
    expect(run.pending).toEqual(["step1", "step2", "step3"])
    expect(liveStep(run)).toBe("Read the error log (1/3)")

    expect(reportStep(runs, "run-1", { step: "step1", status: "started" }).ok).toBe(true)
    expect(liveStep(runs.get("run-1")!)).toBe("Read the error log (1/3)")
    expect(reportStep(runs, "run-1", { step: "1", status: "done", note: "a null email" }).ok).toBe(true)

    // The plan changes: the patch is not needed, a migration is.
    const r = writePlan(runs, "run-1", { steps: ["Fix the data", "Deploy"], reason: "the bug is in the data, not the form" })
    expect(r.ok).toBe(true)
    run = runs.get("run-1")!
    expect(run.meta?.plan?.steps.map((s) => s.id)).toEqual(["step1", "step4", "step5"])
    expect(run.meta?.plan?.revisions).toHaveLength(2)
    expect(run.meta?.plan?.revisions[1]).toMatchObject({ kind: "revise", reason: "the bug is in the data, not the form", steps: ["step4", "step5"], dropped: ["step2", "step3"] })
    expect(run.pending).toEqual(["step4", "step5"])

    expect(reportStep(runs, "run-1", { step: "Fix the data", status: "done" }).ok).toBe(true)
    finishWrap(runs, "run-1", outcome())
    const final = runs.get("run-1")!
    expect(final.status).toBe("completed")
    const rec = runRecord(final)
    expect(rec.mode).toBe("plan")
    expect(rec.revisions).toBe(1)
    expect(rec.steps.map((s) => [s.id, s.status])).toEqual([["step1", "ok"], ["step4", "ok"], ["step5", "skipped"], ["done", "ok"]])
    expect(rec.steps[0]).toMatchObject({ title: "Read the error log", note: "a null email" })
    for (const s of rec.steps) expect(s.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("fails at the step it was on when the turn fails", () => {
    start()
    writePlan(runs, "run-1", { steps: ["One", "Two", "Three"] })
    reportStep(runs, "run-1", { step: "step1", status: "done" })
    reportStep(runs, "run-1", { step: "step2", status: "started" })
    finishWrap(runs, "run-1", outcome({ error: "timed out" }))
    const final = runs.get("run-1")!
    expect(final.status).toBe("failed")
    const rec = runRecord(final)
    expect(rec.failedAt).toBe("step2")
    expect(rec.steps.map((s) => [s.id, s.status])).toEqual([["step1", "ok"], ["step2", "failed"], ["step3", "skipped"]])
  })

  it("closes a stopped turn as canceled, never failed", () => {
    start()
    writePlan(runs, "run-1", { steps: ["One", "Two", "Three"] })
    reportStep(runs, "run-1", { step: "step1", status: "done" })
    reportStep(runs, "run-1", { step: "step2", status: "started" })
    finishWrap(runs, "run-1", outcome({ error: "stopped by the owner: wait for the client", canceled: true }))
    const final = runs.get("run-1")!
    expect(final.status).toBe("canceled")
    const rec = runRecord(final)
    expect(rec.failedAt).toBeNull()
    expect(rec.steps.map((s) => [s.id, s.status])).toEqual([["step1", "ok"], ["step2", "skipped"], ["step3", "skipped"]])
    expect(rec.steps[1].note).toBe("stopped: stopped by the owner: wait for the client")

    start("lin")
    finishWrap(runs, "lin", outcome({ error: "task cancelled by operator", canceled: true }))
    expect(runs.get("lin")!.status).toBe("canceled")
    expect(runRecord(runs.get("lin")!)).toMatchObject({ failedAt: null, steps: [{ id: "reply", status: "skipped" }] })
  })

  it("tells a stop from a failure by the turn's error kind", () => {
    for (const k of ["stopped", "cancelled", "interrupted"]) expect(endedWithoutFailing(k), k).toBe(true)
    for (const k of [undefined, "timeout", "rate_limit", "unknown"]) expect(endedWithoutFailing(k), String(k)).toBe(false)
  })

  it("refuses what makes no sense", () => {
    expect(writePlan(runs, "nope", { steps: ["a"] }).ok).toBe(false)
    start()
    expect(reportStep(runs, "run-1", { step: "1", status: "done" })).toMatchObject({ ok: false })
    expect(writePlan(runs, "run-1", { steps: [] })).toMatchObject({ ok: false })
    writePlan(runs, "run-1", { steps: ["a"] })
    expect(reportStep(runs, "run-1", { step: "zzz", status: "done" })).toMatchObject({ ok: false })
    expect(reportStep(runs, "run-1", { step: "a", status: "maybe" })).toMatchObject({ ok: false })
    finishWrap(runs, "run-1", outcome())
    expect(writePlan(runs, "run-1", { steps: ["b"] })).toMatchObject({ ok: false })
  })
})

describe("after a restart", () => {
  it("closes wrapped runs whose turn was cut off, and leaves others alone", () => {
    start("cut")
    writePlan(runs, "cut", { steps: ["One", "Two"] })
    reportStep(runs, "cut", { step: "step1", status: "started" })
    start("done-already")
    finishWrap(runs, "done-already", outcome())
    expect(closeStaleWraps(runs)).toBe(1)
    // Cut off by the stop, not failed: the task is resumed after it.
    const cut = runs.get("cut")!
    expect(cut.status).toBe("canceled")
    expect(runRecord(cut).failedAt).toBeNull()
    expect(runs.get("done-already")!.status).toBe("completed")
    expect(closeStaleWraps(runs)).toBe(0)
  })
})

describe("task runs keep apart from workflow runs (#877)", () => {
  const pausedOnSignal = async () => {
    const store = new WorkflowStore({ baseDir: dir })
    store.save(workflowSchema.parse({
      id: "wait-sig", title: "Waits on a signal",
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "wait", type: "signal.wait", config: { name: "approved", scope: "workflow" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "wait" }, { from: "wait", to: "done" }],
    }))
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {},
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
    })
    await dispatcher.dispatch({ trigger: { source: "manual" }, entityRef: { backend: "manual", id: "e-sig" }, event: { id: "evt-1", payload: {} } })
    await new Promise((r) => setTimeout(r, 40))
    const paused = runs.list()[0]
    expect(paused.pausedAt?.kind).toBe("signalWait")
    return { dispatcher, paused }
  }

  it("a paused workflow still resumes after more than 500 wrapped tasks", async () => {
    const { dispatcher, paused } = await pausedOnSignal()
    for (let i = 0; i < 520; i++) {
      start(`t-${i}`)
      finishWrap(runs, `t-${i}`, outcome())
    }
    expect(readdirSync(runs.taskRunsDir)).toHaveLength(520)
    // The window counts workflow runs only.
    expect(runs.list({ limit: 500 }).map((r) => r.id)).toEqual([paused.id])
    expect(runs.list({ scope: "tasks", limit: 500 })).toHaveLength(500)
    expect(runs.list({ workflowId: TASK_WORKFLOW_ID })).toHaveLength(520)
    expect(runs.get("t-0")?.status).toBe("completed")

    dispatcher.emitSignal({ name: "approved", scope: "workflow", workflowId: "wait-sig" })
    await new Promise((r) => setTimeout(r, 40))
    expect(runs.get(paused.id)!.status).toBe("completed")
  })

  it("moves task runs written next to workflow runs, and hides them from the workflow list until then", () => {
    start("old")
    renameSync(resolve(runs.taskRunsDir, "old.jsonl"), resolve(runs.runsDir, "old.jsonl"))
    runs.create({ workflowId: "wf", initialPending: [], entityRef: { backend: "manual", id: "e1" }, id: "engine" })
    expect(runs.list().map((r) => r.id)).toEqual(["engine"])
    expect(runs.get("old")?.meta?.wrap).toBeTruthy()
    expect(runs.moveTaskRuns()).toBe(1)
    expect(existsSync(resolve(runs.taskRunsDir, "old.jsonl"))).toBe(true)
    expect(existsSync(resolve(runs.runsDir, "engine.jsonl"))).toBe(true)
    expect(runs.moveTaskRuns()).toBe(0)
    // A cut-off one is still closed at boot, now from its own folder.
    expect(closeStaleWraps(runs)).toBe(1)
    expect(runs.get("old")!.status).toBe("canceled")
  })

  it("keeps finished task runs within the retention, never running ones or workflow runs", () => {
    runs.create({ workflowId: "wf", initialPending: [], entityRef: { backend: "manual", id: "e1" }, id: "engine" })
    runs.setStatus("engine", "completed")
    for (const id of ["a", "b", "c", "d"]) { start(id); finishWrap(runs, id, outcome()) }
    start("live")
    // "a" is oldest by file time; "b" is past maxDays.
    const day = 86_400_000
    utimesSync(resolve(runs.taskRunsDir, "a.jsonl"), new Date(Date.now() - 3 * 60_000), new Date(Date.now() - 3 * 60_000))
    utimesSync(resolve(runs.taskRunsDir, "b.jsonl"), new Date(Date.now() - 40 * day), new Date(Date.now() - 40 * day))
    expect(pruneTaskRuns(runs, { maxRuns: 2, maxDays: 30 })).toBe(2)
    expect(readdirSync(runs.taskRunsDir).sort()).toEqual(["c.jsonl", "d.jsonl", "live.jsonl"])
    expect(runs.get("engine")?.status).toBe("completed")
    expect(pruneTaskRuns(runs, { maxRuns: 2, maxDays: 30 })).toBe(0)
  })
})

describe("tools that change nothing", () => {
  it("tells reads from writes; unknown tools count as writes", () => {
    for (const n of ["Read", "Grep", "WebSearch", "mcp__agentx__agentx_wiki_query", "mcp__github__get_issue", "mcp__linear__list_issues"]) {
      expect(isReadOnlyToolUse(n), n).toBe(true)
    }
    for (const n of [
      "Bash", "Edit", "Write", "mcp__github__create_pull_request", "mcp__agentx__agentx_send", "mystery",
      // A write verb first wins over a lookup word last.
      "mcp__crm__set_status", "mcp__crm__update_status", "mcp__todo__clear_list", "mcp__x__delete_search",
      "mcp__x__add_query", "mcp__x__remove_list", "mcp__x__send_status", "mcp__x__start_check",
      // A read verb first, a write joined on (#877).
      "mcp__x__get_or_create_user", "mcp__x__find_and_update", "mcp__x__getOrCreateUser", "mcp__x__fetch_then_delete",
    ]) {
      expect(isReadOnlyToolUse(n), n).toBe(false)
    }
    expect(isReadOnlyToolUse("mcp__x__issue_status")).toBe(true)
    // A write word that is the thing read, not a second verb, stays a read.
    expect(isReadOnlyToolUse("mcp__github__get_open_issues")).toBe(true)
    expect(isReadOnlyToolUse("mcp__x__getIssue")).toBe(true)
    expect(isReadOnlyToolUse("mcp__agentx__agentx_workflow", { action: "match" })).toBe(true)
    expect(isReadOnlyToolUse("mcp__agentx__agentx_workflow", { action: "start" })).toBe(false)
  })

  it("reads tool calls from a stream event", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "/x" } }] } }
    expect(toolUsesOf(ev)).toEqual([{ name: "Read", input: { file_path: "/x" } }])
    expect(toolUsesOf({ type: "user" })).toEqual([])
  })
})

describe("the agent's plan and step actions", () => {
  function deps(workflowRunId?: string): FollowUpApiDeps {
    return {
      dispatcher: {} as any, store: { get: () => null, list: () => [], save: (w: any) => w } as any, runs,
      // Follow-ups off: plan and step still work, they belong to the wrap.
      settings: { enabled: false, agents: {}, stallMinutes: 30, maxNudges: 2, approval: "step" },
      hasAgent: (id) => id === "builder",
      runningTurn: (_id, proof) => (proof.taskId === "t1" ? { channel: "telegram", chatId: "c1", ...(workflowRunId ? { workflowRunId } : {}) } : null),
      taskRuns: runs,
    }
  }
  const post = (d: FollowUpApiDeps, body: Record<string, unknown>) => handleFollowUpApi("POST", "/follow-up", { agentId: "builder", ...body }, d, { taskId: "t1" })

  it("lets the turn the run wraps write its plan and report steps", async () => {
    start()
    const d = deps("run-1")
    const r = await post(d, { action: "plan", runId: "run-1", steps: ["Check", "Fix"] })
    expect(r.status).toBe(200)
    expect((r.body as any).plan.map((s: any) => s.title)).toEqual(["Check", "Fix"])
    const s = await post(d, { action: "step", runId: "run-1", step: "step1", status: "done", note: "ok" })
    expect(s.status).toBe(200)
    expect((s.body as any).run.step).toBe("step2")
  })

  it("refuses another turn, or a run that is not this turn's", async () => {
    start()
    expect((await post(deps("other-run"), { action: "plan", runId: "run-1", steps: ["x"] })).status).toBe(403)
    expect((await handleFollowUpApi("POST", "/follow-up", { agentId: "builder", action: "plan", runId: "run-1", steps: ["x"] }, deps("run-1"), { taskId: "nope" })).status).toBe(403)
    expect((await post(deps("run-1"), { action: "plan" })).status).toBe(400)
  })
})

describe("engine runs record step times too", () => {
  it("stamps startedAt and durationMs on each node execution", async () => {
    const store = new WorkflowStore({ baseDir: dir })
    store.save(workflowSchema.parse({
      id: "two", title: "Two steps",
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
        { id: "think", type: "agent", config: { agentId: "builder", prompt: "go" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "start", to: "think" }, { from: "think", to: "done" }],
    }))
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", timers: new TimerService({ baseDir: resolve(dir, "_t") }), channels: {},
      agents: { execute: async (): Promise<AgentExecuteResponse> => { await new Promise((r) => setTimeout(r, 15)); return { content: "fine" } } },
    })
    const { run } = await dispatcher.startRun({ workflowId: "two", meta: { followUp: false } })
    const end = Date.now() + 3000
    while (runs.get(run!.id)?.status === "running" && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    const final = runs.get(run!.id)!
    expect(final.status).toBe("completed")
    const think = final.history.find((h) => h.nodeId === "think")!
    expect(think.startedAt).toBeTruthy()
    expect(think.durationMs).toBeGreaterThanOrEqual(10)
    const rec = runRecord(final)
    expect(rec.mode).toBe("workflow")
    expect(rec.steps.find((s) => s.id === "think")?.durationMs).toBe(think.durationMs)
  })
})

describe("what the agent and the live page see", () => {
  it("names the run in one short hint", () => {
    const hint = wrapHintText("run-1")
    expect(hint).toContain("[Workflow run run-1]")
    expect(hint).toContain('action:"plan"')
    // The overhead per wrapped turn, in characters (about 4 per token).
    expect(hint.length).toBeLessThan(700)
  })

  it("keeps the hint whole when mined procedures fill their own budget", () => {
    const procedures = "[Procedure] " + "step and step again ".repeat(400)
    const ctx = buildAgentContext({
      channel: "telegram", agentId: "builder", agentName: "Builder", sender: "Sam", message: "rename the report",
      procedureContext: procedures, workflowRunContext: wrapHintText("run-1"),
    })
    expect(ctx).toContain(wrapHintText("run-1"))
  })

  it("ships a live page script that parses and shows a task's workflow step", () => {
    const html = renderLivePage()
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    expect(html).toContain("function workflowLine(w)")
    expect(html).toContain("workflowLine(t.workflow)")
  })
})

describe("changing the setting (CLI and dashboard)", () => {
  it("saves the global value, the exemption and one agent's override, and turns the engine on", async () => {
    const { writeFileSync, readFileSync } = await import("fs")
    const { readRequiredSettings, updateRequiredSettings } = await import("../src/daemon/workflow-required-settings")
    const path = join(dir, "agentx.json")
    writeFileSync(path, JSON.stringify({ node: { id: "n", name: "n" } }))
    expect(readRequiredSettings(path)).toEqual({ enabled: false, agents: {}, exemptQuestions: true, engine: false })

    expect((await updateRequiredSettings({ enabled: true, exemptQuestions: false }, { configPath: path, reload: false })).success).toBe(true)
    expect((await updateRequiredSettings({ agent: { id: "builder", value: false } }, { configPath: path, reload: false })).success).toBe(true)
    expect(readRequiredSettings(path)).toEqual({ enabled: true, agents: { builder: false }, exemptQuestions: false, engine: true })

    expect((await updateRequiredSettings({ agent: { id: "builder", value: null } }, { configPath: path, reload: false })).success).toBe(true)
    expect(JSON.parse(readFileSync(path, "utf-8")).workflows.required.agents).toEqual({})
    expect((await updateRequiredSettings({ agent: { id: "../x", value: true } }, { configPath: path, reload: false })).success).toBe(false)
  })
})
