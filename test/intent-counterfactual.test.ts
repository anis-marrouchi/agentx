import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchPolicy } from "../src/intent/decide"
import { counterfactual } from "../src/intent/counterfactual"
import type { IntentDecision, IntentEvent, IntentEventInput, IntentResolution } from "../src/intent/types"

let tmp: string
let source: IntentLedger
let target: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-counterfactual-"))
  source = new IntentLedger({ path: path.join(tmp, "source.sqlite") })
  target = new IntentLedger({ path: path.join(tmp, "target.sqlite") })
})

afterEach(() => {
  source.close()
  target.close()
  rmSync(tmp, { recursive: true, force: true })
})

function dumpEvents(l: IntentLedger): IntentEvent[] {
  return (l.db.prepare(`SELECT id, ts, source, source_event_id, project, subject, intent, raw_json FROM intent_events`).all() as Array<any>)
    .map((r) => ({
      id: r.id, ts: r.ts, source: r.source,
      sourceEventId: r.source_event_id, project: r.project, subject: r.subject,
      intent: r.intent, rawJson: r.raw_json,
    }))
}
function dumpDecisions(l: IntentLedger): IntentDecision[] {
  return (l.db.prepare(`SELECT event_id, decided_at, decided_by, agent_id, outcome, reason FROM intent_decisions`).all() as Array<any>)
    .map((r) => ({
      eventId: r.event_id, decidedAt: r.decided_at, decidedBy: r.decided_by,
      agentId: r.agent_id, outcome: r.outcome, reason: r.reason,
    }))
}
function dumpResolutions(l: IntentLedger): IntentResolution[] {
  return (l.db.prepare(`SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary FROM intent_resolutions`).all() as Array<any>)
    .map((r) => ({
      decisionEventId: r.decision_event_id, decisionDecidedBy: r.decision_decided_by,
      resolvedAt: r.resolved_at, status: r.status, durationMs: r.duration_ms, resultSummary: r.result_summary,
    }))
}

const dispatch = (decidedBy: string, agentId: string): DispatchPolicy => ({
  decidedBy,
  decide: () => ({ agentId, outcome: "dispatched", reason: null }),
})

function evt(o: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: 1714400000000, source: "gitlab", sourceEventId: "evt-1",
    project: "p1", subject: "s1", intent: "test", rawJson: "{}",
    ...o,
  }
}

describe("counterfactual — basic substitution", () => {
  it("substituting one decision changes that decision and reports as the only cascade row when it's the trace's tail", () => {
    const d = decideAndCommit(source, evt(), dispatch("router", "agent-x"), () => 100)

    const result = counterfactual(target,
      dumpEvents(source), dumpDecisions(source), dumpResolutions(source),
      { eventId: d.eventId, decidedBy: "router", agentId: "agent-y", outcome: "dispatched" },
    )
    expect(result.cascade).toHaveLength(1)
    expect(result.cascade[0].sourceAgent).toBe("agent-x")
    expect(result.cascade[0].newAgent).toBe("agent-y")
    expect(result.cascade[0].isModification).toBe(true)
  })

  it("substituting dispatch → halt frees the active-task slot, cascading the next same-slot decision from deduped → halted (best-effort)", () => {
    const first = decideAndCommit(source, evt({ sourceEventId: "evt-1" }),
      dispatch("router", "agent-x"), () => 100)
    const second = decideAndCommit(source, evt({ sourceEventId: "evt-2" }),
      dispatch("router", "agent-y"), () => 200)
    expect(first.outcome).toBe("dispatched")
    expect(second.outcome).toBe("deduped") // active-task safety

    const result = counterfactual(target,
      dumpEvents(source), dumpDecisions(source), dumpResolutions(source),
      { eventId: first.eventId, decidedBy: "router", agentId: null, outcome: "halted", reason: "manual halt" },
    )

    // Two cascade rows: the modification itself + the affected dedup
    // chain. **Architectural limitation**: the cascaded decision's new
    // outcome is "halted" (not "dispatched") because the playback
    // policy can't know what the original policy would have decided
    // in a freed slot — we only stored the recorded outcome (which
    // was "deduped"), and the policy can't return "deduped". The
    // cascade row's existence is the operator-visible signal that
    // the downstream decision changed; the exact new outcome is
    // best-effort and documented as such in src/intent/counterfactual.ts.
    expect(result.cascade).toHaveLength(2)
    const mod = result.cascade.find((r) => r.isModification)!
    const cascadeRow = result.cascade.find((r) => !r.isModification)!
    expect(mod.sourceOutcome).toBe("dispatched")
    expect(mod.newOutcome).toBe("halted")
    expect(cascadeRow.sourceOutcome).toBe("deduped")
    expect(cascadeRow.newOutcome).toBe("halted")
  })

  it("substituting halt → dispatch (no cascade): no other decisions touch this slot", () => {
    decideAndCommit(source, evt({ sourceEventId: "evt-1" }), {
      decidedBy: "router",
      decide: () => ({ agentId: null, outcome: "halted", reason: "no-match" }),
    }, () => 100)

    const events = dumpEvents(source)
    const result = counterfactual(target,
      events, dumpDecisions(source), dumpResolutions(source),
      { eventId: events[0].id, decidedBy: "router", agentId: "agent-x", outcome: "dispatched" },
    )
    expect(result.cascade).toHaveLength(1) // just the modification
    expect(result.cascade[0].isModification).toBe(true)
    expect(result.cascade[0].sourceOutcome).toBe("halted")
    expect(result.cascade[0].newOutcome).toBe("dispatched")
  })

  it("modifications on different slots produce independent cascades", () => {
    decideAndCommit(source, evt({ sourceEventId: "a", subject: "s1" }),
      dispatch("router", "x"), () => 100)
    decideAndCommit(source, evt({ sourceEventId: "b", subject: "s2" }),
      dispatch("router", "y"), () => 200)
    decideAndCommit(source, evt({ sourceEventId: "c", subject: "s1" }),
      dispatch("router", "z"), () => 300) // dedupes vs first

    // Counterfactual: halt the s1 first dispatch.
    const events = dumpEvents(source)
    const aEvent = events.find((e) => e.sourceEventId === "a")!
    const result = counterfactual(target,
      events, dumpDecisions(source), dumpResolutions(source),
      { eventId: aEvent.id, decidedBy: "router", agentId: null, outcome: "halted", reason: "halt-a" },
    )

    // s1 has 2 changes (halt + freed dedup → dispatch)
    // s2 unchanged
    const s1Cascade = result.cascade.filter((r) =>
      r.eventId === aEvent.id || r.eventId === events.find((e) => e.sourceEventId === "c")!.id
    )
    expect(s1Cascade).toHaveLength(2)
  })

  it("throws when the modification targets a decision not in the snapshot", () => {
    decideAndCommit(source, evt(), dispatch("router", "x"), () => 1)
    expect(() =>
      counterfactual(target,
        dumpEvents(source), dumpDecisions(source), dumpResolutions(source),
        { eventId: "no-such-event", decidedBy: "router", agentId: "y", outcome: "dispatched" },
      ),
    ).toThrow(/has no decision/)
  })

  it("works with resolutions: substituting a dispatched decision to halted still records the resolution against the modified row", () => {
    const d = decideAndCommit(source, evt(), dispatch("router", "x"), () => 100)
    source.recordResolution({
      decisionEventId: d.eventId, decisionDecidedBy: d.decidedBy,
      resolvedAt: 200, status: "completed", durationMs: 100, resultSummary: null,
    })

    const result = counterfactual(target,
      dumpEvents(source), dumpDecisions(source), dumpResolutions(source),
      { eventId: d.eventId, decidedBy: "router", agentId: null, outcome: "halted" },
    )

    expect(result.cascade).toHaveLength(1)
    expect(result.cascade[0].newOutcome).toBe("halted")
    // Resolution lands in target — the FK on
    // intent_resolutions(event_id, decided_by) doesn't filter on
    // outcome, so the resolution attaches to the (now-halted)
    // decision row. Semantically it's nonsense — you don't resolve a
    // halt — but the schema allows it. Operators reading the cascade
    // row see the modification; the resolution noise is forensically
    // visible too if they query intent_resolutions directly.
    const resCount = target.db.prepare("SELECT COUNT(*) as n FROM intent_resolutions").get() as { n: number }
    expect(resCount.n).toBe(1)
  })
})
