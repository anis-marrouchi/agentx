import { createHash, randomUUID } from "crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  type EntityRef,
  type NodeExecutionEntry,
  type PausedAt,
  type RunStatus,
  type WorkflowRun,
} from "./types"

// --- RunStore (V2) ---
//
// Home-node-only persistence for dataflow runs. The node that processes the
// triggering event becomes the home node and owns:
//   _runs/<runId>.jsonl                   — append-only run events
//   _index/<backend>__<entityId>.json     — entity -> active runId lookup
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

type RunEventLine =
  | { v: 2; kind: "snapshot"; run: WorkflowRun }
  | { v: 2; kind: "exec"; runId: string; entry: NodeExecutionEntry; pending: string[]; status?: RunStatus; pausedAt?: PausedAt | null; context?: Record<string, Record<string, unknown>> }

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
  readonly nodeId: string

  constructor(opts: RunStoreOptions) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.runsDir = resolve(this.baseDir, "_runs")
    this.indexDir = resolve(this.baseDir, "_index")
    this.nodeId = opts.nodeId
    mkdirSync(this.runsDir, { recursive: true })
    mkdirSync(this.indexDir, { recursive: true })
  }

  private runPath(runId: string): string {
    return resolve(this.runsDir, `${runId}.jsonl`)
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
  }): WorkflowRun {
    const now = new Date().toISOString()
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId: args.workflowId,
      workflowVersion: 2,
      homeNode: this.nodeId,
      status: "running",
      pausedAt: undefined,
      context: args.initialContext ?? {},
      pending: args.initialPending,
      entityRef: args.entityRef,
      history: [],
      createdAt: now,
      updatedAt: now,
    }
    this.appendSnapshot(run)
    this.writeIndex(args.entityRef, run.id)
    return run
  }

  /** Read the latest snapshot of a run by replaying the jsonl log. */
  get(runId: string): WorkflowRun | null {
    const p = this.runPath(runId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, "utf-8").trim()
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

  /** List runs, newest first. */
  list(opts: { workflowId?: string; limit?: number } = {}): WorkflowRun[] {
    if (!existsSync(this.runsDir)) return []
    const files = readdirSync(this.runsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(resolve(this.runsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const out: WorkflowRun[] = []
    for (const f of files) {
      const run = this.get(f.name.replace(/\.jsonl$/, ""))
      if (!run) continue
      if (opts.workflowId && run.workflowId !== opts.workflowId) continue
      out.push(run)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
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
    appendFileSync(this.runPath(run.id), JSON.stringify(line) + "\n")
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
