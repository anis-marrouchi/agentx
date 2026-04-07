// --- Wiki knowledge base types ---

/**
 * Access levels for wiki articles:
 * - private: only the owning agent can read/write
 * - shared: specific agents listed in `sharedWith` can read, owner can write
 * - public: all agents on this node can read, owner can write
 */
export type WikiAccess = "private" | "shared" | "public"

export interface WikiArticleMeta {
  title: string
  type: string                  // person, project, concept, decision, pattern, etc.
  owner: string                 // agent ID that created/owns this article
  access: WikiAccess
  sharedWith?: string[]         // agent IDs (only for access: "shared")
  created: string               // ISO date
  lastUpdated: string           // ISO date
  related: string[]             // wikilinks to other articles
  sources: string[]             // raw entry IDs
  tags?: string[]
}

export interface WikiArticle {
  meta: WikiArticleMeta
  content: string               // markdown body
  path: string                  // relative path within wiki dir
}

export interface WikiEntry {
  id: string
  date: string
  agentId: string
  source: string                // "telegram", "cron", "api", "manual"
  sourceContext?: string         // group name, cron job id, etc.
  content: string
  meta?: Record<string, unknown>
}

export interface WikiIndex {
  articles: Array<{
    path: string
    title: string
    type: string
    owner: string
    access: WikiAccess
    sharedWith?: string[]
    aliases: string[]
    backlinks: number
    sources?: string[]
    lastUpdated?: string
  }>
  lastRebuilt: string
}
