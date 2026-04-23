import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { randomUUID } from "crypto"
import { z } from "zod"

// --- Durable timer service ---
//
// Persists pending timers under .agentx/workflows/_timers/<id>.json so a
// daemon restart doesn't forget them. A 1s tick loop fires due timers by
// invoking a registered callback. The workflow dispatcher registers its
// resume-on-timer callback at boot.
//
// Timer model — v1:
//   - Each timer is keyed to a (runId, nodeId) pair so `timer.boundary`
//     nodes can be cancelled when the attached node completes before the
//     timer elapses.
//   - Fire-once semantics. No repeating timers at this layer (use
//     trigger.cron at the workflow level for recurrence).
//   - Best-effort delivery: a missed tick (daemon crash, clock skew) is
//     honoured on next startup by scanning persisted timers with fireAt
//     in the past.

export const timerRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  /** ISO-8601 instant when the timer should fire. */
  fireAt: z.string(),
  /** Optional key to cancel matching timers (e.g., when the attached node
   *  completes normally and the escalation timer should be cancelled). */
  cancelKey: z.string().optional(),
  createdAt: z.string(),
})
export type TimerRecord = z.infer<typeof timerRecordSchema>

export interface TimerCallback {
  (t: TimerRecord): void | Promise<void>
}

export interface TimerServiceOptions {
  baseDir?: string
  /** Tick interval, in ms. Default 1000. */
  tickIntervalMs?: number
  log?: (msg: string) => void
}

export class TimerService {
  readonly baseDir: string
  private readonly tickIntervalMs: number
  private readonly log: (msg: string) => void
  private timer?: ReturnType<typeof setInterval>
  private callback?: TimerCallback
  private firedIds: Set<string> = new Set()

  constructor(opts: TimerServiceOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.baseDir = resolve(root, "_timers")
    mkdirSync(this.baseDir, { recursive: true })
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000
    this.log = opts.log ?? (() => {})
  }

  /** Register the fire callback. Overwrites any prior callback. Typical
   *  caller is the dispatcher's "resume on timer" path. */
  onFire(cb: TimerCallback): void {
    this.callback = cb
  }

  start(): void {
    if (this.timer) return
    this.log(`[timers] ticking every ${this.tickIntervalMs}ms — scanning ${this.baseDir}`)
    // Honour missed ticks on startup: scan all persisted timers once.
    this.tick()
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs)
    // Don't hold the event loop open on daemon shutdown.
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  schedule(args: {
    runId: string
    workflowId: string
    nodeId: string
    fireAt: string
    cancelKey?: string
  }): TimerRecord {
    const record: TimerRecord = {
      id: randomUUID(),
      runId: args.runId,
      workflowId: args.workflowId,
      nodeId: args.nodeId,
      fireAt: args.fireAt,
      cancelKey: args.cancelKey,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(this.pathFor(record.id), JSON.stringify(record, null, 2))
    return record
  }

  /** Cancel any timers matching the filter. Returns how many were removed. */
  cancel(filter: { runId?: string; nodeId?: string; cancelKey?: string }): number {
    let removed = 0
    for (const t of this.list()) {
      if (filter.runId && t.runId !== filter.runId) continue
      if (filter.nodeId && t.nodeId !== filter.nodeId) continue
      if (filter.cancelKey && t.cancelKey !== filter.cancelKey) continue
      try { unlinkSync(this.pathFor(t.id)); removed++ } catch { /* already gone */ }
    }
    return removed
  }

  list(): TimerRecord[] {
    if (!existsSync(this.baseDir)) return []
    const out: TimerRecord[] = []
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.baseDir, entry.name), "utf-8"))
        const parsed = timerRecordSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch { /* skip malformed */ }
    }
    return out
  }

  private pathFor(id: string): string {
    return resolve(this.baseDir, `${id}.json`)
  }

  private tick(): void {
    if (!this.callback) return
    const now = Date.now()
    for (const t of this.list()) {
      if (this.firedIds.has(t.id)) continue
      const fireAtMs = Date.parse(t.fireAt)
      if (Number.isNaN(fireAtMs) || fireAtMs > now) continue
      // Mark fired BEFORE calling the callback so a callback that loops
      // back into the walk (and re-schedules siblings) doesn't re-trigger.
      this.firedIds.add(t.id)
      try { unlinkSync(this.pathFor(t.id)) } catch { /* may race with cancel */ }
      try {
        void Promise.resolve(this.callback(t)).catch((e: any) => this.log(`[timers] fire callback threw: ${e?.message ?? e}`))
      } catch (e: any) {
        this.log(`[timers] fire dispatch failed: ${e?.message ?? e}`)
      }
    }
  }
}
