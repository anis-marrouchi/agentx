import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import { FINAL_STATES, StatusStore, statusText, type StatusRow, type StatusState } from "./status"
import type { DelegationSignal } from "./tracker"

// --- Keep the status of each request current, where it was made (#383) ---
//
// Fed by signals the daemon already has; no model call:
//   - a message waits behind a busy agent   → queued
//   - the turn starts                       → working
//   - the turn hands work to another agent  → waiting on that agent
//   - the turn raises a decision card       → waiting on the owner's answer
//   - the turn ends, nothing handed out     → done
//   - the turn fails / hits its time limit  → failed / timed out
//   - the person stops it                   → stopped
//   - a restart cut it and nothing resumed  → cut off by a restart
//   - a queued message's turn never started → failed
//
// On GitLab and GitHub every change is written to one comment per request:
// posted once, then edited. Nothing comes in for this; the daemon only
// sends to the thread the person already reads.

export interface StatusSettings {
  /** Channels that show request status. Empty: off. */
  channels: string[]
  retentionDays: number
}

export interface StatusBoardDeps {
  /** Post the status comment. Returns its id, or "" when it was not posted. */
  post: (row: StatusRow, text: string) => Promise<string>
  /** Edit the status comment. False when the edit did not go through. */
  edit: (row: StatusRow, commentRef: string, text: string) => Promise<boolean>
  log: (msg: string) => void
  now?: () => number
}

/** Channels where the status is a comment the daemon keeps. Elsewhere the
 *  row is only recorded, for the person to ask about. */
const COMMENT_CHANNELS: ReadonlySet<string> = new Set(["gitlab", "github"])
/** The chats of those channels a comment can be posted to. A pipeline or
 *  a push has no thread, so it gets no request. */
const THREAD = /:(issue|merge_request|pull):\d+$/
/** Failed writes in a row after which the minute check leaves a comment
 *  alone. The next change of state still tries once. */
const WRITE_TRIES = 5

/** After a boot, how long a run the restart cut has to be picked up again. */
const RESTART_GRACE_MS = 120_000
const DAY = 86_400_000

const base = (channel: string) => channel.toLowerCase().split("@")[0]

export class StatusBoard {
  private now: () => number
  private bootAt: number
  /** Requests that were queued or running when the last process stopped. */
  private orphans = new Set<string>()
  /** One write at a time per request, in order. */
  private writes = new Map<string, Promise<void>>()

  constructor(
    readonly store: StatusStore,
    private settings: () => StatusSettings,
    private deps: StatusBoardDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.bootAt = this.now()
    for (const r of store.open()) {
      if (r.state !== "queued" && !r.turnLive) continue
      this.orphans.add(r.id)
      if (r.turnLive) store.set(r.id, { turnLive: false }, this.bootAt)
    }
  }

  private on(channel: string, chatId: string): boolean {
    if (COMMENT_CHANNELS.has(base(channel)) && !THREAD.test(chatId)) return false
    return this.settings().channels.map(base).includes(base(channel))
  }

  private guard(what: string, fn: () => void): void {
    try { fn() } catch (e: any) { this.deps.log(`[status] ${what} failed: ${e?.message ?? e}`) }
  }

  private change(id: string, patch: Parameters<StatusStore["set"]>[1]): void {
    this.store.set(id, patch, this.now())
    this.orphans.delete(id)
    this.push(id)
  }

  queued(p: AgentXEvents["task:queued"]): void {
    this.guard("queued", () => {
      if (!p.humanRoot || !this.on(p.channel, p.chatId)) return
      // Messages that wait together run as one turn: one request.
      if (this.store.inChat(p.agentId, p.channel, p.chatId, "queued")) return
      const id = `req-q-${randomUUID()}`
      this.store.add({ id, channel: p.channel, chatId: p.chatId, agentId: p.agentId, senderId: p.sender?.id ?? p.sender?.username ?? null, state: "queued", now: this.now() })
      this.push(id)
    })
  }

  taskStarted(p: AgentXEvents["task:started"]): void {
    if (!p.taskId) return
    this.guard("start", () => {
      // A run that continues one a restart cut off belongs to its request.
      const earlier = p.resumedFrom ? this.store.byRef("run", p.resumedFrom) : null
      if (earlier) {
        this.store.ref(earlier.id, "run", p.taskId!)
        if (!FINAL_STATES.includes(earlier.state)) this.change(earlier.id, { state: earlier.pending > 0 ? "waiting" : "working", turnLive: true })
        return
      }
      if (!this.on(p.channel, p.chatId)) return
      // Looked up before the humanRoot test: messages that waited together
      // run as one turn with the last one's context, which may be an
      // agent's comment.
      const waiting = this.store.inChat(p.agentId, p.channel, p.chatId, "queued")
      if (waiting) {
        this.store.ref(waiting.id, "run", p.taskId!)
        this.change(waiting.id, { state: "working", turnLive: true })
        return
      }
      if (!p.humanRoot) return
      const id = `req-${p.taskId}`
      this.store.add({ id, channel: p.channel, chatId: p.chatId, agentId: p.agentId, senderId: p.sender?.id ?? p.sender?.username ?? null, state: "working", now: this.now() })
      this.store.ref(id, "run", p.taskId!)
      this.push(id)
    })
  }

  /** The turn a queued message was handed to has ended. A request that
   *  waited before the hand-over and is still queued never started. */
  queueEnded(p: AgentXEvents["task:queue-ended"]): void {
    this.guard("queue end", () => {
      const row = this.store.inChat(p.agentId, p.channel, p.chatId, "queued")
      if (row && row.createdAt <= p.flushedAt) this.change(row.id, { state: "failed" })
    })
  }

  taskCompleted(p: AgentXEvents["task:completed"]): void {
    if (!p.taskId) return
    this.guard("end", () => {
      const row = this.store.byRef("run", p.taskId!)
      if (!row || FINAL_STATES.includes(row.state)) return
      // Cut by a shutdown: the next boot decides.
      if (p.interrupted) return
      let state: StatusState
      // A cancel or a stop signal (#857) is stopped on purpose, not failed.
      if (p.error) state = p.errorKind === "cancelled" || p.errorKind === "stopped" || p.stopped ? "stopped" : /\btimed? ?out\b|timeout/i.test(p.error) ? "timed_out" : "failed"
      else state = row.pending > 0 ? "waiting" : "done"
      this.change(row.id, { state, turnLive: false })
    })
  }

  delegationStarted(d: DelegationSignal): void {
    this.guard("delegation start", () => {
      const row = this.store.inChat(d.caller, d.origin.channel, d.origin.chatId, "live")
      if (!row) return
      this.store.ref(row.id, "delegation", d.id)
      // The agent's name only: which machine it runs on is not the asker's business.
      this.change(row.id, { state: "waiting", waitingOn: d.callee, pending: row.pending + 1 })
    })
  }

  delegationDone(d: DelegationSignal, status: "done" | "error" | "timeout" | "lost"): void {
    this.guard("delegation end", () => this.handedBack(this.store.byRef("delegation", d.id), status))
  }

  /** The agent raised a decision card from the turn of a request: the
   *  work waits on the owner's answer. `turn` is the running turn the call
   *  proved, never the chat the card names. */
  cardRaised(card: { id: string; raised_by: string }, turn: { channel: string; chatId: string } | null): void {
    if (!turn) return
    this.guard("card", () => {
      const row = this.store.inChat(card.raised_by, turn.channel, turn.chatId, "live")
      if (!row) return
      this.store.ref(row.id, "card", card.id)
      this.change(row.id, { state: "waiting", waitingOn: "an answer from the owner", pending: row.pending + 1 })
    })
  }

  /** A linked card was answered or expired. An answer lets the work go
   *  on; an expiry means the answer never came (no card approves itself, #741). */
  cardResolved(card: { id: string; status: string; if_silent?: string; outcome?: string }): void {
    this.guard("card result", () => {
      const went = card.status === "decided"
      this.handedBack(this.store.byRef("card", card.id), went ? "done" : "timeout")
    })
  }

  /** Something the request waited on came back, or never will. */
  private handedBack(row: StatusRow | null, status: "done" | "error" | "timeout" | "lost"): void {
    if (!row || FINAL_STATES.includes(row.state)) return
    const pending = row.pending - 1
    if (pending > 0) { this.change(row.id, { pending }); return }
    // While its turn runs, the turn's own end says how the request went.
    if (row.turnLive) { this.change(row.id, { state: "working", pending }); return }
    const state: StatusState = { done: "done", error: "failed", timeout: "timed_out", lost: "restart" }[status] as StatusState
    this.change(row.id, { state, pending })
  }

  /** What the boot-time resume step did with a run the restart cut off. */
  resumeOutcome(o: { taskId: string; decision: string }): void {
    this.guard("restart", () => {
      if (o.decision !== "reported" && o.decision !== "resume-failed") return
      const row = this.store.byRef("run", o.taskId)
      if (row && !FINAL_STATES.includes(row.state)) this.change(row.id, { state: "restart", turnLive: false })
    })
  }

  /** Once a minute: settle what the restart left, catch up comments that
   *  could not be written, delete old ended requests. */
  sweep(): void {
    const now = this.now()
    this.guard("restart check", () => {
      if (this.orphans.size === 0 || now - this.bootAt < RESTART_GRACE_MS) return
      for (const id of [...this.orphans]) {
        const row = this.store.get(id)
        if (row && !row.turnLive && (row.state === "queued" || row.state === "working")) this.change(id, { state: "restart" })
      }
      this.orphans.clear()
    })
    this.guard("catch up", () => {
      for (const r of this.store.changedSince(now - DAY)) if (r.shown !== statusText(r) && r.writeFails < WRITE_TRIES) this.push(r.id)
    })
    this.guard("retention", () => { this.store.prune(now - this.settings().retentionDays * DAY) })
  }

  /** Resolves when every pending comment write has ended. */
  async idle(): Promise<void> {
    while (this.writes.size) await Promise.all(this.writes.values())
  }

  private push(id: string): void {
    const next = (this.writes.get(id) ?? Promise.resolve())
      .then(() => this.write(id))
      .catch((e: any) => this.deps.log(`[status] comment for ${id} failed: ${e?.message ?? e}`))
      .finally(() => { if (this.writes.get(id) === next) this.writes.delete(id) })
    this.writes.set(id, next)
  }

  private async write(id: string): Promise<void> {
    const row = this.store.get(id)
    if (!row || !COMMENT_CHANNELS.has(base(row.channel))) return
    const text = statusText(row)
    if (text === row.shown) return
    let ref = ""
    try {
      if (!row.commentRef) ref = await this.deps.post(row, text)
      else if (await this.deps.edit(row, row.commentRef, text)) ref = row.commentRef
    } catch (e: any) {
      this.deps.log(`[status] comment for ${id} failed: ${e?.message ?? e}`)
    }
    if (ref) { this.store.posted(id, ref, text); return }
    if (this.store.writeFailed(id) === WRITE_TRIES) {
      this.deps.log(`[status] comment for ${id} on ${row.channel} ${row.chatId} could not be written ${WRITE_TRIES} times; not retried until its state changes`)
    }
  }
}

export interface AttachedStatus {
  board: StatusBoard
  detach: () => void
}

/** Hook the status board to the daemon's event bus. */
export function attachStatus(db: Database.Database, settings: () => StatusSettings, deps: StatusBoardDeps): AttachedStatus {
  const board = new StatusBoard(new StatusStore(db), settings, deps)
  const bus = getEventBus()
  const queued = board.queued.bind(board)
  const started = board.taskStarted.bind(board)
  const completed = board.taskCompleted.bind(board)
  const queueEnded = board.queueEnded.bind(board)
  bus.on("task:queued", queued)
  bus.on("task:queue-ended", queueEnded)
  bus.on("task:started", started)
  bus.on("task:completed", completed)
  return {
    board,
    detach: () => {
      bus.off("task:queued", queued)
      bus.off("task:queue-ended", queueEnded)
      bus.off("task:started", started)
      bus.off("task:completed", completed)
    },
  }
}
