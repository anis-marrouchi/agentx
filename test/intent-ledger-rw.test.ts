import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decodeTime, newEventId } from "../src/intent/ulid"
import type { IntentEventInput } from "../src/intent/types"

// Read/write API tests for Phase 1 commit 2. Companion to intent-ledger-schema.test.ts:
// schema correctness pinned there, runtime semantics pinned here.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-intent-rw-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
})

function eventInput(overrides: Partial<IntentEventInput> = {}): IntentEventInput {
  return {
    ts: 1714400000000,
    source: "gitlab",
    sourceEventId: "gl-evt-1",
    project: "mtgl/mtgl-system-v2",
    subject: "issue:709",
    intent: "issue.opened",
    rawJson: JSON.stringify({ kind: "issue", id: 709 }),
    ...overrides,
  }
}

describe("IntentLedger.recordEvent", () => {
  it("inserts a new event and returns it with a generated id", () => {
    const e = ledger.recordEvent(eventInput())
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(e.source).toBe("gitlab")
    expect(e.subject).toBe("issue:709")
    // The generated id encodes the event ts in its first 10 chars.
    expect(decodeTime(e.id)).toBe(e.ts)
  })

  it("is idempotent on (source, sourceEventId) — re-delivery returns the same row", () => {
    const first = ledger.recordEvent(eventInput())
    const second = ledger.recordEvent(eventInput({ ts: 1714400000999, project: "ignored" }))
    // Same id, same stored project (the second call must NOT have overwritten).
    expect(second.id).toBe(first.id)
    expect(second.project).toBe("mtgl/mtgl-system-v2")
    const all = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    expect(all.n).toBe(1)
  })

  it("respects caller-supplied id when provided (deterministic-test path)", () => {
    const fixedId = newEventId(1714400000000)
    const e = ledger.recordEvent(eventInput({ id: fixedId }))
    expect(e.id).toBe(fixedId)
  })

  it("does not deduplicate events with sourceEventId === null", () => {
    // Cron firings have no stable external id; each tic is its own event.
    const a = ledger.recordEvent(eventInput({ source: "cron", sourceEventId: null, subject: null }))
    const b = ledger.recordEvent(eventInput({ source: "cron", sourceEventId: null, subject: null }))
    expect(a.id).not.toBe(b.id)
    const count = ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }
    expect(count.n).toBe(2)
  })

  it("findEventBySourceId returns null for unknown ids and the row for known ones", () => {
    expect(ledger.findEventBySourceId("gitlab", "missing")).toBeNull()
    const e = ledger.recordEvent(eventInput())
    const found = ledger.findEventBySourceId("gitlab", "gl-evt-1")
    expect(found?.id).toBe(e.id)
  })

  it("getEventById round-trips the full payload", () => {
    const e = ledger.recordEvent(eventInput())
    const back = ledger.getEventById(e.id)
    expect(back).toEqual(e)
  })
})

describe("IntentLedger.recordDecision", () => {
  it("requires the event to exist (FK)", () => {
    expect(() =>
      ledger.recordDecision({
        eventId: "ghost",
        decidedAt: 1,
        decidedBy: "channel-router",
        agentId: null,
        outcome: "halted",
        reason: "no parent",
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it("rejects duplicate (eventId, decidedBy) — decisions are once-and-only-once per decider", () => {
    const e = ledger.recordEvent(eventInput())
    const decision = {
      eventId: e.id,
      decidedAt: e.ts + 1,
      decidedBy: "channel-router",
      agentId: "mtgl-v2",
      outcome: "dispatched" as const,
      reason: null,
    }
    ledger.recordDecision(decision)
    expect(() => ledger.recordDecision(decision)).toThrow(/UNIQUE|PRIMARY/i)
  })

  it("permits multiple decisions for the same event from different deciders (chain)", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: e.ts + 1, decidedBy: "channel-router",
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
    ledger.recordDecision({
      eventId: e.id, decidedAt: e.ts + 2, decidedBy: "pm:pm-mtgl",
      agentId: null, outcome: "halted", reason: "PM denied — out of scope",
    })
    const chain = ledger.getDecisionsForEvent(e.id)
    expect(chain.map((d) => d.decidedBy)).toEqual(["channel-router", "pm:pm-mtgl"])
    expect(chain[1].reason).toBe("PM denied — out of scope")
  })
})

describe("IntentLedger.getActiveDecisionForSubject", () => {
  it("returns null when nothing has been dispatched for the subject", () => {
    expect(ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", "issue:709")).toBeNull()
  })

  it("returns the in-flight dispatched decision while it has no resolution", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: e.ts + 1, decidedBy: "channel-router",
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
    const active = ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", "issue:709")
    expect(active?.agentId).toBe("mtgl-v2")
    expect(active?.outcome).toBe("dispatched")
  })

  it("ignores resolved decisions — the active-task slot is freed once a resolution lands", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: e.ts + 1, decidedBy: "channel-router",
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
    ledger.recordResolution({
      decisionEventId: e.id, decisionDecidedBy: "channel-router",
      resolvedAt: e.ts + 100, status: "completed", durationMs: 99, resultSummary: "ok",
    })
    expect(ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", "issue:709")).toBeNull()
  })

  it("ignores non-dispatched decisions — halted/deduped/queued never count as active", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: e.ts + 1, decidedBy: "channel-router",
      agentId: null, outcome: "halted", reason: "no eligible agent",
    })
    expect(ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", "issue:709")).toBeNull()
  })

  it("returns null when project or subject is null — active-task is undefined without both", () => {
    expect(ledger.getActiveDecisionForSubject(null, "issue:709")).toBeNull()
    expect(ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", null)).toBeNull()
  })

  it("scopes by (project, subject) — same subject string in another project is a different slot", () => {
    const a = ledger.recordEvent(eventInput({ sourceEventId: "gl-evt-a", project: "proj-a" }))
    const b = ledger.recordEvent(eventInput({ sourceEventId: "gl-evt-b", project: "proj-b" }))
    ledger.recordDecision({
      eventId: a.id, decidedAt: a.ts + 1, decidedBy: "channel-router",
      agentId: "agent-a", outcome: "dispatched", reason: null,
    })
    ledger.recordDecision({
      eventId: b.id, decidedAt: b.ts + 1, decidedBy: "channel-router",
      agentId: "agent-b", outcome: "dispatched", reason: null,
    })
    expect(ledger.getActiveDecisionForSubject("proj-a", "issue:709")?.agentId).toBe("agent-a")
    expect(ledger.getActiveDecisionForSubject("proj-b", "issue:709")?.agentId).toBe("agent-b")
  })

  it("returns the most recent dispatched-and-unresolved decision when multiple exist", () => {
    // Sequential lifecycle: dispatch, complete, dispatch again. Only the
    // newest unresolved one counts as active.
    const e1 = ledger.recordEvent(eventInput({ sourceEventId: "gl-evt-1" }))
    ledger.recordDecision({
      eventId: e1.id, decidedAt: 100, decidedBy: "channel-router",
      agentId: "old-agent", outcome: "dispatched", reason: null,
    })
    ledger.recordResolution({
      decisionEventId: e1.id, decisionDecidedBy: "channel-router",
      resolvedAt: 200, status: "completed", durationMs: 100, resultSummary: "ok",
    })
    const e2 = ledger.recordEvent(eventInput({ sourceEventId: "gl-evt-2" }))
    ledger.recordDecision({
      eventId: e2.id, decidedAt: 300, decidedBy: "channel-router",
      agentId: "new-agent", outcome: "dispatched", reason: null,
    })
    const active = ledger.getActiveDecisionForSubject("mtgl/mtgl-system-v2", "issue:709")
    expect(active?.agentId).toBe("new-agent")
  })
})

describe("IntentLedger.recordResolution", () => {
  it("requires the decision to exist (FK)", () => {
    expect(() =>
      ledger.recordResolution({
        decisionEventId: "ghost", decisionDecidedBy: "nobody",
        resolvedAt: 1, status: "completed", durationMs: null, resultSummary: null,
      }),
    ).toThrow(/FOREIGN KEY/)
  })

  it("rejects a second resolution for the same decision — append-only", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: 1, decidedBy: "channel-router",
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
    const res = {
      decisionEventId: e.id, decisionDecidedBy: "channel-router",
      resolvedAt: 100, status: "completed" as const, durationMs: 99, resultSummary: "ok",
    }
    ledger.recordResolution(res)
    expect(() => ledger.recordResolution({ ...res, status: "failed" })).toThrow(/UNIQUE|PRIMARY/i)
  })

  it("getResolution returns null while in-flight and the row once resolved", () => {
    const e = ledger.recordEvent(eventInput())
    ledger.recordDecision({
      eventId: e.id, decidedAt: 1, decidedBy: "channel-router",
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
    expect(ledger.getResolution(e.id, "channel-router")).toBeNull()
    ledger.recordResolution({
      decisionEventId: e.id, decisionDecidedBy: "channel-router",
      resolvedAt: 100, status: "timed-out", durationMs: 60000, resultSummary: null,
    })
    const r = ledger.getResolution(e.id, "channel-router")
    expect(r?.status).toBe("timed-out")
    expect(r?.durationMs).toBe(60000)
  })
})
