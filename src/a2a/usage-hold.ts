// --- A hand-off to an agent over its usage limit waits for the reset (#2467 item 2) ---
//
// A callee run that fails because the callee's plan is over its limit used
// to end the hand-off as an error (76 of them in 8 days). Here: whether a
// run failed on a usage limit, and when that limit resets, read from the
// error the run ended with. The delegation manager keeps the hand-off open
// and sends it again after the reset.
//
// The messages seen on the Mac (handoffs.result_text, 19-27 Nov):
//   Claude plan limit reached: … held until it resets in about 154 min (2026-11-23T22:00:00.000Z) …
//   You've hit your 5-hour limit · resets 11pm (Africa/Tunis) · out of usage credits
//   You've hit your weekly limit · resets Nov 27 at 5pm (Africa/Tunis) · out of usage credits
//   You've hit your usage limit. Upgrade to Pro (…) … or try again at Nov 24th, 2026 1:33 AM.
// plus the forms the cron hold retry reads (#2247): "try again at 1:30 PM",
// "regain access on <date>".

import { runHold } from "@/crons/hold-retry"

/** Send again this long after the reset, so the window has really reset. */
export const LIMIT_HOLD_MARGIN_MS = 2 * 60_000
/** A limit with no reset time in its message: look again after this. */
export const LIMIT_HOLD_UNKNOWN_MS = 30 * 60_000
/** Holds for one hand-off; past them it ends as an error, as before. */
export const MAX_LIMIT_HOLDS = 3

/** The first line of a hand-off sent again after its callee's limit reset. */
export const LIMIT_NOTE = "[Sent again after a usage limit: an earlier run of this hand-off stopped because your plan was over its limit. Check what it already did before you redo it.]\n\n"

interface FailedRun {
  error?: string
  errorKind?: string
  retryAt?: number
}

export interface LimitHold {
  /** When the limit resets (ms), when the message says. */
  until?: number
}

// Only the run's error is read, never an answer: an answer that talks of a
// limit is the callee's own words. "drain limit" (a restart) and "limit
// (N)" (the resume step) are not usage limits.
const LIMIT = /hit your (?:[\w-]+ )?limit|usage limit|plan limit reached|out of usage credits|regain access on/i

/** The usage limit a callee run failed on, or null when it failed for
 *  another reason (or did not fail). */
export function usageLimitHold(r: FailedRun, now: number = Date.now()): LimitHold | null {
  const text = r.error ?? ""
  if (!text) return null
  const kindSays = r.errorKind === "dispatch_hold" || r.errorKind === "usage_cap"
  if (!kindSays && !LIMIT.test(text)) return null
  const until = valid(r.retryAt, now)
    ?? runHold({ error: text, ...(r.errorKind ? { errorKind: r.errorKind } : {}), ...(r.retryAt ? { retryAt: r.retryAt } : {}) }, now)?.until
    ?? isoIn(text, now)
    ?? claudeReset(text, now)
    ?? codexDate(text, now)
  return until !== undefined ? { until } : {}
}

/** When to send it again: after the reset and a margin, or a while later
 *  when the reset is not known. */
export function limitRetryAt(hold: LimitHold, now: number): number {
  return hold.until !== undefined ? Math.max(now, hold.until) + LIMIT_HOLD_MARGIN_MS : now + LIMIT_HOLD_UNKNOWN_MS
}

function valid(t: number | undefined, now: number): number | undefined {
  return typeof t === "number" && Number.isFinite(t) && t > now - 60_000 ? t : undefined
}

function isoIn(text: string, now: number): number | undefined {
  const m = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/)
  return m ? valid(Date.parse(m[0]), now) : undefined
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Claude Code: "resets 11pm (Africa/Tunis)", "resets 2:30pm (UTC)",
 *  "resets Nov 27 at 5pm (Africa/Tunis)". The clock is in the zone named. */
export function claudeReset(text: string, now: number): number | undefined {
  const m = text.match(/resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i)
  if (!m) return undefined
  const [, mon, day, h, min, ampm, zone] = m
  const hour = (+h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0)
  const minute = min ? +min : 0
  if (+h < 1 || +h > 12 || minute > 59) return undefined
  const today = partsIn(now, zone.trim())
  if (!today) return undefined
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase())
    if (month < 0) return undefined
    // No year: this year, or next when that date has passed (a reset is
    // never months behind).
    for (const year of [today.year, today.year + 1]) {
      const t = zonedToUtc(year, month, +day, hour, minute, zone.trim())
      if (t !== undefined && t > now - 60_000) return t
    }
    return undefined
  }
  const t = zonedToUtc(today.year, today.month, today.day, hour, minute, zone.trim())
  if (t === undefined) return undefined
  return t > now ? t : zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone.trim())
}

/** Codex: "try again at Nov 24th, 2026 1:33 AM", in this machine's time. */
export function codexDate(text: string, now: number): number | undefined {
  const m = text.match(/try again at ([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i)
  if (!m) return undefined
  const month = MONTHS.indexOf(m[1].toLowerCase())
  const h = +m[4]
  if (month < 0 || h < 1 || h > 12 || +m[5] > 59) return undefined
  const hour = (h % 12) + (m[6].toUpperCase() === "PM" ? 12 : 0)
  // Codex gives no zone: this reads the time in this machine's zone
  // (the Codex CLI prints its local time; clawd runs on UTC).
  return valid(new Date(+m[3], month, +m[2], hour, +m[5], 0, 0).getTime(), now)
}

/** The calendar date at `at` in a time zone; undefined for a zone this
 *  runtime does not know. */
function partsIn(at: number, zone: string): { year: number; month: number; day: number } | undefined {
  const p = zoneParts(at, zone)
  return p ? { year: p.year, month: p.month, day: p.day } : undefined
}

function zoneParts(at: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
  } catch {
    return undefined
  }
  const get = (type: string) => +(fmt.formatToParts(at).find((x) => x.type === type)?.value ?? NaN)
  const out = { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute") }
  return Object.values(out).every(Number.isFinite) ? out : undefined
}

/** The instant the wall clock in `zone` shows this date and time. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | undefined {
  const wall = Date.UTC(year, month, day, hour, minute)
  let guess = wall
  // Two passes settle the zone's offset, also across a DST change.
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(guess, zone)
    if (!p) return undefined
    guess += wall - Date.UTC(p.year, p.month, p.day, p.hour, p.minute)
  }
  return guess
}
