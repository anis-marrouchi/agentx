import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, listTraces } from "../src/storage/traces"
import { readSignals, setSignalDb, SIGNAL_KINDS, SIGNAL_MEANING } from "../src/improve/signals"
import { KIND_WEIGHT, normalizeDetail } from "../src/improve/rank"
import {
  costSignals, emitCostSignals, jobTypeOf, jobKey, readCostHistory,
  type CostRun, type CostHistory,
} from "../src/improve/cost"
import type { CallUsage } from "../src/daemon/token-tracker"
import { kindLines } from "../src/commands/improve"

// #1995: four cost signals so the nightly pass ranks token waste like it
// ranks failures. `costSignals` is pure; `readCostHistory` reads the job
// type's past runs from task_traces, the one usage store.

const MIN = 60_000
const NOW = Date.parse("2026-11-20T12:00:00Z")
const OPUS = "claude-opus-5-5"
const HAIKU = "claude-haiku-5"

function call(read: number, write: number, extra: Partial<CallUsage> = {}): CallUsage {
  return { inputTokens: 10, outputTokens: 500, cacheReadTokens: read, cacheCreateTokens: write, model: OPUS, ...extra }
}

function run(calls: CallUsage[], over: Partial<CostRun> = {}): CostRun {
  const usage = calls.reduce((s, c) => ({
    inputTokens: s.inputTokens + c.inputTokens, outputTokens: s.outputTokens + c.outputTokens,
    cacheReadTokens: s.cacheReadTokens + c.cacheReadTokens, cacheCreateTokens: s.cacheCreateTokens + c.cacheCreateTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })
  return {
    taskId: "01TRACE", agentId: "builder", channel: "cron", chatId: "cron:nightly-report",
    startedAt: NOW - MIN, resumed: false, model: OPUS, usage, calls, ...over,
  }
}

const kinds = (r: CostRun, h: CostHistory = {}) => costSignals(r, h).map((s) => s.kind)
/** A normal run: a warm start that reads its prefix, then small turns. */
const normal = () => run([call(40_000, 1_000), call(41_000, 1_500), call(42_500, 900)])
const past = (n: number, total: number) => Array.from({ length: n }, () => total)

describe("the four kinds", () => {
  it("are known kinds with a meaning and a weight below the owner's own signals", () => {
    for (const k of ["job_cost_high", "start_no_cache_reuse", "context_rewrite", "model_switch"] as const) {
      expect(SIGNAL_KINDS).toContain(k)
      expect(SIGNAL_MEANING[k].length).toBeGreaterThan(10)
    }
    expect(KIND_WEIGHT.job_cost_high).toBe(2)
    expect(KIND_WEIGHT.start_no_cache_reuse).toBe(1)
    expect(KIND_WEIGHT.context_rewrite).toBe(1)
    expect(KIND_WEIGHT.model_switch).toBe(1)
  })

  it("a normal run is silent, with every history a run can have", () => {
    expect(kinds(normal(), { pastTotals: past(20, 130_000), lastAgentRun: { finishedAt: NOW - 2 * MIN, model: OPUS }, sessionPrevModel: OPUS })).toEqual([])
  })
})

describe("job_cost_high", () => {
  const big = () => run([call(400_000, 2_000), call(402_000, 2_000)])

  it("fires at 3x the job type's median with 10 past runs, naming the job type", () => {
    const s = costSignals(big(), { pastTotals: past(10, 100_000) })
    expect(s).toEqual([expect.objectContaining({ kind: "job_cost_high", agentId: "builder", ref: "01TRACE" })])
    expect(s[0].detail).toMatch(/^job cron nightly-report: 8(\.\d)?x median/)
  })

  it("is silent under 3x, under 50k tokens, and with fewer than 10 past runs", () => {
    expect(kinds(big(), { pastTotals: past(10, 300_000) })).toEqual([])
    expect(kinds(run([call(20_000, 1_000)]), { pastTotals: past(10, 5_000) })).toEqual([])
    expect(kinds(big(), { pastTotals: past(9, 100_000) })).toEqual([])
  })
})

describe("start_no_cache_reuse", () => {
  const fresh = () => run([call(0, 40_000), call(40_000, 800)])
  const recent = { lastAgentRun: { finishedAt: NOW - 3 * MIN, model: OPUS } }

  it("fires on a new session that wrote its prefix again minutes after the same agent's run", () => {
    const s = costSignals(fresh(), recent)
    expect(s.map((x) => x.kind)).toEqual(["start_no_cache_reuse"])
    expect(s[0].detail).toBe("job cron nightly-report: fresh start wrote 40k, last run 2 min ago")
  })

  it("is silent when resumed, when the last run is older than 5 min, on another model, or when it read from cache", () => {
    expect(kinds({ ...fresh(), resumed: true }, recent)).not.toContain("start_no_cache_reuse")
    expect(kinds(fresh(), { lastAgentRun: { finishedAt: NOW - 7 * MIN, model: OPUS } })).toEqual([])
    expect(kinds(fresh(), { lastAgentRun: { finishedAt: NOW - 3 * MIN, model: HAIKU } })).toEqual([])
    expect(kinds(fresh(), { lastAgentRun: null })).toEqual([])
    expect(kinds(run([call(5_000, 40_000)]), recent)).toEqual([])
  })
})

describe("context_rewrite", () => {
  it("fires when a later call writes 80% or more of a 20k+ context", () => {
    const s = costSignals(run([call(40_000, 1_000), call(0, 60_000)]))
    expect(s.map((x) => x.kind)).toEqual(["context_rewrite"])
    expect(s[0].detail).toBe("job cron nightly-report: rewrite 60k of 60k")
  })

  it("counts the first call of a resumed run, not of a new one", () => {
    expect(kinds(run([call(0, 50_000)], { resumed: true }))).toEqual(["context_rewrite"])
    expect(kinds(run([call(0, 50_000)]))).toEqual([])
  })

  it("is silent for a small context or a partial write", () => {
    expect(kinds(run([call(1_000, 1_000), call(0, 15_000)]))).toEqual([])
    expect(kinds(run([call(40_000, 1_000), call(30_000, 20_000)]))).toEqual([])
  })
})

describe("model_switch", () => {
  it("fires when the main thread changes model inside a run", () => {
    const s = costSignals(run([call(40_000, 500), call(40_000, 500, { model: HAIKU })]))
    expect(s.map((x) => x.kind)).toEqual(["model_switch"])
    expect(s[0].detail).toBe(`job cron nightly-report: ${OPUS} → ${HAIKU}`)
  })

  it("fires when a resumed run is on another model than the session's previous run", () => {
    expect(kinds(run([call(40_000, 500)], { resumed: true }), { sessionPrevModel: HAIKU })).toEqual(["model_switch"])
    expect(kinds(run([call(40_000, 500)], { resumed: true }), { sessionPrevModel: OPUS })).toEqual([])
  })
})

describe("subagent calls (B3)", () => {
  it("a run whose subagent writes a fresh context on another model fires none of the three", () => {
    const r = run([call(40_000, 500), call(0, 45_000, { model: HAIKU, sub: true }), call(41_000, 600)])
    expect(kinds(r, { lastAgentRun: { finishedAt: NOW - 2 * MIN, model: OPUS } })).toEqual([])
  })

  it("a subagent's first call does not count as the run's fresh start", () => {
    const r = run([call(0, 45_000, { model: HAIKU, sub: true }), call(40_000, 500)])
    expect(kinds(r, { lastAgentRun: { finishedAt: NOW - 2 * MIN, model: OPUS } })).toEqual([])
  })

  it("job_cost_high still counts every paid token, subagents included", () => {
    const r = run([call(40_000, 500), call(300_000, 45_000, { model: HAIKU, sub: true })])
    expect(kinds(r, { pastTotals: past(10, 50_000) })).toEqual(["job_cost_high"])
  })
})

describe("job type (B1, B4)", () => {
  it("is agent + channel + workflow id or cron job id, never the run id", () => {
    expect(jobTypeOf("builder", "workflow", "workflow:run-1", "release-notes")).toEqual({ agentId: "builder", channel: "workflow", workflowId: "release-notes", cronId: null })
    expect(jobTypeOf("builder", "cron", "cron:nightly-report", null)).toEqual({ agentId: "builder", channel: "cron", workflowId: null, cronId: "nightly-report" })
    expect(jobTypeOf("builder", "telegram", "12345", null)).toEqual({ agentId: "builder", channel: "telegram", workflowId: null, cronId: null })
    expect(jobKey(jobTypeOf("builder", "telegram", "12345", null))).toBe("job telegram chat")
  })

  it("every detail starts with the job key and survives normalisation as one group", () => {
    const a = costSignals(run([call(40_000, 1_000), call(0, 60_000)]))[0].detail!
    const b = costSignals(run([call(90_000, 1_000), call(0, 95_000)], { taskId: "01OTHER" }))[0].detail!
    expect(normalizeDetail("context_rewrite", a)).toBe(normalizeDetail("context_rewrite", b))
    expect(normalizeDetail("context_rewrite", a)).toMatch(/^job cron nightly-report: /)
  })
})

// --- With the database: task_traces is the baseline ---

let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-cost-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  setSignalDb(null)
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

/** A finished trace with `total` tokens, ended `ago` ms before NOW. */
function trace(o: { agent?: string; channel?: string; chat: string; workflowId?: string; total: number; ago: number; status?: "ok" | "error"; model?: string; session?: string }): string {
  const id = recordTraceStart(db, { agentId: o.agent ?? "builder", channel: o.channel ?? "workflow", chatId: o.chat, workflowId: o.workflowId ?? null })
  recordTraceEnd(db, id, { status: o.status ?? "ok", inputTokens: 10, outputTokens: 0, cacheReadTokens: o.total - 10, cacheCreateTokens: 0, model: o.model ?? OPUS, finalSessionId: o.session ?? null })
  db.prepare("UPDATE task_traces SET started_at = ?, finished_at = ? WHERE task_id = ?").run(NOW - o.ago - MIN, NOW - o.ago, id)
  return id
}

describe("readCostHistory", () => {
  it("two runs of one workflow share a job type: the baseline counts every run of the workflow (B1)", () => {
    for (let i = 0; i < 10; i++) trace({ chat: `workflow:run-${i}`, workflowId: "release-notes", total: 100_000, ago: (i + 1) * 3_600_000 })
    trace({ chat: "workflow:run-x", workflowId: "other-flow", total: 1_000, ago: 3_600_000 })
    trace({ chat: "workflow:run-y", workflowId: "release-notes", total: 1_000, ago: 3_600_000, status: "error" })
    const r = run([call(400_000, 2_000)], { channel: "workflow", chatId: "workflow:run-new", workflowId: "release-notes" })
    const h = readCostHistory(db, r, NOW)
    expect(h.pastTotals).toHaveLength(10)
    expect(h.pastTotals!.every((t) => t === 100_000)).toBe(true)
    expect(costSignals(r, h).map((s) => s.kind)).toEqual(["job_cost_high"])
  })

  it("leaves out runs older than 14 days and zero-usage runs (S2)", () => {
    for (let i = 0; i < 6; i++) trace({ channel: "cron", chat: "cron:nightly-report", total: 100_000, ago: (i + 1) * 3_600_000 })
    for (let i = 0; i < 6; i++) trace({ channel: "cron", chat: "cron:nightly-report", total: 100_000, ago: 15 * 86_400_000 + i })
    const zero = recordTraceStart(db, { agentId: "builder", channel: "cron", chatId: "cron:nightly-report" })
    recordTraceEnd(db, zero, { status: "ok" })
    expect(readCostHistory(db, run([call(400_000, 2_000)]), NOW).pastTotals).toHaveLength(6)
  })

  it("finds the same agent's last finished run, and the session's previous model", () => {
    trace({ channel: "telegram", chat: "c-1", total: 50_000, ago: 3 * MIN, model: HAIKU, session: "sess-a" })
    const fresh = run([call(0, 40_000)], { channel: "telegram", chatId: "c-2" })
    expect(readCostHistory(db, fresh, NOW).lastAgentRun).toMatchObject({ model: HAIKU })
    const resumed = run([call(40_000, 500)], { channel: "telegram", chatId: "c-1", resumed: true, resumeSessionId: "sess-a" })
    expect(readCostHistory(db, resumed, NOW).sessionPrevModel).toBe(HAIKU)
  })
})

describe("emitCostSignals", () => {
  it("records through the signal sink, with the trace id as ref, and never throws", () => {
    setSignalDb(db)
    emitCostSignals(run([call(40_000, 1_000), call(0, 60_000)]), NOW)
    expect(readSignals(db, 0).map((r) => [r.kind, r.ref])).toEqual([["context_rewrite", "01TRACE"]])
    setSignalDb(null)
    expect(() => emitCostSignals(run([call(0, 60_000)]), NOW)).not.toThrow()
  })
})

describe("task_traces.workflow_id (B1)", () => {
  it("a workflow step's task:started writes its workflow id", async () => {
    const { attachSqliteSubscribers } = await import("../src/storage/subscribers")
    const { getEventBus } = await import("../src/events/bus")
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      bus.emit("task:started", { agentId: "builder", channel: "workflow", chatId: "workflow:run-7", messagePreview: "step", at: new Date().toISOString(), workflowId: "release-notes" })
      const [t] = listTraces(db, { agentId: "builder" })
      expect(t.workflowRunId).toBe("run-7")
      expect(db.prepare("SELECT workflow_id AS w FROM task_traces WHERE task_id = ?").get(t.taskId)).toEqual({ w: "release-notes" })
    } finally {
      dispose()
      bus.removeAllListeners()
    }
  })
})

describe("agentx improve kinds", () => {
  it("lists every kind with its weight and meaning, the cost kinds included", () => {
    const text = kindLines().join("\n")
    for (const k of SIGNAL_KINDS) expect(text).toContain(k)
    expect(text).toContain(SIGNAL_MEANING.context_rewrite)
  })
})
