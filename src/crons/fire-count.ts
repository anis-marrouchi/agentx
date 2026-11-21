// --- How often a cron fires, for the "more often" rule (#863) ---
//
// An owner may change its own job's time without approval when the new
// time fires no more often than the time the operator last approved.
// "More often" = more fires in the next 31 days, both counted from the same
// start, in the job's own timezone. 31 days, not 7: a monthly job moved to
// weekly gives 1 against 1 in some 7-day windows, never in 31.
//
// Standard cron rules: when both day-of-month and day-of-week are set
// (neither is "*"), a day matches on either (`0 9 1 * 1` fires on the 1st
// and on every Monday). Day-of-week 7 is Sunday too.

export const MORE_OFTEN_DAYS = 31
const SLOT_MS = 15 * 60_000

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  domAny: boolean
  dowAny: boolean
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`)
    let lo: number
    let hi: number
    if (range === "*") { lo = min; hi = max } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number)
      lo = a; hi = b
    } else {
      lo = Number(range); hi = stepText === undefined ? lo : max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`)
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return out
}

export function parseCron(expr: string): ParsedCron {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new Error(`invalid cron "${expr}": five fields are needed`)
  const dows = field(f[4], 0, 7)
  if (dows.has(7)) { dows.delete(7); dows.add(0) }
  return {
    minutes: field(f[0], 0, 59), hours: field(f[1], 0, 23), doms: field(f[2], 1, 31), months: field(f[3], 1, 12), dows,
    domAny: f[2] === "*", dowAny: f[4] === "*",
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function dayMatches(c: ParsedCron, dom: number, month: number, dow: number): boolean {
  if (!c.months.has(month)) return false
  if (!c.domAny && !c.dowAny) return c.doms.has(dom) || c.dows.has(dow)
  return c.doms.has(dom) && c.dows.has(dow)
}

/**
 * Fires of `expr` after `start` and up to `start + days`, in `timezone`.
 * Stops counting once past `cap` (the caller only needs to know it is more).
 * Every timezone offset is a whole number of 15 minutes, so the local
 * clock is read once per 15-minute slot.
 */
export function countFires(expr: string, timezone: string, start: number, days = MORE_OFTEN_DAYS, cap = Infinity): number {
  const c = parseCron(expr)
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  })
  const end = start + days * 86_400_000
  let count = 0
  for (let slot = Math.floor(start / SLOT_MS) * SLOT_MS; slot <= end; slot += SLOT_MS) {
    const parts: Record<string, string> = {}
    for (const p of fmt.formatToParts(new Date(slot))) parts[p.type] = p.value
    const hour = Number(parts.hour) % 24
    if (!c.hours.has(hour) || !dayMatches(c, Number(parts.day), Number(parts.month), WEEKDAYS[parts.weekday] ?? -1)) continue
    const base = Number(parts.minute)
    for (let m = base; m < base + 15; m++) {
      if (!c.minutes.has(m)) continue
      const at = slot + (m - base) * 60_000
      if (at > start && at <= end && ++count > cap) return count
    }
  }
  return count
}

/** Whether `next` fires more often than `approved` over the next 31 days. */
export function firesMoreOften(next: string, approved: string, timezone: string, start: number): { more: boolean; next: number; approved: number } {
  const was = countFires(approved, timezone, start)
  const now = countFires(next, timezone, start, MORE_OFTEN_DAYS, was)
  return { more: now > was, next: now, approved: was }
}
