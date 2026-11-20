import cronstrue from "cronstrue"

// --- Natural-language → cron ---
//
// Hand-coded pattern matcher for the dozen English phrasings people actually
// type. Covers every morning/evening, weekdays/weekends, every N minutes,
// every Monday, daily at X, first of every month, etc.
//
// Returns `null` for anything unrecognized rather than guessing — the caller
// should surface the error to the user with a list of supported phrasings.

export interface NlCronResult {
  /** Standard 5-field cron expression. */
  cron: string
  /** Human-readable rendering from cronstrue. */
  human: string
  /** The bit of input that matched (useful for error messages + id generation). */
  matched: string
  /** One-time schedule (#2004): the single run, as an ISO UTC time. The
   *  job runs once at this time and then switches itself off. */
  runAt?: string
}

export interface NlCronOptions {
  /** "Now" for "today"/"tomorrow" and past checks. Default: the clock. */
  now?: Date
  /** IANA timezone the wall-clock time is read in. Default: UTC. */
  timezone?: string
}

interface Time { h: number; m: number }

const DAY_OF_WEEK: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2, tues: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4, thurs: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}

const DEFAULT_TIMES: Record<string, Time> = {
  morning: { h: 9, m: 0 },
  afternoon: { h: 14, m: 0 },
  evening: { h: 18, m: 0 },
  night: { h: 22, m: 0 },
  noon: { h: 12, m: 0 },
  midnight: { h: 0, m: 0 },
}

function humanize(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: false })
  } catch {
    return cron
  }
}

/**
 * Pull out the first "at HH(:MM)?(am|pm)?" clause. Also accepts bare
 * "noon" / "midnight". Returns null if nothing time-like is present.
 */
function extractTime(text: string): Time | null {
  // "at noon" / "at midnight" / standalone "noon" / "midnight"
  if (/\b(noon|midday)\b/.test(text)) return DEFAULT_TIMES.noon
  if (/\bmidnight\b/.test(text)) return DEFAULT_TIMES.midnight

  // "at 9" / "at 9am" / "at 9:30am" / "at 14:30" / "by 9am"
  const m = text.match(/\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = m[2] ? parseInt(m[2], 10) : 0
    const ampm = m[3]
    if (ampm === "pm" && h < 12) h += 12
    if (ampm === "am" && h === 12) h = 0
    if (h > 23 || min > 59) return null
    return { h, m: min }
  }

  return null
}

// ── Raw cron (#2004) ─────────────────────────────────────────────────

const CRON_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]

/** A plain 5-field cron (numbers, `*`, `,`, `-`, `/`) with every number in range. */
function parseRawCron(text: string): string | null {
  const fields = text.split(/\s+/)
  if (fields.length !== 5) return null
  for (let i = 0; i < 5; i++) {
    if (!/^[\d*,\-/]+$/.test(fields[i])) return null
    const [lo, hi] = CRON_RANGES[i]
    for (const n of fields[i].match(/\d+/g) ?? []) {
      const v = parseInt(n, 10)
      // After "/" is a step, not a value.
      if (fields[i].includes(`/${n}`) ? v < 1 : v < lo || v > hi) return null
    }
  }
  return fields.join(" ")
}

// ── One-time (#2004) ─────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
const ONE_TIME_RE = new RegExp(`\\b(once|today|tomorrow|${MONTH_RE})\\b|\\d{4}-\\d{2}-\\d{2}`)

/** Wall-clock date and time in `timeZone` → the UTC instant. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const offset = (at: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]))
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at
  }
  const first = guess - offset(guess)
  return new Date(guess - offset(first))
}

/** Today's date in `timeZone`. */
function zonedDate(now: Date, timeZone: string): { y: number; mo: number; d: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now).map((x) => [x.type, Number(x.value)]))
  return { y: p.year, mo: p.month, d: p.day }
}

function oneTime(at: Date, wall: { mo: number; d: number; h: number; mi: number }, now: Date): NlCronResult | null {
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null
  const cron = `${wall.mi} ${wall.h} ${wall.d} ${wall.mo} *`
  return { cron, human: `once, ${at.toISOString()}`, matched: `once ${at.toISOString().slice(0, 16)}`, runAt: at.toISOString() }
}

/**
 * "tomorrow at 9", "once on 20 november at 09:05", "on nov 20 at 9am",
 * "on 2026-11-20 at 21:05", or an ISO time. Returns null when the date or
 * time is missing, does not exist, or is already past: a one-time phrase is
 * never turned into a daily schedule.
 */
function parseOneTime(raw: string, text: string, now: Date, timeZone: string): NlCronResult | null {
  // An ISO time with its own offset needs no timezone.
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?$/i)
  if (iso) {
    const [, y, mo, d, h, mi, zone] = iso
    if (!validDay(+y, +mo, +d) || +h > 23 || +mi > 59) return null
    if (!zone) return oneTime(zonedToUtc(+y, +mo, +d, +h, +mi, timeZone), { mo: +mo, d: +d, h: +h, mi: +mi }, now)
    // With its own offset, the cron shows the time in UTC.
    const at = new Date(raw.trim())
    return oneTime(at, { mo: at.getUTCMonth() + 1, d: at.getUTCDate(), h: at.getUTCHours(), mi: at.getUTCMinutes() }, now)
  }

  // Recurring words and one-time words together are ambiguous.
  if (/\b(every|each|daily|hourly|weekdays?|weekends?)\b/.test(text)) return null
  const time = extractTime(text)
  if (!time) return null

  const today = zonedDate(now, timeZone)
  let date: { y: number; mo: number; d: number } | null = null
  let m: RegExpMatchArray | null
  if (/\btoday\b/.test(text)) date = today
  else if (/\btomorrow\b/.test(text)) {
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1))
    date = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
  } else if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    date = { y: +m[1], mo: +m[2], d: +m[3] }
  } else {
    let mo = 0, d = 0
    if ((m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`)))) {
      d = +m[1]; mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1
    } else if ((m = text.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
      mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1; d = +m[2]
    }
    if (!mo) return null
    // No year given: this year, or next year when the date has passed.
    date = { y: today.y, mo, d }
    if (validDay(date.y, mo, d) && zonedToUtc(date.y, mo, d, time.h, time.m, timeZone) <= now) date.y++
  }
  if (!validDay(date.y, date.mo, date.d)) return null
  const at = zonedToUtc(date.y, date.mo, date.d, time.h, time.m, timeZone)
  return oneTime(at, { mo: date.mo, d: date.d, h: time.h, mi: time.m }, now)
}

function validDay(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * Main entry. Returns `null` if we don't recognize the phrasing.
 */
export function parseEnglishToCron(raw: string, opts: NlCronOptions = {}): NlCronResult | null {
  const text = raw.trim().toLowerCase()
  if (!text) return null

  // A raw cron is taken as given (#2004).
  const rawCron = parseRawCron(text)
  if (rawCron) return { cron: rawCron, human: humanize(rawCron), matched: rawCron }
  if (/^[\d*,\-/]+(\s+[\d*,\-/]+){4}$/.test(text)) return null // cron-shaped but out of range

  // A one-time phrase is a single run or nothing, never daily (#2004).
  if (ONE_TIME_RE.test(text) || /^\d{4}-\d{2}-\d{2}t/.test(text)) {
    return parseOneTime(raw, text, opts.now ?? new Date(), opts.timezone ?? "UTC")
  }

  // ── every N minutes / every minute ─────────────────────────────────
  let m: RegExpMatchArray | null
  if ((m = text.match(/\bevery\s+(\d+)\s*(minutes|mins|m)\b/))) {
    const n = parseInt(m[1], 10)
    if (n < 1 || n > 59) return null
    return { cron: `*/${n} * * * *`, human: humanize(`*/${n} * * * *`), matched: m[0] }
  }
  if (/\bevery\s+minute\b/.test(text)) {
    return { cron: `* * * * *`, human: humanize(`* * * * *`), matched: "every minute" }
  }

  // ── every hour / hourly / every N hours ────────────────────────────
  if ((m = text.match(/\bevery\s+(\d+)\s*(hours|hrs|h)\b/))) {
    const n = parseInt(m[1], 10)
    if (n < 1 || n > 23) return null
    return { cron: `0 */${n} * * *`, human: humanize(`0 */${n} * * *`), matched: m[0] }
  }
  if (/\b(every hour|hourly)\b/.test(text)) {
    return { cron: `0 * * * *`, human: humanize(`0 * * * *`), matched: "every hour" }
  }

  const time = extractTime(text)

  // ── keyword-default times (every morning/evening/…) ────────────────
  let dayKeywordTime: Time | null = null
  for (const [kw, t] of Object.entries(DEFAULT_TIMES)) {
    if (kw === "noon" || kw === "midnight") continue
    if (new RegExp(`\\b(every\\s+)?${kw}s?\\b`).test(text)) {
      dayKeywordTime = t
      break
    }
  }
  const resolvedTime = time || dayKeywordTime
  // If we have no time at all, we can't build a cron for most patterns.

  // ── first / nth day of every month ─────────────────────────────────
  const domMatch = text.match(/\b(first|1st|2nd|3rd|last|(\d+)(?:st|nd|rd|th)?)\s+(day\s+)?of\s+(every|each|the)\s+month\b/)
  if (domMatch) {
    const tok = domMatch[1]
    let dom = 1
    if (tok === "last") return null // cron doesn't cleanly support L; punt
    else if (/^\d+(st|nd|rd|th)?$/.test(tok)) dom = parseInt(tok, 10)
    else if (tok === "first" || tok === "1st") dom = 1
    else if (tok === "2nd") dom = 2
    else if (tok === "3rd") dom = 3
    if (dom < 1 || dom > 31) return null
    const t = resolvedTime || { h: 9, m: 0 }
    const cron = `${t.m} ${t.h} ${dom} * *`
    return { cron, human: humanize(cron), matched: domMatch[0] }
  }

  // ── named days of the week (mon, tue…) ─────────────────────────────
  //    "every monday at 9" / "on mondays" / "every monday and friday at 10"
  //
  // We require a structural anchor ("every"/"on"/"each") before the first day
  // to avoid false positives like "sun aligns with mars".
  const dayTokens: number[] = []
  const dayWordsAlt = Object.keys(DAY_OF_WEEK).join("|")
  const anchorRe = new RegExp(`\\b(?:every|on|each|by)\\s+((?:${dayWordsAlt})s?(?:\\s*(?:,|and|&)\\s*(?:${dayWordsAlt})s?)*)\\b`)
  const anchor = text.match(anchorRe)
  if (anchor) {
    const list = anchor[1]
    for (const w of Object.keys(DAY_OF_WEEK)) {
      if (new RegExp(`\\b${w}s?\\b`).test(list)) {
        const n = DAY_OF_WEEK[w]
        if (!dayTokens.includes(n)) dayTokens.push(n)
      }
    }
  }
  if (dayTokens.length) {
    const t = resolvedTime || { h: 9, m: 0 }
    dayTokens.sort((a, b) => a - b)
    const dow = dayTokens.join(",")
    const cron = `${t.m} ${t.h} * * ${dow}`
    return { cron, human: humanize(cron), matched: `on ${dow}` }
  }

  // ── weekdays / weekends ────────────────────────────────────────────
  if (/\b(weekday|workday|business day)s?\b/.test(text)) {
    const t = resolvedTime || { h: 9, m: 0 }
    const cron = `${t.m} ${t.h} * * 1-5`
    return { cron, human: humanize(cron), matched: "weekdays" }
  }
  if (/\bweekends?\b/.test(text)) {
    const t = resolvedTime || { h: 9, m: 0 }
    const cron = `${t.m} ${t.h} * * 0,6`
    return { cron, human: humanize(cron), matched: "weekends" }
  }

  // ── daily / every day ──────────────────────────────────────────────
  if (/\b(every day|daily|each day)\b/.test(text) || dayKeywordTime) {
    const t = resolvedTime || { h: 9, m: 0 }
    const cron = `${t.m} ${t.h} * * *`
    return { cron, human: humanize(cron), matched: dayKeywordTime ? (Object.entries(DEFAULT_TIMES).find(([, v]) => v === dayKeywordTime)?.[0] || "daily") : "daily" }
  }

  // ── bare "at 9am" → assume daily ───────────────────────────────────
  if (time) {
    const cron = `${time.m} ${time.h} * * *`
    return { cron, human: humanize(cron), matched: `at ${time.h}:${String(time.m).padStart(2, "0")}` }
  }

  return null
}

/** Build a stable slug for cron id from the matched phrase + agent. */
export function slugifyScheduleId(phrase: string, agent: string): string {
  const slug = phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `${slug || "job"}-${agent}`
}
