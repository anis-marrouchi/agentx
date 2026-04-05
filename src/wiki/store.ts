import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { resolve, join, relative, dirname } from "path"
import type { WikiArticle, WikiArticleMeta, WikiEntry, WikiIndex, WikiAccess } from "./types"

// --- Wiki Store: filesystem-based knowledge base with permissions ---
//
// Structure:
//   .agentx/wiki/
//     _index.md          # Master index with aliases
//     _backlinks.json    # Reverse link index
//     raw/entries/        # One .md per ingested entry
//     {directories}/     # Articles organized by type
//
// Permission model:
//   - private: only owner agent reads/writes
//   - shared: owner writes, listed agents read
//   - public: owner writes, all agents read

export class WikiStore {
  private baseDir: string
  private rawDir: string
  private log: (...args: unknown[]) => void

  constructor(
    baseDir: string = resolve(process.cwd(), ".agentx/wiki"),
    log: (...args: unknown[]) => void = console.error.bind(console, "[wiki]"),
  ) {
    this.baseDir = baseDir
    this.rawDir = resolve(baseDir, "raw/entries")
    this.log = log

    mkdirSync(this.rawDir, { recursive: true })
    mkdirSync(resolve(baseDir, "raw"), { recursive: true })
  }

  // --- Permission checks ---

  /**
   * Check if an agent can read an article.
   */
  canRead(article: WikiArticleMeta, agentId: string): boolean {
    if (article.access === "public") return true
    if (article.owner === agentId) return true
    if (article.access === "shared" && article.sharedWith?.includes(agentId)) return true
    return false
  }

  /**
   * Check if an agent can write an article.
   */
  canWrite(article: WikiArticleMeta, agentId: string): boolean {
    return article.owner === agentId
  }

  // --- Raw entries (ingestion) ---

  /**
   * Add a raw entry (from a conversation, cron result, etc.)
   */
  addEntry(entry: WikiEntry): string {
    const filename = `${entry.date}_${entry.id}.md`
    const filepath = resolve(this.rawDir, filename)

    const frontmatter = [
      "---",
      `id: ${entry.id}`,
      `date: ${entry.date}`,
      `agent: ${entry.agentId}`,
      `source: ${entry.source}`,
    ]
    if (entry.sourceContext) frontmatter.push(`context: ${entry.sourceContext}`)
    if (entry.meta) {
      for (const [k, v] of Object.entries(entry.meta)) {
        frontmatter.push(`${k}: ${JSON.stringify(v)}`)
      }
    }
    frontmatter.push("---", "", entry.content)

    writeFileSync(filepath, frontmatter.join("\n"))
    return filename
  }

  /**
   * List raw entries, optionally filtered by agent or date range.
   */
  listEntries(filter?: { agentId?: string; after?: string; before?: string }): WikiEntry[] {
    if (!existsSync(this.rawDir)) return []

    const files = readdirSync(this.rawDir).filter(f => f.endsWith(".md")).sort()
    const entries: WikiEntry[] = []

    for (const file of files) {
      const content = readFileSync(resolve(this.rawDir, file), "utf-8")
      const entry = this.parseEntry(content, file)
      if (!entry) continue

      if (filter?.agentId && entry.agentId !== filter.agentId) continue
      if (filter?.after && entry.date < filter.after) continue
      if (filter?.before && entry.date > filter.before) continue

      entries.push(entry)
    }

    return entries
  }

  private parseEntry(content: string, filename: string): WikiEntry | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) return null

    const fm = fmMatch[1]
    const body = fmMatch[2].trim()

    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
      return m?.[1]?.trim() || ""
    }

    return {
      id: get("id") || filename.replace(".md", ""),
      date: get("date"),
      agentId: get("agent"),
      source: get("source"),
      sourceContext: get("context") || undefined,
      content: body,
    }
  }

  // --- Articles (compiled knowledge) ---

  /**
   * Write or update a wiki article.
   */
  writeArticle(
    path: string,
    meta: WikiArticleMeta,
    content: string,
    agentId: string,
  ): boolean {
    // Check write permission if article exists
    const existing = this.readArticle(path)
    if (existing && !this.canWrite(existing.meta, agentId)) {
      this.log(`Permission denied: "${agentId}" cannot write "${path}" (owner: ${existing.meta.owner})`)
      return false
    }

    const fullPath = resolve(this.baseDir, path)
    mkdirSync(dirname(fullPath), { recursive: true })

    const frontmatter = [
      "---",
      `title: "${meta.title}"`,
      `type: ${meta.type}`,
      `owner: ${meta.owner}`,
      `access: ${meta.access}`,
    ]
    if (meta.sharedWith?.length) {
      frontmatter.push(`shared_with: [${meta.sharedWith.map(s => `"${s}"`).join(", ")}]`)
    }
    frontmatter.push(
      `created: ${meta.created}`,
      `last_updated: ${meta.lastUpdated}`,
      `related: [${meta.related.map(r => `"${r}"`).join(", ")}]`,
      `sources: [${meta.sources.map(s => `"${s}"`).join(", ")}]`,
    )
    if (meta.tags?.length) {
      frontmatter.push(`tags: [${meta.tags.map(t => `"${t}"`).join(", ")}]`)
    }
    frontmatter.push("---", "", content)

    writeFileSync(fullPath, frontmatter.join("\n"))
    return true
  }

  /**
   * Read an article. Returns null if not found.
   */
  readArticle(path: string): WikiArticle | null {
    const fullPath = resolve(this.baseDir, path)
    if (!existsSync(fullPath)) return null

    const raw = readFileSync(fullPath, "utf-8")
    return this.parseArticle(raw, path)
  }

  /**
   * Read an article with permission check.
   */
  readArticleAs(path: string, agentId: string): WikiArticle | null {
    const article = this.readArticle(path)
    if (!article) return null
    if (!this.canRead(article.meta, agentId)) return null
    return article
  }

  private parseArticle(raw: string, path: string): WikiArticle | null {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) return null

    const fm = fmMatch[1]
    const content = fmMatch[2].trim()

    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
      return m?.[1]?.trim().replace(/^"(.*)"$/, "$1") || ""
    }

    const getArray = (key: string): string[] => {
      const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m"))
      if (!m) return []
      return m[1].split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
    }

    return {
      meta: {
        title: get("title"),
        type: get("type"),
        owner: get("owner"),
        access: (get("access") as WikiAccess) || "public",
        sharedWith: getArray("shared_with"),
        created: get("created"),
        lastUpdated: get("last_updated"),
        related: getArray("related"),
        sources: getArray("sources"),
        tags: getArray("tags"),
      },
      content,
      path,
    }
  }

  // --- Index and discovery ---

  /**
   * List all articles accessible to an agent.
   */
  listArticles(agentId: string): WikiArticle[] {
    const articles: WikiArticle[] = []
    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_")) return

      const article = this.readArticle(relPath)
      if (article && this.canRead(article.meta, agentId)) {
        articles.push(article)
      }
    })
    return articles
  }

  /**
   * Search articles by keyword. Returns articles the agent can read.
   */
  search(query: string, agentId: string, maxResults: number = 10): WikiArticle[] {
    const queryLower = query.toLowerCase()
    const results: Array<{ article: WikiArticle; score: number }> = []

    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_")) return

      const article = this.readArticle(relPath)
      if (!article || !this.canRead(article.meta, agentId)) return

      let score = 0
      const titleLower = article.meta.title.toLowerCase()
      const contentLower = article.content.toLowerCase()

      // Title match scores highest
      if (titleLower.includes(queryLower)) score += 10
      // Tag match
      if (article.meta.tags?.some(t => t.toLowerCase().includes(queryLower))) score += 5
      // Content match (count occurrences, cap at 5)
      const occurrences = (contentLower.match(new RegExp(queryLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length
      score += Math.min(occurrences, 5)

      if (score > 0) {
        results.push({ article, score })
      }
    })

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => r.article)
  }

  /**
   * Find articles relevant to a message (for context injection).
   * Extracts keywords from the message and searches the wiki.
   */
  findRelevant(message: string, agentId: string, maxArticles: number = 3): WikiArticle[] {
    // Extract meaningful keywords (skip common words)
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "can", "shall", "to", "of", "in", "for",
      "on", "with", "at", "by", "from", "as", "into", "about", "through",
      "and", "but", "or", "not", "no", "if", "then", "so", "what", "how",
      "when", "where", "who", "which", "that", "this", "it", "i", "you",
      "we", "they", "he", "she", "me", "my", "your", "our", "their",
      "please", "just", "also", "very", "much", "some", "any", "all",
    ])

    const words = message.toLowerCase()
      .replace(/[^a-z0-9\s@_-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))

    if (words.length === 0) return []

    // Score articles by keyword matches
    const articleScores = new Map<string, { article: WikiArticle; score: number }>()

    for (const word of words) {
      const matches = this.search(word, agentId, 5)
      for (const article of matches) {
        const existing = articleScores.get(article.path)
        if (existing) {
          existing.score += 1
        } else {
          articleScores.set(article.path, { article, score: 1 })
        }
      }
    }

    return Array.from(articleScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxArticles)
      .map(r => r.article)
  }

  /**
   * Build context string from relevant wiki articles for prompt injection.
   * Token-efficient: includes title + first ~500 chars of each article.
   */
  buildContext(articles: WikiArticle[], maxChars: number = 4000): string {
    if (articles.length === 0) return ""

    const lines: string[] = ["[Wiki Knowledge]"]

    let totalChars = 0
    for (const article of articles) {
      const header = `\n## ${article.meta.title} (${article.meta.type})`
      const body = article.content.length > 600
        ? article.content.slice(0, 600) + "..."
        : article.content

      const chunk = header + "\n" + body
      if (totalChars + chunk.length > maxChars) break

      lines.push(chunk)
      totalChars += chunk.length
    }

    lines.push("\n[End Wiki Knowledge]")
    return lines.join("\n")
  }

  /**
   * Rebuild the master index.
   */
  rebuildIndex(): WikiIndex {
    const articles: WikiIndex["articles"] = []
    const backlinks = new Map<string, number>()

    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_")) return

      const article = this.readArticle(relPath)
      if (!article) return

      // Count wikilinks for backlinks
      const links = article.content.match(/\[\[([^\]]+)\]\]/g) || []
      for (const link of links) {
        const target = link.replace(/\[\[|\]\]/g, "")
        backlinks.set(target, (backlinks.get(target) || 0) + 1)
      }

      // Extract aliases from title and tags
      const aliases = [article.meta.title.toLowerCase()]
      if (article.meta.tags) {
        aliases.push(...article.meta.tags.map(t => t.toLowerCase()))
      }

      articles.push({
        path: relPath,
        title: article.meta.title,
        type: article.meta.type,
        owner: article.meta.owner,
        access: article.meta.access,
        sharedWith: article.meta.sharedWith,
        aliases,
        backlinks: backlinks.get(article.meta.title) || 0,
      })
    })

    const index: WikiIndex = {
      articles,
      lastRebuilt: new Date().toISOString(),
    }

    // Write index files
    writeFileSync(
      resolve(this.baseDir, "_index.json"),
      JSON.stringify(index, null, 2),
    )

    // Write human-readable WIKI.md
    const md = ["# Wiki Index", "", `Last rebuilt: ${index.lastRebuilt}`, ""]
    const byType = new Map<string, typeof articles>()
    for (const a of articles) {
      const list = byType.get(a.type) || []
      list.push(a)
      byType.set(a.type, list)
    }

    for (const [type, list] of Array.from(byType.entries()).sort()) {
      md.push(`## ${type}`, "")
      for (const a of list.sort((x, y) => x.title.localeCompare(y.title))) {
        const access = a.access === "private" ? " (private)" : a.access === "shared" ? " (shared)" : ""
        md.push(`- [${a.title}](${a.path})${access} — owner: ${a.owner}`)
      }
      md.push("")
    }

    writeFileSync(resolve(this.baseDir, "WIKI.md"), md.join("\n"))

    this.log(`Index rebuilt: ${articles.length} articles`)
    return index
  }

  /**
   * Get wiki stats.
   */
  stats(): {
    totalArticles: number
    totalEntries: number
    articlesByType: Record<string, number>
    articlesByAccess: Record<string, number>
    articlesByOwner: Record<string, number>
  } {
    let totalArticles = 0
    const byType: Record<string, number> = {}
    const byAccess: Record<string, number> = {}
    const byOwner: Record<string, number> = {}

    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_") || relPath === "WIKI.md") return

      const article = this.readArticle(relPath)
      if (!article) return

      totalArticles++
      byType[article.meta.type] = (byType[article.meta.type] || 0) + 1
      byAccess[article.meta.access] = (byAccess[article.meta.access] || 0) + 1
      byOwner[article.meta.owner] = (byOwner[article.meta.owner] || 0) + 1
    })

    const entryFiles = existsSync(this.rawDir)
      ? readdirSync(this.rawDir).filter(f => f.endsWith(".md")).length
      : 0

    return {
      totalArticles,
      totalEntries: entryFiles,
      articlesByType: byType,
      articlesByAccess: byAccess,
      articlesByOwner: byOwner,
    }
  }

  // --- Helpers ---

  private walkDir(dir: string, callback: (filePath: string) => void): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        this.walkDir(full, callback)
      } else {
        callback(full)
      }
    }
  }
}
