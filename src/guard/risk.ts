import { askSeat } from "@/decisions/seat"
import {
  GUARD_RISK_SEAT,
  guardRiskQuestions,
  guardRiskState,
  shouldAskForConfirmation,
  type GuardRiskAnswers,
} from "@/decisions/seats/guard-risk"
import { classifyMutation } from "./mutating"
import type { GuardInput, Verdict } from "./types"

// --- The second opinion, and the ratchet that keeps it safe ---
//
// Deterministic rules decide what runs without asking. This layer may only
// REMOVE operations from that set. It is expressed as a ratchet so the
// property is visible in the code rather than promised in a comment:
//
//   deny      -> deny        (never consulted; nothing to gain)
//   ask       -> ask         (already asking)
//   allow     -> ask         (only transition this layer can cause)
//
// There is no path from anything to allow. A model that is broken,
// compromised, rate-limited or simply wrong can cost you a dialog. It
// cannot cost you data.
//
// FAIL CLOSED. askSeat is fail-open by contract — it returns null on every
// error, because a decision seat must never break the call site it was
// bolted onto. A guard inverts that: for an operation the deterministic
// classifier already called destructive, "I don't know" is not "go ahead".
// null therefore escalates, which is the opposite of what askSeat's own
// contract would suggest and is the single most important line here.

export interface RiskAssessment {
  /** True when the caller must obtain confirmation before running. */
  requiresConfirmation: boolean
  /** Why, in one line, for the dialog and the audit row. */
  reason: string | null
  /** Whether the deterministic classifier considered this destructive. */
  mutating: boolean
  /** How the decision was reached — for auditing which layer fired. */
  source: "rules" | "classifier+seat" | "seat-unavailable" | "not-mutating"
}

/**
 * Decide whether this operation needs a human click.
 *
 * Never throws: any failure resolves to requiresConfirmation=true for a
 * mutating operation, and false for one the classifier did not flag.
 */
export async function assessRisk(input: GuardInput, verdict: Verdict): Promise<RiskAssessment> {
  // The rules already decided. Nothing here can soften that, and asking
  // the model would only spend a call to be ignored.
  if (verdict.effectiveAction === "deny" || verdict.effectiveAction === "ask") {
    return {
      requiresConfirmation: verdict.effectiveAction === "ask",
      reason: verdict.message ?? verdict.ruleId ?? "matched guardrail policy",
      mutating: true,
      source: "rules",
    }
  }

  const mutation = classifyMutation(input)
  if (!mutation.mutating) {
    // Read-only work is the overwhelming majority of what an agent does.
    // It never reaches the model, so the guard costs nothing on the hot
    // path and cannot be slowed down by an unreachable API.
    return { requiresConfirmation: false, reason: null, mutating: false, source: "not-mutating" }
  }

  let answers: GuardRiskAnswers | null = null
  try {
    const result = await askSeat(
      GUARD_RISK_SEAT,
      guardRiskState({
        tool: input.tool,
        command: input.command ?? "",
        filePath: input.filePath ?? null,
        resolvedTarget: verdict.resolvedTarget,
        agentId: input.agentId ?? null,
        cwd: input.cwd ?? null,
      }),
      guardRiskQuestions,
      {
        // A guard cannot wait on a model. Past this, treat it as unknown
        // and escalate — an agent blocked for 8 seconds on every rm is a
        // guard people will switch off.
        timeoutMs: 8_000,
        incumbent: { destroys: "unknown", production: "unknown" },
        features: { agent: input.agentId ?? "unknown", tool: input.tool },
      },
    )
    // Shadow mode records without acting, so it must not gate. An operator
    // soaking this seat has not yet agreed to be interrupted by it.
    if (result && result.mode === "active") answers = result.answers as GuardRiskAnswers
    else if (result) {
      return {
        requiresConfirmation: false,
        reason: null,
        mutating: true,
        source: "classifier+seat",
      }
    }
  } catch {
    answers = null
  }

  if (!answers) {
    // The line that matters. Unknown risk on a destructive command asks.
    return {
      requiresConfirmation: true,
      reason: `${mutation.reason} — risk check unavailable, asking to be safe`,
      mutating: true,
      source: "seat-unavailable",
    }
  }

  const ask = shouldAskForConfirmation(answers)
  return {
    requiresConfirmation: ask,
    reason: ask ? mutation.reason : null,
    mutating: true,
    source: "classifier+seat",
  }
}
