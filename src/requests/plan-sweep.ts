import type { DecisionCard } from "@/approvals/cards"
import { CLOSED_STATES, type RequestRecord, type RequestStore } from "./store"
import { FINISHED_STEP_STATES, type PlanRecord, type PlanStep, type PlanStore } from "./plan-store"
import {
  approvalCardInput, blockedText, dispatchText, MESSAGE_KIND, nudgeText, planEvidence, summaryText, type PlanSettings,
} from "./plans"

// --- The daemon's plan check, once a minute (#788) ---
//
// For every active plan, in order:
//   1. Approval: each step whose kind the owner approves (approveKinds)
//      gets one decision card when the plan is new. A yes approves it (with
//      the owner's edit of a message); a no skips it; an expired card
//      blocks it.
//   2. The current step (the first one not done or skipped):
//        - a work step is handed to its owner agent as a turn, once;
//        - a message step is sent by the daemon, once it is approved;
//        - a step with a URL check is marked done when the address answers.
//      A step that finishes here lets the next one start in the same check.
//   3. Stall: a work step with no progress for its stall time gets a
//      nudge, logged, up to maxNudges. One more stall and it is blocked.
//   4. Blocked: the owner is told once, and the request needs attention.
//   5. Finished: every step done or skipped. The request closes as done
//      and the owner gets one summary.
// A plan whose request was closed some other way stops. Every plan is
// isolated: a failure is logged and the next plan runs.

export interface PlanSweepDeps {
  requests: RequestStore
  plans: PlanStore
  settings: PlanSettings
  /** Start a turn on an agent. Fire and forget: the check never waits on
   *  a model. Throws when the turn could not even be asked for. */
  tellAgent?: (agentId: string, text: string, request: RequestRecord, step: PlanStep) => Promise<void>
  /** Send an approved message to its channel and chat. */
  send?: (step: PlanStep, text: string) => Promise<void>
  /** Tell the owner, through the daemon's notify path. */
  notify?: (title: string, message: string, request: RequestRecord) => Promise<void>
  /** Raise a decision card for a step the owner approves. Returns its id. */
  raiseCard?: (request: RequestRecord, step: PlanStep, input: ReturnType<typeof approvalCardInput>) => string
  readCard?: (id: string) => DecisionCard | null
  /** Fetch a step's check address. */
  fetch?: typeof fetch
  hasAgent?: (agentId: string) => boolean
  log: (msg: string) => void
  now?: number
}

export interface PlanSweepResult {
  dispatched: number
  nudged: number
  sent: number
  blocked: number
  finished: number
}

const MINUTE = 60_000
const CHECK_TIMEOUT_MS = 10_000
const CHECK_BODY_MAX = 1_000_000

const isFinished = (s: PlanStep) => FINISHED_STEP_STATES.includes(s.state)

/** Block a step: the request needs attention and the plan check tells the
 *  owner once, with the plan's own words. The request's generic notice is
 *  marked sent so the owner is not told twice. */
export function blockStep(requests: RequestStore, plans: PlanStore, step: PlanStep, reason: string, now: number): void {
  plans.updateStep(step.requestId, step.idx, { state: "blocked", note: reason, notifiedAt: null, updatedAt: now })
  plans.event(step.requestId, step.idx, "blocked", reason, now)
  if (requests.needsAttention(step.requestId, `Step ${step.idx} "${step.name}" (${step.agentId}) is blocked: ${reason}`, now)) {
    requests.markNotified(step.requestId, now)
  }
}

/** Unblock or restart a step: active again, with a fresh count of nudges. */
function restartStep(requests: RequestStore, plans: PlanStore, step: PlanStep, now: number, redispatch: boolean): void {
  plans.updateStep(step.requestId, step.idx, {
    state: "active", note: null, nudges: 0, lastNudgeAt: null, notifiedAt: null, updatedAt: now,
    ...(redispatch ? { dispatchedAt: null } : {}),
  })
  requests.progress(step.requestId, now)
}

export type StepStatus = "progress" | "done" | "blocked"

/** An agent reports on a step it owns (or on any step of a plan it wrote).
 *  Returns an error in words, or null. */
export function reportStep(
  requests: RequestStore,
  plans: PlanStore,
  input: { requestId: string; step: number; status: StepStatus; agentId: string; evidence?: string; note?: string },
  now: number,
): string | null {
  const plan = plans.get(input.requestId)
  if (!plan) return `request "${input.requestId}" has no plan`
  if (plan.state !== "active") return `the plan of "${input.requestId}" is already ${plan.state === "done" ? "finished" : "closed"}`
  const step = plans.step(input.requestId, input.step)
  if (!step) return `the plan of "${input.requestId}" has no step ${input.step}`
  if (step.agentId !== input.agentId && plan.createdBy !== input.agentId) return `step ${step.idx} belongs to ${step.agentId}`
  if (isFinished(step)) return `step ${step.idx} is already ${step.state}`
  const evidence = (input.evidence ?? "").trim()
  const note = (input.note ?? "").trim()
  if (input.status === "done") {
    if (!evidence) return `a finished step needs evidence: what shows "${step.doneWhen}"`
    if (step.kind === MESSAGE_KIND) return "the daemon sends a message step itself once the earlier steps are done"
    plans.updateStep(step.requestId, step.idx, { state: "done", evidence: evidence.slice(0, 1000), note: null, updatedAt: now })
    plans.event(step.requestId, step.idx, "done", `${input.agentId}: ${evidence}`, now)
    requests.progress(step.requestId, now)
    return null
  }
  if (input.status === "blocked") {
    if (!note) return "a blocked step needs a reason (note)"
    blockStep(requests, plans, step, `${input.agentId}: ${note}`, now)
    return null
  }
  if (step.state === "blocked") restartStep(requests, plans, step, now, false)
  else plans.updateStep(step.requestId, step.idx, { updatedAt: now })
  plans.event(step.requestId, step.idx, "progress", `${input.agentId}: ${note || "under way"}`, now)
  requests.touch(step.requestId, now)
  return null
}

export type OwnerStepAction = "retry" | "skip" | "done"

/** The owner moves a step on: retry (hand it over again), skip it, or
 *  mark it done. The owner's word needs no evidence. */
export function ownerStepAction(
  requests: RequestStore,
  plans: PlanStore,
  input: { requestId: string; step: number; action: OwnerStepAction; detail?: string },
  now: number,
): string | null {
  const plan = plans.get(input.requestId)
  if (!plan) return `request "${input.requestId}" has no plan`
  if (plan.state !== "active") return `the plan of "${input.requestId}" is already ${plan.state === "done" ? "finished" : "closed"}`
  const step = plans.step(input.requestId, input.step)
  if (!step) return `the plan of "${input.requestId}" has no step ${input.step}`
  const detail = (input.detail ?? "").trim()
  if (input.action === "retry") {
    if (isFinished(step)) return `step ${step.idx} is already ${step.state}`
    // A message whose card expired is approved by retrying it: the owner said so now.
    if (step.needsApproval && step.approval !== "approved") plans.updateStep(step.requestId, step.idx, { approval: "approved" })
    restartStep(requests, plans, step, now, true)
    plans.event(step.requestId, step.idx, "retry", `owner${detail ? `: ${detail}` : ""}`, now)
    return null
  }
  if (isFinished(step)) return `step ${step.idx} is already ${step.state}`
  if (input.action === "skip") {
    plans.updateStep(step.requestId, step.idx, { state: "skipped", note: detail || "skipped by the owner", updatedAt: now })
    plans.event(step.requestId, step.idx, "skipped", `owner${detail ? `: ${detail}` : ""}`, now)
  } else {
    plans.updateStep(step.requestId, step.idx, { state: "done", evidence: detail || "marked done by the owner", note: null, updatedAt: now })
    plans.event(step.requestId, step.idx, "done", `owner${detail ? `: ${detail}` : ""}`, now)
  }
  requests.progress(step.requestId, now)
  return null
}

async function checkUrl(step: PlanStep, doFetch: typeof fetch): Promise<boolean> {
  const res = await doFetch(step.checkUrl!, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: "follow" })
  if (!res.ok) return false
  if (!step.checkContains) return true
  const body = (await res.text()).slice(0, CHECK_BODY_MAX)
  return body.includes(step.checkContains)
}

/** Step 1: cards for the steps the owner approves, and their answers. */
function settleApprovals(deps: PlanSweepDeps, r: RequestRecord, steps: PlanStep[], now: number): void {
  const { plans, requests, log } = deps
  for (const s of steps) {
    if (!s.needsApproval || isFinished(s)) continue
    if (s.approval === "none" && !s.cardId) {
      if (!deps.raiseCard) continue
      try {
        const id = deps.raiseCard(r, s, approvalCardInput(r, s))
        plans.updateStep(r.id, s.idx, { cardId: id, approval: "pending" })
        plans.event(r.id, s.idx, "approval-asked", `card ${id}`, now)
      } catch (e: any) {
        // A card that cannot be raised (too many waiting) is tried again next check.
        log(`[plans] ${r.id} step ${s.idx}: couldn't raise the approval card: ${e?.message ?? e}`)
      }
      continue
    }
    if (s.approval !== "pending" || !s.cardId || !deps.readCard) continue
    const card = deps.readCard(s.cardId)
    if (!card) {
      plans.updateStep(r.id, s.idx, { approval: "expired" })
      blockStep(requests, plans, s, `its approval card ${s.cardId} is gone`, now)
      continue
    }
    if (card.status === "pending") continue
    if (card.status === "decided" && card.verdict === "yes") {
      // The owner's edit of the draft is what goes out.
      const text = s.kind === MESSAGE_KIND && card.text?.trim() ? card.text : undefined
      plans.updateStep(r.id, s.idx, { approval: "approved", ...(text ? { message: text } : {}) })
      plans.event(r.id, s.idx, "approved", `card ${card.id}${text && text !== s.message ? " (text edited)" : ""}`, now)
    } else if (card.status === "decided") {
      plans.updateStep(r.id, s.idx, { approval: "declined", state: "skipped", note: `the owner said no${card.note ? `: ${card.note}` : ""}`, updatedAt: now })
      plans.event(r.id, s.idx, "declined", `card ${card.id}`, now)
    } else {
      plans.updateStep(r.id, s.idx, { approval: "expired" })
      blockStep(requests, plans, s, "its approval card expired unanswered", now)
    }
  }
}

/** Steps 2 and 3 on the current step. True when it finished, so the next
 *  one can start in this same check. */
async function advance(deps: PlanSweepDeps, r: RequestRecord, steps: PlanStep[], s: PlanStep, now: number, result: PlanSweepResult): Promise<boolean> {
  const { plans, requests, settings, log } = deps
  if (s.state === "blocked") return false
  if (s.state === "pending") {
    plans.updateStep(r.id, s.idx, { state: "active", updatedAt: now })
    plans.event(r.id, s.idx, "started", s.agentId, now)
    s = { ...s, state: "active", updatedAt: now }
  }

  if (s.kind === MESSAGE_KIND) {
    if (s.needsApproval && s.approval !== "approved") return false
    if (!deps.send) return false
    try {
      await deps.send(s, s.message ?? "")
      const evidence = `sent to ${s.toChannel} chat ${s.toChat} at ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`
      plans.updateStep(r.id, s.idx, { state: "done", evidence, updatedAt: now })
      plans.event(r.id, s.idx, "sent", evidence, now)
      requests.progress(r.id, now)
      result.sent++
      log(`[plans] ${r.id} step ${s.idx}: message ${evidence}`)
      return true
    } catch (e: any) {
      const tries = s.nudges + 1
      plans.updateStep(r.id, s.idx, { nudges: tries, lastNudgeAt: now })
      plans.event(r.id, s.idx, "send-failed", `${e?.message ?? e}`, now)
      if (tries >= settings.maxNudges) {
        blockStep(requests, plans, s, `the message could not be sent (${tries} tries): ${e?.message ?? e}`, now)
        result.blocked++
      }
      return false
    }
  }

  if (s.checkUrl) {
    try {
      if (await checkUrl(s, deps.fetch ?? fetch)) {
        const evidence = `${s.checkUrl} answered${s.checkContains ? ` with "${s.checkContains}"` : ""}`
        plans.updateStep(r.id, s.idx, { state: "done", evidence, updatedAt: now })
        plans.event(r.id, s.idx, "done", `check: ${evidence}`, now)
        requests.progress(r.id, now)
        return true
      }
    } catch (e: any) {
      // Not live yet, or not reachable: the step stays as it is.
      log(`[plans] ${r.id} step ${s.idx}: check ${s.checkUrl} failed: ${e?.message ?? e}`)
    }
  }

  if (deps.hasAgent && !deps.hasAgent(s.agentId)) {
    blockStep(requests, plans, s, `agent "${s.agentId}" is not on this node`, now)
    result.blocked++
    return false
  }

  if (s.dispatchedAt === null) {
    if (!deps.tellAgent) return false
    plans.updateStep(r.id, s.idx, { dispatchedAt: now, updatedAt: now })
    try {
      await deps.tellAgent(s.agentId, dispatchText(r, steps, s), r, s)
      plans.event(r.id, s.idx, "dispatched", s.agentId, now)
      requests.touch(r.id, now)
      result.dispatched++
    } catch (e: any) {
      blockStep(requests, plans, s, `could not hand it to ${s.agentId}: ${e?.message ?? e}`, now)
      result.blocked++
    }
    return false
  }

  const stallMinutes = s.stallMinutes ?? settings.stallMinutes
  const quietSince = Math.max(s.updatedAt, s.dispatchedAt, s.lastNudgeAt ?? 0)
  if (now - quietSince < stallMinutes * MINUTE) return false
  if (s.nudges >= settings.maxNudges) {
    blockStep(requests, plans, s, `no progress after ${s.nudges} nudge${s.nudges === 1 ? "" : "s"}`, now)
    result.blocked++
    return false
  }
  if (!deps.tellAgent) return false
  const nudge = s.nudges + 1
  plans.updateStep(r.id, s.idx, { nudges: nudge, lastNudgeAt: now })
  const quietMinutes = (now - quietSince) / MINUTE
  try {
    await deps.tellAgent(s.agentId, nudgeText(r, steps, s, quietMinutes, nudge, settings.maxNudges), r, s)
    plans.event(r.id, s.idx, "nudged", `${s.agentId}, nudge ${nudge} of ${settings.maxNudges}, quiet ${Math.round(quietMinutes)} min`, now)
    // The plan is followed: the request is not quiet.
    requests.touch(r.id, now)
    result.nudged++
    log(`[plans] ${r.id} step ${s.idx}: nudged ${s.agentId} (${nudge}/${settings.maxNudges})`)
  } catch (e: any) {
    plans.event(r.id, s.idx, "nudge-failed", `${s.agentId}: ${e?.message ?? e}`, now)
  }
  return false
}

async function followPlan(deps: PlanSweepDeps, plan: PlanRecord, now: number, result: PlanSweepResult): Promise<void> {
  const { plans, requests } = deps
  const r = requests.get(plan.requestId)
  if (!r || CLOSED_STATES.includes(r.state as any)) {
    if (plans.finish(plan.requestId, "closed", now)) plans.event(plan.requestId, null, "closed", `request ${r ? r.state : "deleted"}`, now)
    return
  }
  settleApprovals(deps, r, plans.steps(r.id), now)
  for (let guard = 0; guard <= 2 * plans.steps(r.id).length; guard++) {
    const steps = plans.steps(r.id)
    const current = steps.find((s) => !isFinished(s))
    if (!current) {
      if (plans.finish(r.id, "done", now)) {
        plans.event(r.id, null, "finished", `${steps.length} steps`, now)
        requests.close(r.id, "done", planEvidence(steps), now)
        result.finished++
        deps.log(`[plans] ${r.id}: every step finished`)
      }
      return
    }
    if (!(await advance(deps, r, steps, current, now, result))) return
  }
}

/** Step 4: the owner hears about each blocked step once. */
async function tellBlocked(deps: PlanSweepDeps, now: number): Promise<void> {
  const { plans, requests, log } = deps
  for (const plan of plans.listActive()) {
    const steps = plans.steps(plan.requestId)
    for (const s of steps.filter((x) => x.state === "blocked" && x.notifiedAt === null)) {
      const r = requests.get(plan.requestId)
      if (!r) continue
      plans.updateStep(s.requestId, s.idx, { notifiedAt: now })
      if (!deps.notify) continue
      try {
        await deps.notify("Plan step blocked", blockedText(r, steps, s), r)
        plans.event(s.requestId, s.idx, "owner-told", "blocked", now)
      } catch (e: any) {
        plans.updateStep(s.requestId, s.idx, { notifiedAt: null })
        log(`[plans] couldn't tell the owner ${r.id} step ${s.idx} is blocked, will try again: ${e?.message ?? e}`)
      }
    }
  }
}

/** Step 5: one summary per finished plan. */
async function tellFinished(deps: PlanSweepDeps, now: number): Promise<void> {
  const { plans, requests, log } = deps
  for (const plan of plans.awaitingSummary()) {
    plans.markNotified(plan.requestId, now)
    const r = requests.get(plan.requestId)
    if (!r || !deps.notify) continue
    try {
      await deps.notify("Plan finished", summaryText(r, plans.steps(r.id)), r)
      plans.event(r.id, null, "owner-told", "finished", now)
    } catch (e: any) {
      plans.markNotified(plan.requestId, null)
      log(`[plans] couldn't send the summary of ${r.id}, will try again: ${e?.message ?? e}`)
    }
  }
}

export async function runPlansSweep(deps: PlanSweepDeps): Promise<PlanSweepResult> {
  const now = deps.now ?? Date.now()
  const result: PlanSweepResult = { dispatched: 0, nudged: 0, sent: 0, blocked: 0, finished: 0 }
  if (!deps.settings.enabled) return result
  try {
    for (const plan of deps.plans.listActive()) {
      try {
        await followPlan(deps, plan, now, result)
      } catch (e: any) {
        deps.log(`[plans] ${plan.requestId} failed: ${e?.message ?? e}`)
      }
    }
  } catch (e: any) {
    deps.log(`[plans] check failed: ${e?.message ?? e}`)
  }
  try { await tellBlocked(deps, now) } catch (e: any) { deps.log(`[plans] blocked notices failed: ${e?.message ?? e}`) }
  try { await tellFinished(deps, now) } catch (e: any) { deps.log(`[plans] summaries failed: ${e?.message ?? e}`) }
  return result
}
