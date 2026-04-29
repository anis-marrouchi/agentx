import type { IntentLedger } from "./ledger"
import type { IntentDecision, IntentEventInput, IntentEvent } from "./types"

// decideAndCommit — Phase 1 of the architectural rescue.
//
// The single function every dispatch source will route through. Every event
// entering the system flows: source-adapter → decideAndCommit → (optional
// agent dispatch). The function's job is to:
//
//   1. Record the event idempotently (Inv-Idempotence)
//   2. Consult the ledger for active-task state (Inv-ActiveTaskSafety)
//   3. Ask the policy for a tentative decision
//   4. Commit a single decision row to the ledger (Inv-NoSilentDrops)
//
// The four invariants are spelled out below and named so that Phase 2's
// TLA+ spec can reference them by string. Tests in test/intent-decide.test.ts
// cite these names in their assertion comments.
//
//   Inv-Idempotence       calling decideAndCommit twice with the same
//                         (source, sourceEventId) and the same policy
//                         produces one event row + one decision row;
//                         the second call returns the row from the first.
//   Inv-Determinism       given a fixed ledger snapshot, a fixed policy,
//                         and a fixed clock, the resulting decision is a
//                         pure function of the input event.
//   Inv-ActiveTaskSafety  at most one decision with outcome=dispatched
//                         that has not yet been resolved exists for any
//                         (project, subject) at any point in the ledger.
//   Inv-NoSilentDrops     every call to decideAndCommit appends exactly
//                         one decision row to the ledger (or returns an
//                         existing one under Inv-Idempotence). No code
//                         path returns without a row visible in the ledger.
//
// What this commit does NOT do:
//   - Wire decideAndCommit into any real call site (commit 6).
//   - Add the mode flag (commit 4) — this function is reachable only from
//     tests until commit 6 wires it up behind a flag that defaults off.
//   - Read or expose the divergence reporter (commit 5).
//   - Run async or call out to network. Policies are sync; if a real call
//     site needs an LLM in the loop, that's a refactor for a later phase.

/**
 * A pluggable dispatch policy. Each call site (channel router, workflow
 * dispatcher, gitlab handler, cron firing, mesh receiver) supplies its own
 * policy — the function below is purely the orchestration around the
 * policy's decision.
 *
 * The policy's `decidedBy` is the ledger's attribution string ("who decided
 * this?") and is what the ledger uses to scope idempotency: re-delivery of
 * the same event to the same `decidedBy` returns the existing row, while
 * the same event reaching a different `decidedBy` is a separate decision
 * (the chain-of-command case).
 */
export interface DispatchPolicy {
  /** Stable attribution string. Examples: `"channel-router"`,
   *  `"workflow:gitlab-sdlc-loop"`, `"gitlab-handler"`. Must be stable
   *  across calls — the ledger uses it as the per-policy idempotency key. */
  readonly decidedBy: string

  /**
   * Inspect the (already-recorded) event and return a tentative decision.
   * Return `null` to mean "I have no opinion" — the caller will record a
   * `halted` decision with reason `"no policy match"`.
   *
   * The policy MUST NOT write to the ledger directly. It MUST be a pure
   * function of `event` plus any read-only context the caller closed over
   * when constructing the policy. (Determinism — Inv-Determinism — depends
   * on this.)
   */
  decide(event: IntentEvent): PolicyDecision | null
}

/** What a policy returns. The `outcome` set excludes `"deduped"` because
 *  dedup is the ledger's call, not the policy's. */
export interface PolicyDecision {
  agentId: string | null
  outcome: "dispatched" | "halted" | "queued"
  reason: string | null
}

/**
 * Append-only dispatch primitive. Returns the canonical decision row —
 * either freshly written or recovered from a prior call (Inv-Idempotence).
 *
 * The whole call runs inside a single SQLite transaction so the lookup
 * (`getDecisionsForEvent` + `getActiveDecisionForSubject`) and the write
 * (`recordDecision`) are atomic with respect to the same database. This
 * matters under concurrent-call scenarios; in the single-process daemon
 * use case, better-sqlite3 already serialises writes so the transaction
 * is belt-and-braces. Adding it now means the call-site wiring (commit 6)
 * can call decideAndCommit from anywhere without worrying about races.
 */
export function decideAndCommit(
  ledger: IntentLedger,
  input: IntentEventInput,
  policy: DispatchPolicy,
  now: () => number = Date.now,
): IntentDecision {
  const tx = ledger.db.transaction((decidedAt: number): IntentDecision => {
    // Step 1 — record the event. recordEvent is itself idempotent on
    // (source, sourceEventId), so this is safe under re-delivery.
    const event = ledger.recordEvent(input)

    // Step 2 — Inv-Idempotence. If this policy has already decided on this
    // event, return that decision unchanged. Two callers who race the same
    // event-policy pair are reduced to a single decision row.
    const prior = ledger
      .getDecisionsForEvent(event.id)
      .find((d) => d.decidedBy === policy.decidedBy)
    if (prior) return prior

    // Step 3 — Inv-ActiveTaskSafety. If a dispatched-and-unresolved
    // decision already exists for (project, subject), this event must
    // dedupe. The dedup outcome is ledger-managed; the policy never sees
    // a chance to override it.
    const active = ledger.getActiveDecisionForSubject(event.project, event.subject)
    if (active) {
      const decision: IntentDecision = {
        eventId: event.id,
        decidedAt,
        decidedBy: policy.decidedBy,
        agentId: null,
        outcome: "deduped",
        reason: `active dispatch in flight: ${active.decidedBy} → ${active.agentId ?? "?"}`,
      }
      ledger.recordDecision(decision)
      return decision
    }

    // Step 4 — consult the policy. A null result is a halt with explicit
    // reason rather than a silent drop (Inv-NoSilentDrops). A halted /
    // queued / dispatched policy decision flows through unchanged.
    const policyResult = policy.decide(event)
    const decision: IntentDecision = policyResult
      ? {
          eventId: event.id,
          decidedAt,
          decidedBy: policy.decidedBy,
          agentId: policyResult.agentId,
          outcome: policyResult.outcome,
          reason: policyResult.reason,
        }
      : {
          eventId: event.id,
          decidedAt,
          decidedBy: policy.decidedBy,
          agentId: null,
          outcome: "halted",
          reason: "no policy match",
        }
    ledger.recordDecision(decision)
    return decision
  })

  return tx(now())
}
