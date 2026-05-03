import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentDecision, IntentEventInput } from "../types"

// Source adapter — workflow dispatcher. Phase 1 commit 6.c.
//
// One trigger event → at most one workflow run firing. The legacy
// dispatchOne returns `{ claimed: boolean, run: WorkflowRun | null }`.
// We project that into a LegacyOutcome and pass-through to the ledger:
//
//   claimed=true,  run!=null  → "dispatched"   (new or resumed run)
//   claimed=true,  run==null  → "halted"       (forwarded or concurrent-drop)
//   claimed=false             → "halted"       (declined: no trigger, dead, etc.)
//
// The "claimed but no run" case is a legitimate dispatcher state (the
// event was claimed by the workflow even though no node fired here —
// either the home node is remote or a concurrent run owns the event).
// Mapping to "halted" for the ledger means: from the ledger's POV no
// agent was dispatched. The legacy reason captures the nuance for audit.

export interface WorkflowEventProjection {
  workflowId: string
  /** TriggerEvent.id — stable across retries. */
  eventId: string
  triggerSource: string
  /** Optional project axis from the trigger metadata (gitlab project,
   *  etc.). When null, Inv-ActiveTaskSafety doesn't engage — same as the
   *  router. */
  project: string | null
  entityRef: { backend: string; id: string }
}

export interface WorkflowLegacyResult {
  claimed: boolean
  /** Set when the legacy path created or resumed a run. */
  runId: string | null
  /** Optional human-readable reason — preserved verbatim in the divergence
   *  row's legacy_reason column. Helps triage during the soak. */
  reason?: string
}

/** Build the IntentEventInput for one workflow trigger. The
 *  sourceEventId is per-(workflow, trigger event) so re-deliveries
 *  collapse to one event. Subject scopes active-task safety to one
 *  entity per workflow. */
export function buildWorkflowEventInput(
  proj: WorkflowEventProjection,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "workflow",
    sourceEventId: `${proj.workflowId}:${proj.eventId}`,
    project: proj.project,
    subject: `workflow:${proj.workflowId}:entity:${proj.entityRef.backend}:${proj.entityRef.id}`,
    intent: `workflow.${proj.triggerSource}`,
    rawJson,
  }
}

/** Project the workflow's `{ claimed, run }` shape into the LegacyOutcome
 *  the divergence reporter consumes. */
export function workflowResultToLegacyOutcome(result: WorkflowLegacyResult): LegacyOutcome {
  if (result.claimed && result.runId) {
    return {
      agentId: `workflow-run:${result.runId}`,
      outcome: "dispatched",
      reason: result.reason ?? "claimed",
    }
  }
  if (result.claimed && !result.runId) {
    // Forwarded to remote or concurrent-drop — claimed but no local run.
    return {
      agentId: null,
      outcome: "halted",
      reason: result.reason ?? "claimed-but-no-run",
    }
  }
  return {
    agentId: null,
    outcome: "halted",
    reason: result.reason ?? "not-claimed",
  }
}

/** Pass-through policy: ledger decision mirrors legacy outcome.
 *  Divergences come from ledger MECHANICS (idempotency on (source,
 *  sourceEventId), active-task safety on (project, subject)). */
export function buildWorkflowPolicyFromLegacy(legacy: LegacyOutcome): DispatchPolicy {
  return {
    decidedBy: "workflow-dispatcher",
    decide: () => ({
      agentId: legacy.agentId,
      outcome: legacy.outcome === "deduped" ? "halted" : legacy.outcome,
      reason:
        legacy.outcome === "deduped"
          ? `legacy-dedup: ${legacy.reason ?? ""}`.trim()
          : legacy.reason ?? null,
    }),
  }
}

/** Record + report for one (trigger event, legacy result). Caller catches
 *  exceptions — workflow dispatch must continue even if the ledger errors. */
export function recordWorkflowDispatch(
  ledger: IntentLedger,
  proj: WorkflowEventProjection,
  rawJson: string,
  result: WorkflowLegacyResult,
  now: () => number = Date.now,
): IntentDecision {
  const eventInput = buildWorkflowEventInput(proj, rawJson, now)
  const legacyOutcome = workflowResultToLegacyOutcome(result)
  const policy = buildWorkflowPolicyFromLegacy(legacyOutcome)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "workflow", ledgerDecision, legacyOutcome, now)
  return ledgerDecision
}
