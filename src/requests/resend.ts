import type { RequestRecord } from "./store"

// --- Resend once (#1542) ---
//
// A request that needs attention because of a mechanical failure, one a
// second try fixes, is sent back to its agent once by the requests check,
// on the owner's pick-up path. Mechanical means:
//   limit    a usage limit, rate limit or quota error
//   restart  cut off by a restart where the resume step could not run it
//            again (not where it chose not to), a hand-off lost in one, or
//            an answer a restart kept from being passed on
// A limit waits until no usage-limit hold is active (the limit reset, or
// the account changed). Both wait `afterMinutes` after it stopped.
// While a resend is due, the owner is not told: a failure that fixes
// itself never reaches them. One still waiting after `holdMaxHours`, or a
// second stop after the resend, is told as before.
// Left alone: a promise (the agent's word to someone), a request in an
// active tracked plan (the plan check follows its steps), one with a
// check of its own, and one whose agent is not on this node.

export interface ResendSettings {
  enabled: boolean
  afterMinutes: number
  holdMaxHours: number
}

export const DEFAULT_RESEND: ResendSettings = { enabled: true, afterMinutes: 5, holdMaxHours: 12 }

export type ResendCause = "limit" | "restart"

const LIMIT = /rate[ _-]?limit|usage limit|limit (?:reached|hit|exceeded)|(?:weekly|daily|hourly|session|5-hour|5h|monthly) limit|quota|too many requests|\b429\b|out of (?:extra )?usage/i
// A restart is read from where the tracker wrote it, never from text an
// agent or a peer wrote after it (the error or answer clipped behind it).
const CUT_OFF = /^Cut off by a restart and not picked up again \((.*)\)$/s
const HANDED_LOST = /^The work handed to [^:]+ was lost in a restart:/
const ANSWER_LOST = /^The answer from [^:]+ was not passed on after a restart \(/
// The resume step's reasons a second try fixes (agents/resume/policy.ts,
// coordinator.ts): the run was too old to resume, had no way back in, had
// nowhere to answer, or its resume threw. Any other reason is a choice the
// owner, the operator's settings or another part of the daemon made: a
// stop-all (its plan resumes it), a delegation relay or a stop signal
// wind-down (they run it again), a crash loop, a run already resumed once,
// a workflow step, resume turned off, a report-only channel. Those are told.
const RESENDABLE_RESUME = [
  /^started \d+ min ago \(limit \d+\)$/,
  /^no record of how to resume it$/,
  /^nothing would deliver its answer\b/,
  /^resume failed:/,
]

/** Why it stopped, when a second try would fix it; null otherwise. */
export function resendCause(reason: string | null): ResendCause | null {
  if (!reason) return null
  const cut = CUT_OFF.exec(reason)
  if (cut) return RESENDABLE_RESUME.some((re) => re.test(cut[1])) ? "restart" : null
  if (HANDED_LOST.test(reason) || ANSWER_LOST.test(reason)) return "restart"
  if (LIMIT.test(reason)) return "limit"
  return null
}

export type ResendVerdict =
  | { act: "tell" }
  | { act: "hold"; why: string }
  | { act: "resend"; cause: ResendCause }

/** What the requests check does with a request that needs attention and
 *  whose owner was not told yet. */
export function resendVerdict(
  r: RequestRecord,
  ctx: {
    settings: ResendSettings
    now: number
    /** A usage-limit hold is still active. */
    limitHeld: boolean
    hasAgent: boolean
    inPlan: boolean
    /** Its handed work all came back: the settle step owns it. */
    cameBack: boolean
  },
): ResendVerdict {
  const { settings, now } = ctx
  if (!settings.enabled || r.state !== "needs_attention" || r.resentAt !== null) return { act: "tell" }
  const cause = resendCause(r.attentionReason)
  if (!cause || r.promise || r.closeWhen || ctx.inPlan || !ctx.hasAgent || ctx.cameBack) return { act: "tell" }
  const since = r.stateChangedAt ?? r.updatedAt
  if (now - since >= settings.holdMaxHours * 3_600_000) return { act: "tell" }
  if (now - since < settings.afterMinutes * 60_000) return { act: "hold", why: `resent ${settings.afterMinutes} minute(s) after it stopped` }
  if (cause === "limit" && ctx.limitHeld) return { act: "hold", why: "waiting for the usage limit to reset" }
  return { act: "resend", cause }
}

/** The line the pick-up turn opens with, after the request's mark. */
export function resendLine(cause: ResendCause): string {
  return cause === "limit"
    ? "This request stopped on a usage limit, which has reset. AgentX sends it to you again, once, on its own."
    : "This request was stopped by a restart. AgentX sends it to you again, once, on its own."
}
