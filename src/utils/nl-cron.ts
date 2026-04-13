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

/**
 * Main entry. Returns `null` if we don't recognize the phrasing.
 */
export function parseEnglishToCron(raw: string): NlCronResult | null {
  const text = raw.trim().toLowerCase()
  if (!text) return null

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
