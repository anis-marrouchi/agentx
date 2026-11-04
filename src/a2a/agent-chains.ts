// --- Turn budget for agent-only chains (#1756) ---
//
// Agents hand work to each other with no end when no person started the
// chain: a hand-off's answer wakes the asking agent again, and that turn
// may hand out more. `maxDelegationDepth` counts distinct agents on one
// subject, so a few agents taking turns never trips it, and
// MAX_SEND_DEPTH only bounds callbacks, not plain sends or sync hops.
//
// This counts hand-offs instead, in two rolling windows:
//
//   perAgentHour  hand-offs one agent may start in the last hour, for
//                 work no person started.
//   perChainDay   hand-offs one chain (the same root) may make in the
//                 last 24 hours.
//
// Work a person started is never counted, and 0 turns a brake off. A hop
// that is refused is not counted. The counts live in memory: a restart
// starts them over, which only ever gives a chain more room, never less.

import type { RootInitiator } from "./initiator"

export interface AgentChainLimits {
  perAgentHour: number
  perChainDay: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Sweep every key for expired entries after this many takes, so agents
 *  and chains that went quiet do not stay in memory. */
const SWEEP_EVERY = 200

/** One chain: the root it started from. A cron job's runs share a root
 *  (`cron:<job>`), so they share a chain's day. */
export function chainKeyOf(root: RootInitiator): string {
  return [root.kind, root.channel, root.chatId ?? "", root.agentId ?? "", root.sender ?? ""].join("\u0000")
}

/** What a refused agent is told: finish the work itself or write to the
 *  owner once, instead of handing out more. */
export function chainBudgetRefusal(agentId: string, why: { scope: "agent" | "chain"; limit: number }): string {
  const used = why.scope === "agent"
    ? `${agentId} has started ${why.limit} hand-offs to other agents in the last hour`
    : `this chain of work has made ${why.limit} hand-offs between agents in the last 24 hours`
  return (
    `Hand-off budget used: no person started this work, and ${used}. ` +
    "Do not hand out more work or ask other agents again. Finish the work yourself in this turn, " +
    "or, if you cannot, write to the owner once with what is done and what is left, then stop."
  )
}

export class AgentChainBudget {
  private byAgent = new Map<string, number[]>()
  private byChain = new Map<string, number[]>()
  private takes = 0
  private readonly now: () => number

  constructor(private limits: () => AgentChainLimits, now?: () => number) {
    this.now = now ?? Date.now
  }

  /**
   * Count one hand-off by `agentId` for the chain `root`, or say why it is
   * refused. Null: allowed (and counted, unless a person started the work).
   */
  take(agentId: string, root: RootInitiator): string | null {
    if (root.kind === "human") return null
    const { perAgentHour, perChainDay } = this.limits()
    if (perAgentHour <= 0 && perChainDay <= 0) return null
    const now = this.now()
    if (++this.takes % SWEEP_EVERY === 0) this.sweep(now)
    const agent = perAgentHour > 0 ? live(this.byAgent, agentId, now - HOUR) : null
    const chainKey = chainKeyOf(root)
    const chain = perChainDay > 0 ? live(this.byChain, chainKey, now - DAY) : null
    if (agent && agent.length >= perAgentHour) return chainBudgetRefusal(agentId, { scope: "agent", limit: perAgentHour })
    if (chain && chain.length >= perChainDay) return chainBudgetRefusal(agentId, { scope: "chain", limit: perChainDay })
    if (agent) { agent.push(now); this.byAgent.set(agentId, agent) }
    if (chain) { chain.push(now); this.byChain.set(chainKey, chain) }
    return null
  }

  /** Hand-offs counted now, for one agent in the last hour and one chain
   *  in the last day (status and tests). */
  usage(agentId: string, root?: RootInitiator): { agentHour: number; chainDay: number } {
    const now = this.now()
    return {
      agentHour: live(this.byAgent, agentId, now - HOUR).length,
      chainDay: root ? live(this.byChain, chainKeyOf(root), now - DAY).length : 0,
    }
  }

  private sweep(now: number): void {
    for (const k of [...this.byAgent.keys()]) live(this.byAgent, k, now - HOUR)
    for (const k of [...this.byChain.keys()]) live(this.byChain, k, now - DAY)
  }
}

/** The entries of `key` newer than `since`; a key left with none is dropped. */
function live(map: Map<string, number[]>, key: string, since: number): number[] {
  const all = map.get(key)
  if (!all) return []
  let i = 0
  while (i < all.length && all[i] <= since) i++
  const kept = i ? all.slice(i) : all
  if (kept.length) map.set(key, kept)
  else map.delete(key)
  return kept
}
