// --- Awareness signals: an agent acted without knowing the state (#1997) ---
//
// `stale_status_told`: a run ends saying it waits on another agent of this
// node, but that agent's latest hand-off from it had already ended done,
// with its answer delivered, and the callee's run stated done. The reply
// misleads whoever reads it. (`duplicate_session` is recorded by the work
// lane itself, where the wait runs out: work-lane.ts.)
//
// v1 checks waits on hand-offs only: the record AgentX owns. Stale
// "merged" and "live" claims are the follow-up (#2029).
//
// The check runs on a later tick, after the reply, like the cost signals
// (#2024). At most three indexed reads, bounded by time, and only for a run
// that waits on a known agent. Never throws.

import type Database from "better-sqlite3"
import { endStateInAnswer, type EndState } from "@/agents/run-state"
import { emitSignal, signalDb, type Signal } from "./signals"

/** A finished run, as the run-end checks (awareness, Bayan) read it. */
export interface RunEnd {
  /** The run's trace task id. */
  taskId: string
  agentId: string
  channel?: string
  chatId?: string | null
  /** `task.context.sender`, e.g. `agent:<id>`. */
  sender?: string | null
  content?: string
  jobState?: EndState
  startedAt: number
}

export interface HandoffRow {
  id: string
  peer: string | null
  status: string | null
  startedAt: number | null
  endedAt: number | null
  relayAttempt: number | null
}

export interface StaleHistory {
  /** The caller's latest hand-offs to the callee, newest first. */
  handoffs: HandoffRow[]
  /** Any hand-off from the caller to the callee in the window is still
   *  open (status NULL or waiting), not only the newest. */
  openInWindow?: boolean
  /** The callee's final answer in the latest hand-off's own chat. */
  calleeAnswer?: string | null
}

/** How far back a hand-off is looked for. */
export const HANDOFF_LOOKBACK_MS = 24 * 3_600_000

/** The agent of this registry a `waiting` state names first, or null:
 *  waits on CI, a person or a time are not checked. */
export function waitedOnAgent(state: EndState | undefined, agentId: string, isAgent: (id: string) => boolean): string | null {
  if (state?.state !== "waiting") return null
  const m = /^@?([A-Za-z0-9][\w.-]*)/.exec(state.on.trim())
  if (!m) return null
  const id = m[1].replace(/[.-]+$/, "")
  const known = isAgent(id) ? id : isAgent(id.toLowerCase()) ? id.toLowerCase() : null
  return known && known !== agentId ? known : null
}

/** The signal for a stale wait, or null. Pure. */
export function staleStatus(run: RunEnd, callee: string, h: StaleHistory): Signal | null {
  const latest = h.handoffs[0]
  // Open (status NULL or waiting), failed, or a newer one still out: silent.
  if (!latest || latest.status !== "done") return null
  // An older hand-off still out: the wait may be on that one.
  if (h.openInWindow) return null
  if (latest.peer) return null // the callee ran on a peer: no local trace
  // The answer is still held for relay: the caller could not know yet.
  if (latest.relayAttempt !== null && latest.relayAttempt !== undefined) return null
  if (latest.endedAt === null || latest.endedAt >= run.startedAt) return null
  if (endStateInAnswer(h.calleeAnswer ?? undefined)?.state !== "done") return null
  const mins = Math.max(0, Math.round((run.startedAt - latest.endedAt) / 60_000))
  return { kind: "stale_status_told", agentId: run.agentId, ref: run.taskId, detail: `said waiting on ${callee}, whose hand-off had ended done ${mins} min before` }
}

/** The reads `staleStatus` needs. The second only when the first could fire. */
export function readStaleHistory(db: Database.Database, run: RunEnd, callee: string): StaleHistory {
  const handoffs = db.prepare(
    `SELECT id, peer, status, started_at AS startedAt, ended_at AS endedAt, relay_attempt AS relayAttempt
     FROM handoffs INDEXED BY idx_handoffs_started WHERE started_at >= ? AND caller = ? AND callee = ?
     ORDER BY started_at DESC LIMIT 2`,
  ).all(run.startedAt - HANDOFF_LOOKBACK_MS, run.agentId, callee) as HandoffRow[]
  const latest = handoffs[0]
  if (!latest || latest.status !== "done" || latest.peer || latest.startedAt === null || latest.endedAt === null) return { handoffs }
  // Any open hand-off to the callee in the same window, older ones too.
  const open = db.prepare(
    `SELECT 1 FROM handoffs INDEXED BY idx_handoffs_started WHERE started_at >= ? AND caller = ? AND callee = ?
     AND (status IS NULL OR status = 'waiting') LIMIT 1`,
  ).get(run.startedAt - HANDOFF_LOOKBACK_MS, run.agentId, callee)
  if (open) return { handoffs, openInWindow: true }
  // The callee's run of this hand-off, by its own chat (delegationIdOfChat's shape).
  const row = db.prepare(
    `SELECT final_response AS answer FROM task_traces INDEXED BY idx_traces_agent_started
     WHERE agent_id = ? AND started_at >= ? AND started_at <= ? AND chat_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(callee, latest.startedAt - 60_000, latest.endedAt, `a2a:${run.agentId}:${callee}:${latest.id}`) as { answer: string | null } | undefined
  return { handoffs, calleeAnswer: row?.answer ?? null }
}

/** Record a finished run's awareness signal. Never throws. */
export function emitAwarenessSignals(run: RunEnd, isAgent: (id: string) => boolean, now = Date.now()): void {
  try {
    const callee = waitedOnAgent(run.jobState, run.agentId, isAgent)
    if (!callee) return
    const db = signalDb()
    if (!db) return
    const s = staleStatus(run, callee, readStaleHistory(db, run, callee))
    if (s) emitSignal(s, now)
  } catch (e: any) {
    console.warn(`[improve] awareness signals skipped for ${run.taskId}: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

/** Check on a later tick, so the reads never sit between a run and its
 *  reply. Never throws. */
export function queueAwarenessSignals(run: RunEnd, isAgent: (id: string) => boolean): void {
  try {
    setImmediate(() => emitAwarenessSignals(run, isAgent))
  } catch { /* never in the reply's way */ }
}
