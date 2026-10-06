import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { configureDecisions, resetDecisionsRuntime } from "../../src/decisions/seat"
import { registerDecisionBackend } from "../../src/decisions/backend"
import { createMockDecisionBackend } from "../../src/decisions/backends/mock"
import { INTENT_PATH_SEAT, proposePathViaSeat, categoryQuestions, verbQuestions } from "../../src/decisions/seats/intent-path"
import type { GraphNode } from "../../src/graph/types"

// The intent graph is a closed set of a few hundred nodes, so a message's
// path is a two-stage Choice: category, then verb within it. The seat can
// only reuse existing nodes and must fail open into "no proposal".

const node = (id: string, parentId: string | null, description?: string): GraphNode => ({
  id, level: parentId ? "verb" : "category", parentId,
  axes: { name: id, ...(description ? { description } : {}) }, createdAt: "2026-01-01T00:00:00Z",
})
const NODES: GraphNode[] = [
  node("code", null, "Software work"),
  node("ops", null, "Infrastructure work"),
  node("admin", null, "Administration"),
  node("review.merge-request", "code", "Review an MR or PR"),
  node("fix.bug", "code", "Fix a defect"),
  node("deploy.staging", "ops"),
  node("restart.service", "ops"),
]
// More code verbs so a stage-2 argmax can sit under one half, or one third.
const WIDE = [...NODES, node("write.tests", "code", "Add tests"), node("refactor.module", "code", "Restructure code")]
const input = { message: "please review MR !5", channel: "gitlab", agent: "coder" }

beforeEach(() => resetDecisionsRuntime())
afterEach(() => resetDecisionsRuntime())

function seat(mode: "off" | "shadow" | "active", answers: Record<string, { probabilities: Record<string, number> }>) {
  registerDecisionBackend("mock", () => createMockDecisionBackend({ answers }))
  configureDecisions({ enabled: true, seats: { [INTENT_PATH_SEAT]: { mode, backend: "mock" } } })
}

describe("intent-path questions", () => {
  it("offers each node as an option described by its own text", () => {
    const q = categoryQuestions(NODES.filter((n) => n.parentId === null)).category
    expect(Object.keys(q.criteria)).toEqual(["code", "ops", "admin"])
    expect(q.criteria.code).toBe("Software work")
    const v = verbQuestions(NODES.filter((n) => n.parentId === "ops")).verb
    expect(v.criteria["deploy.staging"]).toBeNull()
  })
})

describe("intent-path category text", () => {
  it("describes a category seeded with only its kind, keeping a node's own text", () => {
    const bare = (id: string): GraphNode => ({ id, level: "category", parentId: null, axes: { kind: id }, createdAt: "2026-01-01T00:00:00Z" })
    const q = categoryQuestions([bare("support"), bare("social"), node("code", null, "Our own words")]).category
    expect(q.criteria.support).toMatch(/person talking to an agent/)
    expect(q.criteria.social).toMatch(/audience/)
    expect(q.criteria.code).toBe("Our own words")
  })
})

describe("proposePathViaSeat", () => {
  it("returns null when the seat is off", async () => {
    seat("off", {})
    expect(await proposePathViaSeat(input, NODES)).toBeNull()
  })

  it("narrows category then verb and reports confidence as the weaker stage", async () => {
    seat("active", {
      category: { probabilities: { code: 0.9, ops: 0.05, admin: 0.05 } },
      verb: { probabilities: { "review.merge-request": 0.7, "fix.bug": 0.3 } },
    })
    const p = await proposePathViaSeat(input, NODES)
    expect(p?.path).toEqual(["code", "review.merge-request"])
    expect(p?.confidence).toBeCloseTo(0.7, 5)
    expect(p?.confident).toBe(true)
    expect(p?.mode).toBe("active")
  })

  it("is not confident when either stage falls under its threshold", async () => {
    seat("active", {
      // Three-way split: the argmax carries under half the mass.
      category: { probabilities: { code: 0.3, ops: 0.4, admin: 0.3 } },
      verb: { probabilities: { "deploy.staging": 0.9, "restart.service": 0.1 } },
    })
    const p = await proposePathViaSeat(input, NODES)
    expect(p?.path).toEqual(["ops", "deploy.staging"])
    expect(p?.confident).toBe(false)
  })

  it("keeps only the category when the verb is weak but above the floor", async () => {
    seat("active", {
      category: { probabilities: { code: 0.9, ops: 0.05, admin: 0.05 } },
      verb: { probabilities: { "review.merge-request": 0.4, "fix.bug": 0.6 } },
    })
    // fix.bug wins at 0.6: a full path.
    expect((await proposePathViaSeat(input, NODES))?.path).toEqual(["code", "fix.bug"])

    resetDecisionsRuntime()
    seat("active", {
      category: { probabilities: { code: 0.9, ops: 0.05, admin: 0.05 } },
      verb: { probabilities: { "review.merge-request": 0.4, "fix.bug": 0.35, "write.tests": 0.25, "refactor.module": 0 } },
    })
    const p = await proposePathViaSeat(input, WIDE)
    expect(p?.path).toEqual(["code"])
    expect(p?.confidence).toBeCloseTo(0.9, 5)
    expect(p?.confident).toBe(true)
  })

  it("still hands a verb under the floor to the LLM", async () => {
    seat("active", {
      category: { probabilities: { code: 0.9, ops: 0.05, admin: 0.05 } },
      verb: { probabilities: { "review.merge-request": 0.28, "fix.bug": 0.26, "write.tests": 0.24, "refactor.module": 0.22 } },
    })
    const p = await proposePathViaSeat(input, WIDE)
    expect(p?.path).toEqual(["code", "review.merge-request"])
    expect(p?.confident).toBe(false)
  })

  it("only asks for a verb inside the chosen category", async () => {
    seat("active", {
      category: { probabilities: { code: 0.1, ops: 0.8, admin: 0.1 } },
      // A verb from the other category is not an option and cannot be picked.
      verb: { probabilities: { "review.merge-request": 1, "deploy.staging": 0.6, "restart.service": 0.4 } },
    })
    const p = await proposePathViaSeat(input, NODES)
    expect(p?.path[0]).toBe("ops")
    expect(["deploy.staging", "restart.service"]).toContain(p?.path[1])
  })

  it("fails open when the backend breaks", async () => {
    registerDecisionBackend("mock", () => createMockDecisionBackend({ fail: new Error("down") }))
    configureDecisions({ enabled: true, seats: { [INTENT_PATH_SEAT]: { mode: "active", backend: "mock" } } })
    expect(await proposePathViaSeat(input, NODES)).toBeNull()
  })
})
