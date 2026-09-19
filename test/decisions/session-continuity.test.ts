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

  it("will not act when the answer is not a clear no", () => {
    // Near 0.5 is not "medium continuity" — it is the model declining to
    // separate yes from no, and the threshold rejects it for that reason
    // rather than via any notion of confidence.
    expect(shouldRotateEarly(answers(0.45, 0.4), { mechanicalRotation: false })).toBe(false)
  })

  it("honours the documented threshold, not half of it", () => {
    // The regression this pins. shouldRotateEarly used to AND the
    // threshold with a "confidence" derived as |noul - 0.5| * 2, floored
    // at 0.8. Both nouls at or below 0.2 already force that derived value
    // to 0.6 or more, so the floor silently re-expressed the threshold as
    // 0.1 while config, docstring and every discussion said 0.2.
    //
    // 0.15 sits inside the documented band and outside the effective one,
    // so it rotates now and did not before. A Noul has no confidence to
    // gate on — TypeSafe's primitive docs are explicit — and the whole
    // band between 0.1 and 0.2 was dead because of it.
    expect(shouldRotateEarly(answers(0.15, 0.15), { mechanicalRotation: false })).toBe(true)
    expect(shouldRotateEarly(answers(0.2, 0.2), { mechanicalRotation: false })).toBe(true)
    // Just outside stays out, so the threshold is still a threshold.
    expect(shouldRotateEarly(answers(0.21, 0.2), { mechanicalRotation: false })).toBe(false)
  })

  it("respects an explicit maxContinuity", () => {
    expect(shouldRotateEarly(answers(0.3, 0.3), { mechanicalRotation: false })).toBe(false)
    expect(
      shouldRotateEarly(answers(0.3, 0.3), { mechanicalRotation: false, maxContinuity: 0.35 }),
    ).toBe(true)
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
