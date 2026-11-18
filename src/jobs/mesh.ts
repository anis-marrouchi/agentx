import type { JobView } from "./api"
import type { JobRecord, JobRun, JobStore } from "./store"

// --- The job tree across nodes (#1861, phase 4) ---
//
// A job handed to an agent on another node is one row here (waiting on
// that node) and one row there, under the same id: `job-<delegation id>`,
// read by each side from the hand-off's chat. Nothing is copied between
// the two ledgers. This node asks the other one for its row when someone
// looks (GET /jobs/:id?tree=1, the Jobs page), and once a minute for the
// jobs still open, so the line here says what is happening there.
//
// A peer answers 404 for a job it does not have, and says with it whether
// it keeps a ledger (`ledger`: "on" or "off"). Only "on" means there is no
// such job. Still unknown there after UNKNOWN_GRACE_MS with no progress
// here, the hand-off never started there or was lost: the job is marked
// stalled, so its requester is told. A peer with its ledger off, or a
// version that does not say, may well have done the work: the job here
// keeps its own line and is never stalled by this (#1888).
//
// The minute pass reads PASS_SIZE jobs and goes on from there at the next
// one, so every open hand-off is read in turn, however many there are.

export interface RemoteJob {
  peer: string
  /** The job as the other node keeps it, with its runs and children there. */
  job?: JobView
  runs?: JobRun[]
  children?: JobView[]
  /** Why it could not be read. */
  error?: string
  /** The other node keeps a job ledger and has no such job. */
  unknown?: boolean
  /** The other node did not answer, or answered with an error. */
  down?: boolean
}

export interface JobMeshDeps {
  jobs: JobStore
  /** GET /jobs/<id> on the peer, with this node's mesh token. */
  fetchJob: (peer: string, id: string) => Promise<{ status: number; body: unknown }>
  /** Is the hand-off of this job still out (its answer not back yet)?
   *  While it is, its answer ends the job here (doors.delegationDone).
   *  Unset: always out, so the other node's end is only quoted. */
  handOffOut?: (job: JobRecord) => boolean
  log: (msg: string) => void
  now?: () => number
}

/** How the note of a job here quotes its status on the other node. */
export const REMOTE_NOTE = "there: "

const LINE_MAX = 300

/** How long a job handed to another node may stay unknown there, with no
 *  progress here, before it is marked stalled. Long enough for a hand-off
 *  queued behind a busy agent there to start. */
export const UNKNOWN_GRACE_MS = 6 * 3_600_000

/** How many jobs one minute pass reads. */
export const PASS_SIZE = 30

export class JobMesh {
  private busy = false
  /** Where the last pass stopped: the next one goes on after this row. */
  private after = 0

  constructor(private deps: JobMeshDeps) {}

  /** The job as its other node keeps it. Null for a job that is not on
   *  another node. Never throws: a peer that is down is an `error`. */
  async remoteOf(job: Pick<JobRecord, "id" | "peer" | "remoteId">): Promise<RemoteJob | null> {
    if (!job.peer) return null
    try {
      const r = await this.deps.fetchJob(job.peer, job.remoteId ?? job.id)
      const body = r.body as { job?: JobView; runs?: JobRun[]; children?: JobView[]; ledger?: unknown } | null
      if (r.status === 404) {
        if (body?.ledger === "on") return { peer: job.peer, unknown: true, error: "that node has no such job (it may not have started it yet)" }
        if (body?.ledger === "off") return { peer: job.peer, error: "that node keeps no jobs (its job ledger is off), so it cannot say" }
        return { peer: job.peer, error: "that node has no such job, or keeps no jobs (it runs an older version and cannot say which)" }
      }
      if (r.status !== 200 || !body?.job || typeof body.job.id !== "string") return { peer: job.peer, down: true, error: `that node answered ${r.status}` }
      return { peer: job.peer, job: body.job, runs: Array.isArray(body.runs) ? body.runs : [], children: Array.isArray(body.children) ? body.children : [] }
    } catch (e: any) {
      return { peer: job.peer, down: true, error: `that node did not answer (${String(e?.message ?? e).slice(0, 120)})` }
    }
  }

  /** One pass over the open jobs on other nodes, PASS_SIZE of them, going
   *  on where the last pass stopped: each keeps, as its note, the status
   *  line its node gives now. A job its node still does not know after
   *  UNKNOWN_GRACE_MS is marked stalled. A node that did not answer is not
   *  asked again in the same pass. One pass at a time. Returns how many
   *  were read. */
  async refresh(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    let read = 0
    try {
      let page = this.deps.jobs.openOnPeersPage(this.after, PASS_SIZE)
      // Past the last one: start again from the first.
      if (!page.jobs.length && this.after > 0) page = this.deps.jobs.openOnPeersPage(0, PASS_SIZE)
      this.after = page.jobs.length < PASS_SIZE ? 0 : page.last
      const down = new Set<string>()
      for (const job of page.jobs) {
        if (down.has(job.peer!)) continue
        const remote = await this.remoteOf(job)
        if (remote?.down) down.add(job.peer!)
        if (remote?.unknown) this.stallUnknown(job)
        if (!remote?.job) continue
        const said = String(remote.job.status ?? remote.job.state).replace(/\s+/g, " ").trim().slice(0, LINE_MAX)
        read++
        if (this.followEnd(job, remote.job.state, said)) continue
        const line = `${REMOTE_NOTE}${said}`
        if (job.note !== line || job.remoteId !== remote.job.id) this.deps.jobs.setRemote(job.id, remote.job.id, line)
      }
    } catch (e: any) {
      this.deps.log(`[jobs] reading other nodes failed: ${e?.message ?? e}`)
    } finally {
      this.busy = false
    }
    return read
  }

  /** The job ended on the other node, and its hand-off's answer is back
   *  (or will never come): nothing else ends it here. Done there is done
   *  here, with that node's line as the proof. Blocked, stalled or
   *  dropped there is stalled here, so the one who asked here is told
   *  (#1861: every open job has a run, a wake or a waiter with a due
   *  time; one that waits on a node whose job ended has none). True when
   *  it ended the job here. */
  private followEnd(job: JobRecord, state: string | undefined, said: string): boolean {
    if (!state || !["done", "dropped", "blocked", "stalled"].includes(state)) return false
    if (this.deps.handOffOut?.(job) ?? true) return false
    const now = this.deps.now?.() ?? Date.now()
    const line = `on ${job.peer}: ${said}`
    const ended = state === "done"
      ? this.deps.jobs.declare(job.id, { state: "done", proof: line }, { now })
      : this.deps.jobs.markStalled(job.id, line, now)
    if (ended) this.deps.log(`[jobs] ${job.id} ${state === "done" ? "done" : "stalled"}: ${line}`)
    return ended
  }

  private stallUnknown(job: JobRecord): void {
    const now = this.deps.now?.() ?? Date.now()
    if (now - job.updatedAt < UNKNOWN_GRACE_MS) return
    const hours = Math.floor((now - job.updatedAt) / 3_600_000)
    const reason = `${job.peer} has no record of this job ${hours} h after it was handed there: the hand-off did not start there, or was lost`
    if (this.deps.jobs.markStalled(job.id, reason, now)) this.deps.log(`[jobs] ${job.id} stalled: ${reason}`)
  }
}
