import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { dirname, resolve } from "path"

// Human verdicts on graph classifications.
//
// The classifier has recorded 8,903 classifications and not one of them
// carries a human judgement. 8,871 say "approved", which sounds like
// ground truth and is not: `status: "approved"` is set by the
// classifier itself when the proposed path passes schema validation and
// its nodes commit. Nothing rejects. `graph.autoApproveConfidence`
// still defaults to 1.0 — permanently off — which is the codebase
// stating plainly that it does not trust the number.
//
// So a decision seat here would produce a better-formed probability
// against nothing to check it with, which is the one outcome the whole
// calibration exercise exists to avoid. Labels first.
//
// Verdicts live in their own log rather than in classifications.jsonl.
// approveClassification() appends a copy of the row with the status
// flipped, so a human verdict written that way would be
// indistinguishable from the classifier's own — the exact conflation
// that produced 8,871 meaningless "approved" rows. Keeping them apart
// means the join is explicit and the existing log stays what it is: a
// record of what the classifier did.

export type Verdict = "correct" | "wrong" | "unsure"

export interface Review {
  msgHash: string
  verdict: Verdict
  /** For `wrong`: the path it should have been, when the reviewer knows. */
  correctPath?: string[]
  /** Free-text note, for the cases worth remembering. */
  note?: string
  reviewer: string
  ts: string
}

export interface ClassificationRow {
  msgHash: string
  path: string[]
  leaf?: string
  confidence?: number
  preview?: string
  agentId?: string
  channel?: string
  source?: string
  status?: string
  ts?: string
}

export class ReviewStore {
  private readonly file: string

  constructor(baseDir: string) {
    this.file = resolve(baseDir, "reviews.jsonl")
  }

  get path(): string { return this.file }

  /** Latest verdict per msgHash — a reviewer may change their mind. */
  load(): Map<string, Review> {
    const out = new Map<string, Review>()
    if (!existsSync(this.file)) return out
    let raw: string
    try { raw = readFileSync(this.file, "utf-8") } catch { return out }
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const r = JSON.parse(t) as Review
        if (r?.msgHash && r?.verdict) out.set(r.msgHash, r)
      } catch { /* skip corrupt line */ }
    }
    return out
  }

  record(review: Omit<Review, "ts"> & { ts?: string }): Review {
    const row: Review = { ...review, ts: review.ts ?? new Date().toISOString() }
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, `${JSON.stringify(row)}\n`)
    return row
  }
}

export type QueueStrategy = "uncertain" | "stratified"

/**
 * What to put in front of a person next.
 *
 * `uncertain` is classic active learning: lowest confidence first,
 * because that is where a label changes the most. It finds errors fast
 * and it is the right mode when the question is "is this thing broken".
 *
 * It is the wrong mode for calibration, and that distinction matters
 * enough to be the default. Labelling only the bottom of the confidence
 * range leaves the top bins empty, and the top bins are exactly where
 * an overconfident model does its damage — a reliability diagram built
 * from uncertain-only labels cannot see the failure it exists to find.
 * `stratified` spreads the budget evenly across confidence deciles so
 * every bin gets evidence.
 */
export function buildQueue(
  rows: ClassificationRow[],
  reviewed: Set<string>,
  opts: { n?: number; strategy?: QueueStrategy } = {},
): ClassificationRow[] {
  const n = opts.n ?? 20
  const strategy = opts.strategy ?? "stratified"

  // One row per message. The log is append-only and re-records a row on
  // every status change, so the same msgHash appears several times.
  const byHash = new Map<string, ClassificationRow>()
  for (const r of rows) if (r?.msgHash) byHash.set(r.msgHash, r)

  const pending = [...byHash.values()].filter((r) => !reviewed.has(r.msgHash))
  if (pending.length === 0) return []

  if (strategy === "uncertain") {
    // Rows with no confidence at all are cache hits; they carry no
    // number to be uncertain about, so they sort last here.
    return [...pending]
      .sort((a, b) => (a.confidence ?? 2) - (b.confidence ?? 2))
      .slice(0, n)
  }

  const scored = pending.filter((r) => typeof r.confidence === "number")
  const unscored = pending.filter((r) => typeof r.confidence !== "number")

  const bins = new Map<number, ClassificationRow[]>()
  for (const r of scored) {
    const bin = Math.min(9, Math.floor((r.confidence as number) * 10))
    const list = bins.get(bin) ?? []
    list.push(r)
    bins.set(bin, list)
  }

  // Round-robin across occupied bins so a sparse bin still contributes
  // and a crowded one cannot swallow the budget.
  const order = [...bins.keys()].sort((a, b) => a - b)
  const out: ClassificationRow[] = []
  let i = 0
  while (out.length < n && order.length > 0) {
    let placed = false
    for (const bin of order) {
      const list = bins.get(bin)!
      if (i < list.length) { out.push(list[i]); placed = true }
      if (out.length >= n) break
    }
    if (!placed) break
    i++
  }
  // Cache hits are still worth labelling for accuracy, just not for
  // calibration — they fill whatever budget is left.
  for (const r of unscored) {
    if (out.length >= n) break
    out.push(r)
  }
  return out
}

export interface LabelStats {
  classifications: number
  reviewed: number
  correct: number
  wrong: number
  unsure: number
  /** Accuracy among decided verdicts; `unsure` is excluded rather than
   *  counted either way. */
  accuracy: number
  /** Reviewed rows that carry a confidence, i.e. usable for calibration. */
  calibratable: number
  byBin: Array<{ bin: string; n: number; accuracy: number }>
}

export function labelStats(rows: ClassificationRow[], reviews: Map<string, Review>): LabelStats {
  const byHash = new Map<string, ClassificationRow>()
  for (const r of rows) if (r?.msgHash) byHash.set(r.msgHash, r)

  let correct = 0, wrong = 0, unsure = 0, calibratable = 0
  const bins = new Map<number, { n: number; correct: number }>()

  for (const [hash, review] of reviews) {
    const row = byHash.get(hash)
    if (!row) continue
    if (review.verdict === "correct") correct++
    else if (review.verdict === "wrong") wrong++
    else { unsure++; continue }

    if (typeof row.confidence === "number") {
      calibratable++
      const bin = Math.min(9, Math.floor(row.confidence * 10))
      const b = bins.get(bin) ?? { n: 0, correct: 0 }
      b.n++
      if (review.verdict === "correct") b.correct++
      bins.set(bin, b)
    }
  }

  const decided = correct + wrong
  return {
    classifications: byHash.size,
    reviewed: correct + wrong + unsure,
    correct, wrong, unsure,
    accuracy: decided ? correct / decided : 0,
    calibratable,
    byBin: [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([bin, b]) => ({
      bin: `${(bin / 10).toFixed(1)}-${((bin + 1) / 10).toFixed(1)}`,
      n: b.n,
      accuracy: b.n ? b.correct / b.n : 0,
    })),
  }
}
