import { describe, it, expect, vi, afterEach } from "vitest"
import { BlockStream } from "../src/channels/block-stream"

// With humanPacing on (WhatsApp), a paced block used to be sent from a
// detached setTimeout and joined the emission chain only when the timer
// fired, so flush() could return before it was sent and blocks could land
// out of order. The delay now runs inside the chain.

describe("BlockStream human pacing", () => {
  afterEach(() => { vi.useRealTimers() })

  it("flush() waits for paced blocks and keeps their order", async () => {
    vi.useFakeTimers()
    const out: string[] = []
    const bs = new BlockStream(async (b) => { out.push(b) }, {
      minChars: 5, maxChars: 3000, minIntervalMs: 0, idleFlushMs: 10_000, humanPacing: true,
    })
    bs.push("First block here.\n\n")
    bs.push("Second block here.\n\n")
    bs.push("tail")
    const done = bs.flush()
    let settled = false
    void done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(out.join("")).toBe("First block here.\n\nSecond block here.\n\ntail")
    expect(out[0]).toBe("First block here.\n\n")
  })
})
