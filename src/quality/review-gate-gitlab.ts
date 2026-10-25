import { markBody } from "@/channels/outbound-marker"
import { REVIEW_STATUS_CONTEXT, type CiCheck, type ReviewGateGitHub, type ReviewState } from "./review-gate"
import { MERGE_POLICY_CONTEXT } from "./merge-policy"

// --- GitLab REST calls for the review gate (#1292) ---
//
// The same gate as on GitHub (#990), on merge requests. The verdict is the
// commit status `agentx/review` on the MR's head commit: GitLab adds it to
// the commit's pipeline as an external job, so with "Pipelines must
// succeed" on, a failed review blocks the merge. GitLab has no `error`
// state: a review that could not be done posts `failed`, its description
// starting with "error:".
//
// The token is the GitLab channel's shared one (`channels.gitlab.token`).
// It needs the `api` scope to post statuses and notes.

type RestCall = (path: string, init?: RequestInit) => Promise<Response>

function restCall(host: string, token: () => string | undefined, fetchImpl: typeof fetch): RestCall {
  const base = host.replace(/\/+$/, "")
  return async (path, init = {}) => {
    const t = token()
    if (!t) throw new Error("no GitLab token (channels.gitlab.token)")
    const res = await fetchImpl(`${base}/api/v4${path}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": t,
        Accept: "application/json",
        "User-Agent": "AgentX",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`GitLab ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status}`)
    return res
  }
}

const project = (path: string) => `/projects/${encodeURIComponent(path)}`

/** GitLab commit status states, from the gate's. */
export function gitlabStatusState(state: ReviewState | "pending"): "pending" | "running" | "success" | "failed" {
  if (state === "pending") return "running"
  return state === "success" ? "success" : "failed"
}

/** The gate's check state, from a GitLab commit status. */
export function checkState(status: string): string {
  if (["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"].includes(status)) return "pending"
  if (status === "failed") return "failure"
  if (status === "canceled") return "cancelled"
  if (status === "manual") return "neutral"
  return status
}

interface MrDiff { old_path: string; new_path: string; diff: string; new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean }

/** One file's change as a unified diff, the shape the reviewer reads on
 *  GitHub. GitLab's `diff` holds the hunks only. */
export function unifiedDiff(d: MrDiff): string {
  const from = d.new_file ? "/dev/null" : `a/${d.old_path}`
  const to = d.deleted_file ? "/dev/null" : `b/${d.new_path}`
  return [`diff --git a/${d.old_path} b/${d.new_path}`, `--- ${from}`, `+++ ${to}`, (d.diff ?? "").replace(/\n$/, "")].join("\n")
}

export function createReviewGateGitLab(
  host: string,
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): ReviewGateGitHub {
  const call = restCall(host, token, fetchImpl)
  const json = async (path: string): Promise<any> => (await call(path)).json()

  const diffs = async (repo: string, number: number): Promise<MrDiff[]> => {
    const out: MrDiff[] = []
    for (let page = 1; page <= 30; page++) {
      const rows = await json(`${project(repo)}/merge_requests/${number}/diffs?per_page=100&page=${page}`) as MrDiff[]
      out.push(...rows)
      if (rows.length < 100) break
    }
    return out
  }

  return {
    async getPullRequest(repo, number) {
      const mr = await json(`${project(repo)}/merge_requests/${number}`)
      return {
        number: mr.iid,
        headSha: mr.sha,
        title: mr.title ?? "",
        body: mr.description ?? "",
        authorLogin: mr.author?.username ?? "",
        draft: !!(mr.draft ?? mr.work_in_progress),
        state: mr.state === "opened" ? "open" : (mr.state ?? "open"),
      }
    },

    async getDiff(repo, number) {
      return (await diffs(repo, number)).map(unifiedDiff).join("\n")
    },

    async getChangedFiles(repo, number) {
      return (await diffs(repo, number)).map((d) => d.new_path)
    },

    async getIssue(repo, number) {
      try {
        const i = await json(`${project(repo)}/issues/${number}`)
        return { repo, number, title: i.title ?? "", body: i.description ?? "", isPullRequest: false }
      } catch (e: any) {
        if (/: 404$/.test(e?.message || "")) return null
        throw e
      }
    },

    async getChecks(repo, sha) {
      const out: CiCheck[] = []
      for (let page = 1; page <= 10; page++) {
        const rows = await json(`${project(repo)}/repository/commits/${sha}/statuses?per_page=100&page=${page}`) as any[]
        for (const s of rows) {
          if (s.name === REVIEW_STATUS_CONTEXT || s.name === MERGE_POLICY_CONTEXT) continue
          out.push({ name: s.name, state: checkState(String(s.status ?? "")) })
        }
        if (rows.length < 100) break
      }
      return out
    },

    async setStatus(repo, sha, state, description, context = REVIEW_STATUS_CONTEXT) {
      await call(`${project(repo)}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({
          state: gitlabStatusState(state),
          name: context,
          description: state === "error" ? `error: ${description}` : description,
        }),
      })
    },

    async comment(repo, number, body, agentId) {
      const res = await call(`${project(repo)}/merge_requests/${number}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: markBody(body, agentId) }),
      })
      const note = (await res.json().catch(() => ({}))) as any
      return note?.id ? `${host.replace(/\/+$/, "")}/${repo}/-/merge_requests/${number}#note_${note.id}` : undefined
    },
  }
}
