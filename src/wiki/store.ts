import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { resolve, join, relative, dirname, basename } from "path"
import type { WikiArticle, WikiArticleMeta, WikiEntry, WikiIndex, WikiAccess, WikiTreeNode } from "./types"
import { wikiTypeDir } from "./types"

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

    // Initialize schema if missing
    this.ensureSchema()
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
    this.appendLog("ingest", `${entry.id} from ${entry.agentId} via ${entry.source}`)
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
    // Path IS the hierarchy — no remapping. Path = position in the knowledge graph.
    const existing = this.readArticle(path)
    if (existing && !this.canWrite(existing.meta, agentId)) {
      this.log(`Permission denied: "${agentId}" cannot write "${path}" (owner: ${existing.meta.owner})`)
      return false
    }

    const fullPath = resolve(this.baseDir, path)
    mkdirSync(dirname(fullPath), { recursive: true })

    // Support both old "type" and new "kind" field
    const kind = meta.kind || (meta as any).type || "concept"

    const frontmatter = [
      "---",
      `title: "${meta.title}"`,
      `kind: ${kind}`,
    ]
    if (meta.parent) frontmatter.push(`parent: ${meta.parent}`)
    frontmatter.push(
      `owner: ${meta.owner}`,
      `access: ${meta.access}`,
    )
    if (meta.sharedWith?.length) {
      frontmatter.push(`shared_with: [${meta.sharedWith.map(s => `"${s}"`).join(", ")}]`)
    }
    frontmatter.push(
      `created: ${meta.created}`,
      `last_updated: ${meta.lastUpdated}`,
    )
    if (meta.refs?.length) {
      frontmatter.push(`refs: [${meta.refs.map(r => `"${r}"`).join(", ")}]`)
    }
    frontmatter.push(
      `sources: [${meta.sources.map(s => `"${s}"`).join(", ")}]`,
    )
    if (meta.tags?.length) {
      frontmatter.push(`tags: [${meta.tags.map(t => `"${t}"`).join(", ")}]`)
    }
    if (meta.date) frontmatter.push(`date: ${meta.date}`)
    if (meta.involves?.length) {
      frontmatter.push(`involves: [${meta.involves.map(i => `"${i}"`).join(", ")}]`)
    }
    frontmatter.push("---", "", content)

    writeFileSync(fullPath, frontmatter.join("\n"))
    const action = existing ? "update" : "create"
    this.appendLog(action, `${meta.title} (${kind}) by ${agentId} at ${path}`)
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
        kind: get("kind") || get("type") || "concept",  // "kind" is primary, "type" is legacy fallback
        parent: get("parent") || undefined,
        owner: get("owner"),
        access: (get("access") as WikiAccess) || "public",
        sharedWith: getArray("shared_with"),
        created: get("created"),
        lastUpdated: get("last_updated"),
        refs: getArray("refs") || getArray("related"),  // "refs" is primary, "related" is legacy
        sources: getArray("sources"),
        tags: getArray("tags"),
        date: get("date") || undefined,
        involves: getArray("involves"),
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
      const header = `\n## ${article.meta.title} (${article.meta.kind})`
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
        kind: article.meta.kind,
        parent: article.meta.parent,
        owner: article.meta.owner,
        access: article.meta.access,
        sharedWith: article.meta.sharedWith,
        aliases,
        backlinks: backlinks.get(article.meta.title) || 0,
        sources: article.meta.sources,
        lastUpdated: article.meta.lastUpdated,
        date: article.meta.date,
        involves: article.meta.involves,
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
    this.appendLog("rebuild-index", `${articles.length} articles indexed`)
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
      byType[article.meta.kind] = (byType[article.meta.kind] || 0) + 1
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

  // --- Log (chronological, append-only) ---

  /**
   * Append an entry to log.md.
   * Format: ## [YYYY-MM-DD HH:MM] action | details
   */
  appendLog(action: string, details: string): void {
    const logPath = resolve(this.baseDir, "log.md")
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16)
    const entry = `## [${timestamp}] ${action} | ${details}\n\n`

    if (!existsSync(logPath)) {
      writeFileSync(logPath, "# Wiki Log\n\nChronological record of all wiki operations.\n\n")
    }

    appendFileSync(logPath, entry)
  }

  /**
   * Get recent log entries.
   */
  getLog(limit: number = 20): string[] {
    const logPath = resolve(this.baseDir, "log.md")
    if (!existsSync(logPath)) return []

    const content = readFileSync(logPath, "utf-8")
    const entries = content.split(/^## /m).filter(e => e.startsWith("[")).slice(-limit)
    return entries.map(e => e.trim())
  }

  // --- Schema ---

  /**
   * Create _schema.md if it doesn't exist.
   * This tells the LLM how to operate on the wiki.
   */
  private ensureSchema(): void {
    const schemaPath = resolve(this.baseDir, "_schema.md")
    if (existsSync(schemaPath)) return

    const schema = `# Wiki Schema — Knowledge Graph

This wiki is a **living knowledge graph** — a mind map that's always being filled in.
Every article is a **node** in a tree. The path IS the hierarchy.

## The Graph

\`\`\`
wiki/
  raw/entries/                    # Shared inbox — immutable raw sources
  work/                           # Work context
    noqta/                        # Company
      team/                       # People and agents
        anis.md                   # (kind: person)
        nadia.md                  # (kind: agent)
      clients/                    # Client entities
        mtgl/                     # (kind: client)
          project.md              # (kind: project)
          repos/                  # Code repositories
          servers/                # Infrastructure
            staging.md            # (kind: server)
      processes/                  # How we do things
        deploy-staging.md         # (kind: process)
  events/                         # Timeline — cross-cutting
    2026-04-06/
      gitlab-token-expiry.md      # (kind: incident, involves: [work/noqta/clients/mtgl])
\`\`\`

## Node Kinds

### Entities — things that persist and have identity
| Kind | Use when |
|------|----------|
| person | A human being (employee, client contact) |
| agent | An AI agent in the system |
| company | A business entity |
| team | A group of people/agents |
| client | A customer or client |
| project | A specific deliverable or product |
| repo | A code repository |
| server | A deployment target or infrastructure |
| service | A running service or API |
| domain | A web domain |

### Occurrences — things that happen (have a date)
| Kind | Use when |
|------|----------|
| event | Something that happened |
| incident | Something that broke |
| deploy | A deployment action |
| decision | A choice that was made, with reasoning |

### Knowledge — what we know
| Kind | Use when |
|------|----------|
| process | How to do something (workflow, runbook) |
| pattern | A recurring behavior or template |
| concept | A definition or explanation |
| report | A periodic summary or metrics snapshot |

## Article Frontmatter

\`\`\`yaml
---
title: "MTGL Staging Server"
kind: server
parent: work/noqta/clients/mtgl/servers  # Position in tree
owner: devops-agent
access: public
created: 2026-04-06
last_updated: 2026-04-06
refs: ["work/noqta/clients/mtgl/project"]  # Cross-references
sources: ["entry-id-1"]
date: 2026-04-06        # For events: when it happened
involves: ["work/noqta/clients/mtgl"]  # For events: what entities
---
\`\`\`

## Rules

- The **path** is the hierarchy — \`work/noqta/team/nadia.md\` means Nadia is part of the Noqta team
- Use \`[[wikilinks]]\` to link between articles
- Every article traces back to raw sources via \`sources:\`
- Events always have a \`date\` and \`involves\` field
- Entities are things; everything else describes entities
- One topic per article — the graph grows by adding nodes, not by inflating articles

## Operations

### Absorb
Read raw entries → identify entities and events → place in the graph.
Ask: "What entity is this about? What happened? Where does it go in the tree?"

### Query
Navigate the tree → find relevant nodes → follow refs and wikilinks → synthesize.

### Lint
Check for: orphan nodes, missing parents, events without dates,
entities without descriptions, broken wikilinks.
`

    writeFileSync(schemaPath, schema)
    this.log("Created _schema.md")
  }

  // --- Wikilinks and Backlinks ---

  /**
   * Extract all [[wikilinks]] from article content.
   */
  extractWikilinks(content: string): string[] {
    const matches = content.match(/\[\[([^\]]+)\]\]/g) || []
    return matches.map(m => m.replace(/\[\[|\]\]/g, ""))
  }

  /**
   * Build backlinks index: for each article, which other articles link to it.
   */
  buildBacklinks(): Record<string, string[]> {
    const backlinks: Record<string, string[]> = {}

    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_") || relPath === "WIKI.md" || relPath === "log.md") return

      const content = readFileSync(filePath, "utf-8")
      const links = this.extractWikilinks(content)

      for (const link of links) {
        if (!backlinks[link]) backlinks[link] = []
        backlinks[link].push(relPath)
      }
    })

    // Save
    writeFileSync(
      resolve(this.baseDir, "_backlinks.json"),
      JSON.stringify(backlinks, null, 2),
    )

    return backlinks
  }

  /**
   * Get backlinks for a specific article title.
   */
  getBacklinks(title: string): string[] {
    const path = resolve(this.baseDir, "_backlinks.json")
    if (!existsSync(path)) return []
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"))
      return data[title] || []
    } catch {
      return []
    }
  }

  // --- Knowledge Graph: Tree / Mind Map ---

  /**
   * Build a tree from article paths.
   * The path IS the hierarchy: work/noqta/clients/mtgl.md → nested tree.
   */
  buildTree(): WikiTreeNode {
    const index = this.rebuildIndex()
    const root: WikiTreeNode = { path: "", title: "root", kind: "root", children: [], hasArticle: false }

    for (const article of index.articles) {
      // Parse path into segments: "work/noqta/team/nadia.md" → ["work", "noqta", "team", "nadia"]
      const segments = article.path.replace(/\.md$/, "").split("/")
      let current = root

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]
        let child = current.children.find(c => c.path === segments.slice(0, i + 1).join("/"))

        if (!child) {
          const isLeaf = i === segments.length - 1
          child = {
            path: segments.slice(0, i + 1).join("/"),
            title: isLeaf ? article.title : segment.replace(/-/g, " "),
            kind: isLeaf ? article.kind : "folder",
            children: [],
            articlePath: isLeaf ? article.path : undefined,
            hasArticle: isLeaf,
          }
          current.children.push(child)
        }

        // Update if this is the article node
        if (i === segments.length - 1) {
          child.title = article.title
          child.kind = article.kind
          child.articlePath = article.path
          child.hasArticle = true
        }

        current = child
      }
    }

    return root
  }

  /**
   * Get all events, sorted chronologically.
   * Events are articles with kind: event|incident|deploy or with a date field.
   */
  getTimeline(): Array<{ date: string; title: string; kind: string; path: string; involves: string[] }> {
    const index = this.rebuildIndex()
    const events: Array<{ date: string; title: string; kind: string; path: string; involves: string[] }> = []

    for (const article of index.articles) {
      const eventDate = article.date || article.lastUpdated
      if (!eventDate) continue

      const isEvent = ["event", "incident", "deploy", "decision"].includes(article.kind)
      if (isEvent || article.date) {
        events.push({
          date: eventDate,
          title: article.title,
          kind: article.kind,
          path: article.path,
          involves: article.involves || [],
        })
      }
    }

    return events.sort((a, b) => b.date.localeCompare(a.date))
  }

  // --- Lint ---

  /**
   * Run a lint pass on the wiki. Returns issues found.
   */
  lint(): Array<{ type: string; article: string; message: string }> {
    const issues: Array<{ type: string; article: string; message: string }> = []
    const allTitles = new Set<string>()
    const allLinks = new Map<string, string[]>() // article -> outbound links
    const articlePaths = new Map<string, string>() // title -> path

    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_") || relPath === "WIKI.md" || relPath === "log.md") return

      const article = this.readArticle(relPath)
      if (!article) return

      allTitles.add(article.meta.title)
      articlePaths.set(article.meta.title, relPath)

      const links = this.extractWikilinks(article.content)
      allLinks.set(relPath, links)

      // Check: article too long
      const lines = article.content.split("\n").length
      if (lines > 100) {
        issues.push({
          type: "bloated",
          article: relPath,
          message: `${lines} lines — consider splitting`,
        })
      }

      // Check: no sources
      if (!article.meta.sources?.length) {
        issues.push({
          type: "unsourced",
          article: relPath,
          message: "No sources listed in frontmatter",
        })
      }

      // Check: stub (too short)
      if (lines < 10 && article.content.trim().length < 100) {
        issues.push({
          type: "stub",
          article: relPath,
          message: "Very short article — needs enrichment",
        })
      }
    })

    // Check: broken wikilinks
    for (const [articlePath, links] of allLinks) {
      for (const link of links) {
        if (!allTitles.has(link)) {
          issues.push({
            type: "broken-link",
            article: articlePath,
            message: `[[${link}]] — target article not found`,
          })
        }
      }
    }

    // Check: orphan articles (no inbound links)
    const backlinks = this.buildBacklinks()
    for (const [title, path] of articlePaths) {
      if (!backlinks[title] || backlinks[title].length === 0) {
        issues.push({
          type: "orphan",
          article: path,
          message: `No other articles link to "${title}"`,
        })
      }
    }

    this.appendLog("lint", `Found ${issues.length} issues`)
    return issues
  }

  // --- Absorb summary (for automated cron) ---

  /**
   * Get unabsorbed entries (entries not referenced by any article's sources field).
   */
  getUnabsorbedEntries(): WikiEntry[] {
    const allSources = new Set<string>()

    // Collect all source IDs referenced by articles
    this.walkDir(this.baseDir, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const relPath = relative(this.baseDir, filePath)
      if (relPath.startsWith("raw/") || relPath.startsWith("_")) return

      const article = this.readArticle(relPath)
      if (article?.meta.sources) {
        for (const s of article.meta.sources) allSources.add(s)
      }
    })

    // Find entries not in any article's sources
    const entries = this.listEntries()
    return entries.filter(e => !allSources.has(e.id))
  }

  /**
   * Build an absorb prompt for unprocessed entries.
   * Returns a prompt string an agent can execute to compile entries into articles.
   */
  buildAbsorbPrompt(maxEntries: number = 20): string | null {
    const unabsorbed = this.getUnabsorbedEntries().slice(0, maxEntries)
    if (unabsorbed.length === 0) return null

    const entrySummaries = unabsorbed.map(e =>
      `[${e.date} ${e.agentId} via ${e.source}] ${e.content.slice(0, 200)}`
    ).join("\n\n")

    return `/wiki absorb\n\nThere are ${unabsorbed.length} unprocessed entries. Read each, understand what it means, and create or update wiki articles.\n\n${entrySummaries}`
  }

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
