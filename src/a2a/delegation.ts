// --- Delegation with a callback, for work a person started (#277) ---
//
// When a person asks agent A something and A hands part of it to agent B,
// A must not sit on the person's turn until B finishes. Instead:
//
//   1. start()     B's run is launched in the background (a local
//                  registry.execute, or mesh.sendTask to a peer). A gets a
//                  task id back at once, tells the person who it asked,
//                  and ends its turn.
//   2. complete()  B's answer (or error, or timeout) is recorded once per
//                  task id. Later copies are dropped.
//   3. callback    A gets a new turn in the SAME (agent, channel, chatId)
//                  session, carrying B's answer. A's reply to that turn is
//                  sent to the person on the original channel.
//
// Nothing here is a second queue. B runs through the registry or the mesh
// exactly as a synchronous delegation would; the callback turn is an
// ordinary registry.execute on A's session. The only state kept is a
// small start/done log per task id, so a restart can tell the person that
// a delegation was lost instead of saying nothing.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"
import { randomBytes } from "crypto"
import { HUMAN_CHANNELS, isHumanFacingTurn, isInsideDelegation, rootInitiatorOf, type RootInitiator } from "./initiator"
import { isQueued } from "@/agents/queued"
import { taskTypeOf } from "@/watchers/due"
import { normalizeHome } from "./home"

export type DelegationStatus = "done" | "error" | "timeout" | "lost"

/** The caller's running turn, as the daemon resolved it. */
export interface CallerTurn {
  agentId: string
  /** RunningTask id, when known. */
  taskId?: string
  context: Record<string, unknown>
}

/** Where the callback turn runs and the reply goes: the caller's own chat. */
export interface DelegationOrigin {
  channel: string
  chatId: string
  group?: string
  accountId?: string
  channelMeta?: unknown
  runbookPath?: string
  runbookFiles?: string[]
}

export interface DelegationRecord {
  id: string
  caller: string
  callee: string
  /** Mesh peer name; absent for an agent on this node. */
  peer?: string
  /** The request, clipped. Shown back to the caller in the callback. */
  request: string
  origin: DelegationOrigin
  root: RootInitiator
  startedAt: number
  /** The caller's task type (`context.taskType`), which picks the evidence
   *  a watcher's done needs (watchers, #1049). */
  taskType?: string
  /** "send": an agent's send_agent from a turn no person is waiting on.
   *  Its answer goes back to the asking agent's own chat (#1100). Absent:
   *  a delegation a person started. */
  kind?: "send"
  /** How many callback turns led to the asking turn. Bounded, so two
   *  agents cannot call each other back forever. */
  depth?: number
  /** The issue or merge request it is about, in comparable form (#1100). */
  home?: string
}

export interface DelegationResult {
  status: DelegationStatus
  text: string
}

export interface InjectedTurn {
  agentId: string
  message: string
  context: Record<string, unknown>
}

export interface DelegationDeps {
  /** Run the callee on this node. `onStart` gets the running task id. */
  runLocal(
    callee: string,
    message: string,
    context: Record<string, unknown>,
    opts: {
      timeoutMs: number
      onStart: (runId: string) => void
      extras?: Record<string, unknown>
      /** Continue the callee's session from this chat of its own, the
       *  last run on the same home (#1100), instead of a fresh one. */
      resumeFrom?: Array<{ channel: string; chatId: string }>
    },
  ): Promise<{ content: string; error?: string }>
  /** Run the callee on a mesh peer and return its answer text. */
  runPeer(
    peer: string,
    callee: string,
    message: string,
    context: Record<string, unknown>,
    opts: { timeoutMs: number; senderAgentId: string },
  ): Promise<string>
  /** Stop a local callee run that went past the timeout. */
  cancelLocal?(runId: string, reason: string): void
  /** Run one turn for the caller (registry.execute). */
  injectTurn(turn: InjectedTurn): Promise<{ content: string; error?: string }>
  /** True while the caller is mid-turn on this chat. */
  isChatBusy(agentId: string, channel: string, chatId: string): boolean
  /** Can a reply on this channel reach the person? */
  canDeliver(channel: string): boolean
  /** Send the caller's reply to the person. `record` asks for it to be
   *  added to the session too (only for text the turn itself did not
   *  produce). `taskId` and `outcome` let a channel that keeps its own
   *  thread (the phone app) file the reply under the right delegation. */
  deliver(msg: {
    channel: string
    chatId: string
    text: string
    agentId: string
    accountId?: string
    record: boolean
    taskId: string
    /** "error" when the reply is the plain report of a failed delegation. */
    outcome: "done" | "error"
  }): Promise<void>
  log(msg: string): void
  /** Told when a delegation starts and how it ends (open requests, #356).
   *  Errors thrown here are the listener's to handle. */
  onStarted?(record: DelegationRecord): void
  onDone?(record: DelegationRecord, result: DelegationResult): void
  /** A line added to the callback message, e.g. how to close the open
   *  request this delegation belongs to. */
  callbackNote?(record: DelegationRecord, result: DelegationResult): string | undefined
  /** The callback turn was stopped by a restart and its one re-run failed
   *  too: the person got the short notice; note it on the open request.
   *  Errors thrown here are the listener's to handle. */
  onRelayFailed?(record: DelegationRecord, result: DelegationResult, reason: string): void
  /** Default true: a callback turn a restart stopped before it answered
   *  (`registry-stop`, empty reply) runs once more after the next start. */
  requeueRelayOnRestart?: boolean
  /** Upper bound for one delegation, start to answer. */
  timeoutMs: number
  /** Default true: a person-started delegation goes async on its own. */
  asyncWhenHuman?: boolean
  /** How long a callback waits for the caller's chat to be free. */
  busyWaitMs?: number
  pollMs?: number
  /** How long after a callee's run on a home ended a new delegation on
   *  that home still continues its session (#1100). Default 12 h. */
  sameHomeMs?: number
  /** start/done log; omit to keep state in memory only (tests). */
  logPath?: string
  now?: () => number
}

/** How every callback message starts. A turn whose message starts with
 *  this is the relay of a delegation's result to the person. */
export const DELEGATION_RESULT_MARKER = "[agentx:delegation-result"

/** Is this turn message the relay of a delegation result? */
export function isDelegationRelay(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(DELEGATION_RESULT_MARKER)
}

/** Did a restart stop this turn before it answered? The process registry
 *  stops every live turn with the reason `registry-stop` on shutdown.
 *  Such a relay is re-run once (retro:01M4BZCSM8P9NSFBR2BC2JAJHH, #846). */
export function stoppedByRestart(resp: { content: string; error?: string }): boolean {
  return !!resp.error && /\bregistry-stop\b/.test(resp.error) && resp.content.trim().length === 0
}

/** A send from a callback turn this many hops deep is not called back
 *  again: it goes out as a plain send (#1100). */
export const MAX_SEND_DEPTH = 4

/** How many called-back hops led to this turn: a callback turn carries it
 *  in `delegation.depth`, the callee of a send in `sendDepth`. */
export function callbackDepthOf(ctx: Record<string, unknown> | undefined | null): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  return Math.max(n((ctx?.delegation as { depth?: unknown } | undefined)?.depth), n(ctx?.sendDepth))
}

/** The delegation a callee's chat belongs to (`a2a:<caller>:<callee>:<dlg-id>`). */
export function delegationIdOfChat(chatId: string | undefined | null): string | null {
  const m = typeof chatId === "string" ? /^a2a:[^:]+:[^:]+:(dlg-[A-Za-z0-9-]+)$/.exec(chatId) : null
  return m ? m[1] : null
}

const REQUEST_CLIP = 500
const RESULT_CLIP = 12_000
/** Finished task ids remembered for duplicate suppression, in memory and
 *  in the compacted log alike. */
export const MAX_DONE_IDS = 2000
/** Log lines appended between compactions while the daemon runs. */
const COMPACT_EVERY = 500

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

/** The parts of the caller's context the callback turn needs. Bulky or
 *  one-off fields (history, media, reply-to text) stay behind. */
export function originOf(ctx: Record<string, unknown>): DelegationOrigin | null {
  const channel = typeof ctx.channel === "string" ? ctx.channel : ""
  const chatId = typeof ctx.chatId === "string" && ctx.chatId
    ? ctx.chatId
    : typeof ctx.group === "string" ? ctx.group : ""
  if (!channel || !chatId) return null
  const o: DelegationOrigin = { channel, chatId }
  if (typeof ctx.group === "string") o.group = ctx.group
  if (typeof ctx.accountId === "string") o.accountId = ctx.accountId
  if (ctx.channelMeta && typeof ctx.channelMeta === "object") o.channelMeta = ctx.channelMeta
  if (typeof ctx.runbookPath === "string") o.runbookPath = ctx.runbookPath
  if (Array.isArray(ctx.runbookFiles)) o.runbookFiles = ctx.runbookFiles.filter((f): f is string => typeof f === "string")
  return o
}

/** The message the caller receives as its new turn. `reply`: the callee
 *  wrote to the caller itself while it works, rather than ending its run.
 *  `wrote`: this is the end of a run that already wrote to the caller. */
export function buildCallbackMessage(rec: DelegationRecord, result: DelegationResult, opts: { reply?: boolean; wrote?: boolean } = {}): string {
  const who = rec.peer ? `${rec.callee} on ${rec.peer}` : rec.callee
  const outcome = opts.reply ? `answered (${rec.callee} sent this to you itself)` : {
    done: "finished",
    error: "failed",
    timeout: "did not answer in time",
    lost: "was lost (this machine restarted before the answer came back)",
  }[result.status]
  const ok = result.status === "done"
  // A send no person waits on: the asking agent acts on the answer here,
  // in the conversation the ask came from (#1100).
  const next = rec.kind === "send"
    ? ok
      ? "Act on it here, in the work you asked for it: carry on, or pass it to whoever waits on it. Nothing is sent anywhere unless you send it."
      : `Decide now, in this conversation, and do one: resume it (ask ${rec.callee} again and say what is already done), split it into smaller asks, or drop it and tell whoever waits on it. Do not leave it unsaid.`
    : ok
      ? "Tell the person what came back, in your own words, and act on it if they asked you to."
      : "Tell the person it did not work and what they can do next. Do not retry on your own unless they asked you to."
  return [
    `${DELEGATION_RESULT_MARKER} task=${rec.id} from=${rec.callee}${rec.peer ? ` peer=${rec.peer}` : ""} status=${opts.reply ? "reply" : result.status}]`,
    `Earlier in this conversation you asked ${who} to help. That work ${outcome}.`,
    ...(opts.wrote ? [`${rec.callee} already wrote to you during the work; this is how its run ended. Do not act twice on what it already told you.`] : []),
    "",
    "What you asked:",
    rec.request,
    "",
    ok ? `${who} answered:` : "Details:",
    clip(result.text, RESULT_CLIP),
    "",
    next,
  ].join("\n")
}

/** What the person sees when the caller could not write its own summary. */
export function fallbackReply(rec: DelegationRecord, result: DelegationResult): string {
  const who = rec.peer ? `${rec.callee} on ${rec.peer}` : rec.callee
  if (result.status === "done") return `${who} finished:\n\n${clip(result.text, 3500)}`
  return `The request to ${who} did not complete (${result.status}): ${clip(result.text, 500)}`
}

/** What the person sees when the callback turn was stopped by a restart
 *  and its one re-run did not answer either. */
export function relayFailureNotice(rec: DelegationRecord, result: DelegationResult): string {
  const who = rec.peer ? `${rec.callee} on ${rec.peer}` : rec.callee
  return `${rec.caller} could not pass on the answer from ${who} (${result.status}) because of a restart. Ask ${rec.caller} for it again. Ref: ${rec.id}`
}

/** A callback turn a restart stopped, waiting for its one re-run. */
interface HeldRelay {
  record: DelegationRecord
  result: DelegationResult
  /** 1: stopped once, re-run on the next start. 2: the re-run has begun;
   *  if it is stopped too, the next start sends the notice instead. */
  attempt: number
  /** It passed on a message the callee wrote (relayReply), not its end. */
  reply?: boolean
}

type LogLine =
  | ({ type: "start"; ts: number } & DelegationRecord)
  | { type: "done"; id: string; status: DelegationStatus; ts: number }
  | ({ type: "relay"; id: string; ts: number } & HeldRelay)
  | { type: "relayed"; id: string; ts: number }

export class DelegationManager {
  private pendingById = new Map<string, DelegationRecord>()
  /** Finished task id → how it ended, oldest first. */
  private doneIds = new Map<string, DelegationStatus>()
  private appendsSinceCompact = 0
  private recent: Array<{ id: string; caller: string; callee: string; peer?: string; status: DelegationStatus | "running"; startedAt: number; endedAt?: number; origin?: DelegationOrigin }> = []
  /** One callback at a time per caller chat, in completion order. */
  private chains = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private localRuns = new Map<string, string>()
  /** Callback turns a restart stopped, by task id (see HeldRelay). */
  private heldRelays = new Map<string, HeldRelay>()
  /** Delegations whose callee already wrote to the caller (relayReply):
   *  their plain end is not called back a second time. */
  private answered = new Set<string>()
  /** Per callee and home (#1100): the chat of its last run there, and
   *  that run while it is still going. In memory: a restart starts over. */
  private homes = new Map<string, { chats: Array<{ channel: string; chatId: string }>; taskId: string; running: Promise<void> | null; endedAt: number | null }>()
  /** Callee chats with a same-home run going right now: never continued. */
  private busyChats = new Set<string>()
  private readonly now: () => number

  constructor(private deps: DelegationDeps) {
    this.now = deps.now ?? Date.now
    if (deps.logPath) this.load(deps.logPath)
  }

  /**
   * Decide whether a delegation from this caller turn goes the callback
   * way. `asyncFlag` is the request's own `async` field: false always
   * keeps it synchronous, true asks for a callback from a root turn that
   * is not a person's (a cron, say), and absent means "only when a person
   * started it". Inside a delegation nothing goes async, whatever the
   * flag: a delegated hop has a caller waiting on its answer, and a
   * callback turn must not start a chain of callbacks.
   */
  shouldCallback(caller: CallerTurn | null, asyncFlag?: boolean): boolean {
    if (asyncFlag === false || !caller) return false
    if (isInsideDelegation(caller.context)) return false
    if (!originOf(caller.context)) return false
    if (asyncFlag === true) return true
    if (this.deps.asyncWhenHuman === false) return false
    return isHumanFacingTurn(caller.context) && this.deps.canDeliver(String(caller.context.channel))
  }

  /**
   * An agent's send_agent that `shouldCallback` turned down (#1100): no
   * person waits on it, but the asking agent does. Its answer, failure or
   * timeout comes back as a turn in the asking agent's own chat, instead
   * of only into a log. Inside a delegation too: that turn's chat is
   * where its work lives. Not past MAX_SEND_DEPTH callback hops.
   */
  shouldCallbackSend(caller: CallerTurn | null): boolean {
    const origin = caller ? originOf(caller.context) : null
    if (!caller || !origin) return false
    // Never from a person's chat (a callback or watcher turn there): what
    // the agent says to the answer is for its work, not for the person,
    // and a reply, a fallback or a queue flush there would reach them.
    if (HUMAN_CHANNELS.has(origin.channel) || this.deps.canDeliver(origin.channel)) return false
    return callbackDepthOf(caller.context) < MAX_SEND_DEPTH
  }

  /** The pending delegation a callee's message to its caller answers:
   *  the callee writes from the delegation's own chat, to the agent that
   *  asked. Null for anything else. Local callees only. */
  replyTarget(from: { agentId?: string; chatId?: string }, to: string): DelegationRecord | null {
    const id = delegationIdOfChat(from.chatId)
    const rec = id ? this.pendingById.get(id) : undefined
    // Only an agent's send: a delegation a person started keeps its own
    // way back to that person.
    if (!rec || rec.kind !== "send" || rec.peer || rec.callee !== from.agentId || rec.caller !== to) return null
    return rec
  }

  /** The callee wrote to its caller while it works: that message goes to
   *  the caller's chat for this delegation, as a callback turn. The
   *  delegation's own end is still called back: what the callee wrote may
   *  only have been a progress note. */
  relayReply(rec: DelegationRecord, text: string): void {
    this.answered.add(rec.id)
    this.deps.log(`[delegation ${rec.id}] ${rec.callee} wrote to ${rec.caller}; passed to ${rec.origin.channel}:${rec.origin.chatId}`)
    void this.enqueue(rec, () => this.callback(rec, { status: "done", text }, 1, true))
  }

  /** Launch the callee in the background and return its task id. */
  start(opts: {
    caller: CallerTurn
    callee: string
    peer?: string
    message: string
    /** Context for the callee's run; a2a defaults fill the gaps. */
    calleeContext?: Record<string, unknown>
    /** Passed to runLocal untouched (e.g. the intent-ledger ref). */
    extras?: Record<string, unknown>
    /** "send": see shouldCallbackSend. */
    kind?: "send"
    /** Upper bound for this one, instead of the default. */
    timeoutMs?: number
    /** The issue or merge request the work is about (#1100). A local
     *  callee already on the same home finishes first; this one then
     *  resumes that session instead of starting beside it. */
    home?: string
  }): { taskId: string; record: DelegationRecord } {
    const origin = originOf(opts.caller.context)
    if (!origin) throw new Error("caller turn has no channel/chatId to call back to")
    const id = `dlg-${this.now().toString(36)}-${randomBytes(4).toString("hex")}`
    const root = rootInitiatorOf(opts.caller.context as any, opts.caller.agentId)
    const taskType = taskTypeOf(opts.calleeContext)
    const depth = callbackDepthOf(opts.caller.context)
    const home = normalizeHome(opts.home)
    const record: DelegationRecord = {
      id,
      caller: opts.caller.agentId,
      callee: opts.callee,
      ...(opts.peer ? { peer: opts.peer } : {}),
      request: clip(opts.message, REQUEST_CLIP),
      origin,
      root,
      startedAt: this.now(),
      ...(taskType ? { taskType } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(depth ? { depth } : {}),
      ...(home ? { home } : {}),
    }
    this.pendingById.set(id, record)
    this.remember({ id, caller: record.caller, callee: record.callee, peer: record.peer, status: "running", startedAt: record.startedAt, origin })
    this.append({ type: "start", ts: record.startedAt, ...record })
    try { this.deps.onStarted?.(record) } catch { /* a listener never stops a delegation */ }

    const calleeContext: Record<string, unknown> = {
      channel: "a2a",
      chatId: `a2a:${record.caller}:${record.callee}:${id}`,
      sender: `agent:${record.caller}`,
      ...(opts.calleeContext ?? {}),
      // The root always travels, and always as computed here: a caller
      // cannot claim a different origin for work it hands on.
      initiator: root,
      // The callee's own sends count on from here (MAX_SEND_DEPTH).
      ...(record.kind === "send" ? { sendDepth: depth + 1 } : {}),
      ...(home ? { home } : {}),
    }
    const who = record.peer ? `${record.callee}@${record.peer}` : record.callee
    this.deps.log(`[delegation ${id}] ${record.caller} -> ${who} started (root=${root.kind}:${root.channel}, callback to ${origin.channel}:${origin.chatId})`)

    // One session per piece of work (#1100): the callee's run on the same
    // home, still going or recent, is the session this one continues.
    const homeKey = home && !record.peer ? `${record.callee}\u0000${home}` : null
    const prior = homeKey ? this.sameHome(homeKey) : null
    const calleeChat = { channel: String(calleeContext.channel), chatId: String(calleeContext.chatId) }
    // Newest first: a run that failed before it saved a session falls back
    // to the one before it. Read when it launches: while any earlier run on
    // the home is still going (one this delegation stopped waiting for), it
    // starts fresh instead, since that run may be writing the very session
    // an older chat names. No two runs write one session.
    const chatKeyOf = (c: { channel: string; chatId: string }) => `${record.callee}\u0000${c.channel}\u0000${c.chatId}`
    const resumable = () => {
      const chats = prior?.chats ?? []
      if (chats.some((c) => this.busyChats.has(chatKeyOf(c)))) {
        this.deps.log(`[delegation ${id}] a run on ${home} is still going; starting a fresh session instead`)
        return []
      }
      return chats.filter((c) => !(c.channel === calleeChat.channel && c.chatId === calleeChat.chatId))
    }
    if (prior) {
      this.deps.log(`[delegation ${id}] ${record.callee} is on ${home} (${prior.taskId}); ${prior.running ? "waits for it, then " : ""}continues its session`)
    }

    const timeoutMs = opts.timeoutMs ?? this.deps.timeoutMs
    const launch = (): Promise<{ content: string; error?: string }> => {
      // Gone already (a restart reported it lost while it waited).
      if (!this.pendingById.has(id)) return Promise.resolve({ content: "", error: "no longer pending" })
      // The clock starts when the work does, not while it waits its turn.
      const timer = setTimeout(() => {
        const runId = this.localRuns.get(id)
        if (runId) {
          try { this.deps.cancelLocal?.(runId, `delegation ${id} timed out`) } catch { /* best effort */ }
        }
        void this.complete(id, { status: "timeout", text: `No answer from ${who} after ${Math.round(timeoutMs / 60_000) || 1} minute(s).` })
      }, timeoutMs)
      ;(timer as any).unref?.()
      this.timers.set(id, timer)
      if (record.peer) {
        return this.deps.runPeer(record.peer, record.callee, opts.message, calleeContext, { timeoutMs, senderAgentId: record.caller })
          .then((text) => ({ content: text } as { content: string; error?: string }))
      }
      const resumeFrom = resumable()
      const mine = chatKeyOf(calleeChat)
      if (homeKey) this.busyChats.add(mine)
      return this.deps.runLocal(record.callee, opts.message, calleeContext, {
        timeoutMs,
        onStart: (runId) => { this.localRuns.set(id, runId) },
        extras: opts.extras,
        ...(resumeFrom?.length ? { resumeFrom } : {}),
      }).finally(() => { this.busyChats.delete(mine) })
    }
    // The wait is bounded by this delegation's own time limit: a run ahead
    // that never settles (stuck before it started) does not hold it forever.
    const waitFor = prior?.running
      ? Promise.race([prior.running, new Promise<void>((r) => { const t = setTimeout(r, timeoutMs); (t as any).unref?.() })])
      : null
    const run = waitFor ? waitFor.then(launch) : launch()
    if (homeKey) {
      const running = run.then(() => undefined, () => undefined)
      this.homes.set(homeKey, { chats: [calleeChat, ...(prior?.chats ?? [])].slice(0, 3), taskId: id, running, endedAt: null })
      void running.then(() => {
        const h = this.homes.get(homeKey)
        if (h?.taskId === id) { h.running = null; h.endedAt = this.now() }
      })
    }
    run
      .then((r) => this.complete(id, r.error
        ? { status: "error", text: r.error }
        : { status: "done", text: r.content || "(empty answer)" }))
      .catch((e: any) => this.complete(id, { status: "error", text: e?.message ?? String(e) }))

    return { taskId: id, record }
  }

  /**
   * Record the outcome of a delegation and call the caller back. Returns
   * false for a task id that is unknown or already completed: the first
   * outcome wins, later ones (a late answer after a timeout, a retried
   * delivery) are dropped.
   */
  async complete(id: string, result: DelegationResult): Promise<boolean> {
    const rec = this.pendingById.get(id)
    if (!rec) {
      if (this.doneIds.has(id)) this.deps.log(`[delegation ${id}] duplicate ${result.status} suppressed`)
      else this.deps.log(`[delegation ${id}] ${result.status} for an unknown task ignored`)
      return false
    }
    this.pendingById.delete(id)
    this.markDone(id, result.status)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.localRuns.delete(id)
    this.append({ type: "done", id, status: result.status, ts: this.now() })
    const entry = this.recent.find((r) => r.id === id)
    if (entry) { entry.status = result.status; entry.endedAt = this.now() }
    this.deps.log(`[delegation ${id}] ${rec.callee} ${result.status} after ${Math.round((this.now() - rec.startedAt) / 1000)}s`)
    try { this.deps.onDone?.(rec, result) } catch { /* a listener never stops a callback */ }

    // The callee already wrote to the caller (relayReply): its end still
    // comes back, said as such, since what it wrote may only have been a
    // progress note.
    const wrote = this.answered.delete(id)
    await this.enqueue(rec, () => this.callback(rec, result, 1, false, wrote))
    return true
  }

  /** One callback at a time per caller chat, in the order they come. */
  private enqueue(rec: DelegationRecord, run: () => Promise<void>): Promise<void> {
    const key = `${rec.caller}\u0000${rec.origin.channel}\u0000${rec.origin.chatId}`
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(run).catch((e: any) => {
      this.deps.log(`[delegation ${rec.id}] callback failed: ${e?.message ?? e}`)
    })
    this.chains.set(key, next)
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key) })
    return next
  }

  /** After a restart: every delegation that was started and never
   *  finished is reported to its caller as lost, and every callback turn
   *  the restart stopped runs once more (see requeueRelays). */
  async recover(): Promise<number> {
    const relays = this.requeueRelays()
    const lost = [...this.pendingById.values()]
    for (const rec of lost) {
      this.remember({ id: rec.id, caller: rec.caller, callee: rec.callee, peer: rec.peer, status: "running", startedAt: rec.startedAt, origin: rec.origin })
    }
    await Promise.all(lost.map((rec) => this.complete(rec.id, {
      status: "lost",
      text: "This machine restarted while the work was in progress, so its answer never came back.",
    })))
    await relays
    this.compact()
    return lost.length
  }

  /**
   * Callback turns the last restart stopped before they answered. Each
   * runs once more, at most once per task id: the re-run is written down
   * before it starts, so a re-run stopped by yet another restart is not
   * run a third time. That one, or a re-run that fails, gets the short
   * notice instead. Returns how many were re-run.
   */
  async requeueRelays(): Promise<number> {
    const held = [...this.heldRelays.values()]
    let rerun = 0
    await Promise.all(held.map((h) => {
      const rec = h.record
      if (h.attempt >= 2) {
        return this.enqueue(rec, () => this.relayFailed(rec, h.result, "its re-run was stopped by another restart"))
      }
      rerun++
      this.holdRelay({ ...h, attempt: 2 })
      this.deps.log(`[delegation ${rec.id}] re-running the callback to ${rec.caller} a restart stopped`)
      return this.enqueue(rec, () => this.callback(rec, h.result, 2, h.reply === true))
    }))
    return rerun
  }

  /** Recent delegations, newest first. Ids, agents and status only. */
  list(limit = 50): Array<{ id: string; caller: string; callee: string; peer?: string; status: string; startedAt: string; endedAt?: string }> {
    return this.recent.slice(-limit).reverse().map((r) => ({
      id: r.id,
      caller: r.caller,
      callee: r.callee,
      ...(r.peer ? { peer: r.peer } : {}),
      status: r.status,
      startedAt: new Date(r.startedAt).toISOString(),
      ...(r.endedAt ? { endedAt: new Date(r.endedAt).toISOString() } : {}),
    }))
  }

  isPending(id: string): boolean {
    return this.pendingById.has(id)
  }

  /** The callee's run on this home that a new one continues: still going,
   *  or ended within sameHomeMs. Old entries are dropped on the way. */
  private sameHome(key: string): { chats: Array<{ channel: string; chatId: string }>; taskId: string; running: Promise<void> | null } | null {
    const window = this.deps.sameHomeMs ?? 12 * 3_600_000
    const now = this.now()
    for (const [k, h] of this.homes) {
      if (h.endedAt !== null && now - h.endedAt > window) this.homes.delete(k)
    }
    return this.homes.get(key) ?? null
  }

  /** The asking agent and its chat for a delegation, running or recent:
   *  where news about that work belongs (#1100). */
  originFor(id: string): { caller: string; origin: DelegationOrigin } | null {
    const rec = this.pendingById.get(id)
    if (rec) return { caller: rec.caller, origin: rec.origin }
    const r = this.recent.find((e) => e.id === id)
    return r?.origin ? { caller: r.caller, origin: r.origin } : null
  }

  /** Stop timers (daemon shutdown, tests). Pending work stays in the log. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** `attempt` 2 is the one re-run of a callback a restart stopped. */
  private async callback(rec: DelegationRecord, result: DelegationResult, attempt = 1, reply = false, wrote = false): Promise<void> {
    const { channel, chatId } = rec.origin
    await this.waitUntilFree(rec.caller, channel, chatId)
    const context: Record<string, unknown> = {
      ...rec.origin,
      sender: `agent:${rec.callee}`,
      delegation: {
        taskId: rec.id, from: rec.callee, ...(rec.peer ? { peer: rec.peer } : {}), status: reply ? "reply" : result.status,
        // A send from this turn counts one hop more (MAX_SEND_DEPTH).
        depth: (rec.depth ?? 0) + 1,
      },
    }
    let resp: { content: string; error?: string }
    try {
      let note: string | undefined
      try { note = this.deps.callbackNote?.(rec, result) } catch { /* a listener never stops a callback */ }
      const base = buildCallbackMessage(rec, result, { reply, wrote })
      const message = note ? `${base}\n\n${note}` : base
      resp = await this.deps.injectTurn({ agentId: rec.caller, message, context })
    } catch (e: any) {
      resp = { content: "", error: e?.message ?? String(e) }
    }
    // A restart stopped the turn before it answered: the person would get
    // nothing (the channels are already down). Keep it for one re-run after
    // the next start; a re-run stopped too is told on the start after that.
    if (stoppedByRestart(resp) && (attempt > 1 || this.deps.requeueRelayOnRestart !== false)) {
      if (attempt === 1) {
        this.holdRelay({ record: rec, result, attempt: 1, ...(reply ? { reply } : {}) })
        this.deps.log(`[delegation ${rec.id}] callback to ${rec.caller} stopped by a restart; it runs once more after the next start`)
      } else {
        this.deps.log(`[delegation ${rec.id}] re-run of the callback to ${rec.caller} stopped by a restart too; the person is told after the next start`)
      }
      return
    }
    // The registry queued it behind other work; its flush replies on the
    // channel itself.
    if (isQueued(resp.error)) {
      this.deps.log(`[delegation ${rec.id}] callback queued behind other work for ${rec.caller}`)
      if (attempt > 1) this.releaseRelay(rec.id)
      return
    }
    const own = !resp.error && resp.content.trim().length > 0
    // An agent's send: the turn was the asking agent's own work. Nothing
    // goes to a person from here (its chat is an agent's anyway).
    if (rec.kind === "send") {
      if (attempt > 1) this.releaseRelay(rec.id)
      if (!own) this.deps.log(`[delegation ${rec.id}] ${rec.caller} gave no reply to the callback${resp.error ? `: ${resp.error}` : ""}`)
      return
    }
    if (attempt > 1) {
      if (!own) {
        await this.relayFailed(rec, result, `its re-run gave no reply${resp.error ? ` (${clip(resp.error, 200)})` : ""}`)
        return
      }
      this.releaseRelay(rec.id)
      this.deps.log(`[delegation ${rec.id}] re-run of the callback to ${rec.caller} answered`)
    }
    if (!own) this.deps.log(`[delegation ${rec.id}] ${rec.caller} gave no reply to the callback${resp.error ? `: ${resp.error}` : ""}; sending the plain result`)
    const text = own ? resp.content : fallbackReply(rec, result)
    if (!this.deps.canDeliver(channel)) {
      this.deps.log(`[delegation ${rec.id}] no route to ${channel}:${chatId}; the reply is in ${rec.caller}'s session only`)
      return
    }
    try {
      await this.deps.deliver({
        channel, chatId, text, agentId: rec.caller, accountId: rec.origin.accountId, record: !own,
        taskId: rec.id,
        outcome: own || result.status === "done" ? "done" : "error",
      })
      this.deps.log(`[delegation ${rec.id}] ${rec.caller} updated ${channel}:${chatId}`)
    } catch (e: any) {
      this.deps.log(`[delegation ${rec.id}] delivery to ${channel}:${chatId} failed: ${e?.message ?? e}`)
    }
  }

  /** The re-run did not answer: send the short notice to the person and
   *  note it on the open request. Never re-runs again. */
  private async relayFailed(rec: DelegationRecord, result: DelegationResult, reason: string): Promise<void> {
    this.releaseRelay(rec.id)
    this.deps.log(`[delegation ${rec.id}] callback to ${rec.caller} not relayed: ${reason}; telling the person`)
    try { this.deps.onRelayFailed?.(rec, result, reason) } catch { /* a listener never stops the notice */ }
    const { channel, chatId } = rec.origin
    // An agent's send has no person to tell (see callback).
    if (rec.kind === "send") return
    if (!this.deps.canDeliver(channel)) {
      this.deps.log(`[delegation ${rec.id}] no route to ${channel}:${chatId} for the notice`)
      return
    }
    try {
      await this.deps.deliver({
        channel, chatId, text: relayFailureNotice(rec, result), agentId: rec.caller, accountId: rec.origin.accountId,
        record: true, taskId: rec.id, outcome: "error",
      })
    } catch (e: any) {
      this.deps.log(`[delegation ${rec.id}] notice to ${channel}:${chatId} failed: ${e?.message ?? e}`)
    }
  }

  private holdRelay(h: HeldRelay): void {
    const held: HeldRelay = { record: h.record, result: { status: h.result.status, text: clip(h.result.text, RESULT_CLIP) }, attempt: h.attempt, ...(h.reply ? { reply: true } : {}) }
    this.heldRelays.set(h.record.id, held)
    this.append({ type: "relay", id: h.record.id, ts: this.now(), ...held })
  }

  private releaseRelay(id: string): void {
    if (!this.heldRelays.delete(id)) return
    this.append({ type: "relayed", id, ts: this.now() })
  }

  private async waitUntilFree(agentId: string, channel: string, chatId: string): Promise<void> {
    const maxWait = this.deps.busyWaitMs ?? 25 * 60_000
    const poll = this.deps.pollMs ?? 500
    const start = this.now()
    while (this.deps.isChatBusy(agentId, channel, chatId)) {
      if (this.now() - start > maxWait) {
        this.deps.log(`[delegation] ${agentId} still busy on ${channel}:${chatId} after ${Math.round(maxWait / 1000)}s; calling back anyway`)
        return
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  }

  private remember(entry: DelegationManager["recent"][number]): void {
    if (this.recent.some((r) => r.id === entry.id)) return
    this.recent.push(entry)
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200)
  }

  private markDone(id: string, status: DelegationStatus): void {
    this.doneIds.delete(id)
    this.doneIds.set(id, status)
    while (this.doneIds.size > MAX_DONE_IDS) {
      const first = this.doneIds.keys().next().value
      if (first === undefined) break
      this.doneIds.delete(first)
    }
  }

  private append(line: LogLine): void {
    const path = this.deps.logPath
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, JSON.stringify(line) + "\n")
    } catch (e: any) {
      this.deps.log(`[delegation] could not write ${path}: ${e?.message ?? e}`)
    }
    // Keep the file bounded while the daemon stays up, not only at boot.
    if (++this.appendsSinceCompact >= COMPACT_EVERY) this.compact()
  }

  private load(path: string): void {
    if (!existsSync(path)) return
    try {
      for (const raw of readFileSync(path, "utf-8").split("\n")) {
        if (!raw.trim()) continue
        let line: LogLine
        try { line = JSON.parse(raw) } catch { continue }
        if (line.type === "start" && typeof line.id === "string") {
          const { type: _t, ts: _ts, ...rec } = line
          if (!this.doneIds.has(rec.id)) this.pendingById.set(rec.id, rec as DelegationRecord)
        } else if (line.type === "done" && typeof line.id === "string") {
          this.pendingById.delete(line.id)
          this.markDone(line.id, typeof line.status === "string" ? line.status : "done")
        } else if (line.type === "relay" && typeof line.id === "string" && line.record && line.result) {
          this.heldRelays.set(line.id, { record: line.record, result: line.result, attempt: Number(line.attempt) || 1, ...(line.reply === true ? { reply: true } : {}) })
        } else if (line.type === "relayed" && typeof line.id === "string") {
          this.heldRelays.delete(line.id)
        }
      }
    } catch (e: any) {
      this.deps.log(`[delegation] could not read ${path}: ${e?.message ?? e}`)
    }
  }

  /** Keep the log small: only unfinished starts, the recent done ids
   *  (for duplicate suppression) and held callbacks are rewritten. */
  private compact(): void {
    this.appendsSinceCompact = 0
    const path = this.deps.logPath
    if (!path) return
    try {
      const ts = this.now()
      const lines: LogLine[] = [
        ...[...this.pendingById.values()].map((r) => ({ type: "start" as const, ts: r.startedAt, ...r })),
        ...[...this.doneIds].map(([id, status]) => ({ type: "done" as const, id, status, ts })),
        ...[...this.heldRelays].map(([id, h]) => ({ type: "relay" as const, id, ts, ...h })),
      ]
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""))
    } catch { /* best effort */ }
  }
}
