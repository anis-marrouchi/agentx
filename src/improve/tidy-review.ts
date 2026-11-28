// --- Review of a memory tidy run: the approvals item and its number (#2117 PR 3) ---
//
// Each nightly tidy run (tidy-stage.ts) that changed something waits for
// the owner as one approvals item: key `memory:<agent>/tidy-<runId>`. Yes
// keeps the changes; no undoes the whole run (tidy.ts undoRun). Silence
// keeps them: the item leaves the list after TIDY_REVIEW_DAYS. The answer
// is kept in the run log (`review`), so `memory tidy show` shows it.
//
// The number `memory-tidy-kept` (the job's value line): of the changes
// tidy runs made in the last 7 days, the share not undone, in percent.
// One reading a day, written by the tidy stage.

import type Database from "better-sqlite3"
import type { AgentMemory } from "@/agents/agent-memory"
import type { MemoryStore } from "@/agents/memory-store"
import { periodAt } from "@/numbers/model"
import { NumberStore } from "@/numbers/store"
import { changeNote, changeWhat, listRuns, markReviewed, showRun, undoRun, type TidyChange, type TidyRun } from "./tidy"

export const TIDY_REVIEW_DAYS = 7
export const TIDY_KEPT_NUMBER = "memory-tidy-kept"
/** The value line's target: at least 90% of the changes kept. */
export const TIDY_KEPT_TARGET = 90
/** Lines in an item's detail; the rest are counted, see `more`. */
export const TIDY_DETAIL_LINES = 20
const LINE_MAX = 100
const DAY_MS = 86_400_000

/** The ref after `memory:` for a run: `<agent>/tidy-<runId>`. */
export const tidyRef = (run: Pick<TidyRun, "agent" | "runId">) => `${run.agent}/tidy-${run.runId}`

/** A memory ref's run id, or null when the ref names a held fact. */
export function tidyRunIdOf(ref: string): string | null {
  const m = /^[^/]+\/tidy-(.+)$/.exec(ref)
  return m ? m[1] : null
}

/** Tidy runs waiting for the owner: unanswered, younger than
 *  TIDY_REVIEW_DAYS, with at least one change not yet undone. */
export function runsToReview(store: MemoryStore, now: number): TidyRun[] {
  return listRuns(store).filter((r) => r.by === "tidy" && !r.review
    && now - Date.parse(r.at) < TIDY_REVIEW_DAYS * DAY_MS
    && r.changes.some((c) => !c.undoneAt))
}

/** One change in one line, as `memory tidy show` prints it. */
export function changeLine(c: TidyChange): string {
  const note = changeNote(c)
  const line = `${c.n}. ${c.store} ${c.action}${c.reason ? ` (${c.reason})` : ""}: ${changeWhat(c, 60)}${c.undoneAt ? " [undone]" : ""}${note ? ` (${note})` : ""}`
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
}

/** Every change of a run, one line each, at most TIDY_DETAIL_LINES. */
export function runDetail(run: TidyRun): string {
  const lines = run.changes.slice(0, TIDY_DETAIL_LINES).map(changeLine)
  const rest = run.changes.length - lines.length
  if (rest > 0) lines.push(`… and ${rest} more: agentx memory tidy show ${run.runId}`)
  return lines.join("\n")
}

export type ReviewResult = { ok: true; message: string } | { ok: false; error: string }

/** The owner's answer on a run's item. Yes keeps it, no undoes it all. */
export function reviewRun(
  store: MemoryStore, notes: AgentMemory | undefined, runId: string, yes: boolean,
  opts: { by: string; now: number },
): ReviewResult {
  const run = showRun(store, runId)
  if (!run || run.by !== "tidy") return { ok: false, error: `no tidy run ${runId}` }
  if (!runsToReview(store, opts.now).some((r) => r.runId === runId)) return { ok: false, error: `tidy run ${runId} isn't waiting for review` }
  const review = { answer: yes ? "yes" as const : "no" as const, by: opts.by, at: new Date(opts.now).toISOString() }
  if (yes) {
    markReviewed(store, runId, review)
    return { ok: true, message: `tidy run ${runId}: ${run.changes.length} change(s) kept` }
  }
  const r = undoRun(store, runId, { notes, now: opts.now, review })
  const skipped = r.skipped.filter((s) => s.why !== "already undone")
  return {
    ok: true,
    message: `tidy run ${runId} undone: ${r.restored.length} change(s) put back`
      + (skipped.length ? `; skipped ${skipped.map((s) => `${s.n} (${s.why})`).join(", ")}` : ""),
  }
}

export interface KeptReading {
  kept: number
  undone: number
  /** Percent kept; null when the tidy changed nothing in the window. */
  value: number | null
}

/** Of the changes tidy runs made in the last 7 days, how many stand. */
export function keptShare(store: MemoryStore, now: number): KeptReading {
  let kept = 0
  let undone = 0
  for (const r of listRuns(store)) {
    if (r.by !== "tidy" || now - Date.parse(r.at) >= TIDY_REVIEW_DAYS * DAY_MS) continue
    for (const c of r.changes) c.undoneAt ? undone++ : kept++
  }
  const all = kept + undone
  return { kept, undone, value: all ? Math.round((kept / all) * 1000) / 10 : null }
}

/** Write today's reading of `memory-tidy-kept`. The number is made on
 *  first use; an owner's later edits to it are left alone. Nothing is
 *  written when the tidy changed nothing in the window. */
export function recordKept(store: MemoryStore, db: Database.Database, now: number): KeptReading {
  const share = keptShare(store, now)
  if (share.value === null) return share
  const numbers = new NumberStore(db)
  if (!numbers.get(TIDY_KEPT_NUMBER)) {
    numbers.upsert({
      id: TIDY_KEPT_NUMBER, name: "Memory tidy changes kept", unit: "%", rhythm: "daily",
      target: { value: TIDY_KEPT_TARGET, direction: "up" }, tags: ["area:memory"], origin: "agent",
    }, now)
  }
  const p = periodAt("daily", now)
  numbers.record({
    numberId: TIDY_KEPT_NUMBER, value: share.value, readAt: now, periodStart: p.start, periodEnd: p.end,
    by: "tidy", note: `${share.kept} kept, ${share.undone} undone, last ${TIDY_REVIEW_DAYS} days`,
  })
  return share
}
