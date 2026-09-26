import { createHash } from "crypto"
import type Database from "better-sqlite3"
import { getTrace, listTraces, type TraceRecord, type TraceStepRecord } from "@/storage/traces"
import type { MemoryCandidate } from "./promote"

// Failed traces → wiki promotion candidates.
//
// Every other learning pass reads successes: the procedure miner loads
// `status: ok` traces, and promotion reads memories an agent chose to
// write. A tool that keeps failing, or the same wrong turn taken in
// session after session, never reaches either — nothing in a failed run
// is written down as a memory, and the miner never looks at it.
//
// This groups failed and timed-out traces by a failure signature (agent
// + tool + outcome + error class) and offers only the signatures that recur across
// several sessions to `wiki promote`. They join the same pool as memories
// and monitor findings, so the judge, the ledger and the proposal review
// are shared rather than rebuilt. One failure is session state; the same
// failure in five sessions is something the fleet should know.

export const FAILURE_STAMP_PREFIX = "failure:"
export const DEFAULT_MIN_SESSIONS = 3
/** Example runs kept per signature; the counts carry the rest. */
export const MAX_FAILURE_EXAMPLES = 5

/** Trace statuses that count as a failure. `cancelled` does not: an
 *  operator or a daemon restart stopped the run, the agent did not fail. */
const FAILED_STATUSES = ["error", "timeout"]

/** Chats a learning pass itself runs in. Learning from those would make
 *  the system learn from itself (same rule as the procedure miner). */
const SELF_CHAT_PREFIXES = ["memory-promote", "procedure-miner"]

export interface FailedTrace {
  taskId: string
  agentId: string
  chatId: string | null
  /** The session the run belongs to — the provider session when one is
   *  known, else the run itself. See sessionOf(). */
  sessionId: string
  status: string
  startedAt: number
  error: string | null
  messagePreview: string | null
  /** The failing tool — see failingTool(); null when the run failed
   *  before or outside any tool. */
  tool: string | null
}

export interface FailureCandidate extends MemoryCandidate {
  /** Distinct sessions that hit this signature. */
  occurrences: number
  /** Some of those sessions, newest first. */
  sessions: string[]
  /** Some of the failed runs (task ids), newest first. */
  tasks: string[]
  failure: { tool: string; errorClass: string; runs: number }
}

/**
 * Reduce an error message to its class: the words that stay the same
 * when the same thing breaks again. Ids, numbers, paths, URLs and quoted
 * values change every time and would split one failure into many.
 */
export function errorClass(status: string, error: string | null): string {
  const text = (error ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(["'`]).*?\1/g, "<v>")
    .replace(/(?:~|\.{0,2})?\/[\w.@-]+(?:\/[\w.@-]+)*/g, "<path>")
    .replace(/\b[0-9a-z]*\d[0-9a-z]*\b/g, "<n>")
    .replace(/[^a-z<>\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const words = text.split(" ").filter(Boolean).slice(0, 8).join(" ")
  return words || status
}

/** Agent + tool + outcome + error class. A timeout and an error in the
 *  same tool are different failures with different fixes. */
export function failureSignature(t: Pick<FailedTrace, "agentId" | "tool" | "status" | "error">): string {
  return `${t.agentId}|${t.tool ?? "no-tool"}|${t.status}|${errorClass(t.status, t.error)}`
}

function digest(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 10)
}

/**
 * The stamp changes only when recurrence doubles (2–3 → 4–7 → 8–15 …).
 * A lesson skipped or rejected at three sessions is offered again once
 * it has been seen in four, and next at eight; it is not re-offered every
 * night because one more session hit it.
 */
export function failureStamp(signature: string, sessions: number): string {
  return `${FAILURE_STAMP_PREFIX}${digest(signature)}@${Math.floor(Math.log2(Math.max(1, sessions)))}`
}

/**
 * Which session a run belongs to. The provider session is the honest
 * unit: two failures inside one continuing conversation are one session
 * going wrong, not two. A run that never got a session is its own. The
 * chat id is deliberately not used — a scheduled job reuses one chat id
 * forever, which would count a job failing every night as one session.
 */
export function sessionOf(t: Pick<TraceRecord, "taskId" | "finalSessionId" | "resumeSessionId">): string {
  return t.finalSessionId ?? t.resumeSessionId ?? t.taskId
}

/** Load failed and timed-out traces in the window, with their failing tool. */
export function loadFailedTraces(db: Database.Database, opts: { since?: number } = {}): FailedTrace[] {
  const traces = FAILED_STATUSES.flatMap((status) =>
    listTraces(db, { status, since: opts.since, limit: 1000 }))
  return traces
    .filter((t) => !SELF_CHAT_PREFIXES.some((p) => (t.chatId ?? "").startsWith(p)))
    .map((t) => {
      const { tool, error } = failingTool(getTrace(db, t.taskId)?.steps ?? [])
      return {
        taskId: t.taskId,
        agentId: t.agentId,
        chatId: t.chatId,
        sessionId: sessionOf(t),
        status: t.status,
        startedAt: t.startedAt,
        error: error ?? t.error,
        messagePreview: t.messagePreview,
        tool,
      }
    })
}

/**
 * The tool a run failed in, and that tool's error. The stream records a
 * call as a `tool_use` step (named, status in-flight) and its outcome as
 * a separate `tool_result` step that carries no tool name, so an errored
 * result is paired with the call before it. The last error wins; with no
 * errored call the run is attributed to the last tool it used, keeping
 * the run's own error.
 */
export function failingTool(
  steps: Array<Pick<TraceStepRecord, "name" | "action" | "status" | "error" | "outputSummary">>,
): { tool: string | null; error: string | null } {
  let last: string | null = null
  let failing: { tool: string | null; error: string | null } | null = null
  for (const s of steps) {
    if (s.name === "tool_use" && s.action) {
      last = s.action
      if (s.status === "error") failing = { tool: s.action, error: s.error ?? s.outputSummary }
    } else if (s.name === "tool_result" && s.status === "error") {
      failing = { tool: s.action ?? last, error: s.error ?? s.outputSummary }
    }
  }
  return failing ?? { tool: last, error: null }
}

/** Group failures by signature; keep those seen in at least `minSessions`
 *  distinct sessions (never fewer than 2 — one session is not a pattern).
 *  Most recurrent first. */
export function failuresToCandidates(
  traces: FailedTrace[],
  opts: { minSessions?: number } = {},
): FailureCandidate[] {
  const minSessions = Math.max(2, opts.minSessions ?? DEFAULT_MIN_SESSIONS)
  const groups = new Map<string, FailedTrace[]>()
  for (const t of traces) {
    const sig = failureSignature(t)
    groups.set(sig, [...(groups.get(sig) ?? []), t])
  }

  const out: FailureCandidate[] = []
  for (const [signature, list] of groups) {
    const sessions = [...new Set([...list].sort((a, b) => b.startedAt - a.startedAt).map((t) => t.sessionId))]
    if (sessions.length < minSessions) continue
    list.sort((a, b) => b.startedAt - a.startedAt)
    const latest = list[0]
    const tool = latest.tool ?? "no tool"
    const cls = errorClass(latest.status, latest.error)
    const name = `failure-${digest(signature)}`
    out.push({
      occurrences: sessions.length,
      sessions: sessions.slice(0, MAX_FAILURE_EXAMPLES),
      tasks: list.slice(0, MAX_FAILURE_EXAMPLES).map((t) => t.taskId),
      failure: { tool, errorClass: cls, runs: list.length },
      agentId: latest.agentId,
      key: `${latest.agentId}/feedback_${name}`,
      stamp: failureStamp(signature, sessions.length),
      memory: {
        name,
        type: "feedback",
        description: `${latest.agentId}: ${tool} keeps failing (${cls}) in ${sessions.length} sessions`.slice(0, 200),
        body: renderBody(latest.agentId, tool, cls, sessions.length, list),
        createdAt: new Date(list[list.length - 1].startedAt).toISOString(),
        updatedAt: new Date(latest.startedAt).toISOString(),
      },
    })
  }
  return out.sort((a, b) => b.occurrences - a.occurrences)
}

function renderBody(agent: string, tool: string, cls: string, sessions: number, list: FailedTrace[]): string {
  const examples = list.slice(0, MAX_FAILURE_EXAMPLES).map((t) => {
    const task = (t.messagePreview ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
    const error = (t.error ?? t.status).replace(/\s+/g, " ").trim().slice(0, 160)
    return `- ${new Date(t.startedAt).toISOString().slice(0, 10)} \`${t.taskId}\` (${t.status})${task ? ` — task: ${task}` : ""}\n  error: ${error}`
  })
  return [
    `**${agent}** hit the same failure in ${sessions} separate sessions (${list.length} runs).`,
    `- Tool: \`${tool}\`\n- Error class: \`${cls}\``,
    "Recurrence across sessions is the finding: any one of these runs is session state. " +
      "Propose the fix that stops it recurring — what fails, the likely cause, and what to do instead " +
      "(a missing fact, a better approach, or a tool or configuration change to make) — " +
      "or skip it if the examples do not share a cause.",
    `**Examples (newest first):**\n${examples.join("\n")}`,
  ].join("\n\n")
}
