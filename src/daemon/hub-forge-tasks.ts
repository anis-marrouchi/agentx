import { execFile } from "child_process"
import type { DaemonConfig } from "./config"
import { forgeCache, isForgeError, type ForgeAnswer, type ForgeCacheOptions } from "./wall-forge-cache"

// --- The Hub's Tasks: open issues and PRs on the forges (#2226) ---
//
// GET /api/admin/hub/tasks lists the open issues and open pull (merge)
// requests of the repositories this node works on: the GitHub repos and
// GitLab projects named in `channels.github.routes`, `channels.gitlab.routes`
// and the GitLab boards. No new credential: GitHub is read with the `gh`
// login of the user running AgentX, GitLab with the GitLab channel's token.
// Read only, cached for a minute (the Hub asks every 30 s), one time-boxed
// read per project (wall-forge-cache.ts). A project that cannot be read is
// named in `unread`, with why; its last good answer is kept meanwhile.

export type Forge = "github" | "gitlab"
export interface ForgeSource { forge: Forge; project: string }

export interface ForgeTask {
  /** "github:owner/repo#12", "gitlab:group/project!4". */
  id: string
  forge: Forge
  kind: "issue" | "pr"
  project: string
  number: number
  title: string
  url: string
  author: string | null
  assignees: string[]
  labels: string[]
  updatedAt: number
  /** Pull requests: a draft. */
  draft?: boolean
  /** GitHub pull requests: the review decision, lower case ("approved", "changes_requested", "review_required"). */
  review?: string | null
}

export interface ForgeTasksReply {
  items: ForgeTask[]
  /** Projects not read this time, and why; `late`: the read is still going. */
  unread: Array<ForgeSource & { why: string; late?: true }>
  /** A read is still going: ask again soon. */
  pending?: true
}

export type ForgeTasksReader = (source: ForgeSource) => Promise<ForgeAnswer<ForgeTask[]>>

/** Items read per kind and project: the most recently updated. */
export const PER_KIND = 50
const TIMEOUT_MS = 10_000
const TITLE_MAX = 300
export const FORGE_TASKS_TTL_MS = 60_000

/** The projects Tasks lists, once each, in config order. */
export function forgeTaskSources(config: Pick<DaemonConfig, "channels"> & { boards?: DaemonConfig["boards"] }): ForgeSource[] {
  const out = new Map<string, ForgeSource>()
  const add = (forge: Forge, project: string | undefined) => {
    const p = project?.trim()
    if (p && p !== "*" && p.includes("/")) out.set(`${forge}:${p}`, { forge, project: p })
  }
  if (config.channels?.github?.enabled !== false) for (const r of config.channels?.github?.routes ?? []) add("github", r.repo)
  if (config.channels?.gitlab?.enabled !== false) {
    for (const r of config.channels?.gitlab?.routes ?? []) add("gitlab", r.project)
    for (const b of config.boards ?? []) if (b.source.type === "gitlab") for (const p of b.source.projects) add("gitlab", p)
  }
  return [...out.values()]
}

const httpLink = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : null)
const when = (v: unknown) => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? t : 0 }
const names = (list: unknown, key: string): string[] =>
  Array.isArray(list) ? list.map((x: any) => (typeof x === "string" ? x : x?.[key])).filter((x): x is string => typeof x === "string" && !!x) : []

/** Runs `gh` with these arguments and gives its stdout; rejects on failure. */
export type GhRun = (args: string[]) => Promise<string>

export const ghRun: GhRun = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().split("\n")[0] || "gh failed"))
    else resolve(stdout)
  })
})

/** GitHub through the `gh` CLI's login: open issues, then open pull requests. */
export function githubTasksReader(run: GhRun = ghRun): (project: string) => Promise<ForgeAnswer<ForgeTask[]>> {
  return async (project) => {
    const list = async (what: "issue" | "pr") => {
      const fields = what === "issue"
        ? "number,title,url,author,assignees,labels,updatedAt"
        : "number,title,url,author,assignees,labels,updatedAt,isDraft,reviewDecision"
      const raw = await run([what, "list", "--repo", project, "--state", "open", "--limit", String(PER_KIND), "--json", fields])
      const body = JSON.parse(raw)
      if (!Array.isArray(body)) throw new Error("no list in the answer")
      return body.flatMap((x: any): ForgeTask[] => {
        const n = Number(x?.number)
        const url = httpLink(x?.url)
        if (!Number.isInteger(n) || !url) return []
        return [{
          id: `github:${project}#${n}`, forge: "github", kind: what, project, number: n,
          title: String(x.title ?? "").slice(0, TITLE_MAX), url,
          author: typeof x.author?.login === "string" ? x.author.login : null,
          assignees: names(x.assignees, "login"), labels: names(x.labels, "name"), updatedAt: when(x.updatedAt),
          ...(what === "pr" ? { draft: !!x.isDraft, review: x.reviewDecision ? String(x.reviewDecision).toLowerCase() : null } : {}),
        }]
      })
    }
    try {
      return [...await list("issue"), ...await list("pr")]
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 160) }
    }
  }
}

/** GitLab over its REST API with the GitLab channel's token: open issues, then open merge requests. */
export function gitlabTasksReader(gitlab: { url: string; token?: string }, doFetch: typeof fetch = fetch): (project: string) => Promise<ForgeAnswer<ForgeTask[]>> {
  const base = gitlab.url.replace(/\/$/, "")
  const headers: Record<string, string> = gitlab.token ? { "PRIVATE-TOKEN": gitlab.token } : {}
  return async (project) => {
    const list = async (what: "issues" | "merge_requests") => {
      const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/${what}?state=opened&order_by=updated_at&sort=desc&per_page=${PER_KIND}`
      let res: Response
      try {
        res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (e: any) {
        throw new Error(`could not be reached: ${String(e?.message ?? e).slice(0, 120)}`)
      }
      if (!res.ok) throw new Error(res.status === 404 ? "not found (or not visible to the token)" : `HTTP ${res.status}`)
      const body: any = await res.json().catch(() => null)
      if (!Array.isArray(body)) throw new Error("no list in the answer")
      const kind = what === "issues" ? "issue" : "pr"
      return body.flatMap((x: any): ForgeTask[] => {
        const n = Number(x?.iid)
        const link = httpLink(x?.web_url)
        if (!Number.isInteger(n) || !link) return []
        return [{
          id: `gitlab:${project}${kind === "issue" ? "#" : "!"}${n}`, forge: "gitlab", kind, project, number: n,
          title: String(x.title ?? "").slice(0, TITLE_MAX), url: link,
          author: typeof x.author?.username === "string" ? x.author.username : null,
          assignees: names(x.assignees, "username"), labels: names(x.labels, "name"), updatedAt: when(x.updated_at),
          ...(kind === "pr" ? { draft: !!(x.draft ?? x.work_in_progress) } : {}),
        }]
      })
    }
    try {
      return [...await list("issues"), ...await list("merge_requests")]
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 160) }
    }
  }
}

/** One reader for both forges; a forge this node has no access to says so. */
export function forgeTasksReader(config: Pick<DaemonConfig, "channels">, run: GhRun = ghRun, doFetch: typeof fetch = fetch): ForgeTasksReader {
  const github = githubTasksReader(run)
  const gl = config.channels?.gitlab
  const gitlab = gl?.host ? gitlabTasksReader({ url: gl.host, token: gl.token }, doFetch) : null
  return async (s) => s.forge === "github" ? github(s.project)
    : gitlab ? gitlab(s.project) : { error: "no GitLab channel on this computer" }
}

export interface ForgeTasksSource {
  read(): Promise<ForgeTasksReply>
  busy(): boolean
}

/** The cached, time-boxed list. A project whose read is late this time
 *  shows its last good answer. */
export function forgeTasks(sources: ForgeSource[], read: ForgeTasksReader, opts: ForgeCacheOptions = {}): ForgeTasksSource {
  const cache = forgeCache<ForgeSource, ForgeTask[]>(read, { okTtlMs: FORGE_TASKS_TTL_MS, ...opts })
  const lastGood = new Map<string, ForgeTask[]>()
  return {
    busy: cache.busy,
    async read() {
      const refs = new Map(sources.map((s) => [`${s.forge}:${s.project}`, s] as const))
      const reads = await cache.readAll(refs)
      const items: ForgeTask[] = []
      const unread: ForgeTasksReply["unread"] = []
      for (const [key, s] of refs) {
        const got = reads.get(key)
        if (got?.kind === "answer" && !isForgeError(got.answer)) {
          lastGood.set(key, got.answer)
          items.push(...got.answer)
          continue
        }
        if (got?.kind === "answer" && isForgeError(got.answer)) unread.push({ forge: s.forge, project: s.project, why: got.answer.error })
        else unread.push({ forge: s.forge, project: s.project, why: "still being read", late: true })
        items.push(...(lastGood.get(key) ?? []))
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      return { items, unread, ...(cache.busy() ? { pending: true as const } : {}) }
    },
  }
}
