import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentEventInput } from "../types"

// Source adapter — channel-router (telegram only). Phase 1 commit 6.b.
//
// The router is a 1:1 dispatch source: one IncomingMessage → one routing
// decision (drop, deduped, or dispatched-to-one-agent). The legacy path
// makes the decision; the ledger records it alongside via a pass-through
// policy. Divergences during shadow soak come from ledger MECHANICS
// (idempotency on re-delivery, active-task safety on chat) rather than
// from policy disagreement — that's the soak's intended signal.
//
// **Channel coverage.** This commit only handles telegram messages.
// Slack, whatsapp, and other channels also pass through the router but
// are not yet in the `IntentSource` enum; the call site at
// src/channels/router.ts:handleMessage gates on msg.channel before
// invoking this adapter, so non-telegram channels short-circuit out.
// Adding them is a small extension to types.ts + a new branch here.

/** Subset of IncomingMessage the adapter consumes. Local projection so
 *  this file does not import from src/channels/types.ts and decouples
 *  the adapter from that type's evolution. */
export interface RouterMessageProjection {
  id: string
  channel: string
  accountId?: string
  sender: { id: string }
  group?: { id: string }
  replyTo?: string
}

/**
 * Build the IntentEventInput for one telegram message. The sourceEventId
 * is `accountId/msgId` so re-deliveries from the same telegram bot's view
 * collapse to one event. Subject scopes active-task safety to the chat
 * (group id when present, else sender id — mirroring the legacy chatId
 * derivation in router.ts).
 */
export function buildRouterEventInput(
  msg: RouterMessageProjection,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  const accountId = msg.accountId || "default"
  const chatId = msg.group?.id || msg.sender.id
  return {
    ts: now(),
    source: "telegram",
    sourceEventId: `${accountId}/${msg.id}`,
    project: null, // router has no project axis
    subject: `chat:${chatId}`,
    intent: msg.replyTo ? "message.reply" : "message.received",
    rawJson,
  }
}

/**
 * Pass-through policy: the policy reports whatever the legacy path decided.
 * In shadow mode this means agreement-by-construction at the policy level;
 * divergences arise solely from the ledger's idempotency + active-task
 * safety machinery seeing things the legacy LRU dedup didn't.
 *
 * `outcome === "deduped"` is illegal at the PolicyDecision layer (the
 * ledger owns dedup as a structural concept), so we project legacy
 * dedups to `halted` with a reason that flags them. The legacy outcome
 * passed to reportDivergence keeps the original "deduped", so the
 * divergence row's legacy column still says "deduped" — no information
 * loss in the audit trail.
 */
export function buildRouterPolicyFromLegacy(legacy: LegacyOutcome): DispatchPolicy {
  return {
    decidedBy: "channel-router",
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

/**
 * Convenience wrapper: record + report for one telegram message. The
 * caller computes `legacyOutcome` from its routing decision and passes
 * it; the helper writes the event, decision, and (if the two disagree)
 * a divergence row.
 *
 * The caller must catch exceptions — the router must continue serving
 * messages even if the ledger errors.
 */
export function recordRouterDispatch(
  ledger: IntentLedger,
  msg: RouterMessageProjection,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): void {
  const eventInput = buildRouterEventInput(msg, rawJson, now)
  const policy = buildRouterPolicyFromLegacy(legacyOutcome)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "telegram", ledgerDecision, legacyOutcome, now)
}
