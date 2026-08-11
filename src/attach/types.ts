// --- Attach mode: wear agentx inside a live Claude Code session ---
//
// Normally the daemon OWNS the loop: a message arrives, agentx spawns a
// `claude` subprocess, feeds it a prompt, collects the result. Attach mode
// inverts that. A Claude Code session that is already open — the one a human
// is typing into — registers itself with the daemon and becomes addressable
// as an agent. Inbound channel traffic is offered to that session instead of
// spawning a fresh process.
//
// The session cannot be pushed to: its stdin belongs to the human. So the
// daemon never initiates. It queues, and Claude Code's own hooks pull:
//
//   SessionStart      -> register the session (id, cwd, model)
//   UserPromptSubmit  -> piggyback a "N pending" note onto the human's turn
//   Stop              -> the drain point. Depending on the session's delivery
//                        mode we stay silent, mention the backlog, or return
//                        {decision:"block", reason:<msg>} which makes Claude
//                        Code continue the conversation with that message as
//                        input. That is the whole trick.
//   SessionEnd        -> deregister; anything still queued falls back to spawn
//
// Everything here is in-memory on purpose. Attach state is a property of live
// processes, not of the world: if the daemon restarts, the next hook event
// from any session re-registers it. There is nothing worth persisting and
// therefore no schema migration.

/** How aggressively a session's Stop hook drains its inbox. */
export type DeliveryMode =
  /** Never volunteer anything. The human drains with `/inbox`. */
  | "manual"
  /** Mention the backlog in a systemMessage; don't take the turn. Default. */
  | "notify"
  /** Take the turn: block the stop and answer until the inbox is empty. */
  | "auto"

export const DELIVERY_MODES: readonly DeliveryMode[] = ["manual", "notify", "auto"] as const

export function isDeliveryMode(v: unknown): v is DeliveryMode {
  return typeof v === "string" && (DELIVERY_MODES as readonly string[]).includes(v)
}

/**
 * Lifecycle of one offered message.
 *
 *   pending ──claim()──► claimed ──answer()──► answered
 *      │                    │
 *      └───expire()────► expired ◄──expire()──┘
 *
 * `expired` is terminal and is the reason attach mode is safe to put in front
 * of production traffic: the dispatcher only waits a bounded time for a live
 * session to pick a message up, then atomically expires it and falls back to
 * spawning a provider the normal way. A session that drains late finds
 * nothing, so a message is never answered twice — and never dropped.
 */
export type ItemState = "pending" | "claimed" | "answered" | "expired"

export interface InboxItem {
  id: string
  /** Agent identity this was addressed to (the binding that captured it). */
  agentId: string
  /** Session currently responsible for it. */
  sessionId: string
  state: ItemState
  /** The message text as the channel delivered it. */
  text: string
  /** Where it came from — used for the "[telegram/@bob]" prefix on drain. */
  channel: string
  chatId: string
  sender: string
  createdAt: number
  claimedAt?: number
  settledAt?: number
  /** Set once the session produces a reply. */
  answer?: string
}

export interface AttachSession {
  /** Claude Code's own session id (`CLAUDE_CODE_SESSION_ID` / hook stdin). */
  sessionId: string
  cwd: string
  /** Agent identities this session answers for. Usually one. */
  agentIds: string[]
  mode: DeliveryMode
  /** Last time any hook event was seen — drives stale-session reaping. */
  lastSeenAt: number
  registeredAt: number
  /** Model string when Claude Code reported one on SessionStart. */
  model?: string
  /** Item currently handed to the session and awaiting its reply. At most one
   *  — a session answers serially, so the next Stop's `last_assistant_message`
   *  is unambiguously the answer to this item. */
  awaitingAnswer?: string
  /** Items drained in the current Stop-hook chain, reset when the session
   *  actually stops. Bounds the auto-drain loop. */
  drainedThisTurn: number
}

/** Tunables. Deliberately not config-file-backed yet — these are runtime
 *  ergonomics, and every one of them has a defensible default. Promote to
 *  agentx.json only if a real deployment needs to differ. */
export interface AttachOptions {
  /** How long the dispatcher waits for a live session to claim a message
   *  before giving up and spawning a provider instead. */
  claimTimeoutMs: number
  /** How long after its last hook event a session is considered gone. Claude
   *  Code fires no heartbeat, so a session the human abandoned mid-turn would
   *  otherwise hold its bindings forever. */
  staleSessionMs: number
  /** Max items one Stop-hook chain will drain before letting the session
   *  stop. Prevents a flood of queued messages from hijacking a whole turn. */
  maxDrainPerTurn: number
  /** Longest single message injected into a session's context. */
  maxItemChars: number
}

export const DEFAULT_ATTACH_OPTIONS: AttachOptions = {
  claimTimeoutMs: 90_000,
  staleSessionMs: 15 * 60_000,
  maxDrainPerTurn: 5,
  maxItemChars: 4_000,
}

/** What the Stop hook should hand back to Claude Code. Mirrors the documented
 *  hook output contract; `service.ts` serializes it. */
export interface StopDecision {
  /** Present only in `auto` mode when we want the session to keep going. */
  decision?: "block"
  reason?: string
  systemMessage?: string
  suppressOutput?: boolean
}
