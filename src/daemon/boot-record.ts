import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- Boot log: when the daemon started, and why the one before it stopped ---
//
// `agentx daemon status`, the dashboard header and GET /health answer "when
// was it last restarted, by whom, how often" from here.
//
//   * A stopping daemon leaves last-stop.json (who asked, which signal).
//   * The next daemon moves it into boot-log.json next to its start time.
//     No last-stop.json means the process before did not stop cleanly
//     (crash, kill -9, power loss) or was an older version.
//
// boot-history.json (agents/resume) stays as it is: it feeds the crash-loop
// brake and keeps 20 start times, too few to count a week of restarts.
//
// Pure functions over a directory, unit tested.

export const LAST_STOP_FILE = "last-stop.json"
export const BOOT_LOG_FILE = "boot-log.json"
const KEEP_BOOTS = 500
const DAY_MS = 86_400_000

export interface LastStop {
  at: string
  /** What asked, e.g. "agentx daemon restart"; null when nothing said. */
  by: string | null
  /** The signal the daemon stopped on. */
  reason: string
}

export interface BootEntry {
  /** Start time, ms. */
  at: number
  /** Who stopped the process before this one; null when unknown. */
  by: string | null
  /** Why the process before this one stopped; null when unknown. */
  reason: string | null
}

export interface RestartSummary {
  lastRestart: { at: string; by: string | null; reason: string | null; previousBootAt: string | null } | null
  /** Starts counted since local midnight and over seven days. `since` is the
   *  oldest start on record: later than a week ago means last7d is partial. */
  restarts: { today: number; last7d: number; since: string | null }
}

/** Called by a stopping daemon. Best effort: a failed write only costs the
 *  "by" of the next boot. */
export function writeLastStop(agentxDir: string, stop: LastStop): void {
  try {
    writeFileSync(resolve(agentxDir, LAST_STOP_FILE), JSON.stringify(stop) + "\n")
  } catch { /* the shutdown log line already says who asked */ }
}

function isEntry(e: unknown): e is BootEntry {
  return !!e && typeof e === "object" && typeof (e as BootEntry).at === "number"
}

/** The boot log, oldest first. Falls back to the start times in
 *  boot-history.json for a folder last used by an older version. */
export function readBootLog(agentxDir: string, seed?: number[]): BootEntry[] {
  try {
    const path = resolve(agentxDir, BOOT_LOG_FILE)
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"))
      if (Array.isArray(parsed)) {
        return parsed.filter(isEntry).map((e) => ({ at: e.at, by: e.by ?? null, reason: e.reason ?? null }))
      }
    }
  } catch { /* corrupt log → fall back to the seed */ }
  let times = seed
  if (!times) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(agentxDir, "boot-history.json"), "utf-8"))
      times = Array.isArray(parsed) ? parsed.filter((t) => typeof t === "number") : []
    } catch { times = [] }
  }
  return times.map((at) => ({ at, by: null, reason: null }))
}

/** Record this boot with what stopped the process before it, and return the
 *  log, this boot included. `seed` is earlier start times to begin from when
 *  no log exists yet. */
export function recordBootEntry(agentxDir: string, now = Date.now(), seed: number[] = []): BootEntry[] {
  const stopPath = resolve(agentxDir, LAST_STOP_FILE)
  let stop: LastStop | null = null
  try {
    if (existsSync(stopPath)) {
      const parsed = JSON.parse(readFileSync(stopPath, "utf-8"))
      if (typeof parsed?.reason === "string") stop = { at: String(parsed.at), by: typeof parsed.by === "string" ? parsed.by : null, reason: parsed.reason }
    }
  } catch { /* unreadable → unknown */ }
  // Removed either way, so one stop is never blamed for two boots.
  try { unlinkSync(stopPath) } catch { /* none */ }

  const earlier = readBootLog(agentxDir, seed).filter((e) => e.at < now)
  const log = [...earlier, { at: now, by: stop?.by ?? null, reason: stop?.reason ?? null }].slice(-KEEP_BOOTS)
  try {
    mkdirSync(agentxDir, { recursive: true })
    writeFileSync(resolve(agentxDir, BOOT_LOG_FILE), JSON.stringify(log))
  } catch { /* best effort: status then only knows this boot */ }
  return log
}

/** Last restart and restart counts, from the boot log. "Today" starts at
 *  midnight in the daemon's own time zone. */
export function restartSummary(log: BootEntry[], now = Date.now()): RestartSummary {
  const last = log[log.length - 1]
  const previous = log[log.length - 2]
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    lastRestart: last
      ? { at: iso(last.at), by: last.by, reason: last.reason, previousBootAt: previous ? iso(previous.at) : null }
      : null,
    restarts: {
      today: log.filter((e) => e.at >= midnight.getTime()).length,
      last7d: log.filter((e) => e.at > now - 7 * DAY_MS).length,
      since: log.length ? iso(log[0].at) : null,
    },
  }
}
