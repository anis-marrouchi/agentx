import type { AgentXEvents } from "@/events/bus"
import type { RequestStore } from "./store"

// --- Follow a person's request from the turn that received it (#356) ---
//
// Fed by signals the daemon already has; no model call, no waiting:
//   - a turn from a person starts          → a candidate, linked to its run
//   - that turn ends cleanly, nothing left → the candidate is deleted
//   - the turn started a delegation        → open, in progress
//   - a linked run fails or times out      → needs attention
//   - a delegation fails, times out, is lost → needs attention
//   - a restart cut a linked run           → resumed: in progress;
//                                            not resumed: needs attention
//
// Every entry point swallows its own errors: following requests must never
// break the run it is following.

export interface RequestSettings {
  enabled: boolean
  /** Channels to capture on. Empty: every channel a person writes on. */
  channels: string[]
  /** Who counts as the owner on channels other people can reach: sender
   *  ids or usernames, optionally "channel:id". */
  from: string[]
  staleAfterHours: number
  retentionDays: number
}

/** This node's own surfaces: only its operator can reach them. */
export const OPERATOR_CHANNELS: ReadonlySet<string> = new Set(["voice", "app", "dashboard", "webrtc"])

const base = (channel: string) => channel.toLowerCase().split("@")[0]

/** Does a turn on this channel from this sender count as the owner's? */
export function isOwnerTurn(
  settings: Pick<RequestSettings, "channels" | "from">,
  channel: string,
  sender: { id?: string; username?: string } | undefined,
): boolean {
  const ch = base(channel)
  if (settings.channels.length && !settings.channels.map(base).includes(ch)) return false
  if (OPERATOR_CHANNELS.has(ch)) return true
  // Display names are not matched: anyone can pick one.
  const ids = [sender?.id, sender?.username].filter((v): v is string => !!v).map((v) => v.toLowerCase().replace(/^@/, ""))
  if (!ids.length) return false
  return settings.from.some((entry) => {
    const e = entry.trim().toLowerCase()
    const i = e.indexOf(":")
    const scoped = i > 0 && e.slice(0, i) === ch ? e.slice(i + 1) : null
    return ids.includes((scoped ?? e).replace(/^@/, ""))
  })
}

/** The sender fields of a task context, for the task:started event. */
export function senderOf(ctx: Record<string, unknown> | undefined | null): { name?: string; id?: string; username?: string } | undefined {
  if (!ctx) return undefined
  const pick = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 120) : undefined)
  const sender = { name: pick(ctx.sender), id: pick(ctx.senderId), username: pick(ctx.senderUsername) }
  return sender.name || sender.id || sender.username ? sender : undefined
}

/** "timed out" for a timeout, "failed" otherwise. */
function failureWord(error: string): string {
  return /\btimed? ?out\b|timeout/i.test(error) ? "timed out" : "failed"
}

const clip = (s: string, n = 200) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

const chatKey = (agentId: string, channel: string, chatId: string) => `${agentId}\u0000${channel}\u0000${chatId}`

export interface DelegationSignal {
  id: string
  caller: string
  callee: string
  peer?: string
  origin: { channel: string; chatId: string }
}

export class RequestTracker {
  constructor(
    private store: RequestStore,
    private settings: () => RequestSettings,
    private log: (msg: string) => void,
    private now: () => number = Date.now,
  ) {}

  /** Requests whose turn is running now, by agent and chat. A delegation
   *  is linked through this: it can only start from a running turn. */
  private live = new Map<string, { requestId: string; runId: string }>()

  private guard(what: string, fn: () => void): void {
    try { fn() } catch (e: any) { this.log(`[requests] ${what} failed: ${e?.message ?? e}`) }
  }

  /** The request of the turn this agent is running in this chat, if any. */
  liveRequestId(agentId: string, channel: string, chatId: string): string | null {
    return this.live.get(chatKey(agentId, channel, chatId))?.requestId ?? null
  }

  taskStarted(p: AgentXEvents["task:started"]): void {
    if (!this.settings().enabled || !p.taskId) return
    this.guard("capture", () => {
      const now = this.now()
      // A run that continues one a restart cut off belongs to its request.
      const earlier = p.resumedFrom ? this.store.byLink("run", p.resumedFrom) : null
      const key = chatKey(p.agentId, p.channel, p.chatId)
      if (earlier) {
        this.store.link(earlier.id, "run", p.taskId!, now)
        this.store.progress(earlier.id, now)
        this.live.set(key, { requestId: earlier.id, runId: p.taskId! })
        return
      }
      if (!p.humanRoot || !isOwnerTurn(this.settings(), p.channel, p.sender)) return
      this.live.set(key, { requestId: `req-${p.taskId}`, runId: p.taskId! })
      this.store.addCandidate({
        id: `req-${p.taskId}`, runId: p.taskId!, channel: p.channel, chatId: p.chatId,
        sender: p.sender?.name ?? p.sender?.username ?? p.sender?.id ?? null,
        agentId: p.agentId, text: p.fullMessage ?? p.messagePreview, now,
      })
    })
  }

  taskCompleted(p: AgentXEvents["task:completed"]): void {
    if (!p.taskId) return
    this.guard("run end", () => {
      const key = chatKey(p.agentId, p.channel, p.chatId)
      if (this.live.get(key)?.runId === p.taskId) this.live.delete(key)
      const req = this.store.byLink("run", p.taskId!)
      if (!req) return
      const now = this.now()
      // Cut by a shutdown: the next boot decides (resumeOutcome).
      if (p.interrupted) return
      // Stopped on purpose is not a failure.
      if (p.error && p.errorKind !== "cancelled") {
        const word = failureWord(p.error)
        if (this.store.needsAttention(req.id, `${p.agentId} ${word}: ${clip(p.error)}`, now)) {
          this.log(`[requests] ${req.id} needs attention: run ${p.taskId} ${word}`)
        }
        return
      }
      if (req.state === "candidate") this.store.discardCandidate(req.id)
      else this.store.touch(req.id, now)
    })
  }

  delegationStarted(d: DelegationSignal): void {
    if (!this.settings().enabled) return
    this.guard("delegation start", () => {
      const turn = this.live.get(chatKey(d.caller, d.origin.channel, d.origin.chatId))
      if (!turn) return
      const now = this.now()
      this.store.link(turn.requestId, "delegation", d.id, now)
      this.store.progress(turn.requestId, now, "waiting_other")
    })
  }

  delegationDone(d: DelegationSignal, status: "done" | "error" | "timeout" | "lost", text: string): void {
    this.guard("delegation end", () => {
      const req = this.store.byLink("delegation", d.id)
      if (!req) return
      const now = this.now()
      const who = d.peer ? `${d.callee} on ${d.peer}` : d.callee
      if (status === "done") {
        // The answer is back with the asking agent. Still open: closing is explicit.
        this.store.progress(req.id, now)
        return
      }
      const what = { error: "failed", timeout: "did not answer in time", lost: "was lost in a restart" }[status]
      if (this.store.needsAttention(req.id, `The work handed to ${who} ${what}: ${clip(text)}`, now)) {
        this.log(`[requests] ${req.id} needs attention: delegation ${d.id} ${status}`)
      }
    })
  }

  /** The agent raised a decision card from the turn of a request: the
   *  request now waits on the owner, with the card's question. The card's
   *  own reminders (inbox, Mac card, check-ins, digest) do the reminding. */
  cardRaised(card: { id: string; raised_by: string; ask: string; reply?: { channel: string; chatId: string } }): void {
    if (!this.settings().enabled || !card.reply) return
    this.guard("card", () => {
      const requestId = this.live.get(chatKey(card.raised_by, card.reply!.channel, card.reply!.chatId))?.requestId
      if (!requestId) return
      const now = this.now()
      this.store.link(requestId, "card", card.id, now)
      this.store.waitOnOwner(requestId, card.ask, now)
    })
  }

  /** A linked card was answered or expired. An answer, or an expiry whose
   *  default is "approve", lets the work go on. Any other expiry means the
   *  answer never came: the request needs attention. It does not close. */
  cardResolved(card: { id: string; status: string; ask: string; if_silent?: string; outcome?: string }): void {
    this.guard("card result", () => {
      const req = this.store.byLink("card", card.id)
      if (!req || req.state !== "waiting_owner") return
      const now = this.now()
      const applied = card.outcome ?? card.if_silent
      if (card.status === "decided" || applied === "approve") this.store.progress(req.id, now)
      else if (this.store.needsAttention(req.id, `Your answer did not come before the card expired (${clip(card.ask)}); "${applied}" was applied`, now)) {
        this.log(`[requests] ${req.id} needs attention: card ${card.id} expired unanswered`)
      }
    })
  }

  /** What the boot-time resume step did with a run the restart cut off. */
  resumeOutcome(o: { taskId: string; decision: string; reason: string }): void {
    this.guard("restart", () => {
      const req = this.store.byLink("run", o.taskId)
      if (!req) return
      const now = this.now()
      if (o.decision === "resumed") this.store.progress(req.id, now)
      else if (o.decision === "reported" || o.decision === "resume-failed") {
        if (this.store.needsAttention(req.id, `Cut off by a restart and not picked up again (${clip(o.reason)})`, now)) {
          this.log(`[requests] ${req.id} needs attention: run ${o.taskId} cut off by a restart`)
        }
      }
    })
  }
}
