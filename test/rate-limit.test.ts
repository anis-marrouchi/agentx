import { describe, it, expect } from "vitest"
import { RateLimiter } from "../src/daemon/rate-limit"

describe("RateLimiter.acquire (queueing)", () => {
  it("returns immediately when a slot is available", async () => {
    const rl = new RateLimiter(5, 100)
    const start = Date.now()
    const r = await rl.acquire("a")
    expect(r.ok).toBe(true)
    expect(Date.now() - start).toBeLessThan(50)
  })

  it("waits for the per-minute window to reopen under pressure", async () => {
    const rl = new RateLimiter(2, 100)
    // Burn both slots for agent A.
    await rl.acquire("a")
    await rl.acquire("a")
    expect(rl.check("a").allowed).toBe(false)

    // Acquire a third — should block a bit, then succeed. We can't wait a real
    // minute in a unit test, so we just verify the onWait hook fires and the
    // returned promise doesn't resolve instantly.
    let waited: { reason: string; waitMs: number } | null = null
    const p = rl.acquire("a", {
      maxWaitMs: 200,
      onWait: (reason, waitMs) => { waited = { reason, waitMs } },
    })
    const result = await p
    expect(result.ok).toBe(false)            // our 200ms cap is shorter than the 60s window
    expect(waited).not.toBeNull()
    expect(waited!.reason).toMatch(/Rate limit/)
    expect(waited!.waitMs).toBeGreaterThan(0)
  })

  it("isolates agents — one agent's ceiling does not block another", async () => {
    const rl = new RateLimiter(1, 100)
    await rl.acquire("a")
    const r = await rl.acquire("b")
    expect(r.ok).toBe(true)
  })

  it("usage() reflects recorded slots", async () => {
    const rl = new RateLimiter(10, 100)
    await rl.acquire("x")
    await rl.acquire("x")
    expect(rl.usage("x").lastMinute).toBe(2)
    expect(rl.usage("x").lastHour).toBe(2)
  })
})
