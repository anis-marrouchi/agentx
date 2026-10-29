import type { RequestRecord } from "./store"

// --- One resend of a request a machine stopped (#1542) ---
//
// A request that stopped on a usage limit or a restart was not refused or
// wrong: the same hand-back would have finished it. The requests check
// hands it back to its agent once, through the pick-up path:
//
//   limit     afterMinutes after it stopped, and once no provider hold
//             is left (the limit reset)
//   restart   afterMinutes after it stopped
//
// The owner is not told while that resend is still to come. A request
// that stops again after its resend is told as before, and says it was
// resent. A hold that lasts past holdMaxHours is told anyway. Promises
// and requests in a tracked plan are never resent here: their own checks
// follow them.

export interface ResendSettings { enabled: boolean; afterMinutes: number; holdMaxHours: number }
export const DEFAULT_RESEND_SETTINGS: ResendSettings = { enabled: true, afterMinutes: 5, holdMaxHours: 12 }

export type ResendKind = "limit" | "restart"

const LIMIT_RE = /\b(?:usage limits?|rate[ -]?limit(?:ed)?|plan limit|weekly limit|session limit|limit reached|hit your limit|quota|429|overloaded)\b/i
const RESTART_RE = /\b(?:restart|restarted|shutdown|shut down)\b/i

/** Why it stopped, when a resend would have finished it. Read from the
 *  attention reason the tracker wrote (tracker.ts), which carries the
 *  run's or the hand-off's error. */
export function resendKind(reason: string | null | undefined): ResendKind | null {
  if (!reason) return null
  if (LIMIT_RE.test(reason)) return "limit"
  if (RESTART_RE.test(reason)) return "restart"
  return null
}

export interface ResendContext {
  now: number
  settings: ResendSettings
  /** A provider limit is still held: a resend would stop on it again. */
  limitHeld: () => boolean
  inPlan?: (id: string) => boolean
  hasAgent?: (id: string) => boolean
}

/** What the check does with a request that needs attention and was not
 *  told yet: resend it now, hold the notice for a resend to come, or tell. */
export function resendDecision(r: RequestRecord, ctx: ResendContext): "resend" | "hold" | "tell" {
  if (!ctx.settings.enabled || r.state !== "needs_attention" || r.resentAt !== null || r.promise) return "tell"
  const kind = resendKind(r.attentionReason)
  if (!kind) return "tell"
  if (ctx.inPlan?.(r.id)) return "tell"
  if (ctx.hasAgent && !ctx.hasAgent(r.agentId)) return "tell"
  const since = r.stateChangedAt ?? r.updatedAt
  if (ctx.now - since >= ctx.settings.holdMaxHours * 3_600_000) return "tell"
  // Never at once: a rate limit with no hold behind it (a 429) needs a
  // little time too.
  if (ctx.now - since < ctx.settings.afterMinutes * 60_000) return "hold"
  return kind === "limit" && ctx.limitHeld() ? "hold" : "resend"
}

/** The line of the owner's notice about retrying. */
export function retryLine(r: RequestRecord): string {
  if (r.resentAt === null) return "Nothing is retrying it."
  const at = new Date(r.resentAt).toISOString().slice(0, 16).replace("T", " ")
  return `It was handed back to ${r.agentId} once on its own at ${at} UTC and stopped again. It is not retried a second time.`
}
