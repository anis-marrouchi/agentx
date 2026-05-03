import { decideAndCommit, type DispatchPolicy, type PolicyDecision } from "./decide"
import { IntentLedger } from "./ledger"
import type { IntentDecision, IntentEvent, IntentEventInput, IntentResolution } from "./types"

// Counterfactual replay — Phase 7 of the architectural rescue.
//
// Builds on src/intent/replay.ts. Given a snapshot + a "modification"
// targeting one decision, replay everything onto a fresh ledger but
// substitute the modified decision at the right moment, and observe
// how the rest of the ledger diverges.
//
// Use cases:
//
//   1. Post-incident analysis. "If decision row D had dispatched to
//      agent B instead of agent A, what other dispatches would have
//      changed?" — enumerate the cascade.
//   2. Pre-promotion validation for 1c. "If we promote source X to
//      authoritative now, what dispatches would the ledger override?"
//      — by faking the ledger's would-be decisions and replaying.
//   3. What-if for org-chart changes (Phase 3). Once PM gates exist,
//      "if PM had blocked this, what cascade would have happened?"
//
// Deliberate scope limit: counterfactuals only modify ONE decision at
// a time. Reasoning over multi-edit chains is exponential and rarely
// what an operator actually wants — it's almost always "this single
// decision was wrong, show me the consequences."

/** A single-decision modification. The (eventId, decidedBy) pair
 *  identifies the source row to replace. The replacement values
 *  (`agentId`, `outcome`, `reason`) become the policy's output during
 *  the replay; the ledger's mechanics still apply (active-task safety
 *  may still force "deduped"). */
export interface DecisionModification {
  eventId: string
  decidedBy: string
  /** New agent — null becomes the policy's agentId. */
  agentId: string | null
  /** New outcome. Must be a PolicyDecision outcome (no "deduped",
   *  which is ledger-managed). */
  outcome: PolicyDecision["outcome"]
  /** Optional new reason. Defaults to a synthetic
   *  `"counterfactual: ..."` annotation if omitted. */
  reason?: string | null
}

export interface CounterfactualResult {
  /** The replayed ledger — caller owns close(). */
  target: IntentLedger
  /** Decisions in the target that differ from the source. Includes
   *  the explicitly-modified decision AS WELL AS any cascade effects
   *  (a decision that was deduped in source but not in the
   *  counterfactual, etc.). */
  cascade: Array<{
    eventId: string
    decidedBy: string
    sourceOutcome: string
    sourceAgent: string | null
    newOutcome: string
    newAgent: string | null
    /** True for the explicitly-modified decision; false for cascaded
     *  consequences. */
    isModification: boolean
  }>
}

/**
 * Replay onto `target` (which should be empty), substituting the
 * specified modification. Returns the cascade — every decision whose
 * outcome differs from the source ledger's recorded value.
 */
export function counterfactual(
  target: IntentLedger,
  events: IntentEvent[],
  decisions: IntentDecision[],
  resolutions: IntentResolution[],
  modification: DecisionModification,
): CounterfactualResult {
  const eventById = new Map<string, IntentEvent>()
  for (const e of events) eventById.set(e.id, e)

  const sourceDecisionByKey = new Map<string, IntentDecision>()
  for (const d of decisions) {
    sourceDecisionByKey.set(`${d.eventId}|${d.decidedBy}`, d)
  }

  // Confirm the modification target exists.
  const targetKey = `${modification.eventId}|${modification.decidedBy}`
  if (!sourceDecisionByKey.has(targetKey)) {
    throw new Error(
      `counterfactual: source has no decision for (${modification.eventId}, ${modification.decidedBy})`,
    )
  }

  // Same timeline merge as replay.
  type Entry =
    | { kind: "decision"; ts: number; decision: IntentDecision }
    | { kind: "resolution"; ts: number; resolution: IntentResolution }
  const timeline: Entry[] = []
  for (const d of decisions) timeline.push({ kind: "decision", ts: d.decidedAt, decision: d })
  for (const r of resolutions) timeline.push({ kind: "resolution", ts: r.resolvedAt, resolution: r })
  timeline.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    if (a.kind === b.kind) return 0
    return a.kind === "decision" ? -1 : 1
  })

  const cascade: CounterfactualResult["cascade"] = []

  for (const entry of timeline) {
    if (entry.kind === "resolution") {
      try {
        target.recordResolution(entry.resolution)
      } catch {
        // Defensive — the FK on intent_resolutions(event_id, decided_by)
        // is satisfied for any decision row regardless of outcome, so
        // this catch shouldn't fire under normal counterfactual edits.
        // Kept as a safety net; the cascade row already records the
        // semantic divergence so silently dropping is acceptable.
      }
      continue
    }

    const recorded = entry.decision
    const event = eventById.get(recorded.eventId)
    if (!event) continue

    const isModification =
      recorded.eventId === modification.eventId &&
      recorded.decidedBy === modification.decidedBy

    const policy = isModification
      ? buildModifiedPolicy(modification)
      : buildPlaybackPolicy(recorded)

    const eventInput: IntentEventInput = {
      id: event.id,
      ts: event.ts,
      source: event.source,
      sourceEventId: event.sourceEventId,
      project: event.project,
      subject: event.subject,
      intent: event.intent,
      rawJson: event.rawJson,
    }

    const replayed = decideAndCommit(target, eventInput, policy, () => recorded.decidedAt)

    if (
      replayed.outcome !== recorded.outcome ||
      replayed.agentId !== recorded.agentId
    ) {
      cascade.push({
        eventId: event.id,
        decidedBy: recorded.decidedBy,
        sourceOutcome: recorded.outcome,
        sourceAgent: recorded.agentId,
        newOutcome: replayed.outcome,
        newAgent: replayed.agentId,
        isModification,
      })
    }
  }

  return { target, cascade }
}

function buildPlaybackPolicy(recorded: IntentDecision): DispatchPolicy {
  return {
    decidedBy: recorded.decidedBy,
    decide: (): PolicyDecision | null => {
      if (recorded.outcome === "deduped") return null
      return {
        agentId: recorded.agentId,
        outcome: recorded.outcome as PolicyDecision["outcome"],
        reason: recorded.reason,
      }
    },
  }
}

function buildModifiedPolicy(mod: DecisionModification): DispatchPolicy {
  return {
    decidedBy: mod.decidedBy,
    decide: (): PolicyDecision => ({
      agentId: mod.agentId,
      outcome: mod.outcome,
      reason: mod.reason ?? `counterfactual: substituted ${mod.outcome}/${mod.agentId ?? "-"}`,
    }),
  }
}
