import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchPolicy, type PolicyDecision } from "../src/intent/decide"
import type { IntentEvent, IntentEventInput } from "../src/intent/types"

// Tests for Phase 1 commit 3 — decideAndCommit invariants. Each describe
// block names the invariant from src/intent/decide.ts so Phase 2's TLA+
// pass can match assertions to spec lemmas one-to-one.

let tmp: string
let ledger: IntentLedger
let clock: { t: number }

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-decide-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
  clock = { t: 1714400000000 }
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
})

const tick = () => ++clock.t

function eventInput(overrides: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: clock.t,
    source: "gitlab",
    sourceEventId: "gl-evt-1",
    project: "mtgl/mtgl-system-v2",
    subject: "issue:709",
    intent: "issue.opened",
    rawJson: JSON.stringify({ kind: "issue", id: 709 }),
    ...overrides,
  }
}

/** Always-dispatch policy — useful when the test only cares about outcome,
 *  not the decision logic. */
function dispatchPolicy(decidedBy: string, agentId: string): DispatchPolicy {
  return {
    decidedBy,
    decide: (): PolicyDecision => ({ agentId, outcome: "dispatched", reason: null }),
  }
}

/** No-opinion policy — every decide() call returns null. */
const nullPolicy: DispatchPolicy = {
  decidedBy: "test:null",
  decide: () => null,
}

describe("decideAndCommit — Inv-Idempotence", () => {
  it("re-delivery of the same (source, sourceEventId) returns the same decision row", () => {
    const policy = dispatchPolicy("channel-router", "mtgl-v2")
    const first = decideAndCommit(ledger, eventInput(), policy, tick)
    const second = decideAndCommit(ledger, eventInput({ ts: clock.t }), policy, tick)

    expect(second.eventId).toBe(first.eventId)
    expect(second.decidedAt).toBe(first.decidedAt) // unchanged — cached, not re-decided
    expect(second.outcome).toBe("dispatched")
    expect(second.agentId).toBe("mtgl-v2")

    const events = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    const decisions = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }
    expect(events.n).toBe(1)
    expect(decisions.n).toBe(1)
  })

  it("the same event reaching two different policies yields two decisions (chain, not duplicate)", () => {
    const a = dispatchPolicy("channel-router", "mtgl-v2")
    const b = dispatchPolicy("pm:pm-mtgl", "mtgl-v2")
    const dA = decideAndCommit(ledger, eventInput(), a, tick)
    const dB = decideAndCommit(ledger, eventInput({ ts: clock.t }), b, tick)

    expect(dA.eventId).toBe(dB.eventId) // same event
    expect(dA.decidedBy).toBe("channel-router")
    expect(dB.decidedBy).toBe("pm:pm-mtgl")

    const chain = ledger.getDecisionsForEvent(dA.eventId)
    expect(chain.map((d) => d.decidedBy)).toEqual(["channel-router", "pm:pm-mtgl"])
  })
})

describe("decideAndCommit — Inv-Determinism", () => {
  it("same input + same ledger snapshot + same clock produces identical decisions", () => {
    // Two ledgers, identical fresh state, identical inputs. Must produce
    // structurally identical decisions (modulo the eventId, which is a
    // ULID with embedded randomness — we pin a deterministic id to
    // factor it out).
    const dirB = mkdtempSync(path.join(tmpdir(), "agentx-decide-b-"))
    const ledgerB = new IntentLedger({ path: path.join(dirB, "ledger.sqlite") })
    try {
      const policy = dispatchPolicy("channel-router", "mtgl-v2")
      const fixedId = "01HQQQQQQQQQQQQQQQQQQQQQQQ"
      const dA = decideAndCommit(ledger, eventInput({ id: fixedId }), policy, () => 999)
      const dB = decideAndCommit(ledgerB, eventInput({ id: fixedId }), policy, () => 999)
      expect(dA).toEqual(dB)
    } finally {
      ledgerB.close()
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it("policy is called with the recorded event, not the raw input", () => {
    let observed: IntentEvent | null = null
    const policy: DispatchPolicy = {
      decidedBy: "test:observe",
      decide: (event) => {
        observed = event
        return { agentId: "x", outcome: "dispatched", reason: null }
      },
    }
    decideAndCommit(ledger, eventInput({ id: "01HQQQQQQQQQQQQQQQQQQQQQQQ" }), policy, tick)
    expect(observed).not.toBeNull()
    // The policy sees the canonical post-record shape (id assigned, types
    // narrowed) so its determinism only depends on documented fields.
    expect(observed!.id).toBe("01HQQQQQQQQQQQQQQQQQQQQQQQ")
    expect(observed!.subject).toBe("issue:709")
  })
})

describe("decideAndCommit — Inv-ActiveTaskSafety", () => {
  it("a second event for the same (project, subject) is deduped while the first is in-flight", () => {
    const router = dispatchPolicy("channel-router", "mtgl-v2")
    const first = decideAndCommit(ledger, eventInput({ sourceEventId: "evt-1" }), router, tick)
    expect(first.outcome).toBe("dispatched")

    const second = decideAndCommit(
      ledger,
      eventInput({ sourceEventId: "evt-2", ts: clock.t }),
      router,
      tick,
    )
    expect(second.outcome).toBe("deduped")
    expect(second.agentId).toBeNull()
    expect(second.reason).toMatch(/active dispatch in flight/)
  })

  it("once the first decision is resolved, the next event for the same subject can dispatch again", () => {
    const router = dispatchPolicy("channel-router", "mtgl-v2")
    const first = decideAndCommit(ledger, eventInput({ sourceEventId: "evt-1" }), router, tick)
    ledger.recordResolution({
      decisionEventId: first.eventId,
      decisionDecidedBy: first.decidedBy,
      resolvedAt: tick(),
      status: "completed",
      durationMs: 50,
      resultSummary: "ok",
    })
    const second = decideAndCommit(
      ledger,
      eventInput({ sourceEventId: "evt-2", ts: clock.t }),
      router,
      tick,
    )
    expect(second.outcome).toBe("dispatched")
    expect(second.eventId).not.toBe(first.eventId)
  })

  it("active-task scope is per (project, subject) — different projects don't block each other", () => {
    const router = dispatchPolicy("channel-router", "mtgl-v2")
    const a = decideAndCommit(
      ledger,
      eventInput({ sourceEventId: "evt-a", project: "proj-a" }),
      router,
      tick,
    )
    const b = decideAndCommit(
      ledger,
      eventInput({ sourceEventId: "evt-b", project: "proj-b", ts: clock.t }),
      router,
      tick,
    )
    expect(a.outcome).toBe("dispatched")
    expect(b.outcome).toBe("dispatched")
  })

  it("randomized: across many interleaved events, getActiveDecisionForSubject never returns >1", () => {
    // Hand-rolled property check — generate N events across S slots with
    // a deterministic seed, drive each through decideAndCommit, after
    // every step assert ≤1 active decision per slot. The invariant must
    // hold at every observable point in the ledger's life.
    const seed = 1234567
    let s = seed
    const rand = () => {
      // mulberry32 — small, fast, seedable, deterministic.
      s = (s + 0x6d2b79f5) | 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    const slots: Array<{ project: string; subject: string }> = [
      { project: "p-1", subject: "issue:1" },
      { project: "p-1", subject: "issue:2" },
      { project: "p-2", subject: "issue:1" },
    ]
    const router = dispatchPolicy("channel-router", "agent-x")

    const N = 200
    for (let i = 0; i < N; i++) {
      const slot = slots[Math.floor(rand() * slots.length)]
      decideAndCommit(
        ledger,
        eventInput({
          sourceEventId: `rand-${i}`,
          project: slot.project,
          subject: slot.subject,
          ts: clock.t,
        }),
        router,
        tick,
      )
      // Assert per-slot active count ≤1 after every iteration.
      for (const s of slots) {
        const active = ledger.db
          .prepare(
            `SELECT COUNT(*) as n FROM intent_decisions d
             JOIN intent_events e ON e.id = d.event_id
             LEFT JOIN intent_resolutions r
               ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
             WHERE e.project = ? AND e.subject = ?
               AND d.outcome = 'dispatched'
               AND r.decision_event_id IS NULL`,
          )
          .get(s.project, s.subject) as { n: number }
        expect(active.n).toBeLessThanOrEqual(1)
      }

      // Periodically resolve a random in-flight decision so the test
      // exercises the dispatch → resolve → dispatch lifecycle, not just
      // the always-deduped degenerate case.
      if (i % 7 === 0) {
        const inflight = ledger.db
          .prepare(
            `SELECT d.event_id, d.decided_by FROM intent_decisions d
             LEFT JOIN intent_resolutions r
               ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
             WHERE d.outcome = 'dispatched' AND r.decision_event_id IS NULL
             LIMIT 1`,
          )
          .get() as { event_id: string; decided_by: string } | undefined
        if (inflight) {
          ledger.recordResolution({
            decisionEventId: inflight.event_id,
            decisionDecidedBy: inflight.decided_by,
            resolvedAt: tick(),
            status: "completed",
            durationMs: 1,
            resultSummary: null,
          })
        }
      }
    }

    // Final invariant check: at the end too.
    for (const s of slots) {
      const active = ledger.getActiveDecisionForSubject(s.project, s.subject)
      // null or a single decision — never more.
      if (active) expect(active.outcome).toBe("dispatched")
    }
  })
})

describe("decideAndCommit — Inv-NoSilentDrops", () => {
  it("a null policy result is recorded as halted with reason='no policy match'", () => {
    const decision = decideAndCommit(ledger, eventInput(), nullPolicy, tick)
    expect(decision.outcome).toBe("halted")
    expect(decision.reason).toBe("no policy match")
    expect(decision.agentId).toBeNull()
  })

  it("a halted policy result is recorded verbatim — reason flows through", () => {
    const reasoned: DispatchPolicy = {
      decidedBy: "test:reasoned",
      decide: () => ({ agentId: null, outcome: "halted", reason: "out of business hours" }),
    }
    const decision = decideAndCommit(ledger, eventInput(), reasoned, tick)
    expect(decision.outcome).toBe("halted")
    expect(decision.reason).toBe("out of business hours")
  })

  it("a queued policy result is recorded verbatim", () => {
    const queueing: DispatchPolicy = {
      decidedBy: "test:queueing",
      decide: () => ({ agentId: "agent-q", outcome: "queued", reason: "rate limited" }),
    }
    const decision = decideAndCommit(ledger, eventInput(), queueing, tick)
    expect(decision.outcome).toBe("queued")
    expect(decision.agentId).toBe("agent-q")
  })

  it("every call writes exactly one decision row — no path returns without a row", () => {
    const policies: DispatchPolicy[] = [
      dispatchPolicy("p:dispatch", "agent-1"),
      { decidedBy: "p:halt", decide: () => ({ agentId: null, outcome: "halted", reason: "nope" }) },
      { decidedBy: "p:queue", decide: () => ({ agentId: "a", outcome: "queued", reason: "later" }) },
      nullPolicy,
    ]
    let calls = 0
    for (let i = 0; i < policies.length; i++) {
      decideAndCommit(
        ledger,
        eventInput({ sourceEventId: `evt-${i}`, subject: `issue:${i}`, ts: clock.t }),
        policies[i],
        tick,
      )
      calls++
    }
    const rows = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }
    expect(rows.n).toBe(calls)
  })
})
