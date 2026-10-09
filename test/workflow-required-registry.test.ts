import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// workflows.required (#858) through the registry: a task that reaches an
// agent runs inside a workflow run the live list shows with its step, the
// agent is told the run, a plain question leaves no run, and a workflow
// step's own turn is never wrapped again.

const seen = vi.hoisted(() => ({
  prompts: [] as string[],
  during: [] as any[],
  events: [] as any[],
  list: null as null | (() => any[]),
  error: undefined as string | undefined,
  onTurn: null as null | (() => void),
}))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any, _p: any, _d: any, history: any, _r: any, onEvent?: (e: any) => void) => {
      seen.prompts.push(JSON.stringify([task, history]))
      for (const e of seen.events) onEvent?.(e)
      if (seen.list) seen.during.push(seen.list())
      seen.onTurn?.()
      if (seen.error) return Promise.resolve({ content: "", duration: 1, error: seen.error })
      return Promise.resolve({ content: "ok", duration: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0 } })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { RunStore, WorkflowStore, workflowSchema } from "../src/workflows"
import { runRecord } from "../src/workflows/required"

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-wf-required-reg-"))
  process.chdir(dir)
  seen.prompts.length = 0
  seen.during.length = 0
  seen.events = []
  seen.list = null
  seen.error = undefined
  seen.onTurn = null
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function setup(required: Record<string, unknown>, matching: Record<string, unknown> = {}) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
    workflows: { enabled: true, dir: ".agentx/workflows", followUp: { enabled: false }, required, matching },
  })
  const r = new AgentRegistry(config, () => {})
  const runs = new RunStore({ baseDir: join(dir, ".agentx/workflows"), nodeId: "test" })
  r.setWorkflowRunStore(runs)
  seen.list = () => r.list().find((a) => a.id === "ops")!.runningTasks
  return { r, runs }
}

const writeTool = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }
const readTool = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }

describe("workflows.required in the registry", () => {
  it("runs the task inside a linear run, shown live with its step", async () => {
    const { r, runs } = setup({ enabled: true })
    seen.events = [writeTool]
    const res = await r.execute({ message: "rename the report", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    expect(res.error).toBeUndefined()
    const [run] = runs.list()
    expect(run).toMatchObject({ workflowId: "task", status: "completed" })
    expect(run.history.map((h) => h.nodeId)).toEqual(["reply", "done"])
    expect(seen.prompts[0]).toContain(`[Workflow run ${run.id}]`)
    expect(seen.during[0][0].workflow).toMatchObject({ runId: run.id, workflowId: "task", step: "reply" })
    // The task itself is not made a workflow step: restart resume and
    // stop treat it as before.
    expect(JSON.parse(seen.prompts[0])[0].workflowRunId).toBeUndefined()
  })

  it("closes the run as failed when the turn fails", async () => {
    const { r, runs } = setup({ enabled: true })
    seen.error = "The model returned an error"
    await r.execute({ message: "rename the report", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    const [run] = runs.list()
    expect(run.status).toBe("failed")
    expect(run.history.at(-1)).toMatchObject({ nodeId: "reply", status: "failed", note: "The model returned an error" })
  })

  it("closes a stopped turn as canceled, not failed (#857)", async () => {
    const { r, runs } = setup({ enabled: true })
    seen.events = [writeTool]
    // A stop signal lands mid-turn; the runtime then reports the abort.
    seen.onTurn = () => {
      const id = r.list().find((a) => a.id === "ops")!.runningTasks[0].id
      expect(r.stopRunningTask(id, "stopped by owner: deploy")).toBe(true)
      seen.error = "aborted"
    }
    const res = await r.execute({ message: "rename the report", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    expect(res.errorKind).toBe("stopped")
    const [run] = runs.list()
    expect(run.status).toBe("canceled")
    expect(run.history.some((h) => h.status === "failed")).toBe(false)
    expect(run.history.at(-1)).toMatchObject({ nodeId: "reply", status: "skipped", note: "stopped: stopped by owner: deploy" })
    expect(runRecord(run)).toMatchObject({ status: "canceled", failedAt: null })
  })

  it("leaves no run for a plain question", async () => {
    const { r, runs } = setup({ enabled: true })
    seen.events = [readTool]
    await r.execute({ message: "what is on today?", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    expect(runs.list()).toEqual([])
    // ...but keeps one when the exemption is off.
    const second = setup({ enabled: true, exemptQuestions: false })
    await second.r.execute({ message: "what is on today?", agentId: "ops", context: { channel: "api", chatId: "c2" } })
    expect(second.runs.list()).toHaveLength(1)
  })

  it("does nothing when off, or for this agent's override, or for a workflow step", async () => {
    const off = setup({ enabled: false })
    seen.events = [writeTool]
    await off.r.execute({ message: "x", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    expect(off.runs.list()).toEqual([])
    expect(seen.prompts[0]).not.toContain("[Workflow run")

    const optedOut = setup({ enabled: true, agents: { ops: false } })
    await optedOut.r.execute({ message: "x", agentId: "ops", context: { channel: "api", chatId: "c1" } })
    expect(optedOut.runs.list()).toEqual([])

    const step = setup({ enabled: true })
    await step.r.execute({ message: "x", agentId: "ops", workflowRunId: "parent-run", context: { channel: "workflow", chatId: "workflow:parent-run" } })
    expect(step.runs.list()).toEqual([])
    expect(seen.during.at(-1)[0].workflow).toMatchObject({ runId: "parent-run" })
  })

  it("starts a saved workflow that fits a person's request, followed", async () => {
    const { r, runs } = setup({ enabled: true }, { autoRunThreshold: 0.6 })
    new WorkflowStore({ baseDir: join(dir, ".agentx/workflows") }).save(workflowSchema.parse({
      id: "invoice-chase", title: "Chase an unpaid invoice", description: "remind a client about an unpaid invoice",
      ownerAgent: "ops", tags: ["telegram"],
      nodes: [{ id: "start", type: "trigger.manual", config: {} }, { id: "done", type: "end", config: {} }],
      edges: [{ from: "start", to: "done" }],
    }))
    const calls: any[] = []
    r.setWorkflowAutoRunner(async (input) => { calls.push(input); return { runId: "saved-run", title: "Chase an unpaid invoice" } })
    const res = await r.execute({
      message: "chase the unpaid invoice for the client", agentId: "ops",
      context: { channel: "telegram", chatId: "c1", senderId: "u1", sender: "Sam" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ workflowId: "invoice-chase", follow: true })
    expect(res.content).toContain("Chase an unpaid invoice")
    expect(res.metadata).toMatchObject({ handledByWorkflow: "invoice-chase", workflowRunId: "saved-run" })
    // The saved workflow is the task's run: no wrap, and the agent did not run.
    expect(runs.list()).toEqual([])
    expect(seen.prompts).toHaveLength(0)
  })

  it("falls back to its own run when the saved workflow cannot start", async () => {
    const { r, runs } = setup({ enabled: true }, { autoRunThreshold: 0.6 })
    new WorkflowStore({ baseDir: join(dir, ".agentx/workflows") }).save(workflowSchema.parse({
      id: "invoice-chase", title: "Chase an unpaid invoice", ownerAgent: "ops", tags: ["telegram"],
      nodes: [{ id: "start", type: "trigger.manual", config: {} }, { id: "done", type: "end", config: {} }],
      edges: [{ from: "start", to: "done" }],
    }))
    r.setWorkflowAutoRunner(async () => { throw new Error("inputSchema requires client") })
    seen.events = [writeTool]
    await r.execute({ message: "chase the unpaid invoice", agentId: "ops", context: { channel: "telegram", chatId: "c1", senderId: "u1", sender: "Sam" } })
    expect(runs.list()).toHaveLength(1)
    expect(runs.list()[0].workflowId).toBe("task")
  })
})
