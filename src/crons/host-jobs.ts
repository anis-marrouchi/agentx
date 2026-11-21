import { z } from "zod"

// --- allowedHostJobs: what may run outside AgentX on this machine (#863) ---
//
//   allowedHostJobs:
//     com.noqta.disk-hold-watch: { owner: devops-agent, why: "disk sensor PR later", until: "2026-12-15" }
//     com.apple.backupd:         { owner: devops-agent, why: "a system service" }
//
// launchd is the truth of what runs; this list is only what is allowed.
// The weekly tidy (DevOps) compares ~/Library/LaunchAgents and crontab with
// it. During the migration a job not moved yet carries `until`, the date it
// should be moved by: an entry past its `until` shows on the Wall for its
// owner, so the move is not forgotten and the Wall is not flooded before.

const DAY = /^\d{4}-\d{2}-\d{2}$/

export const hostJobSchema = z.object({
  /** The agent that answers for it (moves it, or says why it stays). */
  owner: z.string().trim().min(1),
  why: z.string().trim().min(1).max(300),
  /** A date (YYYY-MM-DD, end of that day UTC) or an ISO time. */
  until: z.string().refine((s) => DAY.test(s) || !Number.isNaN(Date.parse(s)), { message: "until must be a date (YYYY-MM-DD) or an ISO time" }).optional(),
})

export const allowedHostJobsSchema = z.record(z.string().trim().min(1), hostJobSchema).default({})

export type AllowedHostJobs = z.infer<typeof allowedHostJobsSchema>

/** When an entry's `until` runs out: a bare date lasts the whole day. */
export function hostJobEnds(until: string): number {
  return DAY.test(until) ? Date.parse(`${until}T23:59:59.999Z`) : Date.parse(until)
}

export interface HostJobLine { label: string; owner: string; until: string; text: string }

/** The Wall lines: every entry past its `until`, by owner then label. */
export function expiredHostJobs(list: Record<string, { owner?: unknown; why?: unknown; until?: unknown }> | undefined, now: number): HostJobLine[] {
  const out: HostJobLine[] = []
  for (const [label, e] of Object.entries(list ?? {})) {
    if (!e || typeof e.until !== "string" || typeof e.owner !== "string") continue
    const ends = hostJobEnds(e.until)
    if (!Number.isFinite(ends) || ends > now) continue
    out.push({ label, owner: e.owner, until: e.until, text: `host job ${label} is past its until ${e.until}: ${e.owner} moves it to AgentX, or extends it with a reason` })
  }
  return out.sort((a, b) => a.owner.localeCompare(b.owner) || a.label.localeCompare(b.label))
}
