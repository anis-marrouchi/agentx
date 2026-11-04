// --- Hand-off budget for work no person started (#1756) ---
//
// Agents hand work to each other, each answer wakes the asker again, and
// that turn may hand out more. With no person behind the chain nothing
// ends it: five agents trading read-backs and text swaps spent most of a
// day's plan on a2a turns. Two brakes, both only for chains whose root is
// an agent (a cron, an agent's own chat, a desk loop):
//
//   perAgentHour  hand-offs one agent may start in a rolling hour
//   perChainDay   hand-offs one chain (its root) may make in a rolling day
//
// Work a person started is never counted. Counts live in memory: a
// restart starts them over.

import type { RootInitiator } from "./initiator"

export interface ChainBudgetLimits {
  /** 0 turns the brake off. */
  perAgentHour: number
  perChainDay: number
}

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** One chain: the same root, wherever its hops run. */
export function chainKeyOf(root: RootInitiator): string {
  return [root.channel, root.chatId ?? "", root.agentId ?? "", root.sender ?? ""].join("\u0000")
}

export class ChainBudget {
  private byAgent = new Map<string, number[]>()
  private byChain = new Map<string, number[]>()

  constructor(
    private limits: () => ChainBudgetLimits,
    private now: () => number = Date.now,
  ) {}

  /**
   * Count one hand-off from `agentId` for the chain `root`. Returns why it
   * must be refused, or null when it may go (and it is then counted).
   */
  take(agentId: string, root: RootInitiator): string | null {
    if (root.kind === "human") return null
    const { perAgentHour, perChainDay } = this.limits()
    const t = this.now()
    const mine = recent(this.byAgent, agentId, t - HOUR_MS)
    const key = chainKeyOf(root)
    const chain = recent(this.byChain, key, t - DAY_MS)
    if (perAgentHour > 0 && mine.length >= perAgentHour) {
      return refusal(`${agentId} has handed out ${mine.length} pieces of work in the last hour that no person asked for (limit ${perAgentHour})`)
    }
    if (perChainDay > 0 && chain.length >= perChainDay) {
      return refusal(`this chain of work, started by ${root.agentId ?? root.channel}, has made ${chain.length} hand-offs today with no person behind it (limit ${perChainDay})`)
    }
    mine.push(t)
    chain.push(t)
    this.byAgent.set(agentId, mine)
    this.byChain.set(key, chain)
    return null
  }
}

function recent(map: Map<string, number[]>, key: string, since: number): number[] {
  const list = (map.get(key) ?? []).filter((at) => at > since)
  if (list.length) map.set(key, list)
  else map.delete(key)
  return list
}

function refusal(why: string): string {
  return `Hand-off budget used: ${why}. Do not hand this to another agent. ` +
    "Finish what you can in this turn yourself; if something still needs another agent or a decision, " +
    "say so once to the owner in one short message, then stop."
}
