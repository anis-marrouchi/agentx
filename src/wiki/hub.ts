import { WikiStore } from "./store"
import { dirname, resolve } from "path"
import { existsSync, readdirSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import type { WikiEntry } from "./types"

export type WikiMode = "flat" | "graph" | "unified"

/** Per agent and mode: entry ids absorb has read, whether or not it cited them. */
export const ABSORB_REVIEWED_FILE = "_absorb-reviewed.json"

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
   * Entries absorb has not looked at yet.
   *
   * An entry leaves the queue when an article cites it in `sources`, or
   * when absorb read it and passed it over (the reviewed ledger). Citation
   * alone is not enough: most entries absorb reads are never cited, and
   * without the ledger they stay at the head of the oldest-first queue and
   * every `--max` batch re-reads them (#762).
   */
  getUnabsorbedEntries(agentId: string): WikiEntry[] {
    const done = this.getReviewedEntryIds(agentId)
    for (const id of this.getCitedEntryIds(agentId)) done.add(id)
    return this.getAgentEntries(agentId).filter(e => !done.has(e.id))
  }

  /** Entry ids cited by this agent's articles in the current mode. */
  getCitedEntryIds(agentId: string): Set<string> {
    const cited = new Set<string>()
    const index = this.getAgentWiki(agentId).rebuildIndex()
    for (const article of index.articles) {
      if (article.sources) {
        for (const s of article.sources) cited.add(s)
      }
    }
    return cited
  }

  /** Entry ids absorb has read for this agent in the current mode, cited or not. */
  getReviewedEntryIds(agentId: string): Set<string> {
    const path = this.reviewedLedgerPath(agentId)
    if (!existsSync(path)) return new Set()
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"))
      const ids = Array.isArray(parsed?.ids) ? parsed.ids : []
      return new Set(ids.filter((id: unknown): id is string => typeof id === "string"))
    } catch {
      // Corrupt ledger → treat as empty. Worst case: passed-over entries
      // are offered to absorb once more. Cited entries stay out via sources.
      return new Set()
    }
  }

  /** Record that absorb read these entries, so they are not offered again. */
  markEntriesReviewed(agentId: string, ids: string[]): void {
    if (ids.length === 0) return
    const reviewed = this.getReviewedEntryIds(agentId)
    for (const id of ids) reviewed.add(id)
    const path = this.reviewedLedgerPath(agentId)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, ids: [...reviewed].sort() }, null, 2))
    renameSync(tmp, path)
  }

  private reviewedLedgerPath(agentId: string): string {
    return resolve(this.agentsDir, agentId, this.mode, ABSORB_REVIEWED_FILE)
  }

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
  articles: Array<{ title: string; path: string; tags?: string[] }>
}
