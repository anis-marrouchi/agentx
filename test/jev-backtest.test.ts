import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"
import { tmpdir } from "os"
import path from "path"
import { configureDecisions, resetDecisionsRuntime } from "../src/decisions/seat"
import {
  _resetDecisionBackendsForTesting,
  registerDecisionBackend,
  type DecisionBackend,
  type DecisionRequest,
  type DecisionResponse,
} from "../src/decisions/backend"
import { finalizeAnswer } from "../src/decisions/normalize"
import type { AnswersFor, AnyAnswer, Questions } from "../src/decisions/types"
import { WAKE_GATE_SEAT } from "../src/decisions/seats/wake-gate"
import { TASK_TIER_SEAT } from "../src/decisions/seats/task-tier"
import { CACHE_AWARE_PRICING } from "../src/daemon/token-tracker"
import {
  buildReport,
  decideTraces,
  dropZeroCostWorkflowRows,
  gateWouldSkip,
  isZeroCostWorkflowRow,
  parseTraceExport,
  proxyLabel,
  renderReport,
  sampleRows,
  tierWouldDowngrade,
  toCsv,
  SAMPLE_COLUMNS,
  type BacktestTrace,
  type Verdict,
} from "../scripts/backtest-jev-lib"

const FIXTURE = path.resolve(__dirname, "__fixtures__/jev-backtest-traces.json")
const ROOT = path.resolve(__dirname, "..")

/** A backend that answers from the state, so the expected verdicts can be
 *  read off the fixture. Mirrors what a good gate would say: bot noise does
 *  not need a run, a review request is borderline, everything else does;
 *  a thank-you or a routine report does not need the flagship. */
function scriptedBackend(): DecisionBackend {
  return {
    name: "scripted",
    capabilities: {
      probabilitySource: "synthetic", calibratedProbabilities: false,
      maxChoiceOptions: 255, maxStateChars: 24_000, parallelQuestions: true, images: false,
    },
    async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionResponse<Q>> {
      const state = request.state as Record<string, unknown>
      const answers: Record<string, AnyAnswer> = {}
      for (const [name, q] of Object.entries(request.questions)) {
        let p = 0.9
        if (name === "needsRun") {
          const event = String(state.event ?? "")
          if (event.includes("[bot]")) p = 0.05
          else if (event.includes("[pull_request")) p = 0.15
        } else if (name === "needsFlagship") {
          const task = String(state.task ?? "")
          if (/^(thanks|ok)/i.test(task)) p = 0.1
          else if (task.startsWith("Write the daily report")) p = 0.15
          else p = 0.8
        }
        answers[name] = finalizeAnswer(q, { noul: p }).answer
      }
      return {
        model: "scripted",
        answers: answers as AnswersFor<Q>,
        usage: { inputTokens: 10, outputTokens: 0 },
        meta: { backend: "scripted", structureMode: "mock", answerMode: "probabilities", repaired: false, retries: 0, stateTruncated: false, latencyMs: 0 },
      }
    },
  }
}

/** The fixture as the CLI sees it: parsed, with the one zero-cost workflow
 *  step row (TRACE14) left out. 13 runs. */
function fixtureTraces(): BacktestTrace[] {
  return dropZeroCostWorkflowRows(parseTraceExport(JSON.parse(readFileSync(FIXTURE, "utf-8")))).kept
}

const DECIDE = {
  cheapModel: "claude-haiku-4-5",
  pricing: CACHE_AWARE_PRICING,
  agentModels: { reporter: "claude-sonnet-5" },
  defaultModel: "claude-opus-5",
  concurrency: 3,
}

beforeEach(() => {
  _resetDecisionBackendsForTesting()
  registerDecisionBackend("scripted", scriptedBackend)
  resetDecisionsRuntime()
  configureDecisions({
    enabled: true,
    defaultBackend: "scripted",
    store: null,
    seats: {
      [WAKE_GATE_SEAT]: { mode: "shadow" },
      [TASK_TIER_SEAT]: { mode: "shadow" },
    },
  })
})

afterEach(() => {
  resetDecisionsRuntime()
  _resetDecisionBackendsForTesting()
})

describe("parseTraceExport", () => {
  it("accepts the /traces response shape, drops in-flight rows and duplicates, sorts by start", () => {
    const traces = parseTraceExport(JSON.parse(readFileSync(FIXTURE, "utf-8")))
    expect(traces).toHaveLength(14)
    expect(traces.map((t) => t.status)).not.toContain("in-flight")
    expect(new Set(traces.map((t) => t.taskId)).size).toBe(14)
    for (let i = 1; i < traces.length; i++) expect(traces[i].startedAt).toBeGreaterThanOrEqual(traces[i - 1].startedAt)
  })

  it("accepts a bare array and an array of responses", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf-8"))
    expect(parseTraceExport(raw.traces)).toHaveLength(14)
    expect(parseTraceExport([raw, raw])).toHaveLength(14)
    expect(parseTraceExport({ nothing: true })).toEqual([])
  })

  it("reads a sqlite-style resumed flag", () => {
    const [a, b, c] = parseTraceExport([
      { taskId: "a", agentId: "x", status: "ok", resumed: 1 },
      { taskId: "b", agentId: "x", status: "ok", resumed: 0 },
      { taskId: "c", agentId: "x", status: "ok" },
    ])
    expect([a.resumed, b.resumed, c.resumed]).toEqual([true, false, null])
  })
})

describe("zero-cost workflow rows (#626)", () => {
  const row = (over: Partial<BacktestTrace>): BacktestTrace => ({
    taskId: "t", agentId: "workflow:transform", channel: "workflow", chatId: "wf:step", status: "ok", model: null,
    startedAt: 0, finishedAt: 1, numTurns: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreateTokens: null, tier2InputTokens: null, tier2OutputTokens: null,
    tier2CacheReadTokens: null, tier2CacheCreateTokens: null, resumed: null,
    messagePreview: "transform step", originalMessage: null, ...over,
  })

  it("names a workflow row with no tokens, and nothing else", () => {
    expect(isZeroCostWorkflowRow(row({}))).toBe(true)
    expect(isZeroCostWorkflowRow(row({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }))).toBe(true)
    // A workflow step that ran an agent recorded tokens: kept.
    expect(isZeroCostWorkflowRow(row({ agentId: "reporter", inputTokens: 1500, outputTokens: 900 }))).toBe(false)
    expect(isZeroCostWorkflowRow(row({ agentId: "reporter", tier2CacheReadTokens: 10 }))).toBe(false)
    // A zero-token row on any other channel is still an event the gate saw: kept.
    expect(isZeroCostWorkflowRow(row({ channel: "telegram", agentId: "helper", status: "timeout" }))).toBe(false)
    expect(isZeroCostWorkflowRow(row({ channel: null }))).toBe(false)
  })

  it("splits the fixture into 13 runs and the one dispatcher step row", () => {
    const { kept, dropped } = dropZeroCostWorkflowRows(parseTraceExport(JSON.parse(readFileSync(FIXTURE, "utf-8"))))
    expect(kept).toHaveLength(13)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].taskId).toMatch(/TRACE14$/)
    expect(dropped[0].agentId).toBe("workflow:transform")
    // The agent run inside a workflow stays, on its channel.
    expect(kept.find((t) => t.taskId.endsWith("TRACE15"))?.channel).toBe("workflow")
  })
})

describe("proxyLabel", () => {
  const base: BacktestTrace = {
    taskId: "t", agentId: "a", channel: "telegram", chatId: null, status: "ok", model: null,
    startedAt: 0, finishedAt: null, numTurns: 1, inputTokens: 0, outputTokens: 50,
    cacheReadTokens: 0, cacheCreateTokens: 0, tier2InputTokens: null, tier2OutputTokens: null,
    tier2CacheReadTokens: null, tier2CacheCreateTokens: null, resumed: null,
    messagePreview: null, originalMessage: null,
  }
  it("calls a one-turn short run a noop and a tool-chaining run worked", () => {
    expect(proxyLabel(base)).toBe("noop")
    expect(proxyLabel({ ...base, numTurns: 3 })).toBe("worked")
    expect(proxyLabel({ ...base, outputTokens: 1500 })).toBe("worked")
  })
  it("leaves the boundary, errors and missing turn counts unlabelled", () => {
    expect(proxyLabel({ ...base, numTurns: 2, outputTokens: 500 })).toBe("unknown")
    expect(proxyLabel({ ...base, status: "error", numTurns: 1 })).toBe("unknown")
    expect(proxyLabel({ ...base, numTurns: null })).toBe("unknown")
  })
  it("honours custom rules", () => {
    const rules = { noopMaxTurns: 2, noopMaxOutputTokens: 600, workedMinTurns: 10, workedMinOutputTokens: 5000 }
    expect(proxyLabel({ ...base, numTurns: 2, outputTokens: 500 }, rules)).toBe("noop")
    expect(proxyLabel({ ...base, numTurns: 5 }, rules)).toBe("unknown")
  })
})

describe("decideTraces through the decision layer", () => {
  let verdicts: Verdict[]
  const byId = (id: string) => verdicts.find((v) => v.taskId.endsWith(id))!

  beforeEach(async () => {
    verdicts = await decideTraces(fixtureTraces(), DECIDE)
  })

  it("asks both seats and keeps the answers per trace, in input order", () => {
    expect(verdicts).toHaveLength(13)
    expect(verdicts.every((v) => v.errors.length === 0)).toBe(true)
    expect(byId("TRACE4").pNeedsRun).toBeCloseTo(0.05)
    expect(byId("TRACE1").pNeedsRun).toBeCloseTo(0.9)
    expect(byId("TRACE1").pNeedsFlagship).toBeCloseTo(0.8)
  })

  it("blocks the tier where live routing would: a chosen-model channel and a warm follow-up", () => {
    expect(byId("TRACE9").tierBlocked).toBe("channel keeps its model")
    expect(byId("TRACE9").pNeedsFlagship).toBeNull()
    // TRACE2 resumes chat-1 four minutes after TRACE1 finished.
    expect(byId("TRACE2").tierBlocked).toBe("follow-up on a warm cache")
    // TRACE11 resumes chat-9 more than two hours after TRACE10: cache cold, routable.
    expect(byId("TRACE11").tierBlocked).toBeNull()
    expect(byId("TRACE11").pNeedsFlagship).toBeCloseTo(0.8)
  })

  it("prices each run at its own model, the agent's model, or the default", () => {
    const t4 = byId("TRACE4")
    expect(t4.modelSource).toBe("trace")
    // 900 in, 60 out, 120k cache read, 2k cache write at opus-5 list prices.
    expect(t4.costUsd).toBeCloseTo(0.0045 + 0.0015 + 0.06 + 0.0125, 6)
    expect(t4.cheapCostUsd).toBeLessThan(t4.costUsd)
    expect(byId("TRACE6").modelSource).toBe("agent")
    expect(byId("TRACE6").model).toBe("claude-sonnet-5")
    expect(byId("TRACE12").costUsd).toBe(0)
    // The agent run inside a workflow is a run like any other.
    expect(byId("TRACE15").modelSource).toBe("agent")
    expect(byId("TRACE15").costUsd).toBeGreaterThan(0)
    expect(byId("TRACE15").proxy).toBe("worked")
    expect(byId("TRACE15").tierBlocked).toBeNull()
  })

  it("never shows the seat a run's outcome", async () => {
    const seen: string[] = []
    registerDecisionBackend("scripted", () => {
      const inner = scriptedBackend()
      return {
        ...inner,
        decide: (req) => {
          seen.push(JSON.stringify(req.state))
          return inner.decide(req)
        },
      }
    })
    await decideTraces(fixtureTraces().slice(0, 2), DECIDE)
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) {
      expect(s).not.toMatch(/numTurns|outputTokens|cacheRead|"status"|finalResponse/)
    }
  })

  it("fails open when a seat does not answer", async () => {
    registerDecisionBackend("scripted", () => ({
      ...scriptedBackend(),
      decide: async () => { throw new Error("backend down") },
    }))
    const vs = await decideTraces(fixtureTraces().slice(0, 3), DECIDE)
    for (const v of vs) {
      expect(v.pNeedsRun).toBeNull()
      expect(gateWouldSkip(v, 0.99)).toBe(false)
      expect(tierWouldDowngrade(v, 0.99)).toBe(false)
      expect(v.errors.length).toBeGreaterThan(0)
    }
  })

  describe("buildReport", () => {
    const opts = {
      backend: "scripted", cheapModel: "claude-haiku-4-5", pricing: CACHE_AWARE_PRICING,
      pricingSource: "test", sweep: [0.1, 0.2, 0.5],
    }

    it("counts skips and downgrades per channel and in total, with proxy grades", () => {
      const r = buildReport(verdicts, opts)
      expect(r.totals.runs).toBe(13)
      // Three [bot] events and the review request sit at or below 0.2.
      expect(r.totals.gate.skipped).toBe(4)
      expect(r.totals.gate.share).toBeCloseTo(4 / 13)
      expect(r.totals.gate.rightSkips).toBe(3)
      expect(r.totals.gate.wrongSkips).toBe(1) // the 24-turn review
      const skippedCost = verdicts.filter((v) => gateWouldSkip(v, 0.2)).reduce((a, v) => a + v.costUsd, 0)
      expect(r.totals.gate.savingUsd).toBeCloseTo(skippedCost, 9)

      // "thanks!" on whatsapp (already on haiku: saves nothing) and the
      // daily report on sonnet (saves something, and did real work).
      expect(r.totals.tier.downgraded).toBe(2)
      expect(r.totals.tier.safeDowngrades).toBe(1)
      expect(r.totals.tier.riskyDowngrades).toBe(1)
      expect(r.totals.tier.savingUsd).toBeGreaterThan(0)
      expect(r.totals.tier.blockedChannel).toBe(1)
      expect(r.totals.tier.blockedWarmCache).toBe(1)
      expect(r.totals.tier.eligible).toBe(11)

      const github = r.channels.find((c) => c.channel === "github")!
      expect(github.runs).toBe(3)
      expect(github.gate.skipped).toBe(3)
      const voice = r.channels.find((c) => c.channel === "voice")!
      expect(voice.tier.downgraded).toBe(0)
      const workflow = r.channels.find((c) => c.channel === "workflow")!
      expect(workflow.runs).toBe(1)
      expect(workflow.gate.skipped).toBe(0)
      expect(r.channels.reduce((a, c) => a + c.runs, 0)).toBe(13)
      expect(r.channels[0].costUsd).toBeGreaterThanOrEqual(r.channels[r.channels.length - 1].costUsd)
    })

    it("counts the dropped workflow rows and says so in the rendering", () => {
      const silent = buildReport(verdicts, opts)
      expect(silent.traces.droppedZeroCostWorkflow).toBe(0)
      expect(renderReport(silent)).not.toContain("left out:")
      const r = buildReport(verdicts, { ...opts, droppedZeroCostWorkflow: 118 })
      expect(r.traces.droppedZeroCostWorkflow).toBe(118)
      expect(r.totals.runs).toBe(13)
      expect(renderReport(r)).toContain("left out: 118 zero-cost workflow rows")
      expect(r.proxies.join(" ")).toMatch(/droppedZeroCostWorkflow/)
    })

    it("replays the same answers at other thresholds without new calls", () => {
      const r = buildReport(verdicts, opts)
      expect(r.sweep.gate.map((s) => s.threshold)).toEqual([0.1, 0.2, 0.5])
      expect(r.sweep.gate.map((s) => s.count)).toEqual([3, 4, verdicts.length - verdicts.filter((v) => (v.pNeedsRun ?? 1) > 0.5).length])
      expect(r.sweep.gate[0].wrong).toBe(0)
      expect(r.sweep.gate[1].wrong).toBe(1)
      // tier: p < threshold, so 0.1 catches nothing, 0.2 both.
      expect(r.sweep.tier.map((s) => s.count)).toEqual([0, 2, 2])
      for (const rows of [r.sweep.gate, r.sweep.tier]) {
        for (let i = 1; i < rows.length; i++) expect(rows[i].count).toBeGreaterThanOrEqual(rows[i - 1].count)
      }
    })

    it("says which numbers are proxies and what it priced at", () => {
      const r = buildReport(verdicts, opts)
      expect(r.proxies.length).toBeGreaterThan(0)
      expect(r.proxies.join(" ")).toMatch(/proxy/)
      expect(r.traces.byProxy).toEqual({ noop: 6, worked: 4, unknown: 3 })
      expect(r.traces.modelFromAgent).toBe(3)
      expect(r.traces.modelFromDefault).toBe(0)
      expect(r.pricing.perMillionTokens["claude-haiku"]).toBeDefined()
      const text = renderReport(r)
      expect(text).toContain("wake gate")
      expect(text).toContain("model tier")
      expect(text).toContain("github")
      expect(text).toContain("proxy")
    })
  })

  describe("sample", () => {
    it("lists skipped and downgraded events with the proxy label and an empty human label", () => {
      const rows = sampleRows(verdicts, { skipBelow: 0.2, downgradeBelow: 0.2, perKind: 50 })
      expect(rows.filter((r) => r.kind === "skipped")).toHaveLength(4)
      expect(rows.filter((r) => r.kind === "downgraded")).toHaveLength(2)
      const csv = toCsv(rows)
      const lines = csv.trim().split("\n")
      expect(lines[0]).toBe(SAMPLE_COLUMNS.join(","))
      expect(lines).toHaveLength(7)
      expect(lines[1].endsWith(",")).toBe(true) // humanLabel empty
      expect(csv).toContain("[bot] release-please")
      // A preview with a comma or a quote stays one cell.
      expect(csv).toMatch(/"Write the daily report: what changed, what failed, what needs a decision\."/)
      // Never the full message, only the bounded preview.
      expect(csv).not.toContain("Keep it under a page")
    })

    it("spreads a capped sample over the probability range", () => {
      const rows = sampleRows(verdicts, { skipBelow: 0.2, downgradeBelow: 0.2, perKind: 2 })
      const skipped = rows.filter((r) => r.kind === "skipped")
      expect(skipped).toHaveLength(2)
      expect(skipped[0].verdict.pNeedsRun!).toBeLessThanOrEqual(skipped[1].verdict.pNeedsRun!)
    })
  })
})

describe("scripts/backtest-jev.ts", () => {
  const run = (args: string[]) =>
    spawnSync(
      path.join(ROOT, "node_modules/.bin/tsx"),
      ["scripts/backtest-jev.ts", "--traces", FIXTURE, "--backend", "mock", "--sample", "3", ...args],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
    )

  it("runs end to end on the fixture with the mock backend and writes the report", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jev-backtest-"))
    try {
      const r = run(["--out", out])
      expect(r.error).toBeUndefined()
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain("Jev backtest")
      expect(r.stderr).toContain("left out   1 zero-cost workflow rows")
      expect(existsSync(path.join(out, "report.json"))).toBe(true)
      expect(existsSync(path.join(out, "sample.csv"))).toBe(true)
      // Not recorded unless asked.
      expect(existsSync(path.join(out, "decisions.sqlite"))).toBe(false)
      const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf-8"))
      expect(report.backend).toBe("mock")
      expect(report.totals.runs).toBe(13)
      expect(report.traces.droppedZeroCostWorkflow).toBe(1)
      expect(report.traces.unansweredGate).toBe(0)
      expect(report.sweep.gate.length).toBeGreaterThan(0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 120_000)

  it("reads agentx.json, its .env and its pricing overrides from --config, and reports there (#626)", () => {
    // The daemon's folder, somewhere other than the source checkout: the
    // worktree case. The script is started from ROOT, where tsconfig.json
    // resolves the "@/" imports, and pointed at this folder.
    const home = mkdtempSync(path.join(tmpdir(), "jev-backtest-home-"))
    try {
      writeFileSync(path.join(home, "agentx.json"), JSON.stringify({
        node: { id: "demo", name: "Demo", bind: "127.0.0.1:18800" },
        agents: { reporter: { name: "Reporter", workspace: home, tier: "claude-code", model: "${REPORTER_MODEL}" } },
      }))
      writeFileSync(path.join(home, ".env"), "REPORTER_MODEL=claude-sonnet-5\n")
      // A made-up family at ten times the sonnet list price, so the override
      // is visible in the cost.
      mkdirSync(path.join(home, ".agentx/pricing"), { recursive: true })
      writeFileSync(path.join(home, ".agentx/pricing/custom.json"), JSON.stringify({
        "claude-sonnet-5": { input: 30, output: 150, cacheRead: 3, cacheCreate: 37.5 },
      }))

      const r = run(["--config", path.join(home, "agentx.json")])
      expect(r.error).toBeUndefined()
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain(`config     ${path.join(home, "agentx.json")}`)
      expect(r.stderr).not.toContain("no agentx.json read")

      // Report lands under the agentx.json folder, not the current one.
      const reportPath = path.join(home, ".agentx/reports/jev-backtest/report.json")
      expect(existsSync(reportPath)).toBe(true)
      const report = JSON.parse(readFileSync(reportPath, "utf-8"))
      // TRACE6, TRACE7 and TRACE15 recorded no model: priced at the reporter's
      // model from agentx.json (expanded from .env), none at the default.
      expect(report.traces.modelFromAgent).toBe(3)
      expect(report.traces.modelFromDefault).toBe(0)
      expect(report.pricing.source).toContain(".agentx/pricing/custom.json")
      expect(report.pricing.perMillionTokens["claude-sonnet-5"].input).toBe(30)

      // A folder works as well as the file.
      const r2 = run(["--config", home, "--out", path.join(home, "out2")])
      expect(r2.status, r2.stderr).toBe(0)
      expect(r2.stderr).toContain(`config     ${path.join(home, "agentx.json")}`)
      expect(existsSync(path.join(home, "out2/report.json"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)

  it("still says so when --config names a file that is not there", () => {
    const out = mkdtempSync(path.join(tmpdir(), "jev-backtest-"))
    try {
      const r = run(["--config", path.join(out, "missing/agentx.json"), "--out", out])
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain("no agentx.json read")
      expect(r.stderr).toContain("config     none read")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 120_000)
})
