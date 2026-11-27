// --- The Task page's runs, as data (#2101 T2) ---
//
// One Task page per request. A request's runs are the "run" events of its
// thread (GET /api/admin/wall/thread, wallThread in src/daemon/wall-api.ts):
// ref is the run's task id, who its agent, status "in-flight" while it goes
// (src/storage/traces.ts). The run going now opens live; the others are
// listed as past runs, each opening in place as its stored record
// (TaskRuns.tsx draws both).
//
// Reads and writes are the old run page's (wall-task.client.ts):
//   GET  /api/task/stream?node=&agent=&task=     SSE: start / chunk / end
//        (followTaskStream in ../shell/chat-stream.ts reads it)
//   GET  /api/task/history?node=&agent=&task=    the stored record
//   POST /api/task/action?node=&task=&kind=followup|cancel
//        → the node's /api/tasks/:taskId/{followup|cancel}
//
// Pure: no DOM, no React, so test/hub-task-runs.test.ts runs it in Node.
import { outStamp, type OutStamp } from "../../agents/output-stamps"
import type { LiveSnapshot, TaskEvent, TaskNode } from "./task-data"

/** One run of a request. */
export interface RequestRun {
  taskId: string
  agentId: string
  /** The trace's status: "in-flight" while it runs, then ok, error,
   *  timeout, cancelled. Null when the node has no trace for it. */
  status: string | null
  /** When it started, epoch ms. */
  at: number
  durationMs: number | null
  /** Its reply or its error, one line (the thread's text). */
  text: string
}

/** The request's runs from its thread, oldest first, one per task id. A
 *  run with no agent has no trace on the node, so nothing to stream or
 *  read: it is left out. */
export function requestRuns(events: readonly TaskEvent[]): RequestRun[] {
  const seen = new Set<string>()
  const out: RequestRun[] = []
  for (const e of events) {
    if (e.kind !== "run" || !e.ref || !e.who || seen.has(e.ref)) continue
    seen.add(e.ref)
    out.push({ taskId: e.ref, agentId: e.who, status: e.status ?? null, at: e.at || 0, durationMs: e.durationMs ?? null, text: e.text ?? "" })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The task ids running now on any node, by the live snapshot. Null when
 *  there is no snapshot yet: then a run's own status decides. */
export function runningTaskIds(live: LiveSnapshot | null | undefined): Set<string> | null {
  if (!live || !Array.isArray(live.nodes)) return null
  const ids = new Set<string>()
  for (const n of live.nodes) for (const a of n.agents ?? []) for (const t of a.runningTasks ?? []) if (t?.id) ids.add(t.id)
  return ids
}

/** Is this run going now? The live snapshot says so when there is one (a
 *  trace left "in-flight" by a daemon restart is not running); without
 *  one, its status. */
export function isRunning(run: Pick<RequestRun, "taskId" | "status">, running: Set<string> | null): boolean {
  return running ? running.has(run.taskId) : run.status === "in-flight"
}

/** What the run section draws. */
export interface RunView {
  /** The run shown live on top: going now, or the one this page watched
   *  go and end (it stays put, so nothing jumps when it ends). */
  live: RequestRun | null
  /** Every other run, newest first. */
  past: RequestRun[]
  /** The past run the address opens in place (`run=`), or null. */
  opened: string | null
}

/**
 * The run section of a request's Task page. `asked` is the run the address
 * names (`run=<task id>`): going now, it is the live one; ended, it opens in
 * place in the past list. Without it, the newest run going now is the live
 * one. `watched` is the run this page streamed: once it ends it keeps the
 * live place until the page goes.
 */
export function runView(runs: readonly RequestRun[], asked: string | null, running: Set<string> | null, watched: string | null = null): RunView {
  const find = (id: string | null) => (id ? runs.find((r) => r.taskId === id) : undefined)
  const going = (r?: RequestRun) => (r && isRunning(r, running) ? r : undefined)
  const live = going(find(asked)) ?? find(watched) ?? [...runs].reverse().find((r) => isRunning(r, running)) ?? null
  const past = runs.filter((r) => r !== live).sort((a, b) => b.at - a.at)
  const opened = asked && past.some((r) => r.taskId === asked) ? asked : null
  return { live, past, opened }
}

/** The node a request's runs are on, as the live snapshot names it: the
 *  peer that keeps it, else this one (listed first). "" when unknown. */
export function runNodeUrl(node: TaskNode | null | undefined, live: LiveSnapshot | null | undefined): string {
  return node?.daemonUrl || node?.peer || live?.nodes?.[0]?.url || ""
}

/** A run's state from the one state set (orca-design recipes §9): the
 *  lucide icon, the word, the tone, and a reason when the word is not all. */
export interface RunState { icon: string; word: string; tone: "work" | "done" | "err" | "idle"; reason?: string }

export function runState(run: Pick<RequestRun, "taskId" | "status">, running: Set<string> | null): RunState {
  if (isRunning(run, running)) return { icon: "loader-circle", word: "Working", tone: "work" }
  switch (run.status) {
    case "ok": return { icon: "circle-check", word: "Done", tone: "done" }
    case "error": case "failed": return { icon: "circle-x", word: "Failed", tone: "err" }
    case "timeout": return { icon: "circle-x", word: "Failed", tone: "err", reason: "timed out" }
    case "stopped": case "cancelled": case "canceled": return { icon: "ban", word: "Cancelled", tone: "idle" }
    // Left "in-flight" with nothing running it: a restart cut it off.
    case "in-flight": return { icon: "circle-x", word: "Failed", tone: "err", reason: "cut off" }
    case "paused": return { icon: "pause", word: "Paused", tone: "idle" }
    default: return { icon: "circle", word: "Idle", tone: "idle", reason: run.status || "no record" }
  }
}

/** "45 s", "3 min", "1 h 20 min". */
export function runTook(ms: number | null | undefined): string {
  if (!ms || ms < 0) return ""
  const s = Math.round(ms / 1000)
  if (s < 60) return s + " s"
  const m = Math.round(s / 60), h = Math.floor(m / 60)
  return h ? h + " h" + (m % 60 ? " " + (m % 60) + " min" : "") : m + " min"
}

/** The address with `run=` set to this run, or dropped (null); the rest of
 *  the address stays as it is. */
export function runHash(hash: string, taskId: string | null): string {
  const p = new URLSearchParams(hash.replace(/^#/, ""))
  if (taskId) p.set("run", taskId)
  else p.delete("run")
  const s = p.toString()
  return s ? "#" + s : ""
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
export const runRecordUrl = (node: string, agent: string, task: string) => "/api/task/history?" + q({ node, agent, task })
export const runActionUrl = (node: string, task: string, kind: "followup" | "cancel") => "/api/task/action?" + q({ node, task, kind })

// --- A stored run ---

/** The stored record (GET /api/task/history?task=, the node's
 *  /agents/:id/tasks/:taskId). */
export interface RunRecord {
  message?: string
  sender?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  ok?: boolean
  error?: string
  transcript?: string
  transcriptStamps?: OutStamp[]
  responseText?: string
}

/** The record's output as one stream, as the old page drew it: the
 *  transcript, the final reply when the transcript lacks it, the error. */
export function recordOutput(rec: RunRecord): { raw: string; stamps: OutStamp[] } {
  const stamps = (rec.transcriptStamps || []).slice()
  const end = Date.parse(rec.endedAt || "") || 0
  let raw = rec.transcript || ""
  const more = (text: string) => { if (end) outStamp(stamps, raw, text, end); raw += text }
  if (rec.responseText && (!raw || raw.indexOf(rec.responseText) === -1)) more((raw ? "\n\n" : "") + rec.responseText)
  if (rec.error) more("\n\n[error] " + rec.error)
  return { raw, stamps }
}

// --- What a steer or Stop said back ---

/** The follow-up reply in words (the node's /api/tasks/:id/followup), as
 *  the old run page says it. */
export function followupNote(r: { error?: string; resumed?: boolean; taskId?: string; answeredBy?: string } | null | undefined): { text: string; err: boolean } {
  if (r?.error) return { text: "Not sent: " + r.error, err: true }
  if (r?.resumed && r.taskId) return { text: "Sent: it continues as a new run, shown here.", err: false }
  if (r?.resumed && r.answeredBy === "attached") return { text: "Answered by the attached session: no new run here.", err: false }
  if (r?.resumed && r.answeredBy) return { text: "Delivered and answered: no new run on this node.", err: false }
  if (r?.resumed) return { text: "The agent is busy: queued as the next turn in this chat.", err: false }
  return { text: "Queued: it goes in as the next turn.", err: false }
}

/** What Stop said back. */
export function stopNote(r: { error?: string } | null | undefined): { text: string; err: boolean } {
  return r?.error ? { text: "Not stopped: " + r.error, err: true } : { text: "Stop asked: the turn ends now.", err: false }
}
