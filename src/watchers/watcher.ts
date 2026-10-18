import type { AgentXEvents } from "@/events/bus"
import { TASK_WATCH_SEAT, needsWatcher, taskWatchQuestions, taskWatchState, type TaskWatchAnswers } from "@/decisions/seats/task-watch"
import type { CheckpointDecision, WatcherRecord, WatcherSource, WatcherStore } from "./store"

// --- A watcher checkpoint at the start of every task (#1030) ---
//
// A task with a due time was handed from its scheduler to a one-off chat.
// The chat ended halfway, nothing was watching, and the due time passed in
// silence. At every task start (a dispatched run, a delegation, a cron
// hand-off) this checkpoint:
//
//   1. decides  — asks the task-watch seat whether the task carries a
//                 deadline, a promise or a hand-off (a probability)
//   2. looks up — finds a watcher already covering the task key: one of
//                 ours, or another mechanism (an open request, say)
//   3. attaches — arms a watcher unless the answer is a confident "no".
//                 An uncertain or missing answer attaches: fail-safe.
//   4. records  — writes the decision, its probability and the watcher id
//                 against the task key, and as a step on the run's trace
//
// A watcher fires when the due time passes with no done signal, or when the
// run or delegation it watches ends with no result. It tells the delegating
// agent first, then the owner after `escalateAfterMinutes` unless a done
// signal arrives in between. Every entry point swallows its own errors:
// watching a task must never break the task.

export interface WatcherSettings {
  enabled: boolean
  sources: WatcherSource[]
  /** Runs on these channels are checked as dispatches even with no due
   *  time and no delegating agent. */
  dispatchChannels: string[]
  /** A seat answer below this is a confident "no": no watcher. */
  skipBelow: number
  /** Answers at or above this are a "yes"; between skipBelow and this is
   *  "uncertain". Both attach; the word is what the audit row says. */
  attachAbove: number
  /** Minutes after the first alert before the owner is told. */
  escalateAfterMinutes: number
  /** A watcher with no due time that hears nothing for this long fires. */
  quietAfterHours: number
  retentionDays: number
}

export const DEFAULT_WATCHER_SETTINGS: WatcherSettings = {
  enabled: false,
  sources: ["dispatch", "delegation", "cron"],
  dispatchChannels: [],
  skipBelow: 0.2,
  attachAbove: 0.6,
  escalateAfterMinutes: 30,
  quietAfterHours: 24,
  retentionDays: 30,
}

/** Channel of the turn that alerts the delegating agent. Never checked:
 *  an alert about a task is not a new task. */
export const WATCHER_CHANNEL = "watchers"

/** Something other than this module that already watches a task. */
export type WatcherLookup = (input: CheckpointInput) => { kind: string; id: string } | null

export interface SeatAnswer {
  probability: number
  mode: string
  callId: string | null
}

export interface WatcherDeps {
  store: WatcherStore
  settings: () => WatcherSettings
  log: (msg: string) => void
  /** Ask the decision seat. Null: the seat is off or did not answer. */
  decide?: (input: CheckpointInput) => Promise<SeatAnswer | null>
  lookups?: WatcherLookup[]
  /** Start a turn on the delegating agent. */
  alertAgent: (agentId: string, text: string, watcher: WatcherRecord) => Promise<void>
  alertOwner: (title: string, text: string, watcher: WatcherRecord) => Promise<void>
  /** Write a step on the run's trace, so the task page shows the decision. */
  traceStep?: (taskId: string, agentId: string, summary: string) => void
  now?: () => number
}

export interface CheckpointInput {
  /** The id the task is watched under: the delegation id, or the run's
   *  trace id. A delegated run reports its delegation id here, so the
   *  run and the delegation share one watcher. */
  taskKey: string
  source: WatcherSource
  agentId: string
  message: string
  delegator?: string | null
  channel?: string | null
  chatId?: string | null
  dueAt?: number | null
  /** The run's trace id, for the trace step. */
  traceId?: string
}

export interface CheckpointResult {
  decision: CheckpointDecision
  probability: number | null
  watcherId: string | null
  reason: string
}

/** The delegation id a delegated run's chat carries (a2a:caller:callee:dlg-…). */
export function delegationIdOf(chatId: string | undefined | null): string | null {
  const m = /:(dlg-[a-z0-9]+-[0-9a-f]+)$/.exec(chatId ?? "")
  return m ? m[1] : null
}

/** The agent that handed a run on, from its sender ("agent:<id>"). */
export function delegatorOf(sender: { name?: string; id?: string } | undefined): string | null {
  for (const v of [sender?.id, sender?.name]) {
    const m = /^agent:(.+)$/.exec(v ?? "")
    if (m) return m[1]
  }
  return null
}

/** A due time from an ISO string or epoch milliseconds. Null when absent
 *  or unreadable: a bad value must not stop the task. */
export function parseDueAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** The watcher fields of task:started: the due time (the task's own, else
 *  its context's) as ISO, and the delegation a delegated run belongs to.
 *  Empty when absent or unreadable. */
export function watchFields(task: { dueAt?: unknown; context?: unknown }): { dueAt?: string; delegationId?: string } {
  const ctx = (task.context ?? {}) as { dueAt?: unknown; delegationId?: unknown }
  const t = parseDueAt(task.dueAt ?? ctx.dueAt)
  const dlg = typeof ctx.delegationId === "string" && ctx.delegationId.startsWith("dlg-") ? ctx.delegationId : null
  return { ...(t ? { dueAt: new Date(t).toISOString() } : {}), ...(dlg ? { delegationId: dlg } : {}) }
}

/** The seat call, as the daemon wires it. Kept here so tests can mock the
 *  seat module and exercise the real mapping. */
export async function askTaskWatchSeat(input: CheckpointInput): Promise<SeatAnswer | null> {
  const { askSeat } = await import("@/decisions/seat")
  const result = await askSeat(
    TASK_WATCH_SEAT,
    taskWatchState({
      message: input.message,
      agent: input.agentId,
      source: input.source,
      channel: input.channel,
      delegator: input.delegator,
      dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null,
    }),
    taskWatchQuestions,
    {
      // The structural rule this has to beat: watch what has a due time or
      // was handed on.
      incumbent: { needsWatcher: input.dueAt || input.delegator ? 1 : 0 },
      links: [{ kind: "task", id: input.traceId ?? input.taskKey }],
      features: { agent: input.agentId, source: input.source, channel: input.channel ?? "unknown" },
    },
  )
  if (!result) return null
  return { probability: needsWatcher(result.answers as TaskWatchAnswers), mode: result.mode, callId: result.callId }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)
const when = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")

export class TaskWatcher {
  /** Run trace id → the task key it is watched under. */
  private runs = new Map<string, string>()
  /** Run trace id → its checkpoint in flight. A short run can end while
   *  the seat is still answering; its end waits for the watcher. */
  private pending = new Map<string, Promise<unknown>>()
  private readonly now: () => number

  constructor(private deps: WatcherDeps) {
    this.now = deps.now ?? Date.now
  }

  private get settings(): WatcherSettings {
    return this.deps.settings()
  }

  private async guard<T>(what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e: any) {
      this.deps.log(`[watchers] ${what} failed: ${e?.message ?? e}`)
      return undefined
    }
  }

  // --- The checkpoint -----------------------------------------------------

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult | undefined> {
    return this.guard(`checkpoint for ${input.taskKey}`, async () => {
      const s = this.settings
      if (!s.enabled || !s.sources.includes(input.source)) return undefined
      if (input.traceId) this.runs.set(input.traceId, input.taskKey)
      const now = this.now()

      // Look up first: a task already watched costs no seat call.
      const ours = this.deps.store.live(input.taskKey)
      const other = ours ? null : this.otherWatcher(input)
      if (ours || other) {
        const result: CheckpointResult = {
          decision: "existing",
          probability: null,
          watcherId: ours?.id ?? other!.id,
          reason: ours ? `already watched by ${ours.id}` : `already watched by ${other!.kind} ${other!.id}`,
        }
        this.record(input, result, null, now, ours ? "watcher" : other!.kind)
        return result
      }

      let answer: SeatAnswer | null = null
      try {
        answer = this.deps.decide ? await this.deps.decide(input) : null
      } catch {
        answer = null
      }
      const p = answer?.probability ?? null

      // Only an active seat may say no. Off, unreachable or shadow leaves
      // the decision uncertain, and uncertain attaches.
      const structural = !!input.dueAt || !!input.delegator
      let attach: boolean
      let reason: string
      if (structural) {
        attach = true
        reason = input.dueAt ? `has a due time (${when(input.dueAt)})` : `handed on by ${input.delegator}`
        if (p !== null) reason += `; seat ${p.toFixed(2)}`
      } else if (p === null || answer!.mode !== "active") {
        attach = true
        reason = p === null ? "no decision (seat off or unavailable): attached to be safe" : `seat in ${answer!.mode} (${p.toFixed(2)}): attached to be safe`
      } else if (p < s.skipBelow) {
        attach = false
        reason = `confident no (${p.toFixed(2)} below ${s.skipBelow})`
      } else {
        attach = true
        reason = p >= s.attachAbove ? `yes (${p.toFixed(2)})` : `uncertain (${p.toFixed(2)}): attached to be safe`
      }

      if (!attach) {
        const result: CheckpointResult = { decision: "skip", probability: p, watcherId: null, reason }
        this.record(input, result, answer, now, null)
        return result
      }

      const { watcher, created } = this.deps.store.arm({
        taskKey: input.taskKey, source: input.source, agentId: input.agentId, delegator: input.delegator,
        channel: input.channel, chatId: input.chatId, summary: input.message, dueAt: input.dueAt, now,
      })
      const result: CheckpointResult = created
        ? { decision: "attach", probability: p, watcherId: watcher.id, reason }
        : { decision: "existing", probability: p, watcherId: watcher.id, reason: `already watched by ${watcher.id}` }
      this.record(input, result, answer, now, created ? null : "watcher")
      if (created) this.deps.log(`[watchers] ${watcher.id} watching ${input.source} ${input.taskKey} on ${input.agentId}: ${reason}`)
      return result
    })
  }

  private otherWatcher(input: CheckpointInput): { kind: string; id: string } | null {
    for (const lookup of this.deps.lookups ?? []) {
      try {
        const hit = lookup(input)
        if (hit) return hit
      } catch {
        /* a broken lookup is treated as "not watched": attach rather than miss */
      }
    }
    return null
  }

  private record(input: CheckpointInput, r: CheckpointResult, answer: SeatAnswer | null, now: number, existingKind: string | null): void {
    this.deps.store.recordCheckpoint({
      taskKey: input.taskKey, source: input.source, agentId: input.agentId, at: now,
      decision: r.decision, probability: r.probability, seatMode: answer?.mode ?? null,
      callId: answer?.callId ?? null, reason: r.reason, watcherId: r.watcherId, existingKind,
    })
    if (input.traceId && this.deps.traceStep) {
      const p = r.probability === null ? "n/a" : r.probability.toFixed(2)
      try {
        this.deps.traceStep(input.traceId, input.agentId, `${r.decision} p=${p} watcher=${r.watcherId ?? "none"}: ${r.reason}`)
      } catch { /* the audit row above is the record */ }
    }
  }

  // --- Signals --------------------------------------------------------------

  /** A run started: dispatch and cron checkpoints, and the delegated run
   *  of a delegation that is already watched. */
  async taskStarted(p: AgentXEvents["task:started"] & { dueAt?: string | number }): Promise<void> {
    if (!p.taskId || p.channel === WATCHER_CHANNEL) return
    const s = this.settings
    if (!s.enabled) return
    const dlg = p.delegationId ?? delegationIdOf(p.chatId)
    const delegator = delegatorOf(p.sender)
    const dueAt = parseDueAt(p.dueAt)
    const source: WatcherSource | null =
      p.channel === "cron" ? "cron"
      : dlg ? "delegation"
      : dueAt || delegator || s.dispatchChannels.includes(p.channel) ? "dispatch"
      : null
    if (!source) return
    // A run that continues one a restart cut off keeps that run's watcher.
    const resumed = !dlg && p.resumedFrom && this.deps.store.live(p.resumedFrom) ? p.resumedFrom : null
    const run = this.checkpoint({
      taskKey: dlg ?? resumed ?? p.taskId,
      source,
      agentId: p.agentId,
      message: p.requestText ?? p.fullMessage ?? p.messagePreview,
      delegator,
      channel: p.channel,
      chatId: p.chatId,
      dueAt,
      traceId: p.taskId,
    })
    this.pending.set(p.taskId, run)
    try {
      await run
    } finally {
      this.pending.delete(p.taskId)
    }
  }

  /** A run ended. With a result it is the done signal; without one (an
   *  error, a timeout, an empty answer) the watcher fires now. A run a
   *  shutdown cut off is left armed: the resumed run or the quiet check
   *  decides. A run stopped on purpose is done: someone chose to end it. */
  async taskCompleted(p: AgentXEvents["task:completed"]): Promise<void> {
    if (!p.taskId) return
    await this.pending.get(p.taskId)
    const key = this.runs.get(p.taskId)
    if (!key) return
    this.runs.delete(p.taskId)
    await this.guard(`run end ${p.taskId}`, async () => {
      if (p.interrupted) return
      const w = this.deps.store.live(key)
      if (!w) return
      const stopped = p.stopped || p.errorKind === "cancelled" || p.errorKind === "stopped"
      const empty = p.finalResponse !== undefined && !p.finalResponse.trim()
      if (stopped || (!p.error && !empty)) {
        this.done(w)
        return
      }
      await this.fire(w, p.error ? `the run ended with an error: ${clip(p.error, 200)}` : "the run ended with no result")
    })
  }

  /** A delegation started from DelegationManager.onStarted. */
  async delegationStarted(d: { id: string; caller: string; callee: string; peer?: string; request: string; origin: { channel: string; chatId: string }; dueAt?: number }): Promise<void> {
    await this.checkpoint({
      taskKey: d.id,
      source: "delegation",
      agentId: d.peer ? `${d.callee}@${d.peer}` : d.callee,
      message: d.request,
      delegator: d.caller,
      channel: d.origin.channel,
      chatId: d.origin.chatId,
      dueAt: d.dueAt ?? null,
    })
  }

  async delegationDone(d: { id: string; callee: string; peer?: string }, status: "done" | "error" | "timeout" | "lost", text: string): Promise<void> {
    await this.guard(`delegation end ${d.id}`, async () => {
      const w = this.deps.store.live(d.id)
      if (!w) return
      if (status === "done" && text.trim() && text !== "(empty answer)") {
        this.done(w)
        return
      }
      const what = { done: "answered with nothing", error: "failed", timeout: "did not answer in time", lost: "was lost in a restart" }[status]
      await this.fire(w, `the delegation ${what}${status === "done" ? "" : `: ${clip(text, 200)}`}`)
    })
  }

  private done(w: WatcherRecord): void {
    if (this.deps.store.markDone(w.id, this.now())) {
      this.deps.log(`[watchers] ${w.id} done (${w.taskKey})${w.status === "fired" ? " after its alert" : ""}`)
    }
  }

  // --- Firing ---------------------------------------------------------------

  /** First alert: the delegating agent, or the owner when there is none. */
  async fire(w: WatcherRecord, reason: string): Promise<void> {
    const toOwner = !w.delegator
    if (!this.deps.store.markFired(w.id, reason, this.now(), toOwner)) return
    this.deps.log(`[watchers] ${w.id} fired (${w.taskKey}): ${reason}`)
    const text = alertText(w, reason, toOwner ? null : this.settings.escalateAfterMinutes)
    if (toOwner) {
      await this.guard(`owner alert ${w.id}`, () => this.deps.alertOwner(ownerTitle(w), text, w))
    } else {
      await this.guard(`agent alert ${w.id}`, () => this.deps.alertAgent(w.delegator!, text, w))
    }
  }

  /** The periodic check: overdue and quiet watchers fire, fired ones that
   *  stayed unresolved go to the owner, and old rows are pruned. */
  async sweep(): Promise<void> {
    const s = this.settings
    if (!s.enabled) return
    await this.guard("sweep", async () => {
      const now = this.now()
      for (const w of this.deps.store.overdue(now)) {
        await this.fire(w, `its due time (${when(w.dueAt!)}) passed with no done signal`)
      }
      for (const w of this.deps.store.quietSince(now - s.quietAfterHours * 3_600_000)) {
        await this.fire(w, `no done signal after ${s.quietAfterHours} hour(s)`)
      }
      for (const w of this.deps.store.firedBefore(now - s.escalateAfterMinutes * 60_000)) {
        if (!this.deps.store.markEscalated(w.id, now)) continue
        this.deps.log(`[watchers] ${w.id} escalated to the owner (${w.taskKey})`)
        const text = `${alertText(w, w.fireReason ?? "it was not finished", null)}\n${w.delegator} was told ${s.escalateAfterMinutes} minute(s) ago and it is still not done.`
        await this.guard(`owner alert ${w.id}`, () => this.deps.alertOwner(ownerTitle(w), text, w))
      }
      this.deps.store.prune(now - s.retentionDays * 86_400_000)
    })
  }
}

function ownerTitle(w: WatcherRecord): string {
  return `Unfinished task on ${w.agentId}`
}

function alertText(w: WatcherRecord, reason: string, escalateAfter: number | null): string {
  const lines = [
    `[agentx:watcher ${w.id}] ${escalateAfter !== null ? "A task you handed on" : "A task"} may not be finished: ${reason}.`,
    `Task (${w.source} ${w.taskKey}) on ${w.agentId}: ${w.summary}`,
  ]
  if (w.dueAt) lines.push(`Due: ${when(w.dueAt)}`)
  if (escalateAfter !== null) {
    lines.push(`Check it and finish or re-assign it. The owner is told in ${escalateAfter} minute(s) if it is still not done.`)
  }
  return lines.join("\n")
}
