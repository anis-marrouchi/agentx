// --- The owner-words check inside done, before the close (#2047) ---
//
// retro:01M7VXKHCDJMX90PCDN6JT04WN. The owner-words check (owner-check.ts)
// read a close only after it was written, so the owner saw "done" for a
// minute before a part-proof close was reopened. Now an agent's done and
// a plan's close run the same judge first, on the request as it would read
// once closed:
//   warn   closes as before; the caller is told what the proof does not
//          show, and the after-close sweep reopens it without a 2nd call
//   block  a mismatch is refused (an agent's done: 409; a plan: held,
//          needing attention, its agent woken once)
// A model error, an unreadable answer or no time left never blocks: the
// close goes through and the sweep judges it, as before.

import type { RequestRecord, RequestStore } from "./store"
import type { BeforeCloseMode, OwnerVerdict } from "./owner-check"

/** The time an agent's done call has (tool.ts DONE_TIMEOUT_MS). The judge
 *  stays inside what is left of it, so the agent never sees a timeout for
 *  a close the daemon then writes (Hakim's review of #2047). */
export const BEFORE_CLOSE_CALL_MS = 45_000
/** Kept free at the end of the call for the close and the reply. */
export const BEFORE_CLOSE_MARGIN_MS = 5_000
/** Less than this left: the judge is skipped and the sweep judges later. */
export const BEFORE_CLOSE_MIN_MS = 3_000

export interface BeforeCloseCtx {
  /** "off" also when the owner-words check itself is off. */
  mode: BeforeCloseMode
  /** Most seconds the judge may take (ownerCheck.beforeCloseSeconds). */
  seconds: number
  judge?: (r: RequestRecord, timeoutMs: number) => Promise<OwnerVerdict | null>
  /** The judge without waiting, for a plan's close in the every-minute
   *  sweep (#2047 review B2). Unset: a plan closes as before. */
  judgeLater?: (r: RequestRecord, timeoutMs: number) => { ready: true; v: OwnerVerdict | null } | { ready: false }
  /** Whether the after-close sweep will reopen a mismatch on this request
   *  (under its reopen limit). Unset: assumed yes. */
  willReopen?: (id: string) => boolean
  /** Keeps a verdict on a close that went through (OwnerWordsCheck). */
  keep?: (id: string, v: OwnerVerdict, now: number) => void
  /** Wall clock for the call's time budget. Default Date.now. */
  clock?: () => number
  log?: (line: string) => void
}

/** What the caller of a done is told when warn let a mismatch close. */
export interface OwnerWordsNote {
  mode: "warn"
  verdict: "mismatch"
  why: string
  uncovered: string[]
  /** The after-close sweep will reopen it; false past maxReopens. */
  reopens: boolean
}

/** Milliseconds the judge may take, counted from the start of the call;
 *  0 when too little is left to judge. */
export function judgeBudget(ctx: Pick<BeforeCloseCtx, "seconds" | "clock">, startedAt: number): number {
  const left = BEFORE_CLOSE_CALL_MS - BEFORE_CLOSE_MARGIN_MS - ((ctx.clock ?? Date.now)() - startedAt)
  const budget = Math.min(ctx.seconds * 1000, left)
  return budget >= BEFORE_CLOSE_MIN_MS ? budget : 0
}

/** The request as it would read once closed as done, for the judge. */
export function closingRecord(store: RequestStore, id: string, by: string, evidence: string, now: number): RequestRecord | null {
  const r = store.get(id)
  return r ? { ...r, state: "done", closedBy: by, evidence, closedAt: now, closeReason: null } : null
}

export const uncoveredText = (v: Pick<OwnerVerdict, "uncovered" | "why">): string =>
  v.uncovered.length ? v.uncovered.join("; ") : v.why || "the close does not match the owner's words"

/** The refusal of an agent's done in block mode. */
export function blockedBody(v: OwnerVerdict): Record<string, unknown> {
  return {
    error: `Not closed: the owner-words check finds the proof does not show everything the owner asked (${uncoveredText(v)}). ` +
      "Do what is missing, then say done again with a proof link for each part.",
    ownerWordsBlocked: true,
    why: v.why,
    uncovered: v.uncovered,
  }
}

/** The note a warn close carries back to its caller; null when nothing
 *  is to be said. */
export function warnNote(v: OwnerVerdict | null, mode: BeforeCloseMode, reopens: boolean): OwnerWordsNote | null {
  return v?.verdict === "mismatch" && mode === "warn" ? { mode: "warn", verdict: "mismatch", why: v.why, uncovered: v.uncovered, reopens } : null
}

/** What the done tool says on a warn close (#2047 review N2). */
export function warnText(n: Pick<OwnerWordsNote, "why" | "uncovered" | "reopens">): string {
  return `Closed, but the proof does not show: ${uncoveredText(n)}. ` +
    (n.reopens ? "The owner-words check will reopen it; do what is missing." : "It stays closed (reopen limit reached) and the owner is told; do what is missing.")
}
