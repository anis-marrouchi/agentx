import { logger } from "../utils/logger"
import type { IntentLedger } from "./ledger"
import { newEventId } from "./ulid"
import type {
  IntentDecision,
  IntentDivergence,
  IntentOutcomeKind,
  IntentSource,
} from "./types"

// Divergence reporter — Phase 1 commit 5 of the architectural rescue.
//
// During shadow mode (1b in research-rescue-plan.md §7), every dispatch
// runs through both the legacy path and decideAndCommit. The legacy path
// remains authoritative; the ledger's decision is recorded but does not
// drive behaviour. The reporter compares the two and:
//
//   - on agreement: no-op (the soak's success criterion is "zero
//     divergences for ≥7 days" — quiet operation IS the signal).
//   - on mismatch: log a structured warning AND write a row to
//     intent_divergences so the soak dashboard has a queryable surface.
//
// The shape of "the legacy outcome" is deliberately structural rather
// than tied to any one source's existing output type — that lets the
// commit-6 wiring adapt each call site (channel-router's `Routed`, the
// workflow dispatcher's `DispatchResult`, etc.) into a common
// LegacyOutcome at the comparison boundary instead of carrying source-
// specific shapes through the reporter.

/** Minimal projection of a legacy dispatch path's outcome — only the
 *  fields we compare against the ledger decision. */
export interface LegacyOutcome {
  agentId: string | null
  outcome: IntentOutcomeKind
  /** Optional human-readable reason; recorded for forensics, never
   *  compared. (Legacy reasons and ledger reasons phrase the same
   *  decision differently — comparing them would produce noise.) */
  reason?: string | null
}

/**
 * Compare a ledger decision against the legacy path's outcome. On mismatch,
 * append a divergence row and emit a `[ledger-divergence]` log line.
 * Returns `true` when a divergence was recorded, `false` on agreement.
 *
 * Comparison is structural on the load-bearing fields: `outcome` and
 * `agentId`. `reason` strings differ harmlessly between paths and are
 * forensic-only — comparing them would produce noise that drowns out
 * the actual semantic mismatches we care about.
 */
export function reportDivergence(
  ledger: IntentLedger,
  source: IntentSource,
  ledgerDecision: IntentDecision,
  legacy: LegacyOutcome,
  now: () => number = Date.now,
): boolean {
  if (decisionsAgree(ledgerDecision, legacy)) return false

  const ts = now()
  const record: IntentDivergence = {
    id: newEventId(ts),
    ts,
    source,
    eventId: ledgerDecision.eventId,
    decidedBy: ledgerDecision.decidedBy,
    ledgerAgentId: ledgerDecision.agentId,
    ledgerOutcome: ledgerDecision.outcome,
    ledgerReason: ledgerDecision.reason,
    legacyAgentId: legacy.agentId,
    legacyOutcome: legacy.outcome,
    legacyReason: legacy.reason ?? null,
  }
  ledger.recordDivergence(record)

  // Single-line structured log so journalctl + grep are sufficient triage
  // tools during the soak (commit 8 adds a UI; until then, journal is it).
  logger.warn(
    `[ledger-divergence] source=${source} ` +
      `event=${ledgerDecision.eventId} ` +
      `decided_by=${ledgerDecision.decidedBy} ` +
      `ledger=${ledgerDecision.outcome}/${ledgerDecision.agentId ?? "null"} ` +
      `legacy=${legacy.outcome}/${legacy.agentId ?? "null"}`,
  )
  return true
}

/** Two outcomes agree iff they pick the same target with the same outcome
 *  kind. Reasons (free-form) are not part of agreement.
 *
 *  AgentIds that wrap a fresh-per-call instance id (workflow-run:<uuid>,
 *  mesh-fwd:<id>) are normalized to the prefix before comparison — both
 *  paths legitimately dispatch the same kind of work but with different
 *  instance handles, and treating those as divergences buries the real
 *  semantic mismatches in noise (Phase 1 soak finding: ~290 false
 *  positives across both nodes pre-fix). */
export function decisionsAgree(
  ledgerDecision: IntentDecision,
  legacy: LegacyOutcome,
): boolean {
  return (
    ledgerDecision.outcome === legacy.outcome &&
    normalizeSyntheticAgentId(ledgerDecision.agentId) === normalizeSyntheticAgentId(legacy.agentId)
  )
}

function normalizeSyntheticAgentId(id: string | null): string | null {
  if (!id) return null
  const m = id.match(/^(workflow-run|mesh-fwd):/)
  return m ? `${m[1]}:*` : id
}
