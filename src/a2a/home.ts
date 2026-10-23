// --- The home of a piece of work: the issue or merge request it is about (#1100) ---
//
// Two runs of one agent on the same issue overwrite each other's work. A
// delegation can name its home (`home`: an issue link or ref); runs that
// name none are matched by the references in their message. Both are
// reduced to one comparable form here: `group/project#12` for an issue
// (and a GitHub pull request, which shares its numbers), `group/project!12`
// for a GitLab merge request. The host is dropped, so a link and a ref to
// the same issue meet.

const HOME_MAX = 300

// A segment of a project path: letters, digits, dot, dash, underscore,
// with at least one letter (so a date such as 2026/10/20 is not a project).
const SEG = String.raw`(?=[\w.-]*[A-Za-z])[\w.-]+`
// The last segment is not a file name (src/home.ts#12 is a line, not work).
const LAST = String.raw`(?=[\w.-]*[A-Za-z])(?![\w-]*\.(?:ts|js|mjs|cjs|tsx|jsx|md|py|go|rs|json|ya?ml|txt|sh|html|css)\b)[\w.-]+`

const LINK = /\bhttps?:\/\/[^\s/<>()"']+\/([^\s<>()"'#?]+?)\/(?:-\/)?(issues|pull|merge_requests)\/(\d+)/gi
const REF = new RegExp(String.raw`(?<![\w/.-])((?:${SEG}\/)+${LAST})([#!])(\d+)\b`, "g")

/** The comparable form of an issue or merge request: from a link, from a
 *  `group/project#12` or `!12` ref, or (for anything else) the trimmed
 *  lower-cased text. Undefined for anything that is not one usable token. */
export function normalizeHome(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  // One token only: a home is a link or a ref, never prose (and nothing
  // multi-line ends up quoted into another run's prompt).
  if (!s || s.length > HOME_MAX || /\s/.test(s)) return undefined
  const link = new RegExp(LINK.source, "i").exec(s)
  if (link) return `${link[1].toLowerCase()}${link[2].toLowerCase() === "merge_requests" ? "!" : "#"}${link[3]}`
  const ref = new RegExp(`^${REF.source}$`).exec(s)
  if (ref) return `${ref[1].toLowerCase()}${ref[2]}${ref[3]}`
  return s.replace(/\/+$/, "").toLowerCase()
}

/** The homes a message names, in comparable form. A bare `#12` is left
 *  out: without its project it names different work in every repository. */
export function homeRefsOf(text: string | undefined | null): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(LINK)) {
    const h = normalizeHome(m[0])
    if (h) out.add(h)
  }
  for (const m of text.matchAll(REF)) out.add(`${m[1].toLowerCase()}${m[2]}${m[3]}`)
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
