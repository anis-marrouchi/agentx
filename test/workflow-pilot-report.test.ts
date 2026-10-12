import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, listTracesForRuns, type TraceRecord } from "../src/storage/traces"
import { comparePilot, handBackReason, liveRunIdOf, traceCostUsd } from "../src/storage/workflow-pilot"
import type { WorkflowRun } from "../src/workflows/types"

const PRICING = { "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } }

function trace(over: Partial<TraceRecord>): TraceRecord {
  return {
    taskId: over.taskId ?? Math.random().toString(36).slice(2),
    agentId: "sweeper", channel: "workflow", chatId: null,
    workflowRunId: null, workflowId: null, workflowNodeId: null,
    intentEventId: null, intentDecidedBy: null, resumeSessionId: null, finalSessionId: null,
    model: "claude-sonnet-4-6", status: "ok", startedAt: 0, finishedAt: 1, durationMs: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    tier2InputTokens: 0, tier2OutputTokens: 0, tier2CacheReadTokens: 0, tier2CacheCreateTokens: 0,
    resumed: null, jevArm: null, numTurns: null, injectedContext: null, error: null,
    messagePreview: null, originalMessage: null, finalResponse: null,
    ...over,
  }
}

function run(over: Partial<WorkflowRun> & { id: string; workflowId: string }): WorkflowRun {
  return {
    workflowVersion: 2, homeNode: "local", status: "completed", context: {}, pending: [],
    entityRef: { backend: "test", id: over.id }, history: [],
    parentRunId: null, parentNodeId: null, rootRunId: over.id, depth: 0, joinCounters: {},
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
    ...over,
  } as WorkflowRun
}

describe("traceCostUsd", () => {
  it("prices tier-1 tokens at the table rate and tier-2 at 1.5x", () => {
    const t1 = trace({ inputTokens: 1_000_000 })
    const t2 = trace({ tier2InputTokens: 1_000_000 })
    expect(traceCostUsd(t1, PRICING)).toBeCloseTo(3)
    expect(traceCostUsd(t2, PRICING)).toBeCloseTo(4.5)
  })
})

describe("handBackReason", () => {
  it("is null for a completed run, or one that ran out of steps", () => {
    expect(handBackReason({ status: "completed", history: [], pending: [] })).toBeNull()
    expect(handBackReason({ status: "running", history: [], pending: [] })).toBeNull()
  })
  it("names a step that returned the hand-back token", () => {
    const history = [{ at: "", nodeId: "decide", inputKeys: [], status: "ok", idempotencyKey: "k", output: { result: "FALLBACK" } }] as WorkflowRun["history"]
    expect(handBackReason({ status: "completed", history, pending: [] })).toBe('step "decide" handed back')
  })
  it("counts a failed run as handed back", () => {
    expect(handBackReason({ status: "failed", history: [], pending: [] })).toBe("run failed")
  })
})

describe("liveRunIdOf", () => {
  it("reads the parent run, else a liveRunId input", () => {
    expect(liveRunIdOf({ parentRunId: "L1", context: {} })).toBe("L1")
    expect(liveRunIdOf({ parentRunId: null, context: { start: { liveRunId: "L2" } } })).toBe("L2")
    expect(liveRunIdOf({ parentRunId: null, context: {} })).toBeNull()
  })
})

describe("comparePilot", () => {
  const runs = [
    run({ id: "L1", workflowId: "sweep" }),
    run({ id: "L2", workflowId: "sweep" }),
    run({ id: "L3", workflowId: "sweep" }), // ended at the script: no model call
    run({ id: "P1", workflowId: "sweep-pilot", parentRunId: "L1" }),
    run({ id: "P2", workflowId: "sweep-pilot", status: "failed", context: { start: { liveRunId: "L2" } } }),
    run({ id: "P9", workflowId: "sweep-pilot" }), // no live run
  ]
  const traces = [
    trace({ workflowRunId: "L1", inputTokens: 100_000 }), // $0.30
    trace({ workflowRunId: "L2", inputTokens: 200_000 }), // $0.60
    trace({ workflowRunId: "L3", agentId: "workflow:action.run" }),
    trace({ workflowRunId: "P1", inputTokens: 10_000 }), // $0.03
    trace({ workflowRunId: "P2", inputTokens: 20_000 }), // $0.06, then handed back
  ]
  const report = comparePilot({ liveWorkflow: "sweep", pilotWorkflow: "sweep-pilot", runs, traces, pricing: PRICING })

  it("leaves out live runs that never reached a model", () => {
    expect(report.live.runs).toBe(2)
    expect(report.live.totalCostUsd).toBeCloseTo(0.9)
  })
  it("pairs pilot runs by parent run or liveRunId input", () => {
    expect(report.paired.runs).toBe(2)
    expect(report.orphanPilot).toBe(1)
    expect(report.unpairedLive).toBe(0)
  })
  it("charges a hand-back the pilot cost plus the live cost, and does not count it as a failure", () => {
    const p2 = report.pairs.find((p) => p.live.runId === "L2")!
    expect(p2.handedBack).toBe("run failed")
    expect(p2.pilotPathCostUsd).toBeCloseTo(0.66)
    expect(report.paired.handedBack).toBe(1)
    expect(report.paired.handBackShare).toBe(0.5)
    expect(report.paired.pilotPath.failed).toBe(0)
    expect(report.paired.pilotPath.totalCostUsd).toBeCloseTo(0.69)
    expect(report.paired.saving).toBeCloseTo(1 - 0.69 / 0.9)
  })
})

describe("listTracesForRuns", () => {
  let tmp: string
  beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-pilot-")) })
  afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

  it("returns the rows of the named runs only", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const a = recordTraceStart(db, { agentId: "sweeper", channel: "workflow", chatId: "workflow:R1", workflowRunId: "R1" })
    recordTraceEnd(db, a, { status: "ok", inputTokens: 5 })
    recordTraceStart(db, { agentId: "sweeper", channel: "workflow", chatId: "workflow:R2", workflowRunId: "R2" })
    recordTraceStart(db, { agentId: "other", channel: "telegram", chatId: "c" })
    const rows = listTracesForRuns(db, ["R1"])
    expect(rows.map((r) => r.taskId)).toEqual([a])
    expect(rows[0].inputTokens).toBe(5)
    expect(listTracesForRuns(db, [])).toEqual([])
  })
})
