import type Database from "better-sqlite3"
import { redactSourcesRead } from "@/situations/sources/redact"
import { getRunShape } from "@/storage/mesh-drill"

// --- The tool steps behind each Hub chat answer (#2101 PR 2, R14) ---
//
// GET /api/assistant/thread adds `runs`: for each answer whose run is
// known, how long it worked and its tool steps, each with the start of its
// input, so the Hub chat draws "Worked for 1m 12s" over one line per read,
// edit or command (wall-chat-fold.ts). Read through getRunShape, the one
// read of a run's steps (C1 of the v4 review); task_trace_steps keeps them
// for 90 days, so the fold is there after the live output is gone.

export interface AnswerStep {
  tool: string
  input: string
  error: boolean
  result?: string
}
export interface AnswerRun {
  ms: number | null
  status: string | null
  steps: AnswerStep[]
}

/** Steps kept for one answer: the fold lists them, it is not a log. */
export const ANSWER_STEPS_MAX = 200

export function assistantRuns(
  db: Database.Database | null,
  messages: Array<{ role: string; taskId?: string | null }>,
): Record<string, AnswerRun> {
  const out: Record<string, AnswerRun> = {}
  if (!db) return out
  for (const m of messages) {
    if (m.role !== "assistant" || !m.taskId || out[m.taskId]) continue
    let shape
    try { shape = getRunShape(db, m.taskId, ANSWER_STEPS_MAX * 2, { inputs: true }) } catch { continue }
    if (!shape.found) continue
    out[m.taskId] = { ms: shape.durationMs ?? null, status: shape.status ?? null, steps: answerSteps(shape.steps) }
  }
  return out
}

/** Tool calls in order; a failed result marks the call before it. */
export function answerSteps(rows: Array<{ name: string; action: string | null; status: string | null; input?: string | null; output?: string | null }>): AnswerStep[] {
  const steps: AnswerStep[] = []
  for (const r of rows) {
    if (r.name === "tool_use") {
      if (steps.length < ANSWER_STEPS_MAX) steps.push({ tool: r.action || "tool", input: redactSourcesRead(r.input || ""), error: r.status === "error",
        ...(r.output ? { result: redactSourcesRead(r.output) } : {}) })
    } else if (r.name === "tool_result" && steps.length) {
      const step = steps[steps.length - 1]
      if (r.status === "error") step.error = true
      if (r.output) step.result = redactSourcesRead(r.output)
    }
  }
  return steps
}
