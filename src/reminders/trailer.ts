// --- The agentx trailer on a reminder's notes ---
//
// Reminders created through the mac-pim skill end their notes with one line:
//
//   agentx: agent=<agentId> [context=<channel>:<chatId-or-ref>]
//
// `agent` created the reminder and gets it back when it falls due. `context`
// (optional, one token) says where the work came from, e.g. telegram:<chatId>.

export interface ReminderTrailer {
  agent: string
  context?: string
  /** The notes above the trailer, trimmed. */
  detail: string
}

const TRAILER = /^agentx:\s*(.*)$/

/** The trailer, or null when the last non-empty line isn't one or names no agent. */
export function parseTrailer(notes: string | null | undefined): ReminderTrailer | null {
  const lines = (notes ?? "").split(/\r?\n/)
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 0) return null
  const m = TRAILER.exec(lines[last].trim())
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const token of m[1].split(/\s+/)) {
    const eq = token.indexOf("=")
    if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1)
  }
  if (!fields.agent) return null
  return {
    agent: fields.agent,
    ...(fields.context ? { context: fields.context } : {}),
    detail: lines.slice(0, last).join("\n").trim(),
  }
}

/** "telegram:123" → { channel: "telegram", chatId: "123" }; null when it has no channel part. */
export function splitContext(context: string | undefined): { channel: string; chatId: string } | null {
  if (!context) return null
  const i = context.indexOf(":")
  if (i <= 0 || i === context.length - 1) return null
  return { channel: context.slice(0, i), chatId: context.slice(i + 1) }
}
