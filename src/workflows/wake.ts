// --- Wake a timer wait early on a work-item event ---
//
// A `timer.boundary` node may carry `wake: { on, refs, minGapSec, self }`. When
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
  /** Label events: what changed, as `+Title` / `-Title`. */
  labels?: string[]
  /** Label events: made from an account AgentX posts with. */
  byAgentx?: boolean
}

/** The rendered wake config stored on a timerWait pause. */
export interface TimerWake {
  on: WakeOn[]
  refs: string[]
  minGapSec: number
  /** Label changes the run made itself before this pause, as
   *  `group/project#12 +Title` / `... -Title`, lowercased. Each one is
   *  used once to call its own webhook "self". */
  selfLabels?: string[]
}

export type WakeResult = "woke" | "debounced" | "self" | "stale"

const REF_RE = /^[a-z0-9_.\-/]+[#!]\d+$/
const SELF_LABEL_RE = /^(\S+)\s+([+-])\s*(\S.*)$/

/** `group/project#12 +Review` → `group/project#12 +review`; null otherwise. */
function normalizeSelfLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const m = raw.trim().match(SELF_LABEL_RE)
  const ref = m && normalizeRef(m[1])
  return ref ? `${ref} ${m![2]}${m![3].trim().toLowerCase()}` : null
}

const asList = (v: unknown): unknown[] => Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []

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
  const cfg = raw as { on?: unknown; refs?: unknown; minGapSec?: unknown; self?: unknown }
  const kinds: unknown[] = Array.isArray(cfg.on) ? cfg.on : [...WAKE_KINDS]
  const on = kinds.filter((k): k is WakeOn => WAKE_KINDS.includes(k as WakeOn))
  const refs = [...new Set(asList(cfg.refs).map(normalizeRef).filter((r): r is string => !!r))]
  if (!on.length || !refs.length) return undefined
  const gap = Number(cfg.minGapSec)
  const selfLabels = [...new Set(asList(cfg.self).map(normalizeSelfLabel).filter((r): r is string => !!r))]
  return { on, refs, minGapSec: Number.isFinite(gap) && gap >= 0 ? gap : WAKE_DEFAULT_GAP_SEC, ...(selfLabels.length ? { selfLabels } : {}) }
}

/** The run's own label write coming back as a webhook: an AgentX account
 *  made exactly changes the run recorded for this ref. Returns the record
 *  left after using them, or null when the event is not (only) the run's
 *  own, so it wakes. Another agent's label, even from the same account,
 *  is not in the record and wakes the run. */
export function consumeSelfLabels(wake: TimerWake, a: WorkActivity): string[] | null {
  if (a.on !== "label" || !a.byAgentx || !a.labels?.length || !wake.selfLabels?.length) return null
  const left = [...wake.selfLabels]
  for (const change of a.labels) {
    const i = left.indexOf(`${a.ref} ${change.toLowerCase()}`)
    if (i < 0) return null
    left.splice(i, 1)
  }
  return left
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
  const r = raw as { ref?: unknown; on?: unknown; selfMarked?: unknown; labels?: unknown; byAgentx?: unknown }
  const ref = normalizeRef(r.ref)
  if (!ref || !WAKE_KINDS.includes(r.on as WakeOn)) return null
  const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string" && /^[+-]./.test(l)) : []
  return {
    ref, on: r.on as WakeOn, selfMarked: r.selfMarked === true,
    ...(labels.length ? { labels } : {}),
    ...(r.byAgentx === true ? { byAgentx: true } : {}),
  }
}
