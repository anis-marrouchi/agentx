import type { GradedRow } from "@/decisions/store"
import type { TriageVerdict } from "@/decisions/seats/entry-triage"

// Grading the triage gate against what absorb actually did.
//
// The corpus is its own test set. Absorb walks entries oldest-first and
// writes the ones it judges worth an article, recording the entry ids in
// the article's `sources`. So for any entry older than the newest
// absorbed one, we know the answer: absorbed is a yes, passed over is a
// no. On this fleet that is 815 positives and 4,811 negatives, free,
// already on disk — and no other classification site in agentx has
// anything like it.
//
// The label is Sonnet's judgement rather than a human's, which bounds
// what this can prove: a gate that scores perfectly has learned to
// imitate absorb, not to be right. That is still the thing we need,
// because the gate's whole job is to spare absorb the entries it would
// have rejected anyway. Where it disagrees, the disagreement is worth
// reading rather than assuming either side is correct.

export interface LabeledEntry {
  id: string
  date?: string
  source?: string
  sourceContext?: string
  content: string
  /** True when absorb wrote an article citing this entry. */
  absorbed: boolean
}

/**
 * Split entries into labelled examples and not-yet-seen backlog.
 *
 * An unabsorbed entry newer than the newest absorbed one has not been
 * offered to absorb yet, so it is unlabelled — counting it as a negative
 * would score the gate against a decision nobody has made.
 */
export function labelEntries(
  entries: Array<{ id: string; date?: string; source?: string; sourceContext?: string; content: string }>,
  unabsorbedIds: Set<string>,
): { labeled: LabeledEntry[]; backlog: number } {
  const absorbedDates = entries
    .filter((e) => !unabsorbedIds.has(e.id))
    .map((e) => String(e.date ?? ""))
    .sort()
  const newest = absorbedDates[absorbedDates.length - 1] ?? ""

  const labeled: LabeledEntry[] = []
  let backlog = 0
  for (const e of entries) {
    const absorbed = !unabsorbedIds.has(e.id)
    if (!absorbed && String(e.date ?? "") >= newest) { backlog++; continue }
    labeled.push({ ...e, absorbed })
  }
  return { labeled, backlog }
}

/**
 * A stratified sample, because the classes are wildly unbalanced.
 *
 * 14% of entries were absorbed. A uniform sample of 400 would carry
 * ~58 positives, and every metric that matters — recall of the things
 * worth keeping, the threshold that preserves it — would rest on those
 * 58. Sampling each class separately buys a usable positive count at the
 * same total cost; the base rate is restored when reporting.
 */
export function sample<T>(
  items: T[],
  isPositive: (t: T) => boolean,
  n: number,
  rng: () => number = Math.random,
): T[] {
  const pos = items.filter(isPositive)
  const neg = items.filter((t) => !isPositive(t))
  const want = Math.min(n, items.length)
  const wantPos = Math.min(pos.length, Math.floor(want / 2))
  const wantNeg = Math.min(neg.length, want - wantPos)
  return [...pick(pos, wantPos, rng), ...pick(neg, wantNeg, rng)]
}

function pick<T>(items: T[], n: number, rng: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

export interface TriageOutcome {
  entry: LabeledEntry
  verdict: TriageVerdict
  /** P(a wiki would cite this at all) — the signal aligned with the label. */
  citeWorthy?: number
}

export interface BacktestReport {
  n: number
  positives: number
  negatives: number
  /** Absorbed entries the gate would have kept. The number that matters:
   *  a dropped positive is knowledge destroyed, silently. */
  recall: number
  /** Of what the gate kept, the share absorb also kept. */
  precision: number
  /** Share of entries the gate would have spared the writing model. */
  filtered: number
  /** Positives the gate would have dropped. */
  lostPositives: number
  accuracy: number
  /** Of the positives the gate dropped, which condition rejected them.
   *  A gate can fail three different ways and the fix differs for each,
   *  so a single recall number is not actionable on its own. */
  droppedBy: { type: number; worth: number; durability: number }
  /** Mean signal values among positives, to see how far off the
   *  thresholds actually are. */
  positiveMeans: { worth: number; durability: number; typeConfidence: number }
}

export function scoreBacktest(
  outcomes: TriageOutcome[],
  policy: { minType?: number; minWorth?: number; minDurability?: number } = {},
): BacktestReport {
  const minType = policy.minType ?? 0.5
  const minWorth = policy.minWorth ?? 0.5
  const minDurability = policy.minDurability ?? 1.5

  const positives = outcomes.filter((o) => o.entry.absorbed).length
  const negatives = outcomes.length - positives
  const keptPos = outcomes.filter((o) => o.entry.absorbed && o.verdict.absorb).length
  const keptNeg = outcomes.filter((o) => !o.entry.absorbed && o.verdict.absorb).length
  const kept = keptPos + keptNeg

  const lost = outcomes.filter((o) => o.entry.absorbed && !o.verdict.absorb)
  const droppedBy = {
    type: lost.filter((o) => o.verdict.type === "none" || o.verdict.typeConfidence < minType).length,
    worth: lost.filter((o) => o.verdict.worthKeeping < minWorth).length,
    durability: lost.filter((o) => o.verdict.durability < minDurability).length,
  }
  const pos = outcomes.filter((o) => o.entry.absorbed)
  const mean = (f: (o: TriageOutcome) => number) =>
    pos.length ? pos.reduce((a, o) => a + f(o), 0) / pos.length : 0

  return {
    n: outcomes.length,
    positives,
    negatives,
    droppedBy,
    positiveMeans: {
      worth: mean((o) => o.verdict.worthKeeping),
      durability: mean((o) => o.verdict.durability),
      typeConfidence: mean((o) => o.verdict.typeConfidence),
    },
    recall: positives ? keptPos / positives : 0,
    precision: kept ? keptPos / kept : 0,
    filtered: outcomes.length ? 1 - kept / outcomes.length : 0,
    lostPositives: positives - keptPos,
    accuracy: outcomes.length
      ? (keptPos + (negatives - keptNeg)) / outcomes.length
      : 0,
  }
}

/**
 * Rows for the shared calibration metrics.
 *
 * The scalar graded is P(worth keeping), not the gate's boolean: the
 * boolean is a policy over three signals and thresholds, and calibrating
 * a policy tells you about the thresholds rather than the model. The
 * probability is the thing the model actually produced.
 */
export function toGradedRows(outcomes: TriageOutcome[], model: string, backend: string): GradedRow[] {
  return outcomes.map((o, i) => ({
    callId: `backtest-${i}`,
    seat: "entry-triage",
    ts: Date.now(),
    backend,
    model,
    structureMode: "backtest",
    question: "worthKeeping",
    type: "noul" as const,
    predicted: o.verdict.worthKeeping >= 0.5 ? "true" : "false",
    confidence: Math.max(o.verdict.worthKeeping, 1 - o.verdict.worthKeeping),
    probabilities: { true: o.verdict.worthKeeping, false: 1 - o.verdict.worthKeeping },
    truth: o.entry.absorbed ? "true" : "false",
    features: { source: o.entry.source ?? "", type: o.verdict.type },
    mode: "shadow" as const,
    explored: false,
  }))
}

export interface SweepPoint {
  /** Whether the policy required a non-`none` article type at all. */
  requireTyped: boolean
  minType: number
  minWorth: number
  minDurability: number
  recall: number
  precision: number
  filtered: number
  lostPositives: number
}

/**
 * Re-score already-graded outcomes under many policies.
 *
 * The model calls are the expensive part and they are already paid for;
 * the thresholds are free to vary afterwards. This is the difference
 * between "the gate scored 25%" and "the gate scores 25% at these three
 * numbers, and here is what it scores at every other set".
 *
 * Recall is the constraint, not the objective. A dropped positive is an
 * article that never gets written and nobody ever learns was missing,
 * whereas a kept negative costs one Sonnet read. The asymmetry is
 * enormous, so the sweep maximises filtering *subject to* a recall
 * floor rather than trading the two off.
 */
export function sweepPolicies(
  outcomes: TriageOutcome[],
  opts: { minRecall?: number } = {},
): { best: SweepPoint | null; points: SweepPoint[] } {
  const floor = opts.minRecall ?? 0.95
  const grid = {
    // Whether a non-`none` type is required at all. The first sweep
    // hard-coded this to true and no policy could clear 45% recall,
    // which looked like a tuning failure and was really this one
    // condition: absorb frequently MERGES an entry into an existing
    // article, so an entry can be cited without being an article of its
    // own. "What type is this?" and "did absorb use this?" are different
    // questions, and only the second is the label.
    requireTyped: [true, false],
    type: [0, 0.2, 0.3, 0.4, 0.5],
    worth: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
    durability: [0, 0.5, 1.0, 1.5],
  }

  const points: SweepPoint[] = []
  for (const requireTyped of grid.requireTyped) {
  for (const minType of grid.type) {
    for (const minWorth of grid.worth) {
      for (const minDurability of grid.durability) {
        const keep = (o: TriageOutcome) =>
          (!requireTyped || (o.verdict.type !== "none" && o.verdict.typeConfidence >= minType)) &&
          o.verdict.worthKeeping >= minWorth &&
          o.verdict.durability >= minDurability

        const pos = outcomes.filter((o) => o.entry.absorbed)
        const keptPos = pos.filter(keep).length
        const kept = outcomes.filter(keep).length
        points.push({
          requireTyped, minType, minWorth, minDurability,
          recall: pos.length ? keptPos / pos.length : 0,
          precision: kept ? keptPos / kept : 0,
          filtered: outcomes.length ? 1 - kept / outcomes.length : 0,
          lostPositives: pos.length - keptPos,
        })
      }
    }
  }
  }

  // Most filtering among the policies that clear the recall floor.
  const viable = points.filter((p) => p.recall >= floor)
  viable.sort((a, b) => b.filtered - a.filtered)
  return { best: viable[0] ?? null, points }
}
