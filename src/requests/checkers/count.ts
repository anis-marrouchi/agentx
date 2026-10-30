import type { CheckResult } from "./index"
import { forgeHeaders, type ForgeConnectors } from "./issue"

// --- count: how many issues or pull requests a project has open (#1568) ---
//
// A plan step can carry a count check ("open issues in owner/repo = 0").
// The plan check reads the count through the GitHub or GitLab connector,
// marks the step done when it is at or under `max`, and keeps the last
// count so a turn that brought it down counts as progress. One read per
// kind: GitHub's search total, GitLab's X-Total header.

export type CountWhat = "issues" | "prs" | "all"

export interface CountSpec {
  provider: "github" | "gitlab"
  /** "owner/repo" on GitHub, "group/project" on GitLab. */
  project: string
  what: CountWhat
  /** Done at this count or under. */
  max: number
}

/** Reads one open count, or says why it could not. */
export type ForgeCounter = (provider: "github" | "gitlab", project: string, kind: "issues" | "prs") => Promise<number | { error: string }>

const TIMEOUT_MS = 10_000
const WHATS: readonly CountWhat[] = ["issues", "prs", "all"]
const PROJECT_RE = /^[\w.-]+(?:\/[\w.-]+)+$/

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function parseCountSpec(raw: Record<string, unknown>): CountSpec | string {
  const provider = str(raw.provider).toLowerCase()
  if (provider !== "github" && provider !== "gitlab") return "count.provider must be github or gitlab"
  const project = str(raw.project)
  const parts = project.split("/")
  if (!PROJECT_RE.test(project) || parts.some((p) => p === "." || p === "..") || (provider === "github" && parts.length !== 2)) {
    return provider === "github" ? 'count.project must be "owner/repo"' : 'count.project must be "group/project"'
  }
  const what = (str(raw.what) || "issues").toLowerCase()
  if (!(WHATS as readonly string[]).includes(what)) return `count.what must be one of ${WHATS.join(", ")}`
  const max = raw.max === undefined || raw.max === null || raw.max === "" ? 0 : Number(raw.max)
  if (!Number.isInteger(max) || max < 0) return "count.max must be a whole number, 0 or more"
  return { provider, project, what: what as CountWhat, max }
}

/** A stored spec read back. Null when it is not one. */
export function readCountSpec(json: string | null | undefined): CountSpec | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== "object") return null
    const spec = parseCountSpec(v)
    return typeof spec === "string" ? null : spec
  } catch {
    return null
  }
}

const whatWords = (w: CountWhat) => (w === "issues" ? "open issues" : w === "prs" ? "open pull requests" : "open issues and pull requests")

export function describeCount(spec: CountSpec): string {
  return `${whatWords(spec.what)} in ${spec.provider} ${spec.project} ≤ ${spec.max}`
}

/** The count now, and whether it is at or under max. Never throws. */
export async function checkCount(spec: CountSpec, counter: ForgeCounter | undefined): Promise<CheckResult & { count?: number }> {
  if (!counter) return { verdict: "unverifiable", detail: `no ${spec.provider} connector on this node` }
  try {
    const kinds: Array<"issues" | "prs"> = spec.what === "all" ? ["issues", "prs"] : [spec.what]
    let count = 0
    for (const kind of kinds) {
      const n = await counter(spec.provider, spec.project, kind)
      if (typeof n !== "number") return { verdict: "unverifiable", detail: `${spec.project}: ${n.error}` }
      count += n
    }
    const detail = `${count} ${whatWords(spec.what)} in ${spec.project}`
    return { verdict: count <= spec.max ? "met" : "not_met", detail, count }
  } catch (e: any) {
    return { verdict: "unverifiable", detail: `the count check failed: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** The counter over the REST APIs of GitHub and GitLab. */
export function forgeCounter(connectors: ForgeConnectors, doFetch: typeof fetch = fetch): ForgeCounter {
  return async (provider, project, kind) => {
    let url: string
    if (provider === "github") {
      const c = connectors.github
      if (!c) return { error: "no github connector on this node (channels.github or requests.checkers.github)" }
      const q = encodeURIComponent(`repo:${project} is:open is:${kind === "prs" ? "pr" : "issue"}`)
      url = `${c.apiUrl.replace(/\/$/, "")}/search/issues?q=${q}&per_page=1`
    } else {
      const c = connectors.gitlab
      if (!c) return { error: "no gitlab connector on this node (channels.gitlab or requests.checkers.gitlab)" }
      url = `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(project)}/${kind === "prs" ? "merge_requests" : "issues"}?state=opened&per_page=1`
    }
    let res: Response
    try {
      res = await doFetch(url, { headers: forgeHeaders(provider, connectors), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { error: `could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
    }
    if (!res.ok) return { error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    if (provider === "gitlab") {
      const total = Number(res.headers.get("x-total"))
      return Number.isInteger(total) && total >= 0 ? total : { error: "no X-Total in the answer" }
    }
    const body: any = await res.json().catch(() => null)
    const total = Number(body?.total_count)
    return Number.isInteger(total) && total >= 0 ? total : { error: "no total_count in the answer" }
  }
}
