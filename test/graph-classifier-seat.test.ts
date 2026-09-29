import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { GraphStore } from "../src/graph/store"
import { Classifier } from "../src/graph/classifier"
import { configureDecisions, resetDecisionsRuntime } from "../src/decisions/seat"
import { registerDecisionBackend } from "../src/decisions/backend"
import { createMockDecisionBackend } from "../src/decisions/backends/mock"
import { INTENT_PATH_SEAT } from "../src/decisions/seats/intent-path"

// The classifier used to spawn a fresh `claude -p` for every cache miss.
// With the intent-path seat active it asks the seat first and only falls
// back to the model when the seat is not confident. The model here is a
// stub that records whether it was asked; it must never be reached when
// the seat answered.

const llm = vi.hoisted(() => ({ calls: 0, reply: "" }))
vi.mock("../src/agent/providers", () => ({
  createProvider: () => ({
    generate: async () => { llm.calls++; if (!llm.reply) throw new Error("no model in tests"); return { content: llm.reply } },
  }),
}))

let tmp: string
let store: GraphStore
let classifier: Classifier

beforeEach(() => {
  resetDecisionsRuntime()
  llm.calls = 0
  llm.reply = ""
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-classifier-seat-"))
  store = new GraphStore({ baseDir: tmp, log: () => undefined })
  store.loadSchema()
  const at = "2026-01-01T00:00:00Z"
  store.saveNodes({ version: 1, nodes: [
    { id: "code", level: "category", parentId: null, axes: { name: "code", description: "Software work" }, createdAt: at },
    { id: "ops", level: "category", parentId: null, axes: { name: "ops", description: "Infrastructure" }, createdAt: at },
    { id: "admin", level: "category", parentId: null, axes: { name: "admin", description: "Administration" }, createdAt: at },
    { id: "review.merge-request", level: "verb", parentId: "code", axes: { name: "review.merge-request", description: "Review an MR" }, createdAt: at },
    { id: "fix.bug", level: "verb", parentId: "code", axes: { name: "fix.bug", description: "Fix a defect" }, createdAt: at },
    { id: "deploy.staging", level: "verb", parentId: "ops", axes: { name: "deploy.staging", description: "Deploy" }, createdAt: at },
    { id: "restart.service", level: "verb", parentId: "ops", axes: { name: "restart.service", description: "Restart" }, createdAt: at },
  ] })
  classifier = new Classifier({ store, daemonUrl: "http://127.0.0.1:1", log: () => undefined })
})
afterEach(() => {
  resetDecisionsRuntime()
  rmSync(tmp, { recursive: true, force: true })
})

const seat = (mode: "off" | "shadow" | "active", answers: Record<string, { probabilities: Record<string, number> }>) => {
  registerDecisionBackend("mock", () => createMockDecisionBackend({ answers }))
  configureDecisions({ enabled: true, seats: { [INTENT_PATH_SEAT]: { mode, backend: "mock" } } })
}
const msg = { text: "please review MR !5 on noqta/minbar", channel: "gitlab", agentId: "coder", chatId: "noqta/minbar:mr:5" }

describe("Classifier with the intent-path seat", () => {
  it("active: the seat's confident answer is the classification and the model is not asked", async () => {
    seat("active", {
      category: { probabilities: { code: 0.9, ops: 0.05, admin: 0.05 } },
      verb: { probabilities: { "review.merge-request": 0.8, "fix.bug": 0.2 } },
    })
    const r = await classifier.classify(msg)
    expect(r?.path).toEqual(["code", "review.merge-request"])
    expect(r?.source).toBe("seat")
    expect(r?.status).toBe("approved")
    expect(llm.calls).toBe(0)
    // Recorded with the conversation it belongs to.
    expect(store.readRecentClassifications(1)[0]?.chatId).toBe("noqta/minbar:mr:5")
    // The next identical request is a cache hit.
    const again = await classifier.classify(msg)
    expect(again?.source).toBe("cache")
  })

  it("active but unconfident: falls back to the model", async () => {
    seat("active", {
      category: { probabilities: { code: 0.3, ops: 0.4, admin: 0.3 } },
      verb: { probabilities: { "deploy.staging": 0.5, "restart.service": 0.5 } },
    })
    llm.reply = '{"path":["code","fix.bug"],"proposedAxes":{},"leaf":{},"confidence":0.9}'
    const r = await classifier.classify(msg)
    expect(llm.calls).toBe(1)
    expect(r?.source).toBe("llm")
    expect(r?.path).toEqual(["code", "fix.bug"])
  })

  it("shadow: the model decides and the seat's answer does not change it", async () => {
    seat("shadow", {
      category: { probabilities: { code: 0.05, ops: 0.9, admin: 0.05 } },
      verb: { probabilities: { "deploy.staging": 0.9, "restart.service": 0.1 } },
    })
    llm.reply = '{"path":["code","fix.bug"],"proposedAxes":{},"leaf":{},"confidence":0.9}'
    const r = await classifier.classify(msg)
    expect(r?.source).toBe("llm")
    expect(r?.path).toEqual(["code", "fix.bug"])
  })

  it("off: the model decides as before", async () => {
    seat("off", {})
    llm.reply = '{"path":["ops","deploy.staging"],"proposedAxes":{},"leaf":{},"confidence":0.9}'
    const r = await classifier.classify(msg)
    expect(llm.calls).toBe(1)
    expect(r?.path).toEqual(["ops", "deploy.staging"])
  })
})
