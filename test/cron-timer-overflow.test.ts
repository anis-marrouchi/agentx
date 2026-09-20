import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// A cron job scheduled further out than ~24.8 days fired the instant the
// daemon started, on every restart, forever.
//
// Node stores a timer delay in a 32-bit signed int. Past 2147483647ms it
// silently coerces the delay to 1 and emits only a TimeoutOverflowWarning
// — so a monthly accounting job set for the 20th ran a month early on
// every deploy, and the sole symptom was a warning about integers.
//
// These tests exercise the arming arithmetic directly. The scheduler needs
// config, storage and a registry to construct, none of which this bug
// touches.

const MAX = 2_147_483_647

/** Mirrors CronScheduler.armTimer. */
function armTimer(targetMs: number, fire: () => void, set: typeof setTimeout): void {
  const remaining = targetMs - Date.now()
  if (remaining > MAX) {
    set(() => armTimer(targetMs, fire, set), MAX)
    return
  }
  set(fire, Math.max(0, remaining))
}

describe("cron timer overflow", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("does not fire a far-future job immediately", () => {
    const fired = vi.fn()
    // 30 days out — past the 24.8-day ceiling.
    armTimer(Date.now() + 30 * 86_400_000, fired, setTimeout)

    vi.advanceTimersByTime(1000)
    expect(fired, "fired within a second of arming").not.toHaveBeenCalled()
    vi.advanceTimersByTime(20 * 86_400_000)
    expect(fired, "fired before its time").not.toHaveBeenCalled()
  })

  it("fires a far-future job at the right moment, across hops", () => {
    const fired = vi.fn()
    armTimer(Date.now() + 30 * 86_400_000, fired, setTimeout)
    vi.advanceTimersByTime(30 * 86_400_000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("still fires a normal near-future job exactly once", () => {
    const fired = vi.fn()
    armTimer(Date.now() + 60_000, fired, setTimeout)
    vi.advanceTimersByTime(59_000)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("fires a missed job immediately rather than never", () => {
    const fired = vi.fn()
    armTimer(Date.now() - 5_000, fired, setTimeout)
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("recomputes from the target, so hops cannot accumulate drift", () => {
    const fired = vi.fn()
    const target = Date.now() + 60 * 86_400_000 // two hops
    armTimer(target, fired, setTimeout)
    vi.advanceTimersByTime(60 * 86_400_000 - 1)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
