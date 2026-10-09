import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { RunOrigin } from "@/agents/resume/origin"
import type { ResumePlan } from "./plan"

// --- Stopped tasks and their resume plans, one JSON file each (#857) ---
//
// Kept on disk so a stopped task survives a daemon restart and can be
// resumed days later. Small: a record holds the original request, where it
// came from and the plan, never the transcript.

export type StoppedState = "winding-down" | "stopped" | "resumed"

export interface StoppedTask {
  /** The stopped run's dashboard id (RunningTask.id). */
  id: string
  /** Its trace id, for the tool calls it made. */
  traceId?: string
  agentId: string
  channel: string
  chatId: string
  /** The task's sender as its context named it. */
  sender?: string
  /** Root the task ran under; the resumed run keeps it. */
  rootId: string
  originalMessage: string
  /** How to re-enter it (the resume coordinator's resumers). */
  origin: RunOrigin | null
  /** A step of a workflow run (#870): the run paused at this step, and a
   *  resume re-enters the step inside the run instead of the chat. */
  workflow?: { runId: string; workflowId: string; nodeId: string }
  stoppedAt: string
  stoppedBy: string
  reason?: string
  state: StoppedState
  plan?: ResumePlan
  resumedAt?: string
  resumedBy?: string
}

/** Records kept this long after they were resumed. Stopped ones stay until
 *  resumed or removed. */
const KEEP_RESUMED_MS = 7 * 24 * 60 * 60 * 1000
const LIST_MAX = 200

export class StoppedTaskStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    return resolve(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
  }

  save(record: StoppedTask): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    // Write then rename, so a reader never sees half a record.
    const path = this.file(record.id)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8")
    renameSync(tmp, path)
  }

  get(id: string): StoppedTask | null {
    try {
      const path = this.file(id)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, "utf-8")) as StoppedTask
    } catch {
      return null
    }
  }

  /** Claim the task for one resume. Atomic on disk (an exclusive create),
   *  like the boot pass's claimResume: of two resumes, in this process or
   *  another on the same folder, only one gets true. */
  claim(id: string): boolean {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      closeSync(openSync(`${this.file(id)}.claim`, "wx"))
      return true
    } catch {
      return false
    }
  }

  /** Give a claim back, after a resume that could not re-enter the task. */
  release(id: string): void {
    try { unlinkSync(`${this.file(id)}.claim`) } catch { /* not claimed */ }
  }

  remove(id: string): boolean {
    this.release(id)
    try { unlinkSync(this.file(id)); return true } catch { return false }
  }

  /** Newest first. Drops resumed records past their keep time. */
  list(opts: { state?: StoppedState; agentId?: string; limit?: number; now?: number } = {}): StoppedTask[] {
    if (!existsSync(this.dir)) return []
    const now = opts.now ?? Date.now()
    const out: StoppedTask[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue
      let r: StoppedTask
      try { r = JSON.parse(readFileSync(resolve(this.dir, name), "utf-8")) } catch { continue }
      if (r.state === "resumed" && r.resumedAt && now - Date.parse(r.resumedAt) > KEEP_RESUMED_MS) {
        try { unlinkSync(resolve(this.dir, name)) } catch { /* next list retries */ }
        this.release(r.id)
        continue
      }
      if (opts.state && r.state !== opts.state) continue
      if (opts.agentId && r.agentId !== opts.agentId) continue
      out.push(r)
    }
    out.sort((a, b) => b.stoppedAt.localeCompare(a.stoppedAt))
    return out.slice(0, Math.min(opts.limit ?? 50, LIST_MAX))
  }
}

/** The bounded view list APIs and the live page get: the plan is cut, the
 *  request is a preview. GET /api/signals/stopped/:id returns the whole. */
export function summarizeStopped(r: StoppedTask): Record<string, unknown> {
  const preview = (s: string, n: number) => {
    const flat = s.replace(/\s+/g, " ").trim()
    return flat.length <= n ? flat : flat.slice(0, n - 1) + "…"
  }
  return {
    id: r.id,
    agentId: r.agentId,
    channel: r.channel,
    chatId: r.chatId,
    rootId: r.rootId,
    state: r.state,
    stoppedAt: r.stoppedAt,
    stoppedBy: r.stoppedBy,
    reason: r.reason,
    request: preview(r.originalMessage, 200),
    plan: r.plan ? { author: r.plan.author, text: r.plan.text.slice(0, 1200), note: r.plan.note } : undefined,
    resumable: r.state === "stopped" && (!!r.origin || !!r.workflow),
    ...(r.workflow ? { workflow: r.workflow } : {}),
    resumedAt: r.resumedAt,
    resumedBy: r.resumedBy,
  }
}
