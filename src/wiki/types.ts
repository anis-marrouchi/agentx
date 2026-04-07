// --- Wiki knowledge base types ---

/**
 * Canonical article types with enforced directory mapping.
 * Each type maps to a directory and a human-readable label.
 * This is the Karpathy hierarchy — applied per agent.
 */
export const WIKI_TYPES = {
  concept:    { dir: "concepts",    label: "Concepts",    icon: "?" },
  project:    { dir: "projects",    label: "Projects",    icon: "P" },
  process:    { dir: "processes",   label: "Processes",   icon: ">" },
  decision:   { dir: "decisions",   label: "Decisions",   icon: "D" },
  pattern:    { dir: "patterns",    label: "Patterns",    icon: "~" },
  person:     { dir: "people",      label: "People",      icon: "@" },
  incident:   { dir: "incidents",   label: "Incidents",   icon: "!" },
  report:     { dir: "reports",     label: "Reports",     icon: "#" },
} as const

export type WikiType = keyof typeof WIKI_TYPES

export function wikiTypeDir(type: string): string {
  const entry = WIKI_TYPES[type as WikiType]
  return entry ? entry.dir : type + "s"
}

export function wikiTypeLabel(type: string): string {
  const entry = WIKI_TYPES[type as WikiType]
  return entry ? entry.label : type.charAt(0).toUpperCase() + type.slice(1)
}

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
