import { randomUUID } from "crypto"
import { evaluateBranch, findNode, initialPendingFromTrigger, nextNodes } from "./engine"
import { parseResultToken, resolveHandler } from "./nodes/handlers"
import { deliver, messageKey, nextWakeAt, nudgeText, renderPersonMessage, stepVerdict } from "./nodes/follow-up"
import { DEFAULT_FOLLOW_UP, type AgentExecuteRequest, type AgentExecuteResponse, type FollowUpDefaults, type NodeResult, type OwnerPort } from "./nodes/types"
import { RunStore, idempotencyKey } from "./run-store"
import type { WorkflowStore } from "./store"
import { TimerService, type TimerRecord } from "./timers"
import { SignalBus, matchesSignal, type SignalEmission } from "./signals"
import type { EventBus } from "../daemon/event-bus"
import { FOLLOW_UP_PORTS, type EntityRef, type NodeExecutionEntry, type PausedAt, type RunMeta, type Workflow, type WorkflowRun } from "./types"
import { getLedgerMode } from "@/intent/mode"
import { getDefaultLedger } from "@/intent/instance"
import { recordWorkflowDispatch } from "@/intent/sources/workflow"
import { openDb } from "@/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "@/storage/traces"
import { withRoot } from "@/events/envelope"

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
  /** Follow-up (#788): how the engine tells and asks the owner. */
  owner?: OwnerPort
  /** Follow-up defaults, read at each use so a settings change applies. */
  followUp?: () => FollowUpDefaults
  /** A follow-up run ended (completed, failed, canceled). Called once. */
  onRunEnded?: (run: WorkflowRun, workflow: Workflow | null) => void | Promise<void>
  /** A follow-up step is blocked and needs the owner. Called once per block. */
  onBlocked?: (run: WorkflowRun, workflow: Workflow, nodeId: string, reason: string) => void | Promise<void>
}

/** An inbound message a `person.wait` step may be waiting for. */
export interface InboundReply {
  channel: string
  chatId: string
  accountId?: string
  /** Who wrote it, in a group. */
  senderId?: string
  senderName?: string
  text: string
  media?: unknown
  messageId?: string
}

const TERMINAL = new Set(["completed", "failed", "canceled"])

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
  readonly timers: TimerService
  readonly signals: SignalBus
  readonly events?: EventBus
  owner?: OwnerPort
  private readonly followUpDefaults: () => FollowUpDefaults
  private readonly onRunEnded?: DispatcherOptions["onRunEnded"]
  private readonly onBlocked?: DispatcherOptions["onBlocked"]
  /** Runs paused on person.wait, by channel. Read on every inbound
   *  message, so it is kept in memory: built from disk once, then kept up
   *  to date as runs pause. A stale entry costs one read; the run's own
   *  pause is checked before it takes a message. */
  private replyWaiters: Map<string, Set<string>> | null = null
  /** "done" an agent reported from inside its own step's turn, before
   *  the turn ended (runId:nodeId). Applied when the turn ends. */
  private readonly earlyDone = new Map<string, Record<string, unknown>>()
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
    this.timers = opts.timers ?? new TimerService({ log: (m) => this.log(m) })
    this.signals = opts.signals ?? new SignalBus()
    this.events = opts.events
    this.owner = opts.owner
    this.followUpDefaults = opts.followUp ?? (() => DEFAULT_FOLLOW_UP)
    this.onRunEnded = opts.onRunEnded
    this.onBlocked = opts.onBlocked

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
    /** The run's event root; defaults to the current root context. */
    rootId?: string
  }): void {
    if (!this.events) return
    try {
      this.events.publish({
        kind: "run",
        runId: args.runId, workflowId: args.workflowId,
        nodeId: args.nodeId, phase: args.phase,
        status: args.status, note: args.note, homeNode: args.homeNode,
        rootId: args.rootId,
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
        this.emitRunEvent({ runId: fresh.id, workflowId: wf.id, nodeId: fresh.pausedAt.nodeId, phase: "resumed", status: "running", note: `signal:${emission.name}`, rootId: fresh.eventRootId })
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
    const kind = this.runs.get(t.runId)?.pausedAt?.kind
    if (kind === "replyWait" || kind === "agentStep") { await this.followUpTimer(wf, t); return }
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
      this.emitRunEvent({ runId: fresh.id, workflowId: wf.id, nodeId: t.nodeId, phase: "resumed", status: "running", note: `timer:${t.id}`, rootId: fresh.eventRootId })
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
    // Runs are indexed by entity only. A run of another workflow on this
    // entity must not be resumed, or walked with this workflow's graph.
    const activeRunId = this.runs.getActiveByEntity(args.entityRef)
    const active = activeRunId ? this.runs.get(activeRunId) : null
    if (active && active.workflowId !== wf.id) {
      this.log(`[workflow:${wf.id}] entity ${args.entityRef.id} has run ${active.id} of workflow "${active.workflowId}" — not dispatching`)
      return { claimed: false, run: null }
    }
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
      // event from `initech/int.initech.example.com` reaching `globex-pm-triage` (which is
      // tagged `project: globex/globex-system-v2`). Workflows with no
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
      this.emitRunEvent({ runId: run.id, workflowId: workflow.id, phase: "created", status: run.status, homeNode: run.homeNode, rootId: run.eventRootId })
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
    // Everything the walk does (agent tasks, mesh forwards, run events)
    // belongs to the run's root, whatever resumed it.
    const rootId = this.runs.get(runId)?.eventRootId
    const inner = () => this.walkInner(workflow, runId, triggeringEventId)
    try { await (rootId ? withRoot({ rootId }, inner) : inner()) }
    finally {
      this.stopChannelAck(runId)
      await this.settle(runId)
    }
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
    // How long the step took, retries included (#858: run records).
    const stepStartedMs = Date.now()
    const timing = () => ({ startedAt: new Date(stepStartedMs).toISOString(), durationMs: Math.max(0, Date.now() - stepStartedMs) })
    while (attempt < retry.maxAttempts) {
      attempt++
      try {
        result = await handler({
          workflow, run, node,
          channels: this.channels,
          agents: this.agents,
          forwardChannelSend: this.forwarder?.forwardChannelSend?.bind(this.forwarder),
          log: this.log,
          owner: this.owner,
          followUp: this.followUpDefaults(),
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

    // The agent said "done" with agentx_workflow while its turn ran.
    const early = this.earlyDone.get(`${runId}:${nodeId}`)
    if (early) {
      this.earlyDone.delete(`${runId}:${nodeId}`)
      if (result.paused && result.pausedAt?.kind === "agentStep" && !result.blocked) {
        result = { output: { ...(result.output ?? {}), ...early } }
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
            idempotencyKey: key, note: result.error.slice(0, 200), ...timing(),
          },
          nextPending: remainingFromPending,
          status: statusUpdate,
        })
        this.emitRunEvent({ runId, workflowId: workflow.id, nodeId, phase: "failed", status: statusUpdate ?? fresh.status, note: result.error.slice(0, 200) })
        return
      }
      if (result.paused && result.pausedAt && TERMINAL.has(fresh.status)) {
        // Ended meanwhile (canceled while the step ran): note it, don't revive it.
        this.runs.recordExecution({
          runId, entry: { at: now, nodeId, inputKeys, status: "skipped", idempotencyKey: key, note: `step ended after the run was ${fresh.status}` },
          nextPending: remainingFromPending,
        })
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
            at: now, nodeId, inputKeys, status: "paused", idempotencyKey: key, ...timing(),
            ...(result.blocked ? { note: `blocked: ${result.blocked}`.slice(0, 200) } : {}),
          },
          nextPending: remainingFromPending,
          status: "paused",
          pausedAt,
          // A followed agent step keeps what its turn said.
          ...(result.output ? { context: { ...fresh.context, [nodeId]: result.output } } : {}),
        })
        this.emitRunEvent({ runId, workflowId: workflow.id, nodeId, phase: "paused", status: "paused", note: pausedAt.kind })
        this.scheduleWake(runId, workflow.id, pausedAt)
        if (result.blocked) this.markBlocked(runId, workflow, nodeId, result.blocked)
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
        entry: { at: now, nodeId, inputKeys, status: "ok", output, idempotencyKey: key, ...timing() },
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

  // ---------------- Follow-up (#788) ----------------
  //
  // A follow-up run is one an agent, the CLI or the dashboard started for
  // a request (startRun). The run itself is the follow-up: each pause has
  // a resume path here (a card answer, a person's reply, a step reported
  // done, a timer), so nothing needs its own watcher.

  /** Start a run of `workflowId` with these inputs as the trigger's
   *  output. With approval at start (and messages to people in it), the
   *  run waits for the owner's yes before its first step. */
  async startRun(args: {
    workflowId: string
    inputs?: Record<string, unknown>
    meta?: Partial<RunMeta>
    entityRef?: EntityRef
  }): Promise<{ run: WorkflowRun | null; error?: string; awaitingApproval?: boolean }> {
    const wf = this.store.get(args.workflowId)
    if (!wf) return { run: null, error: `workflow "${args.workflowId}" not found` }
    const init = initialPendingFromTrigger(wf)
    if (!init) return { run: null, error: `workflow "${wf.id}" has no trigger node` }
    const entityRef = args.entityRef ?? { backend: "follow-up", id: `${wf.id}:${randomUUID()}` }
    const meta: RunMeta = { tags: [], approvedAtStart: false, ...args.meta, followUp: args.meta?.followUp ?? true }
    const run = this.runs.create({
      workflowId: wf.id,
      initialPending: init.pending,
      entityRef,
      initialContext: { [init.triggerId]: args.inputs ?? {} },
      meta,
    })
    this.log(`[workflow:${wf.id}] follow-up run ${run.id} started${meta.startedBy ? ` by ${meta.startedBy}` : ""}`)
    this.emitRunEvent({ runId: run.id, workflowId: wf.id, phase: "created", status: run.status, homeNode: run.homeNode, rootId: run.eventRootId })

    const messages = this.startMessages(wf, run)
    const approval = wf.approval ?? this.followUpDefaults().approval
    // Only messages known in full at the start can be approved then; one
    // that uses what a later step produces is asked again before it goes.
    if (approval === "start" && messages.some((m) => m.msg) && !meta.approvedAtStart) {
      const fail = async (error: string) => {
        this.runs.setStatus(run.id, "failed")
        await this.settle(run.id)
        return { run: this.runs.get(run.id), error }
      }
      if (!this.owner) return fail("this workflow needs the owner's approval at start, and there is no owner to ask on this node")
      const lines = messages.map(({ nodeId, msg }) => msg
        ? `- ${nodeId} to ${msg.to ? `${msg.to} ` : ""}(${msg.channel} ${msg.chatId}): ${msg.text.replace(/\s+/g, " ").slice(0, 160)}`
        : `- ${nodeId}: asked again before it is sent (it uses what an earlier step produces)`)
      try {
        const { cardId } = await this.owner.ask({
          title: (meta.title ?? wf.title).slice(0, 120),
          ask: `Start "${wf.title}" and let it send the message(s) below without asking again?`.slice(0, 300),
          recommend: "Yes if the recipients and the text below are right.",
          context: lines.join("\n").slice(0, 600),
        }, run, init.triggerId)
        this.runs.recordExecution({
          runId: run.id,
          entry: { at: new Date().toISOString(), nodeId: init.triggerId, inputKeys: [], status: "paused", idempotencyKey: idempotencyKey(run.id, init.triggerId, "start-approval"), note: "waiting for the owner's approval at start" },
          nextPending: init.pending,
          status: "paused",
          pausedAt: { kind: "ownerDecision", nodeId: init.triggerId, cardId, purpose: "start" },
        })
        return { run: this.runs.get(run.id), awaitingApproval: true }
      } catch (e: any) {
        return fail(`could not ask the owner: ${e?.message ?? e}`)
      }
    }
    void this.walk(wf, run.id, `start:${run.id}`)
      .catch((e: any) => this.log(`[workflow:${wf.id}] walk after start failed: ${e.message}`))
    return { run }
  }

  /** The run's person.message steps as they read at the start: in full
   *  when they use only the run's inputs, else null (asked later). */
  private startMessages(wf: Workflow, run: WorkflowRun): Array<{ nodeId: string; msg: ReturnType<typeof renderPersonMessage> | null }> {
    const triggerId = wf.nodes.find((n) => n.type.startsWith("trigger."))?.id ?? ""
    return wf.nodes.filter((n) => n.type === "person.message").map((node) => {
      const c = node.config as Record<string, unknown>
      const refs = [c.channel, c.chatId, c.text, c.to, c.accountId].flatMap((v) => typeof v === "string" ? [...v.matchAll(/\{\{\s*([A-Za-z_][\w-]*)/g)].map((m) => m[1]) : [])
      if (refs.some((r) => r !== triggerId && r !== "env")) return { nodeId: node.id, msg: null }
      const msg = renderPersonMessage({ node, run, workflow: wf })
      return { nodeId: node.id, msg: msg.channel && msg.chatId && msg.text ? msg : null }
    })
  }

  /** A decision card raised for a run was answered or expired. Returns
   *  true when it belonged to a run waiting on it. */
  async resumeFromCard(card: { id: string; status: string; verdict?: string; text?: string; choice?: string; note?: string; origin?: { kind: string; runId?: string; nodeId?: string } }): Promise<boolean> {
    const runId = card.origin?.kind === "workflow" ? card.origin.runId : undefined
    if (!runId || card.status === "pending") return false
    const run0 = this.runs.get(runId)
    const wf = run0 ? this.store.get(run0.workflowId) : null
    if (!run0 || !wf) return false
    const port = card.status === "decided" ? (card.verdict === "yes" ? "yes" : "no") : "expired"
    let handled = false
    let walk = false
    let sendFailure: string | undefined
    // Sending happens outside the commit: a slow channel must not hold it.
    const p0 = run0.pausedAt
    let sent: { messageId: string | null } | { error: string } | null = null
    if (p0?.kind === "ownerDecision" && p0.cardId === card.id && p0.purpose === "send" && port === "yes" && p0.message) {
      sent = await deliver({ channels: this.channels, forwardChannelSend: this.forwarder?.forwardChannelSend?.bind(this.forwarder) }, { ...p0.message, text: card.text?.trim() || p0.message.text })
    }
    await this.commit(runId, () => {
      const fresh = this.runs.get(runId)
      const p = fresh?.pausedAt
      if (!fresh || fresh.status !== "paused" || p?.kind !== "ownerDecision" || p.cardId !== card.id) return
      handled = true
      const at = new Date().toISOString()
      const key = idempotencyKey(fresh.id, p.nodeId, `card:${card.id}`)
      if (p.purpose === "start") {
        if (port === "yes") {
          const approved: Record<string, string> = {}
          for (const { nodeId, msg } of this.startMessages(wf, fresh)) if (msg) approved[nodeId] = messageKey(msg)
          this.runs.setMeta(fresh.id, { approvedAtStart: true, approved })
          this.runs.recordExecution({ runId: fresh.id, entry: { at, nodeId: p.nodeId, inputKeys: [], status: "resumed", idempotencyKey: key, note: "approved at start" }, nextPending: fresh.pending, status: "running", pausedAt: null })
          walk = true
        } else {
          this.runs.recordExecution({ runId: fresh.id, entry: { at, nodeId: p.nodeId, inputKeys: [], status: "failed", idempotencyKey: key, note: port === "no" ? "the owner said no at start" : "the owner did not answer before the start card expired" }, nextPending: [], status: "canceled", pausedAt: null })
        }
        return
      }
      const decision = { cardId: card.id, verdict: card.verdict ?? null, status: card.status, choice: card.choice ?? null, text: card.text ?? null, note: card.note ?? null }
      if (p.purpose === "send") {
        if (port === "yes" && sent && "error" in sent) {
          sendFailure = sent.error
          this.runs.recordExecution({ runId: fresh.id, entry: { at, nodeId: p.nodeId, inputKeys: [], status: "failed", idempotencyKey: key, note: sent.error.slice(0, 200) }, nextPending: [], status: "failed", pausedAt: null })
          return
        }
        const output = port === "yes"
          ? { ...decision, ...p.message, text: card.text?.trim() || p.message?.text, messageId: sent && "messageId" in sent ? sent.messageId : null, approved: "step" }
          : { ...decision, ...p.message, declined: true }
        walk = this.resumeOn(wf, fresh, p.nodeId, output, port === "yes" ? "sent" : "declined", key, port === "yes" ? "sent after approval" : `not sent: ${port === "no" ? "the owner said no" : "the card expired"}`)
        return
      }
      walk = this.resumeOn(wf, fresh, p.nodeId, decision, port, key, `owner answered: ${port}`)
    })
    if (sendFailure) this.log(`[workflow:${wf.id}] run ${runId}: approved message not sent: ${sendFailure}`)
    if (walk) void this.walk(wf, runId, `card:${card.id}`).catch((e: any) => this.log(`[workflow:${wf.id}] walk after card failed: ${e.message}`))
    else if (handled) await this.settle(runId)
    return handled
  }

  /** An inbound message: the oldest run waiting for a reply in this chat
   *  (from this sender, in a group) takes it. Returns that run's id, or
   *  null when no run was waiting for it. */
  async resumeFromReply(msg: InboundReply): Promise<string | null> {
    const source = `${msg.channel}-message`
    if (!this.replyWaiters) {
      this.replyWaiters = new Map()
      for (const r of this.runs.list({ limit: 500 })) {
        if (r.status === "paused" && r.pausedAt?.kind === "replyWait") this.noteReplyWaiter(r.id, r.pausedAt.channel)
      }
    }
    const ids = this.replyWaiters.get(msg.channel)
    if (!ids?.size) return null
    const waiting = [...ids]
      .map((id) => this.runs.get(id))
      .filter((r): r is WorkflowRun => {
        if (r?.status === "paused" && r.pausedAt?.kind === "replyWait") return true
        if (r) ids.delete(r.id)
        return false
      })
      .filter((r) => {
        const p = r.pausedAt as Extract<PausedAt, { kind: "replyWait" }>
        if (p.channel !== msg.channel) return false
        if (normalizeChat(source, p.chatId) !== normalizeChat(source, msg.chatId)) return false
        if (p.accountId && msg.accountId && p.accountId !== msg.accountId) return false
        if (p.from && normalizeChat(source, p.from) !== normalizeChat(source, msg.senderId ?? "")) return false
        return true
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const candidate of waiting) {
      const wf = this.store.get(candidate.workflowId)
      if (!wf) continue
      let taken = false
      await this.commit(candidate.id, () => {
        const fresh = this.runs.get(candidate.id)
        const p = fresh?.pausedAt
        if (!fresh || fresh.status !== "paused" || p?.kind !== "replyWait" || p.nodeId !== (candidate.pausedAt as { nodeId: string }).nodeId) return
        taken = true
        const output = { text: msg.text, from: msg.senderId ?? null, fromName: msg.senderName ?? null, media: msg.media ?? null, channel: msg.channel, chatId: msg.chatId, at: new Date().toISOString(), reminders: p.reminders }
        this.timers.cancel({ cancelKey: `${fresh.id}:${p.nodeId}` })
        this.resumeOn(wf, fresh, p.nodeId, output, "reply", idempotencyKey(fresh.id, p.nodeId, `reply:${msg.messageId ?? output.at}`), "reply received")
      })
      if (!taken) continue
      ids.delete(candidate.id)
      void this.walk(wf, candidate.id, `reply:${msg.messageId ?? Date.now()}`).catch((e: any) => this.log(`[workflow:${wf.id}] walk after reply failed: ${e.message}`))
      return candidate.id
    }
    return null
  }

  /** An agent says its step is done (agentx_workflow done), or that
   *  it is blocked. `nodeId` may be left out: the step the run waits on. */
  async stepDone(args: { runId: string; nodeId?: string; agentId?: string; output?: Record<string, unknown>; blocked?: string }): Promise<{ ok: boolean; error?: string }> {
    const run0 = this.runs.get(args.runId)
    if (!run0) return { ok: false, error: `no run "${args.runId}"` }
    const wf = this.store.get(run0.workflowId)
    if (!wf) return { ok: false, error: `workflow "${run0.workflowId}" is gone` }
    let error: string | undefined
    let walk = false
    await this.commit(args.runId, () => {
      const fresh = this.runs.get(args.runId)
      const p = fresh?.pausedAt
      // Reported from inside the step's own turn: kept until the turn ends.
      if (fresh?.status === "running" && !args.blocked) {
        const nodeId = args.nodeId ?? fresh.pending.find((id) => findNode(wf, id)?.type === "agent")
        const node = nodeId ? findNode(wf, nodeId) : undefined
        const owner = node ? String((node.config as { agentId?: unknown }).agentId ?? "") : ""
        if (node?.type === "agent" && fresh.pending.includes(node.id) && (!args.agentId || args.agentId === owner || args.agentId === fresh.meta?.startedBy)) {
          this.earlyDone.set(`${fresh.id}:${node.id}`, { ...(args.output ?? {}), result: (args.output?.result as string | undefined) ?? "done", doneAt: new Date().toISOString() })
          return
        }
      }
      if (!fresh || fresh.status !== "paused" || p?.kind !== "agentStep") { error = `run ${args.runId} is not waiting on an agent step (it is ${fresh?.status ?? "gone"}${p ? `, on ${p.kind} ${p.nodeId}` : ""})`; return }
      if (args.nodeId && args.nodeId !== p.nodeId) { error = `run ${args.runId} waits on step "${p.nodeId}", not "${args.nodeId}"`; return }
      if (args.agentId && args.agentId !== p.agentId && args.agentId !== fresh.meta?.startedBy) { error = `step "${p.nodeId}" belongs to ${p.agentId}`; return }
      if (args.blocked) {
        // Already blocked: the owner was told once.
        if (!p.blocked) this.blockStep(wf, fresh, p, args.blocked)
        return
      }
      this.timers.cancel({ cancelKey: `${fresh.id}:${p.nodeId}` })
      if (fresh.meta?.blocked) this.runs.setMeta(fresh.id, { blocked: undefined })
      const output = { ...(fresh.context[p.nodeId] ?? {}), ...(args.output ?? {}), result: (args.output?.result as string | undefined) ?? "done", doneAt: new Date().toISOString() }
      walk = this.resumeOn(wf, this.runs.get(fresh.id)!, p.nodeId, output, undefined, idempotencyKey(fresh.id, p.nodeId, `done:${output.doneAt}`), "reported done")
    })
    if (error) return { ok: false, error }
    if (walk) void this.walk(wf, args.runId, `done:${args.runId}`).catch((e: any) => this.log(`[workflow:${wf.id}] walk after step done failed: ${e.message}`))
    else await this.settle(args.runId)
    return { ok: true }
  }

  /** The agent step of `agentId` a running run is on, for a stop signal
   *  about to pause it (#870). An error when the run cannot pause there. */
  agentStepOf(runId: string, agentId: string): { workflowId: string; nodeId: string } | { error: string } {
    const run = this.runs.get(runId)
    if (!run) return { error: `no workflow run ${runId}` }
    if (run.status !== "running") return { error: `workflow run ${runId} is ${run.status}` }
    const wf = this.store.get(run.workflowId)
    if (!wf) return { error: `workflow "${run.workflowId}" is gone` }
    const steps = run.pending.filter((id) => {
      const node = findNode(wf, id)
      return node?.type === "agent" && String((node.config as { agentId?: unknown }).agentId ?? "") === agentId
    })
    if (steps.length !== 1) return { error: steps.length ? `workflow run ${runId} runs ${agentId} in ${steps.length} steps at once` : `workflow run ${runId} is not on a step of ${agentId}` }
    return { workflowId: run.workflowId, nodeId: steps[0] }
  }

  /** A resume signal for a step a stop signal paused (#870). The step
   *  re-enters with `note` (the agent's resume plan) prepended to its
   *  prompt, and the run walks on from it. Resolves once the walk is
   *  started, not when the step ends. */
  async resumeStoppedStep(args: { runId: string; agentId: string; taskId?: string; note: string; by: string }): Promise<{ ok: true; nodeId: string } | { ok: false; error: string }> {
    const run0 = this.runs.get(args.runId)
    if (!run0) return { ok: false, error: `no workflow run ${args.runId}` }
    const wf = this.store.get(run0.workflowId)
    if (!wf) return { ok: false, error: `workflow "${run0.workflowId}" is gone` }
    let error: string | undefined
    let nodeId = ""
    await this.commit(args.runId, () => {
      const fresh = this.runs.get(args.runId)
      const p = fresh?.pausedAt
      if (!fresh || fresh.status !== "paused" || p?.kind !== "agentStop") {
        error = `workflow run ${args.runId} is not paused by a stop (it is ${fresh?.status ?? "gone"}${p ? `, on ${p.kind} ${p.nodeId}` : ""})`
        return
      }
      if (p.agentId !== args.agentId || (args.taskId && p.taskId && p.taskId !== args.taskId)) {
        error = `workflow run ${args.runId} is paused at step "${p.nodeId}" of ${p.agentId}, not at this task`
        return
      }
      nodeId = p.nodeId
      const at = new Date().toISOString()
      // The `resumed` entry carries the note: the step's handler reads it
      // from the step's newest entry, so only the re-entering turn uses it.
      this.runs.recordExecution({
        runId: fresh.id,
        entry: {
          at, nodeId, inputKeys: [], status: "resumed", output: { resumeNote: args.note },
          idempotencyKey: idempotencyKey(fresh.id, nodeId, `signal-resumed:${args.taskId ?? at}`),
          note: `resumed by ${args.by}`.slice(0, 200),
        },
        nextPending: [nodeId, ...fresh.pending.filter((x) => x !== nodeId)],
        status: "running",
        pausedAt: null,
      })
      this.emitRunEvent({ runId: fresh.id, workflowId: wf.id, nodeId, phase: "resumed", status: "running", note: `signal:resume by ${args.by}`, rootId: fresh.eventRootId })
    })
    if (error) return { ok: false, error }
    this.log(`[workflow:${wf.id}] run ${args.runId} resumed at step "${nodeId}" by ${args.by}`)
    void this.walk(wf, args.runId, `signal-resume:${args.taskId ?? Date.now()}`)
      .catch((e: any) => this.log(`[workflow:${wf.id}] walk after resume failed: ${e.message}`))
    return { ok: true, nodeId }
  }

  /** The owner stops a run (CLI, dashboard). */
  async cancelRun(runId: string, reason = "canceled by the owner"): Promise<boolean> {
    let done = false
    await this.commit(runId, () => {
      const fresh = this.runs.get(runId)
      if (!fresh || TERMINAL.has(fresh.status)) return
      const nodeId = fresh.pausedAt?.nodeId ?? fresh.pending[0] ?? "run"
      this.timers.cancel({ runId })
      this.runs.recordExecution({ runId, entry: { at: new Date().toISOString(), nodeId, inputKeys: [], status: "skipped", idempotencyKey: idempotencyKey(runId, nodeId, `cancel:${Date.now()}`), note: reason.slice(0, 200) }, nextPending: [], status: "canceled", pausedAt: null })
      done = true
    })
    if (done) await this.settle(runId)
    return done
  }

  /** Resume a paused follow-up step on `port`. Inside a commit. Returns
   *  true when there is a next step to walk. A step that ended on a port
   *  with nowhere to go stops the run (the summary says why). */
  private resumeOn(wf: Workflow, run: WorkflowRun, nodeId: string, output: Record<string, unknown>, port: string | undefined, key: string, note: string): boolean {
    const node = findNode(wf, nodeId)
    const { nextPending } = node ? nextNodes({ workflow: wf, fromNodeId: nodeId, selectedPort: port }) : { nextPending: [] as string[] }
    const ports = node ? FOLLOW_UP_PORTS[node.type] : undefined
    const dead = !!ports && port !== undefined && port !== ports.main && nextPending.length === 0
    const pending = [...run.pending.filter((x) => x !== nodeId), ...nextPending]
    this.runs.recordExecution({
      runId: run.id,
      entry: { at: new Date().toISOString(), nodeId, inputKeys: [], status: dead ? "failed" : "resumed", output: port ? { ...output, port } : output, idempotencyKey: key, note: dead ? `stopped: ${note}` : note },
      nextPending: dead ? [] : pending,
      status: dead ? "failed" : "running",
      pausedAt: null,
      context: { ...run.context, [nodeId]: port ? { ...output, port } : output },
    })
    this.emitRunEvent({ runId: run.id, workflowId: wf.id, nodeId, phase: dead ? "failed" : "resumed", status: dead ? "failed" : "running", note, rootId: run.eventRootId })
    return !dead
  }

  /** Reminders, deadlines and nudges. */
  private async followUpTimer(wf: Workflow, t: TimerRecord): Promise<void> {
    // Filled inside the commit, acted on after it.
    const after: {
      nudge?: { agentId: string; text: string }
      reminder?: { to: "person"; msg: { channel: string; chatId: string; accountId?: string; text: string } } | { to: "owner"; text: string }
      walk?: boolean
    } = {}
    await this.commit(t.runId, () => {
      const fresh = this.runs.get(t.runId)
      const p = fresh?.pausedAt
      if (!fresh || fresh.status !== "paused" || !p || p.nodeId !== t.nodeId) return
      const now = Date.now()
      const at = new Date(now).toISOString()
      if (p.kind === "replyWait") {
        if (now >= Date.parse(p.deadline)) {
          after.walk = this.resumeOn(wf, fresh, p.nodeId, { timedOut: true, reminders: p.reminders, deadline: p.deadline }, "timeout", idempotencyKey(fresh.id, p.nodeId, `deadline:${p.deadline}`), "no reply before the deadline")
          return
        }
        if (!p.nextRemindAt || now < Date.parse(p.nextRemindAt) || p.reminders >= p.maxReminders) { this.scheduleWake(fresh.id, wf.id, p); return }
        const n = p.reminders + 1
        const next: PausedAt = { ...p, reminders: n, ...(n < p.maxReminders && p.remindEveryMs ? { nextRemindAt: new Date(now + p.remindEveryMs).toISOString() } : { nextRemindAt: undefined }) }
        const sent = p.reminds ? fresh.context[p.reminds] as { text?: unknown } | undefined : undefined
        const reminder: NonNullable<typeof after.reminder> = sent && typeof sent.text === "string" && sent.text
          ? { to: "person", msg: { channel: p.channel, chatId: p.chatId, ...(p.accountId ? { accountId: p.accountId } : {}), text: `Reminder: ${sent.text}` } }
          : { to: "owner", text: `Still waiting for a reply on ${p.channel} (${p.chatId}) for step "${p.nodeId}" of ${fresh.meta?.title ? `"${fresh.meta.title}"` : `workflow ${wf.id}`}. Deadline: ${p.deadline.slice(0, 16).replace("T", " ")} UTC.` }
        this.runs.recordExecution({ runId: fresh.id, entry: { at, nodeId: p.nodeId, inputKeys: [], status: "paused", idempotencyKey: idempotencyKey(fresh.id, p.nodeId, `remind:${n}`), note: `reminder ${n}/${p.maxReminders} to ${reminder.to}` }, nextPending: fresh.pending, status: "paused", pausedAt: next })
        this.scheduleWake(fresh.id, wf.id, next)
        after.reminder = reminder
        return
      }
      if (p.kind === "agentStep") {
        if (p.blocked || !p.nextNudgeAt) return
        if (now < Date.parse(p.nextNudgeAt)) { this.scheduleWake(fresh.id, wf.id, p); return }
        if (p.nudges >= p.maxNudges) {
          this.blockStep(wf, fresh, p, p.maxNudges ? `no progress after ${p.maxNudges} reminder(s) to ${p.agentId}` : `no progress from ${p.agentId} for ${Math.round(p.stallMs / 60_000)} minute(s)`)
          return
        }
        const n = p.nudges + 1
        const next: PausedAt = { ...p, nudges: n, nextNudgeAt: new Date(now + p.stallMs).toISOString() }
        this.runs.recordExecution({ runId: fresh.id, entry: { at, nodeId: p.nodeId, inputKeys: [], status: "paused", idempotencyKey: idempotencyKey(fresh.id, p.nodeId, `nudge:${n}`), note: `nudge ${n}/${p.maxNudges} to ${p.agentId}` }, nextPending: fresh.pending, status: "paused", pausedAt: next })
        this.scheduleWake(fresh.id, wf.id, next)
        after.nudge = { agentId: p.agentId, text: nudgeText(fresh, p.nodeId, n, p.maxNudges, p.stallMs * n) }
        this.log(`[workflow:${wf.id}] run ${fresh.id}: nudge ${n}/${p.maxNudges} to ${p.agentId} on step "${p.nodeId}"`)
      }
    })
    if (after.walk) { void this.walk(wf, t.runId, `timer:${t.id}`).catch((e: any) => this.log(`[workflow:${wf.id}] walk after deadline failed: ${e.message}`)); return }
    await this.settle(t.runId)
    const r = after.reminder
    if (r?.to === "person") {
      const res = await deliver({ channels: this.channels, forwardChannelSend: this.forwarder?.forwardChannelSend?.bind(this.forwarder) }, r.msg)
      if ("error" in res) this.log(`[workflow:${wf.id}] run ${t.runId}: reminder not sent: ${res.error}`)
    } else if (r?.to === "owner") {
      const run = this.runs.get(t.runId)
      if (run) await this.owner?.notify(r.text, run).catch((e: any) => this.log(`[workflow:${wf.id}] run ${t.runId}: reminder to the owner failed: ${e?.message ?? e}`))
    }
    const nd = after.nudge
    if (nd) {
      // Fire and forget: the turn may take minutes. What it says decides.
      void this.agents.execute({ agentId: nd.agentId, message: nd.text, workflowRunId: t.runId })
        .then(async (resp) => {
          if (resp.error) { this.log(`[workflow:${wf.id}] run ${t.runId}: nudge turn on ${nd.agentId} failed: ${resp.error}`); return }
          const token = parseResultToken(resp.content).result
          const verdict = stepVerdict(token)
          if (verdict === "blocked") await this.stepDone({ runId: t.runId, nodeId: t.nodeId, blocked: lastLine(resp.content) || `${nd.agentId} says the step is ${token}` })
          else if (verdict === "done") await this.stepDone({ runId: t.runId, nodeId: t.nodeId, output: { reply: resp.content, result: token, via: "nudge" } })
        })
        .catch((e: any) => this.log(`[workflow:${wf.id}] run ${t.runId}: nudge turn failed: ${e?.message ?? e}`))
    }
  }

  /** Inside a commit: the agent step can't go on without the owner. */
  private blockStep(wf: Workflow, run: WorkflowRun, p: Extract<PausedAt, { kind: "agentStep" }>, reason: string): void {
    const next: PausedAt = { ...p, blocked: reason.slice(0, 300), nextNudgeAt: undefined }
    this.timers.cancel({ cancelKey: `${run.id}:${p.nodeId}` })
    this.runs.recordExecution({ runId: run.id, entry: { at: new Date().toISOString(), nodeId: p.nodeId, inputKeys: [], status: "paused", idempotencyKey: idempotencyKey(run.id, p.nodeId, `blocked:${Date.now()}`), note: `blocked: ${reason}`.slice(0, 200) }, nextPending: run.pending, status: "paused", pausedAt: next })
    this.markBlocked(run.id, wf, p.nodeId, reason)
  }

  /** Record the block and tell the owner once. */
  private markBlocked(runId: string, wf: Workflow, nodeId: string, reason: string): void {
    const run = this.runs.setMeta(runId, { blocked: { nodeId, reason: reason.slice(0, 300), at: new Date().toISOString() } })
    this.log(`[workflow:${wf.id}] run ${runId} blocked on "${nodeId}": ${reason}`)
    if (!run || !this.onBlocked) return
    void Promise.resolve(this.onBlocked(run, wf, nodeId, reason)).catch((e: any) => this.log(`[workflow:${wf.id}] blocked notice failed: ${e?.message ?? e}`))
  }

  private noteReplyWaiter(runId: string, channel: string): void {
    if (!this.replyWaiters) return
    if (!this.replyWaiters.has(channel)) this.replyWaiters.set(channel, new Set())
    this.replyWaiters.get(channel)!.add(runId)
  }

  /** Schedule the timer for a follow-up pause's next moment. */
  private scheduleWake(runId: string, workflowId: string, p: PausedAt): void {
    if (p.kind === "replyWait") this.noteReplyWaiter(runId, p.channel)
    const at = nextWakeAt(p)
    if (!at) return
    try {
      this.timers.cancel({ cancelKey: `${runId}:${p.nodeId}` })
      this.timers.schedule({ runId, workflowId, nodeId: p.nodeId, fireAt: at, cancelKey: `${runId}:${p.nodeId}` })
    } catch (e: any) {
      this.log(`[workflow:${workflowId}] timer schedule failed: ${e.message}`)
    }
  }

  /** After a walk or a resume: a follow-up run that ran out of steps is
   *  complete, and a run that ended gets its one summary. */
  private async settle(runId: string): Promise<void> {
    let run = this.runs.get(runId)
    if (!run?.meta?.followUp) return
    if (run.status === "running" && run.pending.length === 0) run = this.runs.setStatus(runId, "completed") ?? run
    if (!TERMINAL.has(run.status) || run.meta?.endNotifiedAt) return
    run = this.runs.setMeta(runId, { endNotifiedAt: new Date().toISOString() }) ?? run
    this.timers.cancel({ runId })
    this.emitRunEvent({ runId, workflowId: run.workflowId, phase: "ended", status: run.status, rootId: run.eventRootId })
    if (!this.onRunEnded) return
    try { await this.onRunEnded(run, this.store.get(run.workflowId)) }
    catch (e: any) { this.log(`[workflow:${run.workflowId}] end notice for ${runId} failed: ${e?.message ?? e}`) }
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
      this.emitRunEvent({ runId: parent.id, workflowId: parentWf.id, nodeId: args.parentNodeId, phase: "resumed", status: "running", note: `child:${args.childRun.id}`, rootId: parent.eventRootId })
    })
    void this.walk(parentWf, args.parentRunId, `child:${args.childRun.id}`)
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
 *  ids drift between formats (raw digits "10000000000", JID
 *  "10000000000@s.whatsapp.net", group JID "...-...@g.us", and human-formatted
 *  "+216 00 000 000") depending on whether they came from the adapter's
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

/** The last line of a reply that is not the RESULT token. */
function lastLine(text: string | undefined): string {
  if (!text) return ""
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^RESULT:/i.test(l))
  return (lines.at(-1) ?? "").slice(0, 300)
}

export { idempotencyKey } from "./run-store"
