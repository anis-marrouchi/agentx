import { describe, it, expect } from "vitest"
import {
  SESSION_CONTINUITY_SEAT,
  continuityState,
  sessionContinuityQuestions,
  shouldRotateEarly,
  type SessionContinuityAnswers,
} from "../../src/decisions/seats/session-continuity"
import { finalizeAnswer } from "../../src/decisions/normalize"

function answers(continues: number, needsHistory: number): SessionContinuityAnswers {
  return {
    continues: finalizeAnswer(sessionContinuityQuestions.continues, { noul: continues }).answer,
    needsHistory: finalizeAnswer(sessionContinuityQuestions.needsHistory, { noul: needsHistory })
      .answer,
  } as SessionContinuityAnswers
}

describe("shouldRotateEarly", () => {
  it("rotates only when both questions confidently say the work is unrelated", () => {
    expect(shouldRotateEarly(answers(0.03, 0.04), { mechanicalRotation: false })).toBe(true)
  })

  it("never overrides a mechanical rotation", () => {
    // One-directional by design: the seat may save a transcript replay,
    // never keep alive a session the safety rules wanted dead.
    expect(
      shouldRotateEarly(answers(0.0, 0.0), {
        mechanicalRotation: true,
        maxContinuity: 1,
        minConfidence: 0,
      }),
    ).toBe(false)
  })

  it("keeps the session when the request still refers back, even on a new subject", () => {
    // The amnesia case: "forget the deploy, what was that token you
    // mentioned?" changes subject but depends on earlier context.
    expect(shouldRotateEarly(answers(0.05, 0.9), { mechanicalRotation: false })).toBe(false)
  })

  it("keeps the session when the work continues", () => {
    expect(shouldRotateEarly(answers(0.95, 0.9), { mechanicalRotation: false })).toBe(false)
  })

  it("will not act on a low-confidence answer", () => {
    expect(shouldRotateEarly(answers(0.45, 0.4), { mechanicalRotation: false })).toBe(false)
  })

  it("requires BOTH questions, not their average", () => {
    // 0.05 and 0.6 averages below the bar but must not rotate.
    expect(shouldRotateEarly(answers(0.05, 0.6), { mechanicalRotation: false })).toBe(false)
  })
})

describe("continuityState", () => {
  it("carries the two requests and the mechanical signals, and nothing else", () => {
    const state = continuityState({
      message: "and now deploy it",
      previousMessage: "fix the failing test",
      minutesSinceLastTurn: 4,
      turnCount: 11,
      lastTurnContextTokens: 143_000,
      agentId: "devops-agent",
      channel: "telegram",
    }) as Record<string, unknown>

    expect(Object.keys(state).sort()).toEqual([
      "agent", "channel", "currentContextTokens", "minutesSinceLastTurn",
      "newRequest", "previousRequest", "turnsSoFar",
    ])
    expect(state.previousRequest).toBe("fix the failing test")
    expect(state.currentContextTokens).toBe(143_000)
  })

  it("tolerates a first turn with no history", () => {
    const state = continuityState({
      message: "hello",
      previousMessage: null,
      minutesSinceLastTurn: null,
      turnCount: 0,
      lastTurnContextTokens: null,
      agentId: "a",
      channel: "cli",
    }) as Record<string, unknown>
    expect(state.previousRequest).toBeNull()
    expect(state.minutesSinceLastTurn).toBeNull()
  })

  it("clips a long request rather than sending a whole transcript", () => {
    const state = continuityState({
      message: "x".repeat(9000),
      previousMessage: "y".repeat(9000),
      minutesSinceLastTurn: 1,
      turnCount: 1,
      lastTurnContextTokens: 1,
      agentId: "a",
      channel: "cli",
    }) as Record<string, string>
    expect(state.newRequest).toHaveLength(1200)
    expect(state.previousRequest).toHaveLength(800)
  })
})

describe("seat naming", () => {
  it("matches the env override the operator would set", () => {
    expect(SESSION_CONTINUITY_SEAT).toBe("session-continuity")
  })
})
