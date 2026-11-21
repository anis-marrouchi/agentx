import { applyConfigMutation } from "@/daemon/config-mutator"
import { jobGoalState, type JobGoalState } from "./goal-state"

// --- A retired job stays retired (#863) ---
//
// A job is retired when it has `endedAt` (written by retire, by a drop
// answer, or by `until`) or when the operator answered drop on its goal
// card. Every way a job is switched back on asks this first: the agent
// tool's resume, the dashboard's POST /crons/:id/enabled, `agentx cron
// enable` and `agentx schedule enable`. Bringing a retired job back is a
// new schedule, through the create approval.

export interface RetirableJob {
  endedAt?: string
  goalCheck?: JobGoalState["goalCheck"]
}

/** The refusal text when `job` is retired, else null. */
export function retiredRefusal(job: RetirableJob, id = "this job"): string | null {
  const dropped = job.goalCheck?.reason === "drop-answered"
  if (!job.endedAt && !dropped) return null
  const when = (job.endedAt ?? job.goalCheck?.droppedAt ?? "").slice(0, 10) || "an earlier date"
  const why = job.endedAt ? "" : " (the operator answered drop on its goal card)"
  return `"${id}" was retired on ${when}${why}; bringing it back needs operator approval: request a new schedule (create), which the operator approves.`
}

/** retiredRefusal for a job read from agentx.json, with its goal state
 *  from the state file under `root`. */
export function retiredRefusalAt(root: string, id: string, job: { endedAt?: unknown }): string | null {
  const endedAt = typeof job?.endedAt === "string" ? job.endedAt : undefined
  return retiredRefusal({ endedAt, goalCheck: jobGoalState(root, id).goalCheck }, id)
}

export type EndJobResult = { ok: true; changed: boolean } | { ok: false; error: string }

/**
 * Retire a job in agentx.json: `enabled: false` and `endedAt`. Used by a
 * drop answer, the owner's retire and `until`. A job already ended is left
 * as it is (changed: false), so a retry is harmless. Never reloads: the
 * caller stops the in-memory job, or the daemon's config watcher does.
 */
export async function endJobInConfig(id: string, endedAt: string, opts: { configPath?: string; reload?: boolean } = {}): Promise<EndJobResult> {
  let outcome: EndJobResult | null = null
  const r = await applyConfigMutation((cfg) => {
    const job = cfg.crons?.[id]
    if (!job) outcome = { ok: false, error: `no schedule "${id}"` }
    else if (job.endedAt) outcome = { ok: true, changed: false }
    if (outcome) throw new Error("no write")
    job.enabled = false
    job.endedAt = endedAt
  }, { configPath: opts.configPath, reload: opts.reload ?? false })
  if (outcome) return outcome
  if (!r.success) return { ok: false, error: r.error || "could not write agentx.json" }
  return { ok: true, changed: true }
}
