import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildGitLabDispatchPolicy,
  buildGitLabTargetEventInput,
  buildNoteDispatchPolicy,
  buildNoteEventInput,
  recordGitLabIssueLevelDecision,
  recordGitLabNoteDispatch,
  recordGitLabTargetDispatch,
  type GitLabEventProjection,
  type GitLabNoteProjection,
  type GitLabTarget,
} from "../src/intent/sources/gitlab"
import { decodeTime } from "../src/intent/ulid"

// Tests for Phase 1 commit 6.a (handleIssue) and 6.a-extended (handleMR).
// The adapter helpers cover both entity kinds; tests below exercise both.

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

const sampleIssue: GitLabEventProjection = {
  entityKind: "issue",
  project: "mtgl/mtgl-system-v2",
  iid: 709,
  action: "open",
  title: "Test issue",
  description: "Hello",
  url: "https://gitlab.example/issues/709",
}

const sampleMR: GitLabEventProjection = {
  entityKind: "merge_request",
  project: "mtgl/mtgl-system-v2",
  iid: 225,
  action: "open",
  title: "Test MR",
  description: "Adds a thing",
  url: "https://gitlab.example/mrs/225",
}

const issueTarget: GitLabTarget = { agentId: "mtgl-v2", trigger: "assignee-added" }
const mrTarget: GitLabTarget = { agentId: "mtgl-v2", trigger: "reviewer-added" }

describe("buildGitLabTargetEventInput", () => {
  it("issue: entity-kind-prefixed sourceEventId + subject", () => {
    const input = buildGitLabTargetEventInput(sampleIssue, issueTarget, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "gitlab",
      sourceEventId: "issue:709:open:mtgl-v2:assignee-added",
      project: "mtgl/mtgl-system-v2",
      subject: "issue:709:agent:mtgl-v2:trigger:assignee-added",
      intent: "issue.open",
      rawJson: "{}",
    })
  })

  it("merge_request: entity-kind-prefixed sourceEventId + subject", () => {
    const input = buildGitLabTargetEventInput(sampleMR, mrTarget, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "gitlab",
      sourceEventId: "merge_request:225:open:mtgl-v2:reviewer-added",
      project: "mtgl/mtgl-system-v2",
      subject: "merge_request:225:agent:mtgl-v2:trigger:reviewer-added",
      intent: "merge_request.open",
      rawJson: "{}",
    })
  })

  it("issue #5 and MR !5 in the same project produce DIFFERENT sourceEventIds — entity-kind prefix prevents collision", () => {
    const issue5 = { ...sampleIssue, iid: 5 }
    const mr5 = { ...sampleMR, iid: 5 }
    const sameTarget: GitLabTarget = { agentId: "x", trigger: "mention" }
    const a = buildGitLabTargetEventInput(issue5, sameTarget, "{}", () => 1)
    const b = buildGitLabTargetEventInput(mr5, sameTarget, "{}", () => 1)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
    expect(a.subject).not.toBe(b.subject)
  })

  it("each (target.agentId × target.trigger) combo gets its own sourceEventId", () => {
    const a = buildGitLabTargetEventInput(sampleIssue, { agentId: "agent-a", trigger: "mention" }, "{}", () => 1)
    const b = buildGitLabTargetEventInput(sampleIssue, { agentId: "agent-b", trigger: "mention" }, "{}", () => 1)
    const c = buildGitLabTargetEventInput(sampleIssue, { agentId: "agent-a", trigger: "default-route" }, "{}", () => 1)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
    expect(a.sourceEventId).not.toBe(c.sourceEventId)
    expect(b.sourceEventId).not.toBe(c.sourceEventId)
  })

  it("subject scopes active-task safety to the per-target slot — different agents on same issue don't block each other", () => {
    const a = buildGitLabTargetEventInput(sampleIssue, { agentId: "agent-a", trigger: "mention" }, "{}", () => 1)
    const b = buildGitLabTargetEventInput(sampleIssue, { agentId: "agent-b", trigger: "mention" }, "{}", () => 1)
    expect(a.subject).not.toBe(b.subject)
  })
})

describe("buildGitLabDispatchPolicy", () => {
  it("issue: decidedBy includes entity kind + trigger", () => {
    expect(buildGitLabDispatchPolicy("issue", { agentId: "x", trigger: "mention" }).decidedBy)
      .toBe("gitlab:issue:target-mention")
    expect(buildGitLabDispatchPolicy("issue", { agentId: "x", trigger: "default-route" }).decidedBy)
      .toBe("gitlab:issue:target-default-route")
  })

  it("merge_request: decidedBy reflects entity kind", () => {
    expect(buildGitLabDispatchPolicy("merge_request", { agentId: "x", trigger: "reviewer-added" }).decidedBy)
      .toBe("gitlab:merge_request:target-reviewer-added")
  })

  it("decide() returns dispatched/agentId — the policy is a thin wrapper around the legacy target choice", () => {
    const policy = buildGitLabDispatchPolicy("issue", issueTarget)
    expect(policy.decide({} as any)).toEqual({
      agentId: "mtgl-v2",
      outcome: "dispatched",
      reason: null,
    })
  })
})

describe("recordGitLabTargetDispatch", () => {
  it("issue: writes event + decision; ULID time-encodes the supplied clock", () => {
    recordGitLabTargetDispatch(
      ledger, sampleIssue, issueTarget, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched" },
      () => 1714400000000,
    )
    const events = ledger.db.prepare("SELECT * FROM intent_events").all() as Array<{ id: string; ts: number }>
    expect(events).toHaveLength(1)
    expect(decodeTime(events[0].id)).toBe(1714400000000)

    const decisions = ledger.db.prepare("SELECT * FROM intent_decisions").all()
    expect(decisions).toHaveLength(1)
  })

  it("merge_request: writes event + decision separately from issue (no collision)", () => {
    // Same iid/agent/trigger across issue + MR → would collide under
    // prefix-less sourceEventId; with the entity-kind prefix they're
    // independent rows.
    recordGitLabTargetDispatch(
      ledger,
      { ...sampleIssue, iid: 100 },
      { agentId: "x", trigger: "mention" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 1,
    )
    recordGitLabTargetDispatch(
      ledger,
      { ...sampleMR, iid: 100 },
      { agentId: "x", trigger: "mention" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 2,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(2)
  })

  it("agreement: ledger=dispatched/mtgl-v2 and legacy=dispatched/mtgl-v2 → no divergence", () => {
    recordGitLabTargetDispatch(
      ledger, sampleIssue, issueTarget, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("disagreement: ledger=dispatched, legacy=deduped → divergence row + log", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    recordGitLabTargetDispatch(
      ledger, sampleIssue, issueTarget, "{}",
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

  it("re-delivery of the same target (same kind, iid, agent, trigger) collapses to one event/decision", () => {
    for (let i = 0; i < 3; i++) {
      recordGitLabTargetDispatch(
        ledger, sampleIssue, issueTarget, "{}",
        { agentId: "mtgl-v2", outcome: "dispatched" },
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

  it("multiple targets on the same MR (assignee + reviewer) → each gets its own event row + decision", () => {
    const targets: GitLabTarget[] = [
      { agentId: "agent-a", trigger: "assignee-added" },
      { agentId: "agent-b", trigger: "reviewer-added" },
      { agentId: "agent-c", trigger: "default-route" },
    ]
    for (const t of targets) {
      recordGitLabTargetDispatch(
        ledger, sampleMR, t, "{}",
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

// ---------------------------------------------------------------------------
// Note (comment) adapter
// ---------------------------------------------------------------------------

const sampleNote: GitLabNoteProjection = {
  noteId: "12345",
  project: "mtgl/mtgl-system-v2",
  noteableType: "issue",
  noteableIid: "709",
  mentions: ["mtgl_v2_bot"],
}

describe("buildNoteEventInput", () => {
  it("normalizes per-noteId sourceEventId; subject scopes per (noteable, note)", () => {
    const input = buildNoteEventInput(sampleNote, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "gitlab",
      sourceEventId: "note:12345",
      project: "mtgl/mtgl-system-v2",
      subject: "issue:709:note:12345",
      intent: "note.issue",
      rawJson: "{}",
    })
  })

  it("merge_request notes: intent flips to note.merge_request", () => {
    const mrNote = { ...sampleNote, noteableType: "merge_request", noteableIid: "225" }
    const input = buildNoteEventInput(mrNote, "{}", () => 1)
    expect(input.intent).toBe("note.merge_request")
    expect(input.subject).toBe("merge_request:225:note:12345")
  })

  it("two notes on the same issue → distinct sourceEventIds + subjects", () => {
    const a = buildNoteEventInput({ ...sampleNote, noteId: "100" }, "{}", () => 1)
    const b = buildNoteEventInput({ ...sampleNote, noteId: "101" }, "{}", () => 1)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
    expect(a.subject).not.toBe(b.subject)
  })
})

describe("buildNoteDispatchPolicy", () => {
  it("decidedBy is the stable string 'gitlab:note:mention'", () => {
    expect(buildNoteDispatchPolicy("agent-x").decidedBy).toBe("gitlab:note:mention")
  })

  it("agentId resolved → dispatched", () => {
    expect(buildNoteDispatchPolicy("mtgl-v2").decide({} as any)).toEqual({
      agentId: "mtgl-v2", outcome: "dispatched", reason: null,
    })
  })

  it("agentId null → halted with explicit reason (the @mentions didn't resolve)", () => {
    expect(buildNoteDispatchPolicy(null).decide({} as any)).toEqual({
      agentId: null, outcome: "halted", reason: "no @mention resolved to an agent",
    })
  })
})

describe("recordGitLabNoteDispatch", () => {
  it("agreement: dispatch/X = dispatch/X → no divergence", () => {
    recordGitLabNoteDispatch(
      ledger, sampleNote, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention:mtgl_v2_bot" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
    expect((ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n).toBe(1)
  })

  it("re-delivery of the same note collapses to one event/decision", () => {
    for (let i = 0; i < 4; i++) {
      recordGitLabNoteDispatch(
        ledger, sampleNote, "{}",
        { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
        () => 1 + i,
      )
    }
    expect((ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n).toBe(1)
    expect((ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n).toBe(1)
  })

  it("legacy halted (no mention resolved) → policy halted → no divergence", () => {
    recordGitLabNoteDispatch(
      ledger, sampleNote, "{}",
      { agentId: null, outcome: "halted", reason: "unresolved-mentions: random_user" },
      () => 1,
    )
    expect(ledger.getDivergences()).toHaveLength(0) // both ledger and legacy halted
  })

  it("two notes on same issue → both dispatch independently (note id is the active-task slot, not issue)", () => {
    recordGitLabNoteDispatch(
      ledger, { ...sampleNote, noteId: "1" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 1,
    )
    recordGitLabNoteDispatch(
      ledger, { ...sampleNote, noteId: "2" }, "{}",
      { agentId: "x", outcome: "dispatched" },
      () => 2,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
    expect((ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Issue-level (no-target) decisions — hook-blocked etc.
// ---------------------------------------------------------------------------

describe("recordGitLabIssueLevelDecision", () => {
  it("hook-blocked: records halted with marker in subject, no target agent", () => {
    recordGitLabIssueLevelDecision(
      ledger, sampleIssue, "hook-blocked", "gitlab:issue:hook", "{}",
      { agentId: null, outcome: "halted", reason: "hook suppressed dispatch" },
      () => 1714400000000,
    )
    const row = ledger.db
      .prepare("SELECT * FROM intent_events ORDER BY ts DESC LIMIT 1")
      .get() as any
    expect(row.subject).toBe("issue:709:hook-blocked")
    expect(row.source_event_id).toBe("issue:709:open:hook-blocked")
    const decisions = ledger.db.prepare("SELECT * FROM intent_decisions").all() as any[]
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe("halted")
    expect(decisions[0].agent_id).toBeNull()
    expect(decisions[0].decided_by).toBe("gitlab:issue:hook")
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("re-delivery of the same hook-blocked event collapses to one row (per-marker idempotency)", () => {
    for (let i = 0; i < 3; i++) {
      recordGitLabIssueLevelDecision(
        ledger, sampleIssue, "hook-blocked", "gitlab:issue:hook", "{}",
        { agentId: null, outcome: "halted", reason: "hook" },
        () => 1 + i,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
  })

  it("issue-level decisions coexist with per-target decisions for the same issue (different sourceEventIds)", () => {
    // hook-blocked on the same issue as a regular target dispatch — should
    // NOT collide because the marker is part of the sourceEventId.
    recordGitLabTargetDispatch(
      ledger, sampleIssue, issueTarget, "{}",
      { agentId: "mtgl-v2", outcome: "dispatched" },
      () => 1,
    )
    recordGitLabIssueLevelDecision(
      ledger, sampleIssue, "hook-blocked", "gitlab:issue:hook", "{}",
      { agentId: null, outcome: "halted", reason: "hook" },
      () => 2,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(2)
  })

  it("legacy 'deduped' maps to halted in policy (PolicyDecision can't say deduped)", () => {
    recordGitLabIssueLevelDecision(
      ledger, sampleIssue, "no-targets", "gitlab:issue:default", "{}",
      { agentId: null, outcome: "deduped", reason: "TTL" },
      () => 1,
    )
    // Ledger decided halted; legacy says deduped → divergence.
    const div = ledger.getDivergences()
    expect(div).toHaveLength(1)
    expect(div[0].ledgerOutcome).toBe("halted")
    expect(div[0].legacyOutcome).toBe("deduped")
  })
})
