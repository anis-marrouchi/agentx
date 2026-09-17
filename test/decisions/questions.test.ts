import { describe, it, expect } from "vitest"
import {
  MAX_CHOICE_OPTIONS,
  choice,
  labelsOf,
  noul,
  score,
  validateQuestions,
} from "../../src/decisions/questions"

describe("question builders", () => {
  it("builds a choice whose labels are its criteria keys", () => {
    const q = choice({ billing: null, technical: "needs an engineer" }, "what is this about?")
    expect(q.type).toBe("choice")
    expect(q.instructions).toBe("what is this about?")
    expect(labelsOf(q)).toEqual(["billing", "technical"])
  })

  it("rejects a choice with fewer than two options", () => {
    expect(() => choice({ only: null } as Record<string, null>)).toThrow(/at least 2 options/)
  })

  it("rejects a choice over Jev's 255-option cap, at build time", () => {
    const criteria: Record<string, null> = {}
    for (let i = 0; i < MAX_CHOICE_OPTIONS; i++) criteria[`opt${i}`] = null
    expect(() => choice(criteria)).not.toThrow()

    criteria[`opt${MAX_CHOICE_OPTIONS}`] = null
    expect(() => choice(criteria)).toThrow(/at most 255 options/)
  })

  it("numbers score levels from zero, in array order", () => {
    const q = score(["poor", "fine", "good"])
    expect(labelsOf(q)).toEqual(["0", "1", "2"])
  })

  it("rejects a score with fewer than two rubric levels", () => {
    expect(() => score(["only"])).toThrow(/at least 2 rubric levels/)
  })

  it("omits optional fields rather than setting them undefined", () => {
    expect(Object.keys(noul())).toEqual(["type"])
    expect(labelsOf(noul())).toEqual([])
  })
})

describe("validateQuestions", () => {
  it("requires at least one question", () => {
    expect(() => validateQuestions({})).toThrow(/at least one question/)
  })

  it("names the offending question", () => {
    const bad = { verdict: { type: "score", criteria: ["only"] } } as const
    expect(() => validateQuestions(bad)).toThrow(/question "verdict"/)
  })

  it("accepts a well-formed mixed set", () => {
    expect(() =>
      validateQuestions({
        urgent: noul("is this urgent?"),
        area: choice({ code: null, ops: null }),
        quality: score(["poor", "good"]),
      }),
    ).not.toThrow()
  })
})
