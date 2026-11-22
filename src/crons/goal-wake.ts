import { markAwaitSlot } from "@/agents/await-slot"
import type { AgentTask } from "@/agents/runtime"
import { RECOMMEND_WAIT_MS } from "./goal-card"

// --- The goal check's owner wake (#863) ---
//
// The owner's recommendation turn must really run before the card goes
// up. A busy owner's turn waits for a free slot (await-slot.ts) instead of
// being queued: queued, execute() returns at once and the card would go
// up right away with "No recommendation". The wait is capped at the 2 h
// recommendation window, so the 2 h fallback stays the same: an owner
// that is still busy then gets no turn, and the card goes up without it.

interface WakeRegistry {
  getAgent(agentId: string): unknown
  execute(task: AgentTask): Promise<{ error?: string }>
}

/** The `wake` of the goal check's deps: resolves when the owner's turn
 *  ends; rejects when it never ran or failed (the caller logs why). */
export function goalCheckWake(registry: WakeRegistry, slotWaitMs: number = RECOMMEND_WAIT_MS) {
  return async (agentId: string, text: string, chatId: string): Promise<void> => {
    if (!registry.getAgent(agentId)) throw new Error(`agent "${agentId}" is not on this node`)
    const res = await registry.execute({
      agentId,
      message: text,
      context: markAwaitSlot({ channel: "cron", chatId }),
      slotWaitMs,
    })
    if (res.error) throw new Error(res.error)
  }
}
