import type { ForgeConnectors } from "../checkers/issue"
import type { Provider } from "./refs"

// --- What status drift reads on the forges (#1138 step F) ---
//
// Read only: the merge requests merged since a date, and whether a merge
// commit is in a running commit. An issue's state and labels are read by
// the issue checker's reader (checkers/issue.ts), not here. Writing a
// label back goes through the backlog sync-back (business/backlog-sync.ts).

export interface MergedChange {
  /** "group/project!12" or "owner/repo#12". */
  ref: string
  url: string
  title: string
  description: string
  branch: string
  /** The commit the merge put on the target branch: the merge commit,
   *  or the squashed or fast-forwarded one. Null: the forge did not say. */
  commit: string | null
  mergedAt: number
}

export interface DriftForge {
  /** Merged since `since`, newest first. */
  merged(provider: Provider, project: string, since: number): Promise<MergedChange[] | { error: string }>
  /** Is `commit` in `live` (the same commit, or an ancestor)? Null: the
   *  forge could not say (an unknown commit, a forge that is down). */
  contains(provider: Provider, project: string, commit: string, live: string): Promise<boolean | null>
}

const TIMEOUT_MS = 15_000
/** Pages of 100 read per project and check. */
const MAX_PAGES = 3

export function driftForge(connectors: ForgeConnectors, doFetch: typeof fetch = fetch): DriftForge {
  const get = async (url: string, headers: Record<string, string>): Promise<{ ok: true; body: any } | { ok: false; status?: number; error: string }> => {
    let res: Response
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { ok: false, error: `could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
    }
    if (!res.ok) return { ok: false, status: res.status, error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    return { ok: true, body: await res.json().catch(() => null) }
  }
  const github = () => {
    const c = connectors.github
    if (!c) return null
    return {
      api: c.apiUrl.replace(/\/$/, ""),
      headers: { Accept: "application/vnd.github+json", ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) } as Record<string, string>,
    }
  }
  const gitlab = (project: string) => {
    const c = connectors.gitlab
    if (!c) return null
    return {
      base: `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(project)}`,
      headers: (c.token ? { "PRIVATE-TOKEN": c.token } : {}) as Record<string, string>,
    }
  }

  // Only merges into the default branch close issues and get deployed: a
  // stacked change, a release branch or a backport is not the work landing.
  // Null when it cannot be read: then nothing is left out.
  const defaultBranch = async (projectUrl: string, headers: Record<string, string>): Promise<string | null> => {
    const r = await get(projectUrl, headers)
    return r.ok && typeof r.body?.default_branch === "string" && r.body.default_branch ? r.body.default_branch : null
  }

  return {
    async merged(provider, project, since) {
      const out: MergedChange[] = []
      if (provider === "gitlab") {
        const gl = gitlab(project)
        if (!gl) return { error: "no gitlab connector on this node" }
        const after = encodeURIComponent(new Date(since).toISOString())
        const main = await defaultBranch(`${gl.base}`, gl.headers)
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = await get(`${gl.base}/merge_requests?state=merged&updated_after=${after}&order_by=updated_at&sort=desc&per_page=100&page=${page}`, gl.headers)
          if (!r.ok) return { error: r.error }
          const rows: any[] = Array.isArray(r.body) ? r.body : []
          for (const m of rows) {
            const mergedAt = Date.parse(m?.merged_at ?? "")
            if (!(mergedAt >= since)) continue
            if (main && m?.target_branch !== main) continue
            out.push({
              ref: `${project}!${m.iid}`,
              url: String(m.web_url ?? ""),
              title: String(m.title ?? ""),
              description: String(m.description ?? ""),
              branch: String(m.source_branch ?? ""),
              commit: m.merge_commit_sha || m.squash_commit_sha || m.sha || null,
              mergedAt,
            })
          }
          if (rows.length < 100) break
        }
      } else {
        const gh = github()
        if (!gh) return { error: "no github connector on this node" }
        const main = await defaultBranch(`${gh.api}/repos/${project}`, gh.headers)
        pages: for (let page = 1; page <= MAX_PAGES; page++) {
          const r = await get(`${gh.api}/repos/${project}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, gh.headers)
          if (!r.ok) return { error: r.error }
          const rows: any[] = Array.isArray(r.body) ? r.body : []
          for (const p of rows) {
            // Sorted by update: past the window, nothing older was merged in it.
            if (Date.parse(p?.updated_at ?? "") < since) break pages
            const mergedAt = Date.parse(p?.merged_at ?? "")
            if (!(mergedAt >= since)) continue
            if (main && p?.base?.ref !== main) continue
            out.push({
              ref: `${project}#${p.number}`,
              url: String(p.html_url ?? ""),
              title: String(p.title ?? ""),
              description: String(p.body ?? ""),
              branch: String(p.head?.ref ?? ""),
              commit: p.merge_commit_sha || null,
              mergedAt,
            })
          }
          if (rows.length < 100) break
        }
      }
      return out.sort((a, b) => b.mergedAt - a.mergedAt)
    },

    async contains(provider, project, commit, live) {
      if (sameCommit(commit, live)) return true
      if (provider === "gitlab") {
        const gl = gitlab(project)
        if (!gl) return null
        // The merge base of the two is the merge commit itself when it
        // is in the running one.
        const r = await get(`${gl.base}/repository/merge_base?refs[]=${encodeURIComponent(commit)}&refs[]=${encodeURIComponent(live)}`, gl.headers)
        if (!r.ok || typeof r.body?.id !== "string") return null
        return sameCommit(r.body.id, commit)
      }
      const gh = github()
      if (!gh) return null
      const r = await get(`${gh.api}/repos/${project}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(live)}`, gh.headers)
      if (!r.ok) return null
      const status = r.body?.status
      if (status === "ahead" || status === "identical") return true
      if (status === "behind" || status === "diverged") return false
      return null
    },
  }
}

/** Two hashes, one maybe short, are the same commit. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))
}
