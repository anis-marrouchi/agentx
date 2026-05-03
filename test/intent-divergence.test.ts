import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchPolicy } from "../src/intent/decide"
import { decisionsAgree, reportDivergence, type LegacyOutcome } from "../src/intent/divergence"
import type { IntentEventInput } from "../src/intent/types"

// Tests for Phase 1 commit 5 — divergence reporter.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-divergence-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
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

function dispatchAndDecide() {
  return decideAndCommit(ledger, eventInput(), dispatchPolicy, () => 1714400000001)
}

describe("decisionsAgree", () => {
  it("agrees on identical outcome + agentId", () => {
    const decision = dispatchAndDecide()
    expect(
      decisionsAgree(decision, { outcome: "dispatched", agentId: "mtgl-v2" }),
    ).toBe(true)
  })

  it("disagrees when outcome differs", () => {
    const decision = dispatchAndDecide()
    expect(
      decisionsAgree(decision, { outcome: "halted", agentId: null }),
    ).toBe(false)
  })

  it("disagrees when agentId differs", () => {
    const decision = dispatchAndDecide()
    expect(
      decisionsAgree(decision, { outcome: "dispatched", agentId: "different-agent" }),
    ).toBe(false)
  })

  it("ignores reason — free-form text doesn't decide agreement", () => {
    const decision = dispatchAndDecide()
    expect(
      decisionsAgree(decision, {
        outcome: "dispatched",
        agentId: "mtgl-v2",
        reason: "totally different rationale",
      }),
    ).toBe(true)
  })

  it("treats both nulls as agreement (halted/null vs halted/null)", () => {
    const haltPolicy: DispatchPolicy = {
      decidedBy: "test:halt",
      decide: () => ({ agentId: null, outcome: "halted", reason: null }),
    }
    const decision = decideAndCommit(
      ledger,
      eventInput({ sourceEventId: "halt-evt" }),
      haltPolicy,
      () => 1,
    )
    expect(decisionsAgree(decision, { outcome: "halted", agentId: null })).toBe(true)
  })
})

describe("reportDivergence", () => {
  it("on agreement: returns false, writes nothing, logs nothing", () => {
    const decision = dispatchAndDecide()
    const before = ledger.getDivergences().length
    const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const reported = reportDivergence(
      ledger,
      "gitlab",
      decision,
      { outcome: "dispatched", agentId: "mtgl-v2" },
    )

    expect(reported).toBe(false)
    expect(ledger.getDivergences().length).toBe(before)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("on mismatch: returns true, appends a row, emits a structured warning", () => {
    const decision = dispatchAndDecide()
    const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const reported = reportDivergence(
      ledger,
      "gitlab",
      decision,
      { outcome: "halted", agentId: null, reason: "legacy denied" },
      () => 9999,
    )

    expect(reported).toBe(true)
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]).toMatchObject({
      ts: 9999,
      source: "gitlab",
      eventId: decision.eventId,
      decidedBy: "channel-router",
      ledgerAgentId: "mtgl-v2",
      ledgerOutcome: "dispatched",
      legacyAgentId: null,
      legacyOutcome: "halted",
      legacyReason: "legacy denied",
    })
    expect(warnSpy).toHaveBeenCalledOnce()
    const logged = warnSpy.mock.calls[0].join(" ")
    expect(logged).toContain("[ledger-divergence]")
    expect(logged).toContain("source=gitlab")
    expect(logged).toContain(`event=${decision.eventId}`)
    expect(logged).toContain("ledger=dispatched/mtgl-v2")
    expect(logged).toContain("legacy=halted/null")
  })

  it("captures null legacy reason when not provided — record never has undefined columns", () => {
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})

    reportDivergence(
      ledger,
      "gitlab",
      decision,
      { outcome: "halted", agentId: null }, // reason omitted
      () => 1000,
    )
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0].legacyReason).toBeNull()
  })

  it("multiple divergences accumulate in newest-first order", () => {
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})

    reportDivergence(ledger, "gitlab", decision, { outcome: "halted", agentId: null }, () => 100)
    // Same decision can only diverge once if the outcome is the same. To
    // get two divergences against the same decision we vary the legacy
    // side — perfectly valid since the divergence record is keyed by its
    // own ULID, not by decision id.
    reportDivergence(ledger, "gitlab", decision, { outcome: "queued", agentId: "x" }, () => 200)

    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(2)
    expect(divergences[0].ts).toBe(200) // newest first
    expect(divergences[1].ts).toBe(100)
  })

  it("getDivergences filters by source", () => {
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})

    reportDivergence(ledger, "gitlab", decision, { outcome: "halted", agentId: null }, () => 100)
    reportDivergence(ledger, "telegram", decision, { outcome: "queued", agentId: "x" }, () => 200)

    expect(ledger.getDivergences({ source: "gitlab" })).toHaveLength(1)
    expect(ledger.getDivergences({ source: "telegram" })).toHaveLength(1)
    expect(ledger.getDivergences({ source: "workflow" })).toHaveLength(0)
  })

  it("getDivergences filters by since", () => {
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})

    reportDivergence(ledger, "gitlab", decision, { outcome: "halted", agentId: null }, () => 100)
    reportDivergence(ledger, "gitlab", decision, { outcome: "queued", agentId: "x" }, () => 500)
    reportDivergence(ledger, "gitlab", decision, { outcome: "deduped", agentId: null }, () => 900)

    const recent = ledger.getDivergences({ since: 400 })
    expect(recent).toHaveLength(2)
    expect(recent.map((d) => d.ts)).toEqual([900, 500])
  })

  it("getDivergences applies limit after sorting", () => {
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})

    for (const ts of [100, 200, 300, 400]) {
      reportDivergence(ledger, "gitlab", decision, { outcome: "halted", agentId: null }, () => ts)
    }
    const top2 = ledger.getDivergences({ limit: 2 })
    expect(top2.map((d) => d.ts)).toEqual([400, 300])
  })

  it("agreement is the soak's success signal — quiet operation = zero rows", () => {
    // The promotion gate is "≥7 days, zero divergences". This test models
    // that gate by repeatedly reporting agreement and asserting the table
    // stays empty.
    const decision = dispatchAndDecide()
    vi.spyOn(console, "log").mockImplementation(() => {})
    for (let i = 0; i < 20; i++) {
      reportDivergence(ledger, "gitlab", decision, { outcome: "dispatched", agentId: "mtgl-v2" })
    }
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("FK enforcement: divergence cannot exist without its ledger-side decision", () => {
    // Hand-craft a decision-shaped object that does NOT correspond to any
    // ledger row, then try to report a divergence on it.
    vi.spyOn(console, "log").mockImplementation(() => {})
    expect(() =>
      reportDivergence(
        ledger,
        "gitlab",
        {
          eventId: "no-such-event",
          decidedAt: 1,
          decidedBy: "phantom-decider",
          agentId: null,
          outcome: "halted",
          reason: null,
        },
        { outcome: "dispatched", agentId: "x" },
        () => 1,
      ),
    ).toThrow(/FOREIGN KEY/)
  })
})
