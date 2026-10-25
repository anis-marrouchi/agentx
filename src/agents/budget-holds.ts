// --- Work held for an agent paused by its monthly budget (#1162) ---
//
// A chat message that reaches an agent past its budget is not lost: it
// waits here until the budget gate lets the agent run again (the cap was
// raised, or the month turned), then runs as a queued turn would, with its
// reply posted back to the chat. Each chat is told the reason once per
// pause, not once per message.
//
// In memory, like the message queue: a daemon restart drops what waits.
// Bounded per agent; past the bound a message is refused instead.

export interface HeldMessage {
  text: string
  channel: string
  chatId: string
  context: Record<string, unknown> | undefined
  /** When it was first held, for the stale-state note when it runs (#282). */
  heldAt: number
}

export const MAX_HELD_PER_AGENT = 200

export type HoldResult =
  /** Held; the first message of its chat in this pause. Tell the chat why. */
  | "held-first"
  /** Held; the chat was already told. */
  | "held"
  /** Not held: the agent's line is full. */
  | "full"

export class BudgetHolds {
  private held = new Map<string, HeldMessage[]>()

  constructor(private readonly max: number = MAX_HELD_PER_AGENT) {}

  hold(agentId: string, m: HeldMessage): HoldResult {
    const list = this.held.get(agentId) ?? []
    if (list.length >= this.max) return "full"
    const told = list.some((h) => h.channel === m.channel && h.chatId === m.chatId)
    list.push(m)
    this.held.set(agentId, list)
    return told ? "held" : "held-first"
  }

  /** Messages waiting for `agentId`. */
  count(agentId: string): number {
    return this.held.get(agentId)?.length ?? 0
  }

  agents(): string[] {
    return [...this.held.keys()]
  }

  /** Remove and return what waits for `agentId`, oldest first. */
  take(agentId: string): HeldMessage[] {
    const list = this.held.get(agentId) ?? []
    this.held.delete(agentId)
    return list
  }

  get size(): number {
    let n = 0
    for (const l of this.held.values()) n += l.length
    return n
  }
}
