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
 *
 * The same class keeps the home lease (#2084): one run at a time per agent
 * and named home (an issue, a merge request, a pull request). See
 * `enterHome`.
 */

import { emitSignal } from "@/improve/signals"

const REQUEST_ID = /\breq-[0-9A-HJKMNP-TV-Z]{26}\b/
/** How long a run waits for the holder before it goes ahead anyway. */
export const LANE_WAIT_MS = 15 * 60_000
/** How long a peer's task waits for its home's lane and a slot (#2084):
 *  under mesh.sendTask's 30 min cap, so the peer reads the refusal. */
export const MESH_TASK_WAIT_MS = 20 * 60_000
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

/** A home the lease keys on (#2084): a qualified issue, pull request or
 *  merge request ref (`group/project#12`, `owner/repo#12`,
 *  `group/project!12`). A bare `#12` or `!12` names different work in
 *  every repository, and prose is no home: both give null. */
export function leaseHomeOf(home: string | undefined | null): string | null {
  if (!home) return null
  return /^[\w.-]+(?:\/[\w.-]+)+[#!]\d+$/.test(home) ? home : null
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
        // The wait ran out: two runs now do the same work (#1997). A wait
        // the caller cut short (abort) starts no second run of its own.
        if (!signal?.aborted) {
          emitSignal({ kind: "duplicate_session", agentId, ref: key, detail: `two runs on one request: the lane wait ran out after ${Math.round(waitMs / 60_000)} min` })
        }
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

  // ── Home lease (#2084) ───────────────────────────────────────────────
  // One run at a time per agent and named home. Unlike the request lane
  // above: waiters are served first in, first out; there is no same-root
  // skip (a hand-back always waits for the holder); and a waiter whose
  // caller left or whose wait budget ran out leaves the line and never
  // runs, so a retry is never a second run of the same work.

  private homeHolders = new Map<string, HomeHolder>()
  private homeLines = new Map<string, string[]>()
  private homeSeq = 0

  /** Who holds `home` for `agentId`, if anyone. */
  homeHolder(agentId: string, home: string): { holderId: string; taskId?: string; startedAt: number } | null {
    const h = this.homeHolders.get(homeLane(agentId, home))
    return h ? { holderId: h.holderId, taskId: h.taskId, startedAt: h.startedAt } : null
  }

  /** How many runs wait for `home` of `agentId`. */
  homeWaiting(agentId: string, home: string): number {
    return this.homeLines.get(homeLane(agentId, home))?.length ?? 0
  }

  /** Wait for the lease on (`agentId`, `home`), then hold it. With no
   *  `deadline` the waiter waits its turn however long it takes (nobody
   *  awaits a forge comment's answer). `onWait` is called once, when the
   *  run has to wait, with the holder it waits for. */
  async enterHome(agentId: string, home: string, opts: HomeEnterOptions = {}): Promise<HomeEntry | HomeRefusal> {
    const lane = homeLane(agentId, home)
    const start = this.now()
    const id = `lease-${(++this.homeSeq).toString(36)}`
    const line = this.homeLines.get(lane) ?? []
    line.push(id)
    this.homeLines.set(lane, line)
    const leave = () => {
      const l = this.homeLines.get(lane)
      if (!l) return
      const i = l.indexOf(id)
      if (i >= 0) l.splice(i, 1)
      if (!l.length) this.homeLines.delete(lane)
    }
    const source = opts.source ?? "run"
    let told = false
    for (;;) {
      const h = this.homeHolders.get(lane)
      const first = this.homeLines.get(lane)?.[0] === id
      if (!h && first) break
      const blocker = h ? { holderId: h.holderId, ...(h.taskId ? { taskId: h.taskId } : {}) } : { holderId: this.homeLines.get(lane)![0] }
      const name = blocker.taskId ?? blocker.holderId
      if (opts.signal?.aborted) {
        leave()
        this.opts.log?.(`[${agentId}] ${home}: caller gone while waiting for ${name}; not run`)
        return { refused: "caller_gone", ...blocker, waitedMs: this.now() - start }
      }
      if (opts.deadline !== undefined && this.now() >= opts.deadline) {
        leave()
        const waited = Math.round((this.now() - start) / 1000)
        this.opts.log?.(`[${agentId}] ${home}: still held by ${name} after ${waited}s; refused (home_busy), not run`)
        emitSignal({ kind: "home_busy", agentId, ref: home, detail: `${source} refused: ${name} held the home past the wait budget` })
        return { refused: "home_busy", ...blocker, waitedMs: this.now() - start }
      }
      if (!told) {
        told = true
        this.opts.log?.(`[${agentId}] joined ${name} on ${home} from ${source} (queued ${this.homeWaiting(agentId, home)})`)
        emitSignal({ kind: "same_work_joined", agentId, ref: home, detail: `${source} waited for the run on its home` })
        try { opts.onWait?.(blocker) } catch { /* visibility never breaks the lane */ }
      }
      await Promise.race([h?.done ?? Promise.resolve(), (this.opts.sleep ?? defaultSleep)(h ? 1000 : 50)])
    }
    leave()
    let resolve!: () => void
    const done = new Promise<void>((r) => { resolve = r })
    const mine: HomeHolder = { holderId: id, startedAt: this.now(), done }
    this.homeHolders.set(lane, mine)
    const endedKey = `${lane}\u0000ended`
    const last = this.ended.get(endedKey)
    // Only a run that waited for the one before it is told what it said.
    const note = told && last && this.now() - last.at <= LANE_MEMORY_MS ? sameWorkNote(home, last, this.now()) : ""
    let released = false
    return {
      holderId: id,
      note,
      waitedMs: this.now() - start,
      setTaskId: (taskId: string) => { mine.taskId = taskId },
      release: ({ text, ok, ran = true }) => {
        if (released) return
        released = true
        if (this.homeHolders.get(lane) === mine) this.homeHolders.delete(lane)
        if (ran) this.ended.set(endedKey, { at: this.now(), text, ok })
        this.prune()
        resolve()
      },
    }
  }

}

function homeLane(agentId: string, home: string): string {
  return `${agentId}\u0000home:${home}`
}

interface HomeHolder { holderId: string; taskId?: string; startedAt: number; done: Promise<void> }

export interface HomeEnterOptions {
  /** Epoch ms after which a waiter still in the line is refused. */
  deadline?: number
  /** The caller left: the waiter leaves the line and never runs. */
  signal?: AbortSignal
  /** Where the run came from, for the log and the signal. */
  source?: string
  onWait?: (holder: { holderId: string; taskId?: string }) => void
}

export interface HomeEntry extends LaneEntry {
  holderId: string
  /** The holder's running task, once it runs (the task list and events). */
  setTaskId(taskId: string): void
}

export interface HomeRefusal {
  refused: "home_busy" | "caller_gone"
  holderId: string
  taskId?: string
  waitedMs: number
}

export function isHomeRefusal(x: HomeEntry | HomeRefusal): x is HomeRefusal {
  return "refused" in x
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
