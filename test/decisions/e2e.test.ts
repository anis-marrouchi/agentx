import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { askSeat, configureDecisions, resetDecisionsRuntime } from "../../src/decisions/seat"
import {
  _resetDecisionBackendsForTesting,
  registerDecisionBackend,
  type DecisionBackend,
} from "../../src/decisions/backend"
import { DecisionStore } from "../../src/decisions/store"
import { calibrationReport, coverageCurve } from "../../src/decisions/calibration"
import { finalizeAnswer } from "../../src/decisions/normalize"
import { choice } from "../../src/decisions/questions"
import type { AnswersFor, Questions } from "../../src/decisions/types"

// The whole loop, on synthetic traffic whose truth we control:
//   seat -> backend -> store -> label -> calibration report -> threshold.
//
// The backend below is deliberately overconfident in exactly the way an
// RLHF'd chat model is: it always claims 0.9 and is right 65% of the time.
// The point of the test is that the harness SAYS SO. If this ever passes
// while reporting good calibration, the harness is broken, not the backend.

const SEAT = "workflow-matcher"
const questions = { area: choice({ billing: null, technical: null }) }

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Claims 0.9 on every call. Truth is decided by the caller, not by it. */
function overconfidentBackend(): DecisionBackend {
  return {
    name: "overconfident",
    capabilities: {
      calibratedProbabilities: false,
      maxChoiceOptions: 255,
      maxStateChars: 24_000,
      parallelQuestions: true,
      images: false,
    },
    async decide<Q extends Questions>(request: any) {
      const answer = finalizeAnswer(request.questions.area, {
        probabilities: { billing: 0.9, technical: 0.1 },
      }).answer
      return {
        model: "overconfident-v1",
        answers: { area: answer } as unknown as AnswersFor<Q>,
        usage: { inputTokens: 100, outputTokens: 0 },
        meta: {
          backend: "overconfident",
          structureMode: "mock" as const,
          answerMode: "probabilities" as const,
          repaired: false,
          retries: 0,
          stateTruncated: false,
          latencyMs: 5,
        },
      }
    },
  }
}

let tmp: string
let store: DecisionStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-decisions-e2e-"))
  store = new DecisionStore({ path: path.join(tmp, "d.sqlite") })
  _resetDecisionBackendsForTesting()
  registerDecisionBackend("overconfident", overconfidentBackend)
  resetDecisionsRuntime()
  configureDecisions({
    enabled: true,
    store,
    defaultBackend: "overconfident",
    seats: { [SEAT]: { mode: "shadow" } },
  })
})

afterEach(() => {
  resetDecisionsRuntime()
  store.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("shadow soak, end to end", () => {
  it("catches an overconfident backend and names the threshold that fixes it", async () => {
    const rng = mulberry32(42)

    for (let i = 0; i < 400; i++) {
      // Ground truth agrees with the backend 65% of the time.
      const truth = rng() < 0.65 ? "billing" : "technical"
      // The incumbent is right 55% of the time, and independently so.
      const incumbent = rng() < 0.55 ? truth : truth === "billing" ? "technical" : "billing"

      const result = await askSeat(SEAT, { i }, questions, { incumbent: { area: incumbent } })
      expect(result).not.toBeNull()
      store.label(result!.callId!, "area", truth, { kind: "outcome" })
    }

    const rows = store.gradedRows({ seat: SEAT })
    expect(rows).toHaveLength(400)

    const report = calibrationReport(rows, { minN: 100, bootstrap: 200, rng: mulberry32(7) })

    expect(report.insufficient).toBe(false)
    expect(report.nLabeled).toBe(400)

    // It is right about 65% of the time...
    expect(report.accuracy!).toBeGreaterThan(0.55)
    expect(report.accuracy!).toBeLessThan(0.75)
    // ...while claiming far more, and the harness measures the gap.
    expect(report.ece!).toBeGreaterThan(0.1)
    expect(report.eceInterval!.lo).toBeGreaterThan(0)
    // The fix is a temperature above 1, and the fit finds it.
    expect(report.temperature!.temperature).toBeGreaterThan(1)
    expect(report.temperature!.nll).toBeLessThan(report.temperature!.nllBefore)

    // And it beats the incumbent on accuracy, which is the thing that would
    // actually justify promoting the seat.
    expect(report.accuracy!).toBeGreaterThan(0.5)
    expect(report.agreement.n).toBe(400)
  })

  it("a coverage curve is flat when confidence carries no information", async () => {
    const rng = mulberry32(11)
    for (let i = 0; i < 200; i++) {
      const truth = rng() < 0.65 ? "billing" : "technical"
      const result = await askSeat(SEAT, { i }, questions)
      store.label(result!.callId!, "area", truth, { kind: "outcome" })
    }

    // Every answer claims the same confidence, so raising the threshold buys
    // nothing — it drops to zero coverage without ever improving accuracy.
    // That is the signal that this seat should NOT be promoted.
    const curve = coverageCurve(store.gradedRows({ seat: SEAT }), 10)
    const informative = curve.filter((p) => p.n > 0)
    const accuracies = informative.map((p) => p.accuracy)
    expect(Math.max(...accuracies) - Math.min(...accuracies)).toBeLessThan(0.05)
  })

  it("prunes state to hashes without losing a single graded row", async () => {
    for (let i = 0; i < 10; i++) await askSeat(SEAT, { secret: `message ${i}` }, questions)

    expect(store.pruneState(SEAT, 3)).toBe(7)
    expect(store.gradedRows({ seat: SEAT })).toHaveLength(10)

    const kept = store.db
      .prepare("SELECT COUNT(*) AS n FROM decision_calls WHERE state_json IS NOT NULL")
      .get() as { n: number }
    expect(kept.n).toBe(3)
  })
})
