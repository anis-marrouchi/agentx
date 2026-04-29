import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildIssueDispatchPolicy,
  buildIssueEventInput,
  recordIssueTargetDispatch,
  type IssueEventProjection,
  type IssueTarget,
} from "../src/intent/sources/gitlab"
import { decodeTime } from "../src/intent/ulid"

// Tests for Phase 1 commit 6.a — gitlab issue-dispatch adapter helpers.
//
// Adapter functions are pure (or pure-ish — recordIssueTargetDispatch
// writes to the ledger) and exercised here without spinning up the full
// GitLabAdapter / channel-router / daemon stack. The integration test
// in test/intent-gitlab-handle-issue.test.ts drives the real handler
// end-to-end with a mocked event.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-gitlab-adapter-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const sampleIssue: IssueEventProjection = {
  project: "mtgl/mtgl-system-v2",
  iid: 709,
  action: "open",
  title: "Test issue",
  description: "Hello",
  url: "https://gitlab.example/issues/709",
}

const sampleTarget: IssueTarget = { agentId: "mtgl-v2", trigger: "assignee-added" }

describe("buildIssueEventInput", () => {
  it("normalizes the webhook into an IntentEventInput with per-target sourceEventId + subject", () => {
    const input = buildIssueEventInput(sampleIssue, sampleTarget, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "gitlab",
      sourceEventId: "709:open:mtgl-v2:assignee-added",
      project: "mtgl/mtgl-system-v2",
      subject: "issue:709:agent:mtgl-v2:trigger:assignee-added",
      intent: "issue.open",
      rawJson: "{}",
    })
  })

  it("each (target.agentId × target.trigger) combo gets its own sourceEventId", () => {
    const a = buildIssueEventInput(sampleIssue, { agentId: "agent-a", trigger: "mention" }, "{}", () => 1)
    const b = buildIssueEventInput(sampleIssue, { agentId: "agent-b", trigger: "mention" }, "{}", () => 1)
    const c = buildIssueEventInput(sampleIssue, { agentId: "agent-a", trigger: "default-route" }, "{}", () => 1)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
    expect(a.sourceEventId).not.toBe(c.sourceEventId)
    expect(b.sourceEventId).not.toBe(c.sourceEventId)
  })

  it("subject scopes active-task safety to the per-target slot", () => {
    // Two targets on the same issue produce different subjects, so
    // dispatching to both does NOT trip the at-most-one-in-flight
    // invariant in the ledger.
    const a = buildIssueEventInput(sampleIssue, { agentId: "agent-a", trigger: "mention" }, "{}", () => 1)
    const b = buildIssueEventInput(sampleIssue, { agentId: "agent-b", trigger: "mention" }, "{}", () => 1)
    expect(a.subject).not.toBe(b.subject)
  })
})

describe("buildIssueDispatchPolicy", () => {
  it("decidedBy includes the trigger so chain readouts identify the source path", () => {
    expect(buildIssueDispatchPolicy({ agentId: "x", trigger: "mention" }).decidedBy)
      .toBe("gitlab:issue:target-mention")
    expect(buildIssueDispatchPolicy({ agentId: "x", trigger: "default-route" }).decidedBy)
      .toBe("gitlab:issue:target-default-route")
  })

  it("decide() returns dispatched/agentId — the policy is a thin wrapper around computeIssueTargets' choice", () => {
    const policy = buildIssueDispatchPolicy(sampleTarget)
    const decision = policy.decide({} as any)
    expect(decision).toEqual({
      agentId: "mtgl-v2",
      outcome: "dispatched",
      reason: null,
    })
  })
})

describe("recordIssueTargetDispatch", () => {
  it("writes event + decision; ULID time-encodes the supplied clock", () => {
    recordIssueTargetDispatch(
      ledger,
      sampleIssue,
      sampleTarget,
      "{}",
      { agentId: "mtgl-v2", outcome: "dispatched" },
      () => 1714400000000,
    )
    const events = ledger.db.prepare("SELECT * FROM intent_events").all() as Array<{ id: string; ts: number }>
    expect(events).toHaveLength(1)
    expect(decodeTime(events[0].id)).toBe(1714400000000)

    const decisions = ledger.db.prepare("SELECT * FROM intent_decisions").all()
    expect(decisions).toHaveLength(1)
  })

  it("agreement: ledger=dispatched/mtgl-v2 and legacy=dispatched/mtgl-v2 → no divergence", () => {
    recordIssueTargetDispatch(
      ledger,
      sampleIssue,
      sampleTarget,
      "{}",
      { agentId: "mtgl-v2", outcome: "dispatched" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("disagreement: ledger=dispatched, legacy=deduped → divergence row + log", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    recordIssueTargetDispatch(
      ledger,
      sampleIssue,
      sampleTarget,
      "{}",
      { agentId: null, outcome: "deduped", reason: "isDispatchedRecently" },
      () => 1,
    )
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0].source).toBe("gitlab")
    expect(divergences[0].ledgerOutcome).toBe("dispatched")
    expect(divergences[0].legacyOutcome).toBe("deduped")
    expect(divergences[0].legacyReason).toBe("isDispatchedRecently")
  })

  it("re-delivery of the same target re-applies idempotently — one event, one decision", () => {
    for (let i = 0; i < 3; i++) {
      recordIssueTargetDispatch(
        ledger,
        sampleIssue,
        sampleTarget,
        "{}",
        { agentId: "mtgl-v2", outcome: "dispatched" },
        () => 1 + i,
      )
    }
    const events = (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n
    const decisions = (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n
    expect(events).toBe(1)
    expect(decisions).toBe(1)
  })

  it("multiple targets on the same issue → each gets its own event row + decision", () => {
    const targets: IssueTarget[] = [
      { agentId: "agent-a", trigger: "mention" },
      { agentId: "agent-b", trigger: "assignee-added" },
      { agentId: "agent-c", trigger: "default-route" },
    ]
    for (const t of targets) {
      recordIssueTargetDispatch(
        ledger,
        sampleIssue,
        t,
        "{}",
        { agentId: t.agentId, outcome: "dispatched" },
        () => 1,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(3)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(3)
    expect(ledger.getDivergences()).toHaveLength(0)
  })
})
