import type { AgentResponse, AgentTask } from "./runtime"

// --- A run cut at its time limit (#1261) ---
//
// A run that reaches maxExecutionMinutes is stopped. Long work is often
// close to done by then, so instead of a plain failure:
//   - the provider session the run wrote to is kept, and the run gets one
//     more turn on it, told it was cut and asked to finish;
//   - when that is not possible, or the extra turn fails too, the error
//     says where the work is (session, work dir, last step), so whoever
//     reads it (a delegating agent, the person in the chat) can pick it up.
// One extra turn at most: a turn that is cut again is not continued again.

const MAX_STEP_CHARS = 160

/** The session a cut run can be continued from, or null when the run was
 *  not cut by its time limit or left no session to continue. */
export function cutSession(response: AgentResponse): string | null {
  if (response.errorKind !== "timeout") return null
  return response.claudeSessionId || response.codexSessionId || response.opencodeSessionId || null
}

/** One line for a tool step: its name and the most telling part of its input. */
export function describeStep(name: string, input?: Record<string, unknown>): string {
  const pick = input && (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description
    ?? Object.values(input).find((v) => typeof v === "string"))
  const detail = typeof pick === "string" ? pick.replace(/\s+/g, " ").trim() : ""
  const text = detail ? `${name}: ${detail}` : name
  return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 1)}…` : text
}

/** The message of the extra turn. The session holds everything the run
 *  did, so this only says why the turn stopped and what to do now. */
export function continueMessage(minutes: number, lastStep?: string): string {
  return [
    `[AgentX: continue] Your previous turn on this request was stopped at its ${minutes}-minute time limit before you answered.`,
    lastStep ? `The last step you started was: ${lastStep}` : "",
    "Everything you did before is in this session. Check what is already done (files, commits, comments, messages sent) " +
      "before you repeat anything that changes the outside world.",
    "Then finish the work and give your final answer. If it cannot be finished in this turn, say exactly what is done, " +
      "what is left, and where (branch, files), so someone can pick it up.",
  ].filter(Boolean).join("\n")
}

/** The task for the extra turn: same agent, model and guards, the
 *  continue message instead of the request, and none of the chat context
 *  the first turn already read (it is in the session). */
export function continueTask(task: AgentTask, minutes: number, lastStep?: string): AgentTask {
  const { conversationHistory: _h, replyToText: _r, mediaPath: _m, mediaType: _t, ...context } = task.context ?? {}
  const { seedHistory: _s, freshSession: _f, ...rest } = task
  return { ...rest, message: continueMessage(minutes, lastStep), ...(task.context ? { context } : {}) }
}

/** Where the cut work is, added to the error the caller sees. */
export function cutRecord(input: { sessionId?: string | null; workspace?: string; lastStep?: string; continued: boolean }): string {
  const parts = [
    input.continued ? "One extra turn to finish it was cut too." : "",
    input.sessionId ? `Its session ${input.sessionId} keeps the work so far; the next message in this chat continues it.` : "No session was kept.",
    input.workspace ? `Work dir: ${input.workspace}.` : "",
    input.lastStep ? `Last step: ${input.lastStep}.` : "",
  ]
  return parts.filter(Boolean).join(" ")
}
