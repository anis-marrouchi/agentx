/**
 * What happened to each finished task at the wiki's door, one line per
 * task in `_capture-runs.jsonl` (#603).
 *
 * The capture filter's reason was never kept and a failed entry write was
 * swallowed, so 11 of 1,723 eligible tasks in the audit had no entry and
 * no explanation. Each task now records whether it was captured, skipped
 * (with the filter's reason) or failed to write, and `agentx wiki status`
 * counts them. No message, answer or error text goes in the file.
 */
import { appendCappedLine } from "./query-runs"
import type { CaptureDecision } from "./capture-filter"

export const CAPTURE_RUNS_FILE = "_capture-runs.jsonl"

/** Same cap as the query log: past 1 MB, the newest half is kept. */
export const CAPTURE_RUNS_MAX_BYTES = 1_000_000

export type CaptureOutcome = "captured" | "skipped" | "failed"

export interface CaptureRunRecord {
  at: string
  agent: string
  outcome: CaptureOutcome
  /** Skipped: the filter's reason, a fixed phrase from capture-filter.ts. */
  reason?: string
}

type Log = (message: string) => void

function append(file: string, record: CaptureRunRecord, log: Log): void {
  try {
    appendCappedLine(file, record, CAPTURE_RUNS_MAX_BYTES)
  } catch (e) {
    // Counting must not fail a task; say once per write that it did not count.
    log(`[wiki-capture] could not record a capture outcome in ${file}: ${String((e as Error)?.message ?? e)}`)
  }
}

/** A task the filter kept out: log and count why. */
export function recordCaptureSkip(file: string, agent: string, decision: CaptureDecision, log: Log, now = new Date()): void {
  const reason = decision.reason ?? "filtered"
  log(`[${agent}] not captured in the wiki: ${reason}`)
  append(file, { at: now.toISOString(), agent, outcome: "skipped", reason }, log)
}

/**
 * Write a kept task's entry. A write that throws is logged and counted as
 * `failed` instead of disappearing. Returns whether the entry was written.
 */
export function recordCaptureWrite(file: string, agent: string, write: () => void, log: Log, now = () => new Date()): boolean {
  try {
    write()
  } catch (e) {
    log(`[${agent}] wiki entry not written: ${String((e as Error)?.message ?? e)}`)
    append(file, { at: now().toISOString(), agent, outcome: "failed" }, log)
    return false
  }
  append(file, { at: now().toISOString(), agent, outcome: "captured" }, log)
  return true
}

export interface CaptureRunSummary {
  total: number
  captured: number
  skipped: number
  failed: number
  /** Skipped tasks by the filter's reason. */
  skippedBy: Record<string, number>
}

/** Count outcomes, on or after `since` (an ISO date or time) when given. */
export function summariseCaptureRuns(text: string, since?: string): CaptureRunSummary {
  const out: CaptureRunSummary = { total: 0, captured: 0, skipped: 0, failed: 0, skippedBy: {} }
  for (const line of text.split("\n")) {
    if (!line) continue
    let r: CaptureRunRecord
    try { r = JSON.parse(line) } catch { continue }
    if (!r || typeof r.at !== "string" || (since && r.at < since)) continue
    if (r.outcome !== "captured" && r.outcome !== "skipped" && r.outcome !== "failed") continue
    out.total++
    out[r.outcome]++
    if (r.outcome === "skipped") {
      const reason = r.reason || "filtered"
      out.skippedBy[reason] = (out.skippedBy[reason] ?? 0) + 1
    }
  }
  return out
}
