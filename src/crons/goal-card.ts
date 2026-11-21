import { createCard, listCards, type CardInput, type DecisionCard } from "@/approvals/cards"
import type { CronGoalOrigin } from "@/approvals/origin"
export { cronGoalChoice, cronGoalLines } from "@/approvals/origin"
import { addNote, dropNote, jobGoalState, updateJobGoalState, type GoalCheckState, type GoalChoice } from "./goal-state"

// --- The keep / change / drop card of a schedule on goal check (#863) ---
//
// The daemon raises it, never the agent (the card API takes no origin):
// once the owner's recommendation run ends, or 2 h after the owner was
// woken, whichever comes first. One card per job and goal: a pending card
// with the same origin is taken over, never doubled. Raised for the owner
// agent (`raised_by`), so the decided-card notice loop tells the owner the
// answer; not popup-only, so the operator answers from any surface. It
// never expires (cards.ts expireCards).

export const GOAL_CARD_LABELS: Record<GoalChoice, string> = { keep: "Keep", change: "Change", drop: "Drop" }
export const GOAL_CARD_CHOICES = [GOAL_CARD_LABELS.keep, GOAL_CARD_LABELS.change, GOAL_CARD_LABELS.drop]

/** How long after the owner was woken the card goes up without it. */
export const RECOMMEND_WAIT_MS = 2 * 3_600_000

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The card's fields, from the goal-check state. */
export function goalCardInput(job: { id: string; agent: string }, g: GoalCheckState): CardInput {
  const what = g.reason === "closed" ? "is closed" : `has not moved for ${g.days ?? 30} days`
  const rec = g.recommend
  return {
    title: cut(`Schedule ${job.id}: its goal ${g.goalId} ${what}`, 120),
    ask: cut(`Keep, change or drop the schedule ${job.id} (run by ${job.agent})? ${rec ? "A plain yes takes the recommendation shown." : "Pick Keep, Change or Drop."} No keeps the job.`, 300),
    recommend: cut(rec ? `${GOAL_CARD_LABELS[rec.choice]}: ${rec.why}` : `No recommendation from ${job.agent}.`, 300),
    context: "The job does not run until you answer. No expiry: the job stays held until you answer.",
    // Never applied: cron-goal cards do not expire. The schema needs both.
    if_silent: "keep",
    expires: "30d",
    raised_by: job.agent,
    choices: GOAL_CARD_CHOICES,
  }
}

/** The pending card of this job and goal, if any. */
export function pendingGoalCard(root: string, jobId: string, goalId: string): DecisionCard | undefined {
  return listCards(root, "pending").find((c) =>
    c.origin?.kind === "cron-goal" && c.origin.jobId === jobId && c.origin.goalId === goalId)
}

export type RaiseResult = { ok: true; cardId: string; adopted: boolean } | { ok: false; error: string } | { ok: "skip" }

/**
 * Raise the job's goal card now, with the owner's recommendation if it
 * gave one. Skips when the job is not on goal check, already has its card,
 * or was answered drop. A refusal (twin, cap of pending cards, anything
 * else) is written as one Wall line; the next fire retries, with no new
 * wake of the owner.
 */
export function raiseGoalCard(
  root: string,
  job: { id: string; agent: string },
  opts: { now: number; log: (msg: string) => void },
): RaiseResult {
  const g = jobGoalState(root, job.id, opts.log).goalCheck
  if (!g || g.cardId || g.reason === "drop-answered") return { ok: "skip" }
  const at = new Date(opts.now).toISOString()
  const origin: CronGoalOrigin = { kind: "cron-goal", jobId: job.id, goalId: g.goalId }
  const twin = pendingGoalCard(root, job.id, g.goalId)
  let cardId: string
  if (twin) {
    cardId = twin.id
  } else {
    const made = createCard(root, goalCardInput(job, g), { now: opts.now, origin })
    if (!made.ok) {
      opts.log(`[cron-goal] goal card for "${job.id}" refused: ${made.error}`)
      try {
        updateJobGoalState(root, job.id, (s) => {
          if (s.goalCheck) s.goalCheck.refused = { error: made.error, at }
          addNote(s, "card-refused", `goal card for ${job.id} refused: ${made.error}`, at)
        })
      } catch (e: any) {
        opts.log(`[cron-goal] "${job.id}": could not record the refusal: ${e?.message ?? e}`)
      }
      return { ok: false, error: made.error }
    }
    cardId = made.card.id
  }
  try {
    updateJobGoalState(root, job.id, (s) => {
      if (!s.goalCheck) return
      s.goalCheck.cardId = cardId
      delete s.goalCheck.refused
      dropNote(s, "card-refused")
    })
  } catch (e: any) {
    // The card is on disk: the next fire finds it by its origin.
    opts.log(`[cron-goal] "${job.id}": card ${cardId} raised, but its id was not saved: ${e?.message ?? e}`)
  }
  opts.log(`[cron-goal] "${job.id}": goal card ${cardId} ${twin ? "taken over" : "raised"}`)
  return { ok: true, cardId, adopted: !!twin }
}
