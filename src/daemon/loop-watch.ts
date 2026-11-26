import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks"

/** A stall this long blocks every HTTP request, poll and timer in the daemon. */
export const LOOP_STALL_WARN_MS = 2_000
/** How often the watch reads and resets its histogram. */
export const LOOP_WATCH_INTERVAL_MS = 60_000

export interface LoopWatch { stop(): void }

/** The log line for one window, or null when the main thread kept up. */
export function loopStallLine(maxMs: number, p99Ms: number, windowMs: number, warnMs = LOOP_STALL_WARN_MS): string | null {
  if (!(maxMs >= warnMs)) return null
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  return `[loop] main thread blocked for up to ${s(maxMs)} in the last ${Math.round(windowMs / 1000)}s (p99 ${s(p99Ms)}); HTTP, polls and timers waited`
}

/**
 * Warn when the daemon's main thread stalls. better-sqlite3 runs every query
 * on that thread, so one slow read stops the whole daemon: requests queue,
 * the connection backlog fills and clients time out. This only measures and
 * logs; it changes nothing it watches.
 */
export function startLoopWatch(log: (line: string) => void, opts: { intervalMs?: number; warnMs?: number } = {}): LoopWatch {
  const intervalMs = opts.intervalMs ?? LOOP_WATCH_INTERVAL_MS
  const h: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  const timer = setInterval(() => {
    const line = loopStallLine(h.max / 1e6, h.percentile(99) / 1e6, intervalMs, opts.warnMs)
    if (line) log(line)
    h.reset()
  }, intervalMs)
  timer.unref?.()
  return { stop() { clearInterval(timer); h.disable() } }
}
