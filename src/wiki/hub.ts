import { WikiStore } from "./store"
import { resolve } from "path"
import { existsSync, readdirSync, mkdirSync } from "fs"
import type { WikiEntry } from "./types"
import { ABSORB_LEDGER_FILE, appendAbsorbLedger, readAbsorbLedger, type AbsorbLedgerRecord, type AbsorbOutcome } from "./absorb-ledger"

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
   * Entries absorb has not finished with: not cited by any article and,
   * unless `reprocess`, not recorded in the processed-entry ledger (#761).
   */
  getUnabsorbedEntries(agentId: string, opts: { reprocess?: boolean } = {}): WikiEntry[] {
    const { cited, ledger } = this.absorbState(agentId)
    return this.getAgentEntries(agentId)
      .filter(e => !cited.has(e.id) && (opts.reprocess || !ledger.has(e.id)))
  }

  /** Entries an absorb run read and no article cites. */
  getSkippedEntries(agentId: string): WikiEntry[] {
    const { cited, ledger } = this.absorbState(agentId)
    return this.getAgentEntries(agentId)
      .filter(e => !cited.has(e.id) && ledger.get(e.id) === "skipped")
  }

  /**
   * Mark a batch processed once its absorb run has succeeded. Call it
   * after the articles are written, never on a failed run, so a retry
   * still sees the batch.
   */
  recordAbsorbed(agentId: string, entryIds: string[], citedIds: Set<string>): AbsorbLedgerRecord[] {
    this.getAgentWiki(agentId)
    return appendAbsorbLedger(this.ledgerPath(agentId), agentId, entryIds, citedIds)
  }

  private ledgerPath(agentId: string): string {
    return resolve(this.agentsDir, agentId, this.mode, ABSORB_LEDGER_FILE)
  }

  private absorbState(agentId: string): { cited: Set<string>; ledger: Map<string, AbsorbOutcome> } {
    const cited = new Set<string>()
    const index = this.getAgentWiki(agentId).rebuildIndex()
    for (const article of index.articles) {
      for (const s of article.sources ?? []) cited.add(s)
    }
    return { cited, ledger: readAbsorbLedger(this.ledgerPath(agentId)) }
  }

  summary(): AgentWikiSummary[] {
    const agents = this.listAgents()
    return agents.map(agentId => {
      const entries = this.getAgentEntries(agentId)
      const index = this.getAgentWiki(agentId).rebuildIndex()
      const { cited, ledger } = this.absorbState(agentId)
      let unabsorbed = 0
      let skipped = 0
      for (const e of entries) {
        if (cited.has(e.id)) continue
        const outcome = ledger.get(e.id)
        if (!outcome) unabsorbed++
        else if (outcome === "skipped") skipped++
      }

      return {
        agentId,
        totalEntries: entries.length,
        totalArticles: index.articles.length,
        unabsorbed,
        skipped,
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
  /** Read by absorb, cited by no article. Optional: remote peers may predate it. */
  skipped?: number
  articles: Array<{ title: string; path: string; tags?: string[] }>
}
