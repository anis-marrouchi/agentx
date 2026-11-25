// --- A held cron run retries when its hold ends (#2247) ---
//
// A scheduled run can end without starting: the Claude plan window is
// rejected or past the background threshold (dispatch_hold), the Codex
// plan says "try again at 1:30 PM", or the node had no room for an hour
// (no_room). The normal retry ladder (30 s … 60 min, about 81 min in all)
// stops long before most of those holds end, and the job lost its day.
//
// Here: whether a run was held, and until when. The scheduler then retries
// once the hold ends, as long as that is still inside the job's window,
// and reports the run as missed when no retry fits.

/** Retry this long after the hold's end, so the window has really reset. */
export const HOLD_RETRY_MARGIN_MS = 2 * 60_000
/** Hold with no known end (a node with no room): look again after this. */
export const HOLD_RECHECK_MS = 15 * 60_000
/** Hold retries for one scheduled run, whatever their cause. */
export const MAX_HOLD_RETRIES = 6

export type HoldCause = "plan limit" | "usage limit" | "no room on the machine"

export interface RunHold {
  cause: HoldCause
  /** When the hold ends (ms), when the run said so. */
  until?: number
}

interface HeldResponse {
  error?: string
  errorKind?: string
  retryAt?: number
}

/** The run's hold, or null when it was not held (it ran, or failed for
 *  another reason that the normal retry ladder handles). */
export function runHold(res: HeldResponse, now: number = Date.now()): RunHold | null {
  const text = res.error ?? ""
  if (!text) return null
  if (res.errorKind === "no_room") return { cause: "no room on the machine" }
  if (res.errorKind === "dispatch_hold") {
    return { cause: "plan limit", until: validTime(res.retryAt, now) ?? isoInText(text, now) }
  }
  // Codex: "You've hit your usage limit. … or try again at 1:30 PM."
  const codex = text.match(/usage limit[\s\S]*?try again at (\d{1,2}):(\d{2})\s*([AP]M)?/i)
  if (codex) return { cause: "usage limit", until: nextClock(+codex[1], +codex[2], codex[3], now) }
  // Claude Code /usage cap: "You will regain access on <date>."
  const regain = text.match(/regain access on ([^.\n]+?)(?:\.\s|\.$|$)/i)
  if (regain) return { cause: "usage limit", until: validTime(Date.parse(regain[1]), now) }
  return null
}

/** A time stated in the hold message: "(2026-11-20T11:00:00.000Z)". */
function isoInText(text: string, now: number): number | undefined {
  const m = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/)
  return m ? validTime(Date.parse(m[0]), now) : undefined
}

function validTime(t: number | undefined, now: number): number | undefined {
  return typeof t === "number" && Number.isFinite(t) && t > now - 60_000 ? t : undefined
}

/** The next time the clock shows h:mm on this machine (the Codex CLI
 *  states its reset in the machine's local time). */
function nextClock(h: number, m: number, ampm: string | undefined, now: number): number | undefined {
  if (m > 59 || h > 23 || (ampm && (h < 1 || h > 12))) return undefined
  let hour = h
  if (ampm) hour = (h % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0)
  const d = new Date(now)
  d.setHours(hour, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * When the hold retry should start, or null when none fits in the window.
 * `windowEnd` is the last time a retry may start (ms).
 */
export function holdRetryAt(hold: RunHold, now: number, windowEnd: number): number | null {
  const at = hold.until !== undefined ? Math.max(now, hold.until) + HOLD_RETRY_MARGIN_MS : now + HOLD_RECHECK_MS
  return at <= windowEnd ? at : null
}

/** The line that tells a job's owner its run was missed. Plain words: it
 *  can be read on a thread. */
export function missedRunText(
  jobId: string,
  cause: string,
  opts: { heldUntil?: number; nextRun?: Date; scheduledAt?: Date } = {},
): string {
  const lines = [
    `Scheduled job "${jobId}" did not run${opts.scheduledAt ? ` (due ${opts.scheduledAt.toISOString()})` : ""}: ${cause}.`,
  ]
  if (opts.heldUntil) lines.push(`The hold ends ${new Date(opts.heldUntil).toISOString()}, after the job's window.`)
  lines.push(opts.nextRun ? `Next regular run: ${opts.nextRun.toISOString()}.` : "No regular run is scheduled.")
  lines.push("If today's work still matters, run it yourself or ask for it once the hold ends.")
  return lines.join(" ")
}
