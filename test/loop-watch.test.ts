import { describe, expect, it } from "vitest"
import { loopStallLine, startLoopWatch, LOOP_STALL_WARN_MS } from "../src/daemon/loop-watch"

describe("loop watch", () => {
  it("stays quiet while the main thread keeps up", () => {
    expect(loopStallLine(150, 40, 60_000)).toBeNull()
    expect(loopStallLine(LOOP_STALL_WARN_MS - 1, 900, 60_000)).toBeNull()
  })
  it("names how long the main thread was blocked", () => {
    expect(loopStallLine(7_800, 2_400, 60_000)).toBe(
      "[loop] main thread blocked for up to 7.8s in the last 60s (p99 2.4s); HTTP, polls and timers waited",
    )
  })
  it("logs a real stall and stops cleanly", async () => {
    const lines: string[] = []
    const watch = startLoopWatch((l) => lines.push(l), { intervalMs: 600, warnMs: 100 })
    // Block on a later turn: the watch only samples once the loop is running.
    setTimeout(() => { const until = Date.now() + 250; while (Date.now() < until) { /* block the main thread */ } }, 50)
    await new Promise((r) => setTimeout(r, 800))
    watch.stop()
    expect(lines.some((l) => l.startsWith("[loop] main thread blocked"))).toBe(true)
  })
})
