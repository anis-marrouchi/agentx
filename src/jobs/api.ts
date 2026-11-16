import { JOB_DOORS, JOB_STATES, OPEN_JOB_STATES, type JobDoor, type JobRecord, type JobRun, type JobState, type JobStore } from "./store"
import { statusLine, type JobFacts } from "./status"

// --- The daemon's /jobs endpoints (#1861) ---
//
// Read only, gated like /requests: loopback, or a mesh token.
//   GET /jobs       jobs, most recently active first.
//                   ?state=open|all|<state>[,<state>]  (default open)
//                   ?door= ?agent= ?requester= ?parent= ?roots=1
//                   ?limit= (1-500, default 100) ?offset=
//   GET /jobs/:id   one job, its runs, its parent and its children.
//                   An id it does not have is a 404 with `ledger`: "on"
//                   (there is no such job) or "off" (this node keeps no
//                   jobs, so the work may well be here). A 404 without
//                   `ledger` is a version that cannot tell (#1888).
// Each job carries `status`: its one line, derived from facts the daemon
// has (status.ts), never from what the agent says about itself.

export const JOBS_LIMIT = 100
export const JOBS_LIMIT_MAX = 500

export interface JobsApiDeps {
  store: JobStore
  /** What the daemon knows about the job's runs now. Unset: only what
   *  the ledger holds. */
  facts?: (job: JobRecord, runs: () => JobRun[]) => JobFacts
  query?: URLSearchParams
  now?: number
  /** This node keeps no jobs (`requests.jobs.enabled` off). A job it does
   *  not have then says nothing about the work: the 404 says so. */
  ledgerOff?: boolean
}

export interface JobView extends JobRecord {
  status: string
}

interface ApiReply { status: number; body: unknown }

const err = (status: number, error: string): ApiReply => ({ status, body: { error } })

/** Facts from the ledger alone: when the last linked run ended. */
export function ledgerFacts(runs: JobRun[]): JobFacts {
  let last: number | null = null
  for (const r of runs) if (r.finishedAt !== null && (last === null || r.finishedAt > last)) last = r.finishedAt
  return { lastRunEndedAt: last }
}

export function jobView(job: JobRecord, deps: Pick<JobsApiDeps, "store" | "facts">, now: number): JobView {
  let cached: JobRun[] | null = null
  const runs = () => (cached ??= deps.store.runs(job.id))
  const facts = deps.facts ? deps.facts(job, runs) : ledgerFacts(runs())
  return { ...job, status: statusLine(job, facts, now) }
}

function parseStates(raw: string | null): readonly JobState[] | undefined | string {
  const v = (raw ?? "open").trim().toLowerCase()
  if (v === "open") return OPEN_JOB_STATES
  if (v === "all") return undefined
  const states = v.split(",").map((s) => s.trim()).filter(Boolean)
  const bad = states.find((s) => !(JOB_STATES as readonly string[]).includes(s))
  if (bad || !states.length) return `state must be open, all, or any of: ${JOB_STATES.join(", ")}`
  return states as JobState[]
}

function whole(p: URLSearchParams, name: string, min: number, max: number): number | undefined | string {
  const v = p.get(name)
  if (v === null) return undefined
  const n = Number(v)
  return v.trim() && Number.isInteger(n) && n >= min && n <= max ? n : `${name} must be a whole number from ${min} to ${max}`
}

export function handleJobsApi(method: string, path: string, deps: JobsApiDeps): ApiReply {
  if (method !== "GET") return err(405, "The jobs ledger is read here. A run states its job's state with its own tool.")
  const now = deps.now ?? Date.now()
  const p = deps.query ?? new URLSearchParams()

  if (path === "/jobs" || path === "/jobs/") {
    const states = parseStates(p.get("state"))
    if (typeof states === "string") return err(400, states)
    const door = p.get("door")?.trim().toLowerCase()
    if (door && !(JOB_DOORS as readonly string[]).includes(door)) return err(400, `door must be one of: ${JOB_DOORS.join(", ")}`)
    const limit = whole(p, "limit", 1, JOBS_LIMIT_MAX)
    if (typeof limit === "string") return err(400, limit)
    const offset = whole(p, "offset", 0, Number.MAX_SAFE_INTEGER)
    if (typeof offset === "string") return err(400, offset)
    const { items, total } = deps.store.query({
      states, door: door as JobDoor | undefined,
      assignee: p.get("agent")?.trim() || undefined,
      requester: p.get("requester")?.trim() || undefined,
      parentId: p.get("parent")?.trim() || undefined,
      roots: p.get("roots") === "1",
      limit: limit ?? JOBS_LIMIT, offset,
    })
    return { status: 200, body: { jobs: items.map((j) => jobView(j, deps, now)), total, counts: deps.store.counts() } }
  }

  const id = decodeURIComponent(path.slice("/jobs/".length))
  if (!id || id.includes("/")) return err(404, "not found")
  const job = deps.store.get(id)
  if (!job) return { status: 404, body: { error: `no job "${id}"`, ledger: deps.ledgerOff ? "off" : "on" } }
  const parent = job.parentId ? deps.store.get(job.parentId) : null
  return {
    status: 200,
    body: {
      job: jobView(job, deps, now),
      runs: deps.store.runs(id),
      parent: parent ? jobView(parent, deps, now) : null,
      children: deps.store.children(id).map((c) => jobView(c, deps, now)),
    },
  }
}
