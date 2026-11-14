import type { JobRecord } from "./store"

// --- A job's status line, from facts the daemon has (#1861, point 5) ---
//
// Never what the agent says about itself: the live run and its last tool
// call, the armed wake, the named waiter, or the absence of all three.

/** What the daemon knows about a job's runs right now. */
export interface JobFacts {
  /** The run on it now, when there is one. */
  liveRun?: { runId: string; startedAt: number; lastToolAt?: number | null } | null
  /** When its last run ended. */
  lastRunEndedAt?: number | null
}

/** "40 s", "12 min", "3 h", "2 d". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

/** "18:00" today, "Nov 15 18:00" another day, in the node's own time. */
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (new Date(now).toDateString() === d.toDateString()) return hm
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hm}`
}

/** Does the job hold the invariant: a live run, an armed wake, or a named
 *  waiter with a due time? Closed, blocked and stalled jobs are not asked:
 *  blocked and stalled are already someone's to answer. */
export function isOwned(job: JobRecord, facts: JobFacts, now: number): boolean {
  if (job.state === "done" || job.state === "dropped" || job.state === "blocked" || job.state === "stalled") return true
  if (facts.liveRun) return true
  if (job.wakeAt !== null) return true
  if (job.state === "waiting" && job.waitingOn && job.until !== null && job.until > now) return true
  return false
}

/** Why an unowned job is stalled, in words. */
export function stallReason(job: JobRecord, facts: JobFacts, now: number): string {
  if (job.state === "waiting") {
    if (!job.waitingOn) return "waiting, but on nobody named"
    if (job.until === null) return `waiting on ${job.waitingOn} with no due time`
    return `waited on ${job.waitingOn} until ${clock(job.until, now)}, and nothing came`
  }
  if (facts.lastRunEndedAt) return `run ended ${ago(now - facts.lastRunEndedAt)} ago with no state`
  return "no run, no wake and no one it waits on"
}

/** One line for the Jobs page and the issue. */
export function statusLine(job: JobRecord, facts: JobFacts, now: number): string {
  if (job.state === "done") return job.proof ? `done: ${job.proof}` : "done"
  if (job.state === "dropped") return "dropped"
  if (facts.liveRun) {
    const at = facts.liveRun.lastToolAt
    return at ? `working, last tool call ${ago(now - at)} ago` : `working, run started ${ago(now - facts.liveRun.startedAt)} ago`
  }
  if (job.state === "blocked") return job.note ? `blocked: ${job.note}` : "blocked"
  if (job.state === "stalled") return `stalled, ${job.note ?? stallReason(job, facts, now)}`
  if (job.state === "continue" && job.wakeAt !== null) {
    return `sleeping until ${clock(job.wakeAt, now)}${job.note ? ` for ${job.note}` : ""}`
  }
  if (job.state === "waiting" && job.waitingOn) {
    return `waiting on ${job.waitingOn}${job.until !== null ? ` until ${clock(job.until, now)}` : ""}`
  }
  // Open, and nothing holds it: what the minute check marks as stalled.
  return `nobody on it, ${stallReason(job, facts, now)}`
}
