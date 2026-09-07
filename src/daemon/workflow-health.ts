// --- Is the automation still running? -------------------------------------
//
// A workflow that stops firing produces nothing: no error, no run, no page
// entry. On this fleet 16 workflows produced 759 runs and then went quiet for
// three days without anyone noticing, which is the failure this module exists
// to make visible. Health is therefore about ABSENCE first and failure second.
//
// Cost note: RunStore.get() replays a whole run file. Polling that for every
// run on every dashboard refresh is not affordable, so we read each file's
// first line (the snapshot, which carries workflowId) and last line (the
// terminal status), and cache per file keyed on mtime. Runs are append-only,
// so after the first scan almost nothing is re-read.

import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { resolve } from "path"

export interface RunSummary { workflowId: string; status: string; at: number }

/** Absence first: a workflow that used to fire and no longer does is the
 *  headline, because nothing else in the product will ever mention it. */
export type WorkflowState = "never" | "failing" | "dormant" | "active" | "quiet"

export interface WorkflowHealth {
  id: string
  name: string
  state: WorkflowState
  /** Last run of any status, ms since epoch. Null when it has never run. */
  lastRunAt: number | null
  recent: number
  prior: number
  failed: number
  /** Runs parked at a checkpoint. These are waiting on a human, not broken. */
  paused: number
}

export function workflowHealth(
  workflows: Array<{ id: string; name?: string }>,
  runs: RunSummary[],
  now = Date.now(),
  windowDays = 7,
): WorkflowHealth[] {
  // One day in ms, inlined: workflowHealth is stringified and shipped to the
  // workflows page, where a module-scope constant would be unbound.
  const span = windowDays * 86_400_000
  const byId = new Map<string, RunSummary[]>()
  for (const r of runs) {
    const list = byId.get(r.workflowId)
    if (list) list.push(r)
    else byId.set(r.workflowId, [r])
  }
  return workflows.map(w => {
    const mine = byId.get(w.id) ?? []
    const recent = mine.filter(r => now - r.at <= span)
    const prior = mine.filter(r => now - r.at > span && now - r.at <= span * 2)
    const failed = recent.filter(r => r.status === "failed").length
    const paused = mine.filter(r => r.status === "paused").length
    const lastRunAt = mine.length ? Math.max(...mine.map(r => r.at)) : null
    // Order matters: a workflow that has stopped firing is reported as dormant
    // even when its last few runs failed — the silence is the bigger signal.
    const state: WorkflowState =
      !mine.length ? "never"
      : prior.length > 0 && recent.length === 0 ? "dormant"
      : recent.length > 0 && failed * 2 >= recent.length ? "failing"
      : recent.length > 0 ? "active"
      : "quiet"
    return { id: w.id, name: w.name || w.id, state, lastRunAt, recent: recent.length, prior: prior.length, failed, paused }
  }).sort((a, b) => RANK[a.state] - RANK[b.state] || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
}

const RANK: Record<WorkflowState, number> = { dormant: 0, failing: 1, active: 2, quiet: 3, never: 4 }

const cache = new Map<string, { mtime: number; summary: RunSummary | null }>()

/** Read workflowId + terminal status per run, re-reading only changed files. */
export function scanRuns(runsDir: string, limit = 1000): RunSummary[] {
  if (!existsSync(runsDir)) return []
  const files = readdirSync(runsDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => { const p = resolve(runsDir, f); return { path: p, mtime: statSync(p).mtimeMs } })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
  const live = new Set(files.map(f => f.path))
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
  const out: RunSummary[] = []
  for (const { path, mtime } of files) {
    const hit = cache.get(path)
    if (hit && hit.mtime === mtime) { if (hit.summary) out.push(hit.summary); continue }
    const summary = readSummary(path, mtime)
    cache.set(path, { mtime, summary })
    if (summary) out.push(summary)
  }
  return out
}

function readSummary(path: string, mtime: number): RunSummary | null {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
    if (!lines.length) return null
    const head = JSON.parse(lines[0]) as { run?: { workflowId?: string; status?: string } }
    const workflowId = head.run?.workflowId
    if (!workflowId) return null
    // The last line is either a status-bearing exec entry or another snapshot;
    // fall back to the snapshot's own status when it carries neither.
    let status = head.run?.status ?? "unknown"
    for (let i = lines.length - 1; i >= 0; i--) {
      const tail = JSON.parse(lines[i]) as { status?: string; run?: { status?: string } }
      const s = tail.status ?? tail.run?.status
      if (s) { status = s; break }
    }
    return { workflowId, status, at: mtime }
  } catch { return null }
}
