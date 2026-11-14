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
// A peer that does not know the job, or runs a version without the
// ledger, answers 404: the job here keeps its own line.

export interface RemoteJob {
  peer: string
  /** The job as the other node keeps it, with its runs and children there. */
  job?: JobView
  runs?: JobRun[]
  children?: JobView[]
  /** Why it could not be read. */
  error?: string
}

export interface JobMeshDeps {
  jobs: JobStore
  /** GET /jobs/<id> on the peer, with this node's mesh token. */
  fetchJob: (peer: string, id: string) => Promise<{ status: number; body: unknown }>
  log: (msg: string) => void
}

/** How the note of a job here quotes its status on the other node. */
export const REMOTE_NOTE = "there: "

const LINE_MAX = 300

export class JobMesh {
  private busy = false

  constructor(private deps: JobMeshDeps) {}

  /** The job as its other node keeps it. Null for a job that is not on
   *  another node. Never throws: a peer that is down is an `error`. */
  async remoteOf(job: Pick<JobRecord, "id" | "peer" | "remoteId">): Promise<RemoteJob | null> {
    if (!job.peer) return null
    try {
      const r = await this.deps.fetchJob(job.peer, job.remoteId ?? job.id)
      if (r.status === 404) return { peer: job.peer, error: "that node has no such job (it may not have started it yet, or runs an older version)" }
      const body = r.body as { job?: JobView; runs?: JobRun[]; children?: JobView[] } | null
      if (r.status !== 200 || !body?.job || typeof body.job.id !== "string") return { peer: job.peer, error: `that node answered ${r.status}` }
      return { peer: job.peer, job: body.job, runs: Array.isArray(body.runs) ? body.runs : [], children: Array.isArray(body.children) ? body.children : [] }
    } catch (e: any) {
      return { peer: job.peer, error: `that node did not answer (${String(e?.message ?? e).slice(0, 120)})` }
    }
  }

  /** One pass over the open jobs on other nodes: each keeps, as its note,
   *  the status line its node gives now. One pass at a time. Returns how
   *  many were read. */
  async refresh(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    let read = 0
    try {
      for (const job of this.deps.jobs.openOnPeers()) {
        const remote = await this.remoteOf(job)
        if (!remote?.job) continue
        const line = `${REMOTE_NOTE}${String(remote.job.status ?? remote.job.state).replace(/\s+/g, " ").trim().slice(0, LINE_MAX)}`
        if (job.note !== line || job.remoteId !== remote.job.id) this.deps.jobs.setRemote(job.id, remote.job.id, line)
        read++
      }
    } catch (e: any) {
      this.deps.log(`[jobs] reading other nodes failed: ${e?.message ?? e}`)
    } finally {
      this.busy = false
    }
    return read
  }
}
