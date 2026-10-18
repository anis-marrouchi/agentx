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
  url: string
}

/** Reads one item, or says why it could not (unknown, not visible, down). */
export type ForgeReader = (provider: "github" | "gitlab", ref: ParsedRef, opts: { notes: boolean }) => Promise<ForgeItem | { error: string }>

export interface ParsedRef { project: string; number: number; mr: boolean }

const PATTERN_MAX = 200
const NOTE_MAX = 10_000
const TIMEOUT_MS = 10_000
const STATES: readonly IssueState[] = ["open", "closed", "merged"]

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** "owner/repo#12", "group/sub/project!3", or a web address. */
export function parseRef(provider: "github" | "gitlab", ref: string): ParsedRef | null {
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

export function parseIssueSpec(raw: Record<string, unknown>): IssueSpec | string {
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
  if (notePattern) {
    try { new RegExp(notePattern, "i") } catch { return "notePattern is not a valid regular expression" }
  }
  return { kind: "issue", provider, ref, ...(state ? { state: state as IssueState } : {}), ...(notePattern ? { notePattern } : {}) }
}

/** A closed check is met by a merged one too: merged is closed. */
const stateMatches = (want: IssueState, have: IssueState) => want === have || (want === "closed" && have === "merged")

export async function checkIssue(spec: IssueSpec, ctx: Pick<CheckContext, "forge">): Promise<CheckResult> {
  if (!ctx.forge) return { verdict: "unverifiable", detail: `no ${spec.provider} connector on this node` }
  const ref = parseRef(spec.provider, spec.ref)
  if (!ref) return { verdict: "unverifiable", detail: `${spec.ref} is not an issue reference` }
  const item = await ctx.forge(spec.provider, ref, { notes: !!spec.notePattern })
  if ("error" in item) return { verdict: "unverifiable", detail: `${spec.ref}: ${item.error}` }
  // No state and no pattern: closed is what finished means.
  const want = spec.state ?? (spec.notePattern ? null : "closed")
  if (want && stateMatches(want, item.state)) return { verdict: "met", detail: `${item.url} is ${item.state}` }
  if (spec.notePattern) {
    const re = new RegExp(spec.notePattern, "i")
    if ((item.notes ?? []).some((n) => re.test(n.slice(0, NOTE_MAX)))) return { verdict: "met", detail: `${item.url} has a note matching /${spec.notePattern}/` }
  }
  return { verdict: "not_met", detail: `${item.url} is ${item.state}${spec.notePattern ? `, no note matches /${spec.notePattern}/` : ""}` }
}

export interface ForgeConnectors {
  github?: { apiUrl: string; token?: string }
  gitlab?: { url: string; token?: string }
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
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) }
      const base = `${api}/repos/${ref.project}`
      const issue = await get(`${base}/issues/${ref.number}`, headers)
      if (!issue.ok) return { error: issue.error }
      let state: IssueState = issue.body?.state === "closed" ? "closed" : "open"
      if (issue.body?.pull_request && state === "closed") {
        const pr = await get(`${base}/pulls/${ref.number}`, headers)
        if (pr.ok && pr.body?.merged) state = "merged"
      }
      const url = String(issue.body?.html_url ?? `${ref.project}#${ref.number}`)
      if (!opts.notes) return { state, url }
      const notes = await get(`${base}/issues/${ref.number}/comments?per_page=100`, headers)
      if (!notes.ok) return { error: `its notes: ${notes.error}` }
      return { state, url, notes: (Array.isArray(notes.body) ? notes.body : []).map((n: any) => String(n?.body ?? "")) }
    }
    const c = connectors.gitlab
    if (!c) return { error: "no gitlab connector on this node (channels.gitlab or requests.checkers.gitlab)" }
    const headers: Record<string, string> = c.token ? { "PRIVATE-TOKEN": c.token } : {}
    const base = `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(ref.project)}/${ref.mr ? "merge_requests" : "issues"}/${ref.number}`
    const item = await get(base, headers)
    if (!item.ok) return { error: item.error }
    const raw = String(item.body?.state ?? "")
    const state: IssueState = raw === "merged" ? "merged" : raw === "closed" ? "closed" : "open"
    const url = String(item.body?.web_url ?? `${ref.project}${ref.mr ? "!" : "#"}${ref.number}`)
    if (!opts.notes) return { state, url }
    const notes = await get(`${base}/notes?per_page=100&sort=desc&order_by=created_at`, headers)
    if (!notes.ok) return { error: `its notes: ${notes.error}` }
    return { state, url, notes: (Array.isArray(notes.body) ? notes.body : []).map((n: any) => String(n?.body ?? "")).reverse() }
  }
}
