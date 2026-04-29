import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { shadowAlongside } from "../src/intent/integration"
import { resetLedgerForTesting, setLedgerForTesting } from "../src/intent/instance"
import type { DispatchPolicy } from "../src/intent/decide"
import type { LegacyOutcome } from "../src/intent/divergence"
import type { IntentEventInput } from "../src/intent/types"

// Tests for Phase 1 commit 6.0 — shadowAlongside helper.
//
// We pass `env` and `ledger` overrides through `opts` so no global state
// leaks between cases.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-integration-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  resetLedgerForTesting()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const dispatchPolicy: DispatchPolicy = {
  decidedBy: "channel-router",
  decide: () => ({ agentId: "mtgl-v2", outcome: "dispatched", reason: null }),
}

function eventInput(overrides: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: 1714400000000,
    source: "gitlab",
    sourceEventId: "gl-evt-1",
    project: "mtgl/mtgl-system-v2",
    subject: "issue:709",
    intent: "issue.opened",
    rawJson: "{}",
    ...overrides,
  }
}

describe("shadowAlongside — mode 'off'", () => {
  it("calls legacy and returns its result; ledger is never opened", async () => {
    let legacyCalled = 0
    const result = await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,
      async () => {
        legacyCalled++
        return "legacy-result"
      },
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
      { env: {}, ledger }, // empty env → mode=off
    )
    expect(result).toBe("legacy-result")
    expect(legacyCalled).toBe(1)
    // Ledger received no writes.
    const events = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    expect(events.n).toBe(0)
  })

  it("does not require a singleton when mode is off — production-default safe path", async () => {
    // No setLedgerForTesting(); no opts.ledger. The helper should never
    // touch getDefaultLedger() because mode=off short-circuits before any
    // ledger access.
    const result = await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,
      async () => "legacy",
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
      { env: {} },
    )
    expect(result).toBe("legacy")
  })
})

describe("shadowAlongside — mode 'shadow'", () => {
  const shadowEnv = { INTENT_LEDGER_MODE: "shadow" }

  it("records the ledger decision, runs legacy, returns legacy's result", async () => {
    const result = await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,
      async () => "legacy-result",
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
      { env: shadowEnv, ledger, now: () => 9999 },
    )
    expect(result).toBe("legacy-result")

    const events = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    expect(events.n).toBe(1)
    const decisions = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }
    expect(decisions.n).toBe(1)
  })

  it("records a divergence row when ledger and legacy disagree", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,                              // ledger says: dispatch to mtgl-v2
      async () => "legacy",
      () => ({ agentId: null, outcome: "halted" }), // legacy says: halt
      { env: shadowEnv, ledger, now: () => 9999 },
    )
    expect(ledger.getDivergences()).toHaveLength(1)
  })

  it("records no divergence row when ledger and legacy agree", async () => {
    await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,                                       // ledger: dispatch to mtgl-v2
      async () => "legacy",
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }), // legacy: dispatch to mtgl-v2
      { env: shadowEnv, ledger },
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("uses the singleton when no ledger override is supplied", async () => {
    const injected = new IntentLedger({ path: path.join(tmp, "injected.sqlite") })
    setLedgerForTesting(injected)
    try {
      await shadowAlongside(
        "gitlab",
        eventInput(),
        dispatchPolicy,
        async () => "ok",
        () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
        { env: shadowEnv },
      )
      // The injected singleton received the write, not our test-local ledger.
      const events = injected.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
      expect(events.n).toBe(1)
      const localEvents = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
      expect(localEvents.n).toBe(0)
    } finally {
      injected.close()
    }
  })
})

describe("shadowAlongside — mode 'authoritative' (deferred-to-1c semantics)", () => {
  it("currently behaves the same as 'shadow' — legacy still wins, divergence still recorded", async () => {
    // The real "act on ledger decision" is per-source and lands in
    // commits 9-13. Until then, flipping a source to authoritative is a
    // safe no-op behaviour-wise.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const result = await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,                             // ledger: dispatch to mtgl-v2
      async () => "legacy-still-wins",
      () => ({ agentId: null, outcome: "halted" }), // legacy: halt
      { env: { INTENT_LEDGER_MODE: "authoritative" }, ledger },
    )
    expect(result).toBe("legacy-still-wins")
    expect(ledger.getDivergences()).toHaveLength(1)
  })
})

describe("shadowAlongside — per-source mode override", () => {
  it("respects per-source mode env vars (the 1c rollout primitive)", async () => {
    // Global=off, gitlab=shadow → only gitlab records.
    const env = {
      INTENT_LEDGER_MODE: "off",
      INTENT_LEDGER_MODE_GITLAB: "shadow",
    }
    await shadowAlongside(
      "gitlab",
      eventInput(),
      dispatchPolicy,
      async () => "ok",
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
      { env, ledger },
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)

    // Same call but with source=telegram (no per-source override) → mode is
    // global=off → no ledger writes.
    await shadowAlongside(
      "telegram",
      eventInput({ sourceEventId: "tg-evt-1", source: "telegram" }),
      dispatchPolicy,
      async () => "ok",
      () => ({ agentId: "mtgl-v2", outcome: "dispatched" }),
      { env, ledger },
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1) // unchanged — telegram remained off
  })
})
