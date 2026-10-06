import { describe, expect, it } from "vitest"
import { DEFAULT_TRIAGE_ACTIONS, triageModelFor } from "../src/agents/routing"
import { daemonConfigSchema } from "../src/daemon/config"

// #615 — a run started only by triage events (a label added or removed, an
// issue closed) can go to a cheaper model named in config. Off until a
// model is set for the agent's engine.

const haiku = "claude-haiku-4-5-20251001"
const base = {
  tier: "claude-code",
  channel: "github",
  eventActions: ["labeled"],
  triage: { models: { "claude-code": haiku } },
  isFollowUp: false,
}

describe("triageModelFor", () => {
  it("routes a label-only run to the triage model", () => {
    const r = triageModelFor(base)
    expect(r.downgraded).toBe(true)
    expect(r.model).toBe(haiku)
  })

  it("is off without a model for the engine", () => {
    expect(triageModelFor({ ...base, triage: {} }).downgraded).toBe(false)
    expect(triageModelFor({ ...base, triage: undefined }).downgraded).toBe(false)
    expect(triageModelFor({ ...base, tier: "codex-cli" }).downgraded).toBe(false)
  })

  it("keeps the agent's model when any collapsed action is not triage", () => {
    const r = triageModelFor({ ...base, eventActions: ["opened", "labeled"] })
    expect(r.downgraded).toBe(false)
    expect(r.reason).toContain("opened")
  })

  it("keeps the agent's model for runs not started by a platform event", () => {
    expect(triageModelFor({ ...base, eventActions: undefined }).downgraded).toBe(false)
    expect(triageModelFor({ ...base, eventActions: [] }).downgraded).toBe(false)
  })

  it("keeps a warm session's model and routes a cold one", () => {
    expect(triageModelFor({ ...base, isFollowUp: true, sessionIdleMs: 5 * 60_000 }).downgraded).toBe(false)
    expect(triageModelFor({ ...base, isFollowUp: true, sessionIdleMs: 2 * 60 * 60_000 }).downgraded).toBe(true)
  })

  it("only takes a model that fits the engine", () => {
    expect(triageModelFor({ ...base, triage: { models: { "claude-code": "gpt-5-mini" } } }).downgraded).toBe(false)
    const codex = triageModelFor({ ...base, tier: "codex-cli", triage: { models: { "codex-cli": "gpt-5-mini" } } })
    expect(codex.model).toBe("gpt-5-mini")
    expect(triageModelFor({ ...base, tier: "opencode" }).downgraded).toBe(false)
  })

  it("honours a custom action list", () => {
    const triage = { ...base.triage, actions: ["labeled", "assigned"] }
    expect(triageModelFor({ ...base, triage, eventActions: ["assigned"] }).downgraded).toBe(true)
    expect(triageModelFor({ ...base, triage, eventActions: ["closed"] }).downgraded).toBe(false)
  })

  it("never applies on channels where the person picked the model", () => {
    expect(triageModelFor({ ...base, channel: "voice" }).downgraded).toBe(false)
  })
})

describe("session.triage config", () => {
  const node = { id: "n", name: "N" }

  it("defaults to no model and the label/close actions", () => {
    const parsed = daemonConfigSchema.parse({ node })
    expect(parsed.session.triage.models).toEqual({})
    expect(parsed.session.triage.actions).toEqual([...DEFAULT_TRIAGE_ACTIONS])
  })

  it("accepts a model per engine", () => {
    const parsed = daemonConfigSchema.parse({ node, session: { triage: { models: { "claude-code": haiku } } } })
    expect(parsed.session.triage.models["claude-code"]).toBe(haiku)
  })
})
