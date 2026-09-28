import type { AppUnreadAnswer } from "./app-chat-store"

// --- Phone app chat: several conversations at once (#265) ---
//
// GET /api/app/chat/active feeds the conversation strip at the top of Chat:
// what is running for this phone (held in memory by app-chat.ts) and what
// finished since the phone last opened it (one query on app-chat-store.ts).
// The phone polls it every few seconds while it is on screen, so it stays
// cheap and bounded.
//
// When a turn ends and the phone isn't watching it, the phone is told:
// a banner if the app is open (the phone's own poll sees it), a Web Push to
// that one phone otherwise. The rules for the push live here as pure
// functions so they can be tested without a push service.

/** Chips the strip shows at most. */
export const ACTIVE_LIMIT = 12
/** Characters of the preview line. */
export const PREVIEW_MAX = 120
/** A phone that polled this recently has the app open on screen: it gets a
 *  banner, not a notification. The strip polls every 4 s on Chat and every
 *  10 s on the other tabs. */
export const PRESENCE_MS = 15_000

export type ActiveState = "thinking" | "answering" | "done"

export interface ActiveConversation {
  id: string
  title: string
  agent: string
  agentName: string
  color?: string
  state: ActiveState
  /** How the answer ended, for a finished one. */
  status?: "done" | "error" | "stopped"
  preview: string
  updatedAt: number
}

/** A turn running for one phone, as app-chat.ts holds it. */
export interface RunningTurn {
  id: string
  deviceId: string
  title: string
  agent: string
  agentName?: string
  color?: string
  /** What the agent has written so far. */
  text: string
  startedAt: number
}

/** Running turns first (oldest first, so chips don't jump around), then
 *  unread answers (newest first). A conversation appears once; a running
 *  follow-up wins over its older unread answer. At most `limit`. */
export function buildActive(deviceId: string, running: RunningTurn[], unread: AppUnreadAnswer[], limit = ACTIVE_LIMIT): ActiveConversation[] {
  const out: ActiveConversation[] = []
  const seen = new Set<string>()
  const mine = running.filter((t) => t.deviceId === deviceId).sort((a, b) => a.startedAt - b.startedAt)
  for (const t of mine) {
    if (out.length >= limit) break
    seen.add(t.id)
    const written = lastLine(t.text)
    out.push({
      id: t.id, title: t.title, agent: t.agent, agentName: t.agentName || t.agent,
      ...(t.color ? { color: t.color } : {}),
      state: written ? "answering" : "thinking",
      preview: written || t.title.slice(0, PREVIEW_MAX),
      updatedAt: t.startedAt,
    })
  }
  for (const u of unread) {
    if (out.length >= limit) break
    if (seen.has(u.id)) continue
    seen.add(u.id)
    out.push({
      id: u.id, title: u.title, agent: u.agent, agentName: u.agentName || u.agent,
      ...(u.color ? { color: u.color } : {}),
      state: "done", status: u.status,
      preview: firstLine(u.answer) || (u.status === "done" ? "Answered." : u.status === "stopped" ? "Stopped." : "The agent could not answer."),
      updatedAt: u.at,
    })
  }
  return out
}

/** The first line with words in it, without markdown markers, capped. */
export function firstLine(text: string, max = PREVIEW_MAX): string {
  for (const raw of text.split("\n")) {
    const line = clean(raw)
    if (line) return cap(line, max)
  }
  return ""
}

/** The newest line being written, for a running turn's preview. */
function lastLine(text: string, max = PREVIEW_MAX): string {
  const lines = text.split("\n").map(clean).filter(Boolean)
  return lines.length ? cap(lines[lines.length - 1], max) : ""
}

function clean(line: string): string {
  return line.replace(/^\s*(?:[#>]+|[-*+]\s|\d+\.\s)\s*/, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim()
}

function cap(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s
}

/** When each phone last polled the strip. In memory: a dashboard restart
 *  only means the next finish is announced by push instead of a banner. */
export class AppPresence {
  private seen = new Map<string, number>()
  constructor(private windowMs = PRESENCE_MS) {}
  poll(deviceId: string, now = Date.now()): void { this.seen.set(deviceId, now) }
  away(deviceId: string): void { this.seen.delete(deviceId) }
  open(deviceId: string, now = Date.now()): boolean {
    const at = this.seen.get(deviceId)
    return at !== undefined && now - at <= this.windowMs
  }
}

export interface FinishFacts {
  status: "done" | "error" | "stopped"
  /** The phone is streaming this conversation right now. */
  attached: boolean
  /** The phone has the app open on screen (it shows a banner instead). */
  appOpen: boolean
  /** The phone's "Tell me when an answer finishes" setting. */
  enabled: boolean
}

/** Whether a finished turn becomes a notification on its phone. Never for
 *  the conversation the phone is watching, never for a Stop the owner
 *  pressed, and never when the owner turned it off. */
export function shouldPushFinish(f: FinishFacts): boolean {
  return f.enabled && !f.attached && !f.appOpen && f.status !== "stopped"
}

export interface FinishPush {
  /** Only this phone (its device token id). */
  deviceId: string
  title: string
  body: string
  /** Opens the conversation in the app. */
  url: string
}

export const BODY_MAX = 140

export function finishPush(deviceId: string, conv: { id: string; agent: string; agentName?: string }, status: FinishFacts["status"], answer: string, error?: string): FinishPush {
  const body = status === "error"
    ? `Could not answer: ${firstLine(error || "", BODY_MAX - 18) || "something went wrong."}`
    : firstLine(answer, BODY_MAX) || "Answered."
  return { deviceId, title: cap(conv.agentName || conv.agent, 80), body, url: `/app#chat=${conv.id}` }
}
