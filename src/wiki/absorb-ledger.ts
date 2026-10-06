import { appendFileSync, existsSync, readFileSync } from "fs"
import { resolve } from "path"

// --- The absorb ledger: entries absorb has already read (#761) ---
//
// An entry used to leave the absorb queue only when an article's
// `sources` cited it. Everything the model read and chose not to cite —
// noise, duplicates, chit-chat — stayed at the head of the queue and was
// re-read on every run, so a backfill never moved forward.
//
// This records each entry a run read, once that run finished, as
// `cited` or `skipped`. A run that fails partway records nothing, so a
// retry still sees the same entries. One JSONL file at the wiki root,
// keyed by mode: a graph absorb does not settle the flat wiki's queue.

export const ABSORB_LEDGER_FILE = ".absorb-processed.jsonl"

export type AbsorbOutcome = "cited" | "skipped"

export interface AbsorbRecord {
  entryId: string
  agentId: string
  mode: string
  processedAt: string
  outcome: AbsorbOutcome
}

export function absorbLedgerPath(wikiDir: string): string {
  return resolve(wikiDir, ABSORB_LEDGER_FILE)
}

/** Latest outcome per entry for one agent and mode. A bad line is skipped,
 *  not fatal: losing it only means that entry is read again. */
export function readAbsorbLedger(wikiDir: string, agentId: string, mode: string): Map<string, AbsorbOutcome> {
  const out = new Map<string, AbsorbOutcome>()
  const path = absorbLedgerPath(wikiDir)
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Partial<AbsorbRecord>
      if (r.agentId !== agentId || r.mode !== mode || typeof r.entryId !== "string") continue
      if (r.outcome !== "cited" && r.outcome !== "skipped") continue
      out.set(r.entryId, r.outcome)
    } catch { /* torn or hand-edited line */ }
  }
  return out
}

/** Record every entry a finished run read. `cited` holds the ids any
 *  written article lists in `sources`; the rest are `skipped`. */
export function recordAbsorbed(
  wikiDir: string,
  agentId: string,
  mode: string,
  entryIds: string[],
  cited: Set<string>,
  now: Date = new Date(),
): AbsorbRecord[] {
  const processedAt = now.toISOString()
  const records = entryIds.map((entryId): AbsorbRecord => ({
    entryId,
    agentId,
    mode,
    processedAt,
    outcome: cited.has(entryId) ? "cited" : "skipped",
  }))
  if (records.length > 0) {
    appendFileSync(absorbLedgerPath(wikiDir), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  }
  return records
}
