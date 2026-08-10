import { newEventId } from "@/intent/ulid"
import {
  DEFAULT_ATTACH_OPTIONS,
  type AttachOptions,
  type AttachSession,
  type DeliveryMode,
  type InboxItem,
} from "./types"

// --- The attach registry ---
//
// Holds every live Claude Code session that has registered itself, which
// agent identities each answers for, and the messages offered to them.
//
// The one piece of real logic here is the item state machine. Everything
// else is bookkeeping. Two actors race on every item:
//
//   - the dispatcher, which offered the message and is counting down a
//     claim deadline before it gives up and spawns a provider instead
//   - the session's Stop hook, which may drain the item at any moment
//
// Both transitions are guarded by a state check on a single-threaded event
// loop, so "compare state, then mutate" is atomic without a lock. The
// invariant that matters: an item leaves `pending` exactly once. Whichever
// of claim() / expire() wins, the loser observes a non-pending state and
// returns false. That is what makes it safe to put attach mode in front of
// production channel traffic — a message is answered by the session or by a
// spawned agent, never by both, never by neither.
//
// Timeouts are swept rather than scheduled per item. A single interval in
// the daemon calls sweep(); tests call it directly with an explicit clock.
// No dangling setTimeout handles, and deadline behavior is testable without
// fake timers.

/** Resolution handed back to whoever offered the message. */
export type OfferOutcome =
  /** A session answered it. Use this text as the agent's reply. */
  | { kind: "answered"; text: string; sessionId: string }
  /** Nobody claimed it in time (or the session died). Spawn a provider. */
  | { kind: "expired"; reason: string }

interface Waiter {
  resolve: (o: OfferOutcome) => void
}

export interface OfferInput {
  agentId: string
  text: string
  channel: string
  chatId: string
  sender: string
}

export class AttachRegistry {
  private sessions = new Map<string, AttachSession>()
  private items = new Map<string, InboxItem>()
  private waiters = new Map<string, Waiter>()
  private opts: AttachOptions

  constructor(opts: Partial<AttachOptions> = {}) {
    this.opts = { ...DEFAULT_ATTACH_OPTIONS, ...opts }
  }

  options(): AttachOptions {
    return this.opts
  }

  // --- sessions ---

  /** Register (or refresh) a session. Idempotent: every hook event calls
   *  this, so a daemon restart self-heals on the next Stop/prompt without
   *  the human doing anything. Bindings from a previous registration of the
   *  same session id survive — SessionStart fires again on resume/compact,
   *  and losing the binding there would silently detach a bound session. */
  register(
    sessionId: string,
    info: { cwd?: string; model?: string; now?: number } = {},
  ): AttachSession {
    const now = info.now ?? Date.now()
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.lastSeenAt = now
      if (info.cwd) existing.cwd = info.cwd
      if (info.model) existing.model = info.model
      return existing
    }
    const session: AttachSession = {
      sessionId,
      cwd: info.cwd ?? "",
      agentIds: [],
      mode: "notify",
      lastSeenAt: now,
      registeredAt: now,
      model: info.model,
      drainedThisTurn: 0,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  /** Mark activity without creating a session. Returns undefined when the
   *  session is unknown, which is the common case: most Claude Code sessions
   *  on this machine never attach, and their hook events must stay cheap. */
  touch(sessionId: string, now: number = Date.now()): AttachSession | undefined {
    const s = this.sessions.get(sessionId)
    if (s) s.lastSeenAt = now
    return s
  }

  get(sessionId: string): AttachSession | undefined {
    return this.sessions.get(sessionId)
  }

  list(): AttachSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** Bind an agent identity to a session. One agent maps to at most one
   *  session — a later bind steals it, which is what an operator moving
   *  between terminals expects. */
  bind(sessionId: string, agentId: string, mode?: DeliveryMode): AttachSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    for (const other of this.sessions.values()) {
      if (other.sessionId === sessionId) continue
      other.agentIds = other.agentIds.filter((a) => a !== agentId)
    }
    if (!session.agentIds.includes(agentId)) session.agentIds.push(agentId)
    if (mode) session.mode = mode
    return session
  }

  unbind(sessionId: string, agentId?: string): AttachSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    session.agentIds = agentId ? session.agentIds.filter((a) => a !== agentId) : []
    return session
  }

  setMode(sessionId: string, mode: DeliveryMode): AttachSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    session.mode = mode
    return session
  }

  /** Which session, if any, currently answers for this agent. */
  sessionFor(agentId: string): AttachSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.agentIds.includes(agentId)) return s
    }
    return undefined
  }

  /** Drop a session and release everything it was holding. Queued work is
   *  expired, not dropped, so the dispatcher falls back to spawning. */
  deregister(sessionId: string, now: number = Date.now()): void {
    this.sessions.delete(sessionId)
    for (const item of this.items.values()) {
      if (item.sessionId !== sessionId) continue
      if (item.state === "pending" || item.state === "claimed") {
        this.settle(item, "expired", now, "session ended")
      }
    }
  }

  // --- items ---

  /**
   * Offer a message to whichever session owns this agent. Resolves when the
   * session answers, or when the claim deadline passes and the caller should
   * fall back to spawning a provider.
   *
   * Returns null synchronously when no session is bound — the hot path for
   * every normal dispatch, so it must stay allocation-free.
   */
  offer(input: OfferInput, now: number = Date.now()): Promise<OfferOutcome> | null {
    const session = this.sessionFor(input.agentId)
    if (!session) return null
    if (now - session.lastSeenAt > this.opts.staleSessionMs) {
      // The session stopped reporting. Treat it as gone rather than routing
      // real traffic into a terminal nobody is watching.
      this.deregister(session.sessionId, now)
      return null
    }

    const item: InboxItem = {
      id: newEventId(now),
      agentId: input.agentId,
      sessionId: session.sessionId,
      state: "pending",
      text: clip(input.text, this.opts.maxItemChars),
      channel: input.channel,
      chatId: input.chatId,
      sender: input.sender,
      createdAt: now,
    }
    this.items.set(item.id, item)

    return new Promise<OfferOutcome>((resolve) => {
      this.waiters.set(item.id, { resolve })
    })
  }

  /** Items still waiting on a session, oldest first. */
  pending(sessionId: string): InboxItem[] {
    return [...this.items.values()]
      .filter((i) => i.sessionId === sessionId && i.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  pendingCount(sessionId: string): number {
    let n = 0
    for (const i of this.items.values()) {
      if (i.sessionId === sessionId && i.state === "pending") n++
    }
    return n
  }

  /**
   * Take the next pending item for a session. The atomic half of the race:
   * an item observed as `pending` is flipped to `claimed` before any await
   * point, so a concurrent expire() finds it already gone.
   *
   * Only one item may be outstanding per session — the reply-capture path
   * reads Claude Code's `last_assistant_message`, and that is only
   * unambiguous if exactly one question is in flight.
   */
  claim(sessionId: string, now: number = Date.now()): InboxItem | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (session.awaitingAnswer) return undefined

    const next = this.pending(sessionId)[0]
    if (!next || next.state !== "pending") return undefined

    next.state = "claimed"
    next.claimedAt = now
    session.awaitingAnswer = next.id
    session.lastSeenAt = now
    session.drainedThisTurn++
    return next
  }

  /** Record a session's reply and resolve the dispatcher's promise. */
  answer(sessionId: string, text: string, now: number = Date.now()): InboxItem | undefined {
    const session = this.sessions.get(sessionId)
    if (!session?.awaitingAnswer) return undefined
    const item = this.items.get(session.awaitingAnswer)
    session.awaitingAnswer = undefined
    if (!item || item.state !== "claimed") return undefined

    item.answer = text
    this.settle(item, "answered", now)
    return item
  }

  /** Give an item back without answering it — e.g. the human said "not now".
   *  Returns it to `pending` so the claim deadline can still be met by a
   *  later drain, or expire normally. */
  release(sessionId: string, now: number = Date.now()): InboxItem | undefined {
    const session = this.sessions.get(sessionId)
    if (!session?.awaitingAnswer) return undefined
    const item = this.items.get(session.awaitingAnswer)
    session.awaitingAnswer = undefined
    if (!item || item.state !== "claimed") return undefined
    item.state = "pending"
    item.claimedAt = undefined
    session.lastSeenAt = now
    return item
  }

  /** The other atomic half. Returns false when the item already left
   *  `pending`/`claimed`, meaning a session got there first. */
  expire(itemId: string, reason: string, now: number = Date.now()): boolean {
    const item = this.items.get(itemId)
    if (!item) return false
    if (item.state !== "pending" && item.state !== "claimed") return false
    const session = this.sessions.get(item.sessionId)
    if (session?.awaitingAnswer === item.id) session.awaitingAnswer = undefined
    this.settle(item, "expired", now, reason)
    return true
  }

  /**
   * Advance deadlines. Called on an interval by the daemon and directly by
   * tests. An item gets `claimTimeoutMs` to be claimed, and — because a
   * claimed item is a session's active question — the same budget again to
   * be answered, after which we assume the human walked away.
   */
  sweep(now: number = Date.now()): number {
    let expired = 0
    for (const item of this.items.values()) {
      if (item.state === "pending" && now - item.createdAt >= this.opts.claimTimeoutMs) {
        if (this.expire(item.id, "not claimed in time", now)) expired++
      } else if (
        item.state === "claimed" &&
        now - (item.claimedAt ?? item.createdAt) >= this.opts.claimTimeoutMs
      ) {
        if (this.expire(item.id, "claimed but never answered", now)) expired++
      }
    }
    for (const session of this.sessions.values()) {
      if (now - session.lastSeenAt > this.opts.staleSessionMs) {
        this.deregister(session.sessionId, now)
      }
    }
    return expired
  }

  /** Reset the per-turn drain counter — the session actually stopped. */
  endTurn(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.drainedThisTurn = 0
  }

  /** Test/inspection helper. */
  item(id: string): InboxItem | undefined {
    return this.items.get(id)
  }

  /** Drop settled items older than an hour so a long-lived daemon doesn't
   *  accumulate them. In-flight items are never touched. */
  prune(now: number = Date.now(), olderThanMs = 3_600_000): number {
    let n = 0
    for (const [id, item] of this.items) {
      const settled = item.state === "answered" || item.state === "expired"
      if (settled && now - (item.settledAt ?? item.createdAt) > olderThanMs) {
        this.items.delete(id)
        n++
      }
    }
    return n
  }

  /** Single exit point for both terminal states, so the waiter is always
   *  resolved exactly once and never leaks. */
  private settle(item: InboxItem, state: "answered" | "expired", now: number, reason?: string): void {
    item.state = state
    item.settledAt = now
    const waiter = this.waiters.get(item.id)
    if (!waiter) return
    this.waiters.delete(item.id)
    waiter.resolve(
      state === "answered"
        ? { kind: "answered", text: item.answer ?? "", sessionId: item.sessionId }
        : { kind: "expired", reason: reason ?? "expired" },
    )
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}
