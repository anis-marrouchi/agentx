import { callerAgentOf, type RunOrigin } from "@/agents/resume/origin"
import { builderLines, builderWindDownMs, type BuilderWindDown } from "./builders"
import { outcomeLines, validOrderId, type StopAllOutcome } from "./orders"
import { agentPlan, machinePlan, resumeNote, windDownMessage, type ResumePlan, type ToolCallRef } from "./plan"
import { canSignal, describeSender, SignalBudget, type SignalSender, type SignalSettings } from "./policy"
import type { StoppedState, StoppedTask, StoppedTaskStore } from "./store"

// --- Stop a running task cleanly, and resume it from its plan (#857) ---
//
// stop:   check who is asking, end the run (status `stopped`, not failed),
//         then give the agent one short wind-down turn to write its resume
//         plan. No answer in time: the wind-down is stopped too and a plan
//         is built from the trace, marked machine-written.
// resume: re-enter the task through the resume coordinator's resumers (the
//         same ones a restart uses), with the plan prepended, on the same
//         chat and under the same root id.
// A step of a workflow run (#870): the stop pauses the whole run at that
// step (not failed), and the resume re-enters the step inside the run,
// which then goes on to its later steps.
// stopAll (#1271): the owner's order to stop every running task on this
//         node. Each one goes through stop(), so each writes its plan; the
//         records carry the order id, and the next boot's resumeStopAll()
//         resumes every one of them from its plan, one attempt each, and
//         answers with one report. Background builders a stopped task
//         had started are wound down with it (#1328): their unsaved work
//         goes on a WIP branch before the agent writes its plan, and the
//         plan and the resume note name it.
// Both publish `signal` events, so subscribers and the live page see them.
// Every step is logged; nothing here throws to the caller except through
// the returned result.

/** A running task a signal can address. */
export interface RunningRef {
  taskId: string
  traceId?: string
  agentId: string
  channel: string
  chatId: string
  sender?: string
  rootId?: string
  originalMessage: string
  origin: RunOrigin | null
  /** Set when the task is a step of a workflow run. */
  workflowRunId?: string
}

export interface SignalServiceDeps {
  settings(): SignalSettings
  store: StoppedTaskStore
  /** A running task by its id, or the only one of `agentId` on a chat. */
  findRunning(by: { taskId?: string; agentId?: string; channel?: string; chatId?: string }): RunningRef | null
  /** Every running task a stop-all addresses (#1271). Absent: none. */
  listRunning?(): RunningRef[]
  /** End the run with status `stopped`. False when it is no longer running. */
  stopRun(taskId: string, reason: string): boolean
  /** Resolves once the run has let go of its slot, or after `timeoutMs`. */
  whenRunEnds(taskId: string, timeoutMs: number): Promise<void>
  /** Tool calls the run made, from its trace. */
  toolCalls(traceId: string | undefined): ToolCallRef[]
  /** Save the work of the background builders the run had started
   *  (builders.ts, #1328). Absent: builders are not wound down. */
  windDownBuilders?(input: { taskId: string; toolCalls: ToolCallRef[]; reason: string; save: boolean }): Promise<BuilderWindDown | undefined>
  /** Run the wind-down turn and answer with its text. Must stop the turn
   *  itself once `timeoutMs` has passed. */
  windDown(input: { id: string; agentId: string; rootId: string; message: string; timeoutMs: number }): Promise<{ content?: string; error?: string }>
  /** Re-enter the task (resume coordinator). Resolves once handed over. */
  resume(input: { record: StoppedTask; note: string }): Promise<void>
  /** The workflow step a running task is (#870), or why its run cannot
   *  pause there. Absent: the workflow engine is off. */
  workflowStep?(runId: string, agentId: string): { workflowId: string; nodeId: string } | { error: string }
  /** Re-enter a paused workflow step with the note, inside its run. Throws
   *  when the run is no longer paused at it. */
  resumeWorkflowStep?(input: { record: StoppedTask; note: string; by: string }): Promise<void>
  /** One line to the chat the task came from; best effort. */
  tell?(origin: RunOrigin, text: string): Promise<void>
  publish(input: { type: string; agentId: string; rootId: string; summary: string; ref: string }): void
  log(msg: string): void
  now?(): number
}

export type SignalResult =
  | { ok: true; record: StoppedTask; done?: Promise<StoppedTask>; delivery?: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 500; error: string }

/** Where a resumed task's answer goes, in words, by its origin. A `direct`
 *  run that names no calling agent (an API call, a schedule, voice) has
 *  nobody waiting: it runs, and its answer is kept on its task page and
 *  trace only. */
export function deliveryOf(origin: RunOrigin | null, workflow?: StoppedTask["workflow"]): string {
  if (workflow) return `workflow run ${workflow.runId}, which goes on from step ${workflow.nodeId}`
  if (!origin) return "nobody: no record of how to re-enter it"

  if (origin.kind === "router") return `the chat it came from (${origin.adapter})`
  if (origin.kind === "mesh") return `the chat it came from, through ${origin.node ?? "the forwarding node"}`
  const caller = callerAgentOf(origin)
  if (caller) return `${caller}, as a new turn`
  return "nobody: the answer is kept on its task page and trace only"
}

/** One task of a stop-all order, as the order's answer lists it. */
export interface StopAllEntry {
  id: string
  agentId: string
  /** `refused`: stop() would not stop it; `error` says why. */
  state: StoppedState | "refused"
  /** Who wrote its resume plan, once saved. */
  plan?: "agent" | "machine"
  /** Background builders the stop also stopped, and how many of their
   *  folders' work was saved on a WIP branch (#1328). */
  builders?: { count: number; saved: number; notSaved: number }
  error?: string
}

export type StopAllResult =
  | { ok: true; orderId: string; tasks: StopAllEntry[]; done: Promise<StopAllEntry[]> }
  | { ok: false; status: 403; error: string }

export type { StopAllOutcome } from "./orders"

/** The one message the owner gets after a restart that followed a stop-all
 *  (#1271): every task of the order, by agent. Null when there were none. */
export function stopAllReport(node: string, outcomes: StopAllOutcome[]): string | null {
  if (!outcomes.length) return null
  const count = (d: StopAllOutcome["decision"]) => outcomes.filter((o) => o.decision === d).length
  const lines = [`After the stop-all on ${node}: ${count("resumed")} resumed, ${count("resume-failed")} failed, ${count("skipped")} skipped.`, ...outcomeLines(outcomes)]
  if (count("resume-failed") || count("skipped")) lines.push("Resume one by hand with: agentx signal resume <id>")
  return lines.join("\n")
}

/** Time the stopped run gets to let go of its slot before the wind-down
 *  starts anyway (the registry's cancel grace, plus a little). */
const RUN_END_WAIT_MS = 35_000

export class SignalService {
  private budget: SignalBudget
  private resuming = new Set<string>()
  private readonly now: () => number

  constructor(private deps: SignalServiceDeps) {
    this.now = deps.now ?? Date.now
    this.budget = new SignalBudget(this.now)
  }

  list(opts: { state?: StoppedTask["state"]; agentId?: string; limit?: number } = {}): StoppedTask[] {
    return this.deps.store.list({ ...opts, now: this.now() })
  }

  /** How long a stop waits for the agent's plan, at most: the run's slot
   *  release, saving its builders' folders (only listing them when saving
   *  is off), then the wind-down turn. */
  windDownMs(): number {
    const settings = this.deps.settings()
    const builders = this.deps.windDownBuilders ? builderWindDownMs(settings.saveBuilderWork !== false) : 0
    return RUN_END_WAIT_MS + builders + settings.windDownSeconds * 1000 + 5_000
  }

  get(id: string): StoppedTask | null {
    return this.deps.store.get(id)
  }

  async stop(
    sender: SignalSender,
    target: { taskId?: string; agentId?: string; channel?: string; chatId?: string },
    reason?: string,
    order?: { orderId: string },
  ): Promise<SignalResult> {
    const run = this.deps.findRunning(target)
    if (!run) return { ok: false, status: 404, error: "no running task matches (it may have finished already)" }
    // A workflow step (#870): the run pauses at that step. Refused when
    // the engine cannot pause it there, rather than failing the run.
    let workflow: StoppedTask["workflow"]
    if (run.workflowRunId) {
      const step = this.deps.workflowStep?.(run.workflowRunId, run.agentId)
        ?? { error: "the workflow engine is not running on this node" }
      if ("error" in step) {
        return { ok: false, status: 409, error: `this task is a step of workflow run ${run.workflowRunId}, which cannot pause here (${step.error}). Cancel the workflow run instead` }
      }
      workflow = { runId: run.workflowRunId, workflowId: step.workflowId, nodeId: step.nodeId }
    }
    const settings = this.deps.settings()
    const allowed = canSignal(sender, { agentId: run.agentId, sender: run.sender }, settings)
    if (!allowed.ok) return { ok: false, status: 403, error: allowed.reason }
    const rootId = run.rootId || run.taskId
    // The brake is for agent loops: the owner is never counted or refused.
    if (sender.kind !== "owner" && !this.budget.take(rootId, settings.maxPerRoot)) {
      return { ok: false, status: 429, error: `this task's root already carried ${settings.maxPerRoot} signals today (signals.maxPerRoot)` }
    }
    const by = describeSender(sender)
    const why = reason?.trim().slice(0, 500) || undefined
    const record: StoppedTask = {
      id: run.taskId,
      traceId: run.traceId,
      agentId: run.agentId,
      channel: run.channel,
      chatId: run.chatId,
      sender: run.sender,
      rootId,
      originalMessage: run.originalMessage,
      origin: run.origin,
      ...(workflow ? { workflow } : {}),
      ...(order ? { stopAll: { orderId: order.orderId } } : {}),
      stoppedAt: new Date(this.now()).toISOString(),
      stoppedBy: by,
      reason: why,
      state: "winding-down",
    }
    if (!this.deps.stopRun(run.taskId, `stopped by ${by}${why ? `: ${why}` : ""}`)) {
      return { ok: false, status: 404, error: "the task finished before it could be stopped" }
    }
    this.save(record)
    this.deps.publish({
      type: "signal:stop", agentId: run.agentId, rootId, ref: run.taskId,
      summary: `stop sent to ${run.agentId} by ${by}${why ? `: ${why}` : ""}`,
    })
    this.deps.log(`[signals] ${run.agentId} task ${run.taskId} stopped by ${by}${why ? ` (${why})` : ""}; winding down`)
    const done = this.windDown(record, settings.windDownSeconds * 1000)
    return { ok: true, record, done }
  }

  /** Stop every running task on this node (#1271). The owner's order, or
   *  a mesh peer's that signals.allowPeers names; never an agent's. A task
   *  stop() refuses (a workflow step that cannot pause) is listed as
   *  `refused` and keeps running. `done` resolves once every plan is saved.
   *  A peer's order (`stop --all --mesh` on another node) may carry that
   *  node's order id, so every node's tasks share it (#1328). */
  async stopAll(sender: SignalSender, reason?: string, mesh: { orderId?: string } = {}): Promise<StopAllResult> {
    if (sender.kind === "agent") return { ok: false, status: 403, error: "only the owner or a mesh peer may stop every task" }
    const settings = this.deps.settings()
    if (!settings.enabled) return { ok: false, status: 403, error: "signals are turned off on this node (signals.enabled)" }
    if (sender.kind === "peer" && !settings.allowPeers.map((p) => p.toLowerCase()).includes(sender.peer.toLowerCase())) {
      return { ok: false, status: 403, error: `mesh peer "${sender.peer}" is not in signals.allowPeers` }
    }
    const orderId = (sender.kind === "peer" ? validOrderId(mesh.orderId) : undefined)
      ?? `stop-all-${new Date(this.now()).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`
    const why = reason?.trim() ? `stop-all: ${reason.trim()}` : "stop-all"
    const tasks: StopAllEntry[] = []
    const pending: Array<Promise<StopAllEntry>> = []
    for (const run of this.deps.listRunning?.() ?? []) {
      const r = await this.stop(sender, { taskId: run.taskId }, why, { orderId })
      if (!r.ok) {
        // Finished between the list and the stop: nothing left to stop.
        if (r.status === 404) continue
        tasks.push({ id: run.taskId, agentId: run.agentId, state: "refused", error: r.error })
        continue
      }
      tasks.push({ id: r.record.id, agentId: r.record.agentId, state: r.record.state })
      if (r.done) pending.push(r.done.then((s) => ({ id: s.id, agentId: s.agentId, state: s.state, plan: s.plan?.author, ...builderCounts(s.builders) })))
    }
    this.deps.log(`[signals] stop-all ${orderId} by ${describeSender(sender)}: ${pending.length} stopped, ${tasks.length - pending.length} refused`)
    this.deps.publish({
      type: "signal:stop-all", agentId: "*", rootId: orderId, ref: orderId,
      summary: `stop-all by ${describeSender(sender)}: ${pending.length} task(s) stopped`,
    })
    const done = Promise.all(pending).then((saved) => tasks.map((t) => saved.find((s) => s.id === t.id) ?? t))
    return { ok: true, orderId, tasks, done }
  }

  /** The stop-all order that owns a run the last restart cut off, or null
   *  (#1271). Its trace can still be `in-flight` (a `--no-wait` order and a
   *  quick restart, or a run that ignored the abort): resumeStopAll()
   *  resumes it from its plan, so the interrupted-run resume must not run
   *  it a second time. Matched by trace id or task id. */
  stopAllOwner(runId: string): string | null {
    const record = this.deps.store.list({ limit: 200, now: this.now() })
      .find((r) => r.stopAll && (r.traceId === runId || r.id === runId))
    return record?.stopAll?.orderId ?? null
  }

  /** At boot, after recover(): resume every task a stop-all stopped, from
   *  its plan, one attempt each (#1271). No age limit: the order said it
   *  would come back. A task already tried by an earlier boot is never
   *  tried again, and is reported as skipped once; `agentx signal resume`
   *  still works on it. Never throws. */
  async resumeStopAll(opts: { staggerMs?: number } = {}): Promise<StopAllOutcome[]> {
    const outcomes: StopAllOutcome[] = []
    const records = this.deps.store.list({ state: "stopped", limit: 200, now: this.now() })
      .filter((r) => r.stopAll)
      .sort((a, b) => a.stoppedAt.localeCompare(b.stoppedAt))
    for (const record of records) {
      const order = record.stopAll!
      // Each task is in one report only; later boots leave it out.
      if (order.reported) continue
      const of = { orderId: order.orderId, ...outcomeBuilders(record.builders) }
      if (order.attemptedAt) {
        this.save({ ...record, stopAll: { ...order, reported: true } })
        outcomes.push({ id: record.id, agentId: record.agentId, decision: "skipped", reason: `already tried at ${order.attemptedAt}${order.error ? `: ${order.error}` : ""}`, ...of })
        continue
      }
      if (!record.origin && !record.workflow) {
        this.save({ ...record, stopAll: { ...order, reported: true } })
        outcomes.push({ id: record.id, agentId: record.agentId, decision: "skipped", reason: "no record of how to re-enter it", ...of })
        continue
      }
      if (outcomes.some((o) => o.decision !== "skipped") && opts.staggerMs) await new Promise((r) => setTimeout(r, opts.staggerMs))
      // Marked before the attempt: a restart in the middle of it never
      // tries it a second time.
      const attemptedAt = new Date(this.now()).toISOString()
      this.save({ ...record, stopAll: { ...order, attemptedAt } })
      let r: SignalResult
      try {
        r = await this.resume({ kind: "owner", name: "stop-all restart" }, record.id, `resumed after ${order.orderId}`)
      } catch (e: any) {
        r = { ok: false, status: 500, error: String(e?.message ?? e) }
      }
      if (r.ok) {
        outcomes.push({ id: record.id, agentId: record.agentId, decision: "resumed", reason: `answer goes to ${r.delivery ?? "its origin"}`, ...of })
      } else {
        const latest = this.deps.store.get(record.id)
        if (latest?.state === "stopped") this.save({ ...latest, stopAll: { ...order, attemptedAt, error: r.error.slice(0, 300), reported: true } })
        outcomes.push({ id: record.id, agentId: record.agentId, decision: "resume-failed", reason: r.error, ...of })
      }
    }
    return outcomes
  }

  async resume(sender: SignalSender, id: string, reason?: string): Promise<SignalResult> {
    const record = this.deps.store.get(id)
    if (!record) return { ok: false, status: 404, error: `no stopped task ${id}` }
    if (record.state === "winding-down") return { ok: false, status: 409, error: "the task is still writing its resume plan; try again in a moment" }
    if (record.state === "resumed" || this.resuming.has(id)) return { ok: false, status: 409, error: "the task was already resumed" }
    if (!record.origin && !record.workflow) return { ok: false, status: 409, error: "no record of how to re-enter this task" }
    if (record.workflow && !this.deps.resumeWorkflowStep) return { ok: false, status: 409, error: `this task is a step of workflow run ${record.workflow.runId}, and the workflow engine is not running on this node` }
    const settings = this.deps.settings()
    const allowed = canSignal(sender, { agentId: record.agentId, sender: record.sender }, settings)
    if (!allowed.ok) return { ok: false, status: 403, error: allowed.reason }
    if (sender.kind !== "owner" && !this.budget.take(record.rootId, settings.maxPerRoot)) {
      return { ok: false, status: 429, error: `this task's root already carried ${settings.maxPerRoot} signals today (signals.maxPerRoot)` }
    }
    // Atomic, before any action: two resumes can't both re-enter it.
    if (!this.deps.store.claim(id)) return { ok: false, status: 409, error: "the task was already resumed" }
    const by = describeSender(sender)
    const plan: ResumePlan = record.plan ?? machinePlan({ toolCalls: this.deps.toolCalls(record.traceId), note: "no plan was saved" })
    const note = resumeNote({ stoppedAt: record.stoppedAt, stoppedBy: record.stoppedBy, reason: record.reason, plan, resumedBy: by, builders: builderLines(record.builders, "resume") })
    this.resuming.add(id)
    try {
      // Marked first, so a second resume racing this one is refused.
      const resumed: StoppedTask = { ...record, state: "resumed", resumedAt: new Date(this.now()).toISOString(), resumedBy: by }
      this.save(resumed)
      this.deps.publish({
        type: "signal:resume", agentId: record.agentId, rootId: record.rootId, ref: record.id,
        summary: `resume sent to ${record.agentId} by ${by}${reason ? `: ${reason.trim().slice(0, 200)}` : ""}`,
      })
      try {
        if (record.workflow) await this.deps.resumeWorkflowStep!({ record: resumed, note, by })
        else await this.deps.resume({ record: resumed, note })
      } catch (e: any) {
        this.save(record)
        this.deps.store.release(id)
        const error = `resume failed: ${e?.message ?? e}`
        this.deps.log(`[signals] ${record.agentId} task ${id}: ${error}`)
        this.deps.publish({ type: "signal:resume-failed", agentId: record.agentId, rootId: record.rootId, ref: id, summary: error })
        return { ok: false, status: 500, error }
      }
      const delivery = deliveryOf(record.origin, record.workflow)
      this.deps.log(`[signals] ${record.agentId} task ${id} resumed by ${by}; answer goes to ${delivery}`)
      return { ok: true, record: resumed, delivery }
    } finally {
      this.resuming.delete(id)
    }
  }

  /** Forget a stopped task and its plan (#871). Stopped records are kept
   *  until resumed, so one nobody will resume stays until dropped. Same
   *  rules as resume for who may; refused while the plan is being written
   *  or a resume is under way. Not counted against the root budget: it
   *  starts nothing. */
  drop(sender: SignalSender, id: string): SignalResult {
    const record = this.deps.store.get(id)
    if (!record) return { ok: false, status: 404, error: `no stopped task ${id}` }
    if (record.state === "winding-down") return { ok: false, status: 409, error: "the task is still writing its resume plan; try again in a moment" }
    if (this.resuming.has(id)) return { ok: false, status: 409, error: "the task is being resumed" }
    const allowed = canSignal(sender, { agentId: record.agentId, sender: record.sender }, this.deps.settings())
    if (!allowed.ok) return { ok: false, status: 403, error: allowed.reason }
    if (!this.deps.store.remove(id)) return { ok: false, status: 500, error: `couldn't remove ${id}` }
    const by = describeSender(sender)
    this.deps.publish({ type: "signal:dropped", agentId: record.agentId, rootId: record.rootId, ref: id, summary: `stopped task of ${record.agentId} dropped by ${by}` })
    this.deps.log(`[signals] ${record.agentId} task ${id} dropped by ${by}`)
    return { ok: true, record }
  }

  /** After a restart: a task whose wind-down the restart cut off would
   *  wait as "winding-down" forever. Give it a plan from its trace (no
   *  model call) so it can be resumed. A resume the restart cut off
   *  between its claim and its save left a claim on a task still
   *  `stopped`; that claim is removed (#871). Returns how many tasks it
   *  closed. */
  recover(): number {
    const claims = this.deps.store.dropStaleClaims()
    if (claims) this.deps.log(`[signals] removed ${claims} resume claim(s) a restart left on tasks never resumed`)
    let n = 0
    for (const record of this.deps.store.list({ state: "winding-down", limit: 200, now: this.now() })) {
      const plan = machinePlan({ toolCalls: this.deps.toolCalls(record.traceId), note: "a restart cut off the wind-down" })
      this.save({ ...record, state: "stopped", plan })
      this.deps.log(`[signals] ${record.agentId} task ${record.id}: wind-down cut off by a restart; plan built from its trace`)
      n++
    }
    return n
  }

  /** Wait for the run to end, ask the agent for its plan, save it. */
  private async windDown(record: StoppedTask, timeoutMs: number): Promise<StoppedTask> {
    let plan: ResumePlan
    let builders: BuilderWindDown | undefined
    try {
      await this.deps.whenRunEnds(record.id, RUN_END_WAIT_MS)
      const calls = this.deps.toolCalls(record.traceId)
      // The run has let go, so its builders are stopped too: save what they
      // left before the agent writes its plan, so the plan can name it.
      if (this.deps.windDownBuilders) {
        builders = await this.deps.windDownBuilders({ taskId: record.id, toolCalls: calls, reason: `${record.stoppedBy} stopped the task`, save: this.deps.settings().saveBuilderWork !== false })
          .catch((e: any) => { this.deps.log(`[signals] ${record.agentId} task ${record.id}: couldn't wind down its builders: ${e?.message ?? e}`); return undefined })
        if (builders) {
          const saved = builders.folders.filter((f) => f.wipBranch)
          this.deps.log(`[signals] ${record.agentId} task ${record.id}: ${builders.helpers.length} builder(s) stopped; ${saved.length} folder(s) saved on a WIP branch${saved.length ? ` (${saved.map((f) => `${f.path} → ${f.wipBranch}`).join(", ")})` : ""}`)
          for (const f of builders.folders.filter((x) => x.error)) this.deps.log(`[signals] ${record.agentId} task ${record.id}: couldn't save ${f.path}: ${f.error}`)
          // Kept before the plan: a restart while the agent writes it
          // still finds where the work is.
          this.save({ ...record, builders })
        }
      }
      const message = windDownMessage({ by: record.stoppedBy, reason: record.reason, originalMessage: record.originalMessage, toolCalls: calls, builders: builderLines(builders, "wind-down") })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs + 5_000); timer.unref?.() })
      const answer = await Promise.race([
        this.deps.windDown({ id: record.id, agentId: record.agentId, rootId: record.rootId, message, timeoutMs })
          .catch((e: any): { content?: string; error?: string } => ({ error: String(e?.message ?? e) })),
        timedOut,
      ])
      if (timer) clearTimeout(timer)
      const seconds = Math.round(timeoutMs / 1000)
      if (answer === "timeout" || (answer.error && /timed out/i.test(answer.error))) {
        plan = machinePlan({ toolCalls: calls, note: `the agent wrote no plan within ${seconds}s` })
      } else if (answer.error) {
        plan = machinePlan({ toolCalls: calls, note: `the wind-down turn failed: ${answer.error.slice(0, 200)}` })
      } else {
        plan = agentPlan(answer.content) ?? machinePlan({ toolCalls: calls, note: "the agent answered with an empty plan" })
      }
    } catch (e: any) {
      plan = machinePlan({ toolCalls: [], note: `wind-down failed: ${e?.message ?? e}` })
    }
    const stopped: StoppedTask = { ...record, ...(builders ? { builders } : {}), state: "stopped", plan }
    this.save(stopped)
    this.deps.publish({
      type: "signal:stopped", agentId: record.agentId, rootId: record.rootId, ref: record.id,
      summary: `${record.agentId} stopped; resume plan ${plan.author === "agent" ? "written by the agent" : `written by AgentX (${plan.note})`}`,
    })
    this.deps.log(`[signals] ${record.agentId} task ${record.id}: resume plan saved (${plan.author})`)
    if (!record.workflow && record.origin && record.origin.kind !== "direct" && this.deps.tell) {
      await this.deps.tell(record.origin, `Paused: ${record.stoppedBy} stopped this task${record.reason ? ` (${record.reason})` : ""}. Where it got to is saved, and it can be resumed later.`)
        .catch((e: any) => this.deps.log(`[signals] couldn't tell the chat: ${e?.message ?? e}`))
    }
    return stopped
  }

  private save(record: StoppedTask): void {
    try { this.deps.store.save(record) } catch (e: any) { this.deps.log(`[signals] couldn't save ${record.id}: ${e?.message ?? e}`) }
  }
}

function builderCounts(b: BuilderWindDown | undefined): Pick<StopAllEntry, "builders"> {
  if (!b) return {}
  const saved = b.folders.filter((f) => f.wipBranch).length
  return { builders: { count: b.helpers.length, saved, notSaved: b.folders.filter((f) => f.error).length } }
}

function outcomeBuilders(b: BuilderWindDown | undefined): Pick<StopAllOutcome, "builders" | "wip"> {
  if (!b) return {}
  const wip = b.folders.flatMap((f) => (f.wipBranch ? [f.wipBranch] : []))
  return { builders: b.helpers.length, ...(wip.length ? { wip } : {}) }
}
