import type { FlowRow, RequestStore } from "./store"

// --- The flow rate of requests (#1542) ---
//
// The owner's measure of how requests move: of the requests asked in a
// day, how many closed correctly. Done counts, and so does a decline or a
// drop, since each carries its reason (listed, so a wrong one shows).
//
//   rate = (done + dropped) / asked
//
// Beside it: moving (with an agent), waiting (on the owner), stuck (needs
// attention), and how many the requests check resent on its own after a
// limit or a restart. A request counts on the day it was asked, in its
// state now. Read only.

export const DEFAULT_FLOW_TIME_ZONE = "Africa/Tunis"
export const FLOW_DAYS_MAX = 60

export interface FlowCounts {
  asked: number
  done: number
  /** Declined or dropped, each with its reason. */
  dropped: number
  /** In progress, or waiting on another agent. */
  moving: number
  /** Waiting on the owner. */
  waiting: number
  /** Needs attention. */
  stuck: number
  /** Handed back once on their own after a limit or a restart. */
  resent: number
  /** Of those, done since. */
  resentDone: number
  /** (done + dropped) / asked; null with nothing asked. */
  rate: number | null
}

export interface FlowDay extends FlowCounts { day: string }

export interface FlowReport {
  timeZone: string
  days: FlowDay[]
  total: FlowCounts
  /** The reasons of the declines and drops, newest first. */
  drops: Array<{ id: string; day: string; reason: string }>
}

const DAY = 86_400_000

/** The day of `ms` in `timeZone`, as YYYY-MM-DD. */
export function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

function counts(rows: FlowRow[]): FlowCounts {
  const c: FlowCounts = { asked: rows.length, done: 0, dropped: 0, moving: 0, waiting: 0, stuck: 0, resent: 0, resentDone: 0, rate: null }
  for (const r of rows) {
    if (r.state === "done") c.done++
    else if (r.state === "declined" || r.state === "dropped") c.dropped++
    else if (r.state === "waiting_owner") c.waiting++
    else if (r.state === "needs_attention") c.stuck++
    else c.moving++
    if (r.resentAt !== null) {
      c.resent++
      if (r.state === "done") c.resentDone++
    }
  }
  c.rate = c.asked ? (c.done + c.dropped) / c.asked : null
  return c
}

/** The last `days` days, today last, in the owner's time zone. */
export function measureFlow(store: Pick<RequestStore, "flowRows">, opts: { days?: number; timeZone?: string; now?: number } = {}): FlowReport {
  const now = opts.now ?? Date.now()
  const timeZone = opts.timeZone || DEFAULT_FLOW_TIME_ZONE
  dayIn(now, timeZone) // throws on a time zone Intl does not know
  const n = Math.min(Math.max(1, Math.floor(opts.days ?? 7)), FLOW_DAYS_MAX)
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const k = dayIn(now - i * DAY, timeZone)
    if (!keys.includes(k)) keys.push(k)
  }
  const wanted = new Set(keys)
  const rows = store.flowRows(now - (n + 1) * DAY).filter((r) => wanted.has(dayIn(r.createdAt, timeZone)))
  const byDay = new Map<string, FlowRow[]>(keys.map((k) => [k, []]))
  for (const r of rows) byDay.get(dayIn(r.createdAt, timeZone))!.push(r)
  const drops = rows
    .filter((r) => r.state === "declined" || r.state === "dropped")
    .map((r) => ({ id: r.id, day: dayIn(r.createdAt, timeZone), reason: r.closeReason ?? "(no reason kept)" }))
    .reverse()
  return { timeZone, days: keys.map((day) => ({ day, ...counts(byDay.get(day)!) })), total: counts(rows), drops }
}

const pct = (rate: number | null) => rate === null ? "n/a" : `${Math.round(rate * 100)}%`

function line(label: string, c: FlowCounts): string {
  const resent = c.resent ? `, ${c.resent} resent (${c.resentDone} done since)` : ""
  return `${label}: ${pct(c.rate)} closed correctly (${c.done} done + ${c.dropped} dropped of ${c.asked} asked); ${c.moving} moving, ${c.waiting} waiting on the owner, ${c.stuck} stuck${resent}.`
}

/** The report in words: today, the trend, the period, and the drops. */
export function describeFlow(f: FlowReport, dropsShown = 10): string {
  const today = f.days[f.days.length - 1]
  const out = [line(`Today (${today.day}, ${f.timeZone})`, today)]
  if (f.days.length > 1) {
    out.push(`Trend: ${f.days.map((d) => `${d.day.slice(5)} ${pct(d.rate)} of ${d.asked}`).join(" · ")}`)
    out.push(line(`Last ${f.days.length} days`, f.total))
  }
  if (f.drops.length) {
    out.push("Dropped, with why:")
    for (const d of f.drops.slice(0, dropsShown)) out.push(`- ${d.id} (${d.day}): ${d.reason.replace(/\s+/g, " ").slice(0, 160)}`)
    if (f.drops.length > dropsShown) out.push(`- … and ${f.drops.length - dropsShown} more`)
  }
  return out.join("\n")
}
