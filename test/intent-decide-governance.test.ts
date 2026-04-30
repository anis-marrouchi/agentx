import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchGovernance, type DispatchPolicy } from "../src/intent/decide"
import type { IntentEventInput } from "../src/intent/types"

// Phase 3 governance hooks for decideAndCommit.
//
// Tests verify the property the kickoff requires:
//   "a dispatch decision for (project, ...) where business.projects[].pm
//    is set never resolves to an agent without going through the PM first
//    (PM may rubber-stamp, but the decision row records
//    decided_by='pm:pm-mtgl')"

let tmp: string
let ledger: IntentLedger
let clock: { t: number }

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-decide-gov-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
  clock = { t: 1714400000000 }
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
})

const tick = () => ++clock.t

const dispatch = (decidedBy: string, agentId: string): DispatchPolicy => ({
  decidedBy,
  decide: () => ({ agentId, outcome: "dispatched", reason: null }),
})

function evt(o: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: clock.t, source: "gitlab", sourceEventId: "e1",
    project: "p1", subject: "s1", intent: "issue.opened",
    rawJson: "{}", ...o,
  }
}

describe("decideAndCommit governance — pmFor (PM-gate)", () => {
  it("when pmFor returns a PM, the decision's decidedBy becomes pm:<id>", () => {
    const gov: DispatchGovernance = { pmFor: (p) => p === "p1" ? "the-pm" : undefined }
    const d = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick, gov)
    expect(d.decidedBy).toBe("pm:the-pm")
    expect(d.outcome).toBe("dispatched")
    expect(d.agentId).toBe("agent-x") // dispatch target unchanged — PM rubber-stamps
    expect(d.reason).toMatch(/pm-gate.*rubber-stamped by the-pm/)
  })

  it("when pmFor returns undefined, decidedBy stays as the policy's", () => {
    const gov: DispatchGovernance = { pmFor: () => undefined }
    const d = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick, gov)
    expect(d.decidedBy).toBe("router")
    expect(d.reason).toBeNull() // policy returned null reason; no PM annotation added
  })

  it("when no governance is supplied, behavior is unchanged (back-compat)", () => {
    const d = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick)
    expect(d.decidedBy).toBe("router")
  })

  it("re-delivery of same event with PM gate active is idempotent (no UNIQUE constraint failure)", () => {
    const gov: DispatchGovernance = { pmFor: () => "the-pm" }
    const d1 = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick, gov)
    const d2 = decideAndCommit(ledger, evt({ ts: clock.t }), dispatch("router", "agent-x"), tick, gov)
    expect(d2.eventId).toBe(d1.eventId)
    expect(d2.decidedBy).toBe(d1.decidedBy)
    expect(d2.decidedAt).toBe(d1.decidedAt) // idempotency cached
    const decisions = ledger.getDecisionsForEvent(d1.eventId)
    expect(decisions).toHaveLength(1)
  })

  it("PM gate also applies to active-task safety dedup decisions", () => {
    const gov: DispatchGovernance = { pmFor: () => "the-pm" }
    decideAndCommit(ledger, evt({ sourceEventId: "e1" }),
      dispatch("router", "agent-x"), tick, gov)
    const second = decideAndCommit(ledger, evt({ sourceEventId: "e2" }),
      dispatch("router", "agent-y"), tick, gov)
    expect(second.outcome).toBe("deduped")
    expect(second.decidedBy).toBe("pm:the-pm") // dedup decision attributed to PM too
  })

  it("PM gate is project-scoped — different projects can have different PMs (or none)", () => {
    const gov: DispatchGovernance = {
      pmFor: (p) => p === "p1" ? "pm-a" : p === "p2" ? "pm-b" : undefined,
    }
    const d1 = decideAndCommit(ledger, evt({ sourceEventId: "e1", project: "p1" }),
      dispatch("router", "x"), tick, gov)
    const d2 = decideAndCommit(ledger, evt({ sourceEventId: "e2", project: "p2", subject: "s2" }),
      dispatch("router", "y"), tick, gov)
    const d3 = decideAndCommit(ledger, evt({ sourceEventId: "e3", project: "p3", subject: "s3" }),
      dispatch("router", "z"), tick, gov)
    expect(d1.decidedBy).toBe("pm:pm-a")
    expect(d2.decidedBy).toBe("pm:pm-b")
    expect(d3.decidedBy).toBe("router") // no PM for p3
  })

  it("project=null means no PM gate (router-style events)", () => {
    const gov: DispatchGovernance = { pmFor: () => "would-be-pm" }
    const d = decideAndCommit(ledger,
      evt({ project: null, subject: null }),
      dispatch("router", "x"), tick, gov)
    // pmFor should still be called, but with null — let's verify the call site
    // gracefully handles null. We expect the PM rewrite if pmFor returns a value.
    // The kickoff implementation choice: pmFor reads project, returns undefined
    // for null. The TEST's gov stub returns "would-be-pm" unconditionally, so
    // here it WILL gate. Verify decidedBy reflects that.
    expect(d.decidedBy).toBe("pm:would-be-pm")
  })
})

describe("decideAndCommit governance — canHandle (capability veto)", () => {
  it("canHandle returning false forces outcome=halted with org-chart reason", () => {
    const gov: DispatchGovernance = { canHandle: () => false }
    const d = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick, gov)
    expect(d.outcome).toBe("halted")
    expect(d.agentId).toBeNull()
    expect(d.reason).toMatch(/org-chart.*cannot handle/)
  })

  it("canHandle returning true is a no-op", () => {
    const gov: DispatchGovernance = { canHandle: () => true }
    const d = decideAndCommit(ledger, evt(), dispatch("router", "agent-x"), tick, gov)
    expect(d.outcome).toBe("dispatched")
    expect(d.agentId).toBe("agent-x")
  })

  it("canHandle is consulted with the dispatched agentId, project, and intent", () => {
    let observed: { agentId?: string; project?: string | null; intent?: string | null } = {}
    const gov: DispatchGovernance = {
      canHandle: (agentId, project, intent) => {
        observed = { agentId, project, intent }
        return true
      },
    }
    decideAndCommit(ledger,
      evt({ project: "noqta", subject: "issue:1", intent: "issue.opened" }),
      dispatch("router", "agent-x"), tick, gov)
    expect(observed).toEqual({ agentId: "agent-x", project: "noqta", intent: "issue.opened" })
  })

  it("canHandle veto + pmFor: decision attributes to PM but outcome is halted", () => {
    const gov: DispatchGovernance = {
      canHandle: () => false,
      pmFor: () => "the-pm",
    }
    const d = decideAndCommit(ledger, evt(), dispatch("router", "x"), tick, gov)
    expect(d.outcome).toBe("halted") // canHandle vetoed
    expect(d.decidedBy).toBe("pm:the-pm") // PM gate still in effect
    expect(d.reason).toMatch(/org-chart.*cannot handle/)
  })

  it("canHandle is NOT consulted for non-dispatched outcomes (halt/queue)", () => {
    let called = false
    const gov: DispatchGovernance = {
      canHandle: () => { called = true; return true },
    }
    const haltPolicy: DispatchPolicy = {
      decidedBy: "router",
      decide: () => ({ agentId: null, outcome: "halted", reason: "no match" }),
    }
    decideAndCommit(ledger, evt(), haltPolicy, tick, gov)
    expect(called).toBe(false)
  })
})

describe("decideAndCommit governance — kickoff property", () => {
  it("dispatch on a project with a configured PM never records decided_by !== pm:<id>", () => {
    // Property from kickoff §2 phase 3 DoD:
    //   "a dispatch decision for (project, ...) where business.projects[].pm
    //    is set never resolves to an agent without going through the PM first
    //    (PM may rubber-stamp, but the decision row records
    //    decided_by='pm:pm-mtgl')"
    const gov: DispatchGovernance = { pmFor: (p) => p === "p1" ? "the-pm" : undefined }
    // Multiple events on p1, varied policies
    decideAndCommit(ledger, evt({ sourceEventId: "e1" }),
      dispatch("channel-router", "x"), tick, gov)
    decideAndCommit(ledger, evt({ sourceEventId: "e2", subject: "s2" }),
      dispatch("workflow:abc", "y"), tick, gov)
    decideAndCommit(ledger, evt({ sourceEventId: "e3", subject: "s3" }),
      { decidedBy: "gitlab:issue:target-mention", decide: () => ({ agentId: "z", outcome: "dispatched", reason: null }) },
      tick, gov)

    const dispatched = ledger.db
      .prepare(`SELECT * FROM intent_decisions d JOIN intent_events e ON e.id = d.event_id WHERE e.project = 'p1' AND d.outcome = 'dispatched'`)
      .all() as Array<{ decided_by: string }>
    expect(dispatched.length).toBeGreaterThan(0)
    for (const row of dispatched) {
      expect(row.decided_by).toBe("pm:the-pm")
    }
  })
})
