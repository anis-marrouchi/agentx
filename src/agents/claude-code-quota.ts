// --- Claude Max-plan dispatch budget ---
//
// Anthropic enforces soft per-window caps on Max-plan message/request counts
// (the published ballpark is ~45/5h for Pro, ~225/5h for Max 5×, ~900/5h for
// Max 20×; hourly caps exist too). When the fleet burns through these, new
// cold dispatches start failing with "out of extra usage" (overage gate,
// handled separately) or silently degraded responses.
//
// This module tracks dispatch timestamps across ALL claude-code-tier agents
// (they share one OAuth, so their usage pools together) in a simple ring
// buffer and exposes:
//
//   recordClaudeCodeDispatch()  — call when a dispatch is about to fire
//   getClaudeCodeUsage()        — counts in the last hour / last 5h
//   preflightQuotaGate(…)       — optional short-circuit for cold dispatches
//                                  when usage is past the configured ceiling
//
// Values are deliberately conservative defaults (Max 5× ballpark). Tune via
// setDispatchBudget() from DaemonConfig at daemon startup. When thresholds
// are `undefined` the gate is a no-op and only the counters track (pure
// observability, no behavior change).

export interface DispatchBudget {
  /** Soft hourly cap. Logs a warning at warnRatio, gates cold dispatches at 100%. */
  maxPerHour?: number
  /** Soft rolling-5-hour cap. Same semantics as maxPerHour. */
  maxPer5h?: number
  /** Warn when usage >= warnRatio × max (default 0.8). */
  warnRatio?: number
}

const DEFAULT_BUDGET: Required<Pick<DispatchBudget, "warnRatio">> & DispatchBudget = {
  // No hard defaults — opt-in by config. Keep warnRatio so usage logs still
  // emit at 80% when the operator DOES set a cap.
  warnRatio: 0.8,
}

let budget: DispatchBudget = { ...DEFAULT_BUDGET }

// Ring buffer of dispatch timestamps, newest last. We only ever need the
// last 5h, so prune anything older on record.
const FIVE_H_MS = 5 * 60 * 60 * 1000
const ONE_H_MS = 60 * 60 * 1000
const timestamps: number[] = []

export function setDispatchBudget(next: DispatchBudget | undefined): void {
  budget = { ...DEFAULT_BUDGET, ...(next || {}) }
}

export function clearDispatchHistory(): void { timestamps.length = 0 }

function prune(now: number): void {
  const cutoff = now - FIVE_H_MS
  let i = 0
  while (i < timestamps.length && timestamps[i] < cutoff) i++
  if (i > 0) timestamps.splice(0, i)
}

export function recordClaudeCodeDispatch(now: number = Date.now()): void {
  prune(now)
  timestamps.push(now)
}

export interface ClaudeCodeUsage {
  lastHour: number
  last5h: number
  maxPerHour?: number
  maxPer5h?: number
  hourlyRatio?: number   // usage/max in [0,1] when max is set
  fiveHourRatio?: number // usage/max in [0,1] when max is set
}

export function getClaudeCodeUsage(now: number = Date.now()): ClaudeCodeUsage {
  prune(now)
  const hourCutoff = now - ONE_H_MS
  let lastHour = 0
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] >= hourCutoff) lastHour++
    else break
  }
  const last5h = timestamps.length
  const out: ClaudeCodeUsage = {
    lastHour,
    last5h,
    maxPerHour: budget.maxPerHour,
    maxPer5h: budget.maxPer5h,
  }
  if (budget.maxPerHour && budget.maxPerHour > 0) out.hourlyRatio = lastHour / budget.maxPerHour
  if (budget.maxPer5h && budget.maxPer5h > 0) out.fiveHourRatio = last5h / budget.maxPer5h
  return out
}

/**
 * Returns null when dispatch is allowed; returns an abort struct when usage
 * is past 100% of a configured cap. Warm sessions are always allowed through
 * (they replay via cache_read and are cheap) — only cold dispatches get
 * gated, same philosophy as preflightOverageGate.
 *
 * The function DOES NOT mutate state (does not increment counters). Call
 * `recordClaudeCodeDispatch()` separately once the caller commits to the
 * dispatch.
 */
export function preflightQuotaGate(hasWarmSession: boolean, now: number = Date.now()):
  | { abort: true; reason: string; message: string; usage: ClaudeCodeUsage }
  | null {
  const usage = getClaudeCodeUsage(now)
  if (hasWarmSession) return null
  if (budget.maxPerHour && usage.lastHour >= budget.maxPerHour) {
    return {
      abort: true,
      reason: "hourly_cap",
      message:
        `Claude-code fleet dispatch-budget hit: ${usage.lastHour}/${budget.maxPerHour} in the last hour. ` +
        `Cold dispatches are being held back to preserve warm-session headroom. ` +
        `Raise agents.budget.maxPerHour in DaemonConfig if this is a false positive.`,
      usage,
    }
  }
  if (budget.maxPer5h && usage.last5h >= budget.maxPer5h) {
    return {
      abort: true,
      reason: "five_hour_cap",
      message:
        `Claude-code fleet dispatch-budget hit: ${usage.last5h}/${budget.maxPer5h} in the last 5h. ` +
        `Cold dispatches are being held back to preserve warm-session headroom. ` +
        `Raise agents.budget.maxPer5h in DaemonConfig if this is a false positive.`,
      usage,
    }
  }
  return null
}

/**
 * Returns a warning string when usage has crossed the warnRatio threshold,
 * otherwise null. Caller should log and clear the ratcheting state (we don't
 * suppress duplicates here — suppression is a caller concern).
 */
export function warnIfNearingCap(now: number = Date.now()): string | null {
  const usage = getClaudeCodeUsage(now)
  const ratio = budget.warnRatio ?? 0.8
  if (usage.hourlyRatio !== undefined && usage.hourlyRatio >= ratio && usage.hourlyRatio < 1) {
    return `claude-code hourly usage ${usage.lastHour}/${usage.maxPerHour} (${Math.round(usage.hourlyRatio * 100)}% of cap)`
  }
  if (usage.fiveHourRatio !== undefined && usage.fiveHourRatio >= ratio && usage.fiveHourRatio < 1) {
    return `claude-code 5h usage ${usage.last5h}/${usage.maxPer5h} (${Math.round(usage.fiveHourRatio * 100)}% of cap)`
  }
  return null
}
