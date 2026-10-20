import type { AgentXEvents } from "@/events/bus"
import type { DelegationRecord, DelegationStatus } from "@/a2a/delegation"
import { isDelegationRelay } from "@/a2a/delegation"
import { askSeat, recordSeatOutcome } from "@/decisions/seat"
import {
  TASK_WATCH_SEAT, needsWatcher, taskWatchQuestions, taskWatchState,
  type TaskWatchInput, type TaskWatchKind,
} from "@/decisions/seats/task-watch"
import type { WatchDecision, WatcherRecord, WatcherStore } from "./store"
import {
  checkEvidence, describeEvidence, evidenceExample, evidenceRuleFor, parseEvidence, requirementText,
  type EvidenceRule,
} from "./evidence"

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
// A task whose type has an evidence rule (#1049) closes only on a done
// signal whose evidence the rule accepts; its reply never closes it. A run
// with no delegating agent (a cron, a dispatch) is told so in its own
// prompt (runNote), since no one else would close its watcher.
//
// Every entry point swallows its own errors: watching a task must never
// break the task.

/** Channel of the turn that tells a delegating agent its watcher fired,
 *  when the chat it delegated from is not known. */
export const WATCHER_CHANNEL = "watchers"

/** How every alert to a delegating agent starts (agentAlertText). */
export const WATCHER_ALERT_MARKER = "[agentx:watcher "

/** Is this turn message a watcher's alert? */
export function isWatcherAlert(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(WATCHER_ALERT_MARKER)
}

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
  /** Evidence rules by task type (#1049). A task with no rule for its type
   *  closes as `doneSignal` says. */
  evidence?: Record<string, EvidenceRule>
}

/** What a done signal did: `error` is why its evidence was refused. */
export type DoneResult = { changed: boolean; error?: undefined } | { changed: false; error: string; required: string }

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
  /** Did this node start the delegation? A run for a delegation another
   *  node started is watched there, not here. Unset: every one is local. */
  isLocalDelegation?: (id: string) => boolean
  alertAgent: (agentId: string, text: string, w: WatcherRecord) => Promise<void>
  alertOwner: (title: string, text: string, w: WatcherRecord) => Promise<void>
  /** How an agent is told to mark the task done, with the evidence the
   *  task's rule accepts. */
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
  /** The caller's `context.taskType`, which picks the evidence rule. */
  taskType?: string | null
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
  // A watcher's own alert, told in the delegator's chat (#1100).
  if (isWatcherAlert(e.fullMessage ?? e.messagePreview)) return null
  const message = e.requestText || e.fullMessage || e.messagePreview || ""
  const base = {
    traceId, agentId: e.agentId, channel: e.channel, message, dueAt: e.dueAt ?? null,
    taskType: e.taskType ?? null, resumedFrom: e.resumedFrom ?? null,
  }
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
  /** Watchers whose run said it ends to wait (markWaiting), until it ends. */
  private waitingRuns = new Set<string>()
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
    // The delegation's start carries no due time; its callee run can.
    if (task.dueAt && task.dueAt !== w.dueAt) this.deps.store.setDue(w.id, task.dueAt)
    if (task.taskType && task.taskType !== w.taskType) this.deps.store.setTaskType(w.id, task.taskType)
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
    // A run for a delegation another node started (the peer side of a
    // mesh hand-off): the caller's node watches it and hears its end.
    if (task.kind === "delegation" && task.traceId && task.key.startsWith("dlg-")
      && this.deps.isLocalDelegation && !this.deps.isLocalDelegation(task.key)) {
      return { action: "skipped" }
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
      taskType: task.taskType ?? null,
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
  delegationStarted(rec: Pick<DelegationRecord, "id" | "caller" | "callee" | "peer" | "request" | "taskType">, dueAt: number | null = null): Promise<CheckResult> {
    return this.check({
      key: rec.id, traceId: null, kind: "delegation", agentId: rec.peer ? `${rec.callee}@${rec.peer}` : rec.callee,
      channel: "a2a", delegator: rec.caller, message: rec.request, dueAt, taskType: rec.taskType ?? null,
    })
  }

  /** A running task says it ends its run to wait for something before the
   *  work is done (#1100): its reply will not close its watcher, which is
   *  due when the wait should end, if that was given. A delegation's
   *  watcher hears it from the delegation's end instead. The watcher id,
   *  or null when the run has none. */
  markWaiting(traceId: string, dueAt?: number): string | null {
    const w = this.deps.store.byTrace(traceId)
    if (!w || !["open", "alerted"].includes(w.state)) return null
    if (dueAt) this.deps.store.setDue(w.id, dueAt)
    if (!(w.kind === "delegation" && w.taskKey.startsWith("dlg-"))) this.waitingRuns.add(w.id)
    return w.id
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
    // The run said it ends to wait for something (#1100): not done.
    const waited = this.waitingRuns.delete(w.id)
    if (!e.error && e.finalResponse?.trim()) {
      // Explicit: a reply can be a promise ("I'll publish at 18:00"), so
      // only a done signal closes the watcher; the due time still applies.
      if (waited || this.needsExplicitDone(w)) return
      // Also after an alert: a late result spares the owner the escalation.
      this.deps.store.transition(w.id, ["open", "alerted"], "done", "ended with a result", this.now())
      return
    }
    await this.fire(w, e.error ? `the run ended with an error: ${clip(e.error, 160)}` : "the run ended without a result")
  }

  /** A delegation ended: done closes its watcher (unless the done signal
   *  is explicit), anything else fires it. */
  async delegationEnded(rec: Pick<DelegationRecord, "id">, status: DelegationStatus, text = "", dueAt?: number): Promise<void> {
    await this.inflight.get(rec.id)
    const w = this.deps.store.byKey(rec.id)
    if (!w) return
    // The callee ended its run to wait (#1100): not done. The watcher
    // stays open, due when the callee said the wait ends, if it said.
    if (status === "waiting") {
      if (dueAt) this.deps.store.setDue(w.id, dueAt)
      return
    }
    if (status === "done") {
      if (this.needsExplicitDone(w)) return
      this.deps.store.transition(w.id, ["open", "alerted"], "done", "delegation answered", this.now())
      return
    }
    const why = { error: "the delegation failed", timeout: "the delegation did not answer in time", lost: "the delegation was lost in a restart" }[status]
    await this.fire(w, `${why}${text ? `: ${clip(text, 160)}` : ""}`)
  }

  /** The evidence rule for a watcher's task type, if any. */
  ruleFor(w: Pick<WatcherRecord, "taskType" | "kind">): EvidenceRule | null {
    return evidenceRuleFor(this.deps.settings().evidence, w)
  }

  /** Only a done signal closes it: the explicit mode, or an evidence rule. */
  private needsExplicitDone(w: WatcherRecord): boolean {
    return this.deps.settings().doneSignal === "explicit" || !!this.ruleFor(w)
  }

  /** Someone said the task is done (the API, the delegating agent). When
   *  the task's type has an evidence rule, the evidence must pass it; else
   *  any evidence, or none, closes it as before. Readable evidence is kept
   *  on the watcher either way. */
  markDone(id: string, evidence?: unknown): DoneResult {
    const w = this.deps.store.get(id)
    if (!w || w.state === "done") return { changed: false }
    const parsed = parseEvidence(evidence)
    const rule = this.ruleFor(w)
    if (rule) {
      const why = typeof parsed === "string" ? parsed : checkEvidence(rule, parsed)
      if (why) {
        this.deps.log(`[watchers] ${w.id}: done refused (${why})`)
        return { changed: false, error: why, required: requirementText(rule) }
      }
    }
    // No rule: evidence that cannot be read is left out, as before.
    const ev = typeof parsed === "string" ? null : parsed
    // A plain string reads as before: the watcher's reason is that string.
    const reason = typeof evidence === "string" && evidence.trim() ? evidence.trim() : ev ? describeEvidence(ev) : "marked done"
    const changed = this.deps.store.transition(id, ["open", "alerted", "escalated"], "done", reason, this.now(), ev)
    return { changed }
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
      // The alert is a whole agent turn: not waited for, so one slow turn
      // does not hold up the other watchers or the next sweep.
      const delegator = w.delegator
      const alert = this.deps.alertAgent(delegator, agentAlertText(w, reason, this.deps.doneHint ?? apiDoneHint, this.ruleFor(w)), w)
        .then(() => this.deps.log(`[watchers] ${w.id}: told ${delegator} (${reason})`))
        .catch(async (e: any) => {
          this.deps.log(`[watchers] ${w.id}: could not tell ${delegator}: ${e?.message ?? e}`)
          await this.escalate({ ...w, state: "alerted" }, `${reason}; ${delegator} could not be told`)
        })
        .catch(() => { /* escalate logs its own failure */ })
        .finally(() => this.alerting.delete(alert))
      this.alerting.add(alert)
      return
    }
    await this.escalate(w, reason)
  }

  /** Alert turns still running. */
  private alerting = new Set<Promise<void>>()

  /** Resolves when every alert turn started so far has ended. */
  async settled(): Promise<void> {
    while (this.alerting.size) await Promise.all([...this.alerting])
  }

  /** For a delegation's result, when only an explicit done closes its
   *  watcher: tells the delegating agent how to close it. */
  doneNote(delegationId: string): string | undefined {
    try {
      const w = this.deps.store.byKey(delegationId)
      if (!w || (w.state !== "open" && w.state !== "alerted")) return undefined
      if (!this.needsExplicitDone(w)) return undefined
      const rule = this.ruleFor(w)
      const hint = (this.deps.doneHint ?? apiDoneHint)(w, rule)
      const proof = rule ? ` It needs evidence: ${requirementText(rule)}.` : ""
      return `Watcher ${w.id} follows this task and only an explicit done closes it. If the work is really finished (not only promised), mark it done: ${hint}.${proof} Otherwise it fires at ${new Date(w.dueAt).toISOString()}.`
    } catch {
      return undefined
    }
  }

  /** For a run's own prompt, when nothing but that run can close the
   *  watcher that may follow it: a run with no delegating agent (a cron, a
   *  dispatch) whose task only an explicit done closes (an evidence rule,
   *  or `doneSignal: "explicit"`). Without it the run never learns it is
   *  watched, and every such run is escalated to the owner at its due
   *  time. The watcher is attached after the run starts, so the note names
   *  the id it gets. Undefined: nothing to say. */
  runNote(e: AgentXEvents["task:started"]): string | undefined {
    try {
      const settings = this.deps.settings()
      if (!settings.enabled) return undefined
      const task = taskStartOf(e, settings)
      if (!task || task.delegator) return undefined
      const own = this.deps.store.byKey(task.key) ?? (task.resumedFrom ? this.deps.store.byTrace(task.resumedFrom) : null)
      if (own?.state === "done") return undefined
      const typed = { taskType: own?.taskType ?? task.taskType ?? null, kind: task.kind }
      const rule = evidenceRuleFor(settings.evidence, typed)
      if (!rule && settings.doneSignal !== "explicit") return undefined
      const id = own?.id ?? `watch-${task.key}`
      const hint = (this.deps.doneHint ?? apiDoneHint)({ id }, rule)
      return [
        `[agentx:watcher id=${id}] A watcher may follow this run. Your reply does not close it.`,
        `When the work is really finished (not only promised), mark it done: ${hint}`,
        rule ? `Done needs evidence: ${requirementText(rule)}. Without it, done is refused.` : "",
        "If it is not marked done, the owner is told at its due time. A 404 answer means no watcher follows this run.",
      ].filter(Boolean).join("\n")
    } catch {
      return undefined
    }
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

/** How a watcher is marked done, as told to an agent. `rule` is the
 *  task's evidence rule, so the example evidence is one it accepts. */
export type DoneHint = (w: Pick<WatcherRecord, "id">, rule: EvidenceRule | null) => string

const apiDoneHint: DoneHint = (w, rule) => `POST /watchers/${w.id}/done on this node's daemon with {"evidence":${evidenceExample(rule)}}`

export function agentAlertText(w: WatcherRecord, reason: string, doneHint: DoneHint = apiDoneHint, rule: EvidenceRule | null = null): string {
  return [
    `${WATCHER_ALERT_MARKER}id=${w.id} task=${w.taskKey}]`,
    `A task you handed to ${w.agentId} is not finished. Why: ${reason}.`,
    "",
    `The task: ${w.summary}`,
    `Due: ${new Date(w.dueAt).toISOString()}`,
    "",
    "Find out where it stands and finish it, hand it on, or tell the owner why it cannot be done.",
    `When it is done, say so: ${doneHint(w, rule)}`,
    ...(rule ? [`Done needs evidence: ${requirementText(rule)}, sent as the evidence value. Without it, done is refused.`] : []),
    "If nothing happens, the owner is told.",
  ].join("\n")
}

export function ownerAlertText(w: WatcherRecord, reason: string): string {
  const by = w.delegator ? ` (handed over by ${w.delegator})` : ""
  return `${w.agentId}${by}: ${w.summary}\nWhy: ${reason}. Due ${new Date(w.dueAt).toISOString()}. Watcher ${w.id}.`
}
