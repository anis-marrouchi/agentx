import { WikiStore } from "./store"
import { resolve } from "path"
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs"
import type { WikiEntry } from "./types"

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

  listAgents(entries: WikiEntry[] = this.sharedStore.listEntries()): string[] {
    const agents = new Set<string>()

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
   * Entries absorb has not dealt with yet: no article cites them and no
   * successful absorb run has read them. Without the second check an
   * entry absorb read and chose not to cite came back on every run, and
   * a backfill kept re-reading the head of the queue (#762).
   */
  getUnabsorbedEntries(agentId: string): WikiEntry[] {
    return this.classifyEntries(agentId).pending
  }

  /**
   * Record every entry handed to the model in a successful absorb run,
   * cited or not. Callers must not call this for a failed run, so those
   * entries are offered again.
   */
  markProcessed(agentId: string, entryIds: string[], citedIds: Iterable<string>): void {
    const cited = new Set(citedIds)
    const ledger = this.readLedger(agentId)
    const at = new Date().toISOString()
    for (const id of entryIds) ledger.entries[id] = { at, cited: cited.has(id) }

    const file = this.ledgerPath(agentId)
    mkdirSync(resolve(file, ".."), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`)
    renameSync(tmp, file)
  }

  /**
   * Counts and articles per agent, for `GET /wiki/agents` and the mesh.
   * The raw entries are read once and grouped here: reading them again
   * per agent made the endpoint take 25 to 75 s on a fleet with 30
   * agents and 10k entries, past the mesh client's 5 s timeout (#603).
   */
  summary(): AgentWikiSummary[] {
    const entries = this.sharedStore.listEntries()
    const byAgent = new Map<string, WikiEntry[]>()
    for (const e of entries) {
      const list = byAgent.get(e.agentId)
      if (list) list.push(e)
      else byAgent.set(e.agentId, [e])
    }
    return this.listAgents(entries).map(agentId => {
      const { all, cited, read, pending, articles } = this.classifyEntries(agentId, byAgent.get(agentId) ?? [])
      return {
        agentId,
        totalEntries: all.length,
        totalArticles: articles.length,
        cited: cited.length,
        readNotCited: read.length,
        unabsorbed: pending.length,
        articles,
      }
    })
  }

  /** Split an agent's entries into cited by an article, read but not cited, and pending. */
  private classifyEntries(agentId: string, all: WikiEntry[] = this.getAgentEntries(agentId)) {
    const articles = this.getAgentWiki(agentId).rebuildIndex().articles

    const citedIds = new Set<string>()
    for (const article of articles) {
      if (article.sources) {
        for (const s of article.sources) citedIds.add(s)
      }
    }
    const ledger = this.readLedger(agentId).entries

    const cited: WikiEntry[] = []
    const read: WikiEntry[] = []
    const pending: WikiEntry[] = []
    for (const e of all) {
      if (citedIds.has(e.id)) cited.push(e)
      else if (ledger[e.id]) read.push(e)
      else pending.push(e)
    }
    return { all, cited, read, pending, articles }
  }

  /**
   * The peer an agent's articles were copied from by `wiki sync --articles`,
   * or null for an agent this node absorbs itself. A copied agent is
   * read-only here: absorb and patch leave it to its home node.
   */
  syncedFrom(agentId: string): SyncedFrom | null {
    const file = resolve(this.agentsDir, agentId, "_synced.json")
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as SyncedFrom
    } catch (err) {
      // A damaged marker still means the agent lives elsewhere.
      this.log(`synced marker ${file} is not valid JSON: ${(err as Error).message}`)
      return { node: "unknown", peerUrl: "", at: "" }
    }
  }

  markSynced(agentId: string, from: SyncedFrom): void {
    const file = resolve(this.agentsDir, agentId, "_synced.json")
    mkdirSync(resolve(file, ".."), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(from, null, 2)}\n`)
    renameSync(tmp, file)
  }

  /** agents/<id>/_absorbed.json — shared by every mode, like the raw entries. */
  private ledgerPath(agentId: string): string {
    return resolve(this.agentsDir, agentId, "_absorbed.json")
  }

  private readLedger(agentId: string): AbsorbLedger {
    const file = this.ledgerPath(agentId)
    if (!existsSync(file)) return { entries: {} }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as AbsorbLedger
      return { entries: parsed.entries ?? {} }
    } catch (err) {
      // Treating a damaged ledger as empty would let the next run
      // overwrite it and re-queue everything it recorded.
      throw new Error(`absorb ledger ${file} is not valid JSON: ${(err as Error).message}`)
    }
  }
}

export interface SyncedFrom {
  /** The peer's node id. */
  node: string
  peerUrl: string
  /** When the last copy finished. */
  at: string
}

interface AbsorbLedger {
  entries: Record<string, { at: string; cited: boolean }>
}

export interface AgentWikiSummary {
  agentId: string
  totalEntries: number
  totalArticles: number
  /** Entries an article cites. */
  cited: number
  /** Entries a successful absorb run read and did not cite. */
  readNotCited: number
  /** Entries absorb has not read yet. */
  unabsorbed: number
  articles: Array<{ title: string; path: string; tags?: string[] }>
}
