import { routeMemo } from "@/wiki/facts/fact-proposals"
import type { MemoryStore } from "./memory-store"

// --- Where a session memo goes once it is written (#273) ---
//
// A summary may carry work state, never new facts. Claims about outside
// systems (billing, account, outage, deploy) become wiki fact proposals
// with their provenance; only work state is kept as memory, where it
// expires like other task state. The per-chat pinned copy, read by the
// next fresh session, keeps the claims but marks each one UNVERIFIED.

export interface StoreMemoInput {
  wikiDir: string
  agentId: string
  channel: string
  chatId: string
  reason: string
  memo: string
}

export function storeRotationMemo(
  memory: Pick<MemoryStore, "addMemory">,
  sessions: { setRotationMemo(agentId: string, channel: string, chatId: string, memo: string, reason: string): void },
  m: StoreMemoInput,
): { proposals: number; error?: string } {
  const routed = routeMemo(m.wikiDir, m.memo, {
    agentId: m.agentId,
    origin: m.reason === "continuity" ? "continuity-memo" : `rotation-memo:${m.reason}`,
    chat: `${m.channel}:${m.chatId}`,
  })
  if (routed.workState.trim()) {
    // Keywords from the chat id let BM25 surface the memo when the same
    // chat continues; without them it only floats up as a recent fact.
    const chatKeyword = m.chatId.split(/[:@.]/).filter(Boolean).slice(0, 4)
    memory.addMemory(m.agentId, {
      agentId: m.agentId,
      category: "task-state",
      content: `[Rotation memo · ${m.reason}] ${routed.workState}`,
      keywords: ["rotation-memo", m.channel, ...chatKeyword],
      source: { channel: m.channel, chatId: m.chatId, sender: "system:rotation", date: new Date().toISOString().slice(0, 10) },
    })
  }
  // Pinned per chat for deterministic injection into the next fresh
  // session: BM25 rarely surfaces the memo on the turn right after a
  // rotation, which is exactly when it matters.
  sessions.setRotationMemo(m.agentId, m.channel, m.chatId, routed.pinned, m.reason)
  return { proposals: routed.proposals.length, ...(routed.error ? { error: routed.error } : {}) }
}
