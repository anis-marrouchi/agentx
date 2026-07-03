import type Database from "better-sqlite3"
import { getTrace } from "@/storage/traces"
import { loadSuccessfulTraces } from "@/workflows/absorb"
import type { SessionStore } from "@/agents/sessions"

// --- Episode loading ---
// An ActivityEpisode is one completed task seen from both sides: the user's
// words (trace original_message + nearby session turns) and the ground-truth
// action sequence (task_trace_steps). The miner clusters episodes; the LLM
// only ever sees the user-language side plus a coarse action outline.

export interface ActivityEpisode {
  taskId: string
  agentId: string
  channel: string
  chatId: string
  /** ms epoch */
  startedAt: number
  /** Full user message (task_traces.original_message, falls back to preview). */
  userMessage: string
  finalResponse?: string
  /** User-role turns from the surrounding session window (user language). */
  userTurns: string[]
  /** Ordered tool names from tool_use steps (internal only — never shown to the LLM raw). */
  actions: string[]
  /** Capped input summaries per action, for the LLM's coarse outline. */
  actionSummaries: string[]
}

export interface LoadEpisodesOptions {
  /** ms epoch — only traces started at/after this. */
  since?: number
  agentId?: string
  limit?: number
  /** Optional transcript join. Absent = trace-only episodes (still valid). */
  sessions?: SessionStore
}

/** Chat-id namespaces that are machine-originated, not user activity:
 *  cron dispatches, the workflow architect's own LLM tasks, wiki promotion
 *  calls, and this miner's own distillation calls. Mining any of these
 *  would make the system learn from itself. */
const MACHINE_CHAT_PREFIXES = ["cron:", "architect-", "memory-promote", "procedure-miner"]

function isMachineChat(chatId: string | null): boolean {
  const id = chatId ?? ""
  return MACHINE_CHAT_PREFIXES.some((p) => id.startsWith(p))
}

/** Self-referential infra tasks slip the chatId filter when an agent shells
 *  agentx tooling on someone's behalf (e.g. the nightly cron prompt tells
 *  coo-agent to run `node dist/cli.js workflow absorb …` and the task is
 *  recorded on the `api` channel). Any task whose own request invokes the
 *  agentx CLI is orchestration of the system, not user activity — mining it
 *  makes the system learn from itself. */
const SELF_REFERENTIAL_MESSAGE = /\bdist\/cli\.js\b|\bagentx\s+(workflow|procedure|wiki|cron|schedule)\b/i

function isSelfReferential(message: string | null): boolean {
  return SELF_REFERENTIAL_MESSAGE.test(message ?? "")
}

const JOIN_WINDOW_MS = 10 * 60 * 1000
const MAX_USER_TURNS = 6
const MAX_SUMMARY_CHARS = 160

export function loadEpisodes(db: Database.Database, opts: LoadEpisodesOptions = {}): ActivityEpisode[] {
  const traces = loadSuccessfulTraces(db, {
    since: opts.since,
    agentId: opts.agentId,
    limit: opts.limit ?? 1000,
  })
    .filter((t) => !isMachineChat(t.chatId))
    .filter((t) => !isSelfReferential(t.originalMessage ?? t.messagePreview))

  const episodes: ActivityEpisode[] = []
  for (const trace of traces) {
    const episode = buildEpisode(db, trace.taskId, opts.sessions)
    if (episode) episodes.push(episode)
  }
  return episodes
}

/** Load specific episodes by trace id — the distillation fallback for
 *  candidates whose occurrences are behind the scan watermark (their counts
 *  accumulated on earlier runs). The ledger keeps taskIds precisely so a
 *  ready candidate can be sampled at any time, not only in the run where
 *  its last occurrence happened. */
export function loadEpisodesByTaskIds(
  db: Database.Database,
  taskIds: string[],
  sessions?: SessionStore,
): ActivityEpisode[] {
  const episodes: ActivityEpisode[] = []
  for (const taskId of taskIds) {
    const episode = buildEpisode(db, taskId, sessions)
    if (episode) episodes.push(episode)
  }
  return episodes.sort((a, b) => b.startedAt - a.startedAt)
}

function buildEpisode(
  db: Database.Database,
  taskId: string,
  sessions?: SessionStore,
): ActivityEpisode | null {
  const detail = getTrace(db, taskId)
  if (!detail) return null
  const trace = detail.task
  // Guard both entry paths (window scan AND ledger-taskId fallback) — a
  // machine trace counted before a filter existed must not resurface here.
  if (isMachineChat(trace.chatId)) return null
  if (isSelfReferential(trace.originalMessage ?? trace.messagePreview)) return null
  const toolSteps = detail.steps.filter((s) => s.name === "tool_use" && s.action)
  const actions = toolSteps.map((s) => s.action as string)
  const actionSummaries = toolSteps.map((s) => (s.inputSummary ?? "").slice(0, MAX_SUMMARY_CHARS))

  let userTurns: string[] = []
  if (sessions && trace.channel && trace.chatId) {
    try {
      const endedAt = trace.finishedAt ?? trace.startedAt
      const recall = sessions.recallTurns({
        agentId: trace.agentId,
        channel: trace.channel,
        chatId: trace.chatId,
        after: new Date(trace.startedAt - JOIN_WINDOW_MS).toISOString(),
        before: new Date(endedAt + JOIN_WINDOW_MS).toISOString(),
        limit: 20,
      })
      userTurns = recall.turns
        .filter((t) => t.role === "user")
        .map((t) => t.content)
        .reverse() // recallTurns is newest-first; episodes read oldest-first
        .slice(0, MAX_USER_TURNS)
    } catch { /* transcript join is best-effort — the trace alone suffices */ }
  }

  return {
    taskId: trace.taskId,
    agentId: trace.agentId,
    channel: trace.channel ?? "unknown",
    chatId: trace.chatId ?? "",
    startedAt: trace.startedAt,
    userMessage: (trace.originalMessage ?? trace.messagePreview ?? "").trim(),
    finalResponse: trace.finalResponse ?? undefined,
    userTurns,
    actions,
    actionSummaries,
  }
}
