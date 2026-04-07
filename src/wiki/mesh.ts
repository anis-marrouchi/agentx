import type { AgentWikiSummary } from "./hub"
import type { WikiArticle } from "./types"

/**
 * Fetches wiki data from mesh peers over HTTP.
 * Each peer exposes /wiki/agents, /wiki/entries, /wiki/articles.
 */
export class MeshWikiClient {
  private peers: Array<{ url: string; nodeId?: string }>
  private cache: Map<string, { data: any; ts: number }> = new Map()
  private ttl = 30_000 // 30s cache

  constructor(peerUrls: string[]) {
    this.peers = peerUrls.map(url => ({ url: url.replace(/\/$/, "") }))
  }

  /**
   * Get agent summaries from all peers.
   * Returns remote summaries with nodeId attached.
   */
  async getRemoteAgents(): Promise<Array<AgentWikiSummary & { nodeId: string; peerUrl: string }>> {
    const results: Array<AgentWikiSummary & { nodeId: string; peerUrl: string }> = []

    await Promise.all(this.peers.map(async (peer) => {
      try {
        const data = await this.fetchJson(`${peer.url}/wiki/agents`)
        peer.nodeId = data.nodeId
        for (const agent of (data.agents || [])) {
          if (agent.totalEntries > 0 || agent.totalArticles > 0) {
            results.push({ ...agent, nodeId: data.nodeId, peerUrl: peer.url })
          }
        }
      } catch { /* peer unreachable */ }
    }))

    return results
  }

  /**
   * Get articles for a specific agent from a specific peer.
   */
  async getRemoteArticles(peerUrl: string, agentId: string): Promise<Array<{
    path: string; title: string; tags: string[]; lastUpdated?: string; sources?: string[]
  }>> {
    try {
      const data = await this.fetchJson(`${peerUrl}/wiki/articles?agent=${encodeURIComponent(agentId)}`)
      return data.articles || []
    } catch {
      return []
    }
  }

  /**
   * Fetch a specific article's content from a peer.
   */
  async getRemoteArticle(peerUrl: string, agentId: string, articlePath: string): Promise<WikiArticle | null> {
    try {
      const data = await this.fetchJson(
        `${peerUrl}/wiki/article?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(articlePath)}`
      )
      return {
        meta: {
          title: data.title,
          tags: data.tags || [],
          owner: data.owner,
          access: "public",
          created: data.created,
          lastUpdated: data.lastUpdated,
          sources: data.sources || [],
        },
        content: data.content,
        path: data.path,
      }
    } catch {
      return null
    }
  }

  private async fetchJson(url: string): Promise<any> {
    const cached = this.cache.get(url)
    if (cached && Date.now() - cached.ts < this.ttl) return cached.data

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    this.cache.set(url, { data, ts: Date.now() })
    return data
  }
}
