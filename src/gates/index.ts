/**
 * The gates AgentX runs in code (#2085 §3), each tied to its Rules Registry
 * row. When a rule's gate is live for an agent on this node, the rules block
 * sends that rule as one short line ("checked by AgentX") instead of its
 * full text. When it is not live (off, shadow, warn, an older node), the
 * full text stays: the code is the one source only where it really runs.
 */
import type { DaemonConfig } from "@/daemon/config"
import type { SeatMode } from "@/decisions/store"
import type { ResolvedPolicy } from "@/guard/types"
import { ISSUE_COMPLETE_GATE, ISSUE_COMPLETE_RULE } from "./issue-complete"
import { STATUS_CLAIM_GATE, STATUS_CLAIM_RULE, STATUS_CLAIM_SEAT } from "./status-claim"

export interface GateLiveFacts {
  config: DaemonConfig
  /** A seat's mode on this node. */
  seatMode: (seat: string) => SeatMode
  /** The guard policy as this agent's runs read it. */
  policy: (agentId: string) => ResolvedPolicy | null
}

export interface GateEntry {
  ruleId: string
  gate: string
  isLive: (facts: GateLiveFacts, agentId: string) => boolean
}

/** G1: the guard's issue-complete rule refuses (its own `enforce` or the
 *  policy's), the adapter check refuses, and the agent runs Claude Code,
 *  whose written PreToolUse hook covers Bash and the GitLab MCP creates. */
function issueCompleteLive(facts: GateLiveFacts, agentId: string): boolean {
  if (facts.config.gates?.issueComplete?.adapter !== "enforce") return false
  if (facts.config.agents[agentId]?.tier !== "claude-code") return false
  const policy = facts.policy(agentId)
  if (!policy || policy.mode === "off") return false
  return policy.rules.some((r) => r.check === "issue-complete" && (r.mode === "enforce" || policy.mode === "enforce"))
}

export const GATES: GateEntry[] = [
  { ruleId: ISSUE_COMPLETE_RULE, gate: ISSUE_COMPLETE_GATE, isLive: issueCompleteLive },
  {
    // G2: a due time arms its wake, and the due-time seat asks for one.
    ruleId: "R4",
    gate: "due-wake",
    isLive: (f) => f.config.requests?.promises?.acceptWake !== false && f.seatMode("due-time") === "active",
  },
  { ruleId: STATUS_CLAIM_RULE, gate: STATUS_CLAIM_GATE, isLive: (f) => f.seatMode(STATUS_CLAIM_SEAT) === "active" },
]

/** Rule ids whose gate is live for this agent. Never throws: a gate that
 *  cannot be read is not live, so its rule keeps its full text. */
export function liveGateRules(facts: GateLiveFacts, agentId: string, gates: GateEntry[] = GATES): Set<string> {
  const out = new Set<string>()
  for (const g of gates) {
    try {
      if (g.isLive(facts, agentId)) out.add(g.ruleId)
    } catch {
      /* not readable: not live */
    }
  }
  return out
}

/** Gates whose rule id has no row in the Registry (a typo, a row not yet
 *  added): they never shorten anything, and doctor says so. */
export function gatesWithoutRow(ruleIds: Iterable<string>, gates: GateEntry[] = GATES): GateEntry[] {
  const ids = new Set(ruleIds)
  return gates.filter((g) => !ids.has(g.ruleId))
}
