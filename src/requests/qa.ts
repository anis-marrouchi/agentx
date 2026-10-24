// --- A QA verdict on a request (#1188) ---
//
// A request can be marked as needing QA: its agent says so with
// `needsQa: true` on accept, wait, promise or describe. A QA agent then
// records its verdict on it with the `qa` action of agentx_request:
//   block  it must not ship as it is (the note says why)
//   risk   it can ship, with a risk the note names
//   pass   signed off
// The latest verdict is kept on the request, with who gave it and when;
// every verdict is kept in request_verdicts, so a block followed by a pass
// stays readable. A request waits on QA while it is marked as needing it
// and has no verdict since it was last marked: marking it again (after a
// fix for a block, say) asks for a new verdict. Recording a verdict is not
// a touch and sends nothing: it is a record surfaces read.

export const QA_VERDICTS = ["block", "risk", "pass"] as const
export type QaVerdict = (typeof QA_VERDICTS)[number]

export interface QaRecord {
  verdict: QaVerdict
  /** The agent that gave it. */
  by: string
  at: number
  /** Why, in the QA agent's words. Always given for block and risk. */
  note: string | null
}

export const QA_NOTE_MAX = 500

/** The `qa` filter of GET /requests: awaiting sign-off, or one verdict. */
export const QA_FILTERS = ["awaiting", ...QA_VERDICTS] as const
export type QaFilter = (typeof QA_FILTERS)[number]

/** A verdict as given by an agent: its kind and note, or why it is refused. */
export function parseVerdict(verdict: unknown, note: unknown): { verdict: QaVerdict; note: string | null } | string {
  const v = typeof verdict === "string" ? verdict.trim().toLowerCase() : ""
  if (!(QA_VERDICTS as readonly string[]).includes(v)) return `qa needs verdict: one of ${QA_VERDICTS.join(", ")}`
  const text = typeof note === "string" ? note.replace(/\s+/g, " ").trim() : ""
  if (v !== "pass" && !text) return `a ${v} verdict needs a note: what is wrong, in a sentence`
  if (text.length > QA_NOTE_MAX) return `note is longer than ${QA_NOTE_MAX} characters`
  return { verdict: v as QaVerdict, note: text || null }
}

/** The optional `needsQa` of accept, wait, promise and describe. */
export function parseNeedsQa(v: unknown): boolean | undefined | string {
  if (v === undefined || v === null) return undefined
  return typeof v === "boolean" ? v : "needsQa must be true or false"
}

/** Marked as needing QA, with no verdict since it was last marked. */
export function awaitingQa(r: { qaRequestedAt: number | null; qa: QaRecord | null }): boolean {
  return r.qaRequestedAt != null && (!r.qa || r.qa.at < r.qaRequestedAt)
}

/** "BLOCK by qa-agent, 2030-01-01 10:00 UTC: the login fails" */
export function describeQa(qa: QaRecord): string {
  const when = new Date(qa.at).toISOString().slice(0, 16).replace("T", " ")
  return `${qa.verdict.toUpperCase()} by ${qa.by}, ${when} UTC${qa.note ? `: ${qa.note}` : ""}`
}
