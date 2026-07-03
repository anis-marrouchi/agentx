import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { z } from "zod"

// --- Candidate ledger ---
// Recurrence counting for the procedure miner. A "candidate" is a recurring
// activity pattern (cluster key) that hasn't yet earned procedure status.
// Plain JSON file (.agentx/procedures/_candidates.json), same idempotency
// idea as the wiki promotion ledger: a scan watermark for cheap incremental
// runs plus per-candidate task-id sets so re-scans never double count.

export const candidateSchema = z.object({
  /** Cluster key: `<channel>:<intentShape>:<actionSkeleton>`. */
  key: z.string(),
  count: z.number().int().min(0).default(0),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** Trace task ids already counted for this key (dedupes re-scans). */
  taskIds: z.array(z.string()).default([]),
  /** One representative user message, for dry-run review + LLM sampling. */
  sampleMessage: z.string().default(""),
  /**
   * counting  — accumulating occurrences
   * drafted   — a procedure draft was written; stop counting
   * promoted  — the draft became an active procedure
   * rejected  — operator rejected the draft; never re-draft this key
   */
  status: z.enum(["counting", "drafted", "promoted", "rejected"]).default("counting"),
  /** Procedure id once drafted. */
  procedureId: z.string().optional(),
})

export type Candidate = z.infer<typeof candidateSchema>

export const candidateLedgerSchema = z.object({
  /** ISO timestamp: traces started before this have already been scanned. */
  minedThrough: z.string().optional(),
  candidates: z.array(candidateSchema).default([]),
})

export type CandidateLedger = z.infer<typeof candidateLedgerSchema>

export function candidatesPath(baseDir: string): string {
  return resolve(baseDir, "_candidates.json")
}

export function readCandidates(baseDir: string): CandidateLedger {
  const p = candidatesPath(baseDir)
  if (!existsSync(p)) return { candidates: [] }
  try {
    const parsed = candidateLedgerSchema.safeParse(JSON.parse(readFileSync(p, "utf-8")))
    if (parsed.success) return parsed.data
  } catch { /* corrupt ledger — start fresh rather than crash the miner */ }
  return { candidates: [] }
}

export function writeCandidates(baseDir: string, ledger: CandidateLedger): void {
  const p = candidatesPath(baseDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n")
}

/**
 * Record one episode against a cluster key. Returns the candidate.
 * Episodes already counted (same taskId) are ignored, so re-scanning an
 * overlapping window is safe.
 */
export function upsertEpisode(
  ledger: CandidateLedger,
  key: string,
  taskId: string,
  timestamp: string,
  sampleMessage: string,
): Candidate {
  let cand = ledger.candidates.find((c) => c.key === key)
  if (!cand) {
    cand = {
      key,
      count: 0,
      firstSeen: timestamp,
      lastSeen: timestamp,
      taskIds: [],
      sampleMessage,
      status: "counting",
    }
    ledger.candidates.push(cand)
  }
  if (cand.taskIds.includes(taskId)) return cand
  cand.taskIds.push(taskId)
  cand.count += 1
  if (timestamp < cand.firstSeen) cand.firstSeen = timestamp
  if (timestamp > cand.lastSeen) cand.lastSeen = timestamp
  if (!cand.sampleMessage) cand.sampleMessage = sampleMessage
  return cand
}

/** Candidates that have recurred enough to be distilled into a draft. */
export function readyCandidates(ledger: CandidateLedger, minOccurrences: number): Candidate[] {
  return ledger.candidates
    .filter((c) => c.status === "counting" && c.count >= minOccurrences)
    .sort((a, b) => b.count - a.count)
}

export function markCandidate(
  ledger: CandidateLedger,
  key: string,
  status: Candidate["status"],
  procedureId?: string,
): void {
  const cand = ledger.candidates.find((c) => c.key === key)
  if (!cand) return
  cand.status = status
  if (procedureId) cand.procedureId = procedureId
}
