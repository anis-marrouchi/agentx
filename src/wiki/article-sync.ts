import { existsSync } from "fs"
import { isAbsolute, relative, resolve } from "path"
import type { WikiHub } from "./hub"
import type { WikiIndex } from "./types"

/** A mesh peer's daemon, with the token its /wiki/* routes ask for. */
export interface WikiPeer {
  url: string
  token?: string
}

export type PeerFetch = (peer: WikiPeer, path: string, timeoutMs: number) => Promise<any>

export async function fetchPeerJson(peer: WikiPeer, path: string, timeoutMs: number): Promise<any> {
  const res = await fetch(`${peer.url.replace(/\/$/, "")}${path}`, {
    headers: peer.token ? { Authorization: `Bearer ${peer.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  return res.json()
}

export interface AgentSyncResult {
  agentId: string
  copied: number
  unchanged: number
  /** Articles refused for an unsafe path. */
  rejected: number
  /** Why the agent was not copied at all. */
  skipped?: "local" | "bad-id"
  error?: string
}

export interface ArticleSyncResult {
  node: string
  agents: AgentSyncResult[]
}

// One path segment, no dots in front: rules out "..", "/" and "_shared".
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** An article path from a peer is only written when it stays an ordinary
 *  article inside the agent's folder: not a sidecar, raw entry or escape. */
export function isSafeArticlePath(baseDir: string, path: unknown): path is string {
  if (typeof path !== "string" || !path.endsWith(".md") || isAbsolute(path) || path.includes("\\")) return false
  if (path.startsWith("_") || path.startsWith("raw/")) return false
  if (path.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return false
  const rel = relative(baseDir, resolve(baseDir, path))
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Copy a peer's per-agent articles into this node's wiki, for every agent
 * this node does not run itself. Copied agents are marked read-only (see
 * WikiHub.syncedFrom): their home node absorbs them, this node only reads.
 * An article whose last_updated matches the local copy is not fetched again.
 */
export async function syncPeerArticles(opts: {
  hub: WikiHub
  peer: WikiPeer
  localAgents: Set<string>
  dryRun?: boolean
  fetchJson?: PeerFetch
}): Promise<ArticleSyncResult> {
  const { hub, peer, localAgents, dryRun = false } = opts
  const fetchJson = opts.fetchJson ?? fetchPeerJson

  // The peer counts every agent's entries for this list; that has taken
  // over a minute on a large wiki.
  const summary = await fetchJson(peer, "/wiki/agents", 120_000)
  const node = String(summary?.nodeId || "unknown")
  const results: AgentSyncResult[] = []

  for (const remote of summary?.agents ?? []) {
    const agentId = String(remote?.agentId ?? "")
    if (!(remote?.totalArticles > 0)) continue
    const result: AgentSyncResult = { agentId, copied: 0, unchanged: 0, rejected: 0 }
    results.push(result)
    if (!AGENT_ID.test(agentId)) { result.skipped = "bad-id"; continue }
    // This node's own agents are absorbed here; a peer's copy never wins.
    if (localAgents.has(agentId)) { result.skipped = "local"; continue }

    try {
      const listed = await fetchJson(peer, `/wiki/articles?agent=${encodeURIComponent(agentId)}`, 30_000)
      const articles: WikiIndex["articles"] = listed?.articles ?? []
      // Opening a store creates its folder; a dry run must not.
      const agentDir = resolve(hub.getBaseDir(), "agents", agentId, hub.getMode())
      if (dryRun && !existsSync(agentDir)) {
        result.copied = articles.filter((a) => isSafeArticlePath(agentDir, a.path)).length
        result.rejected = articles.length - result.copied
        continue
      }
      const store = hub.getAgentWiki(agentId)

      for (const a of articles) {
        if (!isSafeArticlePath(store.baseDir, a.path)) { result.rejected++; continue }
        const existing = store.readArticle(a.path)
        if (existing && a.lastUpdated && existing.meta.lastUpdated === a.lastUpdated) {
          result.unchanged++
          continue
        }
        if (dryRun) { result.copied++; continue }

        const body = await fetchJson(
          peer,
          `/wiki/article?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(a.path)}`,
          15_000,
        )
        // The list carries access, type, links and graph path; the article
        // route carries the body and creation date.
        const owner = a.owner || agentId
        store.writeArticle(a.path, {
          title: a.title,
          type: a.type,
          related: a.related,
          tags: a.tags ?? [],
          owner,
          access: a.access ?? "private",
          sharedWith: a.sharedWith,
          created: String(body?.created ?? ""),
          lastUpdated: a.lastUpdated ?? "",
          sources: a.sources ?? [],
          graphPath: a.graphPath,
        }, String(body?.content ?? ""), existing?.meta.owner ?? owner)
        result.copied++
      }

      if (!dryRun) {
        store.rebuildIndex()
        hub.markSynced(agentId, { node, peerUrl: peer.url, at: new Date().toISOString() })
      }
    } catch (err) {
      result.error = (err as Error).message
    }
  }

  return { node, agents: results }
}
