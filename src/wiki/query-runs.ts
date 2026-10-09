/**
 * `wiki query` outcomes, one line per query in `_query-runs.jsonl` (#603).
 *
 * A failed query used to print plain text and exit 0, so nothing counted
 * it. Each query now appends its status and timing here, and
 * `wiki query-runs` counts them. No question, answer or error text goes
 * in the file.
 */
import { appendFileSync } from "fs"
import type { AgenticQueryResult } from "./query"

export const QUERY_RUNS_FILE = "_query-runs.jsonl"

export type QueryStatus = AgenticQueryResult["status"]

export interface QueryRunRecord {
  at: string
  agent: string
  status: QueryStatus
  method?: string
  wallMs: number
}

/** Statuses that mean the query could not run, not that the wiki had no answer. */
export function queryFailed(status: QueryStatus): boolean {
  return status === "error" || status === "no-catalog"
}

/** Append one record. Never throws: logging must not fail a query. */
export function recordQueryRun(file: string, record: QueryRunRecord): void {
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`)
  } catch {
    // best-effort
  }
}

export interface QueryRunSummary {
  total: number
  failed: number
  byStatus: Record<string, number>
  wallMsP50: number
  wallMsP95: number
}

/** Count queries by status, on or after `since` (an ISO date or time) when given. */
export function summariseQueryRuns(text: string, since?: string): QueryRunSummary {
  const records: QueryRunRecord[] = text.split("\n").filter(Boolean).flatMap((l) => {
    try {
      const r = JSON.parse(l)
      return r && typeof r.status === "string" && typeof r.at === "string" ? [r] : []
    } catch { return [] }
  }).filter((r) => !since || r.at >= since)
  const byStatus: Record<string, number> = {}
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const ms = records.map((r) => Number(r.wallMs) || 0).sort((a, b) => a - b)
  const pick = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0)
  return {
    total: records.length,
    failed: records.filter((r) => queryFailed(r.status)).length,
    byStatus,
    wallMsP50: pick(0.5),
    wallMsP95: pick(0.95),
  }
}
