import { describe, it, expect } from "vitest"
import {
  WAKE_GATE_SEAT,
  SKIP_BELOW,
  needsRun,
  shouldSkipRun,
  wakeGateQuestions,
  wakeGateState,
  type WakeGateAnswers,
} from "../../src/decisions/seats/wake-gate"
import { finalizeAnswer } from "../../src/decisions/normalize"
import { validateQuestions } from "../../src/decisions/questions"

function answers(p: number): WakeGateAnswers {
  return {
    needsRun: finalizeAnswer(wakeGateQuestions.needsRun, { noul: p }).answer,
  } as WakeGateAnswers
}

describe("wake-gate seat", () => {
  it("asks one yes/no question the seat can honour", () => {
    expect(WAKE_GATE_SEAT).toBe("wake-gate")
    expect(() => validateQuestions(wakeGateQuestions)).not.toThrow()
    expect(wakeGateQuestions.needsRun.type).toBe("noul")
  })

  it("builds a state from pre-run facts only", () => {
    const state = wakeGateState({
      message: "x".repeat(3000),
      agent: "helper",
      channel: "github",
      continuesExistingSession: true,
    }) as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(["agent", "channel", "continuesExistingSession", "event"])
    // Clipped, so a long event cannot blow the backend's budget.
    expect((state.event as string).length).toBeLessThanOrEqual(2001)
    expect(state.continuesExistingSession).toBe(true)
    // No outcome field may ever appear here; a backtest would be grading
    // the seat on an answer it was shown.
    for (const leak of ["status", "numTurns", "outputTokens", "finalResponse", "error"]) {
      expect(state).not.toHaveProperty(leak)
    }
  })

  it("defaults the channel and the session flag", () => {
    const state = wakeGateState({ message: "hi", agent: "helper" }) as Record<string, unknown>
    expect(state.channel).toBeNull()
    expect(state.continuesExistingSession).toBe(false)
  })
})

describe("shouldSkipRun", () => {
  it("skips only on a confident no", () => {
    expect(shouldSkipRun(answers(0.05))).toBe(true)
    expect(shouldSkipRun(answers(SKIP_BELOW))).toBe(true)
    expect(shouldSkipRun(answers(0.21))).toBe(false)
    expect(shouldSkipRun(answers(0.5))).toBe(false)
    expect(shouldSkipRun(answers(0.95))).toBe(false)
  })

  it("thresholds the probability directly, with the threshold as the only knob", () => {
    expect(shouldSkipRun(answers(0.3), { maxNeedsRun: 0.4 })).toBe(true)
    expect(shouldSkipRun(answers(0.3), { maxNeedsRun: 0.1 })).toBe(false)
    expect(needsRun(answers(0.3))).toBeCloseTo(0.3)
  })

  it("never skips on a malformed probability", () => {
    expect(shouldSkipRun({ needsRun: { type: "noul", noul: Number.NaN } } as WakeGateAnswers)).toBe(false)
  })
})
