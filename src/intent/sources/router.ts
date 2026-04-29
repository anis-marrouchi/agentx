import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentEventInput, IntentSource } from "../types"

// Source adapter — channel-router. Phase 1 commit 6.b (telegram) +
// 6.b-extended (slack, whatsapp, discord).
//
// The router is a 1:1 dispatch source: one IncomingMessage → one routing
// decision (drop, deduped, or dispatched-to-one-agent). The legacy path
// makes the decision; the ledger records it alongside via a pass-through
// policy. Divergences during shadow soak come from ledger MECHANICS
// (idempotency on re-delivery, active-task safety on chat) rather than
// from policy disagreement — that's the soak's intended signal.
//
// **Channel coverage.** Supports four channels: telegram, slack,
// whatsapp, discord. Each has its own per-source mode flag
// (`INTENT_LEDGER_MODE_<CHANNEL>`) so an operator can promote them
// independently during 1c. The msg.channel string is mapped to the
// IntentSource enum via `routerChannelToSource`; channels outside the
// supported set return null and the call site short-circuits.

/** Channels the router covers. The `IntentSource` enum is wider but
 *  these are the four chat channels that flow through the router. */
const ROUTER_CHANNELS = new Set<string>(["telegram", "slack", "whatsapp", "discord"])

/** Map a channel string from IncomingMessage.channel to an IntentSource.
 *  Returns null when the channel isn't router-supported (e.g., gitlab —
 *  which has its own dispatcher and isn't routed through router.ts). */
export function routerChannelToSource(channel: string): IntentSource | null {
  return ROUTER_CHANNELS.has(channel) ? (channel as IntentSource) : null
}

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
 * Build the IntentEventInput for one router message. The sourceEventId
 * is `accountId/msgId` so re-deliveries from the same channel adapter's
 * view collapse to one event. Subject scopes active-task safety to the
 * chat (group id when present, else sender id — mirroring the legacy
 * chatId derivation in router.ts).
 *
 * `source` derives from `msg.channel` via `routerChannelToSource` and
 * MUST match the IntentSource enum; channels outside the supported set
 * cause the call site to short-circuit BEFORE reaching this builder.
 */
export function buildRouterEventInput(
  msg: RouterMessageProjection,
  source: IntentSource,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  const accountId = msg.accountId || "default"
  const chatId = msg.group?.id || msg.sender.id
  return {
    ts: now(),
    source,
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
 * Convenience wrapper: record + report for one router message. The
 * caller computes `legacyOutcome` from its routing decision and passes
 * it; the helper writes the event, decision, and (if the two disagree)
 * a divergence row.
 *
 * The caller must catch exceptions — the router must continue serving
 * messages even if the ledger errors. The caller must also have already
 * mapped msg.channel to a valid IntentSource via `routerChannelToSource`
 * (returning null = unsupported channel = caller short-circuits).
 */
export function recordRouterDispatch(
  ledger: IntentLedger,
  msg: RouterMessageProjection,
  source: IntentSource,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): void {
  const eventInput = buildRouterEventInput(msg, source, rawJson, now)
  const policy = buildRouterPolicyFromLegacy(legacyOutcome)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, source, ledgerDecision, legacyOutcome, now)
}
