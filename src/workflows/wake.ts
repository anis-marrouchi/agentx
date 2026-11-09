// --- Wake a timer wait early on a work-item event ---
//
// A `timer.boundary` node may carry `wake: { on, refs, minGapSec }`. When
// a note or a label change lands on one of its refs (`group/project#12`
// for an issue, `group/project!3` for a merge request), the pending
// timer is moved to now instead of waiting for its full delay. The timer
// stays the backup: an event that never comes changes nothing.

export type WakeOn = "note" | "label"
export const WAKE_KINDS: readonly WakeOn[] = ["note", "label"]
export const WAKE_DEFAULT_GAP_SEC = 60
/** A note carrying this mark, posted from an account AgentX posts with,
 *  never wakes a run: it is the workflow talking to itself. */
export const WAKE_SELF_MARK = "<!-- agentx:no-wake -->"

/** A note or label change on an issue or merge request. */
export interface WorkActivity {
  ref: string
  on: WakeOn
  selfMarked: boolean
}

/** The rendered wake config stored on a timerWait pause. */
export interface TimerWake {
  on: WakeOn[]
  refs: string[]
  minGapSec: number
}

export type WakeResult = "woke" | "debounced" | "self" | "stale"

const REF_RE = /^[a-z0-9_.\-/]+[#!]\d+$/

/** `group/project#12` or `group/project!3`, lowercased; null otherwise. */
export function normalizeRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const ref = raw.trim().toLowerCase()
  return REF_RE.test(ref) ? ref : null
}

/** The wake config of a timer node, after its templates were rendered.
 *  `refs` is a comma-separated string or a list; entries that are not a
 *  ref are dropped. Undefined when there is no wake or nothing to watch. */
export function wakeConfig(raw: unknown): TimerWake | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const cfg = raw as { on?: unknown; refs?: unknown; minGapSec?: unknown }
  const kinds: unknown[] = Array.isArray(cfg.on) ? cfg.on : [...WAKE_KINDS]
  const on = kinds.filter((k): k is WakeOn => WAKE_KINDS.includes(k as WakeOn))
  const list = Array.isArray(cfg.refs) ? cfg.refs : typeof cfg.refs === "string" ? cfg.refs.split(",") : []
  const refs = [...new Set(list.map(normalizeRef).filter((r): r is string => !!r))]
  if (!on.length || !refs.length) return undefined
  const gap = Number(cfg.minGapSec)
  return { on, refs, minGapSec: Number.isFinite(gap) && gap >= 0 ? gap : WAKE_DEFAULT_GAP_SEC }
}

export function wakeMatches(wake: TimerWake | undefined, a: WorkActivity): boolean {
  return !!wake && wake.on.includes(a.on) && wake.refs.includes(a.ref)
}

/** Where the timer should move to. A wake within `minGapSec` of the last
 *  one moves it to the end of that gap instead (one trailing tick). Null
 *  when the timer already fires at or before that time. */
export function wakeTarget(args: { nowMs: number; lastWakeAt?: string; minGapSec: number; fireAt: string }): { fireAt: string; result: "woke" | "debounced" } | null {
  const last = args.lastWakeAt ? Date.parse(args.lastWakeAt) : NaN
  const gapEnd = Number.isFinite(last) ? last + args.minGapSec * 1000 : -Infinity
  const debounced = gapEnd > args.nowMs
  const targetMs = debounced ? gapEnd : args.nowMs
  const current = Date.parse(args.fireAt)
  if (Number.isFinite(current) && current <= targetMs) return null
  return { fireAt: new Date(targetMs).toISOString(), result: debounced ? "debounced" : "woke" }
}

/** The `wake` body a peer sends on POST /workflow/event. Null when it is
 *  not a valid one. */
export function parseWorkActivity(raw: unknown): WorkActivity | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as { ref?: unknown; on?: unknown; selfMarked?: unknown }
  const ref = normalizeRef(r.ref)
  if (!ref || !WAKE_KINDS.includes(r.on as WakeOn)) return null
  return { ref, on: r.on as WakeOn, selfMarked: r.selfMarked === true }
}
