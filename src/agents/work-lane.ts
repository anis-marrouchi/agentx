/**
 * One run at a time per agent and owner's request.
 *
 * The same go can reach an agent twice within seconds: once as another
 * agent's message, once as the request plan's step. Each lands in its own
 * chat, so two sessions of the agent did the same work side by side (two
 * servers built at the same minute). A run whose message names an owner's
 * request (`req-<ULID>`) now waits while another run of the same agent
 * holds that request, and starts with a note about what that run said.
 *
 * Person channels never wait here, and a run in the same chain of work
 * (same root) as the holder goes ahead at once: it may be the holder's own
 * hand-off coming back, and waiting would deadlock it.
 */

import { emitSignal } from "@/improve/signals"

const REQUEST_ID = /\breq-[0-9A-HJKMNP-TV-Z]{26}\b/
/** How long a run waits for the holder before it goes ahead anyway. */
export const LANE_WAIT_MS = 15 * 60_000
/** How long a finished run's answer is handed to the next run. */
export const LANE_MEMORY_MS = 45 * 60_000
const NOTE_CLIP = 1500
export const SAME_WORK_MARKER = "[agentx:same-work"

/** Channels where a person waits on the answer: never held back. Includes
 *  the operator's own chats (dashboard, web-chat, tui, admin, test-drive)
 *  and outside visitors (guest, public-api). */
const PERSON_CHANNELS = new Set([
  "app", "telegram", "whatsapp", "voice", "slack", "discord", "email", "sms", "ntfy",
  "dashboard", "web-chat", "tui", "admin", "test-drive", "workflow-editor", "guest", "public-api",
])

export function isPersonChannel(channel: string | undefined): boolean {
  return !!channel && PERSON_CHANNELS.has(channel)
}

/** Agent work no person reads live, where held notices may ride along.
 *  An allowlist: a channel added later (a visitor's chat, a run whose
 *  output code parses) never gets another agent's notices by default. */
const NOTICE_CHANNELS = new Set(["a2a", "cron", "workflow", "reminder", "events", "business"])

export function takesNotices(channel: string | undefined): boolean {
  return !!channel && NOTICE_CHANNELS.has(channel)
}

export function workKeyOf(message: string | undefined, channel: string | undefined): string | null {
  if (!message || isPersonChannel(channel)) return null
  if (message.startsWith(SAME_WORK_MARKER)) return null
  return REQUEST_ID.exec(message)?.[0] ?? null
}

interface Holder { rootId?: string; startedAt: number; done: Promise<void> }
interface Ended { at: number; text: string; ok: boolean }

export interface LaneEntry {
  /** Call when the run ends, with what it answered. `ran: false`: it was
   *  only queued, so there is nothing to tell the next run. */
  release(answer: { text: string; ok: boolean; ran?: boolean }): void
  /** The note to put before the run's message, or "" for none. */
  note: string
  waitedMs: number
}

export class WorkLanes {
  private holders = new Map<string, Holder>()
  private ended = new Map<string, Ended>()

  constructor(private readonly opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; waitMs?: number; log?: (line: string) => void } = {}) {}

  private now(): number { return this.opts.now?.() ?? Date.now() }

  /** Wait for the lane of `agentId` on `key`, then hold it. */
  async enter(agentId: string, key: string, rootId?: string, signal?: AbortSignal): Promise<LaneEntry> {
    const lane = `${agentId}\u0000${key}`
    const start = this.now()
    const waitMs = this.opts.waitMs ?? LANE_WAIT_MS
    let waited = false
    for (;;) {
      const h = this.holders.get(lane)
      if (!h || (rootId && h.rootId === rootId)) break
      if (signal?.aborted || this.now() - start > waitMs) {
        this.opts.log?.(`[${agentId}] ${key}: going ahead beside a run still on it (waited ${Math.round((this.now() - start) / 1000)}s)`)
        break
      }
      if (!waited) {
        this.opts.log?.(`[${agentId}] ${key}: another run of this agent is on it; waiting for it to end`)
        emitSignal({ kind: "same_work_waited", agentId, ref: key, detail: "the same request reached this agent twice while one run was on it" })
      }
      waited = true
      await Promise.race([h.done, (this.opts.sleep ?? defaultSleep)(1000)])
    }
    let resolve!: () => void
    const done = new Promise<void>((r) => { resolve = r })
    const mine: Holder = { rootId, startedAt: this.now(), done }
    const prev = this.holders.get(lane)
    if (!prev) this.holders.set(lane, mine)
    const last = this.ended.get(lane)
    const note = last && this.now() - last.at <= LANE_MEMORY_MS ? sameWorkNote(key, last, this.now()) : ""
    return {
      note,
      waitedMs: this.now() - start,
      release: ({ text, ok, ran = true }) => {
        if (this.holders.get(lane) === mine) this.holders.delete(lane)
        if (ran) this.ended.set(lane, { at: this.now(), text, ok })
        this.prune()
        resolve()
      },
    }
  }

  private prune(): void {
    const cutoff = this.now() - LANE_MEMORY_MS
    for (const [k, e] of this.ended) if (e.at < cutoff) this.ended.delete(k)
  }
}

function sameWorkNote(key: string, last: Ended, now: number): string {
  const mins = Math.max(0, Math.round((now - last.at) / 60_000))
  const text = last.text.length > NOTE_CLIP ? last.text.slice(0, NOTE_CLIP - 1) + "…" : last.text
  return [
    `${SAME_WORK_MARKER} key=${key}]`,
    `Another run of yours worked on ${key} and ended ${mins === 0 ? "just now" : `${mins} min ago`}${last.ok ? "" : " (it failed)"}. It answered:`,
    text || "(no answer)",
    "",
    "Do not do again what it already did. Check the live state, build on it, or say it is already done.",
    "",
    "The new message:",
    "",
  ].join("\n")
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
