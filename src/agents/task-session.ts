// --- One chat's runs as a session, for the Task page (#2101 R4) ---
//
// A follow-up is a new run in the same chat as the one before it: same agent,
// same channel, same chatId. The Task page opened on one run shows the whole
// session in order (the first request, earlier turns, the selected run and
// any after it), so this module answers "which runs share this run's chat?".
//
// The saved run records (.agentx/task-history/<agent>/<day>/<id>.json) are the
// one source. Each file opens with id, agentId, channel and chatId, so the
// index reads only a file's first bytes, once per agent, and the registry adds
// each new record as it is written. Scope is exact: one agent, one channel, one
// chatId. A run with no chatId is a session of one.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "fs"
import { resolve } from "path"
import { JOB_STATE_RULE } from "./run-state"

/** What one turn of a session shows. The selected run keeps its own stream,
 *  so no turn carries a transcript. */
export interface SessionTurn {
  id: string
  sender?: string
  message: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  ok?: boolean
  error?: string
  responseText?: string
  /** Running now: not saved yet. */
  running?: boolean
  /** Its place in the session, from 1. */
  n?: number
}

export interface SessionPage {
  /** null when the run has no chat to share (a session of one). */
  session: { channel: string; chatId: string; turns: number } | null
  selected: string
  /** The session's first turn when it is older than this page. */
  first: SessionTurn | null
  /** Chronological. */
  turns: SessionTurn[]
  /** Pass as `before` to read the turns older than this page. */
  olderBefore: string | null
}

/** A run still running: the registry's view of it. */
export interface LiveRun {
  id: string
  channel: string
  chatId?: string
  sender?: string
  message: string
  requestText?: string
  startedAt: Date | string
}

const HEAD_BYTES = 2048
const RESPONSE_MAX = 20_000
export const SESSION_PAGE_DEFAULT = 10
export const SESSION_PAGE_MAX = 50

type Ref = { id: string; day: string }

function sessionKey(channel: string, chatId: string): string { return channel + "\u0000" + chatId }
function safe(s: string): string { return s.replace(/[^a-zA-Z0-9_.:-]/g, "_") }

/** channel and chatId from the start of a saved record. */
export function readHead(text: string): { channel: string; chatId: string } | null {
  const ch = /"channel":\s*("(?:[^"\\]|\\.)*")/.exec(text)
  const chat = /"chatId":\s*("(?:[^"\\]|\\.)*")/.exec(text)
  if (!ch || !chat) return null
  try { return { channel: JSON.parse(ch[1]), chatId: JSON.parse(chat[1]) } } catch { return null }
}

function readFileHead(file: string): string {
  let fd = -1
  try {
    fd = openSync(file, "r")
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString("utf-8")
  } catch { return "" } finally { if (fd >= 0) try { closeSync(fd) } catch { /* closed */ } }
}

/** What a turn asked: the typed request when it was saved apart, else the
 *  message without the job-state rule the daemon put before it. */
export function askText(r: { message?: unknown; requestText?: unknown }): string {
  const typed = typeof r.requestText === "string" ? r.requestText.trim() : ""
  if (typed) return typed
  const m = String(r.message || "")
  return m.startsWith(JOB_STATE_RULE) ? m.slice(JOB_STATE_RULE.length) : m
}

/** Run ids start with their start time in ms, so id order is time order. */
function byId(a: Ref, b: Ref): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

export class TaskSessionIndex {
  private agents = new Map<string, Map<string, Ref[]>>()
  constructor(private root: string) {}

  private build(agentId: string): Map<string, Ref[]> {
    const have = this.agents.get(agentId)
    if (have) return have
    const map = new Map<string, Ref[]>()
    const dir = resolve(this.root, safe(agentId))
    if (existsSync(dir)) {
      let days: string[] = []
      try { days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } catch { /* unreadable */ }
      for (const day of days) {
        let files: string[] = []
        try { files = readdirSync(resolve(dir, day)).filter((f) => f.endsWith(".json")) } catch { continue }
        for (const f of files) {
          const head = readHead(readFileHead(resolve(dir, day, f)))
          if (!head || !head.chatId) continue
          const k = sessionKey(head.channel, head.chatId)
          const list = map.get(k) || []
          list.push({ id: f.slice(0, -5), day })
          map.set(k, list)
        }
      }
      for (const list of map.values()) list.sort(byId)
    }
    this.agents.set(agentId, map)
    return map
  }

  /** A record was just saved: keep a built index current. */
  note(rec: { id: string; agentId: string; channel: string; chatId?: string; endedAt: string }): void {
    const map = this.agents.get(rec.agentId)
    if (!map || !rec.chatId) return
    const k = sessionKey(rec.channel, rec.chatId)
    const list = map.get(k) || []
    if (!list.some((r) => r.id === safe(rec.id))) {
      list.push({ id: safe(rec.id), day: rec.endedAt.slice(0, 10) })
      list.sort(byId)
    }
    map.set(k, list)
  }

  /** Forget everything (the retention sweep removed folders). */
  reset(): void { this.agents.clear() }

  private readTurn(agentId: string, ref: Ref): SessionTurn | null {
    try {
      const r = JSON.parse(readFileSync(resolve(this.root, safe(agentId), ref.day, ref.id + ".json"), "utf-8"))
      const resp = String(r.responseText || "")
      return {
        id: r.id, sender: r.sender, message: askText(r), startedAt: r.startedAt, endedAt: r.endedAt,
        durationMs: r.durationMs, ok: r.ok, error: r.error,
        responseText: resp.length > RESPONSE_MAX ? resp.slice(0, RESPONSE_MAX) + "\n\n…[cut, open this turn for all of it]" : resp,
      }
    } catch { return null }
  }

  private findSaved(agentId: string, taskId: string): { head: { channel: string; chatId: string } | null; ref: Ref } | null {
    const dir = resolve(this.root, safe(agentId))
    if (!existsSync(dir)) return null
    const id = safe(taskId)
    let days: string[] = []
    try { days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() } catch { return null }
    for (const day of days) {
      const file = resolve(dir, day, id + ".json")
      if (existsSync(file)) return { head: readHead(readFileHead(file)), ref: { id, day } }
    }
    return null
  }

  /**
   * The session page around one run. First read (no `before`): the `limit`
   * turns up to and including the selected run, then up to `limit` after it.
   * With `before`: the `limit` turns older than that id. `live` are the
   * agent's running runs, which are not saved yet. Returns null when the run
   * is neither saved nor running.
   */
  page(agentId: string, taskId: string, live: LiveRun[], opts: { before?: string | null; limit?: number } = {}): SessionPage | null {
    const limit = Math.max(1, Math.min(SESSION_PAGE_MAX, opts.limit || SESSION_PAGE_DEFAULT))
    const liveTurn = (r: LiveRun): SessionTurn => ({
      id: r.id, sender: r.sender, message: askText(r),
      startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : r.startedAt, running: true,
    })
    const running = live.find((r) => r.id === taskId)
    const saved = running ? null : this.findSaved(agentId, taskId)
    if (!running && !saved) return null
    const channel = running ? running.channel : saved!.head?.channel
    const chatId = running ? running.chatId : saved!.head?.chatId
    if (!channel || !chatId) {
      const one = running ? liveTurn(running) : this.readTurn(agentId, saved!.ref)
      return { session: null, selected: taskId, first: null, turns: one ? [{ ...one, n: 1 }] : [], olderBefore: null }
    }

    // Saved turns of this chat, then running ones of the same chat, by time.
    const refs = (this.build(agentId).get(sessionKey(channel, chatId)) || []).slice()
    if (saved && !refs.some((r) => r.id === saved.ref.id)) { refs.push(saved.ref); refs.sort(byId) }
    type Item = { id: string; ref?: Ref; live?: LiveRun }
    const items: Item[] = refs.map((ref) => ({ id: ref.id, ref }))
    for (const r of live) {
      if (r.channel === channel && r.chatId === chatId && !items.some((i) => i.id === safe(r.id))) items.push({ id: safe(r.id), live: r })
    }
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    let from: number, to: number
    if (opts.before) {
      const end = items.findIndex((i) => i.id === safe(opts.before!))
      to = end < 0 ? 0 : end
      from = Math.max(0, to - limit)
    } else {
      const at = items.findIndex((i) => i.id === safe(taskId))
      from = Math.max(0, at - limit + 1)
      to = Math.min(items.length, at + 1 + limit)
    }
    const load = (i: Item): SessionTurn | null => (i.live ? liveTurn(i.live) : this.readTurn(agentId, i.ref!))
    const turns = items.slice(from, to)
      .map((i, k): SessionTurn | null => { const t = load(i); return t ? { ...t, n: from + k + 1 } : null })
      .filter((t): t is SessionTurn => !!t)
    const head = from > 0 && items.length ? load(items[0]) : null
    const first = head ? { ...head, n: 1 } : null
    return {
      session: { channel, chatId, turns: items.length },
      selected: taskId,
      first,
      turns,
      olderBefore: from > 0 ? items[from].id : null,
    }
  }
}
