import { jobStateInText, type JobState } from "@/agents/run-state"
import type { PlanStep, PlanStore } from "./plan-store"
import { reportStep } from "./plan-sweep"
import type { RequestStore } from "./store"

// --- A run that ends "waiting until <time>" files its plan step's wait ---
//
// retro:01M8AG6YTMQG790EQXF01DFG00 (Desk card
// 2026-11-26-plan-nudge-launched-a-full-agent-run-onl-hag3). Remove this
// file and its two call sites (registry.ts setWaitingStepHook, daemon
// index.ts) when the retro is closed as not needed.
//
// A run ended with "State: waiting — … until 00:00Z" and made no step
// call, so the plan check saw its step as quiet and its nudge started a
// whole new run only to post the status the first run never filed. At
// the end of a run, when:
//
//   - the run's job state is waiting, with a time (its `until`, or else a
//     full ISO date and time in the waiting text),
//   - the run is linked to a request whose plan is active, and the agent
//     owns that plan's active step,
//   - and the run filed nothing on that step itself,
//
// then by `requests.waitingStep.mode`:
//
//   off   nothing
//   warn  (the default) one log line and one `waiting_step_unfiled`
//         signal saying what it would file; the step is not changed
//   on    the step gets a progress report with waitUntil = that time
//         (at most 7 days ahead, like a step call), so no nudge before it.
//         The report keeps the step's nudge count (keepNudges): a run
//         that only ever ends waiting still gets the step blocked
//
// No time, a time in the past, no linked step: a log line only. Never
// throws. Runs inside the run's end (no poller of its own, noqta#609).

export type WaitingStepMode = "off" | "warn" | "on"

/** Same cap as a step call's waitUntil (daemon-api.ts MAX_STEP_WAIT_MS). */
export const MAX_AUTO_WAIT_MS = 7 * 24 * 60 * 60 * 1000

export interface WaitingStepRun {
  agentId: string
  /** The run's trace id, then its running id. */
  runIds: string[]
  startedAt: number
  /** The state the registry read (tool or last line), if any. */
  jobState?: JobState | { state: "stalled" } | null
  /** The run's final reply: read for a State line when no state came. */
  reply?: string
}

export interface WaitingStepDeps {
  requests: RequestStore
  plans: PlanStore
  mode: () => WaitingStepMode
  log: (line: string) => void
  /** The warn event (improve/signals.ts). */
  signal?: (agentId: string, ref: string, detail: string) => void
  now?: () => number
}

export type WaitingStepOutcome =
  | "off" | "not-waiting" | "no-time" | "past" | "no-step" | "already-filed" | "warned" | "filed" | "refused"

const FULL_ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g
const CLOCK = /^(?:at\s+|about\s+|~)?(\d{1,2}):(\d{2})\s*(?:Z|UTC|GMT)?\b/i

/** When a waiting state ends, in ms, or null. `until` first: a full ISO
 *  time, or a bare clock time ("00:00Z", "18:00"), read as UTC, the next
 *  one after `now`. Else the last full ISO time in what it waits on
 *  ("my check is at 2026-11-26T00:00Z"). */
export function waitingTime(state: { on: string; until?: string }, now: number): number | null {
  const until = state.until?.trim()
  if (until) {
    const iso = until.match(FULL_ISO)
    if (iso) return isoMs(iso[0])
    const clock = until.match(CLOCK)
    if (clock) {
      const h = Number(clock[1]), m = Number(clock[2])
      if (h > 23 || m > 59) return null
      const d = new Date(now)
      let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m)
      if (at <= now) at += 24 * 60 * 60 * 1000
      return at
    }
  }
  const all = state.on.match(FULL_ISO)
  return all ? isoMs(all[all.length - 1]) : null
}

function isoMs(text: string): number | null {
  // A date and time with no zone is read as UTC, as the fleet writes it.
  const s = text.replace(" ", "T")
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** The active step this agent owns on a request linked to the run. */
function ownedStep(deps: WaitingStepDeps, run: WaitingStepRun): PlanStep | null {
  const seen = new Set<string>()
  for (const ref of run.runIds) {
    for (const kind of ["run", "step_run"] as const) {
      const r = deps.requests.byLink(kind, ref)
      if (!r || seen.has(r.id)) continue
      seen.add(r.id)
      if (deps.plans.get(r.id)?.state !== "active") continue
      const step = deps.plans.steps(r.id).find((s) => s.state === "active" && s.agentId === run.agentId)
      if (step) return step
    }
  }
  return null
}

/** This agent already reported on the step since the run started. */
function filedSince(plans: PlanStore, step: PlanStep, agentId: string, since: number): boolean {
  return plans.events(step.requestId, 50).some((e) =>
    e.step === step.idx && e.at >= since && ["progress", "done", "blocked"].includes(e.kind) && e.detail.startsWith(`${agentId}:`))
}

/** A run ended. Never throws. */
export function fileWaitingStep(deps: WaitingStepDeps, run: WaitingStepRun): WaitingStepOutcome {
  try {
    return decide(deps, run)
  } catch (e: any) {
    deps.log(`[waiting-step] ${run.agentId} ${run.runIds[0] ?? "-"}: check failed: ${e?.message ?? e}`)
    return "refused"
  }
}

function decide(deps: WaitingStepDeps, run: WaitingStepRun): WaitingStepOutcome {
  const mode = deps.mode()
  if (mode === "off") return "off"
  const state = run.jobState && run.jobState.state !== "stalled" ? run.jobState : jobStateInText(run.reply)
  if (!state || state.state !== "waiting") return "not-waiting"
  const now = (deps.now ?? Date.now)()
  const where = `${run.agentId} ${run.runIds[0] ?? "-"}`
  const step = ownedStep(deps, run)
  if (!step) return "no-step"
  const at = waitingTime(state, now)
  if (at === null) {
    deps.log(`[waiting-step] ${where}: ends waiting with no time; step ${step.requestId}#${step.idx} left as it is`)
    return "no-time"
  }
  if (at <= now) {
    deps.log(`[waiting-step] ${where}: ends waiting until ${new Date(at).toISOString()}, already past; nothing filed`)
    return "past"
  }
  if (filedSince(deps.plans, step, run.agentId, run.startedAt)) return "already-filed"
  const until = Math.min(at, now + MAX_AUTO_WAIT_MS)
  const iso = new Date(until).toISOString()
  const ref = `${step.requestId}#${step.idx}`
  if (mode === "warn") {
    deps.log(`[waiting-step] ${where}: would file step ${ref} progress, waits until ${iso} (warn)`)
    deps.signal?.(run.agentId, ref, `run ${run.runIds[0] ?? "-"} ended waiting until ${iso} with no step call (warn: not filed)`)
    return "warned"
  }
  const err = reportStep(deps.requests, deps.plans, {
    requestId: step.requestId, step: step.idx, status: "progress", agentId: run.agentId,
    note: `State: waiting on ${state.on.slice(0, 200)} (filed by the daemon from the run's end)`,
    waitUntil: until,
    // The daemon's report is not the agent's progress: the nudges so far
    // still count toward blocking the step (#2320 review C1).
    keepNudges: true,
  }, now)
  if (err) {
    deps.log(`[waiting-step] ${where}: step ${ref} not filed: ${err}`)
    return "refused"
  }
  deps.log(`[waiting-step] ${where}: filed step ${ref} progress, waits until ${iso}`)
  return "filed"
}
