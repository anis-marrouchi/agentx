import type { IntentLedger } from "../ledger"
import { decideAndCommit, type DispatchPolicy } from "../decide"
import { reportDivergence, type LegacyOutcome } from "../divergence"
import type { IntentEventInput } from "../types"

// Source adapter — A2A mesh inbound /task receiver. Phase 1 commit 6.d.
//
// Mesh receives tasks via POST /task in the daemon's HTTP API. The
// mesh protocol does not (yet) carry a stable request id, so the
// ledger uses `sourceEventId: null` — each call records as its own
// event row, with no per-event idempotency. Mesh peers do not
// typically retry, so the absence of dedup is acceptable for the
// shadow soak. If retries become a concern, the protocol can grow a
// request-id field and the adapter can pick it up here.

export interface MeshTaskProjection {
  /** Agent the task is bound for (resolved at the receiver). */
  agentId: string
  /** Sender's identity claim (log-warn during rollout, will become
   *  required in a future protocol revision). */
  senderAgentId?: string
  /** Forwarded origin context — channel, chatId, project, etc. */
  context?: {
    chatId?: string
    channel?: string
    project?: string
  }
}

/** Build the IntentEventInput for one mesh /task arrival. Subject prefers
 *  the forwarded chatId (so a mesh-routed channel message keeps the same
 *  subject as the originating channel). Falls back to a per-agent slot
 *  when the call is a bare A2A invocation with no channel context. */
export function buildMeshEventInput(
  proj: MeshTaskProjection,
  rawJson: string,
  now: () => number = Date.now,
): IntentEventInput {
  return {
    ts: now(),
    source: "mesh",
    sourceEventId: null, // mesh protocol has no stable request id
    project: proj.context?.project ?? null,
    subject: proj.context?.chatId
      ? `chat:${proj.context.chatId}`
      : `mesh:agent:${proj.agentId}`,
    intent: proj.context?.channel ? `mesh.${proj.context.channel}` : "mesh.task",
    rawJson,
  }
}

/** Pass-through policy. Mesh /task always dispatches (validation rejects
 *  before reaching this layer), so the legacy outcome is generally
 *  "dispatched/agentId" and divergences come from ledger active-task
 *  safety surfacing concurrent inbound traffic on the same chat. */
export function buildMeshPolicyFromLegacy(legacy: LegacyOutcome): DispatchPolicy {
  return {
    decidedBy: "mesh-receiver",
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

export function recordMeshDispatch(
  ledger: IntentLedger,
  proj: MeshTaskProjection,
  rawJson: string,
  legacyOutcome: LegacyOutcome,
  now: () => number = Date.now,
): void {
  const eventInput = buildMeshEventInput(proj, rawJson, now)
  const policy = buildMeshPolicyFromLegacy(legacyOutcome)
  const ledgerDecision = decideAndCommit(ledger, eventInput, policy, now)
  reportDivergence(ledger, "mesh", ledgerDecision, legacyOutcome, now)
}
