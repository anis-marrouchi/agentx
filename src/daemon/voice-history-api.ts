// Past voice exchanges, for AgentX Voice's History window (#159).
//
// Nothing new is recorded for this. Every /ask turn already leaves a
// task_traces row with channel "voice" and chat_id "voice:<agent>": the
// question (message_preview, original_message), the answer as written
// (final_response), the status and how long it took. These routes read
// those rows back.
//
//   GET  /voice/history?agent=&limit=&before=
//        {exchanges, next}: newest first, `limit` (default 20, at most 50)
//        per page. Summaries only: the question and the start of the answer,
//        each capped, never the answer itself. `next` is the id to pass as
//        `before` for the page after this one, null on the last page.
//        `before` is an exchange id, or a time in ms since the epoch.
//   GET  /voice/history/:id
//        One exchange in full: the answer as written, its links and buttons
//        (the agentx:ui directive), and the dashboard path of its task.
//   POST /voice/history/:id/replay
//        Say the answer again in its agent's voice. It joins the end of the
//        speaking queue like any new answer, so it never talks over a line
//        already playing or waiting. 202 {item}.
//
// A prompt or an answer can hold anything, so the whole path is gated like
// agent memory (isMeshGatedPath): loopback is exempt, off-box needs the
// mesh token. Only rows on the voice channel are served here; this is not
// a second way to read every trace.

import type Database from "better-sqlite3"
import { extractUiDirective, type UiDirective } from "@/channels/ui-directive"
import type { VoiceRef } from "@/voice/speaker"
import type { SpeechOut } from "@/voice/speaking-queue"
import type { Reply } from "@/daemon/voice-talk-api"

export const HISTORY_DEFAULT_LIMIT = 20
export const HISTORY_MAX_LIMIT = 50
/** Caps on what a list row carries. */
export const QUESTION_PREVIEW_MAX = 200
export const ANSWER_PREVIEW_MAX = 240
const ERROR_PREVIEW_MAX = 200
/** Caps on one exchange read in full. A voice answer is short; these only
 *  stop a runaway reply from becoming a multi-megabyte response. */
const QUESTION_FULL_MAX = 4_000
const ANSWER_FULL_MAX = 20_000

/** The voice channel's rows, as /ask records them. */
const VOICE_ROWS = "channel = 'voice' AND chat_id LIKE 'voice:%'"

/** One row of the list. */
export interface VoiceExchangeSummary {
  id: string
  agentId: string
  /** When the question was asked, ms since the epoch. */
  at: number
  /** Null while the answer is still coming. */
  durationMs: number | null
  /** "ok", "error", "in-flight", "canceled", "timeout". */
  status: string
  question: string
  /** The start of the written answer, on one line; "" when there is none. */
  answerPreview: string
  /** Length of the whole written answer, so a client can say there is more. */
  answerChars: number
  error: string | null
}

export interface VoiceExchange extends Omit<VoiceExchangeSummary, "answerPreview" | "answerChars"> {
  /** The answer as written, with its links; null when there was none. */
  answer: string | null
  /** True when `answer` was cut at the size cap. */
  truncated: boolean
  /** Buttons, poll or media from the agentx:ui directive. */
  ui: UiDirective | null
  /** The task page on the dashboard, relative to its address. */
  taskPath: string
}

export interface HistoryQuery {
  agent?: string | null
  limit?: number | string | null
  before?: string | null
}

export type HistoryPage =
  | { ok: true; exchanges: VoiceExchangeSummary[]; next: string | null }
  | { ok: false; error: string }

export function isVoiceHistoryPath(path: string): boolean {
  return path === "/voice/history" || path.startsWith("/voice/history/")
}

/** One line, cut at a word, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  if (one.length <= max) return one
  const cut = one.slice(0, max - 1)
  const word = cut.replace(/\s+\S*$/, "")
  return `${word.length > max / 2 ? word : cut}…`
}

/** The start of an answer without the agentx:ui block. Reads only a
 *  prefix of the answer: the block sits at the end, so a prefix that
 *  reaches it is already past everything a preview shows. */
function previewOf(head: string | null): string {
  if (!head) return ""
  const fence = head.search(/```[ \t]*agentx:ui/i)
  return clip(fence >= 0 ? head.slice(0, fence) : head, ANSWER_PREVIEW_MAX)
}

function limitOf(raw: HistoryQuery["limit"]): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10)
  if (!Number.isFinite(n) || n < 1) return HISTORY_DEFAULT_LIMIT
  return Math.min(Math.floor(n), HISTORY_MAX_LIMIT)
}

export function listVoiceHistory(db: Database.Database, q: HistoryQuery = {}): HistoryPage {
  const where = [VOICE_ROWS]
  const params: unknown[] = []
  const agent = (q.agent ?? "").trim()
  if (agent) { where.push("agent_id = ?"); params.push(agent) }

  const before = (q.before ?? "").trim()
  if (/^\d+$/.test(before)) {
    where.push("started_at < ?")
    params.push(Number(before))
  } else if (before) {
    // An exchange id: everything older than it, ties broken by id so two
    // questions asked in the same millisecond are neither lost nor repeated.
    const at = db.prepare(`SELECT started_at FROM task_traces WHERE task_id = ? AND ${VOICE_ROWS}`).get(before) as
      | { started_at: number } | undefined
    if (!at) return { ok: false, error: `before: no voice exchange ${before}` }
    where.push("(started_at < ? OR (started_at = ? AND task_id < ?))")
    params.push(at.started_at, at.started_at, before)
  }

  const limit = limitOf(q.limit)
  // substr() keeps the answer body inside SQLite: the list never holds a
  // whole answer, even in memory.
  const rows = db.prepare(`
    SELECT task_id, agent_id, status, started_at, duration_ms, error,
           COALESCE(message_preview, substr(original_message, 1, ${QUESTION_PREVIEW_MAX})) AS question,
           substr(final_response, 1, ${ANSWER_PREVIEW_MAX * 3}) AS answer_head,
           COALESCE(length(final_response), 0) AS answer_chars
      FROM task_traces
     WHERE ${where.join(" AND ")}
     ORDER BY started_at DESC, task_id DESC
     LIMIT ?
  `).all(...params, limit + 1) as Array<Record<string, any>>

  const more = rows.length > limit
  const exchanges = rows.slice(0, limit).map((r): VoiceExchangeSummary => ({
    id: r.task_id,
    agentId: r.agent_id,
    at: r.started_at,
    durationMs: r.duration_ms ?? null,
    status: r.status,
    question: clip(r.question ?? "", QUESTION_PREVIEW_MAX),
    answerPreview: previewOf(r.answer_head),
    answerChars: r.answer_chars,
    error: r.error ? clip(r.error, ERROR_PREVIEW_MAX) : null,
  }))
  return { ok: true, exchanges, next: more ? exchanges[exchanges.length - 1].id : null }
}

export function getVoiceExchange(db: Database.Database, id: string): VoiceExchange | null {
  const r = db.prepare(`
    SELECT task_id, agent_id, status, started_at, duration_ms, error,
           COALESCE(original_message, message_preview) AS question, final_response
      FROM task_traces WHERE task_id = ? AND ${VOICE_ROWS}
  `).get(id) as Record<string, any> | undefined
  if (!r) return null
  const raw = (r.final_response as string | null) ?? null
  const { cleanText, ui } = raw ? extractUiDirective(raw) : { cleanText: "", ui: undefined }
  const answer = raw ? cleanText : null
  const question = String(r.question ?? "")
  return {
    id: r.task_id,
    agentId: r.agent_id,
    at: r.started_at,
    durationMs: r.duration_ms ?? null,
    status: r.status,
    question: question.length > QUESTION_FULL_MAX ? `${question.slice(0, QUESTION_FULL_MAX)}…` : question,
    answer: answer && answer.length > ANSWER_FULL_MAX ? answer.slice(0, ANSWER_FULL_MAX) : answer,
    truncated: !!answer && answer.length > ANSWER_FULL_MAX,
    ui: ui ?? null,
    error: r.error ? clip(r.error, ERROR_PREVIEW_MAX) : null,
    taskPath: `/tasks/${encodeURIComponent(r.task_id)}?agent=${encodeURIComponent(r.agent_id)}&channel=voice`,
  }
}

export interface VoiceHistoryDeps {
  db: Database.Database | null
  speech: SpeechOut
  /** The agent's voice for the queue; null for an agent this host can't voice. */
  voiceOf: (agentId: string) => VoiceRef | null
  /** Written answer to what is said aloud (the daemon's toSpeakable). */
  speakable: (text: string) => string
}

export function handleVoiceHistory(
  deps: VoiceHistoryDeps,
  method: string,
  path: string,
  query: URLSearchParams,
): Reply {
  if (!deps.db) return { status: 503, body: { error: "sqlite not opened" } }

  if (path === "/voice/history") {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const page = listVoiceHistory(deps.db, {
      agent: query.get("agent"), limit: query.get("limit"), before: query.get("before"),
    })
    return page.ok
      ? { status: 200, body: { exchanges: page.exchanges, next: page.next } }
      : { status: 400, body: { error: page.error } }
  }

  // /voice/history/:id[/replay]. Ids are ULIDs: nothing to decode.
  const [, , , id, action, extra] = path.split("/")
  if (!id || extra !== undefined) return { status: 404, body: { error: "Not found" } }

  if (action === undefined) {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const exchange = getVoiceExchange(deps.db, id)
    return exchange ? { status: 200, body: exchange } : unknown(id)
  }

  if (action === "replay") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const exchange = getVoiceExchange(deps.db, id)
    if (!exchange) return unknown(id)
    const text = exchange.answer ? deps.speakable(exchange.answer) : ""
    if (!text) return { status: 409, body: { error: "This exchange has no answer to say." } }
    const voice = deps.voiceOf(exchange.agentId)
    if (!voice) return { status: 404, body: { error: `Unknown agent: ${exchange.agentId}` } }
    // Not `front`: a replay waits its turn behind everything already queued.
    const { item } = deps.speech.enqueue({ voice, text, agentId: exchange.agentId, kind: "answer" })
    return { status: 202, body: { item } }
  }

  return { status: 404, body: { error: "Not found" } }
}

const unknown = (id: string): Reply => ({ status: 404, body: { error: `No voice exchange ${id}` } })
