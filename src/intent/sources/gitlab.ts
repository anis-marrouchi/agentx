import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentDecision, IntentEventInput } from "../types"

// Source adapter — gitlab issue + merge_request dispatch paths. Phase 1
// commits 6.a (handleIssue) and 6.a-extended (handleMR).
//
// One webhook event can produce N target dispatches (mentions, assignees,
// reviewers, project default route). The ledger's natural unit is "one
// dispatch consideration", not "one webhook arrival", so each target
// becomes its own ledger event. The synthetic sourceEventId
// `${entityKind}:${iid}:${action}:${agentId}:${trigger}` mirrors the
// legacy dedup key, with the entity-kind prefix preventing collision
// between an issue #5 and an MR !5 in the same project.
//
// `handleNote` (comments) is a different shape — its targets come from
// @mention parsing of the note body — and lands in its own commit.

export type GitLabEntityKind = "issue" | "merge_request"

/** Subset of the gitlab webhook payload the ledger needs. The helpers
 *  do not consult anything outside this projection — keeps tests free
 *  of full-payload fixtures and decouples the adapter from
 *  `src/channels/gitlab.ts` evolving its private types. */
export interface GitLabEventProjection {
  entityKind: GitLabEntityKind
  project: string
  iid: number
  action: string
  title: string
  description: string
  url: string
}

/** Per-target shape produced by `computeIssueTargets` /
 *  `computeMRTargets`. The trigger is free-form `string` so MR-specific
 *  triggers (`reviewer-added`, `reviewer-current`) flow through without
 *  needing a discriminated union. The trigger is part of the per-target
 *  dedup key — it's the dispatch reason and it's expected to be a
 *  small fixed set per entity kind. */
export interface GitLabTarget {
  agentId: string
  trigger: string
}

/** Build the IntentEventInput for one (gitlab event, target) combination.
 *  Per-target sourceEventId for idempotency scope; per-target subject so
 *  Inv-ActiveTaskSafety scopes per (issue|MR, agent, trigger). */
export function buildGitLabTargetEventInput(
  event: GitLabEventProjection,
  target: GitLabTarget,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "gitlab",
    sourceEventId: `${event.entityKind}:${event.iid}:${event.action}:${target.agentId}:${target.trigger}`,
    project: event.project,
    subject: `${event.entityKind}:${event.iid}:agent:${target.agentId}:trigger:${target.trigger}`,
    intent: `${event.entityKind}.${event.action}`,
    rawJson,
  }
}

/** Build the per-target DispatchPolicy. `computeIssueTargets` /
 *  `computeMRTargets` already chose the agentId; the ledger's policy is
 *  a thin wrapper that records that fact. The decidedBy preserves the
 *  entity-kind + trigger so chain readouts identify the source path. */
export function buildGitLabDispatchPolicy(
  entityKind: GitLabEntityKind,
  target: GitLabTarget,
): DispatchPolicy {
  return {
    decidedBy: `gitlab:${entityKind}:target-${target.trigger}`,
    decide: () => ({
      agentId: target.agentId,
      outcome: "dispatched",
      reason: null,
    }),
  }
}

/**
 * Convenience wrapper: record + report for one (event, target). Caller
 * computes the legacy outcome (typically "dispatched" when fresh and
 * "deduped" when `isDispatchedRecently` short-circuited the legacy
 * dispatch) and supplies it; the helper handles the rest.
 *
 * The caller is responsible for catching exceptions — the gitlab handler
 * must continue dispatching legacy-style even if the ledger errors.
 */
export function recordGitLabTargetDispatch(
  ledger: IntentLedger,
  event: GitLabEventProjection,
  target: GitLabTarget,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): IntentDecision {
  const eventInput = buildGitLabTargetEventInput(event, target, rawJson, now)
  const policy = buildGitLabDispatchPolicy(event.entityKind, target)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "gitlab", ledgerDecision, legacyOutcome, now)
  return ledgerDecision
}

// ---------------------------------------------------------------------------
// Note (comment) dispatch
// ---------------------------------------------------------------------------
//
// Notes are 1:1 (one comment → one resolved agent from the @mention).
// Different shape from issue/MR per-target dispatch: the trigger is
// always "@mention" and the agent comes from `resolveAgentFromMention`,
// not from a target-set producer. handleNote in src/channels/gitlab.ts
// has many cascade-prevention early-return paths (sourceAgent loops,
// sentNoteIds dedup, no-mention, bot users without signature). Those
// are operational guards rather than dispatch decisions — they do NOT
// reach the ledger. Only the two real decision points are instrumented:
//
//   match              → dispatched / resolved agent
//   mention-no-resolve → halted (the @mentioned name doesn't map to an agent)

export interface GitLabNoteProjection {
  /** GitLab's stable note id — unique across the whole instance. */
  noteId: string
  project: string
  /** "issue" or "merge_request" — the noteable the comment was on. */
  noteableType: string
  noteableIid: string
  /** The @mentions parsed out of the note body, deduped + lowercased.
   *  Carried for forensic value in `intent` / `rawJson`; not load-
   *  bearing for the dispatch decision (the resolved agent already
   *  encodes the choice). */
  mentions: string[]
}

export function buildNoteEventInput(
  proj: GitLabNoteProjection,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "gitlab",
    sourceEventId: `note:${proj.noteId}`,
    project: proj.project,
    subject: `${proj.noteableType}:${proj.noteableIid}:note:${proj.noteId}`,
    intent: `note.${proj.noteableType}`,
    rawJson,
  }
}

export function buildNoteDispatchPolicy(legacyAgentId: string | null): DispatchPolicy {
  return {
    decidedBy: "gitlab:note:mention",
    decide: () => ({
      agentId: legacyAgentId,
      outcome: legacyAgentId ? "dispatched" : "halted",
      reason: legacyAgentId ? null : "no @mention resolved to an agent",
    }),
  }
}

/** Record + report for one note dispatch decision. */
export function recordGitLabNoteDispatch(
  ledger: IntentLedger,
  proj: GitLabNoteProjection,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): IntentDecision {
  const eventInput = buildNoteEventInput(proj, rawJson, now)
  const policy = buildNoteDispatchPolicy(legacyOutcome.agentId)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "gitlab", ledgerDecision, legacyOutcome, now)
  return ledgerDecision
}

// ---------------------------------------------------------------------------
// Issue/MR level (no-target) decisions
// ---------------------------------------------------------------------------
//
// Some dispatch decisions don't correspond to a specific target — the
// `on:gitlab-issue` hook can return `blocked: true` to suppress all
// default dispatch, for example. The decision is "we considered this
// event and chose to dispatch nothing", which is still a real dispatch
// decision the ledger should track.

/** Record + report for an issue/MR-level decision (no specific target).
 *  `marker` distinguishes the decision sub-type ("hook-blocked",
 *  "no-targets", etc.) and is part of the sourceEventId + subject so
 *  multiple issue-level decisions on the same event can coexist. */
export function recordGitLabIssueLevelDecision(
  ledger: IntentLedger,
  event: GitLabEventProjection,
  marker: string,
  decidedBy: string,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): IntentDecision {
  const eventInput: IntentEventInput = {
    ts: now(),
    source: "gitlab",
    sourceEventId: `${event.entityKind}:${event.iid}:${event.action}:${marker}`,
    project: event.project,
    subject: `${event.entityKind}:${event.iid}:${marker}`,
    intent: `${event.entityKind}.${event.action}`,
    rawJson,
  }
  const policy: DispatchPolicy = {
    decidedBy,
    decide: () => ({
      agentId: legacyOutcome.agentId,
      outcome: legacyOutcome.outcome === "deduped" ? "halted" : legacyOutcome.outcome,
      reason: legacyOutcome.outcome === "deduped"
        ? `legacy-dedup: ${legacyOutcome.reason ?? ""}`.trim()
        : legacyOutcome.reason ?? null,
    }),
  }
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "gitlab", ledgerDecision, legacyOutcome, now)
  return ledgerDecision
}
