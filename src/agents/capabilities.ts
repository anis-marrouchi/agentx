import type { AgentDef } from "@/daemon/config"
import type { IntentLedger } from "@/intent/ledger"

// Phase 5 — typed capabilities. Drop-condition simplification.
//
// The kickoff (research-rescue-plan.md §2 phase 5) frames Phase 5 as
// a typed capability lattice with subtyping + composition algebra
// ("agent_A ⊕ agent_B = agent_C"). The same section flags a
// drop-condition: "if 2 weeks in it's not producing real type-check
// rejections, drop it. Replace with a simpler 'registered intents
// per agent' check."
//
// This file ships the simpler form upfront. The reasoning: the
// concrete operational signal Phase 5 was meant to produce
// (rejecting historical "I cannot handle this" agent errors) is
// achievable with a string-set membership check; the lattice +
// subtyping machinery would only matter if real rejections proved
// the simple form insufficient. We don't have that data — so we
// don't build the academic structure.
//
// If/when the simple form proves inadequate, this file can grow:
//   - intent globs ("issue.*" matches "issue.opened", "issue.closed")
//   - capability subtyping (a "review" capability subsumes
//     "review.code" and "review.docs")
//   - composition (combining two agents' capabilities into a
//     derived agent type)
// For now: exact-string membership.

/**
 * Returns true when the agent is permitted to handle the given
 * intent. Permissive defaults:
 *   - When `agent.intents` is empty (the default config), the agent
 *     handles ALL intents — preserves legacy behaviour for projects
 *     that haven't yet declared per-agent intent lists.
 *   - When `intent` is null/undefined (router-style events with no
 *     classified intent), the agent handles it — the intent classifier
 *     is best-effort and we don't reject on its absence.
 *
 * Hard rejection only when the agent has a non-empty intents list
 * AND the dispatched intent isn't in it. This is the production
 * failure mode the rescue plan's drop-condition described — every
 * "I cannot handle this" runtime error from the agent should
 * correspond to a config-time-rejectable mismatch here.
 */
export function agentCanHandleIntent(
  agent: AgentDef | undefined,
  intent: string | null | undefined,
): boolean {
  if (!agent) return false
  if (agent.intents.length === 0) return true
  if (!intent) return true
  return agent.intents.includes(intent)
}

// ---------------------------------------------------------------------------
// Phase 8 — capability-bounded security. Delegation depth check.
// ---------------------------------------------------------------------------
//
// The ledger itself is the chain-of-command record. When dispatching
// to an agent on a (project, subject), we walk back through prior
// decisions on the same subject and count distinct agents. If the
// count meets/exceeds the target's `maxDelegationDepth`, the dispatch
// is refused — the chain is too deep.
//
// This is the simplest credible form of Phase 8. The kickoff also
// names "allowed downstream skills" + "Ed25519-signed ledger entries"
// as Phase 8 goals; both are deliberately deferred:
//
//   - Allowed downstream skills overlaps with Phase 5's intents check
//     (already shipped). A future commit can extend AgentDef with
//     `canDelegateTo: string[]` if cascade-control needs to scope
//     beyond depth.
//
//   - Ed25519-signed ledger entries serves regulatory/audit use cases
//     more than dispatch correctness. The signed-export tool can come
//     when there's a regulator asking for it.

/**
 * Count the distinct agentIds in dispatched decisions on the given
 * (project, subject) within a recency window. Used to gate
 * delegation depth. Returns 0 when (project, subject) is null —
 * the chain concept doesn't apply without a slot identifier.
 */
export function delegationChainDepth(
  ledger: IntentLedger,
  project: string | null,
  subject: string | null,
  windowMs: number = 6 * 60 * 60 * 1000,  // 6h — chains beyond that are likely independent
): number {
  if (!project || !subject) return 0
  const since = Date.now() - windowMs
  const rows = ledger.db
    .prepare(`
      SELECT DISTINCT d.agent_id
      FROM intent_decisions d
      JOIN intent_events e ON e.id = d.event_id
      WHERE e.project = ? AND e.subject = ?
        AND d.outcome = 'dispatched'
        AND d.agent_id IS NOT NULL
        AND d.decided_at >= ?
    `)
    .all(project, subject, since) as Array<{ agent_id: string }>
  return rows.length
}

/**
 * Returns true when dispatching `targetAgent` on `(project, subject)`
 * stays within the agent's delegation budget. The check is per-agent —
 * the TARGET decides the depth limit, not the originator. (Reasoning:
 * the agent being dispatched is the one carrying the budget.)
 *
 * `maxDelegationDepth=0` disables the agent (any incoming chain depth
 * counts as "too deep"). `Infinity` / very-large values effectively
 * disable the check.
 */
export function withinDelegationBudget(
  ledger: IntentLedger,
  agent: AgentDef | undefined,
  agentId: string,
  project: string | null,
  subject: string | null,
): boolean {
  if (!agent) return false
  const max = agent.maxDelegationDepth
  if (max <= 0) return false   // explicitly disabled
  // Count distinct upstream agents on this slot. We treat the chain
  // as "everyone who's already been on it" — if dispatching to
  // agentId would exceed max, refuse.
  const upstream = delegationChainDepth(ledger, project, subject)
  // Subtle: if `agentId` is already in the chain (we're re-dispatching
  // to the same agent, e.g., a follow-up after resolution), don't
  // count them again — they shouldn't tip the budget over the edge
  // when the chain hasn't actually grown.
  const alreadyOnChain = ledger.db
    .prepare(`
      SELECT 1
      FROM intent_decisions d
      JOIN intent_events e ON e.id = d.event_id
      WHERE e.project = ? AND e.subject = ?
        AND d.agent_id = ?
        AND d.outcome = 'dispatched'
      LIMIT 1
    `)
    .get(project, subject, agentId)
  const projectedDepth = alreadyOnChain ? upstream : upstream + 1
  return projectedDepth <= max
}
