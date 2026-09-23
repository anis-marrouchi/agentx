// --- Live state of the issues / MRs the fleet is working on ---
//
// The Fleet Map's line status ("Delays · 3 pipelines failed", "1 held")
// has to come from the forge, not from the ledger: a run can finish fine
// while the MR it pushed fails CI. For the refs named by dispatches in the
// window, read MR/PR/issue state and the head pipeline. Cached per ref so
// the 5 s snapshot stream costs at most one forge call per ref per TTL.

import { refKey, refsOf, type ForgeRef } from "./activity-graph-attribution"

export interface ForgeItem {
  kind: "issue" | "mr"
  project: string
  n: number
  title: string
  /** opened | merged | closed */
  state: string
  draft: boolean
  url: string
  /** Head pipeline (GitLab MRs only): success | failed | running | pending | canceled | … */
  pipeline: { status: string; url: string } | null
  mergedAt: number | null
}

export interface ForgeConfig {
  gitlab?: { host: string; token: string }
  githubToken?: string
}

type Fetch = typeof fetch
interface Want { project: string; ref: ForgeRef; github: boolean }

const TTL_MS = 60_000
const GITHUB_TTL_MS = 5 * 60_000 // unauthenticated GitHub allows 60 calls/hour
const MAX_REFS = 40
const CONCURRENCY = 6

const cache = new Map<string, { at: number; item: ForgeItem | null }>()

/** Refs worth looking up, newest dispatches first, capped. */
export function refsToLookUp(dispatches: Array<{ subject: string; inputPreview: string; projectId: string; channelId: string; startedAt: number }>): Want[] {
  const out = new Map<string, Want>()
  const sorted = [...dispatches].sort((a, b) => b.startedAt - a.startedAt)
  for (const d of sorted) {
    const github = d.channelId === "github" || /\bpull:\d+/.test(d.subject)
    for (const ref of refsOf(d)) {
      const key = refKey(d.projectId, ref)
      if (!out.has(key)) out.set(key, { project: d.projectId, ref, github })
      if (out.size >= MAX_REFS) return [...out.values()]
    }
  }
  return [...out.values()]
}

export async function fetchForgeStatus(
  wants: Want[],
  cfg: ForgeConfig,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<Record<string, ForgeItem>> {
  const result: Record<string, ForgeItem> = {}
  const todo: Want[] = []
  for (const w of wants) {
    const key = refKey(w.project, w.ref)
    const hit = cache.get(key)
    if (hit && now - hit.at < (w.github ? GITHUB_TTL_MS : TTL_MS)) {
      if (hit.item) result[key] = hit.item
    } else todo.push(w)
  }
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (w) => {
      const key = refKey(w.project, w.ref)
      let item: ForgeItem | null = null
      try {
        item = w.github ? await fetchGithub(w, cfg, fetchImpl) : await fetchGitlab(w, cfg, fetchImpl)
      } catch {
        // Unreachable forge: the map shows the ref without a status rather
        // than failing the snapshot. Cached like a miss so we don't hammer it.
      }
      cache.set(key, { at: now, item })
      if (item) result[key] = item
    }))
  }
  return result
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<any | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000)
  try {
    const r = await fetchImpl(url, { headers, signal: ac.signal })
    return r.ok ? await r.json() : null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchGitlab(w: Want, cfg: ForgeConfig, fetchImpl: Fetch): Promise<ForgeItem | null> {
  const gl = cfg.gitlab
  if (!gl?.host || !gl.token) return null
  const base = `${gl.host.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(w.project)}`
  const path = w.ref.kind === "mr" ? `merge_requests/${w.ref.n}` : `issues/${w.ref.n}`
  const j = await getJson(`${base}/${path}`, { "PRIVATE-TOKEN": gl.token }, fetchImpl)
  if (!j) return null
  const hp = j.head_pipeline ?? j.pipeline
  return {
    kind: w.ref.kind, project: w.project, n: w.ref.n,
    title: String(j.title ?? ""),
    state: String(j.state ?? "opened"),
    draft: Boolean(j.draft ?? j.work_in_progress),
    url: String(j.web_url ?? ""),
    pipeline: hp && typeof hp.status === "string" ? { status: hp.status, url: String(hp.web_url ?? "") } : null,
    mergedAt: j.merged_at ? Date.parse(j.merged_at) : null,
  }
}

async function fetchGithub(w: Want, cfg: ForgeConfig, fetchImpl: Fetch): Promise<ForgeItem | null> {
  const path = w.ref.kind === "mr" ? `pulls/${w.ref.n}` : `issues/${w.ref.n}`
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "agentx-dashboard" }
  if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`
  const j = await getJson(`https://api.github.com/repos/${w.project}/${path}`, headers, fetchImpl)
  if (!j) return null
  return {
    kind: w.ref.kind, project: w.project, n: w.ref.n,
    title: String(j.title ?? ""),
    state: j.merged_at ? "merged" : j.state === "open" ? "opened" : String(j.state ?? "opened"),
    draft: Boolean(j.draft),
    url: String(j.html_url ?? ""),
    pipeline: null,
    mergedAt: j.merged_at ? Date.parse(j.merged_at) : null,
  }
}

/** Test hook. */
export function clearForgeCache(): void {
  cache.clear()
}
