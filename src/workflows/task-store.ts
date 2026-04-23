import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { randomUUID } from "crypto"
import { z } from "zod"
import { formSchemaSchema, type FormSchema } from "../forms/types"

// --- UserTask store ---
//
// Persists open `userTask` records (the live inbox). One JSON file per task
// under .agentx/workflows/_tasks/<taskId>.json. When a task is submitted the
// record is moved to _tasks/_completed/ for historical lookup (keeps the
// live inbox fast) and the paused run is resumed via the dispatcher.
//
// Task state machine:
//   open      — freshly created, awaiting any assignee action
//   claimed   — a specific assignee has started (optional in v1; reserved)
//   completed — submitted successfully, record archived
//   canceled  — workflow canceled or timer-escalated past this task

export const taskStatusSchema = z.enum(["open", "claimed", "completed", "canceled"])
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const userTaskRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Assignee ref ("actor:<id>" or "role:<id>"). */
  assignee: z.string(),
  /** Concrete actors who currently see this task (resolved via role strategy). */
  assignedTo: z.array(z.string()),
  form: formSchemaSchema,
  status: taskStatusSchema,
  /** Channel-delivery tracking. Populated by the userTask handler after it
   *  renders the form to the assignee's preferred channel(s). */
  delivered: z.array(z.object({
    channel: z.string(),
    handle: z.string(),
    messageId: z.string().optional(),
    at: z.string(),
  })).default([]),
  /** Optional due date (ISO-8601). Set by dueIn config. */
  dueAt: z.string().optional(),
  /** Set on completion. */
  submittedBy: z.string().optional(),
  submittedAt: z.string().optional(),
  submittedValues: z.record(z.unknown()).optional(),
  submittedAction: z.enum(["primary", "secondary"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type UserTaskRecord = z.infer<typeof userTaskRecordSchema>

export interface TaskStoreOptions {
  baseDir?: string
}

export class TaskStore {
  readonly baseDir: string
  readonly archiveDir: string

  constructor(opts: TaskStoreOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.baseDir = resolve(root, "_tasks")
    this.archiveDir = resolve(this.baseDir, "_completed")
    mkdirSync(this.baseDir, { recursive: true })
    mkdirSync(this.archiveDir, { recursive: true })
  }

  private pathFor(id: string): string {
    return resolve(this.baseDir, `${id}.json`)
  }

  private archivePath(id: string): string {
    return resolve(this.archiveDir, `${id}.json`)
  }

  create(args: {
    runId: string
    workflowId: string
    nodeId: string
    title: string
    description?: string
    assignee: string
    assignedTo: string[]
    form: FormSchema
    dueAt?: string
  }): UserTaskRecord {
    const now = new Date().toISOString()
    const record: UserTaskRecord = {
      id: randomUUID(),
      runId: args.runId,
      workflowId: args.workflowId,
      nodeId: args.nodeId,
      title: args.title,
      description: args.description,
      assignee: args.assignee,
      assignedTo: args.assignedTo,
      form: args.form,
      status: "open",
      delivered: [],
      dueAt: args.dueAt,
      createdAt: now,
      updatedAt: now,
    }
    writeFileSync(this.pathFor(record.id), JSON.stringify(record, null, 2))
    return record
  }

  get(id: string): UserTaskRecord | null {
    const live = this.pathFor(id)
    if (existsSync(live)) {
      try {
        const raw = JSON.parse(readFileSync(live, "utf-8"))
        const parsed = userTaskRecordSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      } catch { return null }
    }
    const archived = this.archivePath(id)
    if (existsSync(archived)) {
      try {
        const raw = JSON.parse(readFileSync(archived, "utf-8"))
        const parsed = userTaskRecordSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      } catch { return null }
    }
    return null
  }

  save(record: UserTaskRecord): UserTaskRecord {
    const updated = { ...record, updatedAt: new Date().toISOString() }
    const dest = updated.status === "completed" || updated.status === "canceled"
      ? this.archivePath(updated.id)
      : this.pathFor(updated.id)
    writeFileSync(dest, JSON.stringify(updated, null, 2))
    // If we just moved to archive, clean up the live file.
    if (dest === this.archivePath(updated.id) && existsSync(this.pathFor(updated.id))) {
      unlinkSync(this.pathFor(updated.id))
    }
    return updated
  }

  /** Open tasks only — drives the inbox page. */
  listOpen(): UserTaskRecord[] {
    if (!existsSync(this.baseDir)) return []
    const out: UserTaskRecord[] = []
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.baseDir, entry.name), "utf-8"))
        const parsed = userTaskRecordSchema.safeParse(raw)
        if (parsed.success && parsed.data.status === "open") out.push(parsed.data)
      } catch { /* skip */ }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** Open tasks assigned to a specific actor (directly or via role). */
  listForActor(actorId: string): UserTaskRecord[] {
    return this.listOpen().filter((t) => t.assignedTo.includes(actorId))
  }

  /** Look up the open task owned by a specific run/node pair. */
  findByRunNode(runId: string, nodeId: string): UserTaskRecord | null {
    return this.listOpen().find((t) => t.runId === runId && t.nodeId === nodeId) ?? null
  }

  /** Return every completed/canceled task record in the archive. Used by
   *  KPI aggregation. Walks the archive directory once. */
  listArchived(): UserTaskRecord[] {
    if (!existsSync(this.archiveDir)) return []
    const out: UserTaskRecord[] = []
    for (const entry of readdirSync(this.archiveDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.archiveDir, entry.name), "utf-8"))
        const parsed = userTaskRecordSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch { /* skip */ }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }
}

// --- KPI aggregation ---
//
// Cheap on-demand stats. For v1 we re-read the fs on every call; cache
// lands later if/when the dashboard polls aggressively. KPIs compute
// over open + archived tasks combined (open contribute to pending count;
// archived contribute to durations + breach rate).

export interface ActorKpi {
  actorId: string
  openTasks: number
  completedTasks: number
  /** Average milliseconds from createdAt → submittedAt (completed only). */
  avgDurationMs: number | null
  /** Fraction 0..1 of completed tasks submitted after dueAt. Null when
   *  no completed tasks had a dueAt to measure against. */
  slaBreachRate: number | null
  /** Count of completed tasks where submittedAt > dueAt. */
  breachedCount: number
}

export interface WorkflowKpis {
  byActor: ActorKpi[]
  totals: ActorKpi
  generatedAt: string
}

export function computeKpis(store: TaskStore): WorkflowKpis {
  const open = store.listOpen()
  const archived = store.listArchived()
  const byActor = new Map<string, {
    open: number
    completed: number
    durations: number[]
    dueCount: number
    breached: number
  }>()

  const bucket = (id: string) => {
    let b = byActor.get(id)
    if (!b) { b = { open: 0, completed: 0, durations: [], dueCount: 0, breached: 0 }; byActor.set(id, b) }
    return b
  }

  for (const t of open) {
    for (const actor of t.assignedTo) bucket(actor).open++
  }
  for (const t of archived) {
    if (t.status !== "completed" || !t.submittedAt) continue
    const createdMs = Date.parse(t.createdAt)
    const submittedMs = Date.parse(t.submittedAt)
    if (Number.isNaN(createdMs) || Number.isNaN(submittedMs)) continue
    const dur = Math.max(0, submittedMs - createdMs)
    const submitter = t.submittedBy ?? t.assignedTo[0] ?? "unknown"
    const b = bucket(submitter)
    b.completed++
    b.durations.push(dur)
    if (t.dueAt) {
      b.dueCount++
      if (submittedMs > Date.parse(t.dueAt)) b.breached++
    }
  }

  const perActor: ActorKpi[] = Array.from(byActor.entries()).map(([actorId, b]) => ({
    actorId,
    openTasks: b.open,
    completedTasks: b.completed,
    avgDurationMs: b.durations.length ? Math.round(b.durations.reduce((a, n) => a + n, 0) / b.durations.length) : null,
    slaBreachRate: b.dueCount ? b.breached / b.dueCount : null,
    breachedCount: b.breached,
  })).sort((a, b) => b.completedTasks - a.completedTasks || a.actorId.localeCompare(b.actorId))

  const totals = aggregateTotals(byActor)
  return {
    byActor: perActor,
    totals,
    generatedAt: new Date().toISOString(),
  }
}

function aggregateTotals(byActor: Map<string, { open: number; completed: number; durations: number[]; dueCount: number; breached: number }>): ActorKpi {
  let open = 0, completed = 0, durations: number[] = [], dueCount = 0, breached = 0
  for (const b of byActor.values()) {
    open += b.open; completed += b.completed
    durations.push(...b.durations)
    dueCount += b.dueCount; breached += b.breached
  }
  return {
    actorId: "__total__",
    openTasks: open,
    completedTasks: completed,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, n) => a + n, 0) / durations.length) : null,
    slaBreachRate: dueCount ? breached / dueCount : null,
    breachedCount: breached,
  }
}
