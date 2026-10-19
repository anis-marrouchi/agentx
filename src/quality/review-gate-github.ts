import { markBody } from "@/channels/outbound-marker"
import { REVIEW_STATUS_CONTEXT, type CiCheck, type ReviewGateGitHub } from "./review-gate"
import { MERGE_POLICY_CONTEXT, type MergePolicyGitHub, type PolicyReview } from "./merge-policy"

// --- GitHub REST calls for the review gate (#990) and merge policy (#1047) ---
//
// The token comes from the GitHub channel (App installation token, else the
// PAT), per repository. The commit status needs `statuses: write` on the
// App, or `repo:status` on a classic PAT.

const API = "https://api.github.com"

type RestCall = (repo: string, path: string, init?: RequestInit & { accept?: string }) => Promise<Response>

/** One authenticated REST call; a non-2xx answer throws "GitHub <method> <path>: <status>". */
function restCall(tokenFor: (repo: string) => Promise<string | undefined>, fetchImpl: typeof fetch): RestCall {
  return async (repo, path, init = {}) => {
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
}

/** The PR's changed files; with `oldPaths`, a renamed file's old path too. */
async function changedFiles(call: RestCall, repo: string, number: number, oldPaths = false): Promise<string[]> {
  const files: string[] = []
  for (let page = 1; page <= 30; page++) {
    const rows = await (await call(repo, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)).json() as any[]
    for (const f of rows) {
      files.push(f.filename)
      if (oldPaths && f.previous_filename) files.push(f.previous_filename)
    }
    if (rows.length < 100) break
  }
  return files
}

export function createReviewGateGitHub(
  tokenFor: (repo: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ReviewGateGitHub {
  const call = restCall(tokenFor, fetchImpl)
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
      return changedFiles(call, repo, number)
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
        // Its own status, and the merge policy's, which waits on a person
        // and would hold the review back for ciWaitMinutes every time.
        if (s.context === REVIEW_STATUS_CONTEXT || s.context === MERGE_POLICY_CONTEXT) continue
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

/** GitHub REST calls for the merge policy (#1047). Labels need `issues:
 *  write` (App) or `repo` (classic PAT); the status, `statuses: write`. */
export function createMergePolicyGitHub(
  tokenFor: (repo: string) => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): MergePolicyGitHub {
  const call = restCall(tokenFor, fetchImpl)
  const json = async (repo: string, path: string): Promise<any> => (await call(repo, path)).json()
  return {
    async getPullRequest(repo, number) {
      const pr = await json(repo, `/repos/${repo}/pulls/${number}`)
      return {
        number: pr.number,
        headSha: pr.head?.sha,
        authorLogin: pr.user?.login ?? "",
        draft: !!pr.draft,
        state: pr.state ?? "open",
        labels: ((pr.labels ?? []) as any[]).map((l) => l?.name).filter(Boolean),
        url: pr.html_url,
      }
    },

    async getChangedFiles(repo, number) {
      return changedFiles(call, repo, number, true)
    },

    async getReviews(repo, number) {
      const out: PolicyReview[] = []
      for (let page = 1; page <= 10; page++) {
        const rows = await json(repo, `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`) as any[]
        for (const r of rows) {
          out.push({ login: r.user?.login ?? "", state: String(r.state ?? "").toLowerCase(), commitId: r.commit_id ?? "", association: r.author_association ?? "" })
        }
        if (rows.length < 100) break
      }
      return out
    },

    async setStatus(repo, sha, state, description) {
      await call(repo, `/repos/${repo}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({ state, description, context: MERGE_POLICY_CONTEXT }),
      })
    },

    async addLabel(repo, number, label) {
      await call(repo, `/repos/${repo}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) })
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
