import { MAX_LISTED_FILES, MERGE_POLICY_CONTEXT, type ChangedFile, type MergePolicyGitHub, type PullRequestReview } from "./merge-policy"

// --- GitHub REST calls for the merge policy (#1047) ---
//
// The token comes from the GitHub channel (App installation token, else the
// PAT), per repository. The status needs `statuses: write` and the label
// `issues: write` (or `pull_requests: write`) on the App, or `repo` on a
// classic PAT.

const API = "https://api.github.com"

export function createMergePolicyGitHub(
  tokenFor: (repo: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): MergePolicyGitHub {
  const call = async (repo: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const token = await tokenFor(repo)
    if (!token) throw new Error(`no GitHub token for ${repo}`)
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
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
  const pages = async (repo: string, path: string, max: number): Promise<any[]> => {
    const out: any[] = []
    for (let page = 1; page <= max; page++) {
      const rows = await json(repo, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`) as any[]
      out.push(...rows)
      if (rows.length < 100) break
    }
    return out
  }

  return {
    async getPullRequest(repo, number) {
      const pr = await json(repo, `/repos/${repo}/pulls/${number}`)
      return {
        headSha: pr.head?.sha,
        authorLogin: pr.user?.login ?? "",
        body: pr.body ?? "",
        labels: (pr.labels ?? []).map((l: any) => l?.name).filter(Boolean),
        state: pr.state ?? "open",
      }
    },

    async getChangedFiles(repo, number) {
      const rows = await pages(repo, `/repos/${repo}/pulls/${number}/files`, MAX_LISTED_FILES / 100)
      return rows.map((f): ChangedFile => ({ path: f.filename, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) }))
    },

    async getReviews(repo, number) {
      const rows = await pages(repo, `/repos/${repo}/pulls/${number}/reviews`, 30)
      return rows.map((r): PullRequestReview => ({
        login: r.user?.login ?? "",
        isBot: r.user?.type === "Bot",
        state: r.state ?? "",
        commitId: r.commit_id ?? "",
        association: r.author_association ?? "NONE",
      })).filter((r) => r.login)
    },

    async setStatus(repo, sha, state, description) {
      await call(repo, `/repos/${repo}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({ state, description, context: MERGE_POLICY_CONTEXT }),
      })
    },

    async addLabel(repo, number, label) {
      await call(repo, `/repos/${repo}/issues/${number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      })
    },

    async removeLabel(repo, number, label) {
      try {
        await call(repo, `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
      } catch (e: any) {
        // Already gone: nothing to do.
        if (!/: 404$/.test(e?.message || "")) throw e
      }
    },
  }
}
