import { describe, it, expect } from "vitest"
import { friendlyModelError, renderFriendlyError } from "../src/agents/error-map"

describe("friendlyModelError", () => {
  it("detects out-of-credits with the exact CLI format", () => {
    const raw = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011Ca9URBqUgBLHZHw8dCdRU"}`
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("out_of_credits")
    expect(f.retryable).toBe(false)
    expect(f.message).toContain("out of Anthropic credits")
    expect(f.fix).toMatch(/billing|claude\.ai\/settings\/usage/)
  })

  it("classifies invalid api key", () => {
    const raw = `API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("auth")
    expect(f.retryable).toBe(false)
    expect(f.fix).toContain("ANTHROPIC_API_KEY")
  })

  it("flags overloaded_error as retryable", () => {
    const raw = `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("overloaded")
    expect(f.retryable).toBe(true)
  })

  it("flags 429 rate_limit_error as retryable", () => {
    const raw = `API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}`
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("rate_limit")
    expect(f.retryable).toBe(true)
  })

  it("classifies context-too-large", () => {
    const raw = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000"}}`
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("context_too_large")
    expect(f.fix).toMatch(/clear session|bigger context/i)
  })

  it("passes through our own timeout text", () => {
    const raw = "Claude Code timed out after 20m (SIGTERM). Bump agent.maxExecutionMinutes for \"devops\" if tasks need longer."
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("timeout")
    expect(f.retryable).toBe(true)
  })

  it("classifies 'Not logged in · Please run /login' as retryable auth", () => {
    const raw = "Not logged in · Please run /login"
    const f = friendlyModelError(raw)
    expect(f.kind).toBe("auth")
    expect(f.retryable).toBe(true)
    expect(f.message).toMatch(/logged out/i)
    expect(f.fix).toMatch(/\/login/)
  })

  it("falls back to 'unknown' for unstructured text", () => {
    const f = friendlyModelError("Random wall of noise that isn't an API error at all.")
    expect(f.kind).toBe("unknown")
    expect(f.retryable).toBe(false)
  })

  it("renders a single actionable line", () => {
    const raw = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage"}}`
    const rendered = renderFriendlyError(friendlyModelError(raw))
    expect(rendered).toMatch(/out of Anthropic credits/i)
    expect(rendered).toMatch(/—/)
    expect(rendered.length).toBeLessThan(300)
  })
})
