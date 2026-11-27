// The orb's talk loop as plain rules (no Electron, no network), so they can
// be tested with plain Node (test/orb-flow.test.mjs). orb-voice.ts runs them.
//
// The loop (#2265 PR 3): hold the orb or the talk key → the orb records and
// shows the words as they come (rolling passes of the node's own speech to
// text) → release → the words go to the agent as a Hub chat message → the
// orb shows the agent working and its words as they arrive → the answer is
// said in the agent's voice, its words on the pill.

/** Hakim C11: live words only on the first 30 s; past it the orb shows the level meter. */
export const LIVE_WORDS_CAP_MS = 30_000
/** A rolling pass at most this often. */
export const LIVE_WORDS_EVERY_MS = 2_500
/** Shorter than this is a tap, not a recording. */
export const MIN_TALK_MS = 350
/** A recording stops by itself after two minutes, as on the phone. */
export const MAX_TALK_MS = 120_000
/** The pill shows the tail of the words, no more than this many characters. */
export const CAPTION_MAX = 140

export type PassDecision = "pass" | "skip" | "meter"

/**
 * Whether to run a rolling pass now (C11): never two at a time (skip while
 * the last one runs), never too often, and none past the cap (meter only).
 */
export function livePass(i: { busy: boolean; recordedMs: number; sinceLastMs: number }): PassDecision {
  if (i.recordedMs > LIVE_WORDS_CAP_MS) return "meter"
  if (i.busy || i.sinceLastMs < LIVE_WORDS_EVERY_MS) return "skip"
  return "pass"
}

/** The last words, whole words only, with "…" in front when cut: the live caption. */
export function caption(text: string, max = CAPTION_MAX): string {
  const t = String(text || "").replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  const tail = t.slice(t.length - max)
  const space = tail.indexOf(" ")
  return "…" + (space > 0 && space < 24 ? tail.slice(space + 1) : tail)
}

/** The first words of an answer, whole words only, with "…" after when cut: what the orb says. */
export function opening(text: string, max = CAPTION_MAX): string {
  const t = String(text || "").replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const space = head.lastIndexOf(" ")
  return (space > max - 24 ? head.slice(0, space) : head) + "…"
}

/** The token a dashboard page on this machine carries (window.AX_LOCAL_TOKEN), or "" when it has none. */
export function pageTokenOf(html: string): string {
  const m = /window\.AX_LOCAL_TOKEN\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html)
  if (!m) return ""
  try {
    const v = JSON.parse(m[1]) as unknown
    return typeof v === "string" ? v : ""
  } catch {
    return ""
  }
}

export interface AgentLike {
  id?: string
  name?: string
}

/**
 * The agent the orb talks to, as the Swift widget picks it: the chosen one
 * while it exists, else the daemon's node.defaultAgent, else the node's first.
 */
export function pickAgent(list: readonly AgentLike[], chosen: string, nodeDefault = ""): { id: string; name: string } | null {
  const agents = list.map((a) => ({ id: a.id || a.name || "", name: a.name || a.id || "" })).filter((a) => a.id)
  return agents.find((a) => a.id === chosen) || agents.find((a) => a.id === nodeDefault) || agents[0] || null
}

export interface ThreadMessage {
  role?: string
  status?: string
  content?: string
}

export type AnswerState = { kind: "working"; partial: string } | { kind: "done"; text: string } | { kind: "failed"; why: string }

/**
 * Where the answer to the last message stands, from a Hub thread read
 * (GET /api/assistant/thread). `after` is how many messages the thread had
 * before the orb sent its own, so an older answer is never read as new.
 */
export function answerOf(messages: readonly ThreadMessage[], after: number): AnswerState {
  const mine = messages.slice(Math.max(0, after))
  const last = [...mine].reverse().find((m) => m.role === "assistant")
  if (!last) return { kind: "working", partial: "" }
  const s = last.status || "done"
  if (s === "done") return last.content ? { kind: "done", text: last.content } : { kind: "failed", why: "The agent gave no answer." }
  if (s === "failed" || s === "error" || s === "cancelled" || s === "stopped") return { kind: "failed", why: last.content || `The run ${s}.` }
  return { kind: "working", partial: last.content || "" }
}
