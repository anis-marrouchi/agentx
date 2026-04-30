import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchPolicy } from "../src/intent/decide"
import { replay } from "../src/intent/replay"
import type { IntentDecision, IntentEvent, IntentEventInput, IntentResolution } from "../src/intent/types"

// Tests for Phase 7 commit 1 — ledger replay.
//
// Each test populates a SOURCE ledger with realistic event + decision
// traces, then dumps the rows to plain arrays and replays onto a fresh
// TARGET ledger. The replay's equivalence report is asserted against
// the recorded decisions.

let tmp: string
let source: IntentLedger
let target: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-replay-"))
  source = new IntentLedger({ path: path.join(tmp, "source.sqlite") })
  target = new IntentLedger({ path: path.join(tmp, "target.sqlite") })
})

afterEach(() => {
  source.close()
  target.close()
  rmSync(tmp, { recursive: true, force: true })
})

function dumpEvents(ledger: IntentLedger): IntentEvent[] {
  return (ledger.db
    .prepare(`SELECT id, ts, source, source_event_id, project, subject, intent, raw_json FROM intent_events`)
    .all() as Array<any>)
    .map((r) => ({
      id: r.id, ts: r.ts, source: r.source,
      sourceEventId: r.source_event_id, project: r.project, subject: r.subject,
      intent: r.intent, rawJson: r.raw_json,
    }))
}

function dumpDecisions(ledger: IntentLedger): IntentDecision[] {
  return (ledger.db
    .prepare(`SELECT event_id, decided_at, decided_by, agent_id, outcome, reason FROM intent_decisions`)
    .all() as Array<any>)
    .map((r) => ({
      eventId: r.event_id, decidedAt: r.decided_at, decidedBy: r.decided_by,
      agentId: r.agent_id, outcome: r.outcome, reason: r.reason,
    }))
}

function dumpResolutions(ledger: IntentLedger): IntentResolution[] {
  return (ledger.db
    .prepare(`SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary FROM intent_resolutions`)
    .all() as Array<any>)
    .map((r) => ({
      decisionEventId: r.decision_event_id, decisionDecidedBy: r.decision_decided_by,
      resolvedAt: r.resolved_at, status: r.status,
      durationMs: r.duration_ms, resultSummary: r.result_summary,
    }))
}

const dispatchPolicy = (decidedBy: string, agentId: string): DispatchPolicy => ({
  decidedBy,
  decide: () => ({ agentId, outcome: "dispatched", reason: null }),
})

const haltPolicy = (decidedBy: string, reason: string): DispatchPolicy => ({
  decidedBy,
  decide: () => ({ agentId: null, outcome: "halted", reason }),
})

function event(overrides: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: 1714400000000,
    source: "gitlab",
    sourceEventId: "evt-1",
    project: "p1",
    subject: "s1",
    intent: "test",
    rawJson: "{}",
    ...overrides,
  }
}

describe("replay — basic equivalence", () => {
  it("single dispatched decision: replay produces identical row, no divergence", () => {
    const policy = dispatchPolicy("router", "agent-x")
    decideAndCommit(source, event(), policy, () => 1714400000001)

    const result = replay(target, dumpEvents(source), dumpDecisions(source))

    expect(result.eventsCount).toBe(1)
    expect(result.decisionsCount).toBe(1)
    expect(result.divergences).toEqual([])
  })

  it("chain of decisions on the same event from different deciders: each replays identically", () => {
    const e = event()
    decideAndCommit(source, e, dispatchPolicy("router", "agent-x"), () => 100)
    // PM gate on the same event — different decidedBy, different decision
    decideAndCommit(source, e, haltPolicy("pm:pm-mtgl", "out of business hours"), () => 101)

    const result = replay(target, dumpEvents(source), dumpDecisions(source))

    expect(result.divergences).toEqual([])
    expect(result.decisionsCount).toBe(2)
  })

  it("active-task safety: dispatched-then-deduped chain replays identically", () => {
    // First: dispatch.
    decideAndCommit(
      source,
      event({ sourceEventId: "evt-1" }),
      dispatchPolicy("router", "agent-x"),
      () => 100,
    )
    // Second event on same (project, subject) → ledger forces deduped.
    const second = decideAndCommit(
      source,
      event({ sourceEventId: "evt-2" }),
      dispatchPolicy("router", "agent-x"),
      () => 200,
    )
    expect(second.outcome).toBe("deduped")

    const result = replay(target, dumpEvents(source), dumpDecisions(source))
    expect(result.divergences).toEqual([])
  })

  it("multi-source mixed traffic: telegram + gitlab + workflow events replay identically", () => {
    decideAndCommit(source, event({ source: "telegram", sourceEventId: "tg-1", project: null, subject: "chat:1" }),
      dispatchPolicy("channel-router", "atlas"), () => 100)
    decideAndCommit(source, event({ source: "gitlab", sourceEventId: "gl-1" }),
      dispatchPolicy("gitlab:issue:target-mention", "mtgl-v2"), () => 101)
    decideAndCommit(source, event({ source: "workflow", sourceEventId: "wf-1", project: "p2", subject: "wf:run-1" }),
      dispatchPolicy("workflow-dispatcher", "wf-agent"), () => 102)

    const result = replay(target, dumpEvents(source), dumpDecisions(source))
    expect(result.eventsCount).toBe(3)
    expect(result.decisionsCount).toBe(3)
    expect(result.divergences).toEqual([])
  })
})

describe("replay — divergence handling", () => {
  it("missing event: a decision pointing at an event not in the snapshot is reported", () => {
    // Manually craft a decisions array that refers to an event we omit
    // from the dump. This is the "snapshot incomplete" case.
    const orphan: IntentDecision[] = [{
      eventId: "ghost",
      decidedAt: 1,
      decidedBy: "router",
      agentId: "x",
      outcome: "dispatched",
      reason: null,
    }]
    const result = replay(target, [], orphan)
    expect(result.divergences).toHaveLength(1)
    expect(result.divergences[0].reason).toMatch(/event not in snapshot/)
  })

  it("decisions are processed in decidedAt order — later decisions see earlier ledger state", () => {
    // Construct two events on the same (project, subject) but recorded
    // OUT OF ORDER in the dump. Sorting must put the earlier-decidedAt
    // first so active-task safety gives the right result.
    decideAndCommit(source, event({ sourceEventId: "evt-1" }),
      dispatchPolicy("router", "agent-x"), () => 100)
    decideAndCommit(source, event({ sourceEventId: "evt-2" }),
      dispatchPolicy("router", "agent-x"), () => 200)

    const events = dumpEvents(source)
    const decisions = dumpDecisions(source).reverse() // shuffled order

    const result = replay(target, events, decisions)
    expect(result.divergences).toEqual([])
  })
})

describe("replay — counterfactual building block", () => {
  it("a fresh target ledger ends up with the same row counts as source", () => {
    decideAndCommit(source, event({ sourceEventId: "evt-1" }),
      dispatchPolicy("router", "agent-x"), () => 100)
    decideAndCommit(source, event({ sourceEventId: "evt-2", subject: "s2" }),
      dispatchPolicy("router", "agent-y"), () => 200)
    decideAndCommit(source, event({ sourceEventId: "evt-3", subject: "s3" }),
      haltPolicy("router", "no match"), () => 300)

    const result = replay(target, dumpEvents(source), dumpDecisions(source))
    expect(result.divergences).toEqual([])

    const sEvents = source.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    const tEvents = target.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    expect(tEvents.n).toBe(sEvents.n)

    const sDecisions = source.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }
    const tDecisions = target.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }
    expect(tDecisions.n).toBe(sDecisions.n)
  })
})

describe("replay — large randomized scenario (regression-test stand-in)", () => {
  it("100 events across 5 (project, subject) slots replay with 0 divergences", () => {
    // Phase 7's definition of done says "30 days of ledger replays
    // identically." Until there's actual production data to replay,
    // we simulate with a randomized scenario. mulberry32 PRNG keeps
    // it deterministic.
    let s = 12345
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const slots = [
      { project: "p1", subject: "s1" },
      { project: "p1", subject: "s2" },
      { project: "p2", subject: "s1" },
      { project: null, subject: null },     // null-slot — no active-task safety
      { project: "p3", subject: "s9" },
    ]
    for (let i = 0; i < 100; i++) {
      const slot = slots[Math.floor(rand() * slots.length)]
      const policy = rand() < 0.7
        ? dispatchPolicy(`router-${i % 3}`, `agent-${Math.floor(rand() * 3)}`)
        : haltPolicy(`router-${i % 3}`, "no-match")
      decideAndCommit(source, event({
        sourceEventId: `evt-${i}`,
        project: slot.project,
        subject: slot.subject,
      }), policy, () => 1000 + i)
      // Periodically resolve an in-flight decision
      if (i % 11 === 0) {
        const inflight = source.db.prepare(`
          SELECT d.event_id, d.decided_by FROM intent_decisions d
          LEFT JOIN intent_resolutions r
            ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
          WHERE d.outcome = 'dispatched' AND r.decision_event_id IS NULL
          LIMIT 1
        `).get() as { event_id: string; decided_by: string } | undefined
        if (inflight) {
          source.recordResolution({
            decisionEventId: inflight.event_id,
            decisionDecidedBy: inflight.decided_by,
            resolvedAt: 1000 + i,
            status: "completed",
            durationMs: 1,
            resultSummary: null,
          })
        }
      }
    }

    const result = replay(
      target,
      dumpEvents(source),
      dumpDecisions(source),
      dumpResolutions(source),
    )

    // The randomized scenario shouldn't produce any divergences when
    // replayed — all the ledger's mechanics are deterministic given
    // event+decision+resolution history.
    expect(result.divergences).toEqual([])
    expect(result.decisionsCount).toBeGreaterThan(50) // sanity
  })

  it("resolution between two same-slot decisions: replay sees freed slot, second dispatches cleanly", () => {
    // First dispatch
    const first = decideAndCommit(source, event({ sourceEventId: "evt-1" }),
      dispatchPolicy("router", "agent-x"), () => 100)
    // Resolve it
    source.recordResolution({
      decisionEventId: first.eventId, decisionDecidedBy: first.decidedBy,
      resolvedAt: 150, status: "completed", durationMs: 50, resultSummary: null,
    })
    // Second dispatch on same slot — should succeed (slot freed)
    const second = decideAndCommit(source, event({ sourceEventId: "evt-2" }),
      dispatchPolicy("router", "agent-y"), () => 200)
    expect(second.outcome).toBe("dispatched")
    expect(second.agentId).toBe("agent-y")

    const result = replay(
      target,
      dumpEvents(source),
      dumpDecisions(source),
      dumpResolutions(source),
    )
    expect(result.divergences).toEqual([])
  })
})
