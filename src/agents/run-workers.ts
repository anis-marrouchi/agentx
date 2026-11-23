// --- The workers a run starts (#2145) ---
//
// New-user feedback on the Hub (2026-11-23): "I can see the workers that
// are launched by them". The live sidebar lists, under each agent run, the
// work that run set going:
//
//   handoff   an agent it handed work to (send_agent, /task from a turn:
//             a dlg- hand-off), on this machine or on a mesh peer
//   workflow  a workflow it started from its turn (agentx_workflow start,
//             run.meta.startedByRun), or a sub-run of the workflow run it
//             works in (run.parentRunId)
//
// Each one is sent on its parent's entry in GET /agents (runningTasks[].
// workers), so the Hub reads it from the live snapshot it already polls:
// no new route. A run started for another (agent.call, mesh.delegate, a
// hand-off on a peer) carries its parent in its own entry
// (runningTasks[].parent): the Hub links the two across machines.

/** The run that started this one: its running task id, its agent and the
 *  node it runs on (config.node.id), when that is another machine. */
export interface RunParent {
  taskId: string
  agentId: string
  node?: string
}

export type WorkerStatus = "working" | "done" | "failed" | "waiting"

/** One worker, as GET /agents sends it on its parent run. */
export interface RunWorker {
  kind: "handoff" | "workflow"
  /** The hand-off (dlg-…) or the workflow run id. */
  id: string
  title: string
  status: WorkerStatus
  startedAt: string
  endedAt?: string
  /** Who does the work: the callee, or the agent that started the run. */
  agentId?: string
  /** The mesh peer it runs on; absent on this machine. */
  peer?: string
  /** Its own run on this machine (the callee's running task id). */
  taskId?: string
  /** The workflow, for a link to its page. */
  workflowId?: string
}

/** How long an ended worker stays under its parent. */
export const WORKER_DONE_WINDOW_MS = 3_600_000
/** At most this many workers per run, newest first. */
export const WORKERS_PER_RUN = 8

const cap = (s: unknown, n: number): string => String(s ?? "").slice(0, n)

/** The parent a caller put on a run's context, checked; undefined when it
 *  is not a well-formed one. Only shown, never trusted for access. */
export function parentRunOf(context: unknown): RunParent | undefined {
  const p = (context as { parentRun?: unknown } | null | undefined)?.parentRun as Record<string, unknown> | undefined
  if (!p || typeof p !== "object") return undefined
  if (typeof p.taskId !== "string" || !p.taskId || typeof p.agentId !== "string" || !p.agentId) return undefined
  return { taskId: cap(p.taskId, 80), agentId: cap(p.agentId, 80), ...(typeof p.node === "string" && p.node ? { node: cap(p.node, 80) } : {}) }
}

/** A hand-off status, in the sidebar's four words. */
export function handoffStatus(status: string): WorkerStatus {
  if (status === "running") return "working"
  if (status === "done") return "done"
  if (status === "waiting") return "waiting"
  return "failed" // error, timeout, lost
}

/** A workflow run status, in the sidebar's four words. */
export function workflowStatus(status: string): WorkerStatus {
  if (status === "running") return "working"
  if (status === "paused") return "waiting"
  if (status === "completed") return "done"
  return "failed" // failed, canceled
}

/** One recent hand-off, as DelegationManager keeps it in memory. */
export interface HandoffEntry {
  id: string
  callee: string
  peer?: string
  status: string
  startedAt: number
  endedAt?: number
  callerRun?: string
  calleeRun?: string
  request?: string
}

/** The few fields of a workflow run read here. */
export interface RunLike {
  id: string
  workflowId: string
  status: string
  parentRunId?: string | null
  createdAt: string
  updatedAt: string
  meta?: { title?: string; startedBy?: string; startedByRun?: string }
}

/** Is it still worth showing: going, or ended within the window. */
function fresh(status: WorkerStatus, endedMs: number, now: number): boolean {
  return status === "working" || status === "waiting" || (Number.isFinite(endedMs) && now - endedMs <= WORKER_DONE_WINDOW_MS)
}

/**
 * The workers of each running task: `tasks` are this node's running
 * tasks (id, and the workflow run each works in), `handoffs` the
 * delegation manager's recent hand-offs, `runs` the recent workflow runs.
 * Keyed by the parent's task id; newest first, WORKERS_PER_RUN at most.
 */
export function workersByRun(
  tasks: ReadonlyArray<{ id: string; workflow?: { runId: string } }>,
  handoffs: ReadonlyArray<HandoffEntry>,
  runs: ReadonlyArray<RunLike>,
  now: number = Date.now(),
): Map<string, RunWorker[]> {
  const out = new Map<string, RunWorker[]>()
  const ids = new Set(tasks.map((t) => t.id))
  const byWorkflowRun = new Map<string, string>()
  for (const t of tasks) if (t.workflow?.runId) byWorkflowRun.set(t.workflow.runId, t.id)
  const add = (parent: string, w: RunWorker) => {
    const list = out.get(parent) ?? []
    if (!list.some((x) => x.kind === w.kind && x.id === w.id)) list.push(w)
    out.set(parent, list)
  }
  for (const h of handoffs) {
    if (!h.callerRun || !ids.has(h.callerRun)) continue
    const status = handoffStatus(h.status)
    if (!fresh(status, h.endedAt ?? NaN, now)) continue
    add(h.callerRun, {
      kind: "handoff", id: h.id, title: cap(h.request || `Work for ${h.callee}`, 160).split("\n")[0], status,
      startedAt: new Date(h.startedAt).toISOString(), ...(h.endedAt ? { endedAt: new Date(h.endedAt).toISOString() } : {}),
      agentId: h.callee, ...(h.peer ? { peer: h.peer } : {}), ...(h.calleeRun ? { taskId: h.calleeRun } : {}),
    })
  }
  for (const r of runs) {
    const parent = (r.meta?.startedByRun && ids.has(r.meta.startedByRun) ? r.meta.startedByRun : undefined)
      ?? (r.parentRunId ? byWorkflowRun.get(r.parentRunId) : undefined)
    if (!parent) continue
    const status = workflowStatus(r.status)
    if (!fresh(status, Date.parse(r.updatedAt), now)) continue
    add(parent, {
      kind: "workflow", id: r.id, title: cap(r.meta?.title || r.workflowId, 160), status,
      startedAt: r.createdAt, ...(status === "done" || status === "failed" ? { endedAt: r.updatedAt } : {}),
      workflowId: r.workflowId, ...(r.meta?.startedBy ? { agentId: r.meta.startedBy } : {}),
    })
  }
  for (const [k, list] of out) {
    list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    out.set(k, list.slice(0, WORKERS_PER_RUN))
  }
  return out
}

/** GET /agents with each running task's workers on it. */
export function withWorkers<A extends { runningTasks: ReadonlyArray<{ id: string; workflow?: { runId: string } }> }>(
  agents: A[],
  handoffs: ReadonlyArray<HandoffEntry>,
  runs: ReadonlyArray<RunLike>,
  now: number = Date.now(),
): A[] {
  const tasks = agents.flatMap((a) => a.runningTasks)
  if (!tasks.length) return agents
  const by = workersByRun(tasks, handoffs, runs, now)
  if (!by.size) return agents
  return agents.map((a) => (!a.runningTasks.some((t) => by.has(t.id)) ? a : {
    ...a,
    runningTasks: a.runningTasks.map((t) => (by.has(t.id) ? { ...t, workers: by.get(t.id) } : t)),
  }))
}

/** At most this many workflow runs are read per refresh. */
export const RECENT_RUNS_CAP = 200

/**
 * The workflow runs to look for workers in, read at most once per
 * `ttlMs`: GET /agents is polled every 2 s per Hub, and listing runs reads
 * their files. Runs still open (running, or waiting on the owner) are
 * always read, however old: a workflow that has waited for a day is what
 * the owner needs to see. Ended runs untouched for longer than the done
 * window are not read. RECENT_RUNS_CAP at most, open runs first.
 */
export class RecentRuns {
  private at = 0
  private runs: RunLike[] = []
  constructor(
    private recent: (sinceMs: number) => RunLike[],
    private open: () => RunLike[] = () => [],
    private ttlMs = 10_000,
    private now: () => number = Date.now,
  ) {}
  get(): RunLike[] {
    const t = this.now()
    if (t - this.at >= this.ttlMs) {
      this.runs = this.read(t)
      this.at = t
    }
    return this.runs
  }
  private read(t: number): RunLike[] {
    const out: RunLike[] = []
    const seen = new Set<string>()
    const take = (list: () => RunLike[]) => {
      let runs: RunLike[]
      try { runs = list() } catch { return }
      for (const r of runs) {
        if (out.length >= RECENT_RUNS_CAP) return
        if (seen.has(r.id)) continue
        seen.add(r.id)
        out.push(r)
      }
    }
    take(this.open)
    take(() => this.recent(t - WORKER_DONE_WINDOW_MS))
    return out
  }
}
