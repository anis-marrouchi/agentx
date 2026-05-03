import type { BacklogItem, BacklogSource } from "./backlog-store"
import type { DaemonConfig } from "@/daemon/config"

// --- Sync-back layer: backlog item mutations → upstream issue ---
//
// When a backlog item carries a `source` ref (gitlab or github), changes
// applied via the backlog work-source need to flow back to the original
// issue: assignees, labels, title, description, milestone, open/close.
// Otherwise the imported view drifts from upstream and humans browsing
// the source see stale state.
//
// This module is intentionally stateless — callers pass the patch they
// just applied to the local item; we forward the same shape to the
// matching upstream API.

export interface BacklogPatch {
  title?: string
  description?: string
  /** Replace labels wholesale. Use addLabels/removeLabels for incremental. */
  labels?: string[]
  addLabels?: string[]
  removeLabels?: string[]
  /** Username on the source (NOT agentId — caller resolves the mapping). */
  assigneeUsernames?: string[]
  /** Title of the milestone, or empty string to clear. */
  milestoneTitle?: string | null
  /** Open/close transition. */
  state?: "open" | "closed"
  /** Optional comment to post on the upstream issue. */
  note?: string
}

export interface SyncBackResult {
  ok: boolean
  url?: string
  error?: string
  /** Each upstream call we attempted, in order. */
  attempts: Array<{ kind: string; ok: boolean; status?: number; error?: string }>
}

/** Resolve agentIds in a patch to upstream usernames using the daemon mappings. */
export function resolveAssigneesForSource(
  agentIds: string[],
  source: BacklogSource,
  daemon: DaemonConfig,
): string[] {
  const out: string[] = []
  if (source.type === "gitlab") {
    const mappings = daemon.channels.gitlab?.agentMappings ?? []
    for (const agentId of agentIds) {
      const m = mappings.find((x) => x.agentId === agentId)
      if (m?.gitlabUsernames?.length) out.push(m.gitlabUsernames[0])
      else out.push(agentId)
    }
  } else if (source.type === "github") {
    const mappings = daemon.channels.github?.agentMappings ?? []
    for (const agentId of agentIds) {
      const m = mappings.find((x) => x.agentId === agentId)
      if (m?.githubUsernames?.length) out.push(m.githubUsernames[0])
      else out.push(agentId)
    }
  }
  return out
}

/** Push a backlog patch to the upstream source referenced by the item. */
export async function syncBacklogItemToSource(
  item: BacklogItem,
  patch: BacklogPatch,
  daemon: DaemonConfig,
  log: (...args: unknown[]) => void = () => {},
): Promise<SyncBackResult> {
  if (!item.source) return { ok: true, attempts: [] }
  if (item.source.type === "gitlab") return syncToGitLab(item.source, patch, daemon, log)
  if (item.source.type === "github") return syncToGitHub(item.source, patch, daemon, log)
  return { ok: false, error: `unknown source.type ${(item.source as any).type}`, attempts: [] }
}

// ---------- GitLab ----------

async function syncToGitLab(
  source: BacklogSource,
  patch: BacklogPatch,
  daemon: DaemonConfig,
  log: (...args: unknown[]) => void,
): Promise<SyncBackResult> {
  const gl = daemon.channels.gitlab
  const token = gl?.token
  const host = gl?.host || (source.host ? `https://${source.host}` : undefined)
  if (!token || !host) {
    return { ok: false, error: "gitlab token/host not configured", attempts: [] }
  }
  const attempts: SyncBackResult["attempts"] = []

  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    return fetch(`${host}/api/v4${path}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    })
  }

  const projectEnc = encodeURIComponent(source.project)

  // Resolve assignee usernames → ids (parallel) — only when we need them.
  let assigneeIds: number[] | undefined
  if (patch.assigneeUsernames !== undefined) {
    const ids = await Promise.all(patch.assigneeUsernames.map(async (u) => {
      try {
        const res = await fetch(`${host}/api/v4/users?username=${encodeURIComponent(u)}`, {
          headers: { "PRIVATE-TOKEN": token },
        })
        if (!res.ok) return null
        const arr: any = await res.json()
        return Array.isArray(arr) && arr[0]?.id ? arr[0].id : null
      } catch { return null }
    }))
    assigneeIds = ids.filter((x): x is number => typeof x === "number")
  }

  // Resolve milestone title → id.
  let milestoneId: number | 0 | undefined
  if (patch.milestoneTitle !== undefined) {
    if (patch.milestoneTitle === null || patch.milestoneTitle === "") {
      milestoneId = 0
    } else {
      try {
        const res = await api(`/projects/${projectEnc}/milestones?title=${encodeURIComponent(patch.milestoneTitle)}`)
        if (res.ok) {
          const arr: any = await res.json()
          if (Array.isArray(arr) && arr[0]?.id) milestoneId = arr[0].id
        }
      } catch (e: any) {
        log(`[backlog-sync] milestone lookup failed: ${e.message}`)
      }
    }
  }

  // Build the PUT body.
  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) body.title = patch.title
  if (patch.description !== undefined) body.description = patch.description
  if (patch.labels !== undefined) body.labels = patch.labels.join(",")
  if (patch.addLabels?.length) body.add_labels = patch.addLabels.join(",")
  if (patch.removeLabels?.length) body.remove_labels = patch.removeLabels.join(",")
  if (assigneeIds !== undefined) body.assignee_ids = assigneeIds
  if (milestoneId !== undefined) body.milestone_id = milestoneId
  if (patch.state) body.state_event = patch.state === "closed" ? "close" : "reopen"

  if (Object.keys(body).length) {
    try {
      const res = await api(`/projects/${projectEnc}/issues/${source.iid}`, {
        method: "PUT",
        body: JSON.stringify(body),
      })
      attempts.push({ kind: "PUT issue", ok: res.ok, status: res.status })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return { ok: false, attempts, error: `PUT issue ${res.status}: ${text.slice(0, 200)}`, url: source.url }
      }
    } catch (e: any) {
      attempts.push({ kind: "PUT issue", ok: false, error: e.message })
      return { ok: false, attempts, error: e.message, url: source.url }
    }
  }

  if (patch.note) {
    try {
      const res = await api(`/projects/${projectEnc}/issues/${source.iid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: patch.note }),
      })
      attempts.push({ kind: "POST note", ok: res.ok, status: res.status })
    } catch (e: any) {
      attempts.push({ kind: "POST note", ok: false, error: e.message })
    }
  }

  return { ok: attempts.every((a) => a.ok), attempts, url: source.url }
}

// ---------- GitHub ----------

async function syncToGitHub(
  source: BacklogSource,
  patch: BacklogPatch,
  daemon: DaemonConfig,
  log: (...args: unknown[]) => void,
): Promise<SyncBackResult> {
  const gh = daemon.channels.github
  const token = gh?.token
  if (!token) {
    return { ok: false, error: "github token not configured", attempts: [] }
  }
  const attempts: SyncBackResult["attempts"] = []

  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    return fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers || {}),
      },
    })
  }

  const repo = source.project // GitHub IDs use "owner/repo" verbatim in the URL path.

  // Resolve milestone title → number.
  let milestoneNumber: number | null | undefined
  if (patch.milestoneTitle !== undefined) {
    if (patch.milestoneTitle === null || patch.milestoneTitle === "") {
      milestoneNumber = null
    } else {
      try {
        const res = await api(`/repos/${repo}/milestones?state=all&per_page=100`)
        if (res.ok) {
          const arr: any = await res.json()
          const found = Array.isArray(arr) ? arr.find((m: any) => m.title === patch.milestoneTitle) : null
          if (found?.number) milestoneNumber = found.number
        }
      } catch (e: any) {
        log(`[backlog-sync] github milestone lookup failed: ${e.message}`)
      }
    }
  }

  // GitHub doesn't support add/remove labels in the issue PATCH the way
  // GitLab does — labels is a wholesale set. If only addLabels/removeLabels
  // were provided we read+merge.
  let nextLabels: string[] | undefined
  if (patch.labels !== undefined) {
    nextLabels = patch.labels
  } else if (patch.addLabels?.length || patch.removeLabels?.length) {
    try {
      const res = await api(`/repos/${repo}/issues/${source.iid}`)
      if (res.ok) {
        const issue: any = await res.json()
        const current: string[] = Array.isArray(issue.labels)
          ? issue.labels.map((l: any) => (typeof l === "string" ? l : l.name))
          : []
        const adds = new Set([...current, ...(patch.addLabels ?? [])])
        for (const r of patch.removeLabels ?? []) adds.delete(r)
        nextLabels = [...adds]
      }
    } catch (e: any) {
      log(`[backlog-sync] github label fetch failed: ${e.message}`)
    }
  }

  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) body.title = patch.title
  if (patch.description !== undefined) body.body = patch.description
  if (nextLabels !== undefined) body.labels = nextLabels
  if (patch.assigneeUsernames !== undefined) body.assignees = patch.assigneeUsernames
  if (milestoneNumber !== undefined) body.milestone = milestoneNumber
  if (patch.state) body.state = patch.state

  if (Object.keys(body).length) {
    try {
      const res = await api(`/repos/${repo}/issues/${source.iid}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      attempts.push({ kind: "PATCH issue", ok: res.ok, status: res.status })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return { ok: false, attempts, error: `PATCH issue ${res.status}: ${text.slice(0, 200)}`, url: source.url }
      }
    } catch (e: any) {
      attempts.push({ kind: "PATCH issue", ok: false, error: e.message })
      return { ok: false, attempts, error: e.message, url: source.url }
    }
  }

  if (patch.note) {
    try {
      const res = await api(`/repos/${repo}/issues/${source.iid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: patch.note }),
      })
      attempts.push({ kind: "POST comment", ok: res.ok, status: res.status })
    } catch (e: any) {
      attempts.push({ kind: "POST comment", ok: false, error: e.message })
    }
  }

  return { ok: attempts.every((a) => a.ok), attempts, url: source.url }
}
