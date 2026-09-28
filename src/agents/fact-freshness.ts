// --- Fact freshness: verify-or-ask (#273) ---
//
// A stored fact is a note of what was true when it was written, not
// ground truth. Account, billing, outage and deploy state change on their
// own, so after a short time an agent must re-check such a fact against
// its source, or say it is unverified and ask the owner. Session summaries
// (rotation memos) are unsourced restatements, so they are treated the
// same way however they are worded.

/** Days a volatile fact is trusted without being re-checked. */
export const VOLATILE_TTL_DAYS = 2

const VOLATILE = new RegExp(
  [
    "billing", "invoice", "payment", "past[- ]due", "overdue", "unpaid", "refund",
    "subscription", "trial", "credits?", "balance", "quota", "rate[- ]limit",
    "expired?", "expir(es|y|ing)", "suspended", "renew(al|ed|s)?",
    "outage", "down", "offline", "unreachable", "blocked", "broken", "failing",
    "deploy(ed|ment)?", "live on", "in prod(uction)?",
  ].map((w) => `\\b${w}\\b`).join("|"),
  "i",
)

export interface FreshnessFields {
  content: string
  createdAt: string
  source: { sender: string }
}

/** Account, billing, outage or deploy state, or a session summary. */
export function isVolatile(f: FreshnessFields): boolean {
  return f.source.sender === "system:rotation" || VOLATILE.test(f.content)
}

/** Whole days since the fact was written; null when the date is unreadable. */
export function ageDays(f: FreshnessFields, now = Date.now()): number | null {
  const t = Date.parse(f.createdAt)
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null
}

/** A volatile fact older than its TTL, or one of unknown age. */
export function needsRecheck(f: FreshnessFields, now = Date.now()): boolean {
  if (!isVolatile(f)) return false
  const age = ageDays(f, now)
  return age === null || age >= VOLATILE_TTL_DAYS
}

/** The rule injected with every memory block. */
export const VERIFY_OR_ASK_RULE =
  "[These are notes, not checked facts. Before you state one marked UNVERIFIED to a person or act on it, " +
  "re-check it against its source (API, CLI, dashboard). If you can't, say it is unverified and ask the owner.]"
