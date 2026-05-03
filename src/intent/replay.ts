import { decideAndCommit, type DispatchPolicy, type PolicyDecision } from "./decide"
import type { IntentLedger } from "./ledger"
import type { IntentDecision, IntentEvent, IntentEventInput, IntentResolution } from "./types"

// Ledger replay — Phase 7 of the architectural rescue.
//
// Given a snapshot of events + decisions from a source ledger, replay
// each event through `decideAndCommit` on a fresh target ledger and
// compare the resulting decisions against what was originally
// recorded.
//
// This validates Inv-Idempotence + Inv-ActiveTaskSafety operationally:
// if 30 days of production traffic replay identically, decideAndCommit
// is deterministic given ledger state (the formal property checked
// statically by Phase 2's TLA+ spec).
//
// Replay is also the foundation for counterfactuals: "if I'd dispatched
// to agent B instead of A at decision row X, what would the rest of
// the ledger look like?" That extension lives in `counterfactual.ts`
// (deferred to a follow-up commit).
//
// **Policy reconstruction.** Replay needs to call `decideAndCommit`,
// which needs a `DispatchPolicy`. Real policies are runtime objects
// keyed by `decidedBy` string; we don't store them. The replay reuses
// the recorded decision as the policy's output — i.e., the
// "playback policy" returns whatever was originally decided. This lets
// the ledger's mechanics (idempotency, active-task safety) re-fire
// independently and surface any divergence in those mechanics, which
// is the exact scope of the regression test.
//
// **What replay does NOT verify.** Real policy disagreement (the policy
// would decide differently today than it did originally) is invisible
// to playback because we feed it the historical answer. Catching
// real policy drift requires re-running the actual policies, which
// the live shadow soak does — that's a complementary signal, not a
// replacement for replay.

export interface ReplayDivergence {
  eventId: string
  decidedBy: string
  expected: { agentId: string | null; outcome: string }
  actual: { agentId: string | null; outcome: string }
  /** Free-form narrative of what diverged. Useful for triage. */
  reason: string
}

export interface ReplayResult {
  /** Number of events replayed. */
  eventsCount: number
  /** Number of decisions replayed (one per (event, decidedBy) pair). */
  decisionsCount: number
  /** Decisions whose replayed outcome did not match the recorded one. */
  divergences: ReplayDivergence[]
  /** Decisions skipped because the recorded `decidedBy` does not exist
   *  on the target ledger's policy registry — useful when replaying a
   *  ledger from a code base that has since dropped a decider. Empty
   *  when not applicable. */
  skipped: ReplayDivergence[]
}

/**
 * Replay a snapshot of (events, decisions, resolutions) onto `target`
 * (which should be empty). Returns an equivalence report.
 *
 * Decisions and resolutions are merged into a single timeline ordered
 * by their original timestamps so the ledger's active-task safety
 * lookup reproduces the original behavior: a resolution that arrived
 * between two decisions in the source will be applied at the same
 * point in the replay, freeing the slot for the second decision the
 * same way it did originally.
 *
 * Resolutions arrive without a separate replay decision (resolutions
 * are unconditional `recordResolution` writes) — they're just
 * forwarded to the target. Decisions are replayed via `decideAndCommit`
 * so the ledger's mechanics (idempotency, active-task safety) re-fire
 * and any divergence in those mechanics surfaces.
 */
export function replay(
  target: IntentLedger,
  events: IntentEvent[],
  decisions: IntentDecision[],
  resolutions: IntentResolution[] = [],
): ReplayResult {
  // Index events by id so playback can find them when iterating decisions.
  const eventById = new Map<string, IntentEvent>()
  for (const e of events) eventById.set(e.id, e)

  // Build a single timeline of decisions + resolutions, sorted by
  // their original timestamp. Same-timestamp ties: decisions before
  // resolutions (a decision recorded at T cannot be resolved before T).
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

  const divergences: ReplayDivergence[] = []
  let decisionsCount = 0

  for (const entry of timeline) {
    if (entry.kind === "resolution") {
      // Resolutions just forward to the target. If the corresponding
      // decision wasn't replayed (skipped because of missing event),
      // the FK in `intent_resolutions` will throw — caught and recorded
      // as a divergence to keep replay non-fatal.
      try {
        target.recordResolution(entry.resolution)
      } catch (e: any) {
        divergences.push({
          eventId: entry.resolution.decisionEventId,
          decidedBy: entry.resolution.decisionDecidedBy,
          expected: { agentId: null, outcome: "resolved" },
          actual: { agentId: null, outcome: "resolution-failed" },
          reason: `recordResolution threw: ${e?.message ?? e}`,
        })
      }
      continue
    }

    const recorded = entry.decision
    const event = eventById.get(recorded.eventId)
    if (!event) {
      // Decision with no matching event in the snapshot — the snapshot
      // is incomplete.
      divergences.push({
        eventId: recorded.eventId,
        decidedBy: recorded.decidedBy,
        expected: { agentId: recorded.agentId, outcome: recorded.outcome },
        actual: { agentId: null, outcome: "skipped" },
        reason: "decision references event not in snapshot",
      })
      continue
    }

    const policy = buildPlaybackPolicy(recorded)
    const eventInput: IntentEventInput = {
      // Preserve the source's event id so resolutions (which reference
      // the original event id) FK-resolve correctly in the target.
      // Without this, recordEvent generates a fresh ULID and the
      // resolution's FK fails.
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
    decisionsCount += 1

    if (
      replayed.outcome !== recorded.outcome ||
      replayed.agentId !== recorded.agentId
    ) {
      divergences.push({
        eventId: event.id,
        decidedBy: recorded.decidedBy,
        expected: { agentId: recorded.agentId, outcome: recorded.outcome },
        actual: { agentId: replayed.agentId, outcome: replayed.outcome },
        reason: classifyDivergence(recorded, replayed),
      })
    }
  }

  return {
    eventsCount: events.length,
    decisionsCount,
    divergences,
    skipped: [],
  }
}

/** Build a "playback policy" that reproduces the recorded decision. The
 *  policy is consulted only when the ledger's mechanics don't force the
 *  outcome (active-task safety can override → "deduped"). When the
 *  recorded outcome is "deduped", the policy returns null because that
 *  outcome is ledger-managed and never produced by a policy. */
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

/** Categorize the kind of replay divergence for triage. Not exhaustive
 *  — operators add new categories by reading the divergence rows. */
function classifyDivergence(
  recorded: IntentDecision,
  replayed: IntentDecision,
): string {
  if (recorded.outcome === "dispatched" && replayed.outcome === "deduped") {
    return "active-task-safety-now-fires (slot held by earlier decision)"
  }
  if (recorded.outcome === "deduped" && replayed.outcome === "halted") {
    return "policy-returned-null (recorded as deduped means the live system" +
      " hit active-task safety; playback policy returned null because" +
      " deduped is illegal at the policy layer — investigate whether the" +
      " in-flight decision is present in the snapshot)"
  }
  if (recorded.agentId !== replayed.agentId) {
    return `agent-changed (recorded=${recorded.agentId} replayed=${replayed.agentId})`
  }
  if (recorded.outcome !== replayed.outcome) {
    return `outcome-changed (recorded=${recorded.outcome} replayed=${replayed.outcome})`
  }
  return "unknown"
}
