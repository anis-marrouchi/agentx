import { existsSync, readdirSync, readFileSync } from "fs"
import { resolve } from "path"
import { runFileTime } from "./run-history"

// --- Movement on a schedule's goal issue (#863) ---
//
// Movement = any note (system notes too) or state change on the goal's
// issue, by anyone, bots included. Left out: label-only changes (the
// reader never returns them) and anything written inside one of this
// job's own run windows (start to end + 2 min, from the run records),
// because the job's own posts must not keep its goal "moving". By time,
// not by account: one bot account posts for several agents.

/** Slack after a run's end: a post made just after still counts as the run's. */
export const OWN_POST_SLACK_MS = 2 * 60_000
/** No movement for this long sends the job to goal check. */
export const NO_MOVEMENT_DAYS = 30
const DAY_MS = 86_400_000

/** How long a good issue read is reused (#2065). */
export const MOVEMENT_CACHE_MS = 6 * 3_600_000

/** Good issue reads by `provider:ref`, shared by the jobs on one issue.
 *  A cached read only ever lets a job run: a newer read can only add
 *  movement, so the caller reads fresh before it holds a job. Failed
 *  reads are never kept. */
export class MovementCache {
  private reads = new Map<string, { at: number; times: number[] }>()
  constructor(private ttlMs = MOVEMENT_CACHE_MS) {}

  get(key: string, now: number): number[] | null {
    const hit = this.reads.get(key)
    if (!hit) return null
    if (now - hit.at < this.ttlMs) return hit.times
    this.reads.delete(key)
    return null
  }

  set(key: string, now: number, times: number[]): void {
    this.reads.set(key, { at: now, times })
  }
}

export interface RunWindow { start: number; end: number }

/** The newest movement not made by the job itself; null when none. */
export function lastMovementAt(times: number[], windows: RunWindow[]): number | null {
  let last: number | null = null
  for (const t of times) {
    if (!Number.isFinite(t)) continue
    if (windows.some((w) => t >= w.start && t <= w.end + OWN_POST_SLACK_MS)) continue
    if (last === null || t > last) last = t
  }
  return last
}

/** Whole days since the clock: the newest of the last movement, the
 *  operator's last keep, and `floor` (the goal record's creation, so a new
 *  goal with no notes yet is not "still" for years). */
export function daysStill(now: number, parts: Array<number | null | undefined>): number {
  const clock = Math.max(...parts.filter((p): p is number => typeof p === "number" && Number.isFinite(p)), 0)
  return Math.floor((now - clock) / DAY_MS)
}

/** This job's run windows that started at or after `since`, read from its
 *  run records (`.agentx/cron/runs/<jobId>/*.json`). Unreadable files are
 *  skipped: a missed window only makes the job's own post count. */
export function cronRunWindows(runsDir: string, jobId: string, since: number, log?: (msg: string) => void): RunWindow[] {
  const dir = resolve(runsDir, jobId)
  if (!existsSync(dir)) return []
  const out: RunWindow[] = []
  for (const name of readdirSync(dir)) {
    const stamped = runFileTime(name)
    // The name is the start time; a long run may start a day before `since`.
    if (stamped !== null && stamped < since - DAY_MS) continue
    try {
      const r = JSON.parse(readFileSync(resolve(dir, name), "utf-8"))
      const start = Date.parse(r?.startedAt)
      const end = Date.parse(r?.completedAt)
      if (Number.isFinite(start) && start >= since - DAY_MS) out.push({ start, end: Number.isFinite(end) ? end : start })
    } catch (e: any) {
      log?.(`[cron-goal] run record ${jobId}/${name} unreadable: ${e?.message ?? e}`)
    }
  }
  return out
}
