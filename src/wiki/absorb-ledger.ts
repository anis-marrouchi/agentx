import { appendFileSync, existsSync, readFileSync } from "fs"

// Absorb's processed-entry ledger (#761).
//
// An entry used to leave the absorb queue only when an article cited it
// in `sources`. Entries the model read and judged not worth an article
// came back at the head of every oldest-first run, so a backfill stalled
// on the same batch. The ledger records every entry of a batch whose run
// finished, cited or skipped, and selection excludes them.
//
// One JSON line per entry, appended; the last line for an id wins.

export type AbsorbOutcome = "cited" | "skipped"

export interface AbsorbLedgerRecord {
  entryId: string
  agentId: string
  processedAt: string
  outcome: AbsorbOutcome
}

export const ABSORB_LEDGER_FILE = "_absorb-processed.jsonl"

export function readAbsorbLedger(path: string): Map<string, AbsorbOutcome> {
  const outcomes = new Map<string, AbsorbOutcome>()
  if (!existsSync(path)) return outcomes
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as AbsorbLedgerRecord
      if (r.entryId && (r.outcome === "cited" || r.outcome === "skipped")) outcomes.set(r.entryId, r.outcome)
    } catch {
      // A torn last line from a killed run: the entries it held are
      // simply read again next time, which is the safe direction.
    }
  }
  return outcomes
}

/** Record a finished batch: entries some article cites are cited, the rest skipped. */
export function appendAbsorbLedger(
  path: string,
  agentId: string,
  entryIds: string[],
  citedIds: Set<string>,
  now: Date = new Date(),
): AbsorbLedgerRecord[] {
  const processedAt = now.toISOString()
  const records = entryIds.map((entryId) => ({
    entryId,
    agentId,
    processedAt,
    outcome: (citedIds.has(entryId) ? "cited" : "skipped") as AbsorbOutcome,
  }))
  if (records.length > 0) appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return records
}
