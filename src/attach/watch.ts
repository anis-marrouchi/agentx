import { z } from "zod"
import { eventSubscriptionSchema } from "@/daemon/config"
import type { EventEnvelope } from "@/events/envelope"
import { formatEventLine, matchesFilters, type SubscriptionInput } from "@/events/subscriptions"

// --- Watch mode: stay aware of the mesh without answering for it (#167) ---
//
// `agentx attach as <agent>` makes a session answer for an agent. A watching
// session answers for nobody. It holds no identity, so the dispatcher never
// offers it a message and the Stop hook never takes its turn. The one thing
// it gets is a short digest on UserPromptSubmit: the events since its last
// turn that match its subscription, capped so a busy mesh cannot flood the
// human's context.
//
// This module is the pure half: the default filter, the cursor that says
// where the last digest stopped, and the rendering. The registry stores the
// state; service.ts reads the event ring and calls in here.

/** What a watcher sees when it names no filter: failures, completions,
 *  approvals waiting, peers down. Mapped to the envelope kinds and types the
 *  daemon actually publishes (src/events/bus.ts, src/daemon/event-bus.ts):
 *
 *    task:completed   an agent turn ended; the summary says "failed after …"
 *                     or "completed in …", so one type covers both
 *    failed/timeout/  workflow run phases (kind "run"); no other publisher
 *    completed        uses these types
 *    paused + match   a run stopped at a checkpoint, i.e. waiting on a person
 *    lost             a mesh peer stopped answering
 */
export const DEFAULT_WATCH_SUBSCRIPTIONS: SubscriptionInput[] = [
  { kinds: ["task:completed"] },
  { kinds: ["failed", "timeout", "completed"] },
  { kinds: ["paused"], match: "checkpoint" },
  { kinds: ["lost"] },
]

/** Validate a watcher's filter with the same schema agent subscriptions use
 *  (#165). Absent means the default filter. */
export function parseWatchSubscriptions(
  raw: unknown,
): { ok: true; subscriptions: SubscriptionInput[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, subscriptions: DEFAULT_WATCH_SUBSCRIPTIONS }
  const parsed = z.array(eventSubscriptionSchema).min(1).safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `invalid subscriptions: ${issue?.path.join(".") || "value"} ${issue?.message ?? ""}`.trim() }
  }
  return { ok: true, subscriptions: parsed.data }
}

/** Hard caps on one injected digest. */
export const WATCH_DIGEST_MAX_LINES = 15
export const WATCH_DIGEST_MAX_CHARS = 1_500
/** Longest single event line, so one long summary cannot crowd out the rest. */
const LINE_MAX = 200

/** Where the last digest stopped. `id` is the newest event the session was
 *  shown or skipped past; `at` is its time, used when the id has left the
 *  ring (daemon restart, buffer wrap). No id means "since `at`, inclusive":
 *  the ring was empty when watching began. */
export interface WatchCursor {
  id?: string
  at: string
}

export interface WatchState {
  subscriptions: SubscriptionInput[]
  cursor: WatchCursor
  startedAt: number
}

/** A cursor pointing at the newest event in `events`, or at `now` when
 *  there are none. A new watcher starts here, not at the start of the ring. */
export function cursorAtEnd(events: EventEnvelope[], now: number = Date.now()): WatchCursor {
  const last = events[events.length - 1]
  return last ? { id: last.id, at: last.at } : { at: new Date(now).toISOString() }
}

/** Events strictly after the cursor, oldest first. */
export function eventsAfter(events: EventEnvelope[], cursor: WatchCursor): EventEnvelope[] {
  if (cursor.id) {
    const idx = events.findIndex((e) => e.id === cursor.id)
    if (idx >= 0) return events.slice(idx + 1)
  }
  const t = Date.parse(cursor.at)
  if (Number.isNaN(t)) return events
  return cursor.id
    ? events.filter((e) => Date.parse(e.at) > t)
    : events.filter((e) => Date.parse(e.at) >= t)
}

export interface WatchDigest {
  /** The context block, or undefined when nothing matched. */
  text?: string
  /** Where the next digest starts: the newest event looked at, matched or not. */
  cursor: WatchCursor
  matched: number
  shown: number
}

/** Build the digest for one prompt. Pure: the caller stores the cursor. */
export function watchDigest(
  state: WatchState,
  events: EventEnvelope[],
  caps: { maxLines?: number; maxChars?: number } = {},
): WatchDigest {
  const fresh = eventsAfter(events, state.cursor)
  const cursor = fresh.length ? cursorAtEnd(fresh) : state.cursor
  const matched = fresh.filter((e) => state.subscriptions.some((s) => matchesFilters(s, e)))
  if (matched.length === 0) return { cursor, matched: 0, shown: 0 }
  const since = state.cursor.id ?? state.cursor.at
  const { text, shown } = renderWatchDigest(matched, since, caps)
  return { text, cursor, matched: matched.length, shown }
}

/**
 * Render matched events (oldest first) under the caps. Keeps the newest
 * events that fit and ends with "+N more" and the command that lists them
 * all. Both caps count the whole block, header and trailer included.
 */
export function renderWatchDigest(
  matched: EventEnvelope[],
  since: string,
  caps: { maxLines?: number; maxChars?: number } = {},
): { text: string; shown: number } {
  const maxLines = Math.max(3, caps.maxLines ?? WATCH_DIGEST_MAX_LINES)
  const maxChars = Math.max(200, caps.maxChars ?? WATCH_DIGEST_MAX_CHARS)
  const lines = matched.map((e) => clipLine(`- ${formatEventLine(e)}`))
  const total = lines.length

  for (let shown = Math.min(total, maxLines - 1); shown >= 0; shown--) {
    const more = total - shown
    const header = more
      ? `[agentx watch] ${total} events since your last turn, newest ${shown} shown:`
      : `[agentx watch] ${total} event${total === 1 ? "" : "s"} since your last turn:`
    const out = [header, ...lines.slice(total - shown)]
    if (more) out.push(`+${more} more — \`agentx events --since ${since}\``)
    const text = out.join("\n")
    if (out.length <= maxLines && text.length <= maxChars) return { text, shown }
  }
  // Unreachable with sane caps: zero events plus header and trailer fit.
  return { text: `[agentx watch] ${total} events since your last turn — \`agentx events --since ${since}\``, shown: 0 }
}

function clipLine(s: string): string {
  return s.length <= LINE_MAX ? s : `${s.slice(0, LINE_MAX - 1)}…`
}
