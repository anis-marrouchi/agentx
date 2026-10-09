import { callerAgentOf, type RunOrigin } from "@/agents/resume/origin"
import { agentPlan, machinePlan, resumeNote, windDownMessage, type ResumePlan, type ToolCallRef } from "./plan"
import { canSignal, describeSender, SignalBudget, type SignalSender, type SignalSettings } from "./policy"
import type { StoppedTask, StoppedTaskStore } from "./store"

// --- Stop a running task cleanly, and resume it from its plan (#857) ---
//
// stop:   check who is asking, end the run (status `stopped`, not failed),
//         then give the agent one short wind-down turn to write its resume
//         plan. No answer in time: the wind-down is stopped too and a plan
//         is built from the trace, marked machine-written.
// resume: re-enter the task through the resume coordinator's resumers (the
//         same ones a restart uses), with the plan prepended, on the same
//         chat and under the same root id.
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
  /** End the run with status `stopped`. False when it is no longer running. */
  stopRun(taskId: string, reason: string): boolean
  /** Resolves once the run has let go of its slot, or after `timeoutMs`. */
  whenRunEnds(taskId: string, timeoutMs: number): Promise<void>
  /** Tool calls the run made, from its trace. */
  toolCalls(traceId: string | undefined): ToolCallRef[]
  /** Run the wind-down turn and answer with its text. Must stop the turn
   *  itself once `timeoutMs` has passed. */
  windDown(input: { id: string; agentId: string; rootId: string; message: string; timeoutMs: number }): Promise<{ content?: string; error?: string }>
  /** Re-enter the task (resume coordinator). Resolves once handed over. */
  resume(input: { record: StoppedTask; note: string }): Promise<void>
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
export function deliveryOf(origin: RunOrigin): string {
  if (origin.kind === "router") return `the chat it came from (${origin.adapter})`
  if (origin.kind === "mesh") return `the chat it came from, through ${origin.node ?? "the forwarding node"}`
  const caller = callerAgentOf(origin)
  if (caller) return `${caller}, as a new turn`
  return "nobody: the answer is kept on its task page and trace only"
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

  get(id: string): StoppedTask | null {
    return this.deps.store.get(id)
  }

  async stop(
    sender: SignalSender,
    target: { taskId?: string; agentId?: string; channel?: string; chatId?: string },
    reason?: string,
  ): Promise<SignalResult> {
    const run = this.deps.findRunning(target)
    if (!run) return { ok: false, status: 404, error: "no running task matches (it may have finished already)" }
    // A workflow step: stopping it would fail the workflow run, and a resume
    // would re-enter it outside that run, answering nobody. Refused until
    // workflow runs can pause on a stop (#857 review).
    if (run.workflowRunId) {
      return { ok: false, status: 409, error: `this task is a step of workflow run ${run.workflowRunId}: pausing it would fail the run. Cancel or pause the workflow run instead` }
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

  async resume(sender: SignalSender, id: string, reason?: string): Promise<SignalResult> {
    const record = this.deps.store.get(id)
    if (!record) return { ok: false, status: 404, error: `no stopped task ${id}` }
    if (record.state === "winding-down") return { ok: false, status: 409, error: "the task is still writing its resume plan; try again in a moment" }
    if (record.state === "resumed" || this.resuming.has(id)) return { ok: false, status: 409, error: "the task was already resumed" }
    if (!record.origin) return { ok: false, status: 409, error: "no record of how to re-enter this task" }
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
    const note = resumeNote({ stoppedAt: record.stoppedAt, stoppedBy: record.stoppedBy, reason: record.reason, plan, resumedBy: by })
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
        await this.deps.resume({ record: resumed, note })
      } catch (e: any) {
        this.save(record)
        this.deps.store.release(id)
        const error = `resume failed: ${e?.message ?? e}`
        this.deps.log(`[signals] ${record.agentId} task ${id}: ${error}`)
        this.deps.publish({ type: "signal:resume-failed", agentId: record.agentId, rootId: record.rootId, ref: id, summary: error })
        return { ok: false, status: 500, error }
      }
      const delivery = deliveryOf(record.origin)
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
    try {
      await this.deps.whenRunEnds(record.id, RUN_END_WAIT_MS)
      const calls = this.deps.toolCalls(record.traceId)
      const message = windDownMessage({ by: record.stoppedBy, reason: record.reason, originalMessage: record.originalMessage, toolCalls: calls })
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
    const stopped: StoppedTask = { ...record, state: "stopped", plan }
    this.save(stopped)
    this.deps.publish({
      type: "signal:stopped", agentId: record.agentId, rootId: record.rootId, ref: record.id,
      summary: `${record.agentId} stopped; resume plan ${plan.author === "agent" ? "written by the agent" : `written by AgentX (${plan.note})`}`,
    })
    this.deps.log(`[signals] ${record.agentId} task ${record.id}: resume plan saved (${plan.author})`)
    if (record.origin && record.origin.kind !== "direct" && this.deps.tell) {
      await this.deps.tell(record.origin, `Paused: ${record.stoppedBy} stopped this task${record.reason ? ` (${record.reason})` : ""}. Where it got to is saved, and it can be resumed later.`)
        .catch((e: any) => this.deps.log(`[signals] couldn't tell the chat: ${e?.message ?? e}`))
    }
    return stopped
  }

  private save(record: StoppedTask): void {
    try { this.deps.store.save(record) } catch (e: any) { this.deps.log(`[signals] couldn't save ${record.id}: ${e?.message ?? e}`) }
  }
}
