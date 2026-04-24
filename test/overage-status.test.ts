import { describe, it, expect } from "vitest"
import { parseOverageStatus, preflightOverageGate, clearOverageStatusCache } from "../src/agents/overage-status"

describe("parseOverageStatus", () => {
  it("returns available=true (unknown) when the file is missing", () => {
    const s = parseOverageStatus(null, 1_000)
    expect(s.available).toBe(true)
    expect(s.unknown).toBe(true)
  })

  it("returns available=true when the file has no disabled markers", () => {
    const s = parseOverageStatus({}, 1_000)
    expect(s.available).toBe(true)
    expect(s.reason).toBeUndefined()
  })

  it("BLOCKS only when reason is 'org_level_disabled_until'", () => {
    const s = parseOverageStatus({ cachedExtraUsageDisabledReason: "org_level_disabled_until" }, 1_000)
    expect(s.available).toBe(false)
    expect(s.reason).toBe("org_level_disabled_until")
  })

  it("does NOT block on transient 'out_of_credits' reason", () => {
    const s = parseOverageStatus({ cachedExtraUsageDisabledReason: "out_of_credits" }, 1_000)
    expect(s.available).toBe(true)
    expect(s.reason).toBe("out_of_credits")
  })

  it("does NOT block when only the grant cache says available=false (dropped signal)", () => {
    const s = parseOverageStatus({
      overageCreditGrantCache: {
        "org-id": { info: { available: false, eligible: false, granted: false } },
      },
    } as Record<string, unknown>, 1_000)
    expect(s.available).toBe(true)
  })

  it("does NOT block on any unknown disabled reason string", () => {
    const s = parseOverageStatus({ cachedExtraUsageDisabledReason: "something_new_from_anthropic" }, 1_000)
    expect(s.available).toBe(true)
  })
})

describe("preflightOverageGate", () => {
  // Note: the live gate reads ~/.claude.json via getOverageStatus. These two
  // cases drive it through the in-memory cache — we seed cache via a fresh
  // read, then call the gate. We can't easily fake ~/.claude.json without
  // mocking os.homedir (which is non-configurable), so instead we test the
  // pure decision logic at parseOverageStatus above and only smoke-test the
  // warm-session short-circuit here, which doesn't depend on file state.

  it("returns null for warm sessions regardless of overage state", () => {
    clearOverageStatusCache()
    // warm session always passes through; no file dependency
    expect(preflightOverageGate(true)).toBeNull()
  })
})
