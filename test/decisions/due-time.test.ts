import { describe, it, expect } from "vitest"
import {
  ASK_AT,
  DUE_TIME_SEAT,
  commitsDueTime,
  dueTimeOwner,
  dueTimeQuestions,
  dueTimeState,
  needsDueRecord,
  type DueTimeAnswers,
} from "../../src/decisions/seats/due-time"
import { finalizeAnswer } from "../../src/decisions/normalize"
import { validateQuestions } from "../../src/decisions/questions"

function answers(p: number, owner: Record<string, number> = { this_agent: 1 }): DueTimeAnswers {
  return {
    commits: finalizeAnswer(dueTimeQuestions.commits, { noul: p }).answer,
    owner: finalizeAnswer(dueTimeQuestions.owner, { probabilities: owner }).answer,
  } as DueTimeAnswers
}

describe("due-time seat", () => {
  it("asks whether a due time is owed, and by whom", () => {
    expect(DUE_TIME_SEAT).toBe("due-time")
    expect(() => validateQuestions(dueTimeQuestions)).not.toThrow()
    expect(dueTimeQuestions.commits.type).toBe("noul")
    expect(Object.keys(dueTimeQuestions.owner.criteria)).toEqual(["this_agent", "another_agent", "person", "none"])
  })

  it("builds its state from the final reply and the notes posted, clipped", () => {
    const state = dueTimeState({
      agent: "helper", channel: "github", now: "2030-01-01T10:00:00.000Z",
      reply: `${"x".repeat(6000)} I will post the review by 15:00Z.`,
      notes: Array.from({ length: 12 }, (_, i) => `note ${i} ${"y".repeat(2000)}`),
    }) as Record<string, any>
    expect(Object.keys(state).sort()).toEqual(["agent", "channel", "finalReply", "notesPosted", "now"])
    // The end of the reply is kept: that is where a due time is stated.
    expect(state.finalReply.endsWith("I will post the review by 15:00Z.")).toBe(true)
    expect(state.finalReply.length).toBeLessThanOrEqual(4001)
    expect(state.notesPosted).toHaveLength(8)
    expect(state.notesPosted[7].startsWith("note 11")).toBe(true)
    expect(state.notesPosted[0].length).toBeLessThanOrEqual(801)
  })

  it("defaults the channel, the time and the notes", () => {
    expect(dueTimeState({ agent: "helper", reply: "done" })).toEqual({ agent: "helper", channel: null, now: null, finalReply: "done", notesPosted: [] })
  })
})

describe("needsDueRecord", () => {
  it("is true only on a fairly sure yes", () => {
    expect(needsDueRecord(answers(0.95))).toBe(true)
    expect(needsDueRecord(answers(ASK_AT))).toBe(true)
    expect(needsDueRecord(answers(0.5))).toBe(false)
    expect(needsDueRecord(answers(0.05))).toBe(false)
    expect(needsDueRecord(answers(0.5), { minCommits: 0.4 })).toBe(true)
  })

  it("reads the probability and the owner from the answers", () => {
    const a = answers(0.9, { this_agent: 0.1, person: 0.9 })
    expect(commitsDueTime(a)).toBeCloseTo(0.9)
    expect(dueTimeOwner(a)).toBe("person")
  })
})
