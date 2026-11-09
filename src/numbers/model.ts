// --- Numbers: a tracked number with a history of readings (#1826) ---
//
// A number is a measure the team follows over time: content reach per
// channel, a step of the client journey, a CX or growth measure. It has a
// record of its own (id, name, owner agent, unit, target and direction,
// rhythm, source, tags) and a table of readings. Each reading holds a
// value, when it was read, and the window it covers (`periodStart` up to
// `periodEnd`), so "views 11-02..11-08" is one reading.
//
// Goals cannot hold this: a goal closes once, and keeps no history of
// values. A goal can still close itself on a number with the `number`
// check (src/requests/goal-store.ts).
//
// A failed read is stored as a reading without a value: the status says
// "no reading", never 0.

export const NUMBER_ID_MAX = 80
export const NUMBER_NAME_MAX = 120
export const NUMBER_UNIT_MAX = 30
export const NUMBER_TAG_MAX = 60
export const NUMBER_TAGS_MAX = 20
export const READING_NOTE_MAX = 300
const NUMBER_ID_RE = /^[a-z0-9][\w.:-]*$/i
const TAG_RE = /^[^\s,]+$/

export const RHYTHMS = ["daily", "weekly", "monthly"] as const
export type Rhythm = (typeof RHYTHMS)[number]

export const DIRECTIONS = ["up", "down"] as const
/** up: higher is better (the target is a floor). down: lower is better
 *  (the target is a ceiling). */
export type Direction = (typeof DIRECTIONS)[number]

export const DAY_MS = 86_400_000

/** A reading window: start inclusive, end exclusive, both UTC ms. */
export interface Period { start: number; end: number }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** An id for a number: letters, digits, dashes, dots or colons. */
export function parseNumberId(v: unknown): string | { error: string } {
  const id = str(v)
  if (!id) return { error: "id is needed: a short name made of letters, digits and dashes" }
  if (id.length > NUMBER_ID_MAX || !NUMBER_ID_RE.test(id)) return { error: `id must be letters, digits, dashes, dots or colons, at most ${NUMBER_ID_MAX} characters` }
  return id
}

/** Tags such as `channel:youtube` or `product:agentx`. Accepts an array
 *  or a comma-separated string. Lower case, no duplicates. */
export function parseTags(v: unknown): string[] | { error: string } {
  if (v === undefined || v === null || v === "") return []
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null
  if (!raw) return { error: "tags must be a list of words such as channel:youtube" }
  const tags: string[] = []
  for (const t of raw) {
    const tag = str(t).toLowerCase()
    if (!tag) continue
    if (tag.length > NUMBER_TAG_MAX || !TAG_RE.test(tag)) return { error: `tag "${String(t).slice(0, 40)}" must be one word (no spaces or commas), at most ${NUMBER_TAG_MAX} characters` }
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > NUMBER_TAGS_MAX) return { error: `at most ${NUMBER_TAGS_MAX} tags` }
  return tags
}

/** True when every tag of `wanted` is on `tags`. */
export function hasTags(tags: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((w) => tags.includes(w.toLowerCase()))
}

const utcDay = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }

/** The rhythm period that holds `at` (UTC). Weeks start on Monday. */
export function periodAt(rhythm: Rhythm, at: number): Period {
  const day = utcDay(at)
  if (rhythm === "daily") return { start: day, end: day + DAY_MS }
  if (rhythm === "weekly") {
    const dow = (new Date(day).getUTCDay() + 6) % 7 // Monday 0
    const start = day - dow * DAY_MS
    return { start, end: start + 7 * DAY_MS }
  }
  const d = new Date(day)
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) }
}

/** The last whole period before `now`: what a reading taken now covers. */
export function lastPeriod(rhythm: Rhythm, now: number): Period {
  return periodAt(rhythm, periodAt(rhythm, now).start - 1)
}

/** "2026-11-02" for a UTC ms. */
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** "2026-11-02..2026-11-08": the window in whole days, end inclusive. A
 *  window of one day reads as that day. */
export function describePeriod(p: Period): string {
  const first = isoDay(p.start)
  const last = isoDay(Math.max(p.start, p.end - 1))
  return first === last ? first : `${first}..${last}`
}

/** A date such as "2026-11-02" (UTC midnight), or an error. */
export function parseDay(v: unknown, field: string): number | { error: string } {
  const s = str(v)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
  if (!m || !Number.isFinite(ms) || isoDay(ms) !== s) return { error: `${field} must be a date such as 2026-11-02` }
  return ms
}

/** A window given as `from` and `to` (whole days, both inclusive). */
export function parsePeriod(from: unknown, to: unknown): Period | { error: string } {
  const start = parseDay(from, "from")
  if (typeof start !== "number") return start
  const last = to === undefined || to === null || to === "" ? start : parseDay(to, "to")
  if (typeof last !== "number") return last
  if (last < start) return { error: "to must be on or after from" }
  return { start, end: last + DAY_MS }
}

export interface Reading {
  numberId: string
  /** Null: the read failed, so there is no reading for this window. */
  value: number | null
  /** Why the read failed. */
  error: string | null
  readAt: number
  periodStart: number
  periodEnd: number
  /** Who or what gave it: "reader", "owner", or an agent id. */
  by: string
  note: string | null
}

export interface NumberTarget { value: number; direction: Direction }

export const STATUSES = ["on_target", "missed", "missed_twice", "no_reading", "no_target"] as const
export type NumberStatus = (typeof STATUSES)[number]

export const STATUS_WORDS: Record<NumberStatus, string> = {
  on_target: "on target",
  missed: "missed",
  missed_twice: "missed twice",
  no_reading: "no reading",
  no_target: "no target",
}

/** Whether `value` meets the target. */
export function meets(value: number, target: NumberTarget): boolean {
  return target.direction === "down" ? value <= target.value : value >= target.value
}

/** Where a number stands, from its readings newest first.
 *  - no reading: none yet, the newest read failed, or the last whole
 *    period of its rhythm has none (it is late)
 *  - no target: it has a value but nothing to compare it with
 *  - on target / missed: the newest reading against the target
 *  - missed twice: the newest and the one before it both missed */
export function statusOf(n: { target: NumberTarget | null; rhythm: Rhythm }, readings: readonly Reading[], now: number): NumberStatus {
  const latest = readings[0]
  if (!latest || latest.value === null) return "no_reading"
  if (latest.periodEnd < lastPeriod(n.rhythm, now).end) return "no_reading"
  if (!n.target) return "no_target"
  if (meets(latest.value, n.target)) return "on_target"
  const before = readings[1]
  return before && before.value !== null && !meets(before.value, n.target) ? "missed_twice" : "missed"
}

/** A value for people: whole numbers with thousands marks, others to two
 *  decimals, and the unit. */
export function formatValue(value: number | null, unit?: string | null): string {
  if (value === null) return "no reading"
  const v = Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 })
  return unit ? (unit === "%" ? `${v}%` : `${v} ${unit}`) : v
}

/** "≥ 1,000 views" or "≤ 2 h". */
export function describeTarget(t: NumberTarget, unit?: string | null): string {
  return `${t.direction === "down" ? "≤" : "≥"} ${formatValue(t.value, unit)}`
}
