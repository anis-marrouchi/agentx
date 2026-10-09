import { createHash, randomUUID } from "crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { currentRoot } from "@/events/envelope"
import {
  type EntityRef,
  type NodeExecutionEntry,
  type PausedAt,
  type RunMeta,
  type RunStatus,
  type WorkflowRun,
} from "./types"

// --- RunStore (V2) ---
//
// Home-node-only persistence for dataflow runs. The node that processes the
// triggering event becomes the home node and owns:
//   _runs/<runId>.jsonl                   — append-only run events
//   _index/<backend>__<entityId>.json     — entity -> active runId lookup
//   _tasks/<runId>.jsonl                  — runs that wrap an agent's task
//                                           (#858, workflows.required)
//
// Task runs live apart (#883): one is written per task, so in _runs they
// would push paused workflow runs out of every newest-first window that
// looks for runs to resume. list() leaves them out unless asked; get() and
// every write find a run in either folder.
//
// Event lines come in two shapes:
//   { v: 2, kind: "snapshot", run }         — full run state at a moment
//   { v: 2, kind: "exec", entry, context? } — one node execution
//
// Append a snapshot on create + on status changes (completed/failed/paused);
// append an `exec` on every node completion. The authoritative run state is
// reconstructed by walking the lines in order: start from the last snapshot,
// fold subsequent `exec` entries into `history` + `context` + `pending`.
//
// This replaces the V1 transition-centric record. The entity-index +
// home-node ownership semantics are unchanged.

/** The workflow id of runs that wrap an agent's task (#858). Such runs are
 *  kept in their own folder (_tasks). */
export const TASK_WORKFLOW_ID = "task"

export interface RunStoreOptions {
  baseDir?: string
  /** This daemon's mesh peer id. Stamped as `homeNode` on run creation so
   *  later code can verify ownership before mutating. */
  nodeId: string
}

type RunEventLine =
  | { v: 2; kind: "snapshot"; run: WorkflowRun }
  | {
      v: 2; kind: "exec"; runId: string; entry: NodeExecutionEntry;
      pending: string[];
      status?: RunStatus;
      pausedAt?: PausedAt | null;
      context?: Record<string, Record<string, unknown>>;
      joinCounters?: Record<string, string[]>;
    }

function sanitize(s: string): string {
  // Keep the set narrow so the result is always a safe single filename
  // component — `/` is replaced because otherwise it creates unintended
  // subdirectories under _index/ on write.
  return s.replace(/[^a-zA-Z0-9._:#@-]/g, "_").slice(0, 200)
}

/** Stable idempotency key for a node execution given its triggering event.
 *  Same event delivered twice -> same key -> engine drops the duplicate. */
export function idempotencyKey(runId: string, nodeId: string, eventId: string): string {
  return createHash("sha1").update(`${runId}|${nodeId}|${eventId}`).digest("hex").slice(0, 16)
}

export class RunStore {
  readonly baseDir: string
  readonly runsDir: string
  readonly indexDir: string
  /** Task runs (#883): kept out of runsDir. */
  readonly tasksDir: string
  readonly nodeId: string

  constructor(opts: RunStoreOptions) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.runsDir = resolve(this.baseDir, "_runs")
    this.indexDir = resolve(this.baseDir, "_index")
    this.tasksDir = resolve(this.baseDir, "_tasks")
    this.nodeId = opts.nodeId
    mkdirSync(this.runsDir, { recursive: true })
    mkdirSync(this.indexDir, { recursive: true })
    mkdirSync(this.tasksDir, { recursive: true })
  }

  /** Where a run's file is: its folder by workflow id when known, else
   *  whichever folder holds it. */
  private runPath(runId: string, workflowId?: string): string {
    if (workflowId !== undefined && workflowId !== TASK_WORKFLOW_ID) return resolve(this.runsDir, `${runId}.jsonl`)
    if (workflowId === TASK_WORKFLOW_ID) {
      // A task run left in _runs by an older version stays where it is.
      const old = resolve(this.runsDir, `${runId}.jsonl`)
      return existsSync(old) ? old : resolve(this.tasksDir, `${runId}.jsonl`)
    }
    const task = resolve(this.tasksDir, `${runId}.jsonl`)
    return existsSync(task) ? task : resolve(this.runsDir, `${runId}.jsonl`)
  }

  private indexPath(entity: EntityRef): string {
    return resolve(this.indexDir, `${entity.backend}__${sanitize(entity.id)}.json`)
  }

  /** Create a new run. Seeds the initial pending queue (typically the
   *  trigger node's immediate successors) and writes an entity-index entry
   *  so future events for the same entity land on this home node. */
  create(args: {
    workflowId: string
    initialPending: string[]
    entityRef: EntityRef
    initialContext?: Record<string, Record<string, unknown>>
    /** Optional parent-run linkage for sub-process children. */
    parentRunId?: string | null
    parentNodeId?: string | null
    rootRunId?: string | null
    depth?: number
    /** Defaults to the current event root, if any. */
    eventRootId?: string
    /** Follow-up runs (#788): title, tags, who started it. */
    meta?: RunMeta
    /** A run id chosen before the run exists (#858: the agent is told it
     *  before its turn starts). Default: a fresh UUID. */
    id?: string
  }): WorkflowRun {
    const now = new Date().toISOString()
    const id = args.id ?? randomUUID()
    const run: WorkflowRun = {
      id,
      workflowId: args.workflowId,
      workflowVersion: 2,
      homeNode: this.nodeId,
      status: "running",
      pausedAt: undefined,
      context: args.initialContext ?? {},
      pending: args.initialPending,
      entityRef: args.entityRef,
      history: [],
      parentRunId: args.parentRunId ?? null,
      parentNodeId: args.parentNodeId ?? null,
      rootRunId: args.rootRunId ?? id,
      depth: args.depth ?? 0,
      eventRootId: args.eventRootId ?? currentRoot()?.rootId,
      joinCounters: {},
      ...(args.meta ? { meta: args.meta } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.appendSnapshot(run)
    this.writeIndex(args.entityRef, run.id)
    return run
  }

  /** Read the latest snapshot of a run by replaying the jsonl log. */
  get(runId: string): WorkflowRun | null {
    return this.readRun(this.runPath(runId))
  }

  private readRun(p: string): WorkflowRun | null {
    let raw: string
    try { raw = readFileSync(p, "utf-8").trim() } catch { return null }
    if (!raw) return null
    let run: WorkflowRun | null = null
    for (const line of raw.split("\n")) {
      let evt: RunEventLine
      try { evt = JSON.parse(line) as RunEventLine } catch { continue }
      if (evt.v !== 2) continue
      if (evt.kind === "snapshot") run = evt.run
      else if (evt.kind === "exec" && run && run.id === evt.runId) {
        const current: WorkflowRun = run
        run = {
          ...current,
          history: [...current.history, evt.entry],
          pending: evt.pending,
          status: evt.status ?? current.status,
          pausedAt: evt.pausedAt === null ? undefined : (evt.pausedAt ?? current.pausedAt),
          context: evt.context ?? current.context,
          joinCounters: evt.joinCounters ?? current.joinCounters,
          updatedAt: evt.entry.at,
        }
      }
    }
    return run
  }

  /** Look up the active run id for an entity, if any. */
  getActiveByEntity(entity: EntityRef): string | null {
    const p = this.indexPath(entity)
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as { runId: string; homeNode: string; updatedAt: string }
      return parsed.runId
    } catch {
      return null
    }
  }

  /** Which node owns a given entity (null if unclaimed). Used by the
   *  dispatcher to decide whether to process locally or forward via mesh. */
  getHomeNodeByEntity(entity: EntityRef): string | null {
    const p = this.indexPath(entity)
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as { runId: string; homeNode: string; updatedAt: string }
      return parsed.homeNode
    } catch {
      return null
    }
  }

  /** Record a single node's execution. Appends an `exec` line and returns
   *  the updated run snapshot. Idempotent: if an entry with the same
   *  idempotencyKey already exists, the call is a no-op. */
  recordExecution(args: {
    runId: string
    entry: NodeExecutionEntry
    nextPending: string[]
    status?: RunStatus
    pausedAt?: PausedAt | null  // null = clear, undefined = unchanged
    /** Optional updated context snapshot. When provided, replaces the run's
     *  context wholesale (used when a node's output bundle lands).  When
     *  omitted, context is carried forward unchanged. */
    context?: Record<string, Record<string, unknown>>
    /** Optional updated join-counter map. Undefined = carry forward. */
    joinCounters?: Record<string, string[]>
  }): WorkflowRun | null {
    const run = this.get(args.runId)
    if (!run) return null
    if (run.history.some((h) => h.idempotencyKey === args.entry.idempotencyKey)) return run

    const line: RunEventLine = {
      v: 2,
      kind: "exec",
      runId: args.runId,
      entry: args.entry,
      pending: args.nextPending,
      status: args.status,
      pausedAt: args.pausedAt === null ? null : args.pausedAt,
      context: args.context,
      joinCounters: args.joinCounters,
    }
    appendFileSync(this.runPath(args.runId, run.workflowId), JSON.stringify(line) + "\n")

    // Refresh the index: completed/failed/canceled runs clear it; running +
    // paused runs keep it so webhook re-entry can still find the home node.
    const nextStatus = args.status ?? run.status
    if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "canceled") {
      this.clearIndex(run.entityRef)
    } else {
      this.writeIndex(run.entityRef, run.id)
    }

    return this.get(args.runId)
  }

  /** Mutate status without adding a history entry — used for
   *  pause / resume / cancel commands from the CLI or dashboard. */
  setStatus(runId: string, status: RunStatus): WorkflowRun | null {
    const run = this.get(runId)
    if (!run) return null
    const updated: WorkflowRun = { ...run, status, updatedAt: new Date().toISOString() }
    this.appendSnapshot(updated)
    if (status !== "running" && status !== "paused") this.clearIndex(updated.entityRef)
    return updated
  }

  /** Merge fields into a run's meta (#788). Appends a snapshot, like
   *  setStatus; history and context are carried over as they are. */
  setMeta(runId: string, patch: Partial<RunMeta>): WorkflowRun | null {
    const run = this.get(runId)
    if (!run) return null
    const meta: RunMeta = { tags: [], followUp: false, approvedAtStart: false, ...run.meta, ...patch }
    const updated: WorkflowRun = { ...run, meta, updatedAt: new Date().toISOString() }
    this.appendSnapshot(updated)
    return updated
  }

  /** Merge into a run's meta and replace its pending queue (#858: a plan
   *  written or changed mid-run). Appends a snapshot; history is kept. */
  patch(runId: string, patch: { meta?: Partial<RunMeta>; pending?: string[] }): WorkflowRun | null {
    const run = this.get(runId)
    if (!run) return null
    const updated: WorkflowRun = {
      ...run,
      ...(patch.meta ? { meta: { tags: [], followUp: false, approvedAtStart: false, ...run.meta, ...patch.meta } } : {}),
      ...(patch.pending ? { pending: patch.pending } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.appendSnapshot(updated)
    return updated
  }

  /** Remove a run and its entity index entry, as if it never ran (#858: a
   *  plain question exempted from workflows.required). */
  discard(runId: string): boolean {
    const run = this.get(runId)
    if (!run) return false
    this.clearIndex(run.entityRef)
    try { unlinkSync(this.runPath(runId, run.workflowId)); return true } catch { return false }
  }

  /** List runs, newest first. Task runs (#883) are left out unless
   *  `tasks` says otherwise; `workflowId: "task"` lists only them. A run
   *  file last written before `since` (ms) is skipped unread: a run starts
   *  before its file's last write. */
  list(opts: { workflowId?: string; limit?: number; tasks?: "exclude" | "include" | "only"; since?: number } = {}): WorkflowRun[] {
    const tasks = opts.tasks ?? (opts.workflowId === TASK_WORKFLOW_ID ? "only" : "exclude")
    const dirs = tasks === "only" ? [this.tasksDir] : tasks === "include" ? [this.runsDir, this.tasksDir] : [this.runsDir]
    const files: Array<{ path: string; mtime: number }> = []
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue
        const path = resolve(dir, f)
        let mtime: number
        try { mtime = statSync(path).mtimeMs } catch { continue }
        if (opts.since && mtime < opts.since) continue
        files.push({ path, mtime })
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    const out: WorkflowRun[] = []
    for (const f of files) {
      const run = this.readRun(f.path)
      if (!run) continue
      if (opts.workflowId && run.workflowId !== opts.workflowId) continue
      // One an older version left in _runs, until moveTaskRuns() runs.
      if (tasks === "exclude" && run.workflowId === TASK_WORKFLOW_ID) continue
      out.push(run)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
  }

  /** Task runs still open (#883): their entity index entry is kept until
   *  they end, so this reads the open ones only, however many have ended.
   *  An entry whose run is gone is removed. */
  openTaskRunIds(): string[] {
    if (!existsSync(this.indexDir)) return []
    const ids: string[] = []
    for (const name of readdirSync(this.indexDir)) {
      if (!name.startsWith("task__") || !name.endsWith(".json")) continue
      const p = resolve(this.indexDir, name)
      let runId = ""
      try { runId = String((JSON.parse(readFileSync(p, "utf-8")) as { runId?: unknown }).runId ?? "") } catch { /* unreadable: dropped below */ }
      const run = runId ? this.get(runId) : null
      if (!run) { try { unlinkSync(p) } catch { /* ignore */ } continue }
      ids.push(runId)
    }
    return ids
  }

  /** Retention for task runs (#883): remove ended task runs last written
   *  more than `maxDays` ago. Only old files are read; open runs stay.
   *  Returns how many were removed. */
  pruneTaskRuns(maxDays: number): number {
    if (!(maxDays > 0) || !existsSync(this.tasksDir)) return 0
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    let pruned = 0
    for (const name of readdirSync(this.tasksDir)) {
      if (!name.endsWith(".jsonl")) continue
      const path = resolve(this.tasksDir, name)
      try { if (statSync(path).mtimeMs >= cutoff) continue } catch { continue }
      const run = this.readRun(path)
      if (run && (run.status === "running" || run.status === "paused")) continue
      try { unlinkSync(path); pruned++ } catch { /* ignore */ }
    }
    return pruned
  }

  /** Move task runs written to _runs before they had a folder of their own
   *  (0.133.0) into _tasks. Once: a marker file records it is done. */
  moveTaskRuns(): number {
    const marker = resolve(this.tasksDir, ".moved")
    if (existsSync(marker) || !existsSync(this.runsDir)) return 0
    let moved = 0
    for (const name of readdirSync(this.runsDir)) {
      if (!name.endsWith(".jsonl")) continue
      const path = resolve(this.runsDir, name)
      let first = ""
      try { first = readFileSync(path, "utf-8").split("\n", 1)[0] } catch { continue }
      let workflowId: unknown
      try { workflowId = (JSON.parse(first) as { run?: { workflowId?: unknown } }).run?.workflowId } catch { continue }
      if (workflowId !== TASK_WORKFLOW_ID) continue
      try { renameSync(path, resolve(this.tasksDir, name)); moved++ } catch { /* left where it is: get() still finds it */ }
    }
    writeFileSync(marker, new Date().toISOString() + "\n")
    return moved
  }

  /** Retention: keep at most `maxRuns` completed/failed/canceled runs
   *  younger than `maxDays`. Running/paused runs are never pruned. */
  prune(policy: { maxRuns: number; maxDays: number }): number {
    if (!existsSync(this.runsDir)) return 0
    const cutoff = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000
    const candidates: Array<{ file: string; run: WorkflowRun; mtime: number }> = []
    for (const name of readdirSync(this.runsDir)) {
      if (!name.endsWith(".jsonl")) continue
      const path = resolve(this.runsDir, name)
      const mtime = statSync(path).mtimeMs
      const run = this.get(name.replace(/\.jsonl$/, ""))
      if (!run) continue
      if (run.status === "running" || run.status === "paused") continue
      candidates.push({ file: path, run, mtime })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    let pruned = 0
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      const tooOld = c.mtime < cutoff
      const tooMany = i >= policy.maxRuns
      if (tooOld || tooMany) {
        try { unlinkSync(c.file); pruned++ } catch { /* ignore */ }
      }
    }
    return pruned
  }

  private appendSnapshot(run: WorkflowRun): void {
    const line: RunEventLine = { v: 2, kind: "snapshot", run }
    appendFileSync(this.runPath(run.id, run.workflowId), JSON.stringify(line) + "\n")
  }

  private writeIndex(entity: EntityRef, runId: string): void {
    writeFileSync(this.indexPath(entity), JSON.stringify({
      runId,
      homeNode: this.nodeId,
      updatedAt: new Date().toISOString(),
    }, null, 2) + "\n")
  }

  private clearIndex(entity: EntityRef): void {
    const p = this.indexPath(entity)
    if (existsSync(p)) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
  }
}
