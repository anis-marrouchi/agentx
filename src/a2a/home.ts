// --- The home of a piece of work: the issue or merge request it is about (#1100) ---
//
// Two runs of one agent on the same issue overwrite each other's work. A
// delegation can name its home (`home`: an issue link or ref); runs that
// name none are matched by the references in their message. Both are
// reduced to one comparable form here.

const HOME_MAX = 300

/** One comparable form of a home: trimmed, lower case, without a link's
 *  query, comment anchor or trailing slash. Undefined for anything that
 *  is not a usable string. */
export function normalizeHome(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  let s = v.trim().toLowerCase()
  if (/^https?:\/\//.test(s)) s = s.replace(/[?#].*$/, "")
  s = s.replace(/\/+$/, "")
  return s && s.length <= HOME_MAX ? s : undefined
}

// Issue, pull and merge request links, and `group/project#12` refs. A bare
// `#12` is left out: without its project it names different work in
// every repository.
const LINK = /\bhttps?:\/\/[^\s<>()"']+\/(?:-\/)?(?:issues|pull|merge_requests)\/\d+/gi
const REF = /(?<![\w/.-])([\w.-]+(?:\/[\w.-]+)+)[#!](\d+)\b/g

/** The homes a message names, in comparable form. */
export function homeRefsOf(text: string | undefined | null): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(LINK)) {
    const h = normalizeHome(m[0])
    if (h) out.add(h)
  }
  for (const m of text.matchAll(REF)) {
    const h = normalizeHome(`${m[1]}#${m[2]}`)
    if (h) out.add(h)
  }
  return [...out]
}

/** The home a /task or /send/agent body names: top level, or in the
 *  context a /task carries. */
export function homeOfBody(body: Record<string, unknown>): string | undefined {
  const ctx = body.context && typeof body.context === "object" ? body.context as Record<string, unknown> : null
  return normalizeHome(body.home) ?? normalizeHome(ctx?.home)
}

/** How the note to a second run on the same home starts. */
export const SAME_HOME_MARKER = "[agentx:same-home]"

/** A line for a run that starts while another run of the same agent, in
 *  another chat, works on one of its homes (#1100): say so, so the two do
 *  not overwrite each other. Null when there is none. */
export function sameHomeNote(
  others: ReadonlyArray<{ homes?: string[]; channel: string; chatId?: string; startedAt: Date }>,
  mine: string[],
  chat: { channel: string; chatId?: string },
): string | null {
  if (!mine.length) return null
  for (const o of others) {
    if (o.channel === chat.channel && o.chatId === chat.chatId) continue
    const shared = o.homes?.find((h) => mine.includes(h))
    if (!shared) continue
    const at = o.startedAt.toISOString().slice(11, 16)
    return `${SAME_HOME_MARKER} Another run of yours is already working on ${shared} (started ${at}Z, chat ${o.channel}:${o.chatId ?? "?"}). ` +
      "Coordinate with it or stop: do not redo or overwrite its work. Keep what is not committed in a branch, not in a shared folder."
  }
  return null
}

/** The homes a run is about: its named home first, then those in its
 *  message. */
export function homesOfRun(run: { message?: string; home?: unknown }): string[] {
  const named = normalizeHome(run.home)
  const found = homeRefsOf(run.message)
  return named ? [named, ...found.filter((h) => h !== named)] : found
}
