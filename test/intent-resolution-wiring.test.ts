import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import { decideAndCommit, type DispatchPolicy } from "../src/intent/decide"
import { recordRouterDispatch, recordCronDispatch } from "../src/intent/sources/router"
import { recordCronDispatch as cronDispatch } from "../src/intent/sources/cron"
import {
  recordGitLabTargetDispatch,
  recordGitLabNoteDispatch,
  recordGitLabIssueLevelDecision,
} from "../src/intent/sources/gitlab"
import { recordMeshDispatch } from "../src/intent/sources/mesh"
import { recordWorkflowDispatch } from "../src/intent/sources/workflow"

// Confirms the record*Dispatch helpers all return the IntentDecision so
// callers can extract intentRef = { eventId, decidedBy } for the
// resolution-on-completion wiring in registry.execute.
//
// Companion to the production wiring in src/channels/gitlab.ts,
// src/channels/router.ts, src/crons/scheduler.ts, src/daemon/index.ts.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-resolution-wiring-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe("record*Dispatch helpers return the IntentDecision", () => {
  it("recordRouterDispatch returns the decision row with eventId + decidedBy", () => {
    const decision = recordRouterDispatch(
      ledger,
      { id: "msg-1", channel: "telegram", accountId: "default", sender: { id: "u1" } },
      "telegram", "{}",
      { agentId: "agent-x", outcome: "dispatched", reason: null },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
    expect(decision.agentId).toBe("agent-x")
    expect(decision.decidedBy).toBe("channel-router")
    expect(typeof decision.eventId).toBe("string")
  })

  it("recordGitLabTargetDispatch returns dispatched decision with stable event id for resolution lookup", () => {
    const decision = recordGitLabTargetDispatch(
      ledger,
      { entityKind: "issue", project: "p", iid: 1, action: "open", title: "t", description: "d", url: "u" },
      { agentId: "x", trigger: "mention" },
      "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
    // The returned decision's (eventId, decidedBy) MUST match the row
    // in the ledger so caller's resolution write FK-resolves.
    const found = ledger.getDecisionsForEvent(decision.eventId)
    expect(found).toHaveLength(1)
    expect(found[0].decidedBy).toBe(decision.decidedBy)
  })

  it("recordGitLabNoteDispatch returns the decision", () => {
    const decision = recordGitLabNoteDispatch(
      ledger,
      { noteId: "n1", project: "p", noteableType: "issue", noteableIid: "1", mentions: ["x"] },
      "{}",
      { agentId: "x", outcome: "dispatched", reason: "mention:x" },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
    expect(decision.agentId).toBe("x")
  })

  it("recordGitLabIssueLevelDecision returns the decision (issue-level halt)", () => {
    const decision = recordGitLabIssueLevelDecision(
      ledger,
      { entityKind: "issue", project: "p", iid: 1, action: "open", title: "t", description: "d", url: "u" },
      "hook-blocked",
      "gitlab:issue:hook",
      "{}",
      { agentId: null, outcome: "halted", reason: "hook" },
      () => 1,
    )
    expect(decision.outcome).toBe("halted")
  })

  it("recordCronDispatch returns the decision", () => {
    const decision = cronDispatch(
      ledger,
      { jobId: "daily", agentId: "x", firedAt: new Date(1000) },
      "{}",
      { agentId: "x", outcome: "dispatched", reason: null },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
  })

  it("recordMeshDispatch returns the decision", () => {
    const decision = recordMeshDispatch(
      ledger,
      { agentId: "x" },
      "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
  })

  it("recordWorkflowDispatch returns the decision", () => {
    const decision = recordWorkflowDispatch(
      ledger,
      {
        workflowId: "wf-1", eventId: "evt-1", triggerSource: "gitlab",
        project: "p", entityRef: { backend: "issue", id: "1" },
      },
      "{}",
      { claimed: true, runId: "run-1" },
      () => 1,
    )
    expect(decision.outcome).toBe("dispatched")
  })
})

describe("end-to-end: intentRef from helper → resolution write closes the active-task slot", () => {
  it("a recorded dispatch + manual resolution clears active-task safety, allowing same-slot re-dispatch", () => {
    // First dispatch — gitlab issue path.
    const first = recordGitLabTargetDispatch(
      ledger,
      { entityKind: "issue", project: "p", iid: 1, action: "open", title: "t", description: "d", url: "u" },
      { agentId: "x", trigger: "mention" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 100,
    )
    expect(first.outcome).toBe("dispatched")

    // Without a resolution, a second dispatch on the SAME (project,
    // subject) gets active-task-deduped.
    const second = recordGitLabTargetDispatch(
      ledger,
      { entityKind: "issue", project: "p", iid: 1, action: "update", title: "t", description: "d", url: "u" },
      { agentId: "x", trigger: "mention" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 200,
    )
    expect(second.outcome).toBe("deduped")

    // Now write a resolution (mimicking what registry.execute does on
    // completion) using the FIRST dispatch's eventId/decidedBy.
    ledger.recordResolution({
      decisionEventId: first.eventId,
      decisionDecidedBy: first.decidedBy,
      resolvedAt: 300,
      status: "completed",
      durationMs: 200,
      resultSummary: "ok",
    })

    // A third dispatch on the same slot now clears active-task and
    // dispatches again. This is the goal of the resolution wiring:
    // without it, agentx's ledger sees every same-slot re-dispatch as
    // "in flight forever", producing endless false-positive divergences.
    const third = recordGitLabTargetDispatch(
      ledger,
      { entityKind: "issue", project: "p", iid: 1, action: "comment", title: "t", description: "d", url: "u" },
      { agentId: "x", trigger: "mention" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 400,
    )
    expect(third.outcome).toBe("dispatched")
  })
})

describe("decideAndCommit + resolution roundtrip", () => {
  it("the full lifecycle: dispatch → resolve → re-dispatch on same slot succeeds", () => {
    const policy: DispatchPolicy = {
      decidedBy: "channel-router",
      decide: () => ({ agentId: "x", outcome: "dispatched", reason: null }),
    }
    const event = {
      ts: 1, source: "telegram" as const, sourceEventId: "msg-1",
      project: "noqta", subject: "chat:1", intent: "msg", rawJson: "{}",
    }
    const d1 = decideAndCommit(ledger, event, policy, () => 1)
    expect(d1.outcome).toBe("dispatched")

    // Without resolution: same slot dispatch dedupes
    const d2 = decideAndCommit(ledger, { ...event, sourceEventId: "msg-2" }, policy, () => 2)
    expect(d2.outcome).toBe("deduped")

    // After resolution: same slot dispatch succeeds
    ledger.recordResolution({
      decisionEventId: d1.eventId, decisionDecidedBy: d1.decidedBy,
      resolvedAt: 3, status: "completed", durationMs: 2, resultSummary: null,
    })
    const d3 = decideAndCommit(ledger, { ...event, sourceEventId: "msg-3" }, policy, () => 4)
    expect(d3.outcome).toBe("dispatched")
  })
})
