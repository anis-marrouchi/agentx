import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentEventInput } from "../types"

// Source adapter — gitlab issue dispatch path. Phase 1 commit 6.a.
//
// One webhook event can produce N target dispatches (mentions, newly-added
// assignees, current assignees, project default route) — see
// `computeIssueTargets` in src/channels/gitlab.ts. The ledger's natural
// unit is "one dispatch consideration", not "one webhook arrival", so each
// target becomes its own ledger event. The synthetic sourceEventId
// `iid:action:agentId:trigger` mirrors the legacy dedup key (minus the
// project namespace which the ledger stores separately) so re-deliveries
// of the same webhook + target combination collapse to one row.
//
// This commit covers the post-`computeIssueTargets` per-target loop only.
// The hook-driven dispatch path (when an `on:gitlab-issue` hook returns
// `modified.dispatch`) is structurally similar but has its own quirks
// (custom prompts, hook-supplied preferNode) and lands in a follow-up.
// `handleMR` and `handleNote` follow the same pattern and will reuse
// these helpers via parallel adapters.

/** Subset of the gitlab issue webhook payload the ledger needs. The
 *  helpers do not consult anything outside this projection — keeps tests
 *  free of full-payload fixtures and decouples the adapter from
 *  `src/channels/gitlab.ts` evolving its private types. */
export interface IssueEventProjection {
  project: string
  iid: number
  action: string
  title: string
  description: string
  url: string
}

/** Per-target shape produced by `computeIssueTargets`. Mirrored here so
 *  this file does not import from `src/channels/gitlab.ts` (preventing a
 *  cycle once the channel imports back from us). */
export interface IssueTarget {
  agentId: string
  trigger: "mention" | "assignee-added" | "assignee-current" | "default-route"
}

/** Build the IntentEventInput for one (issue, target) combination. The
 *  sourceEventId is per-target so each target has its own idempotency
 *  scope. Subject encodes the per-target slot for active-task safety. */
export function buildIssueEventInput(
  event: IssueEventProjection,
  target: IssueTarget,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "gitlab",
    sourceEventId: `${event.iid}:${event.action}:${target.agentId}:${target.trigger}`,
    project: event.project,
    subject: `issue:${event.iid}:agent:${target.agentId}:trigger:${target.trigger}`,
    intent: `issue.${event.action}`,
    rawJson,
  }
}

/** Build the per-target DispatchPolicy. The policy is "I would dispatch
 *  to this target" — `computeIssueTargets` already decided the agentId,
 *  so the ledger's policy is a thin wrapper that records that fact. */
export function buildIssueDispatchPolicy(target: IssueTarget): DispatchPolicy {
  return {
    decidedBy: `gitlab:issue:target-${target.trigger}`,
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
export function recordIssueTargetDispatch(
  ledger: IntentLedger,
  event: IssueEventProjection,
  target: IssueTarget,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): void {
  const eventInput = buildIssueEventInput(event, target, rawJson, now)
  const policy = buildIssueDispatchPolicy(target)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "gitlab", ledgerDecision, legacyOutcome, now)
}
