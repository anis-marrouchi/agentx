/**
 * Live reads for `wiki query` (#855): before the answer, read the current
 * state of what the picked pages name (an issue, a merge request, the
 * newest release, the AgentX version on each node) from the system that
 * owns it.
 *
 * Read-only by construction. A model only *names* reads, as JSON. Each one
 * is checked here against the configured sources (the repository must be
 * on the source's list, an id must be a number, search words are cut and
 * URL-encoded) and anything else is dropped. The code then builds one HTTP
 * GET per read against the source's own host. No shell, no CLI, no tool is
 * given to a model. A source's token is sent only to that source's API,
 * and redirects are refused so it cannot be carried anywhere else.
 */

export interface GitSource {
  kind: "github" | "gitlab"
  /** How the planner and the answer name this source. */
  name: string
  /** Web host, e.g. github.com or gitlab.example.com. */
  host: string
  /** API base. Default https://api.github.com for github.com, else
   *  https://<host>/api/v3 (GitHub Enterprise) or https://<host>/api/v4. */
  apiUrl?: string
  /** Repositories (owner/name, or group/subgroup/project) that may be read. */
  repos: string[]
  /** Environment variable that holds the token. Unset: read without one. */
  tokenEnv?: string
}

export interface AgentxSource {
  kind: "agentx"
  name: string
  /** Also ask each mesh peer, not only this node. */
  peers: boolean
}

export type LiveSource = GitSource | AgentxSource

/** A node the `agentx` source asks for its version. */
export interface AgentxNode {
  name: string
  url: string
  token?: string
}

export type LiveRead =
  | { source: string; kind: "issue"; repo: string; id: number }
  | { source: string; kind: "merge_request"; repo: string; id: number }
  | { source: string; kind: "search"; repo: string; query: string }
  | { source: string; kind: "releases"; repo: string }
  | { source: string; kind: "version" }

/** One line of the live read, as the answer sees it. */
export interface LiveLine {
  /** `live 1`, `live 2`… as the answer cites it. */
  label: string
  source: string
  kind: LiveRead["kind"]
  text: string
  /** Where a person can check it: the web page, or the node's URL. */
  url: string
}

export const LIVE_READ_KINDS = ["issue", "merge_request", "search", "releases", "version"] as const
const SEARCH_CHARS = 80
const SEARCH_RESULTS = 5
const RELEASES = 3
const TITLE_CHARS = 140

const REPO_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/

/** What the planner is told it may read. */
export function describeSources(sources: LiveSource[]): string {
  return sources.map((s) => {
    if (s.kind === "agentx") {
      return `- source "${s.name}" (agentx): kind "version" — the AgentX version and uptime on ${s.peers ? "this node and each mesh peer" : "this node"}.`
    }
    const mr = s.kind === "github" ? "pull request" : "merge request"
    return `- source "${s.name}" (${s.kind}, ${s.host}), repositories: ${s.repos.join(", ")}. Kinds: "issue" (repo, id), "merge_request" (repo, id: a ${mr}), "search" (repo, query: issues and ${mr}s matching a few words), "releases" (repo: newest releases or tags).`
  }).join("\n")
}

/**
 * Keep the reads that a configured source allows, at most `max`, without
 * duplicates. Anything else in the model's reply is dropped.
 */
export function validateReads(raw: unknown, sources: LiveSource[], max: number): LiveRead[] {
  if (!Array.isArray(raw)) return []
  const out: LiveRead[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= max) break
    const read = validateRead(item, sources)
    if (!read) continue
    const key = JSON.stringify(read).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(read)
  }
  return out
}

function validateRead(item: unknown, sources: LiveSource[]): LiveRead | null {
  if (!item || typeof item !== "object") return null
  const r = item as Record<string, unknown>
  const source = sources.find((s) => s.name === r.source)
  if (!source || typeof r.kind !== "string") return null
  if (source.kind === "agentx") return r.kind === "version" ? { source: source.name, kind: "version" } : null

  const repo = typeof r.repo === "string" ? r.repo.trim().replace(/^\/+|\/+$/g, "") : ""
  if (!REPO_RE.test(repo)) return null
  const allowed = source.repos.find((x) => x.toLowerCase() === repo.toLowerCase())
  if (!allowed) return null
  switch (r.kind) {
    case "issue":
    case "merge_request": {
      const id = typeof r.id === "number" ? r.id : typeof r.id === "string" && /^\d+$/.test(r.id) ? Number(r.id) : NaN
      if (!Number.isSafeInteger(id) || id < 1) return null
      return { source: source.name, kind: r.kind, repo: allowed, id }
    }
    case "search": {
      const query = cleanSearch(r.query)
      return query ? { source: source.name, kind: "search", repo: allowed, query } : null
    }
    case "releases":
      return { source: source.name, kind: "releases", repo: allowed }
    default:
      return null
  }
}

/** Search words only: letters, digits, spaces and a few joiners, cut short. */
export function cleanSearch(q: unknown): string {
  if (typeof q !== "string") return ""
  return q.replace(/[^\p{L}\p{N} ._#-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_CHARS).trim()
}

export function apiBase(s: GitSource): string {
  if (s.apiUrl) return s.apiUrl.replace(/\/+$/, "")
  if (s.kind === "github") return s.host === "github.com" ? "https://api.github.com" : `https://${s.host}/api/v3`
  return `https://${s.host}/api/v4`
}

/** The one GET a git read makes: URL and the page a person would open. */
export function gitRequest(read: Exclude<LiveRead, { kind: "version" }>, s: GitSource): { api: string; web: string } {
  const api = apiBase(s)
  const web = `https://${s.host}/${read.repo}`
  if (s.kind === "github") {
    const repo = read.repo.split("/").map(encodeURIComponent).join("/")
    switch (read.kind) {
      case "issue": return { api: `${api}/repos/${repo}/issues/${read.id}`, web: `${web}/issues/${read.id}` }
      case "merge_request": return { api: `${api}/repos/${repo}/pulls/${read.id}`, web: `${web}/pull/${read.id}` }
      case "search": {
        const q = encodeURIComponent(`repo:${read.repo} ${read.query}`)
        return { api: `${api}/search/issues?q=${q}&sort=updated&order=desc&per_page=${SEARCH_RESULTS}`, web: `${web}/issues?q=${encodeURIComponent(read.query)}` }
      }
      case "releases": return { api: `${api}/repos/${repo}/releases?per_page=${RELEASES}`, web: `${web}/releases` }
    }
  }
  const project = encodeURIComponent(read.repo)
  switch (read.kind) {
    case "issue": return { api: `${api}/projects/${project}/issues/${read.id}`, web: `${web}/-/issues/${read.id}` }
    case "merge_request": return { api: `${api}/projects/${project}/merge_requests/${read.id}`, web: `${web}/-/merge_requests/${read.id}` }
    case "search": {
      const q = encodeURIComponent(read.query)
      return { api: `${api}/projects/${project}/issues?search=${q}&order_by=updated_at&per_page=${SEARCH_RESULTS}`, web: `${web}/-/issues?search=${q}` }
    }
    case "releases": return { api: `${api}/projects/${project}/releases?per_page=${RELEASES}`, web: `${web}/-/releases` }
  }
}

export interface RunLiveOptions {
  /** Each read's timeout, ms. */
  timeoutMs: number
  /** Nodes the `agentx` source asks: this node first, then its peers. */
  nodes?: AgentxNode[]
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
}

/**
 * Run the reads in parallel. A read that fails or times out is left out:
 * the answer is still given from the pages.
 */
export async function runLiveReads(reads: LiveRead[], sources: LiveSource[], opts: RunLiveOptions): Promise<LiveLine[]> {
  const doFetch = opts.fetch ?? fetch
  const env = opts.env ?? process.env
  const get = async (url: string, headers: Record<string, string>): Promise<any> => {
    const res = await doFetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  const settled = await Promise.all(reads.map(async (read): Promise<Array<Omit<LiveLine, "label">>> => {
    const source = sources.find((s) => s.name === read.source)
    if (!source) return []
    try {
      if (read.kind === "version") {
        if (source.kind !== "agentx") return []
        const nodes = (opts.nodes ?? []).slice(0, source.peers ? undefined : 1)
        const lines = await Promise.all(nodes.map(async (n) => {
          try {
            const body = await get(`${n.url.replace(/\/+$/, "")}/health`, n.token ? { Authorization: `Bearer ${n.token}` } : {})
            return [{ source: source.name, kind: read.kind, text: versionLine(n.name, body), url: n.url }]
          } catch {
            return []
          }
        }))
        return lines.flat()
      }
      if (source.kind === "agentx") return []
      const { api, web } = gitRequest(read, source)
      const token = source.tokenEnv ? env[source.tokenEnv] : undefined
      const headers: Record<string, string> = { "User-Agent": "agentx-wiki-query", Accept: "application/json" }
      if (token) {
        if (source.kind === "github") headers.Authorization = `Bearer ${token}`
        else headers["PRIVATE-TOKEN"] = token
      }
      let body = await get(api, headers)
      // A repository that publishes tags but no releases.
      if (read.kind === "releases" && Array.isArray(body) && body.length === 0) {
        const tags = source.kind === "github"
          ? `${apiBase(source)}/repos/${read.repo.split("/").map(encodeURIComponent).join("/")}/tags?per_page=${RELEASES}`
          : `${apiBase(source)}/projects/${encodeURIComponent(read.repo)}/repository/tags?per_page=${RELEASES}`
        body = { tags: await get(tags, headers) }
      }
      const text = gitLine(read, source, body)
      return text ? [{ source: source.name, kind: read.kind, text, url: web }] : []
    } catch {
      return []
    }
  }))
  return settled.flat().map((l, i) => ({ label: `live ${i + 1}`, ...l }))
}

function clip(s: unknown, n = TITLE_CHARS): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

function day(s: unknown): string {
  return typeof s === "string" && s ? s.slice(0, 10) : ""
}

function versionLine(node: string, h: any): string {
  const up = typeof h?.uptime === "number" ? `, up ${formatUptime(h.uptime)}` : ""
  const commit = h?.commit ? ` (${String(h.commit).slice(0, 10)})` : ""
  return `AgentX on ${h?.node?.name || node}: version ${h?.version ?? "unknown"}${commit}${up}, status ${h?.status ?? "unknown"}`
}

function formatUptime(s: number): string {
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d`
  if (s >= 3600) return `${Math.floor(s / 3600)}h`
  return `${Math.max(0, Math.floor(s / 60))}m`
}

/** One line of facts from a git API reply, or "" when it holds none. */
export function gitLine(read: Exclude<LiveRead, { kind: "version" }>, s: GitSource, b: any): string {
  const gh = s.kind === "github"
  const at = (label: string, v: unknown) => (day(v) ? `${label} ${day(v)}` : "")
  const join = (...parts: string[]) => parts.filter(Boolean).join(", ")
  switch (read.kind) {
    case "issue": {
      if (!b || typeof b !== "object" || !b.title) return ""
      const state = gh ? (b.state === "closed" ? `closed${b.state_reason ? ` (${b.state_reason})` : ""}` : "open") : b.state === "closed" ? "closed" : "open"
      const labels = (b.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean).slice(0, 6)
      return `${read.repo}#${read.id} "${clip(b.title)}": ${join(state, at("closed", b.closed_at), at("updated", b.updated_at), labels.length ? `labels ${labels.join(" ")}` : "")}`
    }
    case "merge_request": {
      if (!b || typeof b !== "object" || !b.title) return ""
      const merged = gh ? !!b.merged || !!b.merged_at : b.state === "merged"
      const state = merged ? "merged" : b.state === "closed" ? "closed without merging" : `open${b.draft ? " (draft)" : ""}`
      const name = gh ? `${read.repo} pull request #${read.id}` : `${read.repo}!${read.id}`
      return `${name} "${clip(b.title)}": ${join(state, at("merged", b.merged_at), at("updated", b.updated_at))}`
    }
    case "search": {
      const items: any[] = gh ? b?.items ?? [] : Array.isArray(b) ? b : []
      if (items.length === 0) return `${read.repo}, search "${read.query}": nothing found`
      const rows = items.slice(0, SEARCH_RESULTS).map((x) => {
        const id = gh ? x.number : x.iid
        const kind = gh && x.pull_request ? "PR " : ""
        return `${kind}#${id} "${clip(x.title, 80)}" ${x.state}${day(x.updated_at) ? ` ${day(x.updated_at)}` : ""}`
      })
      return `${read.repo}, search "${read.query}": ${rows.join("; ")}`
    }
    case "releases": {
      if (b && Array.isArray(b.tags)) {
        const tags = b.tags.slice(0, RELEASES).map((t: any) => t?.name).filter(Boolean)
        return tags.length ? `${read.repo} newest tags (no releases): ${tags.join(", ")}` : ""
      }
      const rows = (Array.isArray(b) ? b : []).slice(0, RELEASES).map((r: any) => {
        const tag = r.tag_name ?? r.name
        const when = day(gh ? r.published_at ?? r.created_at : r.released_at ?? r.created_at)
        return `${tag}${when ? ` ${when}` : ""}${r.prerelease ? " (pre-release)" : ""}${r.draft ? " (draft)" : ""}`
      })
      return rows.length ? `${read.repo} newest releases: ${rows.join(", ")}` : ""
    }
  }
}
