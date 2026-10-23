import type Database from "better-sqlite3"
import type { CheckContext, CheckResult, ReplySpec } from "./index"

// --- reply: a person wrote in a chat after a time ---
//
// Read from the daemon's own record of inbound turns (task_traces): every
// turn a person starts on a channel is a row with its chat, its time and,
// when the sender is a known person (people, #384), their id. `from` is
// that id. A node without the record cannot say: unverifiable.

/** Inbound turns `person` started on this channel and chat since
 *  `after`, oldest first. Null: there is no record to read. */
export type InboundLog = (channel: string, chatId: string, after: number, person: string) => Array<{ person: string | null; at: number }> | null

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const FIELD_MAX = 200

export function parseReplySpec(raw: Record<string, unknown>, now: number): ReplySpec | string {
  const channel = str(raw.channel).toLowerCase()
  const chatId = str(raw.chatId)
  const from = str(raw.from)
  if (!channel || !chatId) return "a reply check needs channel and chatId: the chat the answer arrives in"
  if (!from) return "a reply check needs from: the id of the person who answers (people)"
  if ([channel, chatId, from].some((v) => v.length > FIELD_MAX)) return `channel, chatId and from are at most ${FIELD_MAX} characters`
  let after = now
  if (raw.after !== undefined) {
    const at = typeof raw.after === "number" ? raw.after : Date.parse(str(raw.after))
    if (!Number.isFinite(at) || at < 0) return "after must be epoch milliseconds or an ISO date"
    after = at
  }
  return { kind: "reply", channel, chatId, from, after }
}

export async function checkReply(spec: ReplySpec, ctx: Pick<CheckContext, "inbound" | "now">): Promise<CheckResult> {
  if (!ctx.inbound) return { verdict: "unverifiable", detail: "this node keeps no record of inbound messages" }
  const after = spec.after ?? 0
  const turns = ctx.inbound(spec.channel, spec.chatId, after, spec.from)
  if (!turns) return { verdict: "unverifiable", detail: "this node keeps no record of inbound messages" }
  const who = spec.from.toLowerCase()
  const hit = turns.find((t) => t.at > after && (t.person ?? "").toLowerCase() === who)
  if (hit) {
    return { verdict: "met", detail: `${spec.from} wrote on ${spec.channel} chat ${spec.chatId} at ${new Date(hit.at).toISOString().slice(0, 16).replace("T", " ")} UTC` }
  }
  return { verdict: "not_met", detail: `no message from ${spec.from} on ${spec.channel} chat ${spec.chatId} yet` }
}

const INBOUND_LIMIT = 5

/** The inbound log over this node's task_traces. A channel matches with
 *  or without its account ("telegram" and "telegram@support"). */
export function traceInbound(db: Database.Database): InboundLog {
  return (channel, chatId, after, person) => {
    try {
      return db.prepare(
        `SELECT person, started_at AS at FROM task_traces
         WHERE (channel = ? OR channel LIKE ? ESCAPE '\\') AND chat_id = ? AND started_at > ? AND lower(person) = lower(?)
         ORDER BY started_at LIMIT ?`,
      ).all(channel, `${channel.replace(/[\\%_]/g, "\\$&")}@%`, chatId, after, person, INBOUND_LIMIT) as Array<{ person: string | null; at: number }>
    } catch {
      // No task_traces (or no person column) here.
      return null
    }
  }
}
