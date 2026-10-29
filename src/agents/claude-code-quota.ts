// --- Claude subscription dispatch gate ---
//
// All claude-code-tier agents share one Claude subscription (one OAuth), so
// their usage pools together. Anthropic enforces rolling windows (5 hours,
// 7 days) on that pool, measured by utilization, not by message count.
// Claude Code reports the state of those windows on every turn as a
// `rate_limit_event` in its stream-json output:
//
//   { type: "rate_limit_event",
//     rate_limit_info: { status: "allowed" | "allowed_warning" | "rejected",
//                        resetsAt: <unix seconds>, rateLimitType: "five_hour" | … } }
//
// That event is the source of truth here. When Claude Code says a window is
// rejected, cold dispatches (no warm session) are held until the reported
// reset time, so scheduled jobs don't burn subprocesses reproducing the same
// refusal. Warm sessions always pass: they replay from prompt cache and a
// real refusal comes straight back from Claude as the task error.
//
// One exception: on an account with extra usage switched on, Claude Code
// keeps serving requests after a window is used up and still reports it as
// rejected, with `isUsingOverage: true` (and `overageStatus` "allowed" or
// "allowed_warning"). That is not a refusal, so it does not hold anything.
//
// Each event carries one status for the request plus the one window that
// matters most, so an `allowed` event means Claude served the request
// whichever window it names: it lifts the holds of the other windows too.
// A model window ("seven_day_opus", "seven_day_sonnet") only concerns that
// model: it holds, and is lifted by, runs on that model alone. A run with
// no model set is held by every window, because we can't tell which it uses.
//
// The dispatch counters (last hour / last 5h) stay for observability and for
// operators who want a hard local ceiling on top of the plan. Local caps are
// opt-in: with no cap configured the counters never gate anything. Before
// this, a default local cap sized for a "225 messages per 5h" guess held back
// every cron and bot-to-bot call on a busy morning while Anthropic was still
// accepting requests.
//
//   recordClaudeCodeDispatch()  — call when a dispatch is about to fire
//   recordRateLimitEvent(ev)    — call for every stream-json event; ignores others
//   getClaudeCodeUsage()        — counters + the last provider signal
//   liftProviderHolds()         — operator override: drop the active holds
//   preflightQuotaGate(…)       — short-circuit for cold dispatches

export interface DispatchBudget {
  /** Optional hard hourly ceiling on new claude-code runs. Unset or 0 = off. */
  maxPerHour?: number
  /** Optional hard rolling-5-hour ceiling. Unset or 0 = off. */
  maxPer5h?: number
  /** Warn when usage >= warnRatio × a configured cap (default 0.8). */
  warnRatio?: number
}

const DEFAULT_BUDGET: Required<Pick<DispatchBudget, "warnRatio">> & DispatchBudget = {
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

export function getDispatchBudget(): DispatchBudget { return { ...budget } }

export function clearDispatchHistory(): void {
  timestamps.length = 0
  providerSignals.clear()
  liftedHolds.clear()
  lastSessionInit = null
}

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

// --- Provider signal (Claude Code rate_limit_event) ---

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected"

export interface RateLimitSignal {
  status: RateLimitStatus
  /** Window name as Claude Code reports it ("five_hour", "seven_day", …). */
  window: string
  /** Wall-clock ms when the window resets, when reported. */
  resetsAt?: number
  /** 0..1 share of the window used, when reported. */
  utilization?: number
  /** True when the window is used up but extra usage is still serving requests. */
  usingOverage?: boolean
  /** Wall-clock ms when this signal was observed. */
  seenAt: number
}

/** Latest signal per window. A newer event for the same window replaces it. */
const providerSignals = new Map<string, RateLimitSignal>()

/** A rejected signal with no reset time is trusted for this long. */
const REJECTED_FALLBACK_HOLD_MS = 15 * 60 * 1000

// --- Lifted holds (#1531) ---
//
// A hold that ends is remembered for a day, so `/api/node` can say "lifted
// at 07:30" instead of dropping the window silently. Without it, an agent
// that last saw "rejected, resets tomorrow" could not tell that the
// account had recovered from the hold simply being gone.

export interface LiftedHold {
  window: string
  /** When the provider first reported the window as rejected. */
  heldSince: number
  /** The reset time the hold was waiting for, when reported. */
  resetsAt?: number
  liftedAt: number
  /** "served": Claude served a request again; "operator": `agentx usage
   *  plan --lift`; "reset": the reported reset time passed. */
  how: "served" | "operator" | "reset"
}

const LIFTED_KEEP_MS = 24 * 60 * 60 * 1000
const liftedHolds = new Map<string, LiftedHold>()

function holdEnd(s: RateLimitSignal): number {
  return s.resetsAt ?? s.seenAt + REJECTED_FALLBACK_HOLD_MS
}

function noteLifted(s: RateLimitSignal, liftedAt: number, how: LiftedHold["how"]): void {
  if (s.status !== "rejected" || s.usingOverage) return
  liftedHolds.set(s.window, { window: s.window, heldSince: s.seenAt, ...(s.resetsAt && { resetsAt: s.resetsAt }), liftedAt, how })
}

/** Holds that ended in the last day, newest first. A hold whose reset
 *  time passed counts as lifted at that time. */
export function liftedProviderHolds(now: number = Date.now()): LiftedHold[] {
  const out = new Map(liftedHolds)
  for (const s of providerSignals.values()) {
    if (s.status !== "rejected" || s.usingOverage) continue
    const end = holdEnd(s)
    if (end <= now) out.set(s.window, { window: s.window, heldSince: s.seenAt, ...(s.resetsAt && { resetsAt: s.resetsAt }), liftedAt: end, how: "reset" })
    else out.delete(s.window)
  }
  return [...out.values()].filter((l) => now - l.liftedAt < LIFTED_KEEP_MS).sort((a, b) => b.liftedAt - a.liftedAt)
}

// --- The account Claude Code last ran on (#1531) ---
//
// Claude Code's first stream event (system/init) says where its
// credential came from (`apiKeySource`: "none" means the /login
// subscription) and its own version. Kept so the node can say which
// account its sessions run on without anyone remembering it.

export interface SessionInitInfo {
  agentId?: string
  apiKeySource?: string
  cliVersion?: string
  model?: string
  seenAt: number
}

let lastSessionInit: SessionInitInfo | null = null

export function recordSessionInit(event: unknown, now: number = Date.now(), agentId?: string): void {
  if (!event || typeof event !== "object") return
  const e = event as Record<string, unknown>
  if (e.type !== "system" || e.subtype !== "init") return
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  lastSessionInit = {
    ...(agentId && { agentId }),
    ...(str(e.apiKeySource) && { apiKeySource: str(e.apiKeySource) }),
    ...(str(e.claude_code_version) && { cliVersion: str(e.claude_code_version) }),
    ...(str(e.model) && { model: str(e.model) }),
    seenAt: now,
  }
}

export function lastClaudeSessionInit(): SessionInitInfo | null {
  return lastSessionInit ? { ...lastSessionInit } : null
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** Claude Code reports resetsAt in unix seconds; accept ms too. */
function asEpochMs(v: unknown): number | undefined {
  const n = asNumber(v)
  if (n === undefined || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

/**
 * Parse a stream-json event. Returns the signal when the event is a
 * rate_limit_event with a recognisable status, otherwise null. Field names
 * follow Claude Code's camelCase; snake_case variants are accepted so a
 * CLI update doesn't silently blind the gate.
 */
export function parseRateLimitEvent(event: unknown, now: number = Date.now()): RateLimitSignal | null {
  if (!event || typeof event !== "object") return null
  const e = event as Record<string, unknown>
  if (e.type !== "rate_limit_event") return null
  const info = (e.rate_limit_info ?? e.rateLimitInfo) as Record<string, unknown> | undefined
  if (!info || typeof info !== "object") return null
  const status = info.status
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return null
  const window = String(info.rateLimitType ?? info.rate_limit_type ?? "unknown")
  const resetsAt = asEpochMs(info.resetsAt ?? info.resets_at)
  const utilization = asNumber(info.utilization)
  const overageStatus = info.overageStatus ?? info.overage_status
  const usingOverage = status === "rejected" && (
    (info.isUsingOverage ?? info.is_using_overage) === true
    || overageStatus === "allowed" || overageStatus === "allowed_warning"
  )
  return { status, window, resetsAt, utilization, ...(usingOverage && { usingOverage }), seenAt: now }
}

/** "seven_day_opus" → "opus". Null for the windows shared by every model. */
function windowModel(window: string): string | null {
  return /_(opus|sonnet|haiku)$/.exec(window)?.[1] ?? null
}

/** Whether a window concerns a run on `model`. Unknown model: every window does. */
function concerns(window: string, model: string | undefined): boolean {
  const family = windowModel(window)
  return !family || !model || model.toLowerCase().includes(family)
}

/**
 * Record the provider's view of the plan window. Non rate-limit events are
 * ignored. `model` is the model of the run that produced the event; a served
 * request lifts the holds of the other windows that concern that model.
 */
export function recordRateLimitEvent(event: unknown, now: number = Date.now(), model?: string): RateLimitSignal | null {
  const signal = parseRateLimitEvent(event, now)
  if (!signal) return null
  if (signal.status !== "rejected") {
    for (const [window, s] of providerSignals) {
      if (s.status !== "rejected") continue
      if (window === signal.window) { if (holdEnd(s) > now) noteLifted(s, now, "served"); continue }
      if (!windowModel(window) || (model && concerns(window, model))) {
        if (holdEnd(s) > now) noteLifted(s, now, "served")
        providerSignals.delete(window)
      }
    }
  } else {
    liftedHolds.delete(signal.window)
  }
  providerSignals.set(signal.window, signal)
  return signal
}

/** The rejected windows that still hold at `now`. Extra usage still serving is not a hold. */
export function activeProviderHolds(now: number = Date.now()): RateLimitSignal[] {
  return [...providerSignals.values()].filter((s) => {
    if (s.status !== "rejected" || s.usingOverage) return false
    return holdEnd(s) > now
  })
}

/** The window that holds a cold run on `model` at `now`, if any. */
export function activeProviderHold(now: number = Date.now(), model?: string): RateLimitSignal | null {
  return activeProviderHolds(now).find((s) => concerns(s.window, model)) ?? null
}

/**
 * Operator override: forget the active holds, so the next cold dispatch asks
 * Claude again. If the window is still used up, that run's refusal puts the
 * hold back. Returns the holds that were lifted.
 */
export function liftProviderHolds(now: number = Date.now()): RateLimitSignal[] {
  const lifted = activeProviderHolds(now)
  for (const s of lifted) {
    noteLifted(s, now, "operator")
    providerSignals.delete(s.window)
  }
  return lifted
}

export function getProviderSignals(): RateLimitSignal[] {
  return [...providerSignals.values()].sort((a, b) => b.seenAt - a.seenAt)
}

// --- Usage view ---

export interface ClaudeCodeUsage {
  lastHour: number
  last5h: number
  maxPerHour?: number
  maxPer5h?: number
  hourlyRatio?: number   // usage/max in [0,1] when max is set
  fiveHourRatio?: number // usage/max in [0,1] when max is set
  /** Latest signal per window from Claude Code, newest first. */
  provider: RateLimitSignal[]
}

function capOn(v: number | undefined): v is number { return typeof v === "number" && v > 0 }

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
    maxPerHour: capOn(budget.maxPerHour) ? budget.maxPerHour : undefined,
    maxPer5h: capOn(budget.maxPer5h) ? budget.maxPer5h : undefined,
    provider: getProviderSignals(),
  }
  if (out.maxPerHour) out.hourlyRatio = lastHour / out.maxPerHour
  if (out.maxPer5h) out.fiveHourRatio = last5h / out.maxPer5h
  return out
}

// --- Gate ---

export interface QuotaGateAbort {
  abort: true
  reason: "provider_rate_limit" | "hourly_cap" | "five_hour_cap"
  message: string
  usage: ClaudeCodeUsage
}

function windowLabel(window: string): string {
  return window.replace(/_/g, " ")
}

function resetLabel(resetsAt: number | undefined, now: number): string {
  if (!resetsAt) return "shortly"
  const mins = Math.max(1, Math.round((resetsAt - now) / 60_000))
  return `in about ${mins} min (${new Date(resetsAt).toISOString()})`
}

/**
 * Returns null when dispatch is allowed; returns an abort struct when the
 * provider reports the plan window as rejected, or when usage is past a
 * configured local cap. Warm sessions are always allowed through — they
 * replay via cache_read and are cheap — so only cold dispatches get gated,
 * same philosophy as preflightOverageGate.
 *
 * The function DOES NOT mutate state. Call `recordClaudeCodeDispatch()`
 * separately once the caller commits to the dispatch.
 */
export function preflightQuotaGate(hasWarmSession: boolean, now: number = Date.now(), model?: string): QuotaGateAbort | null {
  const usage = getClaudeCodeUsage(now)
  if (hasWarmSession) return null
  const hold = activeProviderHold(now, model)
  if (hold) {
    return {
      abort: true,
      reason: "provider_rate_limit",
      message:
        `Claude plan limit reached: Claude Code reports the ${windowLabel(hold.window)} window as rejected. ` +
        `Cold dispatches are held until it resets ${resetLabel(hold.resetsAt, now)}; open conversations still go through. ` +
        `To try again now, run: agentx usage plan --lift`,
      usage,
    }
  }
  if (usage.maxPerHour && usage.lastHour >= usage.maxPerHour) {
    return {
      abort: true,
      reason: "hourly_cap",
      message:
        `Local dispatch cap reached: ${usage.lastHour}/${usage.maxPerHour} claude-code runs in the last hour. ` +
        `Cold dispatches are held; open conversations still go through. ` +
        `Raise or remove session.maxClaudeCodeDispatchesPerHour in agentx.json (applies on save).`,
      usage,
    }
  }
  if (usage.maxPer5h && usage.last5h >= usage.maxPer5h) {
    return {
      abort: true,
      reason: "five_hour_cap",
      message:
        `Local dispatch cap reached: ${usage.last5h}/${usage.maxPer5h} claude-code runs in the last 5h. ` +
        `Cold dispatches are held; open conversations still go through. ` +
        `Raise or remove session.maxClaudeCodeDispatchesPer5h in agentx.json (applies on save).`,
      usage,
    }
  }
  return null
}

/**
 * Returns a warning string when the provider reports a window near its
 * limit, or when usage has crossed warnRatio of a configured local cap.
 * Otherwise null. Suppression of repeats is a caller concern.
 */
export function warnIfNearingCap(now: number = Date.now()): string | null {
  const usage = getClaudeCodeUsage(now)
  const nearing = usage.provider.find((s) => s.status === "allowed_warning")
  if (nearing) {
    const pct = nearing.utilization !== undefined ? ` (${Math.round(nearing.utilization * 100)}% used)` : ""
    return `claude plan ${windowLabel(nearing.window)} window nearing its limit${pct}, resets ${resetLabel(nearing.resetsAt, now)}`
  }
  const ratio = budget.warnRatio ?? 0.8
  if (usage.hourlyRatio !== undefined && usage.hourlyRatio >= ratio && usage.hourlyRatio < 1) {
    return `claude-code hourly usage ${usage.lastHour}/${usage.maxPerHour} (${Math.round(usage.hourlyRatio * 100)}% of local cap)`
  }
  if (usage.fiveHourRatio !== undefined && usage.fiveHourRatio >= ratio && usage.fiveHourRatio < 1) {
    return `claude-code 5h usage ${usage.last5h}/${usage.maxPer5h} (${Math.round(usage.fiveHourRatio * 100)}% of local cap)`
  }
  return null
}
