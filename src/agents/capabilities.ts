import type { AgentDef } from "@/daemon/config"

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
