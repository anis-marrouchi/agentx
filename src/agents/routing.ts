import { askSeat } from "@/decisions/seat"
import {
  TASK_TIER_SEAT,
  taskTierQuestions,
  taskTierState,
  needsFlagship,
  type TaskTierAnswers,
  type TaskTierInput,
} from "@/decisions/seats/task-tier"

// Picking a cheaper model for work that does not need an expensive one.
//
// The policy, in one line: keep the flagship unless the seat is ACTIVE and
// confidently says the task is mechanical.
//
// Every branch that is not that leads to the flagship — seat off, seat in
// shadow, backend unreachable, answer above the threshold, no cheap model
// configured, a follow-up turn. That is not defensiveness for its own
// sake. Downgrading is invisible in the output: the reply still arrives,
// still reads fluently, and is simply worse in ways nobody checks. An
// outage that silently made the whole fleet dumber would cost far more
// than the tokens it saved, so the failure has to land on the expensive
// side.
//
// Follow-ups keep the flagship regardless. A second turn inherits the
// difficulty of the first, and swapping models inside a live session
// changes who is answering halfway through a conversation.

/** Below this P(needs the strongest model), a cheaper one will do.
 *
 *  Low on purpose. This is not the point at which a small model becomes
 *  adequate — it is the point past which being wrong is cheap, and the
 *  asymmetry between "saved a fraction of a cent" and "gave a subtly wrong
 *  answer nobody caught" is not close. */
const DOWNGRADE_BELOW = 0.2

export interface RouteResult {
  /** The model to use, or undefined to leave the agent's own default. */
  model?: string
  /** True when this call moved the task off the flagship. */
  downgraded: boolean
  /** P(needs the strongest model), or null when nothing was asked. */
  needsFlagship: number | null
  reason: string
}

export interface RouteOptions extends TaskTierInput {
  /** The model to drop to. Usually from config; no downgrade without it. */
  cheapModel?: string | null
  threshold?: number
}

/**
 * Decide whether this task can run on a cheaper model.
 *
 * Never throws and never blocks: a routing decision must not be able to
 * stop a task from running.
 */
export async function routeTaskModel(opts: RouteOptions): Promise<RouteResult> {
  const keep = (reason: string, p: number | null = null): RouteResult => ({
    downgraded: false, needsFlagship: p, reason,
  })

  if (!opts.cheapModel) return keep("no cheaper model configured")
  // A conversation should not change who is answering it partway through.
  if (opts.isFollowUp) return keep("follow-up turn — keeping the session's model")

  let result
  try {
    result = await askSeat(
      TASK_TIER_SEAT,
      taskTierState(opts),
      taskTierQuestions,
      {
        // The incumbent is "always flagship", which is what this has to beat.
        incumbent: { needsFlagship: 1 },
        features: { agent: opts.agent, channel: opts.channel ?? "unknown" },
      },
    )
  } catch {
    return keep("routing seat threw — keeping the flagship")
  }

  if (!result) return keep("routing seat unavailable — keeping the flagship")

  const p = needsFlagship(result.answers as TaskTierAnswers)

  // Shadow records the answer and changes nothing. This is the whole
  // point of a soak: the rows accumulate against real traffic while the
  // incumbent stays authoritative, so promotion is a decision made on
  // evidence rather than on how good the idea sounded.
  if (result.mode !== "active") {
    return keep(`shadow — would ${p < (opts.threshold ?? DOWNGRADE_BELOW) ? "downgrade" : "keep"} (${p.toFixed(2)})`, p)
  }

  const threshold = opts.threshold ?? DOWNGRADE_BELOW
  if (p >= threshold) return keep(`needs the flagship (${p.toFixed(2)})`, p)

  return {
    model: opts.cheapModel,
    downgraded: true,
    needsFlagship: p,
    reason: `mechanical task (${p.toFixed(2)} below ${threshold}) → ${opts.cheapModel}`,
  }
}
