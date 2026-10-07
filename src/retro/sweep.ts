import type Database from "better-sqlite3"
import { getTrace, listTraces, type TraceRecord } from "@/storage/traces"
import { listCards } from "@/approvals/cards"
import type { ApprovalSettings } from "@/approvals/sweep"
import {
  earlierRetros,
  isRetroRun,
  prepareRetro,
  raiseRetroCard,
  readMonitorReview,
  signatureOf,
  newSignalCache,
  struggleSignals,
  type StruggleSignal,
} from "./retro"

// --- Nightly retro sweep (#743, P1) ---
//
// `agentx retro <taskId>` reads one run the operator picked. The sweep picks
// them itself: it ranks the window's runs by how badly they struggled,
// keeps one run per failure, and raises cards for the worst few. A nightly
// schedule calls it (`agentx retro sweep --commit`), next to `wiki promote`.
//
// Without --commit it only ranks: no reviewer is asked and no card raised.
// The limits on noise all hold here: at most `max` retro cards in any 24
// hours (cards raised by hand count too), one open card per failure, the
// 30-day rule on turned-down fixes, and never a retro's own runs.

/** How much each sign of struggle weighs when ranking. A run that failed
 *  or was cut off outranks one that was only slow. */
export const SIGNAL_WEIGHT: Record<StruggleSignal["kind"], number> = {
  "failed": 3,
  "restart-killed": 3,
  "recurring": 2,
  "delegation": 2,
  "slow": 1,
  "many-tools": 1,
  "friction": 1,
}

/** Retro cards a day, unless `--max` says otherwise. */
export const DEFAULT_RETRO_PER_DAY = 3
/** The window the sweep reads, unless `--since` says otherwise. */
export const DEFAULT_SWEEP_HOURS = 24
/** Runs read per sweep at most: a busy fleet's day, not its whole history. */
const MAX_RUNS_READ = 1000
const DAY_MS = 86_400_000

export interface RankedRun {
  task: TraceRecord
  signals: StruggleSignal[]
  score: number
  signature: string
}

/** The window's struggled runs, worst first, one per failure signature. */
export function rankStruggledRuns(
  db: Database.Database,
  root: string,
  opts: { since: number; now?: number },
): RankedRun[] {
  const now = opts.now ?? Date.now()
  const best = new Map<string, RankedRun>()
  const cache = newSignalCache()
  for (const task of listTraces(db, { since: opts.since, limit: MAX_RUNS_READ })) {
    if (task.status === "in-flight" || isRetroRun(root, task)) continue
    const steps = getTrace(db, task.taskId)?.steps ?? []
    const signals = struggleSignals(db, task, steps, readMonitorReview(db, task.taskId), now, cache)
    if (!signals.length) continue
    const run: RankedRun = { task, signals, score: signals.reduce((n, s) => n + SIGNAL_WEIGHT[s.kind], 0), signature: signatureOf(task, steps) }
    const prev = best.get(run.signature)
    if (!prev || worse(run, prev)) best.set(run.signature, run)
  }
  return [...best.values()].sort((a, b) => (worse(a, b) ? -1 : worse(b, a) ? 1 : 0))
}

/** Higher score first; on a tie, the more recent run. */
function worse(a: RankedRun, b: RankedRun): boolean {
  return a.score !== b.score ? a.score > b.score : a.task.startedAt > b.task.startedAt
}

/** Retro cards raised in the last 24 hours, by the sweep or by hand. */
export function retroCardsToday(root: string, now = Date.now()): number {
  return listCards(root).filter((c) => c.origin?.kind === "retro" && Date.parse(c.created_at) > now - DAY_MS).length
}

export type SweepOutcome =
  | { taskId: string; agentId: string; result: "raised"; cardId: string }
  | { taskId: string; agentId: string; result: "skipped"; why: string }
  | { taskId: string; agentId: string; result: "would-try" }

export interface SweepOptions {
  root: string
  db: Database.Database
  /** The reviewer, as for `prepareRetro`. Not called without `commit`. */
  propose: (input: string) => Promise<string>
  settings: ApprovalSettings
  since: number
  /** Retro cards allowed in any 24 hours. */
  max?: number
  /** Ask the reviewer and raise cards. Off: rank only. */
  commit?: boolean
  now?: number
}

export interface SweepResult {
  ranked: RankedRun[]
  /** Room left under the daily limit when the sweep started. */
  room: number
  outcomes: SweepOutcome[]
  /** Set when the sweep could not run at all. */
  error?: string
}

/** Rank the window's runs and, with `commit`, raise cards for the worst. */
export async function sweepRetros(opts: SweepOptions): Promise<SweepResult> {
  const now = opts.now ?? Date.now()
  const ranked = rankStruggledRuns(opts.db, opts.root, { since: opts.since, now })
  const room = Math.max(0, (opts.max ?? DEFAULT_RETRO_PER_DAY) - retroCardsToday(opts.root, now))
  const outcomes: SweepOutcome[] = []
  if (opts.commit && opts.settings.forwardTo) {
    return {
      ranked, room, outcomes,
      error: `approvals.forwardTo is set (${opts.settings.forwardTo}): retro cards can't be forwarded to another machine yet. Run the sweep on a machine that keeps its own cards.`,
    }
  }

  // A reviewer answer can still be unusable, so a failed attempt lets the
  // next run in line try, but never more than twice the room: each attempt
  // costs a reviewer call.
  let raised = 0
  let attempts = 0
  for (const run of ranked) {
    if (raised >= room || attempts >= room * 2) break
    const who = { taskId: run.task.taskId, agentId: run.task.agentId }
    const open = earlierRetros(opts.root, run.signature, now).open
    if (open) { outcomes.push({ ...who, result: "skipped", why: `card:${open.id} already asks about this failure` }); continue }
    if (!opts.commit) { outcomes.push({ ...who, result: "would-try" }); raised++; continue }

    attempts++
    const r = await prepareRetro({ root: opts.root, db: opts.db, taskId: run.task.taskId, propose: opts.propose, now })
    if (!r.ok) { outcomes.push({ ...who, result: "skipped", why: r.error }); continue }
    const card = raiseRetroCard(opts.root, r.card, opts.settings)
    if (!card.ok) { outcomes.push({ ...who, result: "skipped", why: card.error }); continue }
    outcomes.push({ ...who, result: "raised", cardId: card.card.id })
    raised++
  }
  return { ranked, room, outcomes }
}
