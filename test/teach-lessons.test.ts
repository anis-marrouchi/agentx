import { describe, it, expect } from "vitest"
import { LESSONS } from "../src/teach/lessons"

describe("teach lessons", () => {
  it("have unique ids", () => {
    expect(new Set(LESSONS.map(l => l.id)).size).toBe(LESSONS.length)
  })

  it.each(LESSONS.map(l => [l.id, l] as const))("%s gates every action on a readiness claim", (_id, lesson) => {
    for (const step of lesson.steps) {
      if (step.click || step.type || step.key) expect(step.before, step.say).toBeTruthy()
      if (step.click) expect(step.find, step.say).toBeTruthy()
    }
  })
})
