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
import { isHumanFacingTurn, isInsideDelegation, rootInitiatorOf, type RootInitiator } from "./initiator"

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
    opts: { timeoutMs: number; onStart: (runId: string) => void; extras?: Record<string, unknown> },
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
  /** Upper bound for one delegation, start to answer. */
  timeoutMs: number
  /** Default true: a person-started delegation goes async on its own. */
  asyncWhenHuman?: boolean
  /** How long a callback waits for the caller's chat to be free. */
  busyWaitMs?: number
  pollMs?: number
  /** start/done log; omit to keep state in memory only (tests). */
  logPath?: string
  now?: () => number
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

/** The message the caller receives as its new turn. */
export function buildCallbackMessage(rec: DelegationRecord, result: DelegationResult): string {
  const who = rec.peer ? `${rec.callee} on ${rec.peer}` : rec.callee
  const outcome = {
    done: "finished",
    error: "failed",
    timeout: "did not answer in time",
    lost: "was lost (this machine restarted before the answer came back)",
  }[result.status]
  return [
    `[agentx:delegation-result task=${rec.id} from=${rec.callee}${rec.peer ? ` peer=${rec.peer}` : ""} status=${result.status}]`,
    `Earlier in this conversation you asked ${who} to help. That work ${outcome}.`,
    "",
    "What you asked:",
    rec.request,
    "",
    result.status === "done" ? `${who} answered:` : "Details:",
    clip(result.text, RESULT_CLIP),
    "",
    result.status === "done"
      ? "Tell the person what came back, in your own words, and act on it if they asked you to."
      : "Tell the person it did not work and what they can do next. Do not retry on your own unless they asked you to.",
  ].join("\n")
}

/** What the person sees when the caller could not write its own summary. */
export function fallbackReply(rec: DelegationRecord, result: DelegationResult): string {
  const who = rec.peer ? `${rec.callee} on ${rec.peer}` : rec.callee
  if (result.status === "done") return `${who} finished:\n\n${clip(result.text, 3500)}`
  return `The request to ${who} did not complete (${result.status}): ${clip(result.text, 500)}`
}

type LogLine =
  | ({ type: "start"; ts: number } & DelegationRecord)
  | { type: "done"; id: string; status: DelegationStatus; ts: number }

export class DelegationManager {
  private pendingById = new Map<string, DelegationRecord>()
  /** Finished task id → how it ended, oldest first. */
  private doneIds = new Map<string, DelegationStatus>()
  private appendsSinceCompact = 0
  private recent: Array<{ id: string; caller: string; callee: string; peer?: string; status: DelegationStatus | "running"; startedAt: number; endedAt?: number }> = []
  /** One callback at a time per caller chat, in completion order. */
  private chains = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private localRuns = new Map<string, string>()
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
  }): { taskId: string; record: DelegationRecord } {
    const origin = originOf(opts.caller.context)
    if (!origin) throw new Error("caller turn has no channel/chatId to call back to")
    const id = `dlg-${this.now().toString(36)}-${randomBytes(4).toString("hex")}`
    const root = rootInitiatorOf(opts.caller.context as any, opts.caller.agentId)
    const record: DelegationRecord = {
      id,
      caller: opts.caller.agentId,
      callee: opts.callee,
      ...(opts.peer ? { peer: opts.peer } : {}),
      request: clip(opts.message, REQUEST_CLIP),
      origin,
      root,
      startedAt: this.now(),
    }
    this.pendingById.set(id, record)
    this.remember({ id, caller: record.caller, callee: record.callee, peer: record.peer, status: "running", startedAt: record.startedAt })
    this.append({ type: "start", ts: record.startedAt, ...record })

    const calleeContext: Record<string, unknown> = {
      channel: "a2a",
      chatId: `a2a:${record.caller}:${record.callee}:${id}`,
      sender: `agent:${record.caller}`,
      ...(opts.calleeContext ?? {}),
      // The root always travels, and always as computed here: a caller
      // cannot claim a different origin for work it hands on.
      initiator: root,
    }
    const who = record.peer ? `${record.callee}@${record.peer}` : record.callee
    this.deps.log(`[delegation ${id}] ${record.caller} -> ${who} started (root=${root.kind}:${root.channel}, callback to ${origin.channel}:${origin.chatId})`)

    const timeoutMs = this.deps.timeoutMs
    const timer = setTimeout(() => {
      const runId = this.localRuns.get(id)
      if (runId) {
        try { this.deps.cancelLocal?.(runId, `delegation ${id} timed out`) } catch { /* best effort */ }
      }
      void this.complete(id, { status: "timeout", text: `No answer from ${who} after ${Math.round(timeoutMs / 60_000) || 1} minute(s).` })
    }, timeoutMs)
    ;(timer as any).unref?.()
    this.timers.set(id, timer)

    const run = record.peer
      ? this.deps.runPeer(record.peer, record.callee, opts.message, calleeContext, { timeoutMs, senderAgentId: record.caller })
          .then((text) => ({ content: text } as { content: string; error?: string }))
      : this.deps.runLocal(record.callee, opts.message, calleeContext, {
          timeoutMs,
          onStart: (runId) => { this.localRuns.set(id, runId) },
          extras: opts.extras,
        })
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

    const key = `${rec.caller}\u0000${rec.origin.channel}\u0000${rec.origin.chatId}`
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.callback(rec, result)).catch((e: any) => {
      this.deps.log(`[delegation ${id}] callback failed: ${e?.message ?? e}`)
    })
    this.chains.set(key, next)
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key) })
    await next
    return true
  }

  /** After a restart: every delegation that was started and never
   *  finished is reported to its caller as lost. */
  async recover(): Promise<number> {
    const lost = [...this.pendingById.values()]
    for (const rec of lost) {
      this.remember({ id: rec.id, caller: rec.caller, callee: rec.callee, peer: rec.peer, status: "running", startedAt: rec.startedAt })
    }
    await Promise.all(lost.map((rec) => this.complete(rec.id, {
      status: "lost",
      text: "This machine restarted while the work was in progress, so its answer never came back.",
    })))
    this.compact()
    return lost.length
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

  /** Stop timers (daemon shutdown, tests). Pending work stays in the log. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private async callback(rec: DelegationRecord, result: DelegationResult): Promise<void> {
    const { channel, chatId } = rec.origin
    await this.waitUntilFree(rec.caller, channel, chatId)
    const context: Record<string, unknown> = {
      ...rec.origin,
      sender: `agent:${rec.callee}`,
      delegation: { taskId: rec.id, from: rec.callee, ...(rec.peer ? { peer: rec.peer } : {}), status: result.status },
    }
    let resp: { content: string; error?: string }
    try {
      resp = await this.deps.injectTurn({ agentId: rec.caller, message: buildCallbackMessage(rec, result), context })
    } catch (e: any) {
      resp = { content: "", error: e?.message ?? String(e) }
    }
    // The registry queued it behind other work; its flush replies on the
    // channel itself.
    if (resp.error?.startsWith("__queued__")) {
      this.deps.log(`[delegation ${rec.id}] callback queued behind other work for ${rec.caller}`)
      return
    }
    const own = !resp.error && resp.content.trim().length > 0
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
        }
      }
    } catch (e: any) {
      this.deps.log(`[delegation] could not read ${path}: ${e?.message ?? e}`)
    }
  }

  /** Keep the log small: only unfinished starts and the recent done ids
   *  (for duplicate suppression) are rewritten. */
  private compact(): void {
    this.appendsSinceCompact = 0
    const path = this.deps.logPath
    if (!path) return
    try {
      const ts = this.now()
      const lines: LogLine[] = [
        ...[...this.pendingById.values()].map((r) => ({ type: "start" as const, ts: r.startedAt, ...r })),
        ...[...this.doneIds].map(([id, status]) => ({ type: "done" as const, id, status, ts })),
      ]
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""))
    } catch { /* best effort */ }
  }
}
