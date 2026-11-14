import { describe, it, expect, vi, beforeEach } from "vitest"

// Moving a job UP to the edge model, and asking for sub-agents.
//
// The move costs money and quota, so the only path to it is an explicit,
// confident "yes" from an ACTIVE seat. Each test below is one way a job
// could have moved up, or been told to fan out, without that.
//
// Live Jev on sample tasks, 2026-11-14 (needs edge / sub-agents help):
//
//   "ok thanks!"                                         0.02 / 0.04
//   "the staging deploy failed, find out why"            0.24 / 0.35
//   "update the copyright year in all 40 repositories…"  0.22 / 0.96
//   "audit the auth layer for token replay and races…"   0.64 / 0.71
//   "design how session ids flow across mesh hops…"      0.76 / 0.58
//   "jobs vanish under load, two fixes did not hold…"    0.90 / 0.73

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn(), getSeatMode: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: hoisted.askSeat, getSeatMode: hoisted.getSeatMode }))

const answer = (edge: number, sub: number, mode = "active") => ({
  answers: {
    needsEdge: { type: "noul", noul: edge },
    subagentsHelp: { type: "noul", noul: sub },
  },
  callId: "test", mode,
})

const base = {
  message: "the queue loses jobs under load and two fixes did not hold; find the cause",
  agent: "ops-agent",
  tier: "claude-code",
  edgeModel: "claude-fable-5-2",
  currentModel: "claude-opus-5-5",
}

describe("routeTaskEdge", () => {
  beforeEach(() => {
    hoisted.askSeat.mockReset()
    hoisted.getSeatMode.mockReset()
  })

  it("moves a hard job to the edge model when the seat is active and sure", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.93, 0.1))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(base)
    expect(route.upgraded).toBe(true)
    expect(route.model).toBe("claude-fable-5-2")
    expect(route.subagents).toBe(false)
  })

  it("moves a follow-up too: the move is for quality, not for cost", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.9, 0.1))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge({ ...base, isFollowUp: true })
    expect(route.upgraded).toBe(true)
  })

  it("changes nothing while the seat is in shadow", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.99, 0.99, "shadow"))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(base)
    expect(route.upgraded).toBe(false)
    expect(route.subagents).toBe(false)
    expect(route.model).toBeUndefined()
    expect(route.needsEdge).toBe(0.99)
    expect(route.reason).toMatch(/shadow/)
  })

  it("keeps the agent's model when the answer is under the threshold", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.69, 0.2))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(base)
    expect(route.upgraded).toBe(false)
    expect(route.model).toBeUndefined()
  })

  it.each([
    ["the seat is off or unreachable", () => hoisted.askSeat.mockResolvedValue(null)],
    ["the seat throws", () => hoisted.askSeat.mockRejectedValue(new Error("boom"))],
    ["the answer is malformed", () => hoisted.askSeat.mockResolvedValue({ answers: {}, callId: "x", mode: "active" })],
  ])("changes nothing when %s", async (_name, arrange) => {
    arrange()
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(base)
    expect(route.upgraded).toBe(false)
    expect(route.subagents).toBe(false)
    expect(route.model).toBeUndefined()
  })

  it("does not move up without an edge model, but still advises sub-agents", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.9))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge({ ...base, edgeModel: null })
    expect(route.upgraded).toBe(false)
    expect(route.model).toBeUndefined()
    expect(route.subagents).toBe(true)
  })

  it("does not respawn an agent that already runs on the edge model", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge({ ...base, currentModel: "claude-fable-5-2" })
    expect(route.upgraded).toBe(false)
    expect(route.reason).toMatch(/already on the edge model/)
  })

  it("advises sub-agents only for Claude Code", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.9, 0.9))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge({ ...base, tier: "codex-cli", edgeModel: "gpt-6-astra", currentModel: "gpt-6" })
    expect(route.upgraded).toBe(true)
    expect(route.subagents).toBe(false)
  })

  it.each(["voice", "desktop", "opencode"])("leaves %s requests on the model the person picked", async (channel) => {
    hoisted.askSeat.mockResolvedValue(answer(0.99, 0.99))
    const { routeTaskEdge } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge({ ...base, channel })
    expect(route.upgraded).toBe(false)
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })
})

describe("edgePlanFor", () => {
  const route = { model: "claude-fable-5-2", upgraded: true, subagents: true, needsEdge: 0.9, subagentsHelp: 0.9, reason: "" }

  it("puts the job and its sub-agents on the edge model and adds the hint", async () => {
    const { edgePlanFor, SUBAGENT_NOTE } = await import("../src/agents/edge-routing")
    expect(edgePlanFor(route, { tier: "claude-code" })).toEqual({
      model: "claude-fable-5-2", subagentModel: "claude-fable-5-2", turnNote: SUBAGENT_NOTE,
    })
  })

  it("adds only the hint when the job stays on the agent's model", async () => {
    const { edgePlanFor, SUBAGENT_NOTE } = await import("../src/agents/edge-routing")
    const plan = edgePlanFor({ ...route, model: undefined, upgraded: false }, { tier: "claude-code" })
    expect(plan).toEqual({ turnNote: SUBAGENT_NOTE })
  })

  it("drops the hint when the session's tool list leaves the sub-agent tool out", async () => {
    const { edgePlanFor } = await import("../src/agents/edge-routing")
    const plan = edgePlanFor(route, { tier: "claude-code", claudeArgs: ["--tools", "Read,Grep,ToolSearch"] })
    expect(plan).toEqual({ model: "claude-fable-5-2" })
    const kept = edgePlanFor(route, { tier: "claude-code", claudeArgs: ["--tools", "Read,Agent,ToolSearch"] })
    expect(kept.turnNote).toBeDefined()
  })

  it("changes nothing without a route", async () => {
    const { edgePlanFor } = await import("../src/agents/edge-routing")
    expect(edgePlanFor(undefined, { tier: "claude-code" })).toEqual({})
  })
})

describe("edgeModelForEngine", () => {
  it("accepts only a model of the agent's own engine", async () => {
    const { edgeModelForEngine } = await import("../src/agents/edge-routing")
    const routing = { edgeModels: { "claude-code": "claude-fable-5-2", "codex-cli": "gpt-6-astra" } }
    expect(edgeModelForEngine("claude-code", routing)).toBe("claude-fable-5-2")
    expect(edgeModelForEngine("codex-cli", routing)).toBe("gpt-6-astra")
    expect(edgeModelForEngine("claude-code", { edgeModels: { "claude-code": "gpt-6" } })).toBeUndefined()
    expect(edgeModelForEngine("orchestrator", routing)).toBeUndefined()
    expect(edgeModelForEngine("claude-code", {})).toBeUndefined()
  })
})

describe("edgeSeatOn", () => {
  it("is false when the seat is off or its mode cannot be read", async () => {
    const { edgeSeatOn } = await import("../src/agents/edge-routing")
    hoisted.getSeatMode.mockReturnValue("off")
    expect(edgeSeatOn()).toBe(false)
    hoisted.getSeatMode.mockImplementation(() => { throw new Error("no config") })
    expect(edgeSeatOn()).toBe(false)
    hoisted.getSeatMode.mockReturnValue("shadow")
    expect(edgeSeatOn()).toBe(true)
  })
})
