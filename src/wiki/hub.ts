import { WikiStore } from "./store"
import { resolve } from "path"
import { existsSync, readdirSync, mkdirSync } from "fs"
import type { WikiEntry } from "./types"
import { readAbsorbLedger } from "./absorb-ledger"

export type WikiMode = "flat" | "graph" | "unified"

/**
 * WikiHub: manages per-agent wikis with a shared raw entry pool.
 * Supports two compilation modes:
 *   - flat:  Karpathy pattern — tags, LLM-chosen paths, worldview, gap detection
 *   - graph: Knowledge graph — kind, parent, hierarchy, events, entities
 *
 * Both modes share the same raw entries. Articles stored separately:
 *   agents/<id>/flat/    ← Karpathy compilation
 *   agents/<id>/graph/   ← Knowledge graph compilation
 */
export class WikiHub {
  private baseDir: string
  private agentsDir: string
  private mode: WikiMode
  private sharedStore: WikiStore
  private agentStores: Map<string, WikiStore> = new Map()
  private log: (...args: unknown[]) => void

  constructor(
    baseDir: string = resolve(process.cwd(), ".agentx/wiki"),
    log: (...args: unknown[]) => void = console.error.bind(console, "[wiki-hub]"),
    mode: WikiMode = "graph",
  ) {
    this.baseDir = baseDir
    this.agentsDir = resolve(baseDir, "agents")
    this.mode = mode
    this.log = log

    mkdirSync(this.agentsDir, { recursive: true })
    this.sharedStore = new WikiStore(baseDir, log)
  }

  getMode(): WikiMode { return this.mode }

  /**
   * Get or create the wiki store for a specific agent (mode-aware).
   * flat:  agents/<id>/flat/
   * graph: agents/<id>/graph/
   */
  getAgentWiki(agentId: string): WikiStore {
    const key = `${agentId}:${this.mode}`
    if (this.agentStores.has(key)) return this.agentStores.get(key)!

    const agentDir = resolve(this.agentsDir, agentId, this.mode)
    const store = new WikiStore(agentDir, this.log)
    this.agentStores.set(key, store)
    return store
  }

  /** The wiki root: shared sidecars (_facts.json, _questions.json) live here. */
  getBaseDir(): string {
    return this.baseDir
  }

  getSharedStore(): WikiStore {
    return this.sharedStore
  }

  listAgents(): string[] {
    const agents = new Set<string>()

    const entries = this.sharedStore.listEntries()
    for (const e of entries) agents.add(e.agentId)

    if (existsSync(this.agentsDir)) {
      for (const dir of readdirSync(this.agentsDir)) {
        if (!dir.startsWith("_") && !dir.startsWith(".")) {
          agents.add(dir)
        }
      }
    }

    return [...agents].sort()
  }

  getAgentEntries(agentId: string): WikiEntry[] {
    return this.sharedStore.listEntries({ agentId })
  }

  /**
   * Entries absorb has not read yet: not cited by any article, and not in
   * the absorb ledger (#761). `includeProcessed` ignores the ledger, so
   * entries a past run read and skipped come back (`absorb --reprocess`).
   */
  getUnabsorbedEntries(agentId: string, opts: { includeProcessed?: boolean } = {}): WikiEntry[] {
    const { unabsorbed } = this.classifyEntries(agentId, opts)
    return unabsorbed
  }

  /** Entries a finished absorb run read and no article cites. */
  getSkippedEntries(agentId: string): WikiEntry[] {
    return this.classifyEntries(agentId).skipped
  }

  private classifyEntries(
    agentId: string,
    opts: { includeProcessed?: boolean } = {},
  ): { unabsorbed: WikiEntry[]; skipped: WikiEntry[] } {
    const agentWiki = this.getAgentWiki(agentId)
    const agentEntries = this.getAgentEntries(agentId)

    const citedIds = new Set<string>()
    const index = agentWiki.rebuildIndex()
    for (const article of index.articles) {
      if (article.sources) {
        for (const s of article.sources) citedIds.add(s)
      }
    }
    const processed = opts.includeProcessed
      ? new Map<string, unknown>()
      : readAbsorbLedger(this.baseDir, agentId, this.mode)

    const unabsorbed: WikiEntry[] = []
    const skipped: WikiEntry[] = []
    for (const e of agentEntries) {
      if (citedIds.has(e.id)) continue
      if (processed.has(e.id)) skipped.push(e)
      else unabsorbed.push(e)
    }
    return { unabsorbed, skipped }
  }

  summary(): AgentWikiSummary[] {
    const agents = this.listAgents()
    return agents.map(agentId => {
      const entries = this.getAgentEntries(agentId)
      const wiki = this.getAgentWiki(agentId)
      const index = wiki.rebuildIndex()
      const { unabsorbed, skipped } = this.classifyEntries(agentId)

      return {
        agentId,
        totalEntries: entries.length,
        totalArticles: index.articles.length,
        unabsorbed: unabsorbed.length,
        skipped: skipped.length,
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
  /** Read by absorb, cited by nothing. Optional: older peers omit it. */
  skipped?: number
  articles: Array<{ title: string; path: string; tags?: string[] }>
}
