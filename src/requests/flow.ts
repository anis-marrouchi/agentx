import { startOfDay, TODAY_ZONE } from "./today"
import type { RequestStore } from "./store"

// --- The daily flow rate of requests (#1542) ---
//
// Every request asked in a day (the owner's day, `requests.flow.timeZone`),
// and where each one stands now:
//   asked     requests made that day (candidates left out)
//   done      closed as done
//   dropped   declined or dropped: each carries its reason, listed beside
//             the rate so a wrong drop can be seen
//   moving    in progress, or waiting on another agent
//   waiting   waiting on the owner
//   stuck     needs attention
//   rate      (done + dropped) / asked; null on a day nothing was asked
//   resent    resent once by the requests check (resend.ts), and how many
//             of those are done now
// Read only, recomputed on every call: a request closed later moves the
// day it was asked. No model.

export interface FlowSettings {
  timeZone: string
  days: number
}

export const DEFAULT_FLOW: FlowSettings = { timeZone: TODAY_ZONE, days: 7 }

/** Days one report may cover: closed requests age out after retentionDays. */
export const FLOW_DAYS_MAX = 90

/** Drop reasons listed per day. */
const REASONS_MAX = 5
const REASON_WORDS = 120

export interface FlowDay {
  /** YYYY-MM-DD in the zone. */
  day: string
  /** Epoch ms of the day's 00:00 in the zone. */
  start: number
  asked: number
  done: number
  dropped: number
  moving: number
  waiting: number
  stuck: number
  rate: number | null
  /** Most frequent reasons first; `more` counts the drops not listed. */
  dropReasons: Array<{ reason: string; count: number }>
  moreReasons: number
  resent: number
  resentDone: number
}

export interface FlowReport {
  zone: string
  /** Oldest first; the last one is today. */
  days: FlowDay[]
  today: FlowDay
}

const dayKey = (ms: number, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))

function emptyDay(start: number, zone: string): FlowDay {
  return { day: dayKey(start, zone), start, asked: 0, done: 0, dropped: 0, moving: 0, waiting: 0, stuck: 0, rate: null, dropReasons: [], moreReasons: 0, resent: 0, resentDone: 0 }
}

export function flowReport(store: RequestStore, opts: { days?: number; zone?: string; now?: number } = {}): FlowReport {
  const zone = opts.zone ?? DEFAULT_FLOW.timeZone
  const count = Math.min(Math.max(Math.floor(opts.days ?? DEFAULT_FLOW.days), 1), FLOW_DAYS_MAX)
  const now = opts.now ?? Date.now()
  // Walked back one 00:00 at a time: a day across a clock change is 23 or 25 h.
  const starts = [startOfDay(now, zone)]
  while (starts.length < count) starts.unshift(startOfDay(starts[0] - 1, zone))
  const days = starts.map((s) => emptyDay(s, zone))
  const reasons = days.map(() => new Map<string, number>())
  let i = 0
  for (const r of store.flowRows(starts[0])) {
    while (i + 1 < days.length && r.createdAt >= days[i + 1].start) i++
    const d = days[i]
    d.asked++
    if (r.state === "done") d.done++
    else if (r.state === "declined" || r.state === "dropped") {
      d.dropped++
      const why = (r.closeReason ?? "").replace(/\s+/g, " ").trim()
      const key = why.length > REASON_WORDS ? `${why.slice(0, REASON_WORDS - 1)}…` : why || "no reason given"
      reasons[i].set(key, (reasons[i].get(key) ?? 0) + 1)
    } else if (r.state === "in_progress" || r.state === "waiting_other") d.moving++
    else if (r.state === "waiting_owner") d.waiting++
    else if (r.state === "needs_attention") d.stuck++
    if (r.resentAt !== null) {
      d.resent++
      if (r.state === "done") d.resentDone++
    }
  }
  days.forEach((d, n) => {
    d.rate = d.asked ? (d.done + d.dropped) / d.asked : null
    const sorted = [...reasons[n]].sort((a, b) => b[1] - a[1])
    d.dropReasons = sorted.slice(0, REASONS_MAX).map(([reason, c]) => ({ reason, count: c }))
    d.moreReasons = sorted.slice(REASONS_MAX).reduce((sum, [, c]) => sum + c, 0)
  })
  return { zone, days, today: days[days.length - 1] }
}

const pct = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate * 100)}%`)

/** Today's figure, then one line per day, oldest first: what the CLI
 *  prints and the agentx_request tool answers. */
export function describeFlow(f: FlowReport): string {
  const t = f.today
  const lines = [
    `Today (${t.day}, ${f.zone}): ${t.asked ? `${t.done + t.dropped} of ${t.asked} closed, ${pct(t.rate)}` : "nothing asked yet"}.`,
    `  ${t.done} done, ${t.dropped} dropped, ${t.moving} moving, ${t.waiting} waiting on the owner, ${t.stuck} stuck.` +
      (t.resent ? ` ${t.resent} resent once on its own, ${t.resentDone} of them done.` : ""),
  ]
  if (t.dropReasons.length) {
    lines.push("  Dropped because:")
    for (const r of t.dropReasons) lines.push(`    ${r.count} × ${r.reason}`)
    if (t.moreReasons) lines.push(`    ${t.moreReasons} more`)
  }
  if (f.days.length > 1) {
    lines.push("", "Day         asked  done  dropped  moving  waiting  stuck  rate")
    for (const d of f.days) {
      const cells = [d.asked, d.done, d.dropped, d.moving, d.waiting, d.stuck].map(String)
      lines.push(`${d.day}  ${cells[0].padStart(5)}  ${cells[1].padStart(4)}  ${cells[2].padStart(7)}  ${cells[3].padStart(6)}  ${cells[4].padStart(7)}  ${cells[5].padStart(5)}  ${pct(d.rate).padStart(4)}`)
    }
  }
  return lines.join("\n")
}
