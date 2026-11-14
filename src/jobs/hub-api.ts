import type Database from "better-sqlite3"
import { handleJobsApi } from "./api"
import { dbFacts } from "./facts"
import { JobStore } from "./store"

// --- The Hub's read of the job ledger (#1861) ---
//
//   GET /api/admin/job-ledger        jobs, most recently active first, each
//                                    with its status line, and the count of
//                                    jobs in each state
//   GET /api/admin/job-ledger/<id>   one job, its runs, parent and children
//
// The same replies as the daemon's GET /jobs and GET /jobs/:id (api.ts),
// with the same query (?state= ?door= ?agent= ?requester= ?parent= ?roots=
// ?limit= ?offset=). Served by the dashboard after its admin token gate;
// another machine's jobs come through the dashboard's peer proxy.
//
// The path is not /api/admin/ledger/: that one is the cost ledger panel.

export const JOBS_HUB_PATH = "/api/admin/job-ledger"

/** One store per open database: its constructor checks the columns. */
const stores = new WeakMap<Database.Database, JobStore>()

function storeOf(db: Database.Database): JobStore {
  let store = stores.get(db)
  if (!store) { store = new JobStore(db); stores.set(db, store) }
  return store
}

/** Is this path the Hub's job ledger, or one job of it? */
export function isJobsHubPath(path: string): boolean {
  return path === JOBS_HUB_PATH || path.startsWith(JOBS_HUB_PATH + "/")
}

export function jobsHubReply(db: Database.Database | null, path: string, query: URLSearchParams, now: number): { status: number; body: unknown } {
  if (!isJobsHubPath(path)) return { status: 404, body: { error: "not found" } }
  if (!db) return { status: 503, body: { error: "the database is not open" } }
  return handleJobsApi("GET", "/jobs" + path.slice(JOBS_HUB_PATH.length), { store: storeOf(db), facts: dbFacts(db), query, now })
}
