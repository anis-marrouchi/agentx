import type { AgentXEvents } from "@/events/bus"
import type { DelegationRecord, DelegationStatus } from "@/a2a/delegation"
import { isDelegationRelay } from "@/a2a/delegation"
import { askSeat, recordSeatOutcome } from "@/decisions/seat"
import {
  TASK_WATCH_SEAT, needsWatcher, taskWatchQuestions, taskWatchState,
  type TaskWatchInput, type TaskWatchKind,
} from "@/decisions/seats/task-watch"
import type { WatchDecision, WatcherRecord, WatcherStore } from "./store"

// --- The watcher checkpoint at every task start (#1030) ---
//
//   1. Look up  a watcher for this task already exists (ours, or one a
//               lookup reports, such as a tracked plan): record it, stop.
//   2. Decide   the task-watch seat says how likely the task carries a
//               deadline, a promise to the owner, or a hand-off.
//   3. Attach   unless the seat is active and confidently says no. A seat
//               that is off, failed, in shadow or unsure attaches: fail-safe.
//   4. Record   the decision, its probability and the watcher id on the
//               watcher row and on the run's trace.
//
// A watcher fires when its due time passes with no done signal, or when the
// task ends without a result. It tells the delegating agent first and the
// owner after `escalateAfterMinutes`; with no delegating agent on this node
// it tells the owner at once.
//
// Every entry point swallows its own errors: watching a task must never
// break the task.

/** Channel of the turn that tells a delegating agent its watcher fired. */
export const WATCHER_CHANNEL = "watchers"

export interface WatcherSettings {
  enabled: boolean
  /** Channels whose runs are never checked. */
  skipChannels: string[]
  /** The due time of a task that gives none, from its start. */
  defaultDueMinutes: number
  /** Below: a confident "no". Only an active seat acts on it. */
  noBelow: number
  /** At or above: "yes". Between `noBelow` and this: "uncertain". */
  yesAt: number
  /** After the delegating agent was told, the owner is told this much later. */
  escalateAfterMinutes: number
  /** Finished watchers are deleted after this many days. */
  retentionDays: number
  /** What closes a watcher. "result": a run that ends with a reply, or a
   *  delegation that answers. "explicit": only a done signal (POST
   *  /watchers/:id/done), so a reply that only promises keeps it open. */
  doneSignal: DoneSignal
}

export type DoneSignal = "result" | "explicit"

export interface DecideResult {
  probability: number | null
  callId: string | null
  /** "active" is the only mode whose "no" skips a watcher. */
  mode: "off" | "shadow" | "active"
}

export interface CheckpointDeps {
  store: WatcherStore
  settings: () => WatcherSettings
  /** The typed decision. Default: the task-watch seat. */
  decide?: (input: TaskWatchInput, key: string) => Promise<DecideResult>
  /** Other watchers that may already follow this task. Each returns a
   *  short description of the watcher it found, or null. */
  lookups?: Array<(task: { key: string; traceId: string | null }) => string | null>
  /** Is this agent on this node (can it take an alert turn)? */
  hasAgent: (agentId: string) => boolean
  alertAgent: (agentId: string, text: string, w: WatcherRecord) => Promise<void>
  alertOwner: (title: string, text: string, w: WatcherRecord) => Promise<void>
  /** How the alert tells the delegating agent to mark the task done. */
  doneHint?: DoneHint
  log: (msg: string) => void
  now?: () => number
}

export interface TaskStart {
  key: string
  traceId: string | null
  kind: TaskWatchKind
  agentId: string
  channel: string
  delegator: string | null
  message: string
  dueAt: number | null
  /** The run a restart cut off, when this run resumes it. */
  resumedFrom?: string | null
}

export type CheckResult =
  | { action: "skipped" }
  | { action: "existing"; watcherId: string | null; found: string }
  | { action: "attached"; watcher: WatcherRecord; decision: WatchDecision }
  | { action: "declined"; decision: "no"; probability: number }

const MINUTE = 60_000
const DLG_CHAT = /^a2a:[^:]+:[^:]+:(dlg-[A-Za-z0-9-]+)$/

const clip = (s: string, n = 200) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** What a run start is, for the checkpoint. Null: not checked. */
export function taskStartOf(e: AgentXEvents["task:started"], settings: Pick<WatcherSettings, "skipChannels">): TaskStart | null {
  const traceId = e.taskId ?? null
  if (e.channel === WATCHER_CHANNEL || settings.skipChannels.includes(e.channel)) return null
  // The relay of a delegation's result is the end of that delegation.
  if (isDelegationRelay(e.fullMessage ?? e.messagePreview)) return null
  const message = e.requestText || e.fullMessage || e.messagePreview || ""
  const base = { traceId, agentId: e.agentId, channel: e.channel, message, dueAt: e.dueAt ?? null, resumedFrom: e.resumedFrom ?? null }
  const dlg = e.channel === "a2a" ? DLG_CHAT.exec(e.chatId)?.[1] : undefined
  const sender = e.sender?.name ?? ""
  const caller = sender.startsWith("agent:") ? sender.slice("agent:".length) : null
  if (dlg) return { ...base, key: dlg, kind: "delegation", delegator: caller }
  if (!traceId) return null
  if (e.channel === "cron") return { ...base, key: traceId, kind: "cron", delegator: null }
  if (caller) return { ...base, key: traceId, kind: "delegation", delegator: caller }
  return { ...base, key: traceId, kind: "dispatch", delegator: null }
}

/** Yes, no or uncertain, from a probability and the settings. */
export function classify(p: number | null, s: Pick<WatcherSettings, "noBelow" | "yesAt">): WatchDecision {
  if (p === null || !Number.isFinite(p)) return "uncertain"
  if (p < s.noBelow) return "no"
  if (p >= s.yesAt) return "yes"
  return "uncertain"
}

async function seatDecide(input: TaskWatchInput, key: string): Promise<DecideResult> {
  const res = await askSeat(TASK_WATCH_SEAT, taskWatchState(input), taskWatchQuestions, {
    incumbent: { needsWatcher: 1 },
    links: [{ kind: "task", id: key }],
    features: { agent: input.agent, kind: input.kind, channel: input.channel ?? null },
  })
  if (!res) return { probability: null, callId: null, mode: "off" }
  return { probability: needsWatcher(res.answers), callId: res.callId, mode: res.mode === "active" ? "active" : "shadow" }
}

export class WatchCheckpoint {
  /** Checks still deciding, by task key and by run (trace) id. */
  private inflight = new Map<string, Promise<CheckResult>>()
  private checking = new Map<string, Promise<CheckResult>>()
  private readonly now: () => number

  constructor(private deps: CheckpointDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Runs the checkpoint once per task key. A second call for a key still
   *  being decided waits for the first instead of deciding again. */
  check(task: TaskStart): Promise<CheckResult> {
    if (!this.deps.settings().enabled) return Promise.resolve({ action: "skipped" })
    const running = this.inflight.get(task.key)
    if (running) return this.tracked(task.traceId, running.then((r) => this.joined(task, r)))
    const p = this.run(task)
      .catch((e: any): CheckResult => {
        this.deps.log(`[watchers] checkpoint for ${task.key} failed: ${e?.message ?? e}`)
        return { action: "skipped" }
      })
      .finally(() => this.inflight.delete(task.key))
    this.inflight.set(task.key, p)
    return this.tracked(task.traceId, p)
  }

  /** Remembers the check a run is waiting on, so its end (which can come
   *  before the decision does) is read after the watcher exists. */
  private tracked(traceId: string | null, p: Promise<CheckResult>): Promise<CheckResult> {
    if (!traceId) return p
    this.checking.set(traceId, p)
    void p.finally(() => { if (this.checking.get(traceId) === p) this.checking.delete(traceId) })
    return p
  }

  /** A second start of a task already being checked: it found that one. */
  private joined(task: TaskStart, first: CheckResult): CheckResult {
    try {
      const w = this.deps.store.byKey(task.key)
      if (!w) return first
      this.link(task, w)
      return { action: "existing", watcherId: w.id, found: w.id }
    } catch (e: any) {
      this.deps.log(`[watchers] checkpoint for ${task.key} failed: ${e?.message ?? e}`)
      return { action: "skipped" }
    }
  }

  private link(task: TaskStart, w: WatcherRecord): void {
    if (!task.traceId) return
    if (task.traceId !== w.taskKey) this.deps.store.setTrace(w.id, task.traceId)
    this.deps.store.recordOnTrace(task.traceId, "existing", w.probability, w.id)
  }

  private async run(task: TaskStart): Promise<CheckResult> {
    const { store } = this.deps
    const settings = this.deps.settings()

    // 1. Look up.
    // A run resumed after a restart continues its cut-off run's task.
    const own = store.byKey(task.key) ?? (task.resumedFrom ? store.byTrace(task.resumedFrom) : null)
    if (own) {
      this.link(task, own)
      return { action: "existing", watcherId: own.id, found: own.id }
    }
    for (const lookup of this.deps.lookups ?? []) {
      let found: string | null = null
      try { found = lookup({ key: task.key, traceId: task.traceId }) } catch { /* a lookup never stops the check */ }
      if (found) {
        if (task.traceId) store.recordOnTrace(task.traceId, "existing", null, found)
        return { action: "existing", watcherId: null, found }
      }
    }

    // 2. Decide.
    const decide = this.deps.decide ?? seatDecide
    const input: TaskWatchInput = {
      message: task.message, agent: task.agentId, kind: task.kind, channel: task.channel,
      delegator: task.delegator, dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    }
    let result: DecideResult
    try {
      result = await decide(input, task.key)
    } catch {
      result = { probability: null, callId: null, mode: "off" }
    }
    const decision = classify(result.probability, settings)

    // 3. Attach, unless an active seat confidently said no.
    if (decision === "no" && result.mode === "active") {
      recordSeatOutcome(result.callId, "skip")
      if (task.traceId) store.recordOnTrace(task.traceId, "no", result.probability, null)
      return { action: "declined", decision: "no", probability: result.probability! }
    }
    const now = this.now()
    const { watcher, created } = store.add({
      taskKey: task.key, traceId: task.traceId, kind: task.kind, agentId: task.agentId,
      delegator: task.delegator, summary: clip(task.message), dueAt: task.dueAt ?? now + settings.defaultDueMinutes * MINUTE,
      decision, probability: result.probability, decisionCallId: result.callId, createdAt: now,
    })
    // Another process added one between the look-up and here.
    if (!created) {
      this.link(task, watcher)
      return { action: "existing", watcherId: watcher.id, found: watcher.id }
    }
    recordSeatOutcome(result.callId, "review")

    // 4. Record.
    if (task.traceId) store.recordOnTrace(task.traceId, decision, result.probability, watcher.id)
    const p = result.probability === null ? "none" : result.probability.toFixed(2)
    this.deps.log(`[watchers] ${watcher.id}: attached to ${task.agentId} (${task.kind}, ${decision}, p=${p}), due ${new Date(watcher.dueAt).toISOString()}`)
    return { action: "attached", watcher, decision }
  }

  /** A delegation started: checked under its id, which the callee's own
   *  run on this node shares, so the two starts make one watcher. A peer
   *  callee runs elsewhere, and this is the only start this node sees. */
  delegationStarted(rec: Pick<DelegationRecord, "id" | "caller" | "callee" | "peer" | "request">, dueAt: number | null = null): Promise<CheckResult> {
    return this.check({
      key: rec.id, traceId: null, kind: "delegation", agentId: rec.peer ? `${rec.callee}@${rec.peer}` : rec.callee,
      channel: "a2a", delegator: rec.caller, message: rec.request, dueAt,
    })
  }

  /** A run ended. With a result, its watcher is done; without one, it fires.
   *  A delegation's watcher follows the delegation's own end instead. */
  async taskEnded(e: AgentXEvents["task:completed"]): Promise<void> {
    if (!e.taskId) return
    await this.checking.get(e.taskId)
    const w = this.deps.store.byTrace(e.taskId)
    if (!w || (w.kind === "delegation" && w.taskKey.startsWith("dlg-"))) return
    // A restart or a stop signal cut it: it may resume, so the due time decides.
    if (e.interrupted || e.stopped) return
    if (!e.error && e.finalResponse?.trim()) {
      // Explicit: a reply can be a promise ("I'll publish at 18:00"), so
      // only a done signal closes the watcher; the due time still applies.
      if (this.deps.settings().doneSignal === "explicit") return
      // Also after an alert: a late result spares the owner the escalation.
      this.deps.store.transition(w.id, ["open", "alerted"], "done", "ended with a result", this.now())
      return
    }
    await this.fire(w, e.error ? `the run ended with an error: ${clip(e.error, 160)}` : "the run ended without a result")
  }

  /** A delegation ended: done closes its watcher (unless the done signal
   *  is explicit), anything else fires it. */
  async delegationEnded(rec: Pick<DelegationRecord, "id">, status: DelegationStatus, text = ""): Promise<void> {
    await this.inflight.get(rec.id)
    const w = this.deps.store.byKey(rec.id)
    if (!w) return
    if (status === "done") {
      if (this.deps.settings().doneSignal === "explicit") return
      this.deps.store.transition(w.id, ["open", "alerted"], "done", "delegation answered", this.now())
      return
    }
    const why = { error: "the delegation failed", timeout: "the delegation did not answer in time", lost: "the delegation was lost in a restart" }[status]
    await this.fire(w, `${why}${text ? `: ${clip(text, 160)}` : ""}`)
  }

  /** Someone said the task is done (the API, the delegating agent). */
  markDone(id: string, evidence = "marked done"): boolean {
    return this.deps.store.transition(id, ["open", "alerted", "escalated"], "done", evidence, this.now())
  }

  /** Every minute: fire what is overdue, escalate what was not answered,
   *  delete old finished watchers. */
  async sweep(): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.enabled) return
    const now = this.now()
    for (const w of this.deps.store.due(now)) {
      await this.fire(w, "the due time passed with no done signal")
    }
    for (const w of this.deps.store.unescalated(now - settings.escalateAfterMinutes * MINUTE)) {
      await this.escalate(w, `${w.delegator ?? "The delegating agent"} was told ${Math.round((now - (w.alertedAt ?? now)) / MINUTE)} min ago and the task is still not done`)
    }
    this.deps.store.prune(now - settings.retentionDays * 24 * 60 * MINUTE)
  }

  private async fire(w: WatcherRecord, reason: string): Promise<void> {
    if (w.delegator && this.deps.hasAgent(w.delegator)) {
      if (!this.deps.store.transition(w.id, ["open"], "alerted", reason, this.now())) return
      try {
        await this.deps.alertAgent(w.delegator, agentAlertText(w, reason, this.deps.doneHint), w)
        this.deps.log(`[watchers] ${w.id}: told ${w.delegator} (${reason})`)
        return
      } catch (e: any) {
        this.deps.log(`[watchers] ${w.id}: could not tell ${w.delegator}: ${e?.message ?? e}`)
        await this.escalate({ ...w, state: "alerted" }, `${reason}; ${w.delegator} could not be told`)
        return
      }
    }
    await this.escalate(w, reason)
  }

  private async escalate(w: WatcherRecord, reason: string): Promise<void> {
    if (!this.deps.store.transition(w.id, ["open", "alerted"], "escalated", reason, this.now())) return
    try {
      await this.deps.alertOwner("A task is not finished", ownerAlertText(w, reason), w)
      this.deps.log(`[watchers] ${w.id}: told the owner (${reason})`)
    } catch (e: any) {
      this.deps.log(`[watchers] ${w.id}: could not tell the owner: ${e?.message ?? e}`)
    }
  }
}

/** How a watcher is marked done, as told to the delegating agent. */
export type DoneHint = (w: WatcherRecord) => string

const apiDoneHint: DoneHint = (w) => `POST /watchers/${w.id}/done on this node's daemon`

export function agentAlertText(w: WatcherRecord, reason: string, doneHint: DoneHint = apiDoneHint): string {
  return [
    `[agentx:watcher id=${w.id} task=${w.taskKey}]`,
    `A task you handed to ${w.agentId} is not finished. Why: ${reason}.`,
    "",
    `The task: ${w.summary}`,
    `Due: ${new Date(w.dueAt).toISOString()}`,
    "",
    "Find out where it stands and finish it, hand it on, or tell the owner why it cannot be done.",
    `When it is done, say so: ${doneHint(w)}`,
    "If nothing happens, the owner is told.",
  ].join("\n")
}

export function ownerAlertText(w: WatcherRecord, reason: string): string {
  const by = w.delegator ? ` (handed over by ${w.delegator})` : ""
  return `${w.agentId}${by}: ${w.summary}\nWhy: ${reason}. Due ${new Date(w.dueAt).toISOString()}. Watcher ${w.id}.`
}
