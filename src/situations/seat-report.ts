import type { GradedRow } from "@/decisions/store"

// --- The situation-phase seat's calibration report (#1892, phase 5) ---
//
// One number decides whether the seat may act: the false "no reply" rate.
// Of the messages the seat said need no reply (P(needs a reply) at or
// under `below`), how many did, by a person's label (`agentx decisions
// label <call> needsReply yes|no`, or a release of a dropped message,
// which labels it "yes")?
//
// The seat may act only when the owner set a limit (`maxFalseNoReply`),
// at least `minLabeled` "no reply" answers are labelled, and the upper end
// of the 95% Wilson interval of the rate is under the limit. The upper
// bound, not the rate: four clean labels prove nothing, and a seat that
// holds real messages must show it rarely does with enough evidence.
//
// Pure: rows in, report out.

export interface SeatReport {
  /** Answers recorded for the needsReply question. */
  calls: number
  /** Answers that said no reply is needed. */
  noReply: number
  /** Of those, how many a person labelled. */
  labeled: number
  /** Of those, how many did need a reply. */
  falseNoReply: number
  /** falseNoReply / labeled; null with no labels. */
  rate: number | null
  /** Upper end of the 95% Wilson interval of `rate`; null with no labels. */
  upper95: number | null
  below: number
  limit: number | null
  minLabeled: number
  /** The seat may act. */
  ready: boolean
  /** Why it may or may not, in one sentence. */
  why: string
}

export interface SeatReportOptions {
  below: number
  limit?: number | null
  minLabeled: number
}

/** Upper end of the Wilson score interval for k of n. 1 when n is 0. */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 1
  const p = k / n
  const z2 = z * z
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.min(1, (centre + margin) / (1 + z2 / n))
}

const YES = new Set(["yes", "true", "1"])
const NO = new Set(["no", "false", "0"])

/** A label as yes / no, or null when it is neither. */
function truthOf(v: string | undefined): boolean | null {
  if (v === undefined) return null
  const t = v.trim().toLowerCase()
  return YES.has(t) ? true : NO.has(t) ? false : null
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function situationSeatReport(rows: GradedRow[], opts: SeatReportOptions): SeatReport {
  const limit = opts.limit ?? null
  let noReply = 0
  let labeled = 0
  let falseNoReply = 0
  for (const r of rows) {
    const p = Number(r.probabilities?.yes)
    if (!Number.isFinite(p) || p > opts.below) continue
    noReply++
    const t = truthOf(r.truth)
    if (t === null) continue
    labeled++
    if (t) falseNoReply++
  }
  const rate = labeled > 0 ? falseNoReply / labeled : null
  const upper95 = labeled > 0 ? wilsonUpper(falseNoReply, labeled) : null
  let ready = false
  let why: string
  if (limit === null) why = "No limit set (situations.seat.maxFalseNoReply): the seat never acts."
  else if (labeled < opts.minLabeled) why = `Only ${labeled} labeled "no reply" answers; ${opts.minLabeled} are needed.`
  else if (upper95! > limit) why = `The upper bound ${pct(upper95!)} is over the limit ${pct(limit)}.`
  else {
    ready = true
    why = `The upper bound ${pct(upper95!)} is under the limit ${pct(limit)}.`
  }
  return { calls: rows.length, noReply, labeled, falseNoReply, rate, upper95, below: opts.below, limit, minLabeled: opts.minLabeled, ready, why }
}

/** The report as lines for the terminal. */
export function formatSeatReport(r: SeatReport): string[] {
  return [
    `Answers: ${r.calls}; said "no reply needed" (P(needs a reply) <= ${r.below}): ${r.noReply}; labeled: ${r.labeled}`,
    r.rate === null
      ? `False "no reply" rate: unknown (no labeled "no reply" answers)`
      : `False "no reply" rate: ${pct(r.rate)} (${r.falseNoReply} of ${r.labeled} labeled), 95% upper bound ${pct(r.upper95!)}`,
    `Limit: ${r.limit === null ? "not set" : pct(r.limit)}; labels needed: ${r.minLabeled}`,
    `Ready for active: ${r.ready ? "yes" : "no"}. ${r.why}`,
  ]
}
