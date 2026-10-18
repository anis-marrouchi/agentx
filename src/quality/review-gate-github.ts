import { markBody } from "@/channels/outbound-marker"
import { REVIEW_STATUS_CONTEXT, type CiCheck, type ReviewGateGitHub } from "./review-gate"

// --- GitHub REST calls for the review gate (#990) ---
//
// The token comes from the GitHub channel (App installation token, else the
// PAT), per repository. The commit status needs `statuses: write` on the
// App, or `repo:status` on a classic PAT.

const API = "https://api.github.com"

export function createReviewGateGitHub(
  tokenFor: (repo: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ReviewGateGitHub {
  const call = async (repo: string, path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> => {
    const token = await tokenFor(repo)
    if (!token) throw new Error(`no GitHub token for ${repo}`)
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AgentX",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status}`)
    return res
  }
  const json = async (repo: string, path: string): Promise<any> => (await call(repo, path)).json()

  return {
    async getPullRequest(repo, number) {
      const pr = await json(repo, `/repos/${repo}/pulls/${number}`)
      return {
        number: pr.number,
        headSha: pr.head?.sha,
        title: pr.title ?? "",
        body: pr.body ?? "",
        authorLogin: pr.user?.login ?? "",
        draft: !!pr.draft,
        state: pr.state ?? "open",
      }
    },

    async getDiff(repo, number) {
      return (await call(repo, `/repos/${repo}/pulls/${number}`, { accept: "application/vnd.github.diff" })).text()
    },

    async getChangedFiles(repo, number) {
      const files: string[] = []
      for (let page = 1; page <= 30; page++) {
        const rows = await json(repo, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`) as any[]
        files.push(...rows.map((f) => f.filename))
        if (rows.length < 100) break
      }
      return files
    },

    async getIssue(repo, number) {
      try {
        const i = await json(repo, `/repos/${repo}/issues/${number}`)
        return { repo, number, title: i.title ?? "", body: i.body ?? "", isPullRequest: !!i.pull_request }
      } catch (e: any) {
        if (/: 404$|: 410$/.test(e?.message || "")) return null
        throw e
      }
    },

    async getChecks(repo, sha) {
      const out: CiCheck[] = []
      const runs = await json(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)
      for (const r of runs.check_runs ?? []) {
        out.push({ name: r.name, state: r.status === "completed" ? (r.conclusion ?? "neutral") : "pending" })
      }
      const combined = await json(repo, `/repos/${repo}/commits/${sha}/status?per_page=100`)
      for (const s of combined.statuses ?? []) {
        if (s.context === REVIEW_STATUS_CONTEXT) continue
        out.push({ name: s.context, state: s.state })
      }
      return out
    },

    async setStatus(repo, sha, state, description) {
      await call(repo, `/repos/${repo}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({ state, description, context: REVIEW_STATUS_CONTEXT }),
      })
    },

    async comment(repo, number, body, agentId) {
      const res = await call(repo, `/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: markBody(body, agentId) }),
      })
      return ((await res.json().catch(() => ({}))) as any).html_url
    },
  }
}
