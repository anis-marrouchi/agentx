import { WikiStore } from "./store"
import { resolve } from "path"
import { existsSync, readdirSync, mkdirSync } from "fs"
import type { WikiEntry } from "./types"

/**
 * WikiHub: manages per-agent wikis with a shared raw entry pool.
 *
 * Structure:
 *   .agentx/wiki/
 *     raw/entries/              # Shared inbox — all agent entries
 *     agents/
 *       marketing-agent/        # Nadia's compiled wiki (articles, index)
 *       devops-agent/           # DevOps compiled wiki
 *       ...
 */
export class WikiHub {
  private baseDir: string
  private agentsDir: string
  private sharedStore: WikiStore  // Manages raw entries
  private agentStores: Map<string, WikiStore> = new Map()
  private log: (...args: unknown[]) => void

  constructor(
    baseDir: string = resolve(process.cwd(), ".agentx/wiki"),
    log: (...args: unknown[]) => void = console.error.bind(console, "[wiki-hub]"),
  ) {
    this.baseDir = baseDir
    this.agentsDir = resolve(baseDir, "agents")
    this.log = log

    mkdirSync(this.agentsDir, { recursive: true })

    // Shared store handles raw entry ingestion
    this.sharedStore = new WikiStore(baseDir, log)
  }

  /**
   * Get or create the wiki store for a specific agent.
   */
  getAgentWiki(agentId: string): WikiStore {
    if (this.agentStores.has(agentId)) return this.agentStores.get(agentId)!

    const agentDir = resolve(this.agentsDir, agentId)
    const store = new WikiStore(agentDir, this.log)
    this.agentStores.set(agentId, store)
    return store
  }

  /**
   * Get the shared store (for raw entry operations).
   */
  getSharedStore(): WikiStore {
    return this.sharedStore
  }

  /**
   * List all agent IDs that have entries or a wiki.
   */
  listAgents(): string[] {
    const agents = new Set<string>()

    // From raw entries
    const entries = this.sharedStore.listEntries()
    for (const e of entries) agents.add(e.agentId)

    // From existing agent wiki directories
    if (existsSync(this.agentsDir)) {
      for (const dir of readdirSync(this.agentsDir)) {
        if (!dir.startsWith("_") && !dir.startsWith(".")) {
          agents.add(dir)
        }
      }
    }

    return [...agents].sort()
  }

  /**
   * Get entries for a specific agent (from shared pool).
   */
  getAgentEntries(agentId: string): WikiEntry[] {
    return this.sharedStore.listEntries({ agentId })
  }

  /**
   * Get unabsorbed entries for a specific agent.
   * An entry is "absorbed" if any article in that agent's wiki references it.
   */
  getUnabsorbedEntries(agentId: string): WikiEntry[] {
    const agentWiki = this.getAgentWiki(agentId)
    const agentEntries = this.getAgentEntries(agentId)

    // Collect all source IDs from this agent's articles
    const absorbedIds = new Set<string>()
    const index = agentWiki.rebuildIndex()
    for (const article of index.articles) {
      if (article.sources) {
        for (const s of article.sources) absorbedIds.add(s)
      }
    }

    return agentEntries.filter(e => !absorbedIds.has(e.id))
  }

  /**
   * Get a summary of all agents and their wiki state.
   */
  summary(): AgentWikiSummary[] {
    const agents = this.listAgents()
    return agents.map(agentId => {
      const entries = this.getAgentEntries(agentId)
      const wiki = this.getAgentWiki(agentId)
      const index = wiki.rebuildIndex()
      const unabsorbed = this.getUnabsorbedEntries(agentId)

      return {
        agentId,
        totalEntries: entries.length,
        totalArticles: index.articles.length,
        unabsorbed: unabsorbed.length,
        articles: index.articles,
      }
    })
  }
}

export interface AgentWikiSummary {
  agentId: string
  totalEntries: number
  totalArticles: number
  unabsorbed: number
  articles: Array<{ title: string; path: string; type: string }>
}
