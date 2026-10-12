// --- The resume plan a stopped task leaves behind (#857) ---
//
// A stop ends the run, then gives the agent one short wind-down turn on the
// same chat to write down where it was. When that turn does not answer in
// time, the plan is built from the run's trace instead and marked as
// machine-written. Resuming prepends the plan to the original request.

export interface ResumePlan {
  /** Who wrote it: the agent in its wind-down turn, or the daemon from the
   *  trace when the agent did not answer in time. */
  author: "agent" | "machine"
  text: string
  /** Why a machine plan was written (timeout, wind-down error). */
  note?: string
}

export interface ToolCallRef {
  action: string | null
  inputSummary: string | null
}

/** Longest plan kept. A plan is a note to self, not a transcript. */
export const PLAN_MAX_CHARS = 4000
const MAX_LISTED_CALLS = 15
const MAX_CALL_CHARS = 160
const MAX_REQUEST_CHARS = 1500

function oneLine(s: string | null | undefined, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…"
}

function listCalls(calls: ToolCallRef[]): string[] {
  const lines = calls.slice(0, MAX_LISTED_CALLS).map((c, i) => {
    const input = oneLine(c.inputSummary, MAX_CALL_CHARS)
    return `${i + 1}. ${c.action ?? "tool"}${input ? `: ${input}` : ""}`
  })
  if (calls.length > MAX_LISTED_CALLS) lines.push(`…and ${calls.length - MAX_LISTED_CALLS} more.`)
  return lines
}

function lastCall(calls: ToolCallRef[]): string {
  const c = calls[calls.length - 1]
  const input = oneLine(c.inputSummary, MAX_CALL_CHARS)
  return `${c.action ?? "tool"}${input ? `: ${input}` : ""}`
}

/** The message of the wind-down turn. */
export function windDownMessage(input: {
  by: string
  reason?: string
  originalMessage: string
  toolCalls: ToolCallRef[]
}): string {
  const lines = [
    `[Stop signal] ${input.by} asked you to stop this task${input.reason ? ` (${oneLine(input.reason, 200)})` : ""}. It has been stopped.`,
    "Do not continue the work and do not start any new action: no tool call that changes anything.",
    "Reply once, with a resume plan under exactly these headings:",
    "Done: what is finished.",
    "Left: what is still to do.",
    "Next action: the first thing to do when this is resumed.",
    "Half-applied: anything started but not finished (a partial edit, an open branch, an unsent message), or \"nothing\".",
    "",
    "The request you were working on:",
    oneLine(input.originalMessage, MAX_REQUEST_CHARS) || "(no message recorded)",
  ]
  if (input.toolCalls.length) {
    lines.push("", `Tool calls you had already made (${input.toolCalls.length}):`, ...listCalls(input.toolCalls))
    // The stop aborted the turn mid-way: whatever ran last may not have finished.
    lines.push(`The stop cut your turn off: the last tool call (${lastCall(input.toolCalls)}) may not have finished. Name it under Half-applied unless you know it completed.`)
  }
  return lines.join("\n")
}

/** The agent's answer as a plan, or null when it is empty. */
export function agentPlan(content: string | undefined): ResumePlan | null {
  const text = String(content ?? "").trim()
  if (!text) return null
  return { author: "agent", text: text.length <= PLAN_MAX_CHARS ? text : text.slice(0, PLAN_MAX_CHARS - 1) + "…" }
}

/** A plan built from the trace, for an agent that did not write one. */
export function machinePlan(input: { toolCalls: ToolCallRef[]; note: string }): ResumePlan {
  const lines = ["Written by AgentX from the run's trace: the agent did not write a plan."]
  if (input.toolCalls.length === 0) {
    lines.push("Done: no tool calls were made before the stop.")
  } else {
    lines.push(`Done: ${input.toolCalls.length} tool call(s) were made before the stop:`, ...listCalls(input.toolCalls))
  }
  lines.push(
    "Left: unknown. Re-read the request.",
    "Next action: check the tool calls above, then carry on with the request.",
    input.toolCalls.length
      ? `Half-applied: the stop cut the turn off, so the last tool call (${lastCall(input.toolCalls)}) may not have finished. Check it first.`
      : "Half-applied: nothing recorded.",
  )
  return { author: "machine", text: lines.join("\n"), note: input.note }
}

/** Prepended to the original request when a stopped task is resumed. */
export function resumeNote(input: { stoppedAt: string; stoppedBy: string; reason?: string; plan: ResumePlan; resumedBy: string }): string {
  const at = input.stoppedAt.slice(11, 16)
  const who = input.plan.author === "agent" ? "Your resume plan" : "A resume plan AgentX built from your trace (you did not write one)"
  return [
    `[Resumed after a stop] ${input.stoppedBy} stopped this task at ${at} UTC${input.reason ? ` (${oneLine(input.reason, 200)})` : ""}; ${input.resumedBy} resumed it.`,
    `${who}:`,
    input.plan.text,
    "",
    "Before repeating anything that changes the outside world (posting, pushing, merging, deploying, sending), check whether it already happened.",
    "Then finish the request below.",
    "",
  ].join("\n")
}
