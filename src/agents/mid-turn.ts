// --- Messages that reach a run while it works (mid-turn) ---
//
// An agent used to be deaf while it worked: a message in the same chat
// waited for the whole run to end (queued, or the phone app holding the
// request open), and a correction ("not that one, the other file") came
// after the work it was meant to stop. Interactive Claude Code passes a
// message typed while it works to the model as soon as the current tool
// calls finish, in the same turn. This does the same for AgentX runs.
//
// A message for an agent with a run going in that same chat is offered
// here, and still follows its usual path (queued, or waiting for the
// chat). A PostToolUse hook in the agent's workspace asks the daemon after
// every tool call (GET /runs/inbox); a message waiting for that chat is
// handed to the model as added context and marked taken. A taken message
// is then not run again: the queue drops it, and a caller waiting on it is
// answered that it went into the running turn. A message the run never
// took (it ended before another tool call) goes on as before, as the next
// turn. Kept in memory: a restart ends the runs it was offered to.

export const MID_TURN_MARKER = "[agentx:mid-turn"
export const DELIVERED_TEXT = "Delivered into the run that was already working in this chat: it read this before it finished, and its answer covers it."
/** The same, to be spoken (AgentX Voice, a spoken question in the app). */
export const DELIVERED_SPOKEN = "Got it, I passed that on to the work in progress."
/** How long a taken message is remembered for the caller still waiting on it. */
const TAKEN_TTL_MS = 2 * 3_600_000
const TEXT_CLIP = 4000

export interface MidTurnEntry {
  id: string
  key: string
  runId: string
  text: string
  from: string
  at: number
}

export function midTurnKey(agentId: string, channel: string, chatId: string): string {
  return `${agentId}\u0000${channel}\u0000${chatId}`
}

/** Channels whose messages are a person's or another agent's words to the
 *  run, worth hearing mid-turn. Internal turns (a plan step, a schedule, a
 *  workflow node) never are. */
const SKIP_CHANNELS = new Set(["requests", "cron", "workflow", "events", "reminder", "business", "sprint", "notices"])

export function midTurnChannel(channel: string | undefined): boolean {
  return !!channel && !SKIP_CHANNELS.has(channel)
}

/** Whether a message in this chat may be offered to the run going in it.
 *  A /send/agent call that names no sender lands in the shared a2a chat
 *  "a2a": every sender-less send shares it, so a second one is not a
 *  follow-up to the run going there but unrelated work, and must get a
 *  turn (and an answer) of its own. */
export function midTurnChat(channel: string | undefined, chatId: string | undefined): boolean {
  if (!midTurnChannel(channel) || !chatId) return false
  return !(channel === "a2a" && chatId === "a2a")
}

export class MidTurnInbox {
  private byKey = new Map<string, MidTurnEntry[]>()
  private taken = new Map<string, number>()
  private seq = 0

  constructor(private readonly opts: { now?: () => number } = {}) {}

  private now(): number { return this.opts.now?.() ?? Date.now() }

  /** Offer a message to the run `runId` going in this chat. */
  offer(key: string, runId: string, text: string, from: string): MidTurnEntry {
    const e: MidTurnEntry = { id: `mt-${this.now().toString(36)}-${++this.seq}`, key, runId, text: text.length > TEXT_CLIP ? text.slice(0, TEXT_CLIP - 1) + "…" : text, from, at: this.now() }
    const list = this.byKey.get(key) ?? []
    list.push(e)
    this.byKey.set(key, list)
    return e
  }

  /** The hook's call: every message waiting for this chat, oldest first,
   *  marked taken. */
  take(key: string): MidTurnEntry[] {
    const list = this.byKey.get(key)
    if (!list?.length) return []
    this.byKey.delete(key)
    const now = this.now()
    for (const e of list) this.taken.set(e.id, now)
    this.prune(now)
    return list
  }

  isTaken(id: string | undefined): boolean {
    return !!id && this.taken.has(id)
  }

  /** The run ended: what it never took goes on its usual way. */
  endRun(runId: string): void {
    for (const [key, list] of this.byKey) {
      const left = list.filter((e) => e.runId !== runId)
      if (left.length) this.byKey.set(key, left)
      else this.byKey.delete(key)
    }
  }

  /** The run in this chat ended: what it never took goes on its usual way
   *  (the queue or the waiting caller), never to a later run. */
  endChat(key: string): void {
    this.byKey.delete(key)
  }

  pending(key: string): number {
    return this.byKey.get(key)?.length ?? 0
  }

  private prune(now: number): void {
    for (const [id, at] of this.taken) if (now - at > TAKEN_TTL_MS) this.taken.delete(id)
  }
}

/** What the model reads after its tool call. */
export function midTurnContext(entries: MidTurnEntry[]): string {
  const lines = entries.map((e) => `- ${new Date(e.at).toISOString().slice(11, 16)}Z, ${e.from}: ${e.text}`)
  return [
    `${MID_TURN_MARKER} count=${entries.length}]`,
    `While you were working, ${entries.length === 1 ? "this message" : "these messages"} arrived in this chat:`,
    ...lines,
    "Take it into account now. If it changes what you should do, change course before your next step. In your answer, say that you saw it and what you did about it. It will not be sent to you again.",
  ].join("\n")
}

/** The PostToolUse hook's output: added context, or nothing. */
export function hookOutput(entries: MidTurnEntry[]): string {
  if (!entries.length) return ""
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: midTurnContext(entries) } })
}
