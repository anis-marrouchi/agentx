import { describe, it, expect, vi, afterEach } from "vitest"
import { ClaudeProvider } from "../../src/agent/providers/claude"

// Regression test for a real bug, not a hypothetical one.
//
// ClaudeProvider built every fetch without a `signal`, so `abortSignal` was
// accepted and silently discarded. Callers that armed an AbortController and
// a setTimeout — src/graph/classifier.ts (nominally 30s, on the per-task
// blocking path) and src/agents/context-planner.ts (nominally 8s, per
// message) — had no timeout at all. A decision call that cannot be cancelled
// has no place on a critical path, so this is a prerequisite for wiring any
// seat into one.

const origFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = origFetch
})

/** A fetch that never resolves on its own and only settles when aborted —
 *  i.e. one that behaves like the real thing with respect to `signal`. */
function hangingFetch(): { seenSignals: Array<AbortSignal | undefined> } {
  const seenSignals: Array<AbortSignal | undefined> = []
  globalThis.fetch = vi.fn((_url: any, init: any) => {
    seenSignals.push(init?.signal)
    return new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal
      if (!signal) return // no signal: hangs forever, exactly the old bug
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      )
    })
  }) as any
  return { seenSignals }
}

describe("ClaudeProvider honours abortSignal", () => {
  it("passes the signal to fetch on generate()", async () => {
    const { seenSignals } = hangingFetch()
    const provider = new ClaudeProvider("sk-test-fake")
    const controller = new AbortController()

    const pending = provider.generate([{ role: "user", content: "hi" }], {
      abortSignal: controller.signal,
    })
    const assertion = expect(pending).rejects.toThrow(/Abort/i)
    controller.abort()
    await assertion

    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
  })

  it("passes the signal to fetch on generateRaw()", async () => {
    const { seenSignals } = hangingFetch()
    const provider = new ClaudeProvider("sk-test-fake")
    const controller = new AbortController()

    const pending = provider.generateRaw(
      [{ role: "user", content: "hi" }],
      "system",
      [],
      { abortSignal: controller.signal },
    )
    const assertion = expect(pending).rejects.toThrow(/Abort/i)
    controller.abort()
    await assertion

    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
  })

  it("a caller's timeout now actually bounds the call", async () => {
    hangingFetch()
    const provider = new ClaudeProvider("sk-test-fake")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 40)

    const started = Date.now()
    await expect(
      provider.generate([{ role: "user", content: "hi" }], { abortSignal: controller.signal }),
    ).rejects.toThrow(/Abort/i)
    clearTimeout(timer)

    expect(Date.now() - started).toBeLessThan(2_000)
  })

})
