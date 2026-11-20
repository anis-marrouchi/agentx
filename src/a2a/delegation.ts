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
// ordinary registry.execute on A's session. The only state kept is one
// row per task id in the `handoffs` table of the jobs database
// (handoff-store.ts, #1861), so a restart can tell the person that a
// delegation was lost instead of saying nothing, and pass on once more an
// answer a restart kept from reaching them. The old
// `.agentx/a2a/delegations.jsonl` is no longer written (#1961): a node that
// still has one imports it into the table once at start and renames it
// (importDelegationLog in handoff-store.ts).

import { emitSignal } from "@/improve/signals"
import { randomBytes } from "crypto"
import { HUMAN_CHANNELS, isHumanFacingTurn, isInsideDelegation, rootInitiatorOf, type RootInitiator } from "./initiator"
import { isQueued } from "@/agents/queued"
import { taskTypeOf } from "@/agents/task-context"
import { normalizeHome } from "./home"
import { describeJobState, endStateInAnswer, stalledLine, type EndState } from "@/agents/run-state"
import type { HandoffStore } from "./handoff-store"

/** "waiting": the callee answered, but said its run ends to wait for
 *  something (a build, another agent, a time) before the work is done
 *  (#1100). It is not done. */
export type DelegationStatus = "done" | "waiting" | "error" | "timeout" | "lost"

/** What a callee said it waits for when its run ended (markWaiting). */
export interface Waiting {
  on: string
  dueAt?: number
}

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
  /** The caller's task type (`context.taskType`, #1049). */
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
  /** With status "waiting": what for, and until when. */
  waiting?: Waiting
  /** The job's state the callee's run ended with (agents/run-state.ts),
   *  when it gave one or was asked for one. The status follows it:
   *  continue is "waiting" (not finished), blocked and stalled are
   *  "error" (the caller decides what happens next). */
  state?: EndState
}

/** What a callee's run returned. */
export interface CalleeRun {
  content: string
  error?: string
  /** Set by the registry on a run it checked (local runs only). */
  jobState?: EndState
}

const dueOf = (v: string | undefined): number | undefined => {
  const t = v ? Date.parse(v.trim()) : NaN
  return Number.isFinite(t) && t > 0 ? t : undefined
}

/** The state line the registry put on the end of an answer. */
const STATE_TRAILER = /(?:^|\n+)[ \t]*\[job (?:state|stalled)\][^\n]*$/i

/** The answer with its state on the first line, where no clip cuts it. */
function stateFirst(text: string, callee: string, state: EndState): string {
  const line = state.state === "stalled" ? stalledLine(callee) : `[Job state] ${describeJobState(state)}`
  const body = text.trimEnd().replace(STATE_TRAILER, "").trim()
  return body && body !== "(empty answer)" ? `${line}\n\n${body}` : line
}

/**
 * The outcome of a delegation from how the callee's run ended. A run that
 * stated its job continues, waits or is blocked, or stated nothing even
 * when asked (stalled), is not "done" (#1861). `said`: what the run said
 * it waits for with agentx_waiting (markWaiting). `peer`: the answer came
 * back as text from another node, so its state is read from its last lines.
 */
export function resultOfRun(r: CalleeRun, o: { callee: string; said?: Waiting; peer?: boolean }): DelegationResult {
  if (r.error) return { status: "error", text: r.error }
  const text = r.content || "(empty answer)"
  const state = r.jobState ?? (o.peer ? endStateInAnswer(r.content) : null) ?? undefined
  if (o.said) return { status: "waiting", text, waiting: o.said, ...(state?.state === "waiting" ? { state } : {}) }
  if (!state) return { status: "done", text }
  switch (state.state) {
    // A long answer is clipped on its way back: keep the proof in sight.
    case "done": return { status: "done", text: text.length > FALLBACK_CLIP ? stateFirst(text, o.callee, state) : text, state }
    case "waiting": {
      const dueAt = dueOf(state.until)
      return { status: "waiting", text: stateFirst(text, o.callee, state), waiting: { on: clip(state.on, 300), ...(dueAt ? { dueAt } : {}) }, state }
    }
    case "continue": {
      const dueAt = dueOf(state.when)
      return { status: "waiting", text: stateFirst(text, o.callee, state), waiting: { on: clip(`${o.callee} to carry on: ${state.left}`, 300), ...(dueAt ? { dueAt } : {}) }, state }
    }
    default: return { status: "error", text: stateFirst(text, o.callee, state), state }
  }
}

const whenText = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

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
  ): Promise<CalleeRun>
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
    /** The caller's answer in the conversation (true), or a notice (#1892). */
    countsAsReply?: boolean
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
  /** The same for work with no home (#1749): a callee asked again from the
   *  same caller chat continues its last run from there. Default 2 h. */
  sameChatMs?: number
  /** How long a finished delegation's callback waits for the other
   *  delegations still running from the same caller chat, so their
   *  answers come back as one turn (#1749). Default 0: only answers
   *  already in are joined. */
  coalesceMs?: number
  /** The hand-off journal in the jobs database (#1861): what is still out
   *  and what callback is held are read back from it at start. Absent: a
   *  node with no database keeps hand-offs in memory only. */
  store?: HandoffStore | null
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

/** A /task body whose top-level `sendDepth` (a mesh peer's plain
 *  /send/agent, #1100) joins its `context`, where callbackDepthOf reads
 *  it. The larger count wins. Returns the context to use, or the body's own. */
export function contextWithSendDepth(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const ctx = body.context && typeof body.context === "object" ? body.context as Record<string, unknown> : undefined
  const top = callbackDepthOf({ sendDepth: body.sendDepth })
  if (!top || callbackDepthOf(ctx) >= top) return ctx
  return { ...(ctx ?? {}), sendDepth: top }
}

/** The delegation a callee's chat belongs to (`a2a:<caller>:<callee>:<dlg-id>`). */
export function delegationIdOfChat(chatId: string | undefined | null): string | null {
  const m = typeof chatId === "string" ? /^a2a:[^:]+:[^:]+:(dlg-[A-Za-z0-9-]+)$/.exec(chatId) : null
  return m ? m[1] : null
}

const REQUEST_CLIP = 500
const RESULT_CLIP = 12_000
/** The answer as a person reads it when the caller wrote no summary. */
const FALLBACK_CLIP = 3500

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
  const w = result.waiting
  const waitWords = w ? `${w.on}${w.dueAt ? `, expected by ${whenText(w.dueAt)}` : ""}` : ""
  const st = result.state
  const outcome = opts.reply ? `answered (${rec.callee} sent this to you itself)` : {
    done: "finished",
    waiting: st?.state === "continue"
      ? `is NOT finished: ${rec.callee} ended its run with work left${w?.dueAt ? `, to carry on by ${whenText(w.dueAt)}` : ""}`
      : `is NOT finished: ${rec.callee} ended its run to wait for ${waitWords || "something"}`,
    error: st?.state === "blocked"
      ? `is NOT finished: ${rec.callee} says it is blocked`
      : st?.state === "stalled"
        ? `is NOT finished: ${rec.callee} ended its run without saying whether it is done, and gave no state when asked`
        : "failed",
    timeout: "did not answer in time",
    lost: "was lost (this machine restarted before the answer came back)",
  }[result.status]
  const ok = result.status === "done" || result.status === "waiting"
  if (result.status === "waiting" && !opts.reply) {
    const nextWait = rec.kind === "send"
      ? "Do not count it as done. Carry on with what does not depend on it. If it is still not finished when it is due, you will be told."
      : "Tell the person it is under way and what it waits for. Do not say it is done."
    return [
      `${DELEGATION_RESULT_MARKER} task=${rec.id} from=${rec.callee}${rec.peer ? ` peer=${rec.peer}` : ""} status=waiting]`,
      `Earlier in this conversation you asked ${who} to help. That work ${outcome}.`,
      ...(opts.wrote ? [`${rec.callee} already wrote to you during the work; this is how its run ended.`] : []),
      "",
      "What you asked:",
      rec.request,
      "",
      `${who} said:`,
      clip(result.text, RESULT_CLIP),
      "",
      nextWait,
    ].join("\n")
  }
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
  if (result.status === "done") return `${who} finished:\n\n${clip(result.text, FALLBACK_CLIP)}`
  if (result.state?.state === "continue") return `${who} is not finished yet; it has work left:\n\n${clip(result.text, FALLBACK_CLIP)}`
  if (result.status === "waiting") return `${who} is not finished yet; it is waiting for ${result.waiting?.on ?? "something"}:\n\n${clip(result.text, FALLBACK_CLIP)}`
  if (result.state?.state === "blocked") return `${who} is not finished; it says it is blocked:\n\n${clip(result.text, FALLBACK_CLIP)}`
  if (result.state?.state === "stalled") return `${who} did not say whether the work is done. Treat it as stalled:\n\n${clip(result.text, FALLBACK_CLIP)}`
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
  /** The end of a run that already wrote to the caller. */
  wrote?: boolean
  /** Its callback turn never started before the restart (#1861). */
  pending?: boolean
}

/** One answer a callback turn passes on. `reply`: a message the callee
 *  wrote while it works (relayReply). `wrote`: the end of a run that
 *  already wrote to the caller. */
interface CallbackItem {
  rec: DelegationRecord
  result: DelegationResult
  reply?: boolean
  wrote?: boolean
}

interface CallbackBatch {
  items: CallbackItem[]
  startedAt: number
  done: Promise<void>
}

/** Answers batch per caller chat, and an agent's sends apart from the
 *  delegations a person started (they are told different things). */
function batchKeyOf(rec: DelegationRecord): string {
  return `${rec.caller}\u0000${rec.origin.channel}\u0000${rec.origin.chatId}\u0000${rec.kind ?? ""}`
}

/** Does a run's final answer add nothing to what the callee already wrote
 *  to its caller? True when at least REPEAT_SHARE of its words are in what
 *  was written. A progress note ("on it") followed by the real result
 *  still comes back. Measured on 60 such ends (2026-11-05..07): the
 *  caller answered "nothing new" to nearly all, at shares 0.15 to 0.90. */
export function repeatsWritten(finalText: string, written: string[]): boolean {
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/#-]*/gu) ?? [])
  const fin = words(finalText)
  if (fin.size === 0) return true
  const seen = words(written.join("\n"))
  let shared = 0
  for (const w of fin) if (seen.has(w)) shared++
  return shared / fin.size >= REPEAT_SHARE
}
/** Share of the final answer's words already written for it to count as a repeat. */
export const REPEAT_SHARE = 0.5

export class DelegationManager {
  private pendingById = new Map<string, DelegationRecord>()
  private recent: Array<{ id: string; caller: string; callee: string; peer?: string; status: DelegationStatus | "running"; startedAt: number; endedAt?: number; origin?: DelegationOrigin; depth?: number }> = []
  /** One callback at a time per caller chat, in completion order. */
  private chains = new Map<string, Promise<void>>()
  /** Per caller chat, the answers waiting for a callback that has not
   *  started yet (queueCallback). */
  private batches = new Map<string, CallbackBatch>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private localRuns = new Map<string, string>()
  /** Callback turns a restart stopped, and answers back whose callback
   *  turn never started before it (`pending`, #1861), by task id (see
   *  HeldRelay). */
  private heldRelays = new Map<string, HeldRelay>()
  /** Delegations whose callee said its run ends to wait (markWaiting). */
  private waiting = new Map<string, Waiting>()
  /** Delegations whose callee already wrote to the caller (relayReply),
   *  with what it wrote: an end that only repeats it is not called back. */
  private answered = new Map<string, string[]>()
  /** Per callee and home (#1100): the chat of its last run there, and
   *  that run while it is still going. In memory: a restart starts over. */
  private homes = new Map<string, { chats: Array<{ channel: string; chatId: string }>; taskId: string; running: Promise<void> | null; endedAt: number | null; implicit: boolean }>()
  /** Callee chats with a same-home run going right now: never continued. */
  private busyChats = new Set<string>()
  private readonly now: () => number
  private readonly store: HandoffStore | null

  constructor(private deps: DelegationDeps) {
    this.now = deps.now ?? Date.now
    this.store = deps.store ?? null
    // Without the table, nothing is read back: memory only (#1861).
    if (this.store) this.load(this.store)
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
    this.answered.set(rec.id, [...(this.answered.get(rec.id) ?? []), text])
    this.deps.log(`[delegation ${rec.id}] ${rec.callee} wrote to ${rec.caller}; passed to ${rec.origin.channel}:${rec.origin.chatId}`)
    void this.enqueue(rec, () => this.callback([{ rec, result: { status: "done", text }, reply: true }]))
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
    this.remember({ id, caller: record.caller, callee: record.callee, peer: record.peer, status: "running", startedAt: record.startedAt, origin, ...(depth ? { depth } : {}) })
    this.journal("record the hand-off", (s) => s.insert(record, record.startedAt), undefined)
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
    // Work with no home counts the caller's chat as its home (#1749): asked
    // again from the same conversation, the callee picks up where its last
    // run there ended, instead of starting cold. It never waits for a run
    // still going there; it starts fresh beside it.
    const implicit = !home
    const homeKey = record.peer
      ? null
      : home
        ? `${record.callee}\u0000${home}`
        : `${record.callee}\u0000chat\u0000${record.caller}\u0000${origin.channel}\u0000${origin.chatId}`
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
        if (!implicit) this.deps.log(`[delegation ${id}] a run on ${home} is still going; starting a fresh session instead`)
        return []
      }
      const from = chats.filter((c) => !(c.channel === calleeChat.channel && c.chatId === calleeChat.chatId))
      if (implicit && from.length) this.deps.log(`[delegation ${id}] ${record.callee} continues its session from ${origin.channel}:${origin.chatId}`)
      return from
    }
    if (prior && !implicit) {
      this.deps.log(`[delegation ${id}] ${record.callee} is on ${home} (${prior.taskId}); ${prior.running ? "waits for it, then " : ""}continues its session`)
    }

    const timeoutMs = opts.timeoutMs ?? this.deps.timeoutMs
    const launch = (): Promise<CalleeRun> => {
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
          .then((text) => ({ content: text } as CalleeRun))
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
    const waitFor = prior?.running && !implicit
      ? Promise.race([prior.running, new Promise<void>((r) => { const t = setTimeout(r, timeoutMs); (t as any).unref?.() })])
      : null
    const run = waitFor ? waitFor.then(launch) : launch()
    if (homeKey) {
      const running = run.then(() => undefined, () => undefined)
      this.homes.set(homeKey, { chats: [calleeChat, ...(prior?.chats ?? [])].slice(0, 3), taskId: id, running, endedAt: null, implicit })
      void running.then(() => {
        const h = this.homes.get(homeKey)
        if (h?.taskId === id) { h.running = null; h.endedAt = this.now() }
      })
    }
    run
      .then((r) => {
        // A run that said it ends to wait (markWaiting) is not done
        // (#1100), nor is one whose job continues, is blocked or stalled
        // (#1861).
        const said = this.waiting.get(id)
        this.waiting.delete(id)
        return this.complete(id, resultOfRun(r, { callee: record.callee, said, peer: !!record.peer }))
      })
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
      // The table knows every kept row; without it (memory only), the
      // recent list knows this process's last 200.
      const ended = this.journal("read the hand-off", (s) => s.statusOf(id), null)
        ?? this.recent.find((r) => r.id === id && r.status !== "running")?.status
      if (ended) this.deps.log(`[delegation ${id}] duplicate ${result.status} suppressed`)
      else this.deps.log(`[delegation ${id}] ${result.status} for an unknown task ignored`)
      return false
    }
    // The callee already wrote to the caller (relayReply): its end still
    // comes back, said as such, since what it wrote may only have been a
    // progress note. An end that only repeats what it wrote is not: the
    // caller's turn for it answered "nothing new" every time.
    const written = this.answered.get(id)
    const repeat = !!written && result.status === "done" && repeatsWritten(result.text, written)
    this.pendingById.delete(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.localRuns.delete(id)
    this.waiting.delete(id)
    this.answered.delete(id)
    // The first outcome wins across processes too: another daemon on this
    // database that already ended it has called back. An answer that will
    // be called back is marked pending in the same write: should the daemon
    // stop before its callback turn starts, the next start runs it once.
    const pending = repeat ? undefined : { result: { ...result, text: clip(result.text, RESULT_CLIP) }, ...(written ? { wrote: true } : {}) }
    if (this.journal("end the hand-off", (s) => s.end(id, result.status, this.now(), pending, result), "missing") === "taken") {
      this.deps.log(`[delegation ${id}] ${result.status} dropped: another process ended it already`)
      return false
    }
    const entry = this.recent.find((r) => r.id === id)
    if (entry) { entry.status = result.status; entry.endedAt = this.now() }
    this.deps.log(`[delegation ${id}] ${rec.callee} ${result.status} after ${Math.round((this.now() - rec.startedAt) / 1000)}s`)
    try { this.deps.onDone?.(rec, result) } catch { /* a listener never stops a callback */ }
    // A callee that said it is blocked did not fail, and a stalled one
    // already left its own signal (job_stalled).
    if (!result.state && (result.status === "error" || result.status === "timeout" || result.status === "lost")) {
      emitSignal({ kind: "delegation_failed", agentId: rec.caller, ref: id, detail: `${rec.callee}${rec.peer ? `@${rec.peer}` : ""} ${result.status}: ${result.text.slice(0, 160)}` })
    }

    if (repeat) {
      this.deps.log(`[delegation ${id}] ${rec.callee}'s end repeats what it already wrote to ${rec.caller}; no callback turn`)
      emitSignal({ kind: "callback_repeat_skipped", agentId: rec.callee, ref: id, detail: `wrote to ${rec.caller}, then ended with the same answer` })
      return true
    }
    await this.queueCallback({ rec, result, wrote: !!written })
    return true
  }

  /**
   * Answers for one caller chat come back as one turn (#1749): a caller
   * that handed out four pieces of work gets one callback, not four. An
   * answer joins the batch of its chat that has not started yet; the batch
   * waits up to coalesceMs for the other delegations still running from
   * that chat, then for the chat to be free, and only then closes.
   */
  private queueCallback(item: CallbackItem): Promise<void> {
    const key = batchKeyOf(item.rec)
    const open = this.batches.get(key)
    if (open) {
      open.items.push(item)
      return open.done
    }
    const batch: CallbackBatch = { items: [item], startedAt: this.now(), done: Promise.resolve() }
    this.batches.set(key, batch)
    batch.done = this.enqueue(item.rec, async () => {
      await this.settle(key, batch)
      const { channel, chatId } = item.rec.origin
      await this.waitUntilFree(item.rec.caller, channel, chatId)
      if (this.batches.get(key) === batch) this.batches.delete(key)
      await this.callback(batch.items)
    })
    return batch.done
  }

  /** Wait while other delegations from the batch's chat still run, up to
   *  coalesceMs from when the batch opened. */
  private async settle(key: string, batch: CallbackBatch): Promise<void> {
    const limit = this.deps.coalesceMs ?? 0
    if (limit <= 0) return
    const poll = this.deps.pollMs ?? 500
    const inBatch = () => new Set(batch.items.map((i) => i.rec.id))
    const siblings = () => {
      const have = inBatch()
      return [...this.pendingById.values()].some((r) => batchKeyOf(r) === key && !have.has(r.id))
    }
    while (siblings() && this.now() - batch.startedAt < limit) {
      await new Promise((r) => setTimeout(r, poll))
    }
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
      this.remember({ id: rec.id, caller: rec.caller, callee: rec.callee, peer: rec.peer, status: "running", startedAt: rec.startedAt, origin: rec.origin, ...(rec.depth ? { depth: rec.depth } : {}) })
    }
    await Promise.all(lost.map((rec) => this.complete(rec.id, {
      status: "lost",
      text: "This machine restarted while the work was in progress, so its answer never came back.",
    })))
    await relays
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
      // Written down before it starts, and only once: a second process on
      // this database finds it taken.
      if (!this.journal("claim the re-run", (s) => s.claimRerun(rec.id, this.now()), true)) {
        this.heldRelays.delete(rec.id)
        this.deps.log(`[delegation ${rec.id}] re-run of the callback to ${rec.caller} already taken by another process`)
        return Promise.resolve()
      }
      rerun++
      this.holdRelay({ ...h, attempt: 2 })
      this.deps.log(h.pending
        ? `[delegation ${rec.id}] re-running the callback to ${rec.caller} a restart kept from starting`
        : `[delegation ${rec.id}] re-running the callback to ${rec.caller} a restart stopped`)
      return this.enqueue(rec, () => this.callback([{ rec, result: h.result, reply: h.reply === true, wrote: h.wrote === true }], 2))
    }))
    return rerun
  }

  /** Recent delegations, newest first. Ids, agents and status only. Read
   *  from the table, so the list survives a restart (#2007); a node with
   *  no database, or a failed read, lists this process's last 200. */
  list(limit = 50): Array<{ id: string; caller: string; callee: string; peer?: string; status: string; startedAt: string; endedAt?: string }> {
    const stored = this.journal("list the hand-offs", (s) => s.list(limit), null)
    if (stored) return stored
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
   *  or ended within sameHomeMs (sameChatMs for a caller chat's). Old
   *  entries are dropped on the way. */
  private sameHome(key: string): { chats: Array<{ channel: string; chatId: string }>; taskId: string; running: Promise<void> | null } | null {
    const homeWindow = this.deps.sameHomeMs ?? 12 * 3_600_000
    const chatWindow = this.deps.sameChatMs ?? 2 * 3_600_000
    const now = this.now()
    for (const [k, h] of this.homes) {
      if (h.endedAt !== null && now - h.endedAt > (h.implicit ? chatWindow : homeWindow)) this.homes.delete(k)
    }
    return this.homes.get(key) ?? null
  }

  /** A callee's run (by its run id) says it ends to wait for something
   *  before the work is done (#1100): its end is reported as "waiting",
   *  not done. The delegation it runs for, or null when it runs for none
   *  on this node. */
  markWaiting(runId: string, w: Waiting): DelegationRecord | null {
    for (const [id, run] of this.localRuns) {
      if (run !== runId) continue
      const rec = this.pendingById.get(id)
      if (!rec) return null
      this.waiting.set(id, { on: clip(w.on, 300), ...(w.dueAt ? { dueAt: w.dueAt } : {}) })
      this.deps.log(`[delegation ${id}] ${rec.callee} ends its run waiting for ${clip(w.on, 120)}`)
      return rec
    }
    return null
  }

  /** The asking agent and its chat for a delegation, running or recent:
   *  where news about that work belongs (#1100). `depth` is the asking
   *  turn's callback hop count (MAX_SEND_DEPTH). */
  originFor(id: string): { caller: string; origin: DelegationOrigin; depth: number } | null {
    const rec = this.pendingById.get(id)
    if (rec) return { caller: rec.caller, origin: rec.origin, depth: rec.depth ?? 0 }
    const r = this.recent.find((e) => e.id === id)
    return r?.origin ? { caller: r.caller, origin: r.origin, depth: r.depth ?? 0 } : null
  }

  /** Stop timers (daemon shutdown, tests). Pending work stays in the table. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** One turn for the caller, passing on every answer in `items` (all for
   *  the same caller chat). `attempt` 2 is the one re-run of a callback a
   *  restart stopped; it always carries a single answer. */
  private async callback(items: CallbackItem[], attempt = 1): Promise<void> {
    const rec = items[0].rec
    const last = items[items.length - 1].rec
    const tag = items.map((i) => i.rec.id).join(",")
    const { channel, chatId } = rec.origin
    await this.waitUntilFree(rec.caller, channel, chatId)
    const context: Record<string, unknown> = {
      ...rec.origin,
      sender: `agent:${rec.callee}`,
      delegation: {
        taskId: rec.id, from: rec.callee, ...(rec.peer ? { peer: rec.peer } : {}), status: items[0].reply ? "reply" : items[0].result.status,
        ...(items.length > 1 ? { taskIds: items.map((i) => i.rec.id) } : {}),
        // A send from this turn counts one hop more (MAX_SEND_DEPTH).
        depth: Math.max(...items.map((i) => i.rec.depth ?? 0)) + 1,
        // Work this turn hands on keeps the chain's root (#1749).
        root: rec.root,
      },
    }
    // The turn starts now: an answer marked pending at complete() no longer
    // needs its re-run (a restart from here on holds it, below). Not for a
    // reply: the end of the same delegation may still wait behind it.
    const ends = items.filter((i) => !i.reply).map((i) => i.rec.id)
    if (ends.length) this.journal("clear the pending callback", (s) => s.clearPending(ends, this.now()), undefined)
    let resp: { content: string; error?: string }
    try {
      const parts = items.map(({ rec: r, result, reply, wrote }) => {
        let note: string | undefined
        try { note = this.deps.callbackNote?.(r, result) } catch { /* a listener never stops a callback */ }
        const base = buildCallbackMessage(r, result, { reply, wrote })
        return note ? `${base}\n\n${note}` : base
      })
      const message = items.length > 1
        ? `${parts.join("\n\n---\n\n")}\n\n${items.length} pieces of work you handed out came back together. Answer them in one reply.`
        : parts[0]
      resp = await this.deps.injectTurn({ agentId: rec.caller, message, context })
    } catch (e: any) {
      resp = { content: "", error: e?.message ?? String(e) }
    }
    // A restart stopped the turn before it answered: the person would get
    // nothing (the channels are already down). Keep it for one re-run after
    // the next start; a re-run stopped too is told on the start after that.
    if (stoppedByRestart(resp) && (attempt > 1 || this.deps.requeueRelayOnRestart !== false)) {
      if (attempt === 1) {
        for (const i of items) this.holdRelay({ record: i.rec, result: i.result, attempt: 1, ...(i.reply ? { reply: true } : {}), ...(i.wrote ? { wrote: true } : {}) })
        this.deps.log(`[delegation ${tag}] callback to ${rec.caller} stopped by a restart; it runs once more after the next start`)
      } else {
        this.deps.log(`[delegation ${tag}] re-run of the callback to ${rec.caller} stopped by a restart too; the person is told after the next start`)
      }
      return
    }
    // The registry queued it behind other work; its flush replies on the
    // channel itself.
    if (isQueued(resp.error)) {
      this.deps.log(`[delegation ${tag}] callback queued behind other work for ${rec.caller}`)
      if (attempt > 1) for (const i of items) this.releaseRelay(i.rec.id)
      return
    }
    const own = !resp.error && resp.content.trim().length > 0
    // An agent's send: the turn was the asking agent's own work. Nothing
    // goes to a person from here (its chat is an agent's anyway).
    if (rec.kind === "send") {
      if (attempt > 1) for (const i of items) this.releaseRelay(i.rec.id)
      if (!own) this.deps.log(`[delegation ${tag}] ${rec.caller} gave no reply to the callback${resp.error ? `: ${resp.error}` : ""}`)
      return
    }
    if (attempt > 1) {
      if (!own) {
        const why = `its re-run gave no reply${resp.error ? ` (${clip(resp.error, 200)})` : ""}`
        for (const i of items) await this.relayFailed(i.rec, i.result, why)
        return
      }
      for (const i of items) this.releaseRelay(i.rec.id)
      this.deps.log(`[delegation ${tag}] re-run of the callback to ${rec.caller} answered`)
    }
    if (!own) this.deps.log(`[delegation ${tag}] ${rec.caller} gave no reply to the callback${resp.error ? `: ${resp.error}` : ""}; sending the plain result`)
    const text = own ? resp.content : items.map((i) => fallbackReply(i.rec, i.result)).join("\n\n")
    if (!this.deps.canDeliver(channel)) {
      this.deps.log(`[delegation ${tag}] no route to ${channel}:${chatId}; the reply is in ${rec.caller}'s session only`)
      return
    }
    const ok = (s: DelegationStatus) => s === "done" || s === "waiting"
    try {
      await this.deps.deliver({
        channel, chatId, text, agentId: rec.caller, accountId: rec.origin.accountId, record: !own,
        taskId: last.id,
        outcome: own || items.every((i) => ok(i.result.status)) ? "done" : "error",
        countsAsReply: true,
      })
      this.deps.log(`[delegation ${tag}] ${rec.caller} updated ${channel}:${chatId}`)
    } catch (e: any) {
      this.deps.log(`[delegation ${tag}] delivery to ${channel}:${chatId} failed: ${e?.message ?? e}`)
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
        record: true, taskId: rec.id, outcome: "error", countsAsReply: false,
      })
    } catch (e: any) {
      this.deps.log(`[delegation ${rec.id}] notice to ${channel}:${chatId} failed: ${e?.message ?? e}`)
    }
  }

  private holdRelay(h: HeldRelay): void {
    // Keep waiting and state: the re-run must end the hand-off the same way.
    const held: HeldRelay = { record: h.record, result: { ...h.result, text: clip(h.result.text, RESULT_CLIP) }, attempt: h.attempt, ...(h.reply ? { reply: true } : {}) }
    const wrote = h.wrote ? { wrote: true } : {}
    this.heldRelays.set(h.record.id, { ...held, ...wrote })
    const ts = this.now()
    this.journal("hold the callback", (s) => s.hold(held.record, { ...held, ...wrote }, held.attempt, ts), undefined)
  }

  private releaseRelay(id: string): void {
    if (!this.heldRelays.delete(id)) return
    const ts = this.now()
    this.journal("release the callback", (s) => s.release(id, ts), undefined)
  }

  /** "database": hand-offs survive a restart. "memory-only": this node
   *  has no database, so a restart forgets them (shown in /health). */
  journalMode(): "database" | "memory-only" {
    return this.store ? "database" : "memory-only"
  }

  /** What GET /a2a/delegations/:id reads (#2007): the table, or null on a
   *  node with no database. */
  journalReader(): Pick<HandoffStore, "read"> | null {
    return this.store
  }

  /** Delete hand-offs that ended before `before` (requests.retentionDays).
   *  Held callbacks stay. Returns how many went. */
  prune(before: number): number {
    return this.journal("prune", (s) => s.prune(before), 0)
  }

  /** One write or read of the table. A failure is logged and the work goes
   *  on in memory. */
  private journal<T>(what: string, fn: (s: HandoffStore) => T, fallback: T): T {
    if (!this.store) return fallback
    try {
      return fn(this.store)
    } catch (e: any) {
      this.deps.log(`[delegation] could not ${what} in the handoffs table: ${e?.message ?? e}`)
      return fallback
    }
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

  /** At start: what was still out and what callback was held are read
   *  back from the table. A leftover old file was imported into it before
   *  (importDelegationLog). */
  private load(store: HandoffStore): void {
    try {
      for (const rec of store.open()) this.pendingById.set(rec.id, rec)
      const dropped: string[] = []
      for (const h of store.held()) {
        // An answer whose callback never started is re-run once, like a held
        // callback, unless the owner turned re-runs after a restart off:
        // then it is dropped.
        if (h.pending && this.deps.requeueRelayOnRestart === false) dropped.push(h.record.id)
        else this.heldRelays.set(h.record.id, h)
      }
      if (dropped.length) {
        store.clearPending(dropped, this.now())
        this.deps.log(`[delegation] ${dropped.length} answer(s) a restart kept from their callback not re-run (requeueRelayOnRestart is off): ${dropped.join(", ")}`)
      }
    } catch (e: any) {
      this.deps.log(`[delegation] could not read the handoffs table: ${e?.message ?? e}`)
    }
  }
}
