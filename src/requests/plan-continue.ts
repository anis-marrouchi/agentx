import { CLOSED_STATES, type RequestRecord, type RequestStore } from "./store"
import type { PlanStep, PlanStore } from "./plan-store"
import { checkCount, readCountSpec, type ForgeCounter } from "./checkers/count"
import { continueText, type ContinueSettings } from "./plans"
import { cardWords } from "./card-view"

// --- Keep a step moving when a turn ends (#1568) ---
//
// The plan check nudges a step after 30 quiet minutes. That is too slow for
// work that is moving: most nudges got back a status line, not more work.
// So when a turn on a plan step ends (a pick-up turn in the request's own
// chat), the daemon looks at the step:
//   - done or blocked: nothing here; the plan check moves on or tells the
//     owner, as before;
//   - still active and it moved during the turn (its count went down, or
//     the agent reported new progress): the next turn starts at once;
//   - still active and nothing moved: nothing; the nudge is the safety net.
// Turns started this way are capped per goal (or request, without a goal)
// per day, by count and by cost. At the cap the owner is told once and the
// nudges take over.

/** How a turn on a request's chat ended (task:completed). */
export interface TurnEnd {
  /** The run's id: it must be a run the daemon linked to the request when
   *  it started its pick-up turn. A /task call that only names the
   *  requests channel is not one. */
  taskId?: string
  agentId: string
  chatId: string
  durationMs: number
  error?: string
  stopped?: boolean
  interrupted?: boolean
  costUsd?: number
}

export interface ContinueDeps {
  requests: RequestStore
  plans: PlanStore
  settings: ContinueSettings
  /** Start a turn on the step's owner in the request's chat. */
  tellAgent: (agentId: string, text: string, request: RequestRecord, step: PlanStep) => Promise<void>
  notify?: (title: string, message: string, request: RequestRecord) => Promise<void>
  /** Reads open counts, for steps with a count check. */
  counter?: ForgeCounter
  /** Requests whose last turn this daemon started on its own: their next
   *  turn end is charged to the goal's daily cost. */
  started: Set<string>
  /** A step was marked done here: run the plan check soon. */
  onDone?: () => void
  log: (msg: string) => void
  now?: number
}

export type ContinueOutcome = "continued" | "capped" | "still" | null

/** The goal a request's turns are capped under: its goal, else itself. */
export const goalKey = (r: RequestRecord) => r.goal?.id ? `goal:${r.goal.id}` : `request:${r.id}`

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
const sameWords = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

/** Read a step's open count now and record it. A lower count than the
 *  last one is logged as "count-down": the step moved. Never throws. */
export async function refreshCount(plans: PlanStore, step: PlanStep, counter: ForgeCounter | undefined, now: number) {
  const spec = readCountSpec(step.checkCount)
  if (!spec) return null
  const res = await checkCount(spec, counter)
  if (res.count === undefined) {
    plans.updateStep(step.requestId, step.idx, { lastCountAt: now })
    return res
  }
  const last = step.lastCount
  plans.updateStep(step.requestId, step.idx, { lastCount: res.count, lastCountAt: now })
  if (last !== null && res.count !== last) {
    plans.event(step.requestId, step.idx, res.count < last ? "count-down" : "count-up", `${last} → ${res.detail}`, now)
  } else if (last === null) {
    plans.event(step.requestId, step.idx, "count", res.detail, now)
  }
  return res
}

/** How many of a step's latest progress reports to compare. */
const PROGRESS_LOOKBACK = 200

/** What moved on the step since `since`, in words, or null. */
function movedSince(plans: PlanStore, step: PlanStep, since: number): string | null {
  const down = plans.stepEvents(step.requestId, step.idx, "count-down", 1).find((e) => e.at >= since)
  if (down) return `count ${down.detail}`
  // With a count check, the count is the measure: words alone are not.
  if (readCountSpec(step.checkCount)) return null
  const progress = plans.stepEvents(step.requestId, step.idx, "progress", PROGRESS_LOOKBACK)
  for (let i = progress.length - 1; i >= 0 && progress[i].at >= since; i--) {
    // The oldest one read is the step's first report only when the log held no more.
    const first = i === 0 && progress.length < PROGRESS_LOOKBACK
    if (first || (i > 0 && sameWords(progress[i].detail) !== sameWords(progress[i - 1].detail))) return "new progress reported"
  }
  return null
}

export async function continueOnTurnEnd(deps: ContinueDeps, end: TurnEnd): Promise<ContinueOutcome> {
  const { requests, plans, settings, log } = deps
  const now = deps.now ?? Date.now()
  const r = requests.get(end.chatId)
  if (!r || CLOSED_STATES.includes(r.state as any)) return null
  // Only a turn the daemon started on this request (#1568 review): the
  // tracker links a pick-up's run when it starts; any caller of /task can
  // name the channel, but not make that link.
  if (!end.taskId || ![requests.byLink("run", end.taskId), requests.byLink("step_run", end.taskId)].some((x) => x?.id === r.id)) return null
  const charged = deps.started.delete(r.id)
  const key = goalKey(r)
  const day = utcDay(now)
  if (charged && end.costUsd) plans.addContinue(key, day, { costUsd: end.costUsd })
  if (!settings.enabled) return null
  if (settings.only.length && !settings.only.includes(r.id) && !(r.goal && settings.only.includes(r.goal.id))) return null
  if (plans.get(r.id)?.state !== "active") return null
  // A turn that failed, was stopped or cut by a shutdown is not progress.
  if (end.error || end.stopped || end.interrupted) return null
  const steps = plans.steps(r.id)
  let step = steps.find((s) => s.state !== "done" && s.state !== "skipped")
  if (!step || step.state !== "active" || step.agentId !== end.agentId || step.dispatchedAt === null) return null

  const since = now - Math.max(0, end.durationMs)
  if (step.checkCount) {
    const res = await refreshCount(plans, step, deps.counter, now)
    // Met: done now, as the plan check would mark it, rather than at its
    // next count read up to 5 minutes later (#1568 review). The plan
    // check hands on the next step.
    if (res?.verdict === "met") {
      plans.updateStep(r.id, step.idx, { state: "done", evidence: res.detail, updatedAt: now })
      plans.event(r.id, step.idx, "done", `check: ${res.detail}`, now)
      requests.progress(r.id, now)
      deps.onDone?.()
      return null
    }
    step = plans.step(r.id, step.idx) ?? step
  }
  const moved = movedSince(plans, step, since)
  if (!moved) return "still"

  const used = plans.continues(key, day)
  if (used.turns >= settings.maxTurnsPerDay || used.costUsd >= settings.maxCostUsdPerDay) {
    if (used.toldAt === null) {
      plans.addContinue(key, day, { toldAt: now })
      const why = `${used.turns} turns, $${used.costUsd.toFixed(2)} today (cap ${settings.maxTurnsPerDay} turns, $${settings.maxCostUsdPerDay})`
      plans.event(r.id, step.idx, "continue-capped", why, now)
      try {
        await deps.notify?.(`Plan paused at its daily cap: ${cardWords(r, 80).headline}`,
          `Step ${step.idx} "${step.name}" (${step.agentId}) is still moving, but its turns started on their own reached the cap: ${why}. The 30-minute nudges carry on; the cap resets at 00:00 UTC (requests.plans.continue).`, r)
      } catch (e: any) {
        log(`[plans] ${r.id}: couldn't tell the owner about the continue cap: ${e?.message ?? e}`)
      }
    }
    return "capped"
  }

  const turn = used.turns + 1
  plans.addContinue(key, day, { turns: 1 })
  try {
    await deps.tellAgent(step.agentId, continueText(r, steps, step, moved, turn, settings.maxTurnsPerDay), r, step)
    deps.started.add(r.id)
    plans.event(r.id, step.idx, "continued", `${step.agentId}, turn ${turn} of ${settings.maxTurnsPerDay} today: ${moved}`, now)
    requests.touch(r.id, now)
    log(`[plans] ${r.id} step ${step.idx}: continued ${step.agentId} (${turn}/${settings.maxTurnsPerDay}): ${moved}`)
    return "continued"
  } catch (e: any) {
    plans.addContinue(key, day, { turns: -1 })
    plans.event(r.id, step.idx, "continue-failed", `${step.agentId}: ${e?.message ?? e}`, now)
    return null
  }
}
