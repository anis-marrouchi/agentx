import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentEventInput } from "../types"

// Source adapter — cron scheduler. Phase 1 commit 6.d.
//
// Cron is the cleanest 1:1 dispatch source: one fire → one agent. The
// scheduler's `executeJob(jobId)` is the dispatch entry point. We
// instrument the two decision branches (hook-blocked vs hook-approved)
// and pass the legacy outcome to a pass-through policy.

export interface CronJobProjection {
  jobId: string
  agentId: string
  /** When the job fired (used as part of the ULID-friendly sourceEventId). */
  firedAt: Date
}

/** Build the IntentEventInput for one cron fire. sourceEventId is
 *  per-(jobId, firedAt) so concurrent re-fires (shouldn't happen but)
 *  collapse via idempotency. Subject scopes active-task safety to one
 *  fire-in-flight per job — but project=null disables Inv-ActiveTaskSafety,
 *  so successive fires of the same job both dispatch (matches legacy). */
export function buildCronEventInput(
  proj: CronJobProjection,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "cron",
    sourceEventId: `${proj.jobId}:${proj.firedAt.getTime()}`,
    project: null,
    subject: `cron:${proj.jobId}`,
    intent: "cron.fired",
    rawJson,
  }
}

/** Pass-through policy. Same shape as router/workflow: divergences come
 *  from ledger MECHANICS, not policy disagreement. */
export function buildCronPolicyFromLegacy(legacy: LegacyOutcome): DispatchPolicy {
  return {
    decidedBy: "cron-scheduler",
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

export function recordCronDispatch(
  ledger: IntentLedger,
  proj: CronJobProjection,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): void {
  const eventInput = buildCronEventInput(proj, rawJson, now)
  const policy = buildCronPolicyFromLegacy(legacyOutcome)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "cron", ledgerDecision, legacyOutcome, now)
}
