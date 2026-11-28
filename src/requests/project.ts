// --- The project a request belongs to (#2587) ---
//
// Every request names a project, or none ("No project", stored as null).
// It is filled at creation only when the request clearly names one: the
// forge chat it came from, one forge reference or address in its words,
// or one known project's name. Anyone can move it later (dashboard, CLI,
// agentx_request action project).

/** The longest project key kept. Forge paths are short; this caps junk. */
export const PROJECT_MAX = 200
/** The label shown for a request with no project. */
export const NO_PROJECT = "No project"

/** A known project: its key (`org/repo` or a slug) and an optional name. */
export interface KnownProject { project: string; displayName?: string }

let known: () => readonly KnownProject[] = () => []

/** The daemon tells the store which projects it knows (.agentx/projects
 *  rules), read fresh at each creation so a rule added later counts. */
export function setKnownProjects(fn: () => readonly KnownProject[]): void { known = fn }

/** A project key as given by a person or an agent: trimmed, at most
 *  PROJECT_MAX. "", "none" and "No project" mean no project (null).
 *  Returns a string error when it cannot be a key. */
export function normalizeProject(raw: unknown): string | null | { error: string } {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") return { error: "project must be a string (a project key such as group/project), or \"none\"" }
  const v = raw.trim()
  if (!v || /^none$/i.test(v) || v.toLowerCase() === NO_PROJECT.toLowerCase()) return null
  if (v.length > PROJECT_MAX) return { error: `project is longer than ${PROJECT_MAX} characters` }
  if (/[\s\u0000-\u001f]/.test(v)) return { error: "project must not hold spaces: use its key, such as group/project" }
  return v
}

const FORGE_CHANNELS = new Set(["gitlab", "github"])
// "group/sub/project#12" or "!12", not inside a longer word or address.
const SHORT_REF = /(?:^|[\s(\[,;:'"])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)[#!]\d+\b/g
const GITHUB_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+/g
const GITLAB_URL = /https?:\/\/[\w.-]+\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:issues|merge_requests)\/\d+/g

function refsIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const re of [SHORT_REF, GITHUB_URL, GITLAB_URL]) {
    for (const m of text.matchAll(re)) {
      const p = m[1]
      if (p.split("/").every((s) => s !== "." && s !== "..")) found.add(p)
    }
  }
  return found
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Short names are words too often ("app", "web"): a name is matched
 *  only from this length. The full key always is. */
const NAME_MIN = 4

function namesOf(p: KnownProject): string[] {
  const names = [p.project]
  const last = p.project.split("/").pop() ?? ""
  if (last !== p.project && last.length >= NAME_MIN) names.push(last)
  if (p.displayName && p.displayName.trim().length >= NAME_MIN) names.push(p.displayName.trim())
  return names
}

function knownIn(text: string, projects: readonly KnownProject[]): Set<string> {
  const found = new Set<string>()
  for (const p of projects) {
    if (namesOf(p).some((n) => new RegExp(`(?:^|[^\\w/.-])${escape(n)}(?![\\w/-])`, "i").test(text))) found.add(p.project)
  }
  return found
}

/** The project a new request clearly names, or null ("No project").
 *  In order: the forge chat it came from (`group/project:issue:12`), one
 *  forge reference or address in its words, one known project's key or
 *  name in its words. Two different ones are not clear: null. */
export function projectOf(input: { channel: string; chatId: string; text: string }, projects: readonly KnownProject[] = known()): string | null {
  if (FORGE_CHANNELS.has(input.channel)) {
    const p = input.chatId.split(":")[0]
    if (p && p.includes("/") && p.length <= PROJECT_MAX) return p
  }
  const refs = refsIn(input.text)
  if (refs.size === 1) {
    const p = [...refs][0]
    // A known key in another case is the same project.
    return projects.find((k) => k.project.toLowerCase() === p.toLowerCase())?.project ?? (p.length <= PROJECT_MAX ? p : null)
  }
  if (refs.size > 1) return null
  const named = knownIn(input.text, projects)
  return named.size === 1 ? [...named][0] : null
}
