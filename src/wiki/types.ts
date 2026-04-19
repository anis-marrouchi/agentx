// --- Wiki types ---
//
// Karpathy/Farzapedia pattern: plain files, LLM-chosen structure, articles
// organized by `type` with wikilinks (`related`) as the primary navigation
// surface. `_index.md` is the catalog; tags are a secondary hint, no longer
// load-bearing. See blog/wiki-karpathy-review for the why.

export type WikiAccess = "private" | "shared" | "public"

/**
 * Article type — the organizational spine. Matches Farzapedia's
 * `type: person | project | place | concept | event`, extended with
 * `decision` and `pattern` for workflow-heavy corpora.
 * Optional on legacy articles; Phase 2 migration backfills it.
 */
export type WikiArticleType =
  | "person"
  | "project"
  | "place"
  | "concept"
  | "event"
  | "decision"
  | "pattern"

/**
 * Article metadata. `type` + `related` are the primary retrieval surface;
 * tags remain as a secondary hint but are no longer central.
 */
export interface WikiArticleMeta {
  title: string
  /** Organizational spine — Phase 2 migration backfills any missing values. */
  type?: WikiArticleType
  /** Wikilink targets (by title) — persisted from `[[wikilinks]]` in body. */
  related?: string[]
  /** Secondary hint, no longer the retrieval spine. */
  tags: string[]
  owner: string                    // Agent ID
  access: WikiAccess
  sharedWith?: string[]
  created: string
  lastUpdated: string
  sources: string[]                // Raw entry IDs
  /** Intent graph path (root → leaf node ids) when the article was authored
   *  under an active intent graph. Empty for legacy articles — retrieval
   *  falls back to pure BM25 for those. */
  graphPath?: string[]
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
    type?: WikiArticleType
    related?: string[]
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
