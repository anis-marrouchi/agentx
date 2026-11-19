import type { SituationImportance } from "@/decisions/seats/situation-phase"

// --- How much a talk matters, in code (#1892, phase 5) ---
//
// Design 2.2: importance is derived in code from the person's role
// (`people` config), an open promise on this chat and its due time. The
// seat is used only when code has nothing to go on (level null), and only
// when the seat may act.
//
// Shown on the record (`agentx situation list`, GET /situations) and, when
// high, in the [Situation] prompt line. It gates nothing.
// `situations.importance.enabled` (off by default) turns it on.
//
// Call urgency (design 2.2) is not here: calls do not reach the chat gate.

export type { SituationImportance }

export interface ImportanceInput {
  senderKind: "person" | "bot" | "agent"
  /** The sender's role in `people`, when listed. */
  role?: string | null
  /** The earliest-due open promise on this chat, when there is one. */
  openPromise?: { dueAt: number | null } | null
  now: number
  /** A promise due within this is "soon". Default one day. */
  soonMs?: number
}

export interface ImportanceResult {
  level: SituationImportance | null
  why: string
}

const DAY_MS = 24 * 3600_000

export function importanceOf(i: ImportanceInput): ImportanceResult {
  const due = i.openPromise?.dueAt ?? null
  if (i.role === "owner") return { level: "high", why: "the owner is in the talk" }
  if (i.role === "client") return { level: "high", why: "a client is in the talk" }
  if (i.openPromise && due !== null && due - i.now <= (i.soonMs ?? DAY_MS)) {
    return { level: "high", why: due <= i.now ? "an open promise on this chat is overdue" : "an open promise on this chat is due within a day" }
  }
  if (i.openPromise) return { level: "normal", why: "an open promise on this chat" }
  if (i.role) return { level: "normal", why: `a known person (${i.role})` }
  if (i.senderKind !== "person") return { level: "low", why: `a ${i.senderKind} with no open promise on this chat` }
  return { level: null, why: "nothing known about the sender" }
}
