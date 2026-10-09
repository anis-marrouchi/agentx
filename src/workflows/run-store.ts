import { createHash, randomUUID } from "crypto"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
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
//   _task-runs/<runId>.jsonl              — runs that wrap a task (#858, #877)
//   _index/<backend>__<entityId>.json     — entity -> active runId lookup
//
// Wrapped task runs (workflows.required) get their own folder: there is one
// per task, so in the shared folder they would push paused workflow runs out
// of the newest-N window the engine resumes from, and every scan would grow
// with every task ever wrapped. list() reads workflow runs only unless asked.
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

export interface RunStoreOptions {
  baseDir?: string
  /** This daemon's mesh peer id. Stamped as `homeNode` on run creation so
   *  later code can verify ownership before mutating. */
  nodeId: string
}

/** Which runs list() and prune() read: workflow runs (the default),
 *  wrapped task runs, or both. */
export type RunScope = "workflows" | "tasks" | "all"

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
  readonly taskRunsDir: string
  readonly indexDir: string
  readonly nodeId: string

  constructor(opts: RunStoreOptions) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.runsDir = resolve(this.baseDir, "_runs")
    this.taskRunsDir = resolve(this.baseDir, "_task-runs")
    this.indexDir = resolve(this.baseDir, "_index")
    this.nodeId = opts.nodeId
    mkdirSync(this.runsDir, { recursive: true })
    mkdirSync(this.taskRunsDir, { recursive: true })
    mkdirSync(this.indexDir, { recursive: true })
  }

  /** Where a run's file is: workflow runs first, then task runs. A run not
   *  written yet goes to the folder its kind belongs in. */
  private runPath(runId: string, task = false): string {
    const main = resolve(this.runsDir, `${runId}.jsonl`)
    if (existsSync(main)) return main
    const wrapped = resolve(this.taskRunsDir, `${runId}.jsonl`)
    return task || existsSync(wrapped) ? wrapped : main
  }

  private dirsFor(scope: RunScope): string[] {
    if (scope === "tasks") return [this.taskRunsDir]
    if (scope === "workflows") return [this.runsDir]
    return [this.runsDir, this.taskRunsDir]
  }

  /** Run files in the scope's folders, newest first. */
  private files(scope: RunScope): Array<{ path: string; mtime: number }> {
    const out: Array<{ path: string; mtime: number }> = []
    for (const dir of this.dirsFor(scope)) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue
        const path = resolve(dir, name)
        try { out.push({ path, mtime: statSync(path).mtimeMs }) } catch { /* removed meanwhile */ }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  private readPath(path: string): WorkflowRun | null {
    if (!existsSync(path)) return null
    let raw: string
    try { raw = readFileSync(path, "utf-8").trim() } catch { return null }
    return raw ? replay(raw) : null
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
    return this.readPath(this.runPath(runId))
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
    appendFileSync(this.runPath(args.runId), JSON.stringify(line) + "\n")

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
    try { unlinkSync(this.runPath(runId)); return true } catch { return false }
  }

  /** Runs, newest first, read one file at a time so a caller that stops
   *  early reads no more. Scope: workflow runs by default; with a
   *  workflowId, both folders (the id decides). */
  *iterate(opts: { workflowId?: string; scope?: RunScope } = {}): Generator<{ run: WorkflowRun; mtimeMs: number }> {
    const scope = opts.scope ?? (opts.workflowId ? "all" : "workflows")
    for (const f of this.files(scope)) {
      const run = this.readPath(f.path)
      if (!run) continue
      if (opts.workflowId && run.workflowId !== opts.workflowId) continue
      // A task run written before task runs had their own folder.
      if (scope === "workflows" && run.meta?.wrap) continue
      yield { run, mtimeMs: f.mtime }
    }
  }

  /** List runs, newest first. The limit counts runs of the scope only: task
   *  runs never take a workflow run's place. */
  list(opts: { workflowId?: string; limit?: number; scope?: RunScope } = {}): WorkflowRun[] {
    const out: WorkflowRun[] = []
    for (const { run } of this.iterate(opts)) {
      out.push(run)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
  }

  /** Move task runs written to the workflow-run folder before they had
   *  their own (#877). Reads the head of each workflow run file only: a
   *  task run's first snapshot is small, a workflow run's can be large. */
  moveTaskRuns(): number {
    if (!existsSync(this.runsDir)) return 0
    let moved = 0
    for (const name of readdirSync(this.runsDir)) {
      if (!name.endsWith(".jsonl")) continue
      const path = resolve(this.runsDir, name)
      const first = headLine(path)
      if (!first?.includes('"wrap"')) continue
      try {
        const evt = JSON.parse(first) as RunEventLine
        if (evt.kind !== "snapshot" || !evt.run.meta?.wrap) continue
        renameSync(path, resolve(this.taskRunsDir, name))
        moved++
      } catch { /* leave it where it is */ }
    }
    return moved
  }

  /** Retention: keep at most `maxRuns` completed/failed/canceled runs
   *  younger than `maxDays`, in the scope (default: both folders). Running
   *  and paused runs are never pruned. */
  prune(policy: { maxRuns: number; maxDays: number }, scope: RunScope = "all"): number {
    const cutoff = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000
    let kept = 0
    let pruned = 0
    for (const f of this.files(scope)) {
      const run = this.readPath(f.path)
      if (!run) continue
      if (run.status === "running" || run.status === "paused") continue
      if (f.mtime < cutoff || kept >= policy.maxRuns) {
        try { unlinkSync(f.path); pruned++ } catch { /* ignore */ }
      } else kept++
    }
    return pruned
  }

  private appendSnapshot(run: WorkflowRun): void {
    const line: RunEventLine = { v: 2, kind: "snapshot", run }
    appendFileSync(this.runPath(run.id, !!run.meta?.wrap), JSON.stringify(line) + "\n")
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

/** Fold a run file's lines into its latest state. */
function replay(raw: string): WorkflowRun | null {
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

/** A file's first line, if it ends within the first 16 KB. */
function headLine(path: string): string | null {
  let fd: number
  try { fd = openSync(path, "r") } catch { return null }
  try {
    const buf = Buffer.alloc(16 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString("utf-8")
    const end = text.indexOf("\n")
    return end >= 0 ? text.slice(0, end) : n < buf.length ? text : null
  } catch { return null } finally { closeSync(fd) }
}
