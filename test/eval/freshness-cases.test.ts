import { describe, it, expect } from "vitest"
import fixture from "./fixtures/freshness-cases.json"

// Shape guard for the memory-freshness question set (#603).
//
// The set is the shared ground truth for the current wiki path and any
// later backend arm. It grades nothing by itself; this only keeps the
// set honest: 40 questions, six categories, a held-out part in every
// category, and evidence that exists and is not from the future.

const CATEGORIES = [
  "recent-correction",
  "changing-fact",
  "procedure",
  "past-fix",
  "permission-boundary",
  "missing-or-contradictory",
]
const EXPECTS = ["answer", "abstain", "conflict", "refuse"]

describe("freshness question set", () => {
  const events = new Map(fixture.events.map((e) => [e.id, e]))

  it("has 40 uniquely named questions", () => {
    expect(fixture.cases).toHaveLength(40)
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(40)
  })

  it("covers every category in both splits", () => {
    for (const category of CATEGORIES) {
      const inCategory = fixture.cases.filter((c) => c.category === category)
      expect(inCategory.filter((c) => c.split === "dev").length, category).toBeGreaterThanOrEqual(4)
      expect(inCategory.filter((c) => c.split === "held-out").length, category).toBe(2)
    }
    expect(fixture.cases.every((c) => CATEGORIES.includes(c.category))).toBe(true)
  })

  it("points only at evidence that exists before the question is asked", () => {
    for (const c of fixture.cases) {
      expect(EXPECTS, c.id).toContain(c.expect)
      for (const id of c.evidence) {
        const event = events.get(id)
        expect(event, `${c.id} -> ${id}`).toBeDefined()
        expect(Date.parse(event!.at), `${c.id} -> ${id}`).toBeLessThan(Date.parse(c.askedAt))
      }
    }
  })

  it("gives every question something to grade", () => {
    for (const c of fixture.cases) {
      if (c.expect === "answer" || c.expect === "conflict") {
        expect(c.answerContains?.length ?? 0, c.id).toBeGreaterThan(0)
        expect(c.evidence.length, c.id).toBeGreaterThan(0)
      }
      if (c.expect === "refuse") {
        // The evidence exists, but outside what the asker may read.
        const scopes = c.evidence.map((id) => events.get(id)!.scope)
        expect(scopes.some((s) => !(c.askerScope ?? []).includes(s)), c.id).toBe(true)
      }
    }
  })
})
