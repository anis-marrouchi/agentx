// --- What happens to a run stopped at its agent's time limit (#1257) ---
//
// A run that passes maxExecutionMinutes is stopped. Unlike a run a restart
// cuts off, it used to end as a bare error: the work it had done stayed in
// its chat's session, and nothing picked it up again. Now it is continued
// in the same chat, under a cap, with a note that says it hit the limit and
// lists the tool calls it had made. Pure: the registry carries it out.
//
// Rules, in order (the first that applies wins):
//
//   none      not a time-limit stop (any other error, a caller's deadline,
//             a stop, a restart, a pre-spawn stall)
//   none      run on a mesh peer: that node continues it itself
//   report    turned off, or the cap is reached
//   report    scheduled job: the next scheduled run covers it
//   report    workflow step: the workflow engine owns its retries
//   report    the caller is gone, or its deadline leaves too little time
//   continue  otherwise
//
// "report" keeps the error and adds one plain line saying why it was not
// continued, so the owner knows what happened and what to change.

export interface TimeLimitSettings {
  enabled: boolean
  /** How many times one request is continued after a time-limit stop. */
  maxContinuations: number
}

export const DEFAULT_TIME_LIMIT_SETTINGS: TimeLimitSettings = { enabled: true, maxContinuations: 1 }

/** How many continuations a run stopped at its time limit can get. */
export function timeLimitContinuations(s: TimeLimitSettings | undefined): number {
  return s?.enabled ? s.maxContinuations : 0
}

/** A continuation given less than this by the caller's deadline is not started. */
export const MIN_CONTINUATION_MS = 2 * 60_000

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
  | { action: "continue"; minutes: number; continuation: number; timeoutMinutes?: number }
  | { action: "report"; minutes: number; reason: string }

export function planTimeLimit(input: {
  error: string | undefined
  errorKind: string | undefined
  viaMesh?: string
  channel?: string
  chatId?: string
  workflowRunId?: string
  /** Continuations this request has had so far. */
  continuation: number
  /** The caller's own deadline for the whole request, if it set one. */
  timeoutMinutes?: number
  /** How long the request has run so far, continuations included. */
  elapsedMs: number
  callerGone: boolean
  settings: TimeLimitSettings
}): TimeLimitPlan {
  const minutes = timeLimitMinutes(input.error, input.errorKind)
  if (minutes === null || input.viaMesh) return { action: "none" }
  const s = input.settings
  if (!s.enabled) return { action: "report", minutes, reason: "continuing after the time limit is turned off" }
  if (input.continuation >= s.maxContinuations) {
    return {
      action: "report", minutes,
      reason: s.maxContinuations === 0
        ? "continuing after the time limit is turned off"
        : `already continued ${input.continuation === 1 ? "once" : `${input.continuation} times`}`,
    }
  }
  const channel = (input.channel ?? "").toLowerCase().split("@")[0]
  if (channel === "cron") return { action: "report", minutes, reason: "scheduled job: the next scheduled run covers it" }
  if (input.workflowRunId || (input.chatId ?? "").startsWith("workflow:")) {
    return { action: "report", minutes, reason: "workflow step: the workflow engine owns retries" }
  }
  if (input.callerGone) return { action: "report", minutes, reason: "nobody is waiting for the answer any more" }
  let timeoutMinutes: number | undefined
  if (input.timeoutMinutes && input.timeoutMinutes > 0) {
    const leftMs = input.timeoutMinutes * 60_000 - input.elapsedMs
    if (leftMs < MIN_CONTINUATION_MS) return { action: "report", minutes, reason: "the caller's own time limit leaves no time to continue" }
    timeoutMinutes = leftMs / 60_000
  }
  return { action: "continue", minutes, continuation: input.continuation + 1, ...(timeoutMinutes ? { timeoutMinutes } : {}) }
}

/** The error a time-limit stop ends with when it is not continued: the
 *  runtime's own message, and why it stopped there. */
export function reportedTimeLimitError(error: string, reason: string): string {
  return `${error} It was not continued (${reason}).`
}

const MAX_LISTED_CALLS = 15
const MAX_CALL_CHARS = 160

/** Prepended to the request when it is continued. The chat's session holds
 *  the earlier turns; the tool calls of the stopped turn are listed from
 *  its trace, so the agent can check before doing an outside action twice. */
export function buildTimeLimitNote(
  minutes: number,
  toolCalls: Array<{ action: string | null; inputSummary: string | null }>,
  /** No continuation will follow this one. */
  last: boolean,
): string {
  const lines = [
    `[Continued after the time limit] You worked on this request for ${minutes} min, your time limit, and were stopped before you finished.`,
  ]
  if (toolCalls.length === 0) {
    lines.push("No tool calls were recorded for that run.")
  } else {
    lines.push(`You had already made these tool calls (${toolCalls.length}):`)
    toolCalls.slice(0, MAX_LISTED_CALLS).forEach((c, i) => {
      const input = (c.inputSummary ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CALL_CHARS)
      lines.push(`${i + 1}. ${c.action ?? "tool"}${input ? `: ${input}` : ""}`)
    })
    if (toolCalls.length > MAX_LISTED_CALLS) lines.push(`…and ${toolCalls.length - MAX_LISTED_CALLS} more.`)
    lines.push(
      "Before repeating anything that changes the outside world — posting a comment or message, " +
      "pushing, merging, deploying, sending — check whether it already happened.",
    )
  }
  lines.push(
    last
      ? "This is your last run for it. Finish the request if you can; if you can't, " +
        "say what is done, what is left and what is blocking it. Don't start long work you can't finish."
      : "Carry on from where you stopped and finish the request below.",
    "",
  )
  return lines.join("\n")
}
