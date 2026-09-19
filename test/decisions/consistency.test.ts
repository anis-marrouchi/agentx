import { describe, it, expect, beforeEach } from "vitest"
import {
  UNCERTAINTY_HIGH,
  UNCERTAINTY_LOW,
  band,
  measureConsistency,
  withUid,
} from "../../src/decisions/consistency"
import {
  _resetDecisionBackendsForTesting,
  registerDecisionBackend,
  type DecisionBackend,
} from "../../src/decisions/backend"
import { finalizeAnswer } from "../../src/decisions/normalize"
import { choice, noul } from "../../src/decisions/questions"
import type { AnswersFor, Questions } from "../../src/decisions/types"

beforeEach(() => _resetDecisionBackendsForTesting())

describe("band", () => {
  it("follows TypeSafe's review band", () => {
    expect(band(0.1)).toBe("no")
    expect(band(UNCERTAINTY_LOW)).toBe("no") // inclusive lower edge
    expect(band(0.5)).toBe("uncertain")
    expect(band(UNCERTAINTY_HIGH)).toBe("uncertain") // exclusive upper edge
    expect(band(0.71)).toBe("yes")
  })
})

describe("withUid", () => {
  it("adds a throwaway field to an object state", () => {
    expect(withUid({ a: 1 }, "x")).toEqual({ a: 1, uid: "x" })
  })
  it("wraps a non-object state rather than mangling it", () => {
    expect(withUid("some text", "x")).toEqual({ uid: "x", state: "some text" })
  })
})

/** Emits a scripted sequence of P(true) values, one per call. */
function scriptedNoulBackend(sequence: number[]): DecisionBackend {
  let i = 0
  const seen = new Set<string>()
  return {
    name: "scripted",
    capabilities: {
      probabilitySource: "native", calibratedProbabilities: false,
      maxChoiceOptions: 255, maxStateChars: 24_000, parallelQuestions: true, images: false,
    },
    async decide<Q extends Questions>(req: any) {
      seen.add(JSON.stringify(req.state))
      const p = sequence[i++ % sequence.length]
      const answers: Record<string, unknown> = {}
      for (const [name, q] of Object.entries(req.questions as Questions)) {
        answers[name] =
          q.type === "noul"
            ? finalizeAnswer(q, { noul: p }).answer
            : finalizeAnswer(q, { probabilities: { a: p, b: 1 - p } }).answer
      }
      return {
        model: "scripted",
        answers: answers as AnswersFor<Q>,
        usage: { inputTokens: 10, outputTokens: 0 },
        meta: {
          backend: "scripted", structureMode: "native" as const,
          answerMode: "probabilities" as const, repaired: false, retries: 0,
          stateTruncated: false, latencyMs: 1,
        },
        _distinctStates: seen.size,
      } as any
    },
  }
}

describe("measureConsistency", () => {
  const questions = { q: noul("Is it true?") }

  it("measures P(true) for a noul, not the winning label's share", async () => {
    // The regression this test exists for. answerView projects a noul onto
    // (predicted, topProb), and topProb is max(p, 1-p) — so a steady
    // P(true) of 0.26 reported as 0.74, and since topProb is never below
    // 0.5 every noul landed in the "yes" band regardless of its answer.
    registerDecisionBackend("scripted", () => scriptedNoulBackend([0.26]))
    const report = await measureConsistency("scripted", { s: 1 }, questions, { samples: 5 })

    expect(report.questions[0].mean).toBeCloseTo(0.26, 6)
    expect(report.questions[0].bands).toEqual(["no"])
  })

  it("reports zero spread for a steady question", async () => {
    registerDecisionBackend("scripted", () => scriptedNoulBackend([0.9]))
    const report = await measureConsistency("scripted", { s: 1 }, questions, { samples: 10 })
    expect(report.questions[0].stdev).toBeCloseTo(0, 10)
    expect(report.questions[0].crossesThreshold).toBe(false)
    expect(report.unstable).toEqual([])
  })

  it("flags a question whose samples straddle the band", async () => {
    // Moves either side of 0.5 — same question, opposite decisions.
    registerDecisionBackend("scripted", () => scriptedNoulBackend([0.2, 0.8]))
    const report = await measureConsistency("scripted", { s: 1 }, questions, { samples: 10 })

    expect(report.questions[0].crossesThreshold).toBe(true)
    expect(report.unstable).toEqual(["q"])
    expect(new Set(report.questions[0].bands)).toEqual(new Set(["no", "yes"]))
    expect(new Set(report.questions[0].distinctAnswers)).toEqual(new Set(["yes", "no"]))
  })

  it("flags drift that stays on one side of 0.5 but crosses the review band", async () => {
    // Never flips the yes/no answer, but moves between "act" and "escalate".
    registerDecisionBackend("scripted", () => scriptedNoulBackend([0.62, 0.78]))
    const report = await measureConsistency("scripted", { s: 1 }, questions, { samples: 10 })
    expect(report.questions[0].distinctAnswers).toEqual(["yes"])
    expect(report.questions[0].crossesThreshold).toBe(true)
  })

  it("gives every sample a distinct state, so none can be served from cache", async () => {
    const backend = scriptedNoulBackend([0.5])
    registerDecisionBackend("scripted", () => backend)
    const res = await measureConsistency("scripted", { s: 1 }, questions, { samples: 8 })
    expect(res.samples).toBe(8)
    // Eight calls, eight different states — the uid did its job.
    const last = await backend.decide({ state: withUid({ s: 1 }, "probe"), questions } as any)
    expect((last as any)._distinctStates).toBe(9)
  })

  it("uses the winning label's share for a choice", async () => {
    registerDecisionBackend("scripted", () => scriptedNoulBackend([0.85]))
    const report = await measureConsistency(
      "scripted", { s: 1 }, { pick: choice({ a: null, b: null }) }, { samples: 4 },
    )
    expect(report.questions[0].mean).toBeCloseTo(0.85, 6)
    expect(report.questions[0].distinctAnswers).toEqual(["a"])
  })
})
