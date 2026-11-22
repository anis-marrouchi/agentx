import { parseDue } from "@/requests/loops"
import type { JobState as RunJobState } from "@/agents/run-state"
import type { JobDeclaration, JobStore } from "./store"

// --- What a run said about its job, written on the job (#1861 phase 2) ---
//
// The registry checks the state a run of agent work ends with
// (agents/run-state.ts) and says what happened: the run stated a state,
// it was asked for one, or it stayed silent and its job stalled. This
// writes that on the run's job, when the run belongs to one. A run no
// door opened a job for is left alone.

/** A continue or a wait with no time it can read: the job is looked at
 *  again after this long, not never. */
export const DEFAULT_STATE_WAIT_MS = 60 * 60_000

export type RunStateEvent =
  | { kind: "stated"; state: RunJobState }
  | { kind: "asked" }
  | { kind: "stalled"; reason: string }

/** The declaration the job store takes for a state a run gave. */
export function toDeclaration(s: RunJobState, now: number): JobDeclaration {
  const at = (v: string | undefined) => {
    const t = parseDue(v, now)
    return typeof t === "number" ? t : now + DEFAULT_STATE_WAIT_MS
  }
  switch (s.state) {
    case "done": return { state: "done", proof: s.proof }
    case "blocked": return { state: "blocked", why: s.why }
    case "continue": return { state: "continue", wakeAt: at(s.when), note: s.when && typeof parseDue(s.when, now) !== "number" ? `${s.left} (${s.when})` : s.left }
    case "waiting": return { state: "waiting", on: s.on, until: at(s.until), ...(s.until && typeof parseDue(s.until, now) !== "number" ? { note: `until ${s.until}` } : {}) }
  }
}

/** Write the event on the job of the first of these runs that has one.
 *  Returns the job id, or null when none of the runs belongs to a job. */
export function recordRunState(
  store: Pick<JobStore, "byRun" | "declare" | "markStateAsked" | "markStalled" | "markRequesterTold">,
  runIds: Array<string | undefined>,
  ev: RunStateEvent,
  now: number,
): string | null {
  const ids = runIds.filter((id): id is string => !!id)
  const job = ids.map((id) => store.byRun(id)).find((j) => !!j)
  if (!job) return null
  if (ev.kind === "asked") store.markStateAsked(job.id, now)
  else if (ev.kind === "stated") store.declare(job.id, toDeclaration(ev.state, now), { runId: ids[0], now })
  else if (store.markStalled(job.id, ev.reason, now)) {
    // The stalled line goes back in the run's own answer: that told them.
    store.markRequesterTold(job.id, now)
  }
  return job.id
}
