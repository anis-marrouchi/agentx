import { describe, it, expect } from "vitest"
import { createSimpleJevBackend } from "../../src/decisions/backends/simple-jev"
import { noul } from "../../src/decisions/questions"

// A seat call was seen in production that neither answered nor failed for
// five minutes: its fetch ignored the abort signal the deadline fired
// (#340). The backend now races the signal itself, so the deadline holds
// whatever the request does.

describe("simple-jev deadline", () => {
  it("fails at the deadline even when the request ignores its signal", async () => {
    const backend = createSimpleJevBackend({
      name: "stuck", baseUrl: "http://x", path: "/y", model: "m",
      fetchImpl: (() => new Promise(() => {})) as any,
    })
    const started = Date.now()
    await expect(backend.decide({ state: { a: 1 }, questions: { q: noul("yes?") }, timeoutMs: 200 }))
      .rejects.toThrow(/timed out after 200ms/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
  it("fails at the deadline when the body never arrives", async () => {
    const backend = createSimpleJevBackend({
      name: "stuck", baseUrl: "http://x", path: "/y", model: "m",
      fetchImpl: (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: async () => "" })) as any,
    })
    await expect(backend.decide({ state: { a: 1 }, questions: { q: noul("yes?") }, timeoutMs: 200 }))
      .rejects.toThrow(/timed out after 200ms/)
  })
})
