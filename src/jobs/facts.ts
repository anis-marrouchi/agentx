import type Database from "better-sqlite3"
import type { JobRecord, JobRun } from "./store"
import type { JobFacts } from "./status"

// --- What the database knows about a job's runs (#1861) ---
//
// The daemon and the Hub both read the same traces: a run still in
// flight is the job's live run, its newest step is its last tool call.
// A database without the traces answers with what the ledger holds.

const IN_FLIGHT = "in-flight"

/** Facts for one job, from its linked runs and their traces. */
export function dbFacts(db: Database.Database): (job: JobRecord, runs: () => JobRun[]) => JobFacts {
  let lastStep: Database.Statement | null | undefined
  return (_job, runs) => {
    const list = runs()
    let lastRunEndedAt: number | null = null
    let live: JobRun | null = null
    for (const r of list) {
      if (r.status === IN_FLIGHT && r.startedAt !== null) { if (!live || r.startedAt > (live.startedAt ?? 0)) live = r }
      else if (r.finishedAt !== null && (lastRunEndedAt === null || r.finishedAt > lastRunEndedAt)) lastRunEndedAt = r.finishedAt
    }
    if (!live) return { liveRun: null, lastRunEndedAt }
    let lastToolAt: number | null = null
    if (lastStep === undefined) {
      try { lastStep = db.prepare("SELECT MAX(started_at) AS at FROM task_trace_steps WHERE task_id = ?") } catch { lastStep = null }
    }
    try { lastToolAt = (lastStep?.get(live.runId) as { at: number | null } | undefined)?.at ?? null } catch { lastToolAt = null }
    return { liveRun: { runId: live.runId, startedAt: live.startedAt!, lastToolAt }, lastRunEndedAt }
  }
}
