import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildWorkflowEventInput,
  buildWorkflowPolicyFromLegacy,
  recordWorkflowDispatch,
  workflowResultToLegacyOutcome,
  type WorkflowEventProjection,
} from "../src/intent/sources/workflow"

// Tests for Phase 1 commit 6.c — workflow dispatcher adapter helpers.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-workflow-adapter-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const sampleProj: WorkflowEventProjection = {
  workflowId: "gitlab-sdlc-loop",
  eventId: "evt-abc",
  triggerSource: "gitlab-issue",
  project: "mtgl/mtgl-system-v2",
  entityRef: { backend: "issue", id: "709" },
}

describe("buildWorkflowEventInput", () => {
  it("normalizes per-(workflow, event) sourceEventId + per-entity subject", () => {
    const input = buildWorkflowEventInput(sampleProj, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "workflow",
      sourceEventId: "gitlab-sdlc-loop:evt-abc",
      project: "mtgl/mtgl-system-v2",
      subject: "workflow:gitlab-sdlc-loop:entity:issue:709", // backend axis comes through
      intent: "workflow.gitlab-issue",
      rawJson: "{}",
    })
  })

  it("project null when trigger had no project axis (router-driven workflows)", () => {
    expect(
      buildWorkflowEventInput({ ...sampleProj, project: null }, "{}", () => 1).project,
    ).toBeNull()
  })

  it("two events on the same (workflow, entity) but different event ids → two events", () => {
    const a = buildWorkflowEventInput({ ...sampleProj, eventId: "e1" }, "{}", () => 1)
    const b = buildWorkflowEventInput({ ...sampleProj, eventId: "e2" }, "{}", () => 2)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
    expect(a.subject).toBe(b.subject) // same entity → same active-task slot
  })
})

describe("workflowResultToLegacyOutcome", () => {
  it("claimed + runId → dispatched/workflow-run:<id>", () => {
    expect(workflowResultToLegacyOutcome({ claimed: true, runId: "run-1" })).toEqual({
      agentId: "workflow-run:run-1",
      outcome: "dispatched",
      reason: "claimed",
    })
  })

  it("claimed + null run → halted (forwarded or concurrent-drop)", () => {
    expect(workflowResultToLegacyOutcome({ claimed: true, runId: null })).toEqual({
      agentId: null,
      outcome: "halted",
      reason: "claimed-but-no-run",
    })
  })

  it("not claimed → halted", () => {
    expect(workflowResultToLegacyOutcome({ claimed: false, runId: null })).toEqual({
      agentId: null,
      outcome: "halted",
      reason: "not-claimed",
    })
  })

  it("custom reason flows through to the LegacyOutcome reason column", () => {
    const outcome = workflowResultToLegacyOutcome({
      claimed: true, runId: null, reason: "concurrent-drop",
    })
    expect(outcome.reason).toBe("concurrent-drop")
  })
})

describe("buildWorkflowPolicyFromLegacy", () => {
  it("decidedBy is the stable string 'workflow-dispatcher'", () => {
    expect(
      buildWorkflowPolicyFromLegacy({ outcome: "dispatched", agentId: "x" }).decidedBy,
    ).toBe("workflow-dispatcher")
  })

  it("dispatched flows through verbatim", () => {
    const policy = buildWorkflowPolicyFromLegacy({
      outcome: "dispatched", agentId: "workflow-run:run-1", reason: "claimed",
    })
    expect(policy.decide({} as any)).toEqual({
      agentId: "workflow-run:run-1",
      outcome: "dispatched",
      reason: "claimed",
    })
  })

  it("legacy 'deduped' projects to halted (PolicyDecision can't be deduped)", () => {
    const policy = buildWorkflowPolicyFromLegacy({
      outcome: "deduped", agentId: null, reason: "stale",
    })
    expect(policy.decide({} as any).outcome).toBe("halted")
    expect(policy.decide({} as any).reason).toBe("legacy-dedup: stale")
  })
})

describe("recordWorkflowDispatch", () => {
  it("records event + decision; agreement → no divergence", () => {
    recordWorkflowDispatch(
      ledger, sampleProj, "{}",
      { claimed: true, runId: "run-1" },
      () => 1,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(1)
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("re-delivery of the same trigger event collapses to one event/decision", () => {
    for (let i = 0; i < 3; i++) {
      recordWorkflowDispatch(
        ledger, sampleProj, "{}",
        { claimed: true, runId: "run-1" },
        () => 1 + i,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(1)
  })

  it("active-task safety engages when project is set: 2nd event same entity → ledger=deduped vs legacy=dispatched → divergence", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    // First event: ledger=dispatched, legacy=dispatched → agreement.
    recordWorkflowDispatch(
      ledger, { ...sampleProj, eventId: "e1" }, "{}",
      { claimed: true, runId: "run-1" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
    // Second event same entity: ledger detects active-task on
    // (project, subject) → ledger=deduped; legacy still dispatched → divergence.
    recordWorkflowDispatch(
      ledger, { ...sampleProj, eventId: "e2" }, "{}",
      { claimed: true, runId: "run-2" },
      () => 2,
    )
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0].ledgerOutcome).toBe("deduped")
    expect(divergences[0].legacyOutcome).toBe("dispatched")
  })

  it("project=null disables active-task safety — two events on same entity both dispatch agreed", () => {
    const projNoProj: WorkflowEventProjection = { ...sampleProj, project: null }
    recordWorkflowDispatch(
      ledger, { ...projNoProj, eventId: "e1" }, "{}",
      { claimed: true, runId: "run-1" },
      () => 1,
    )
    recordWorkflowDispatch(
      ledger, { ...projNoProj, eventId: "e2" }, "{}",
      { claimed: true, runId: "run-2" },
      () => 2,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })
})
