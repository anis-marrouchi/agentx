// --- Bayan signals: an unclear hand-off or reply, on its sender (#1998) ---
//
// Found from text and records the daemon already has, with no model call:
//
//   clarification_asked  the receiver of a hand-off asked back instead of starting
//   handoff_refused      the receiver was blocked by missing information
//   a2a_extra_rounds     the work started only after one of those, on the same
//                        (caller, callee, root)
//   owner_asked_subject  the owner asked what the agent's reply was about
//
// Each hand-off signal is recorded on the sender, so the #1996 rule goes to
// the sender, and only when the sender is an agent of this node and the
// hop was local: the hand-off row this node wrote names it as the caller,
// with no peer (B1). `ref` is the hand-off id; a round is keyed on the
// root of its hand-off row (B2). An a2a run with no hand-off row (the
// synchronous send paths) is not checked in v1.
//
// Every check runs on a later tick, after the reply or at the owner's turn
// start, and never throws. Each read is indexed and bounded by time.

import type Database from "better-sqlite3"
import { delegationIdOfChat } from "@/a2a/delegation"
import { withoutStateLines, type EndState } from "@/agents/run-state"
import { isPersonChannel } from "@/agents/work-lane"
import { emitSignal, signalDb, type Signal } from "./signals"
import type { RunEnd } from "./awareness"

/** How far back earlier rounds of a hand-off are looked for. */
export const ROUND_WINDOW_MS = 2 * 3_600_000
/** How far back the agent's reply is looked for when the owner asks. */
export const REPLY_WINDOW_MS = 6 * 3_600_000
/** Only the end of an answer is read for the question back. */
const TAIL_CHARS = 400
/** An owner message longer than this is not a "what is this about?". */
export const SUBJECT_MAX_CHARS = 80
const MAX_EARLIER = 50

/** Words of a question that asks what is meant or what is missing. */
const ASK_RE = /\b(?:which|what do you mean|clarify|do you want|should i|please (?:send|provide|share|confirm)|can you (?:send|provide|share|confirm)|missing|not sure what|lequel|laquelle|tu veux dire|vous voulez dire)\b/i
/** A blocked state's why that names missing input. */
const MISSING_RE = /\b(?:missing|not given|no (?:brief|link|id|issue|details?|spec|access)|needs? the|unclear|not specified|which .+ (?:do|did) you mean)\b/i

/** The owner's phrases for "what is this about?" (owner question 1 of
 *  #1998: a constant, not a setting). Matched anywhere in a short message. */
export const SUBJECT_PHRASES = [
  "what is this about", "what's this about", "what is it about", "what is that about", "what are you talking about", "what do you mean",
  "c'est quoi ça", "c'est quoi ca", "de quoi tu parles", "de quoi s'agit", "à propos de quoi", "a propos de quoi",
  "chnowa hedha", "chnoua hedha", "chnowa hedhi", "3la chnowa", "3la chnoua", "ach ma3neha",
  "شنوة هذا", "شنوة هذه", "على شنوة", "آش معناها", "ما هذا", "عن ماذا",
]
/** Short forms that count only as the whole message. */
export const SUBJECT_WHOLE = ["which one", "about what", "chnowa", "chnoua", "شنوة", "شنو"]

/** The agent id of an `agent:<id>` sender that is an agent of this registry. */
export function senderAgentOf(sender: string | null | undefined, isAgent: (id: string) => boolean): string | null {
  const m = typeof sender === "string" ? /^agent:([\w.-]+)$/.exec(sender) : null
  return m && isAgent(m[1]) ? m[1] : null
}

/** The last question in the answer's tail, state lines taken out first. */
export function lastQuestion(content: string | undefined): string | null {
  const tail = withoutStateLines(content ?? "").slice(-TAIL_CHARS)
  const qs = tail.match(/[^.!?\n]*\?/g)
  return qs ? qs[qs.length - 1].trim() : null
}

export type RunKind = "refused" | "asked" | "working" | "other"

/** What a callee's run did with its hand-off. One event, one kind:
 *  blocked for missing input is a refusal even when it asks too. */
export function classifyRun(content: string | undefined, state: EndState | undefined): RunKind | null {
  if (!state || state.state === "stalled") return null
  if (state.state === "blocked" && MISSING_RE.test(state.why)) return "refused"
  if (state.state === "waiting" || state.state === "blocked") {
    const q = lastQuestion(content)
    if (q && ASK_RE.test(q)) return "asked"
  }
  return state.state === "blocked" ? "other" : "working"
}

export interface HandoffRef { id: string; caller: string | null; callee: string | null; peer: string | null; rootJson: string | null; startedAt: number | null }

/** The root's identity, or null when it cannot tell two jobs apart. */
export function rootKeyOf(rootJson: string | null): string | null {
  try {
    const r = JSON.parse(rootJson ?? "null")
    if (!r || typeof r !== "object" || !r.chatId) return null
    return JSON.stringify([r.kind ?? null, r.channel ?? null, r.chatId, r.sender ?? null, r.agentId ?? null, r.person ?? null])
  } catch {
    return null
  }
}

/** The asks of earlier rounds on the same (caller, callee, root) since the
 *  last round already counted. Two indexed reads, bounded by time. */
export function earlierAsks(db: Database.Database, h: HandoffRef, now: number): number {
  const root = rootKeyOf(h.rootJson)
  if (!root || !h.caller || !h.callee) return 0
  const since = now - ROUND_WINDOW_MS
  const ids = (db.prepare(
    `SELECT id, root_json AS rootJson FROM handoffs INDEXED BY idx_handoffs_started
     WHERE started_at >= ? AND caller = ? AND callee = ? AND id <> ? ORDER BY started_at DESC LIMIT ${MAX_EARLIER}`,
  ).all(since, h.caller, h.callee, h.id) as Array<{ id: string; rootJson: string | null }>)
    .filter((r) => rootKeyOf(r.rootJson) === root)
    .map((r) => r.id)
  if (!ids.length) return 0
  const rows = db.prepare(
    `SELECT kind FROM improve_signals WHERE agent_id = ? AND at >= ?
     AND kind IN ('clarification_asked', 'handoff_refused', 'a2a_extra_rounds') AND ref IN (${ids.map(() => "?").join(",")})
     ORDER BY at, id`,
  ).all(h.caller, since, ...ids) as Array<{ kind: string }>
  let n = 0
  for (const r of rows) n = r.kind === "a2a_extra_rounds" ? 0 : n + 1
  return n
}

/** The signal for a callee's run, given its hand-off. Pure. */
export function bayanSignal(run: RunEnd, kind: RunKind, h: HandoffRef, asks: number): Signal | null {
  const sender = h.caller!
  const callee = run.agentId
  if (kind === "refused") return { kind: "handoff_refused", agentId: sender, ref: h.id, detail: `missing information -> ${callee}: blocked` }
  if (kind === "asked") return { kind: "clarification_asked", agentId: sender, ref: h.id, detail: `${callee} asked back before starting` }
  if (kind === "working" && asks > 0) return { kind: "a2a_extra_rounds", agentId: sender, ref: h.id, detail: `${callee}: ${asks + 1} rounds before work started` }
  return null
}

/** Record a callee's run-end Bayan signal. Never throws. */
export function emitBayanSignals(run: RunEnd, isAgent: (id: string) => boolean, now = Date.now()): void {
  try {
    if ((run.channel ?? "").split("@")[0] !== "a2a") return
    const sender = senderAgentOf(run.sender, isAgent)
    if (!sender || sender === run.agentId) return
    const id = delegationIdOfChat(run.chatId)
    if (!id) return
    const kind = classifyRun(run.content, run.jobState)
    if (!kind || kind === "other") return
    const db = signalDb()
    if (!db) return
    const h = db.prepare(
      "SELECT id, caller, callee, peer, root_json AS rootJson, started_at AS startedAt FROM handoffs WHERE id = ?",
    ).get(id) as HandoffRef | undefined
    // Only a hand-off this node wrote, from a local agent to a local agent.
    if (!h || h.caller !== sender || h.callee !== run.agentId || h.peer) return
    const s = bayanSignal(run, kind, h, kind === "working" ? earlierAsks(db, h, now) : 0)
    if (s) emitSignal(s, now)
  } catch (e: any) {
    console.warn(`[improve] bayan signals skipped for ${run.taskId}: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

export function queueBayanSignals(run: RunEnd, isAgent: (id: string) => boolean): void {
  try {
    setImmediate(() => emitBayanSignals(run, isAgent))
  } catch { /* never in the reply's way */ }
}

// --- The owner asks what a reply was about ---

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").replace(/^[\s?!.؟…,]+|[\s?!.؟…,]+$/g, "")

/** A short owner message asking what a reply was about. */
export function asksSubject(text: string | undefined): boolean {
  const raw = (text ?? "").trim()
  if (!raw || raw.length > SUBJECT_MAX_CHARS) return false
  const t = norm(raw)
  return SUBJECT_WHOLE.includes(t) || SUBJECT_PHRASES.some((p) => t.includes(p))
}

/** The channel as written in a detail: a person channel, else "other". */
export function channelLabel(channel: string | undefined): string {
  return channel && isPersonChannel(channel) ? channel : "other"
}

export interface OwnerTurn {
  taskId: string
  agentId: string
  channel: string
  chatId: string
  text?: string
  startedAt: number
  /** Questions of the agent caught in this chat that still waited on the
   *  owner when the turn started: then "which one?" answers them. */
  waitingQuestions: number
}

/** Record owner_asked_subject on the agent that replied. Never throws. */
export function emitOwnerSubjectSignal(t: OwnerTurn, now = Date.now()): void {
  try {
    if (t.waitingQuestions > 0 || !asksSubject(t.text)) return
    const db = signalDb()
    if (!db) return
    // The agent's reply in this chat before this turn, never the turn itself.
    const replied = db.prepare(
      `SELECT 1 FROM task_traces INDEXED BY idx_traces_agent_started
       WHERE agent_id = ? AND started_at >= ? AND started_at < ? AND channel = ? AND chat_id = ? AND task_id <> ?
       AND final_response IS NOT NULL LIMIT 1`,
    ).get(t.agentId, t.startedAt - REPLY_WINDOW_MS, t.startedAt, t.channel, t.chatId, t.taskId)
    if (!replied) return
    emitSignal({ kind: "owner_asked_subject", agentId: t.agentId, ref: t.taskId, detail: `the owner asked what the reply was about (${channelLabel(t.channel)})` }, now)
  } catch (e: any) {
    console.warn(`[improve] owner subject signal skipped for ${t.taskId}: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

export function queueOwnerSubjectSignal(t: OwnerTurn): void {
  try {
    setImmediate(() => emitOwnerSubjectSignal(t))
  } catch { /* never in the owner's way */ }
}
