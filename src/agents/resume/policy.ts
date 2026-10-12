import type { InterruptedRun } from "@/storage/traces"
import { callerAgentOf, parseOrigin, type RunOrigin } from "./origin"

// --- What to do with each run a restart cut off ---
//
// Pure: given the interrupted runs, the settings and the recent boots,
// decide per run. Rules, in order (the first that applies wins):
//
//   skip    scheduled jobs — the next scheduled run covers them
//   skip    runs another part of the daemon picks up itself (a delegation
//           result's relay turn: the delegation manager re-runs it, #846)
//   report  workflow steps — the workflow engine owns their retries
//   report  crash loop — several restarts in a short window; a resumed run
//           may be what brings the daemon down
//   report  already a resume — a run cut off while resuming isn't retried
//   report  too old — older than maxAgeMinutes
//   report  no way back in — no recorded origin (older builds, or too big)
//   report  channel opted out, or a direct run on a channel not opted in
//           (a mesh run is not direct: the forwarding node delivers it;
//           an agent-to-agent run that names its calling agent is not
//           either: the answer goes to that agent as a new turn)
//   resume  otherwise
//
// "report" means: don't run it again, tell the chat it came from (or the
// operator) that it was cut off.

export interface ResumeSettings {
  enabled: boolean
  maxAgeMinutes: number
  maxAttempts: number
  /** Never resumed, even from a chat. */
  reportOnlyChannels: string[]
  /** Direct runs (no router) resumed only on these channels. */
  directChannels: string[]
  crashLoop: { restarts: number; windowMinutes: number }
}

export const DEFAULT_RESUME_SETTINGS: ResumeSettings = {
  enabled: true,
  maxAgeMinutes: 30,
  maxAttempts: 1,
  reportOnlyChannels: [],
  directChannels: [],
  crashLoop: { restarts: 3, windowMinutes: 10 },
}

export type ResumePlan =
  | { run: InterruptedRun; action: "resume"; origin: RunOrigin; reason: string }
  /** origin, when known, lets the run's chat be told it was cut off. */
  | { run: InterruptedRun; action: "report"; origin: RunOrigin | null; reason: string }
  | { run: InterruptedRun; action: "skip"; origin: RunOrigin | null; reason: string }

function base(channel: string | null): string {
  return (channel ?? "").toLowerCase().split("@")[0]
}

/** Whether the recent boots (ms timestamps, this one included) look like
 *  a crash loop. */
export function inCrashLoop(boots: number[], now: number, s: ResumeSettings["crashLoop"]): boolean {
  const since = now - s.windowMinutes * 60_000
  return boots.filter((t) => t >= since).length >= s.restarts
}

export function planResume(
  runs: InterruptedRun[],
  settings: ResumeSettings,
  ctx: {
    now: number
    boots: number[]
    /** A reason when another part of the daemon picks this run up itself. */
    handledElsewhere?: (run: InterruptedRun) => string | null
  },
): ResumePlan[] {
  const loop = inCrashLoop(ctx.boots, ctx.now, settings.crashLoop)
  return runs.map((run): ResumePlan => {
    const ch = base(run.channel)
    const origin = parseOrigin(run.resumeOrigin)
    if (ch === "cron") return { run, action: "skip", origin, reason: "scheduled job: the next scheduled run covers it" }
    const elsewhere = ctx.handledElsewhere?.(run)
    if (elsewhere) return { run, action: "skip", origin, reason: elsewhere }
    if (run.workflowRunId) return { run, action: "report", origin, reason: "workflow step: the workflow engine owns retries" }
    if (!settings.enabled) return { run, action: "report", origin, reason: "resume is turned off" }
    if (loop) {
      return { run, action: "report", origin, reason: `${settings.crashLoop.restarts}+ restarts within ${settings.crashLoop.windowMinutes} min; not resuming` }
    }
    if (run.resumeAttempt >= settings.maxAttempts) {
      return { run, action: "report", origin, reason: "cut off again while resuming; not retried" }
    }
    const ageMin = (ctx.now - run.startedAt) / 60_000
    if (ageMin > settings.maxAgeMinutes) {
      return { run, action: "report", origin, reason: `started ${Math.round(ageMin)} min ago (limit ${settings.maxAgeMinutes})` }
    }
    if (!origin) return { run, action: "report", origin, reason: "no record of how to resume it" }
    if (settings.reportOnlyChannels.map((c) => c.toLowerCase()).includes(ch)) {
      return { run, action: "report", origin, reason: `channel "${ch}" is set to report only` }
    }
    const caller = callerAgentOf(origin)
    if (caller) return { run, action: "resume", origin, reason: `cut off by a restart; the answer goes to ${caller}` }
    if (origin.kind === "direct" && !settings.directChannels.map((c) => c.toLowerCase()).includes(ch)) {
      return { run, action: "report", origin, reason: `nothing would deliver its answer (channel "${ch || "none"}")` }
    }
    return { run, action: "resume", origin, reason: "cut off by a restart" }
  })
}
