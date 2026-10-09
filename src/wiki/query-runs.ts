/**
 * `wiki query` outcomes, one line per query in `_query-runs.jsonl` (#603).
 *
 * A failed query used to print plain text and exit 0, so nothing counted
 * it. Each query now appends its status and timing here, and
 * `wiki query-runs` counts them. No question, answer or error text goes
 * in the file.
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "fs"
import type { AgenticQueryResult } from "./query"

export const QUERY_RUNS_FILE = "_query-runs.jsonl"

/** Past this size the file is cut to its newest half, so it never grows without a limit. */
export const QUERY_RUNS_MAX_BYTES = 1_000_000

export type QueryStatus = AgenticQueryResult["status"]

/** Where the query came from: the `wiki query` command or the `agentx_wiki_query` tool. */
export type QuerySource = "cli" | "tool"

export interface QueryRunRecord {
  at: string
  agent: string
  status: QueryStatus
  method?: string
  /** Missing on lines written before the tool was counted; those came from the CLI. */
  source?: QuerySource
  wallMs: number
}

/** Statuses that mean the query could not run, not that the wiki had no answer. */
export function queryFailed(status: QueryStatus): boolean {
  return status === "error" || status === "no-catalog"
}

/** Append one record. Never throws: logging must not fail a query. */
export function recordQueryRun(file: string, record: QueryRunRecord, maxBytes = QUERY_RUNS_MAX_BYTES): void {
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    if (statSync(file).size > maxBytes) trimToNewest(file, Math.floor(maxBytes / 2))
  } catch {
    // best-effort
  }
}

/** Keep the newest whole lines that fit in `bytes`. Written to a temp file and renamed, so a reader never sees half a file. */
function trimToNewest(file: string, bytes: number): void {
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean)
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    size += Buffer.byteLength(lines[i]) + 1
    if (size > bytes) break
    kept.push(lines[i])
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, kept.reverse().map((l) => `${l}\n`).join(""))
  renameSync(tmp, file)
}

/**
 * Run one query and record how it ended. A query that throws is recorded
 * as `error` and the error is thrown on, so no query goes uncounted.
 */
export async function timedQuery<T extends { status: QueryStatus; method?: string }>(
  file: string,
  agent: string,
  source: QuerySource,
  run: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  const record = (status: QueryStatus, method?: string) =>
    recordQueryRun(file, { at: new Date().toISOString(), agent, status, method, source, wallMs: Date.now() - start })
  try {
    const result = await run()
    record(result.status, result.method)
    return result
  } catch (e) {
    record("error")
    throw e
  }
}

export interface QueryRunSummary {
  total: number
  failed: number
  byStatus: Record<string, number>
  bySource: Record<string, number>
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
  const bySource: Record<string, number> = {}
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const source = r.source ?? "cli"
    bySource[source] = (bySource[source] ?? 0) + 1
  }
  const ms = records.map((r) => Number(r.wallMs) || 0).sort((a, b) => a - b)
  const pick = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0)
  return {
    total: records.length,
    failed: records.filter((r) => queryFailed(r.status)).length,
    byStatus,
    bySource,
    wallMsP50: pick(0.5),
    wallMsP95: pick(0.95),
  }
}
