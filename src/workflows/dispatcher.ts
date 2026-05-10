import { evaluateBranch, findNode, initialPendingFromTrigger, nextNodes } from "./engine"
import { resolveHandler } from "./nodes/handlers"
import type { AgentExecuteRequest, AgentExecuteResponse, NodeResult } from "./nodes/types"
import { RunStore, idempotencyKey } from "./run-store"
import type { WorkflowStore } from "./store"
import { TaskStore } from "./task-store"
import { TimerService, type TimerRecord } from "./timers"
import { SignalBus, matchesSignal, type SignalEmission } from "./signals"
import type { EventBus } from "../daemon/event-bus"
import { ActorStore } from "../actors/store"
import { validateSubmission } from "../forms/validator"
import type { FormSubmission } from "../forms/types"
import type { EntityRef, NodeExecutionEntry, Workflow, WorkflowRun } from "./types"
import { getLedgerMode } from "@/intent/mode"
import { getDefaultLedger } from "@/intent/instance"
import { recordWorkflowDispatch } from "@/intent/sources/workflow"
import { openDb } from "@/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "@/storage/traces"

// --- Dispatcher (V2) ---
//
// Entry point called by the hook layer. Given a triggering event:
//
//   1. Find workflows whose trigger filter matches.
//   2. For each match, resolve or create a run keyed by the event's entityRef.
//   3. If the run's home node is a remote peer, forward via mesh.
//   4. Locally: seed the trigger node's output into run.context, then
//      walk the DAG — execute each pending node's handler, fold the output
//      into run.context, enqueue successors, loop until pending is empty
//      or a handler paused / failed the run.
//
// All side effects (adapter calls, agent dispatch) happen inside node
// handlers. This module only orchestrates.

export interface MeshForwarder {
  forwardTransition(peer: string, payload: { workflowId: string; event: TriggerEvent; entityRef: EntityRef }): Promise<void>
  /** Broadcast a fresh trigger event to all healthy mesh peers that may host
   *  remote-allowed workflows for this trigger's source. Implementations
   *  should be best-effort: a failing peer must not block delivery to others
   *  or surface back to the local dispatch path. Optional — when absent,
   *  workflows are local-only as before. */
  broadcastTrigger?(payload: {
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] }
    entityRef: EntityRef
    event: TriggerEvent
  }): Promise<void>
  /** Forward an outbound channel send to whichever peer hosts the channel.
   *  Returns the message id from the remote adapter (or null when not
   *  available). Throws when no healthy peer hosts the channel — callers
   *  should treat that as a hard error and surface it as the action's
   *  failure. Optional — when absent, workflow `action.send` to a non-local
   *  channel just errors out, preserving today's behaviour. */
  forwardChannelSend?(payload: {
    channel: string
    chatId: string
    text: string
    accountId?: string
    parseMode?: string
    replyTo?: string
  }): Promise<{ messageId: string | null }>
}

export interface TriggerEvent {
  /** Stable event id — used by idempotency keys so retried webhooks
   *  collapse into the same node execution. */
  id: string
  /** Output bundle produced by the trigger node. Hooks build this from
   *  the raw channel payload. Goes directly into `run.context[triggerId]`. */
  payload: Record<string, unknown>
}

export interface DispatcherOptions {
  store: WorkflowStore
  runs: RunStore
  nodeId: string
  forwarder?: MeshForwarder
  channels: Record<string, unknown>
  agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }
  log?: (msg: string) => void
  /** Optional Actor/Role store. If omitted, constructed with defaults so
   *  userTask handlers still work out of the box (reads from .agentx/actors/
   *  and .agentx/roles/). */
  actors?: ActorStore
  /** Optional user-task store. If omitted, constructed with defaults
   *  (.agentx/workflows/_tasks/). */
  tasks?: TaskStore
  /** Optional form-renderer hook for user tasks. Called after a userTask
   *  record is persisted — the hook delivers the form to the assignee's
   *  preferred channel(s). Best-effort; failures are logged. */
  renderUserTask?: (task: import("./task-store").UserTaskRecord) => Promise<void> | void
  /** Optional timer service. When provided, `timer.boundary` nodes
   *  schedule against it and resume on fire. When omitted, a default is
   *  constructed but its loop is NOT started — callers can start it via
   *  `dispatcher.timers.start()` once (typically at daemon boot). */
  timers?: TimerService
  /** Optional signal bus. Workflow-scoped default if omitted. */
  signals?: SignalBus
  /** Optional observability bus. When present, the dispatcher emits
   *  run-phase events (created / ok / failed / paused / resumed /
   *  completed) so operators can watch live via SSE or CLI. No-op when
   *  absent — the dispatcher runs exactly as before. */
  events?: EventBus
}

/** Subset of channel adapter API used for the auto-acknowledge lifecycle on
 *  channel-triggered runs. Duck-typed so any adapter implementing react +
 *  sendTyping (telegram today, future whatsapp/discord) gets the UX for free.
 *  The accountId arg is forwarded so multi-account adapters reply on the
 *  originating bot, not whichever bot the chat was last seen on. */
interface AckCapableAdapter {
  react?: (chatId: string, messageId: string, emoji?: string, accountId?: string) => Promise<void> | void
  sendTyping?: (chatId: string, accountId?: string) => Promise<void> | void
}

const ACK_TYPING_INTERVAL_MS = 4000

/** Max parallel node handlers per run. Caps fan-out storms (e.g.,
 *  gateway.parallel(fanOut) → 100 branches) from exhausting agent
 *  slots. Chosen to be meaningful for the common case (3–8 parallel
 *  approvers / implementations) while never going wild. */
const MAX_PARALLEL_PER_RUN = 8

export class WorkflowDispatcher {
  private readonly store: WorkflowStore
  private readonly runs: RunStore
  private readonly nodeId: string
  private readonly forwarder?: MeshForwarder
  private readonly channels: Record<string, unknown>
  private readonly agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }
  private readonly log: (msg: string) => void
  readonly actors: ActorStore
  readonly tasks: TaskStore
  readonly timers: TimerService
  readonly signals: SignalBus
  readonly events?: EventBus
  private readonly renderUserTask?: (task: import("./task-store").UserTaskRecord) => Promise<void> | void
  /** Per-run typing timer. Started when a channel-triggered run is created or
   *  resumed; stopped when the run terminates (completed / failed / canceled
   *  / paused). Keyed by runId so concurrent channel runs don't stomp on each
   *  other's lifecycles. */
  private readonly ackTypingTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
  /** Per-run commit chain. The parallel walk loop fires node handlers
   *  concurrently via Promise.allSettled, but every state-mutating
   *  operation (recordExecution, joinCounter update, pause transition,
   *  resume) must land atomically — runs are a single log and the
   *  read-update-write on joinCounters + dedup check on idempotencyKey
   *  need to see a consistent snapshot. Serialising commits through a
   *  per-run promise chain gives us that guarantee without a broader
   *  global lock; different runs still progress independently. */
  private readonly commitChains: Map<string, Promise<unknown>> = new Map()

  constructor(opts: DispatcherOptions) {
    this.store = opts.store
    this.runs = opts.runs
    this.nodeId = opts.nodeId
    this.forwarder = opts.forwarder
    this.channels = opts.channels
    this.agents = opts.agents
    this.log = opts.log ?? (() => {})
    this.actors = opts.actors ?? new ActorStore()
    this.tasks = opts.tasks ?? new TaskStore()
    this.timers = opts.timers ?? new TimerService({ log: (m) => this.log(m) })
    this.signals = opts.signals ?? new SignalBus()
    this.events = opts.events
    this.renderUserTask = opts.renderUserTask

    // Register the timer-fire callback once. TimerService is a per-node
    // singleton; re-registration would clobber prior instances, but the
    // dispatcher also is, so this is safe.
    this.timers.onFire((t) => this.resumeFromTimer(t))
    // Resume any paused signalWait runs whose filter matches a published
    // signal. Running a full scan of paused runs per emission is cheap in
    // v1 (runs are fs-backed and typically numbered in the hundreds).
    this.signals.subscribe((emission) => this.resumeFromSignal(emission))
  }

  /** Publish a run-phase event if an EventBus is configured. No-op
   *  otherwise. Used by the walk loop + resume paths so operators can
   *  Monitor runs live. */
  private emitRunEvent(args: {
    runId: string; workflowId: string; nodeId?: string; phase: string; status?: string; note?: string; homeNode?: string
  }): void {
    if (!this.events) return
    try {
      this.events.publish({
        kind: "run",
        runId: args.runId, workflowId: args.workflowId,
        nodeId: args.nodeId, phase: args.phase,
        status: args.status, note: args.note, homeNode: args.homeNode,
      })
    } catch { /* defensive — a bus failure never breaks the engine */ }
  }

  /** Serialise a state-mutating operation against all other commits for
   *  the same run. Parallel branches execute their handlers concurrently,
   *  but their commits land one after another — keeping joinCounters +
   *  pending + pausedAt + recordExecution dedup consistent. */
  private async commit<T>(runId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.commitChains.get(runId) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    // Keep the chain alive until the caller's fn settles. We don't care
    // about fn's result type for the chain tail — `unknown` is enough.
    this.commitChains.set(runId, next.then(() => undefined, () => undefined))
    return next as Promise<T>
  }

  /** Public helper for the HTTP API to emit a signal programmatically. */
  emitSignal(args: { name: string; scope?: "workflow" | "global"; workflowId?: string; payload?: Record<string, unknown> }): SignalEmission {
    const emission: SignalEmission = {
      name: args.name,
      scope: args.scope ?? "global",
      workflowId: args.workflowId ?? "",
      payload: args.payload ?? {},
      emittedAt: new Date().toISOString(),
    }
    this.signals.emit(emission)
    if (this.events) {
      try {
        this.events.publish({
          kind: "signal",
          name: emission.name,
          scope: emission.scope,
          workflowId: emission.workflowId || undefined,
          payload: emission.payload,
        })
      } catch { /* ignore */ }
    }
    return emission
  }

  /** Callback when a signal is published. Finds paused `signalWait` runs
   *  whose filter matches and resumes them. */
  private async resumeFromSignal(emission: SignalEmission): Promise<void> {
    const all = this.runs.list({ limit: 500 })
    for (const run of all) {
      if (run.status !== "paused" || !run.pausedAt || run.pausedAt.kind !== "signalWait") continue
      const waiter = {
        name: run.pausedAt.signalName,
        scope: run.pausedAt.scope,
        workflowId: run.workflowId,
        match: run.pausedAt.match ?? {},
      }
      if (!matchesSignal(waiter, emission)) continue
      const wf = this.store.list().find((w) => w.id === run.workflowId)
      if (!wf) continue
      // Resume under the per-run mutex so a concurrent walk batch (or
      // another signal firing at the same instant) can't see a half-
      // transitioned pausedAt/pending/status set.
      await this.commit(run.id, () => {
        const fresh = this.runs.get(run.id)
        if (!fresh || fresh.status !== "paused" || !fresh.pausedAt || fresh.pausedAt.kind !== "signalWait") return
        if (!matchesSignal({ name: fresh.pausedAt.signalName, scope: fresh.pausedAt.scope, workflowId: fresh.workflowId, match: fresh.pausedAt.match ?? {} }, emission)) return
        const node = findNode(wf, fresh.pausedAt.nodeId)
        const successors = node ? wf.edges.filter((e) => e.from === node.id).map((e) => e.to) : []
        const output = {
          receivedAt: new Date().toISOString(),
          name: emission.name,
          payload: emission.payload,
        }
        this.runs.recordExecution({
          runId: fresh.id,
          entry: {
            at: output.receivedAt,
            nodeId: fresh.pausedAt.nodeId,
            inputKeys: [],
            status: "resumed",
            output,
            idempotencyKey: idempotencyKey(fresh.id, fresh.pausedAt.nodeId, `signal:${emission.name}:${emission.emittedAt}`),
          },
          nextPending: successors,
          status: "running",
          pausedAt: null,
          context: { ...fresh.context, [fresh.pausedAt.nodeId]: output },
        })
        this.log(`[workflow:${wf.id}] run ${fresh.id} resumed from signal "${emission.name}"`)
        this.emitRunEvent({ runId: fresh.id, workflowId: wf.id, nodeId: fresh.pausedAt.nodeId, phase: "resumed", status: "running", note: `signal:${emission.name}` })
      })
      void this.walk(wf, run.id, `signal:${emission.name}`)
        .catch((e: any) => this.log(`[workflow:${wf.id}] walk-after-signal failed: ${e.message}`))
    }
  }

  /** Callback from the TimerService when a scheduled timer elapses. Reads
   *  the paused run, verifies the pause is still on this timer's node, and
   *  resumes by seeding the timer node's output with { firedAt } and
   *  enqueueing successors. */
  private async resumeFromTimer(t: TimerRecord): Promise<void> {
    const wf = this.store.list().find((w) => w.id === (this.runs.get(t.runId)?.workflowId ?? ""))
    if (!wf) return
    await this.commit(t.runId, () => {
      const fresh = this.runs.get(t.runId)
      if (!fresh || fresh.status !== "paused") return
      if (!fresh.pausedAt || fresh.pausedAt.kind !== "timerWait" || fresh.pausedAt.nodeId !== t.nodeId) return
      const node = findNode(wf, t.nodeId)
      const successors = node ? wf.edges.filter((e) => e.from === node.id).map((e) => e.to) : []
      const firedAt = new Date().toISOString()
      const output = { firedAt, scheduledFor: t.fireAt }
      this.runs.recordExecution({
        runId: fresh.id,
        entry: {
          at: firedAt, nodeId: t.nodeId, inputKeys: [], status: "resumed", output,
          idempotencyKey: idempotencyKey(fresh.id, t.nodeId, `timer:${t.id}`),
        },
        nextPending: successors,
        status: "running",
        pausedAt: null,
        context: { ...fresh.context, [t.nodeId]: output },
      })
      this.log(`[workflow:${wf.id}] run ${fresh.id} resumed from timer "${t.nodeId}" (fired ${firedAt})`)
      this.emitRunEvent({ runId: fresh.id, workflowId: wf.id, nodeId: t.nodeId, phase: "resumed", status: "running", note: `timer:${t.id}` })
    })
    void this.walk(wf, t.runId, `timer:${t.id}`)
      .catch((e: any) => this.log(`[workflow:${wf.id}] walk-after-timer failed: ${e.message}`))
  }

  /** Fire a specific workflow by id, bypassing matchByTrigger. Used by
   *  `trigger.hook` and `trigger.cron` subscribers — they already KNOW
   *  which workflow they're firing, and the workflow's trigger config
   *  may not carry a `source` field to match against the caller's event.
   *  `trigger` is synthesized so the reused dispatchOne path still has
   *  something to feed matchesResume/paused-run resume logic. */
  async dispatchWorkflow(args: {
    workflowId: string
    entityRef: EntityRef
    event: TriggerEvent
    trigger?: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] }
  }): Promise<{ claimed: boolean; run: WorkflowRun | null }> {
    const wf = this.store.list().find((w) => w.id === args.workflowId)
    if (!wf) { this.log(`[workflows] dispatchWorkflow: workflow "${args.workflowId}" not found`); return { claimed: false, run: null } }
    const triggerNode = wf.nodes.find((n) => n.type.startsWith("trigger."))
    const cfg = (triggerNode?.config ?? {}) as { source?: string; filter?: Record<string, unknown> }
    const effective = {
      source: args.trigger?.source ?? cfg.source ?? "hook",
      project: args.trigger?.project,
      repo: args.trigger?.repo,
      chat: args.trigger?.chat,
      labels: args.trigger?.labels,
    }
    return this.dispatchOne(wf, args.entityRef, args.event, effective)
  }

  /** Fire 👀 + start the typing loop for a channel-triggered run, mirroring
   *  what MessageRouter does when it owns the conversation. Without this,
   *  workflow-claimed messages lose the "I see you, I'm working on it" UX
   *  that users learn to expect from the agent path.
   *
   *  Best-effort throughout: a failing adapter call must not break the walk.
   *  Idempotent: repeated calls for the same runId no-op (typing loop stays). */
  private startChannelAck(runId: string, payload: Record<string, unknown>): void {
    const channel = String(payload.channel ?? "")
    const chatId = String(payload.chatId ?? "")
    if (!channel || !chatId) return
    const adapter = this.channels[channel] as AckCapableAdapter | undefined
    if (!adapter) return
    const accountId = typeof payload.accountId === "string" ? payload.accountId : undefined
    const event = payload.event as { id?: unknown } | undefined
    const messageId = typeof event?.id === "string" ? event.id : (event?.id != null ? String(event.id) : undefined)

    if (messageId && adapter.react) {
      try { void Promise.resolve(adapter.react(chatId, messageId, "👀", accountId)).catch(() => {}) }
      catch { /* swallow — ack is decorative */ }
    }
    if (this.ackTypingTimers.has(runId)) return
    if (!adapter.sendTyping) return
    const tick = () => {
      try { void Promise.resolve(adapter.sendTyping!(chatId, accountId)).catch(() => {}) }
      catch { /* swallow */ }
    }
    tick()
    const timer = setInterval(tick, ACK_TYPING_INTERVAL_MS)
    this.ackTypingTimers.set(runId, timer)
  }

  /** Stop the typing loop for a run. Called when a run leaves the running
   *  state (terminal status OR pause — paused runs are waiting on an external
   *  event and should not appear "still typing"). */
  private stopChannelAck(runId: string): void {
    const timer = this.ackTypingTimers.get(runId)
    if (!timer) return
    clearInterval(timer)
    this.ackTypingTimers.delete(runId)
  }

  /** Main entry. The hook subscribers map channel events into this shape.
   *  `claimed` lists workflows that are actively handling this event for the
   *  entity — newly created, resumed, forwarded to a remote home, or dropped
   *  as a concurrent duplicate of a running run. The pre:channel-message hook
   *  uses this to suppress the router's default reply so the workflow owns
   *  the conversation (no double-send). A paused run whose resumeMatch didn't
   *  accept the event is deliberately NOT claimed, so unrelated chatter flows
   *  through the default agent while the workflow waits for the signal it
   *  cares about. */
  async dispatch(args: {
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] }
    entityRef: EntityRef
    event: TriggerEvent
    /** When true, this dispatch was initiated by a peer's broadcast (received
     *  via /workflow/event with kind=trigger). Only workflows that have
     *  explicitly opted in via `mesh.allowRemote: true` (and pass the
     *  `mesh.peers` allowlist when set) match in that mode — local workflows
     *  without the opt-in stay isolated. The flag also short-circuits the
     *  outbound fan-out below so a remote-origin dispatch never re-broadcasts
     *  back through the mesh (no echo loops). */
    fromRemote?: { peer: string }
  }): Promise<{ claimed: Workflow[]; runs: WorkflowRun[] }> {
    const matches = this.matchByTrigger(args.trigger, args.fromRemote)
    const willFan = matches.some((m) => m.fanOut)
    const toRun = willFan ? matches : matches.slice(0, 1)
    const claimed: Workflow[] = []
    const runs: WorkflowRun[] = []
    for (const wf of toRun) {
      const r = await this.dispatchOne(wf, args.entityRef, args.event, args.trigger)
      if (r.claimed) claimed.push(wf)
      if (r.run) runs.push(r.run)
    }

    // Mesh trigger fan-out. Only emit on local-origin dispatches; broadcasts
    // from peers (`fromRemote`) are never re-broadcast or we'd echo. The
    // forwarder decides per-peer whether to actually deliver — typically based
    // on cached peer agent-cards advertising allowRemote workflows for this
    // trigger source.
    if (!args.fromRemote && this.forwarder?.broadcastTrigger) {
      // Fire-and-forget: a slow / unhealthy peer must not delay the local
      // hook return path that the router awaits. Failures are logged inside
      // the forwarder.
      void Promise.resolve(this.forwarder.broadcastTrigger({
        trigger: args.trigger,
        entityRef: args.entityRef,
        event: args.event,
      })).catch((e: any) => this.log(`[mesh-broadcast] ${e?.message ?? e}`))
    }

    return { claimed, runs }
  }

  private matchByTrigger(
    t: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] },
    fromRemote?: { peer: string },
  ): Workflow[] {
    const all = this.store.list()
    const out: Workflow[] = []
    for (const wf of all) {
      // Lifecycle gate: only `active` workflows match new triggers.
      // disabled (operator kill switch) and quarantined (set by the
      // conflict detector) both opt out of fresh dispatches; in-flight
      // runs created while active continue to advance.
      if (wf.state && wf.state !== "active") continue
      // Mesh isolation: remote-origin events only see workflows that opted in.
      if (fromRemote) {
        if (!wf.mesh?.allowRemote) continue
        const allowed = wf.mesh.peers
        if (allowed && allowed.length > 0 && !allowed.includes(fromRemote.peer)) continue
      }
      const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
      if (!trigger) continue
      const cfg = trigger.config as {
        source?: string
        filter?: { project?: string; repo?: string; chat?: string; labels?: string[]; fromJid?: string }
      }
      if (cfg.source !== t.source) continue
      // Project-scope gate. A workflow's top-level `project:` field is
      // a hard scope: events from a different project never match. This
      // is what stops cross-tenant fan-out — e.g. an `on:gitlab-issue`
      // event from `ksi/int.ksi.tn` reaching `mtgl-pm-triage` (which is
      // tagged `project: mtgl/mtgl-system-v2`). Workflows with no
      // `project` field are global and match across projects (rare —
      // typically cross-project chores or templates). Events with no
      // `t.project` (manual / cron / 1:1 chat) bypass this check; the
      // project field only constrains project-scoped event sources.
      if (wf.project && t.project && wf.project !== t.project) continue
      const f = cfg.filter
      if (f) {
        if (f.project && f.project !== "*" && f.project !== t.project) continue
        if (f.repo && f.repo !== "*" && f.repo !== t.repo) continue
        if (f.chat && f.chat !== "*" && normalizeChat(t.source, f.chat) !== normalizeChat(t.source, t.chat)) continue
        if (f.labels?.length) {
          const have = new Set(t.labels ?? [])
          const hit = f.labels.some((l) => have.has(l))
          if (!hit) continue
        }
      }
      out.push(wf)
    }
    return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  /**
   * Phase 1 commit 6.c — thin wrapper around the legacy dispatch. Calls
   * `dispatchOneLegacy` then, when `getLedgerMode("workflow") !== "off"`,
   * records the dispatch to the intent ledger and reports any divergence
   * between ledger and legacy. Wrapped in try/catch so a ledger failure
   * never breaks workflow dispatch — legacy stays authoritative until
   * the 1c per-source promotion lands.
   */
  private async dispatchOne(
    workflow: Workflow,
    entityRef: EntityRef,
    event: TriggerEvent,
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  ): Promise<{ claimed: boolean; run: WorkflowRun | null }> {
    const result = await this.dispatchOneLegacy(workflow, entityRef, event, trigger)
    if (getLedgerMode("workflow") !== "off") {
      try {
        recordWorkflowDispatch(
          getDefaultLedger(),
          {
            workflowId: workflow.id,
            eventId: event.id,
            triggerSource: trigger.source,
            project: trigger.project ?? null,
            entityRef,
          },
          JSON.stringify({ event, trigger, entityRef }),
          {
            claimed: result.claimed,
            runId: result.run?.id ?? null,
          },
        )
      } catch (e: any) {
        this.log(`[ledger] workflow ${workflow.id} run ${result.run?.id ?? "?"} record failed: ${e?.message ?? e}`)
      }
    }
    return result
  }

  private async dispatchOneLegacy(
    workflow: Workflow,
    entityRef: EntityRef,
    event: TriggerEvent,
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  ): Promise<{ claimed: boolean; run: WorkflowRun | null }> {
    const activeRunId = this.runs.getActiveByEntity(entityRef)
    const homeNode = activeRunId ? this.runs.getHomeNodeByEntity(entityRef) : null

    // Remote home node — forward via mesh and bail. The remote owns the
    // conversation, so we still claim the event locally (no default reply).
    if (activeRunId && homeNode && homeNode !== this.nodeId) {
      if (!this.forwarder) {
        this.log(`[workflow:${workflow.id}] run ${activeRunId} home'd on "${homeNode}" but no forwarder — dropping`)
        return { claimed: false, run: null }
      }
      try {
        await this.forwarder.forwardTransition(homeNode, { workflowId: workflow.id, event, entityRef })
      } catch (e: any) {
        this.log(`[workflow:${workflow.id}] forward to "${homeNode}" failed: ${e.message}`)
      }
      return { claimed: true, run: null }
    }

    let run = activeRunId ? this.runs.get(activeRunId) : null
    if (!run) {
      // New entity → create a run, seed trigger context, enqueue trigger's successors.
      const init = initialPendingFromTrigger(workflow)
      if (!init) { this.log(`[workflow:${workflow.id}] no trigger node found`); return { claimed: false, run: null } }
      run = this.runs.create({
        workflowId: workflow.id,
        initialPending: init.pending,
        entityRef,
        initialContext: { [init.triggerId]: event.payload },
      })
      this.log(`[workflow:${workflow.id}] run ${run.id} created from trigger "${init.triggerId}" for ${entityRef.id}`)
      this.emitRunEvent({ runId: run.id, workflowId: workflow.id, phase: "created", status: run.status, homeNode: run.homeNode })
      // Channel-triggered: kick off the react+typing lifecycle so users see
      // the same "I'm on it" affordances they get from the router's path.
      if (trigger.source.endsWith("-message")) this.startChannelAck(run.id, event.payload)
    } else if (run.status === "paused" && run.pausedAt) {
      // Resume path: a matching event arrived for a paused run. Only
      // `checkpoint` pauses resume on channel events. userTask pauses on
      // form submit; subProcess on child end; signalWait on signal.emit;
      // timerWait on timer fire. Each of those has its own resume entry
      // point elsewhere — here we just drop the channel event and decline
      // to claim (so default routing handles it).
      if (run.pausedAt.kind !== "checkpoint") {
        this.log(`[workflow:${workflow.id}] run ${run.id} paused on ${run.pausedAt.kind} — channel event bypasses workflow`)
        return { claimed: false, run: null }
      }
      if (!matchesResume(run.pausedAt.resumeMatch, trigger, event)) {
        this.log(`[workflow:${workflow.id}] run ${run.id} paused but event doesn't match resumeMatch — dropping`)
        return { claimed: false, run: null }
      }
      const checkpointNode = findNode(workflow, run.pausedAt.nodeId)
      const successors = checkpointNode
        ? workflow.edges.filter((e) => e.from === checkpointNode.id).map((e) => e.to)
        : []
      const resumeEntry = {
        at: new Date().toISOString(),
        nodeId: run.pausedAt.nodeId,
        inputKeys: [],
        status: "resumed" as const,
        output: { event: event.payload },
        idempotencyKey: idempotencyKey(run.id, run.pausedAt.nodeId, `resume:${event.id}`),
      }
      const newContext: Record<string, Record<string, unknown>> = {
        ...run.context,
        [run.pausedAt.nodeId]: { event: event.payload },
      }
      const pausedCheckpointName = run.pausedAt.checkpointName
      const updated = this.runs.recordExecution({
        runId: run.id,
        entry: resumeEntry,
        nextPending: successors,
        status: "running",
        pausedAt: null,
        context: newContext,
      })
      if (updated) run = updated
      this.log(`[workflow:${workflow.id}] run ${run.id} resumed from checkpoint "${pausedCheckpointName}"`)
      if (trigger.source.endsWith("-message")) this.startChannelAck(run.id, event.payload)
    } else if (run.status === "running") {
      // Concurrent message on an already-running run. v1 policy: drop —
      // but still claim the event so the router doesn't ALSO reply.
      this.log(`[workflow:${workflow.id}] run ${run.id} already running; dropping concurrent event ${event.id}`)
      return { claimed: true, run: null }
    } else {
      // completed / failed / canceled — dead run. The filter matched but
      // this conversation's workflow is over, so let default routing handle.
      this.log(`[workflow:${workflow.id}] run ${run.id} is ${run.status}; dropping event ${event.id}`)
      return { claimed: false, run: null }
    }

    // Background walk — the dispatch call already returned 200 to the
    // webhook source. Agent calls inside the walk can take minutes.
    void this.walk(workflow, run.id, event.id)
    return { claimed: true, run }
  }

  /** Execute the pending queue until empty, paused, or failed. Wraps the
   *  inner walk in try/finally so the channel-ack typing loop is always
   *  cleared on exit — regardless of which branch (failed / paused / end /
   *  drained) returned. Without this wrapper, an early return inside the
   *  loop would leave the typing indicator running forever. */
  private async walk(workflow: Workflow, runId: string, triggeringEventId: string): Promise<void> {
    try { await this.walkInner(workflow, runId, triggeringEventId) }
    finally { this.stopChannelAck(runId) }
  }

  private async walkInner(workflow: Workflow, runId: string, triggeringEventId: string): Promise<void> {
    let run = this.runs.get(runId)
    if (!run) return

    // Batch-parallel walk: dispatch up to MAX_PARALLEL_PER_RUN pending
    // node handlers concurrently via Promise.allSettled. Each node's
    // handler runs unguarded (parallel); only the commit (recordExecution
    // + joinCounters + pause transitions) runs under the per-run mutex.
    // For linear workflows (single pending) this collapses to the old
    // serial path — identical behaviour, identical history.
    while (run.status === "running" && run.pending.length > 0) {
      const batch = run.pending.slice(0, MAX_PARALLEL_PER_RUN)
      await Promise.allSettled(
        batch.map((nodeId) => this.executeNodeAndCommit(workflow, runId, nodeId, triggeringEventId)),
      )
      const fresh = this.runs.get(runId)
      if (!fresh) return
      run = fresh
      if (run.status !== "running") return
    }
  }

  /** Execute one node + commit its result. Handler runs outside the
   *  mutex (so sibling branches run concurrently). Dedup + recordExecution
   *  + joinCounters run inside commit() so state transitions never
   *  interleave. */
  private async executeNodeAndCommit(
    workflow: Workflow,
    runId: string,
    nodeId: string,
    triggeringEventId: string,
  ): Promise<void> {
    const key = idempotencyKey(runId, nodeId, triggeringEventId)

    // --- phase 1 (guarded): dedup check + resolve handler ---
    const prelude = await this.commit(runId, () => {
      const run = this.runs.get(runId)
      if (!run) return { kind: "done" as const }
      if (run.status !== "running") return { kind: "done" as const }
      const node = findNode(workflow, nodeId)
      if (!node) {
        this.log(`[workflow:${workflow.id}] missing node "${nodeId}" — marking run failed`)
        this.runs.recordExecution({
          runId, entry: {
            at: new Date().toISOString(), nodeId, inputKeys: [], status: "failed",
            idempotencyKey: key, note: "node definition missing from workflow",
          },
          nextPending: run.pending.filter((x) => x !== nodeId),
          status: "failed",
        })
        return { kind: "done" as const }
      }
      const handler = resolveHandler(node.type)
      if (!handler) {
        this.log(`[workflow:${workflow.id}] no handler for node type "${node.type}"`)
        this.runs.recordExecution({
          runId, entry: {
            at: new Date().toISOString(), nodeId, inputKeys: [], status: "failed",
            idempotencyKey: key, note: `no handler for node type "${node.type}"`,
          },
          nextPending: run.pending.filter((x) => x !== nodeId),
          status: "failed",
        })
        return { kind: "done" as const }
      }
      if (run.history.some((h) => h.idempotencyKey === key)) {
        this.runs.recordExecution({
          runId, entry: {
            at: new Date().toISOString(), nodeId, inputKeys: [], status: "skipped",
            idempotencyKey: key + "_dedup", note: "duplicate execution dropped",
          },
          nextPending: run.pending.filter((x) => x !== nodeId),
        })
        return { kind: "done" as const }
      }
      return { kind: "go" as const, run, node, handler }
    })
    if (prelude.kind === "done") return

    // --- phase 2 (unguarded): actually run the handler, parallel-safe ---
    const { run, node, handler } = prelude
    const inputKeys = workflow.edges.filter((e) => e.to === nodeId).map((e) => e.from)

    // Improvement plan #9c — workflow steps populate task_traces so a
    // single `agentx trace list --workflow <runId>` shows every step,
    // joined by workflow_run_id. Agent nodes generate their own trace
    // via registry.execute (with workflow context already plumbed via
    // task.workflowRunId) so wrapping them here would double-count;
    // every other node type gets a synthetic trace row keyed by node
    // type so operators can answer "which transform / branch / signal
    // / action.builtin step ran when, and how long?"
    let workflowTraceTaskId: string | undefined
    if (node.type !== "agent") {
      const db = openDb()
      if (db) {
        try {
          workflowTraceTaskId = recordTraceStart(db, {
            agentId: `workflow:${node.type}`,
            channel: "workflow",
            chatId: `${workflow.id}:${nodeId}`,
            workflowRunId: runId,
            workflowId: workflow.id,
            workflowNodeId: nodeId,
            messagePreview: `${node.type} ${nodeId}`,
          })
        } catch { /* observability best-effort */ }
      }
    }

    // Improvement plan #9b — per-node retry on hard errors. Pause
    // results (userTask, signalWait, timerWait, subProcess) are
    // intentionally NOT retried — pausing is a normal lifecycle
    // transition. Only `{error}` results (handler returned an error
    // or threw) consume a retry budget.
    const retry = (node as { retry?: { maxAttempts: number; backoffMs: number } }).retry
      ?? { maxAttempts: 1, backoffMs: 1000 }
    let result: NodeResult = { error: "retry-loop did not run" }
    let attempt = 0
    while (attempt < retry.maxAttempts) {
      attempt++
      try {
        result = await handler({
          workflow, run, node,
          channels: this.channels,
          agents: this.agents,
          actors: this.actors,
          tasks: this.tasks,
          forwardChannelSend: this.forwarder?.forwardChannelSend?.bind(this.forwarder),
          log: this.log,
        })
      } catch (e: any) {
        this.log(`[workflow:${workflow.id}] handler "${node.type}" threw: ${e.message}`)
        result = { error: e.message }
      }
      // Stop on success or pause; keep going only on hard error.
      if (!result.error || result.paused) break
      if (attempt < retry.maxAttempts) {
        const wait = retry.backoffMs * Math.pow(2, attempt - 1)
        this.log(`[workflow:${workflow.id}] node "${nodeId}" failed (attempt ${attempt}/${retry.maxAttempts}): ${result.error.slice(0, 120)} — retrying in ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }

    // Finalize the workflow-step trace row, regardless of result.
    // Status mirrors the result shape: error → "error", paused → "ok"
    // (the node ran successfully and is waiting on external input;
    // pause is a normal lifecycle transition, not a failure), else "ok".
    if (workflowTraceTaskId) {
      const db = openDb()
      if (db) {
        try {
          recordTraceEnd(db, workflowTraceTaskId, {
            status: result.error ? "error" : "ok",
            error: result.error ?? null,
          })
        } catch { /* */ }
      }
    }

    // --- phase 3 (guarded): persist result + side effects ---
    await this.commit(runId, async () => {
      const fresh = this.runs.get(runId)
      if (!fresh) return
      const now = new Date().toISOString()
      const remainingFromPending = fresh.pending.filter((x) => x !== nodeId)

      if (result.error) {
        // If run is already paused/terminal from a sibling, just append
        // the exec entry without flipping status.
        const statusUpdate = fresh.status === "running" ? ("failed" as const) : undefined
        this.runs.recordExecution({
          runId, entry: {
            at: now, nodeId, inputKeys, status: "failed",
            idempotencyKey: key, note: result.error.slice(0, 200),
          },
          nextPending: remainingFromPending,
          status: statusUpdate,
        })
        this.emitRunEvent({ runId, workflowId: workflow.id, nodeId, phase: "failed", status: statusUpdate ?? fresh.status, note: result.error.slice(0, 200) })
        return
      }
      if (result.paused && result.pausedAt) {
        let pausedAt = result.pausedAt
        let spawnedChild: WorkflowRun | null = null
        if (result.spawnChild && pausedAt.kind === "subProcess") {
          spawnedChild = await this.spawnChild({
            parent: fresh, parentNodeId: nodeId,
            childWorkflowId: result.spawnChild.workflowId,
            input: result.spawnChild.input,
          })
          if (!spawnedChild) {
            this.runs.recordExecution({
              runId, entry: {
                at: now, nodeId, inputKeys, status: "failed",
                idempotencyKey: key,
                note: `subProcess: child workflow "${result.spawnChild.workflowId}" not found`,
              },
              nextPending: remainingFromPending, status: "failed",
            })
            return
          }
          pausedAt = { ...pausedAt, childRunId: spawnedChild.id }
        }
        this.runs.recordExecution({
          runId, entry: {
            at: now, nodeId, inputKeys, status: "paused", idempotencyKey: key,
          },
          nextPending: remainingFromPending,
          status: "paused",
          pausedAt,
        })
        this.emitRunEvent({ runId, workflowId: workflow.id, nodeId, phase: "paused", status: "paused", note: pausedAt.kind })
        if (spawnedChild) this.kickChildWalk(spawnedChild)
        if (pausedAt.kind === "timerWait") {
          try {
            this.timers.schedule({
              runId, workflowId: workflow.id, nodeId: pausedAt.nodeId,
              fireAt: pausedAt.fireAt,
              cancelKey: `${runId}:${pausedAt.nodeId}`,
            })
          } catch (e: any) {
            this.log(`[workflow:${workflow.id}] timer schedule failed: ${e.message}`)
          }
        }
        if (pausedAt.kind === "userTask") {
          const taskRecord = this.tasks.get(pausedAt.taskId)
          if (taskRecord && this.events) {
            try {
              this.events.publish({
                kind: "task", taskId: taskRecord.id, workflowId: workflow.id, runId,
                phase: "created", title: taskRecord.title, assignedTo: taskRecord.assignedTo,
              })
            } catch { /* ignore */ }
          }
          if (taskRecord && this.renderUserTask) {
            try { await this.renderUserTask(taskRecord) }
            catch (e: any) { this.log(`[workflow:${workflow.id}] userTask render failed: ${e.message}`) }
          }
        }
        return
      }

      // Success path — fold output, join-gate, enqueue successors.
      const output: Record<string, unknown> = result.output ?? {}
      const newContext: Record<string, Record<string, unknown>> = { ...fresh.context, [nodeId]: output }
      const { nextPending } = nextNodes({ workflow, fromNodeId: nodeId, selectedPort: result.port })

      const readyNext: string[] = []
      const joinCounters: Record<string, string[]> = { ...(fresh.joinCounters ?? {}) }
      for (const succId of nextPending) {
        const succ = findNode(workflow, succId)
        const isJoin = succ?.type === "gateway.parallel" && String((succ.config as { mode?: unknown } | undefined)?.mode ?? "fanOut") === "join"
        if (!isJoin) { readyNext.push(succId); continue }
        const arrived = joinCounters[succId] ?? []
        if (!arrived.includes(nodeId)) arrived.push(nodeId)
        joinCounters[succId] = arrived
        const expected = workflow.edges.filter((e) => e.to === succId).length
        if (arrived.length >= expected) {
          readyNext.push(succId)
          delete joinCounters[succId]
        }
      }
      const merged = [...remainingFromPending, ...readyNext]
      const terminal = node.type === "end"

      // Respect a sibling branch's pause: if the run is already non-running,
      // don't flip status back to running. Still record the exec entry +
      // merged pending so the resume path can see the siblings' successors.
      const statusUpdate = fresh.status === "running"
        ? (terminal ? (String(node.config.status ?? "completed") as WorkflowRun["status"]) : ("running" as const))
        : undefined

      const updated = this.runs.recordExecution({
        runId,
        entry: { at: now, nodeId, inputKeys, status: "ok", output, idempotencyKey: key },
        nextPending: terminal ? [] : merged,
        status: statusUpdate,
        context: newContext,
        joinCounters,
      })

      this.emitRunEvent({
        runId, workflowId: workflow.id, nodeId,
        phase: terminal ? "completed" : "ok",
        status: updated?.status ?? fresh.status,
      })

      if (result.emitSignal) {
        this.emitSignal({
          name: result.emitSignal.name,
          scope: result.emitSignal.scope,
          workflowId: workflow.id,
          payload: result.emitSignal.payload,
        })
      }

      if (terminal && updated && updated.parentRunId && updated.parentNodeId) {
        void this.resumeParent({
          parentRunId: updated.parentRunId,
          parentNodeId: updated.parentNodeId,
          childRun: updated,
        }).catch((e: any) => this.log(`[workflow:${workflow.id}] resumeParent failed: ${e.message}`))
      }
    })
  }

  // ---------------- Sub-process helpers ----------------

  /** Create a child run for a sub-process node. Returns null if the child
   *  workflow id doesn't exist. Depth cap is enforced at the handler layer
   *  before we get here. */
  private async spawnChild(args: {
    parent: WorkflowRun
    parentNodeId: string
    childWorkflowId: string
    input: Record<string, unknown>
  }): Promise<WorkflowRun | null> {
    const childWf = this.store.list().find((w) => w.id === args.childWorkflowId)
    if (!childWf) return null

    const init = initialPendingFromTrigger(childWf)
    if (!init) { this.log(`[workflow:${childWf.id}] no trigger node — cannot spawn as child`); return null }

    // Child gets a fresh context, seeded by the parent's inputMap. Top-level
    // keys are child-context keys; values are bundles. Parent linkage is
    // stamped onto the trigger node's bundle so downstream templates can
    // read {{trigger.parentRunId}} if useful.
    const childContext: Record<string, Record<string, unknown>> = {
      ...(args.input as Record<string, Record<string, unknown>>),
    }
    childContext[init.triggerId] = {
      ...(childContext[init.triggerId] ?? {}),
      parentRunId: args.parent.id,
      parentNodeId: args.parentNodeId,
    }

    const entityRef: EntityRef = {
      backend: "agentx-internal",
      id: `subprocess:${args.parent.id}:${args.parentNodeId}`,
    }

    const child = this.runs.create({
      workflowId: childWf.id,
      initialPending: init.pending,
      entityRef,
      initialContext: childContext,
      parentRunId: args.parent.id,
      parentNodeId: args.parentNodeId,
      rootRunId: args.parent.rootRunId ?? args.parent.id,
      depth: (args.parent.depth ?? 0) + 1,
    })
    this.log(`[workflow:${childWf.id}] child run ${child.id} spawned from ${args.parent.id}/${args.parentNodeId} (depth ${child.depth})`)
    // The caller (walk loop) kicks off the child walk AFTER persisting the
    // parent's paused state, so a fast child reaching end doesn't try to
    // resume a parent that hasn't been saved yet.
    return child
  }

  /** Kick a child run's walk loop — used by the walk loop after persisting
   *  the parent's pause. Fire-and-forget. */
  private kickChildWalk(childRun: WorkflowRun): void {
    const childWf = this.store.list().find((w) => w.id === childRun.workflowId)
    if (!childWf) return
    void this.walk(childWf, childRun.id, `spawn:${childRun.parentRunId}:${childRun.parentNodeId}`)
      .catch((e: any) => this.log(`[workflow:${childWf.id}] child walk failed: ${e.message}`))
  }

  /** Resume a parent run whose subProcess node was awaiting this child. */
  async resumeParent(args: {
    parentRunId: string
    parentNodeId: string
    childRun: WorkflowRun
  }): Promise<void> {
    const preliminaryParent = this.runs.get(args.parentRunId)
    if (!preliminaryParent) return
    const parentWf = this.store.list().find((w) => w.id === preliminaryParent.workflowId)
    if (!parentWf) return

    await this.commit(args.parentRunId, () => {
      const parent = this.runs.get(args.parentRunId)
      if (!parent || parent.status !== "paused") return
      if (!parent.pausedAt || parent.pausedAt.kind !== "subProcess") return
      if (parent.pausedAt.nodeId !== args.parentNodeId) return
      if (parent.pausedAt.childRunId !== args.childRun.id) return

      const node = findNode(parentWf, args.parentNodeId)
      const successors = node ? parentWf.edges.filter((e) => e.from === node.id).map((e) => e.to) : []
      const childOutput: Record<string, unknown> = {
        childRunId: args.childRun.id,
        status: args.childRun.status,
        output: pickChildOutput(args.childRun),
      }
      this.runs.recordExecution({
        runId: parent.id,
        entry: {
          at: new Date().toISOString(),
          nodeId: args.parentNodeId,
          inputKeys: [],
          status: "resumed",
          output: childOutput,
          idempotencyKey: idempotencyKey(parent.id, args.parentNodeId, `child:${args.childRun.id}`),
        },
        nextPending: successors,
        status: "running",
        pausedAt: null,
        context: { ...parent.context, [args.parentNodeId]: childOutput },
      })
      this.log(`[workflow:${parentWf.id}] parent run ${parent.id} resumed from subProcess child ${args.childRun.id}`)
      this.emitRunEvent({ runId: parent.id, workflowId: parentWf.id, nodeId: args.parentNodeId, phase: "resumed", status: "running", note: `child:${args.childRun.id}` })
    })
    void this.walk(parentWf, args.parentRunId, `child:${args.childRun.id}`)
  }

  // ---------------- User-task submit / resume ----------------

  async submitTask(taskId: string, submission: FormSubmission, submittedBy: string): Promise<
    { ok: true; runId: string } | { ok: false; error: string; fieldErrors?: Array<{ field: string; message: string }> }
  > {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, error: `task not found: ${taskId}` }
    if (task.status !== "open") return { ok: false, error: `task is ${task.status}` }

    const validated = validateSubmission(task.form, submission)
    if (!validated.ok) return { ok: false, error: "form validation failed", fieldErrors: validated.errors }

    const preliminary = this.runs.get(task.runId)
    if (!preliminary) return { ok: false, error: `run ${task.runId} not found` }
    const parentWf = this.store.list().find((w) => w.id === preliminary.workflowId)
    if (!parentWf) return { ok: false, error: `workflow ${preliminary.workflowId} not found` }

    const commitResult = await this.commit(task.runId, ():
      | { ok: true; runId: string }
      | { ok: false; error: string } => {
      const parent = this.runs.get(task.runId)
      if (!parent || parent.status !== "paused") return { ok: false, error: `run ${task.runId} is not paused` }
      if (!parent.pausedAt || parent.pausedAt.kind !== "userTask" || parent.pausedAt.taskId !== taskId) {
        return { ok: false, error: `run ${task.runId} is not waiting on task ${taskId}` }
      }
      const node = findNode(parentWf, task.nodeId)
      const successors = node ? parentWf.edges.filter((e) => e.from === node.id).map((e) => e.to) : []
      const output: Record<string, unknown> = {
        submittedBy,
        submittedAt: new Date().toISOString(),
        values: validated.values,
        action: submission.action,
      }
      this.runs.recordExecution({
        runId: parent.id,
        entry: {
          at: new Date().toISOString(),
          nodeId: task.nodeId,
          inputKeys: [],
          status: "resumed",
          output,
          idempotencyKey: idempotencyKey(parent.id, task.nodeId, `task:${taskId}:${submission.action}`),
        },
        nextPending: successors,
        status: "running",
        pausedAt: null,
        context: { ...parent.context, [task.nodeId]: output },
      })
      this.tasks.save({
        ...task,
        status: "completed",
        submittedBy,
        submittedAt: output.submittedAt as string,
        submittedValues: validated.values,
        submittedAction: submission.action,
      })
      this.log(`[workflow:${parentWf.id}] run ${parent.id} resumed from userTask ${taskId}`)
      this.emitRunEvent({ runId: parent.id, workflowId: parentWf.id, nodeId: task.nodeId, phase: "resumed", status: "running", note: `task:${taskId}` })
      if (this.events) {
        try {
          this.events.publish({
            kind: "task",
            taskId, workflowId: parentWf.id, runId: parent.id,
            phase: "submitted", submittedBy,
            title: task.title, assignedTo: task.assignedTo,
          })
        } catch { /* ignore */ }
      }
      return { ok: true, runId: parent.id }
    })
    if (!commitResult.ok) return commitResult
    void this.walk(parentWf, task.runId, `task:${taskId}`)
    return commitResult
  }
}

/** Pick the most informative output bundle from a child run's history as
 *  the `output` field exposed to the parent's subProcess node. We prefer
 *  the last non-empty `ok` entry, which is typically the last meaningful
 *  step before `end`. */
function pickChildOutput(child: WorkflowRun): Record<string, unknown> {
  for (let i = child.history.length - 1; i >= 0; i--) {
    const h = child.history[i]
    if (h.status === "ok" && h.output && Object.keys(h.output).length > 0) {
      return h.output
    }
  }
  return {}
}

/** Does the incoming event's trigger fields match the checkpoint's
 *  resumeMatch filter? Empty/missing fields are wildcards (match anything),
 *  so the default `resumeMatch: {}` accepts any event on the entity. */
function matchesResume(
  resumeMatch: Record<string, unknown>,
  trigger: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  event: TriggerEvent,
): boolean {
  const match = (k: keyof typeof trigger): boolean => {
    const want = resumeMatch[k]
    if (want === undefined || want === "" || want === "*") return true
    if (Array.isArray(want)) {
      const have = new Set(trigger.labels ?? [])
      return (want as string[]).some((l) => have.has(String(l)))
    }
    if (k === "chat") {
      return normalizeChat(trigger.source, String(want)) === normalizeChat(trigger.source, trigger.chat)
    }
    return trigger[k] === want
  }
  // Fields supported in v1: source, project, repo, chat, labels. Additional
  // keys in resumeMatch are ignored (won't accidentally block resume).
  if (!match("source")) return false
  if (!match("project")) return false
  if (!match("repo")) return false
  if (!match("chat")) return false
  // `eventIdLike`: optional substring match on the event id, useful for
  // resuming only on events that carry a specific marker.
  const eventIdLike = resumeMatch.eventIdLike
  if (typeof eventIdLike === "string" && eventIdLike && !event.id.includes(eventIdLike)) return false
  return true
}

/** Normalize a chat identifier for filter comparison. Channel-aware: WhatsApp
 *  ids drift between formats (raw digits "21624309128", JID
 *  "21624309128@s.whatsapp.net", group JID "...-...@g.us", and human-formatted
 *  "+216 24 309 128") depending on whether they came from the adapter's
 *  payload, a copy-paste from the WA UI, or an editor field. We collapse all
 *  of these to the canonical bare-id form before equality so authors can write
 *  filters in whichever form is convenient. Other channels (Telegram, GitLab,
 *  ...) use stable id formats from their APIs and don't need normalization. */
function normalizeChat(source: string | undefined, value: string | undefined): string {
  if (value == null) return ""
  if (source === "whatsapp-message") {
    return value.replace(/@s\.whatsapp\.net$|@g\.us$/i, "").replace(/[\s+()]/g, "")
  }
  return value
}

export { idempotencyKey } from "./run-store"
