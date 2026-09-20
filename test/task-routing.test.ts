import { describe, it, expect, vi, beforeEach } from "vitest"

// The routing policy — every branch that must NOT downgrade.
//
// Downgrading is invisible in the output. The reply still arrives, still
// reads fluently, and is simply worse in ways nobody checks. So the only
// path to a cheaper model is an explicit, confident "no" from an ACTIVE
// seat, and each test below is one way that could have leaked.
//
// The seat itself measured 8/8 on real traffic shapes, with the two
// classes well separated:
//
//   "ok thanks!"                                  0.15
//   "what time is the standup?"                   0.18
//   "the staging deploy failed, find out why"     0.77
//   "drop the old invoices table from production" 0.80
//
// The 0.2 threshold sits in the empty space between them.

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: hoisted.askSeat }))

const answer = (p: number, mode = "active") => ({
  answers: { needsFlagship: { type: "noul", noul: p } },
  callId: "test", mode,
})

const base = {
  message: "ok thanks!",
  agent: "devops-agent",
  cheapModel: "claude-haiku-4-5",
}

describe("routeTaskModel", () => {
  beforeEach(() => {
    hoisted.askSeat.mockReset()
    vi.resetModules()
  })

  it("downgrades a mechanical task when the seat is active and sure", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.13))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel(base)
    expect(route.downgraded).toBe(true)
    expect(route.model).toBe("claude-haiku-4-5")
  })

  it("keeps the flagship when the seat is only in shadow", async () => {
    // A shadow seat records and changes nothing. If shadow could route,
    // a soak would be indistinguishable from a rollout.
    hoisted.askSeat.mockResolvedValue(answer(0.05, "shadow"))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel(base)
    expect(route.downgraded).toBe(false)
    expect(route.model).toBeUndefined()
    expect(route.reason).toMatch(/shadow/)
    // The answer is still reported, so a soak can be read off the logs.
    expect(route.needsFlagship).toBe(0.05)
  })

  it("keeps the flagship when the seat is unavailable", async () => {
    // askSeat is fail-OPEN by contract and returns null when a seat is off
    // or its backend is down. Open has to mean "expensive" here: an outage
    // that silently made the fleet answer on a smaller model would cost
    // far more than the tokens it saved.
    hoisted.askSeat.mockResolvedValue(null)
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel(base)
    expect(route.downgraded).toBe(false)
    expect(route.reason).toMatch(/unavailable/i)
  })

  it("keeps the flagship when the seat throws", async () => {
    hoisted.askSeat.mockRejectedValue(new Error("network"))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel(base)
    expect(route.downgraded).toBe(false)
  })

  it("keeps the flagship above the threshold", async () => {
    hoisted.askSeat.mockResolvedValue(answer(0.77))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel({ ...base, message: "why did the deploy fail" })
    expect(route.downgraded).toBe(false)
    expect(route.needsFlagship).toBe(0.77)
  })

  it("never asks when no cheaper model is configured", async () => {
    // The feature cannot turn itself on. No model named, no call spent.
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel({ ...base, cheapModel: null })
    expect(route.downgraded).toBe(false)
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })

  it("keeps the model on a follow-up while the cache is still warm", async () => {
    // Switching mid-session is mechanically fine — it is what /model does.
    // It is the ARITHMETIC that says no: the new model has no cache for
    // the transcript, so it reads all of it at $1.00/M against opus's
    // cached $0.50/M, and only wins back the difference on output. A task
    // worth downgrading has a short answer, so the swap loses.
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel({
      ...base, isFollowUp: true, sessionIdleMs: 30_000,
    })
    expect(route.downgraded).toBe(false)
    expect(route.reason).toMatch(/warm cache/i)
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })

  it("routes a follow-up once the cache has gone cold", async () => {
    // Past the TTL there is no cached read left to give up: opus pays
    // $5.00/M and haiku $1.00/M, so the cheap model wins outright. A rule
    // that refused here would be leaving the easy savings on the table.
    hoisted.askSeat.mockResolvedValue(answer(0.13))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel({
      ...base, isFollowUp: true, sessionIdleMs: 3 * 60 * 60 * 1000,
    })
    expect(route.downgraded).toBe(true)
    expect(route.model).toBe("claude-haiku-4-5")
  })

  it("still keeps the flagship on a cold follow-up that needs it", async () => {
    // A cold cache makes the swap affordable, not advisable. The seat
    // still decides.
    hoisted.askSeat.mockResolvedValue(answer(0.8))
    const { routeTaskModel } = await import("../src/agents/routing")

    const route = await routeTaskModel({
      ...base, isFollowUp: true, sessionIdleMs: 3 * 60 * 60 * 1000,
    })
    expect(route.downgraded).toBe(false)
  })
})
