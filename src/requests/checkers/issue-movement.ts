import { forgeHeaders, parseRef, type ForgeConnectors, type ParsedRef } from "./issue"

// --- Movement on an issue: when anything happened on it (#863) ---
//
// A schedule's goal check asks whether the goal's issue moved in the last
// 30 days. Movement = any note (system notes too, so "mentioned in commit"
// counts) and any state change, by anyone, bots included. Label-only
// changes are left out: on GitLab they are resource_label_events, which
// are never read; on GitHub the timeline's labeled / unlabeled events are
// dropped. `updated_at` is not used, because a label change moves it.
//
// The times come back whole, so the caller can drop the job's own posts.
// GitLab: the newest 100 notes and the last page of state events. GitHub:
// the last page of the timeline (the list is oldest first).

export type MovementRead = { ok: true; times: number[]; state: "open" | "closed" | "merged" } | { ok: false; error: string }
export type MovementReader = (provider: "github" | "gitlab", ref: string) => Promise<MovementRead>

const TIMEOUT_MS = 10_000
const LABEL_EVENTS = new Set(["labeled", "unlabeled"])

const timeOf = (v: unknown): number | null => {
  const at = typeof v === "string" ? Date.parse(v) : NaN
  return Number.isFinite(at) ? at : null
}

/** The `rel="last"` address of a Link header, if any. */
export function lastPageUrl(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="last"/)
    if (m) return m[1]
  }
  return null
}

/** One GitHub timeline event's time: commits carry it under author. */
function githubEventTime(e: any): number | null {
  if (LABEL_EVENTS.has(String(e?.event ?? ""))) return null
  return timeOf(e?.created_at) ?? timeOf(e?.submitted_at) ?? timeOf(e?.author?.date) ?? timeOf(e?.committer?.date)
}

export function movementReader(connectors: ForgeConnectors, doFetch: typeof fetch = fetch): MovementReader {
  const get = async (url: string, headers: Record<string, string>): Promise<{ ok: true; body: any; res: Response } | { ok: false; error: string }> => {
    let res: Response
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { ok: false, error: `could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
    }
    if (!res.ok) return { ok: false, error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    return { ok: true, body: await res.json().catch(() => null), res }
  }

  const github = async (ref: ParsedRef): Promise<MovementRead> => {
    const c = connectors.github
    if (!c) return { ok: false, error: "no github connector on this node" }
    const headers = forgeHeaders("github", connectors)
    const base = `${c.apiUrl.replace(/\/$/, "")}/repos/${ref.project}/issues/${ref.number}`
    const issue = await get(base, headers)
    if (!issue.ok) return issue
    const first = await get(`${base}/timeline?per_page=100`, headers)
    if (!first.ok) return { ok: false, error: `its timeline: ${first.error}` }
    let events: any[] = Array.isArray(first.body) ? first.body : []
    const last = lastPageUrl(first.res.headers.get("link"))
    if (last) {
      const page = await get(last, headers)
      if (!page.ok) return { ok: false, error: `its timeline: ${page.error}` }
      events = Array.isArray(page.body) ? page.body : []
    }
    const state = issue.body?.state === "closed" ? (issue.body?.pull_request?.merged_at ? "merged" : "closed") : "open"
    return { ok: true, state, times: events.map(githubEventTime).filter((t): t is number => t !== null) }
  }

  const gitlab = async (ref: ParsedRef): Promise<MovementRead> => {
    const c = connectors.gitlab
    if (!c) return { ok: false, error: "no gitlab connector on this node" }
    const headers = forgeHeaders("gitlab", connectors)
    const base = `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(ref.project)}/${ref.mr ? "merge_requests" : "issues"}/${ref.number}`
    const item = await get(base, headers)
    if (!item.ok) return item
    const notes = await get(`${base}/notes?per_page=100&sort=desc&order_by=created_at`, headers)
    if (!notes.ok) return { ok: false, error: `its notes: ${notes.error}` }
    let events = await get(`${base}/resource_state_events?per_page=100`, headers)
    if (!events.ok) return { ok: false, error: `its state events: ${events.error}` }
    const pages = Number(events.res.headers.get("x-total-pages"))
    if (Number.isInteger(pages) && pages > 1) {
      events = await get(`${base}/resource_state_events?per_page=100&page=${pages}`, headers)
      if (!events.ok) return { ok: false, error: `its state events: ${events.error}` }
    }
    const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
    const times = [...list(notes.body), ...list(events.body)].map((n) => timeOf(n?.created_at)).filter((t): t is number => t !== null)
    const raw = String(item.body?.state ?? "")
    return { ok: true, state: raw === "merged" ? "merged" : raw === "closed" ? "closed" : "open", times }
  }

  return async (provider, refText) => {
    const ref = parseRef(provider, refText)
    if (!ref) return { ok: false, error: `${refText} is not an issue reference` }
    return provider === "github" ? github(ref) : gitlab(ref)
  }
}
