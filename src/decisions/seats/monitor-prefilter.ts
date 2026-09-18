import type Database from "better-sqlite3"
import { noul } from "../questions"
import type { DecisionStore } from "../store"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// The monitor pre-filter seat.
//
// src/daemon/session-monitor.ts spends one opus call per completed run,
// fleet-wide, on a 5s tick. Most of those runs produce a review nobody ever
// acts on. This seat asks a cheap model whether the expensive call is worth
// making.
//
// The saving is NOT dollars. reviewWithClaude deliberately strips
// ANTHROPIC_API_KEY to force the CLI onto subscription auth, so what a
// skipped review returns is rate-limit headroom and ~180s of serialised
// wall clock — and a pre-filter routed through the API path would *add*
// dollar cost while saving quota. Keep it on the subscription path.
//
// Two questions, and the second one is the point of the design:
//
//   worthReviewing  the real decision. Ground truth is derived from what
//                   happened to the review afterwards, and is only
//                   available for rows the outcome actually settles.
//
//   runHitAnError   a CONTROL. The answer is stated plainly in the state
//                   we hand over, and the truth is known exactly for every
//                   single row. It costs almost nothing (questions fan out
//                   across one shared state) and it is the cheapest
//                   possible check on whether the backend can read the
//                   input at all. A backend that cannot score this is not
//                   worth believing on the question that matters.
//
// Deviation from the original plan, recorded on purpose: the plan called
// for a three-way Choice over {skip, summary_only, full_review}. It is not
// here because no outcome in the system distinguishes summary_only from
// full_review, so that category could never be scored — it would put a
// number on the dashboard that is permanently unfalsifiable, which is the
// exact failure this harness exists to prevent.

export const MONITOR_PREFILTER_SEAT = "monitor-prefilter"

export const monitorPrefilterQuestions = {
  worthReviewing: noul(
    "Would a person act on a written review of this run?",
    {
      true:
        "The run left something unresolved, surprising, risky, or needing a decision — " +
        "a review would produce a follow-up someone actually does.",
      false:
        "The run did what was asked and ended cleanly. A review would produce a summary " +
        "nobody reads and no follow-up.",
    },
  ),
  runHitAnError: noul("Did this run fail, error, or get cancelled?", {
    true: "The run's status is anything other than success.",
    false: "The run completed successfully.",
  }),
}

export type MonitorPrefilterAnswers = AnswersFor<typeof monitorPrefilterQuestions>

/** A run whose status is anything but ok/completed. Read from the evidence
 *  rather than the database so replay and the live path agree. */
export function runFailed(evidence: any): boolean {
  const status = String(evidence?.task?.status ?? "").toLowerCase()
  if (!status) return false
  return !["ok", "completed", "success", "succeeded"].includes(status)
}

/**
 * A compact state for the pre-filter.
 *
 * Deliberately NOT the evidence the reviewer gets. That payload carries a
 * 16k prompt, a 24k response and sixty trace steps, which would be
 * truncated at the backend's budget and would make the "cheap" call cost
 * nearly as much as the one it is trying to avoid. Deciding *whether* a
 * review is worth writing needs far less than writing one.
 */
export function prefilterState(evidence: any): StateValue {
  const task = evidence?.task ?? {}
  const steps: any[] = Array.isArray(evidence?.steps) ? evidence.steps : []
  const stepErrors = steps
    .filter((s) => s?.status && String(s.status).toLowerCase() !== "ok")
    .slice(-5)
    .map((s) => String(s.tool ?? s.kind ?? "step").slice(0, 80))

  return {
    agent: str(task.agentId, 80),
    channel: str(task.channel, 40),
    status: str(task.status, 40),
    error: str(task.error, 400),
    durationMs: typeof task.durationMs === "number" ? task.durationMs : null,
    stepCount: steps.length,
    failedSteps: stepErrors,
    request: str(task.originalMessage ?? task.messagePreview, 1200),
    response: tail(task.finalResponse, 2000),
  }
}

export interface SkipPolicy {
  /** Confidence floor on the yes/no call before a skip is permitted. */
  minConfidence?: number
  /** A skip also needs the model to actively believe nobody would act. */
  maxWorth?: number
  /** Hard override: a failed run is always reviewed. */
  runFailed: boolean
}

/**
 * Whether the expensive review can be skipped. Three conditions, all
 * required, because the cost of a wrong skip (a real problem nobody hears
 * about) is far higher than the cost of a wrong review (one opus call).
 *
 * The runFailed override is not a confidence threshold and cannot be tuned
 * away: a run that errored gets reviewed no matter what any model says.
 */
export function shouldSkip(answers: MonitorPrefilterAnswers, policy: SkipPolicy): boolean {
  if (policy.runFailed) return false

  const worth = answers.worthReviewing as NoulAnswer
  const maxWorth = policy.maxWorth ?? 0.2
  const minConfidence = policy.minConfidence ?? 0.8

  if (worth.noul > maxWorth) return false
  // A noul's confidence is its distance from a coin flip, scaled to [0,1].
  const confidence = Math.abs(worth.noul - 0.5) * 2
  return confidence >= minConfidence
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export interface MonitorLabels {
  worthReviewing?: "yes" | "no"
  runHitAnError: "yes" | "no"
}

/**
 * What the outcome actually settles, and nothing more.
 *
 *   worthReviewing = yes  someone marked one of the review's actions done,
 *                         or the review raised an action flagged "now"
 *   worthReviewing = no   the review produced no actions and no warnings
 *   (omitted)             actions exist but are all "later" and untouched.
 *                         Genuinely ambiguous, so it stays unlabeled and
 *                         waits for a human via `agentx decisions unlabeled`.
 *
 * runHitAnError is always known, which is what makes it a usable control.
 */
export function labelFromOutcome(db: Database.Database, reviewId: string): MonitorLabels | null {
  const row = db
    .prepare("SELECT status, result FROM session_reviews WHERE id = ?")
    .get(reviewId) as { status: string; result: string | null } | undefined
  if (!row) return null

  const trace = db
    .prepare("SELECT status FROM task_traces WHERE task_id = ?")
    .get(reviewId) as { status: string } | undefined
  const errored = trace ? !["ok", "completed", "success", "succeeded"].includes(
    String(trace.status).toLowerCase(),
  ) : undefined
  if (errored === undefined) return null

  const labels: MonitorLabels = { runHitAnError: errored ? "yes" : "no" }

  if (row.status !== "ready" || !row.result) return labels

  let review: any
  try {
    review = JSON.parse(row.result)
  } catch {
    return labels
  }

  const actions: any[] = Array.isArray(review?.actions) ? review.actions : []
  const warnings: any[] = Array.isArray(review?.warnings) ? review.warnings : []

  const doneCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM monitor_action_states WHERE review_id = ? AND state = 'done'")
      .get(reviewId) as { n: number }
  ).n

  if (doneCount > 0 || actions.some((a) => a?.when === "now")) {
    labels.worthReviewing = "yes"
  } else if (actions.length === 0 && warnings.length === 0) {
    labels.worthReviewing = "no"
  }

  return labels
}

/** Attach outcome labels to every recorded pre-filter call that does not
 *  have one yet. Returns how many labels were written. */
export function backfillMonitorLabels(db: Database.Database, store: DecisionStore): number {
  const rows = store.gradedRows({ seat: MONITOR_PREFILTER_SEAT })
  let written = 0
  for (const row of rows) {
    if (row.truth !== undefined) continue
    const reviewIds = store.db
      .prepare("SELECT ref_id FROM decision_links WHERE call_id = ? AND ref_kind = 'review'")
      .all(row.callId) as Array<{ ref_id: string }>
    const reviewId = reviewIds[0]?.ref_id
    if (!reviewId) continue

    const labels = labelFromOutcome(db, reviewId)
    if (!labels) continue

    const value = labels[row.question as keyof MonitorLabels]
    if (!value) continue
    store.label(row.callId, row.question, value, { kind: "outcome", labeledBy: "monitor" })
    written++
  }
  return written
}

function str(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > max ? text.slice(0, max) : text
}

function tail(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > max ? text.slice(-max) : text
}
