// Operations polls one call at a time (#2101 R8). /api/mesh can take over
// 10 s; a fixed 5 s timer stacked calls until, framed in the Hub, none came
// back and the cards stayed on "-".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MESH_SHARED_SCRIPT } from "../src/daemon/ui/pages/mesh-shared.client"
import { MESH_OPS_SCRIPT } from "../src/daemon/ui/pages/mesh-ops.client"
import { MESH_FEED_SCRIPT } from "../src/daemon/ui/pages/mesh-feed.client"

function loadMX(): any {
  const win: any = {}
  const body = MESH_SHARED_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")
  new Function("window", "document", body)(win, { getElementById: () => null, addEventListener() {} })
  return win.MX
}

describe("MX.poll (#2101 R8)", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("never runs two calls at once, and waits 5 s after each answer", async () => {
    const MX = loadMX()
    let open = 0, most = 0, calls = 0
    const answers: Array<() => void> = []
    MX.poll(() => { calls++; open++; most = Math.max(most, open); return new Promise<void>((r) => answers.push(() => { open--; r() })) }, 5000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000) // a slow answer: no second call meanwhile
    expect(calls).toBe(1)
    answers.shift()!()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    expect(most).toBe(1)
  })

  it("keeps polling after a failed call", async () => {
    const MX = loadMX()
    let calls = 0
    MX.poll(() => { calls++; return Promise.reject(new Error("HTTP 502")) }, 5000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(3)
  })

  it("is what Operations and the Mesh feed use, not a fixed timer", () => {
    for (const s of [MESH_OPS_SCRIPT, MESH_FEED_SCRIPT]) {
      expect(s).toContain("MX.poll(load,5000);")
      expect(s).not.toContain("setInterval(load")
    }
  })
})
