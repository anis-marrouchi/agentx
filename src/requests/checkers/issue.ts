import type { CheckContext, CheckResult, IssueSpec, IssueState } from "./index"

// --- issue: an issue or merge request is in a state, or has a matching note ---
//
// Read through the configured GitHub or GitLab connector: one GET for the
// item, and one for its notes when a pattern is given. A ref the forge
// does not know, or will not show, is unverifiable: the check cannot say.
//
// Refs: "owner/repo#12" (GitHub issue or pull request), "group/project#12"
// (GitLab issue), "group/project!12" (GitLab merge request), or the item's
// web address on either forge.

export interface ForgeItem {
  state: IssueState
  /** The bodies of its notes, oldest first. Only read when asked for. */
  notes?: string[]
  /** When each of `notes` was written (epoch ms), same order; null when
   *  the forge did not say (#1925). */
  noteTimes?: Array<number | null>
  url: string
  /** Its label names (status drift, #1138 step F). */
  labels?: string[]
  /** Who closed or merged it, and when (ISO), as the forge says (#1184). */
  closedBy?: string | null
  closedAt?: string | null
  /** Its milestone title and assignee logins, as the forge says (#1195). */
  milestone?: string | null
  assignees?: string[]
  /** Why a GitHub issue was closed ("completed", "not_planned"), as the
   *  forge says (#1522). GitLab has no such field. */
  stateReason?: string | null
}

/** Reads one item, or says why it could not (unknown, not visible, down). */
export type ForgeReader = (provider: "github" | "gitlab", ref: ParsedRef, opts: { notes: boolean; notesSince?: number }) => Promise<ForgeItem | { error: string }>

export interface ParsedRef { project: string; number: number; mr: boolean }

const PATTERN_MAX = 200
const NOTE_MAX = 10_000
const TIMEOUT_MS = 10_000
const STATES: readonly IssueState[] = ["open", "closed", "merged"]

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** "owner/repo#12", "group/sub/project!3", or a web address. A project
 *  with a "." or ".." part is refused: it would walk the API path. */
export function parseRef(provider: "github" | "gitlab", ref: string): ParsedRef | null {
  const parsed = parseRefParts(provider, ref)
  return parsed && parsed.project.split("/").every((p) => p !== "." && p !== "..") ? parsed : null
}

function parseRefParts(provider: "github" | "gitlab", ref: string): ParsedRef | null {
  const short = ref.match(/^([\w.-]+(?:\/[\w.-]+)+)([#!])(\d+)$/)
  if (short) {
    if (provider === "github" && (short[2] === "!" || short[1].split("/").length !== 2)) return null
    return { project: short[1], number: Number(short[3]), mr: short[2] === "!" }
  }
  let u: URL
  try { u = new URL(ref) } catch { return null }
  const path = u.pathname.replace(/\/+$/, "")
  if (provider === "github") {
    const m = path.match(/^\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)$/)
    return m ? { project: m[1], number: Number(m[3]), mr: m[2] === "pull" } : null
  }
  const m = path.match(/^\/(.+?)\/-\/(issues|merge_requests)\/(\d+)$/)
  return m ? { project: m[1], number: Number(m[3]), mr: m[2] === "merge_requests" } : null
}

export function parseIssueSpec(raw: Record<string, unknown>, now = Date.now()): IssueSpec | string {
  const provider = str(raw.provider).toLowerCase()
  if (provider !== "github" && provider !== "gitlab") return "provider must be github or gitlab"
  const ref = str(raw.ref)
  if (!ref || ref.length > 500 || !parseRef(provider, ref)) {
    return provider === "github"
      ? 'ref must be "owner/repo#12" or the issue or pull request address'
      : 'ref must be "group/project#12" (issue), "group/project!12" (merge request) or its address'
  }
  const state = str(raw.state).toLowerCase()
  if (state && !(STATES as readonly string[]).includes(state)) return `state must be one of ${STATES.join(", ")}`
  const notePattern = str(raw.notePattern)
  if (notePattern.length > PATTERN_MAX) return `notePattern is longer than ${PATTERN_MAX} characters`
  // A note pattern looks only at notes written once the loop is open
  // (#1925): a word already on the issue must not close it at once.
  let after = now
  if (notePattern && raw.after !== undefined) {
    const at = typeof raw.after === "number" ? raw.after : Date.parse(str(raw.after))
    if (!Number.isFinite(at) || at < 0) return "after must be epoch milliseconds or an ISO date"
    after = at
  }
  return { kind: "issue", provider, ref, ...(state ? { state: state as IssueState } : {}), ...(notePattern ? { notePattern, after } : {}) }
}

/** The notes a pattern may match: all of them for a spec stored without
 *  `after`, else only those written at or after it. A note without a time
 *  is left out: the check cannot tell it is new. */
function notesToMatch(spec: IssueSpec, item: ForgeItem): string[] {
  const notes = item.notes ?? []
  if (spec.after === undefined) return notes
  return notes.filter((_, i) => {
    const at = item.noteTimes?.[i]
    return typeof at === "number" && at >= spec.after!
  })
}

/** A forge time string as epoch ms; null when absent or unreadable. */
const timeOf = (v: unknown): number | null => {
  const at = typeof v === "string" ? Date.parse(v) : NaN
  return Number.isFinite(at) ? at : null
}

/** A closed check is met by a merged one too: merged is closed. */
const stateMatches = (want: IssueState, have: IssueState) => want === have || (want === "closed" && have === "merged")

export async function checkIssue(spec: IssueSpec, ctx: Pick<CheckContext, "forge">): Promise<CheckResult> {
  if (!ctx.forge) return { verdict: "unverifiable", detail: `no ${spec.provider} connector on this node` }
  const ref = parseRef(spec.provider, spec.ref)
  if (!ref) return { verdict: "unverifiable", detail: `${spec.ref} is not an issue reference` }
  const item = await ctx.forge(spec.provider, ref, { notes: !!spec.notePattern, ...(spec.notePattern && spec.after !== undefined ? { notesSince: spec.after } : {}) })
  if ("error" in item) return { verdict: "unverifiable", detail: `${spec.ref}: ${item.error}` }
  // No state and no pattern: closed is what finished means.
  const want = spec.state ?? (spec.notePattern ? null : "closed")
  if (want && stateMatches(want, item.state)) return { verdict: "met", detail: `${item.url} is ${item.state}` }
  if (spec.notePattern) {
    // Plain text, any case: an agent's pattern never runs as a regular
    // expression on the daemon's thread, so it cannot stall it.
    const want = spec.notePattern.toLowerCase()
    if (notesToMatch(spec, item).some((n) => n.slice(0, NOTE_MAX).toLowerCase().includes(want))) return { verdict: "met", detail: `${item.url} has a note with "${spec.notePattern}"` }
  }
  const since = spec.notePattern && spec.after !== undefined ? ` since ${new Date(spec.after).toISOString()}` : ""
  return { verdict: "not_met", detail: `${item.url} is ${item.state}${spec.notePattern ? `, no note${since} has "${spec.notePattern}"` : ""}` }
}

/** A forge user name or time string; null when absent. */
const login = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 120) : null)

/** Label names: GitLab sends strings, GitHub objects with a name. */
function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((l: any) => (typeof l === "string" ? l : String(l?.name ?? ""))).filter(Boolean)
}

/** Milestone and assignees: the same fields on both forges, the login
 *  under `login` (GitHub) or `username` (GitLab). */
function planOf(b: any, key: "login" | "username"): { milestone: string | null; assignees: string[] } {
  const people: any[] = Array.isArray(b?.assignees) ? b.assignees : b?.assignee ? [b.assignee] : []
  return { milestone: login(b?.milestone?.title), assignees: people.map((a) => login(a?.[key])).filter((a): a is string => !!a) }
}

export interface ForgeConnectors {
  github?: { apiUrl: string; token?: string }
  gitlab?: { url: string; token?: string }
}

/** The headers a forge read sends: the connector's token, if it has one. */
export function forgeHeaders(provider: "github" | "gitlab", connectors: ForgeConnectors): Record<string, string> {
  if (provider === "github") {
    const token = connectors.github?.token
    return { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  }
  const token = connectors.gitlab?.token
  return token ? { "PRIVATE-TOKEN": token } : {}
}

/** The reader over the REST APIs of GitHub and GitLab. One page of notes
 *  (the newest 100 on GitLab, the first 100 on GitHub). */
export function forgeReader(connectors: ForgeConnectors, doFetch: typeof fetch = fetch): ForgeReader {
  const get = async (url: string, headers: Record<string, string>): Promise<{ ok: true; body: any } | { ok: false; error: string }> => {
    let res: Response
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { ok: false, error: `could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
    }
    if (!res.ok) return { ok: false, error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    return { ok: true, body: await res.json().catch(() => null) }
  }

  return async (provider, ref, opts) => {
    if (provider === "github") {
      const c = connectors.github
      if (!c) return { error: "no github connector on this node (channels.github or requests.checkers.github)" }
      const api = c.apiUrl.replace(/\/$/, "")
      const headers = forgeHeaders("github", connectors)
      const base = `${api}/repos/${ref.project}`
      const issue = await get(`${base}/issues/${ref.number}`, headers)
      if (!issue.ok) return { error: issue.error }
      let state: IssueState = issue.body?.state === "closed" ? "closed" : "open"
      let closer = { closedBy: login(issue.body?.closed_by?.login), closedAt: login(issue.body?.closed_at) }
      if (issue.body?.pull_request && state === "closed") {
        const pr = await get(`${base}/pulls/${ref.number}`, headers)
        if (pr.ok && pr.body?.merged) {
          state = "merged"
          closer = { closedBy: login(pr.body?.merged_by?.login) ?? closer.closedBy, closedAt: login(pr.body?.merged_at) ?? closer.closedAt }
        }
      }
      if (state === "open") closer = { closedBy: null, closedAt: null }
      const url = String(issue.body?.html_url ?? `${ref.project}#${ref.number}`)
      const labels = labelNames(issue.body?.labels)
      const plan = planOf(issue.body, "login")
      const reason = state === "closed" ? login(issue.body?.state_reason) : null
      const stateReason = reason ? { stateReason: reason } : {}
      if (!opts.notes) return { state, url, labels, ...closer, ...plan, ...stateReason }
      // `since` (updated at or after) keeps the page to the notes that can
      // count, so a long thread's new notes are not past the first 100.
      const since = opts.notesSince !== undefined ? `&since=${encodeURIComponent(new Date(opts.notesSince).toISOString())}` : ""
      const notes = await get(`${base}/issues/${ref.number}/comments?per_page=100${since}`, headers)
      if (!notes.ok) return { error: `its notes: ${notes.error}` }
      const list: any[] = Array.isArray(notes.body) ? notes.body : []
      return { state, url, labels, ...closer, ...plan, ...stateReason, notes: list.map((n) => String(n?.body ?? "")), noteTimes: list.map((n) => timeOf(n?.created_at)) }
    }
    const c = connectors.gitlab
    if (!c) return { error: "no gitlab connector on this node (channels.gitlab or requests.checkers.gitlab)" }
    const headers = forgeHeaders("gitlab", connectors)
    const base = `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(ref.project)}/${ref.mr ? "merge_requests" : "issues"}/${ref.number}`
    const item = await get(base, headers)
    if (!item.ok) return { error: item.error }
    const raw = String(item.body?.state ?? "")
    const state: IssueState = raw === "merged" ? "merged" : raw === "closed" ? "closed" : "open"
    const url = String(item.body?.web_url ?? `${ref.project}${ref.mr ? "!" : "#"}${ref.number}`)
    const labels = labelNames(item.body?.labels)
    const b = item.body
    const closer = state === "merged"
      ? { closedBy: login((b?.merge_user ?? b?.merged_by)?.username), closedAt: login(b?.merged_at) }
      : state === "closed" ? { closedBy: login(b?.closed_by?.username), closedAt: login(b?.closed_at) } : { closedBy: null, closedAt: null }
    const plan = planOf(b, "username")
    if (!opts.notes) return { state, url, labels, ...closer, ...plan }
    const notes = await get(`${base}/notes?per_page=100&sort=desc&order_by=created_at`, headers)
    if (!notes.ok) return { error: `its notes: ${notes.error}` }
    const list: any[] = (Array.isArray(notes.body) ? notes.body : []).slice().reverse()
    return { state, url, labels, ...closer, ...plan, notes: list.map((n) => String(n?.body ?? "")), noteTimes: list.map((n) => timeOf(n?.created_at)) }
  }
}
