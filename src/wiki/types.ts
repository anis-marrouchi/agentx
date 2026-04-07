// --- Wiki types ---
//
// Karpathy pattern: plain files, LLM-chosen structure, aggressive tagging.
// The wiki is a compounding artifact. Structure emerges from data.
// No rigid ontology — the LLM decides how to organize.
// Tags are the primary mechanism for context narrowing.

export type WikiAccess = "private" | "shared" | "public"

/**
 * Article metadata. Intentionally minimal — tags do the heavy lifting.
 */
export interface WikiArticleMeta {
  title: string
  tags: string[]                   // Aggressive tagging — the more the better
  owner: string                    // Agent ID
  access: WikiAccess
  sharedWith?: string[]
  created: string
  lastUpdated: string
  sources: string[]                // Raw entry IDs
}

export interface WikiArticle {
  meta: WikiArticleMeta
  content: string                  // Markdown body — may contain section tags
  path: string                     // LLM-chosen path — structure emerges from data
}

export interface WikiEntry {
  id: string
  date: string
  agentId: string
  source: string
  sourceContext?: string
  content: string
  meta?: Record<string, unknown>
}

export interface WikiIndex {
  articles: Array<{
    path: string
    title: string
    tags: string[]
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
