import { describe, it, expect, beforeEach } from "vitest"
import {
  _resetDecisionBackendsForTesting,
  getDecisionBackend,
  listDecisionBackends,
  registerDecisionBackend,
} from "../../src/decisions/backend"
import { createMockDecisionBackend } from "../../src/decisions/backends/mock"
import { registerBuiltinDecisionBackends } from "../../src/decisions"
import { choice, noul, score } from "../../src/decisions/questions"
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../../src/decisions/types"

beforeEach(() => {
  _resetDecisionBackendsForTesting()
})

describe("backend registry", () => {
  it("resolves a registered backend and memoizes the instance", () => {
    let built = 0
    registerDecisionBackend("counted", () => {
      built++
      return createMockDecisionBackend()
    })
    expect(built).toBe(0) // factories are lazy
    const first = getDecisionBackend("counted")
    const second = getDecisionBackend("counted")
    expect(first).toBe(second)
    expect(built).toBe(1)
  })

  it("names the registered backends when asked for an unknown one", () => {
    registerDecisionBackend("mock", () => createMockDecisionBackend())
    expect(() => getDecisionBackend("jev")).toThrow(/unknown decision backend "jev".*mock/s)
  })

  it("says so plainly when nothing is registered", () => {
    expect(() => getDecisionBackend("mock")).toThrow(/none registered/)
  })

  it("re-registering replaces the memoized instance", () => {
    registerDecisionBackend("mock", () => createMockDecisionBackend())
    const first = getDecisionBackend("mock")
    registerDecisionBackend("mock", () => createMockDecisionBackend())
    expect(getDecisionBackend("mock")).not.toBe(first)
  })

  it("registerBuiltinDecisionBackends registers mock", () => {
    registerBuiltinDecisionBackends()
    expect(listDecisionBackends()).toContain("mock")
  })
})

describe("mock backend", () => {
  const questions = {
    urgent: noul("is this urgent?"),
    area: choice({ code: null, ops: null, support: null }),
    quality: score(["poor", "fine", "good"]),
  }

  it("answers every question in one call", async () => {
    const backend = createMockDecisionBackend()
    const res = await backend.decide({ state: "the deploy is failing", questions })
    expect(Object.keys(res.answers).sort()).toEqual(["area", "quality", "urgent"])
    expect((res.answers.urgent as NoulAnswer).type).toBe("noul")
    expect((res.answers.area as ChoiceAnswer).type).toBe("choice")
    expect((res.answers.quality as ScoreAnswer).type).toBe("score")
    expect(res.meta.backend).toBe("mock")
    expect(res.meta.structureMode).toBe("mock")
  })

  it("is deterministic in the state", async () => {
    const backend = createMockDecisionBackend()
    const a = await backend.decide({ state: { ticket: 42 }, questions })
    const b = await backend.decide({ state: { ticket: 42 }, questions })
    const c = await backend.decide({ state: { ticket: 43 }, questions })
    expect(a.answers).toEqual(b.answers)
    expect(a.answers).not.toEqual(c.answers)
  })

  it("produces a valid distribution without scripting", async () => {
    const backend = createMockDecisionBackend()
    const res = await backend.decide({ state: "anything", questions })
    const area = res.answers.area as ChoiceAnswer
    const total = Object.values(area.probabilities).reduce((x, y) => x + y, 0)
    expect(total).toBeCloseTo(1, 10)
    expect(res.meta.repaired).toBe(false)
  })

  it("honours scripted answers", async () => {
    const backend = createMockDecisionBackend({
      answers: { area: { probabilities: { code: 0.8, ops: 0.15, support: 0.05 } } },
    })
    const res = await backend.decide({ state: "x", questions })
    expect((res.answers.area as ChoiceAnswer).choice).toBe("code")
  })

  it("flags a repair when a scripted answer is off-schema", async () => {
    const backend = createMockDecisionBackend({
      answers: { area: { probabilities: { code: 1, nonsense: 1 } } },
    })
    const res = await backend.decide({ state: "x", questions })
    expect(res.meta.repaired).toBe(true)
    expect((res.answers.area as ChoiceAnswer).choice).toBe("code")
  })

  it("rejects a malformed question set before spending a round trip", async () => {
    const backend = createMockDecisionBackend()
    await expect(backend.decide({ state: "x", questions: {} })).rejects.toThrow(
      /at least one question/,
    )
  })

  it("can be told to fail, for exercising the fail-open path", async () => {
    const backend = createMockDecisionBackend({ fail: new Error("backend down") })
    await expect(backend.decide({ state: "x", questions })).rejects.toThrow("backend down")
  })
})
