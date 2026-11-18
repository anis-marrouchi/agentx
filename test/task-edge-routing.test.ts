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
    expect(route.model).toBe("claude-fable-5-2")
    expect(route.reason).toMatch(/already on the edge model/)
    const { edgePlanFor } = await import("../src/agents/edge-routing")
    expect(edgePlanFor(route, { tier: "claude-code" })).toEqual({})
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

// The downgrade (task-tier routing) and the edge seat are asked at the same
// time, and the edge seat only knows the agent's configured model. #1864: an
// agent configured on the edge model used to run a hard job on the cheap
// model, because "already on the edge model" left the downgrade in place.
describe("jobModelFor", () => {
  const onEdge = { ...base, currentModel: "claude-fable-5-2" }
  const cheap = "claude-haiku-5-5"

  it("drops a downgrade when the seat is sure and the agent is already on the edge model", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge, jobModelFor } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(onEdge)
    // No override: the job runs on the agent's own model, the edge model.
    expect(jobModelFor(route, cheap)).toBeUndefined()
  })

  it("keeps the downgrade when the seat is under the threshold", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.69, 0.1))
    const { routeTaskEdge, jobModelFor } = await import("../src/agents/edge-routing")
    expect(jobModelFor(await routeTaskEdge(onEdge), cheap)).toBe(cheap)
  })

  it("keeps the downgrade when only sub-agents are advised", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.2, 0.9))
    const { routeTaskEdge, jobModelFor } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(onEdge)
    expect(route.subagents).toBe(true)
    expect(jobModelFor(route, cheap)).toBe(cheap)
  })

  it("keeps the downgrade while the seat is in shadow", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.99, 0.1, "shadow"))
    const { routeTaskEdge, jobModelFor } = await import("../src/agents/edge-routing")
    expect(jobModelFor(await routeTaskEdge(onEdge), cheap)).toBe(cheap)
  })

  it("puts the edge model over a downgrade when the agent is on another model", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge, jobModelFor } = await import("../src/agents/edge-routing")
    expect(jobModelFor(await routeTaskEdge(base), cheap)).toBe("claude-fable-5-2")
  })

  it("passes the downgrade through when there is no route", async () => {
    const { jobModelFor } = await import("../src/agents/edge-routing")
    expect(jobModelFor(undefined, cheap)).toBe(cheap)
    expect(jobModelFor(undefined, undefined)).toBeUndefined()
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

// A person describes a problem and asks for nothing. Read as a sentence it
// is a remark; the work it leads to can still be large. Each test is one
// way a remark could start work, or a job could move up, that nobody
// switched on.
describe("implied work", () => {
  const implied = (edge: number, pImplied: number, design: number, mode = "active") => ({
    answers: {
      needsEdge: { type: "noul", noul: edge },
      subagentsHelp: { type: "noul", noul: 0.2 },
      workAsked: {
        type: "choice", choice: pImplied >= 0.5 ? "implied" : "asked",
        probabilities: { asked: 1 - pImplied, implied: pImplied, none: 0 },
      },
      designChange: { type: "noul", noul: design },
    },
    callId: "test", mode,
  })
  const remark = { ...base, message: "we cannot see whether an agent is still working on its job" }

  let routeTaskEdge: typeof import("../src/agents/edge-routing").routeTaskEdge
  let edgePlanFor: typeof import("../src/agents/edge-routing").edgePlanFor
  let IMPLIED_WORK_NOTE: string, SUBAGENT_NOTE: string, IMPLIED_AT: number

  beforeEach(async () => {
    hoisted.askSeat.mockReset()
    hoisted.getSeatMode.mockReset()
    ;({ routeTaskEdge, edgePlanFor, IMPLIED_WORK_NOTE, SUBAGENT_NOTE, IMPLIED_AT } = await import("../src/agents/edge-routing"))
  })

  it("does not ask the two questions when the setting is off", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.3, 0.2))
    const r = await routeTaskEdge({ ...remark })
    expect(Object.keys(hoisted.askSeat.mock.calls[0][2])).toEqual(["needsEdge", "subagentsHelp"])
    expect(r.impliedWork).toBeUndefined()
  })

  it("asks them in the same call when the setting is on", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
    await routeTaskEdge({ ...remark, impliedWork: "shadow" })
    expect(hoisted.askSeat).toHaveBeenCalledTimes(1)
    expect(Object.keys(hoisted.askSeat.mock.calls[0][2])).toEqual(["needsEdge", "subagentsHelp", "workAsked", "designChange"])
  })

  it("active: a problem that needs a design change moves up and the agent states the job", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(true)
    expect(r.model).toBe("claude-fable-5-2")
    expect(r.impliedWork).toBe(true)
    expect(r.reason).toContain("implied hard task")
    expect(edgePlanFor(r, { tier: "claude-code" }).turnNote).toBe(IMPLIED_WORK_NOTE)
  })

  it("active: a small implied fix gets the line and keeps the agent's model", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.05, 0.99, 0.1))
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBe(true)
    expect(edgePlanFor(r, { tier: "claude-code" })).toEqual({ turnNote: IMPLIED_WORK_NOTE })
  })

  it("active: an outright request is left alone, however large the design score", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, 0.1, 0.9))
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBe(false)
    expect(edgePlanFor(r, { tier: "claude-code" })).toEqual({})
  })

  it("active: an unsure reading (under the threshold) changes nothing", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, IMPLIED_AT - 0.01, 0.95))
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBe(false)
  })

  it("shadow: records what it would do and changes nothing", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
    const r = await routeTaskEdge({ ...remark, impliedWork: "shadow" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBe(false)
    expect(r.impliedP).toBe(0.98)
    expect(r.reason).toContain("implied work (shadow): would state the job and move up")
    expect(edgePlanFor(r, { tier: "claude-code" })).toEqual({})
  })

  it("a seat in shadow changes nothing even when implied work is active", async () => {
    hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85, "shadow"))
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBe(false)
  })

  it("a missing or malformed answer changes nothing", async () => {
    hoisted.askSeat.mockResolvedValue({
      answers: { needsEdge: { type: "noul", noul: 0.3 }, subagentsHelp: { type: "noul", noul: 0.2 }, workAsked: { type: "choice" } },
      callId: "test", mode: "active",
    })
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(r.upgraded).toBe(false)
    expect(r.impliedWork).toBeFalsy()
  })

  it("both lines are carried when the job is implied and splits into parts", async () => {
    const a = implied(0.3, 0.98, 0.85)
    a.answers.subagentsHelp.noul = 0.9
    hoisted.askSeat.mockResolvedValue(a)
    const r = await routeTaskEdge({ ...remark, impliedWork: "active" })
    expect(edgePlanFor(r, { tier: "claude-code" }).turnNote).toBe(`${IMPLIED_WORK_NOTE}\n${SUBAGENT_NOTE}`)
  })

  // #1864 for implied hard work: the same downgrade gap, reached through
  // the design-change answer instead of "needs the edge model".
  describe("with a downgrade routed for the same job", () => {
    const onEdge = { ...remark, currentModel: "claude-fable-5-2", impliedWork: "active" as const }
    const cheap = "claude-haiku-5-5"

    it("agent on the edge model, implied hard work → the downgrade is dropped", async () => {
      hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
      const { jobModelFor } = await import("../src/agents/edge-routing")
      const r = await routeTaskEdge(onEdge)
      expect(r.model).toBe("claude-fable-5-2")
      expect(r.upgraded).toBe(false)
      // No override: the job runs on the agent's own model, the edge model.
      expect(jobModelFor(r, cheap)).toBeUndefined()
    })

    it("agent on the edge model, design change under the threshold → the downgrade applies", async () => {
      hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.69))
      const { jobModelFor } = await import("../src/agents/edge-routing")
      expect(jobModelFor(await routeTaskEdge(onEdge), cheap)).toBe(cheap)
    })

    it("agent on the edge model, implied work in shadow → the downgrade applies", async () => {
      hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
      const { jobModelFor } = await import("../src/agents/edge-routing")
      expect(jobModelFor(await routeTaskEdge({ ...onEdge, impliedWork: "shadow" }), cheap)).toBe(cheap)
    })

    it("agent on another model, implied hard work → the edge model", async () => {
      hoisted.askSeat.mockResolvedValue(implied(0.3, 0.98, 0.85))
      const { jobModelFor } = await import("../src/agents/edge-routing")
      expect(jobModelFor(await routeTaskEdge({ ...onEdge, currentModel: "claude-opus-5-5" }), cheap)).toBe("claude-fable-5-2")
    })
  })
})

// The log line the registry writes. The edge seat only sees the agent's
// configured model, so its reason can say "already on the edge model"
// while task-tier routing had sent the job down. The line must say which
// model the job actually runs on.
describe("edgeRouteLog", () => {
  const onEdge = { ...base, currentModel: "claude-fable-5-2" }
  const cheap = "claude-haiku-5-5"

  beforeEach(() => {
    hoisted.askSeat.mockReset()
  })

  it("names the dropped downgrade and the model the job runs on", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge, edgeRouteLog } = await import("../src/agents/edge-routing")
    const line = edgeRouteLog(await routeTaskEdge(onEdge), cheap)
    expect(line).toMatch(/^hard task → claude-fable-5-2 for this job/)
    expect(line).toContain(`downgrade to ${cheap} dropped`)
    expect(line).not.toMatch(/already on the edge model/)
  })

  it("says the same for implied hard work", async () => {
    hoisted.askSeat.mockResolvedValue({
      answers: {
        needsEdge: { type: "noul", noul: 0.3 },
        subagentsHelp: { type: "noul", noul: 0.2 },
        workAsked: { type: "choice", choice: "implied", probabilities: { asked: 0.02, implied: 0.98, none: 0 } },
        designChange: { type: "noul", noul: 0.85 },
      },
      callId: "test", mode: "active",
    })
    const { routeTaskEdge, edgeRouteLog } = await import("../src/agents/edge-routing")
    const line = edgeRouteLog(await routeTaskEdge({ ...onEdge, impliedWork: "active" }), cheap)
    expect(line).toMatch(/^implied hard task → claude-fable-5-2 for this job/)
    expect(line).toContain(`downgrade to ${cheap} dropped`)
  })

  it("keeps \"already on the edge model\" when no downgrade was routed", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge, edgeRouteLog } = await import("../src/agents/edge-routing")
    const line = edgeRouteLog(await routeTaskEdge(onEdge), undefined)
    expect(line).toMatch(/already on the edge model \(claude-fable-5-2\)/)
    expect(line).not.toContain("dropped")
  })

  it("names the dropped downgrade on a real move up", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.95, 0.1))
    const { routeTaskEdge, edgeRouteLog } = await import("../src/agents/edge-routing")
    const line = edgeRouteLog(await routeTaskEdge(base), cheap)
    expect(line).toMatch(/^hard task → claude-fable-5-2 for this job/)
    expect(line).toContain(`downgrade to ${cheap} dropped`)
  })

  it("is the plain reason when the downgrade stands", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.2, 0.9))
    const { routeTaskEdge, edgeRouteLog } = await import("../src/agents/edge-routing")
    const route = await routeTaskEdge(onEdge)
    expect(edgeRouteLog(route, cheap)).toBe(route.reason)
  })
})
