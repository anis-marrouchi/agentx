// --- What happens to a run stopped at its agent's time limit (#1257, #1861) ---
//
// A run that passes maxExecutionMinutes is stopped. Its job continues it:
// the daemon arms the job's wake, whose run starts in the same chat with a
// note that says it hit the limit and lists the tool calls it had made
// (jobs/wake.ts), under the job's caps of wakes and cost. The registry no
// longer runs a continuation of its own. Pure: the registry and the
// daemon carry it out.
//
// Rules, in order (the first that applies wins):
//
//   none      not a time-limit stop (any other error, a caller's deadline,
//             a stop, a restart, a pre-spawn stall)
//   none      run on a mesh peer: that node continues it itself
//   report    turned off
//   report    scheduled job: the next scheduled run covers it
//   report    workflow step: the workflow engine owns its retries
//   handoff   otherwise: its job's wake continues it, when it takes it
//
// "report" keeps the error and adds one plain line saying why it was not
// continued, so the owner knows what happened and what to change. So does
// a handoff the job's wake does not take (no job, wake off, at its cap).

export interface TimeLimitSettings {
  enabled: boolean
}

export const DEFAULT_TIME_LIMIT_SETTINGS: TimeLimitSettings = { enabled: true }

/** The runtimes' own time-limit message (runtime.ts). A caller's deadline
 *  reads "timed out after Ns" and a busy slot "slot wait timed out", so
 *  neither matches. */
const TIME_LIMIT_RE = /^(Claude Code|Codex CLI|OpenCode|Orchestrator) timed out after (\d+)m\b/

/** The time limit in minutes when this error is a time-limit stop, or null. */
export function timeLimitMinutes(error: string | undefined, errorKind: string | undefined): number | null {
  if (!error || errorKind !== "timeout") return null
  const m = error.match(TIME_LIMIT_RE)
  return m ? Number(m[2]) : null
}

export type TimeLimitPlan =
  | { action: "none" }
  | { action: "handoff"; minutes: number }
  | { action: "report"; minutes: number; reason: string }

export function planTimeLimit(input: {
  error: string | undefined
  errorKind: string | undefined
  viaMesh?: string
  channel?: string
  chatId?: string
  workflowRunId?: string
  settings: TimeLimitSettings
}): TimeLimitPlan {
  const minutes = timeLimitMinutes(input.error, input.errorKind)
  if (minutes === null || input.viaMesh) return { action: "none" }
  if (!input.settings.enabled) return { action: "report", minutes, reason: "continuing after the time limit is turned off" }
  const channel = (input.channel ?? "").toLowerCase().split("@")[0]
  if (channel === "cron") return { action: "report", minutes, reason: "scheduled job: the next scheduled run covers it" }
  if (input.workflowRunId || (input.chatId ?? "").startsWith("workflow:")) {
    return { action: "report", minutes, reason: "workflow step: the workflow engine owns retries" }
  }
  return { action: "handoff", minutes }
}

/** The error a time-limit stop ends with when it is not continued: the
 *  runtime's own message, and why it stopped there. */
export function reportedTimeLimitError(error: string, reason: string): string {
  return `${error} It was not continued (${reason}).`
}

/** The error of a time-limit stop its job's wake took: the next run of
 *  the job carries the work on, and answers in the job's chat. */
export function handedOffTimeLimitError(error: string, jobId: string): string {
  return `${error} Its job ${jobId} continues it in a new run.`
}

// The note is the job's wake note (at most 1000 characters, JOB_NOTE_MAX).
const MAX_LISTED_CALLS = 8
const MAX_CALL_CHARS = 80

/** Why the job's next run starts, for the wake (jobs/wake.ts wakeText,
 *  which also says to check before repeating an outside action). The
 *  chat's session holds the earlier turns; the tool calls of the stopped
 *  turn are listed from its trace. */
export function buildTimeLimitNote(
  minutes: number,
  toolCalls: Array<{ action: string | null; inputSummary: string | null }>,
): string {
  const parts = [`your last run was stopped at its ${minutes} min time limit before it finished.`]
  if (toolCalls.length === 0) {
    parts.push("No tool calls were recorded for it.")
  } else {
    const listed = toolCalls.slice(0, MAX_LISTED_CALLS).map((c, i) => {
      const input = (c.inputSummary ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CALL_CHARS)
      return `${i + 1}. ${c.action ?? "tool"}${input ? `: ${input}` : ""}`
    })
    if (toolCalls.length > MAX_LISTED_CALLS) listed.push(`…and ${toolCalls.length - MAX_LISTED_CALLS} more`)
    parts.push(`It had made these tool calls (${toolCalls.length}): ${listed.join("; ")}.`)
  }
  parts.push("Carry on from where it stopped.")
  return parts.join(" ")
}
