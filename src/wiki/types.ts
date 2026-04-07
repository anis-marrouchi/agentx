// --- Wiki knowledge graph types ---
//
// The wiki is a living knowledge graph, not a flat article list.
// Every article is a NODE in a tree. The path IS the hierarchy.
// Events are cross-cutting — they happen at any node.
//
// Example tree:
//   work/noqta/                    (company entity)
//   work/noqta/team/nadia          (person entity)
//   work/noqta/clients/mtgl/       (client entity)
//   work/noqta/clients/mtgl/repos/ (repo entities)
//   events/2026-04-06/gitlab-token-expiry (event referencing noqta, mtgl)

/**
 * Node kinds — what IS this article?
 *
 * Entities persist and have identity. Everything else describes entities.
 */
export const NODE_KINDS = {
  // Entities — things that exist and persist
  person:       { label: "Person",       icon: "@", isEntity: true },
  company:      { label: "Company",      icon: "C", isEntity: true },
  team:         { label: "Team",         icon: "T", isEntity: true },
  client:       { label: "Client",       icon: "$", isEntity: true },
  project:      { label: "Project",      icon: "P", isEntity: true },
  repo:         { label: "Repository",   icon: "R", isEntity: true },
  server:       { label: "Server",       icon: "S", isEntity: true },
  agent:        { label: "Agent",        icon: "A", isEntity: true },
  service:      { label: "Service",      icon: "~", isEntity: true },
  domain:       { label: "Domain",       icon: "D", isEntity: true },
  // Occurrences — things that happen
  event:        { label: "Event",        icon: "!", isEntity: false },
  incident:     { label: "Incident",     icon: "X", isEntity: false },
  deploy:       { label: "Deploy",       icon: ">", isEntity: false },
  decision:     { label: "Decision",     icon: "?", isEntity: false },
  // Knowledge — what we know
  process:      { label: "Process",      icon: ">", isEntity: false },
  pattern:      { label: "Pattern",      icon: "~", isEntity: false },
  concept:      { label: "Concept",      icon: "i", isEntity: false },
  report:       { label: "Report",       icon: "#", isEntity: false },
} as const

export type NodeKind = keyof typeof NODE_KINDS

export function nodeKindLabel(kind: string): string {
  const entry = NODE_KINDS[kind as NodeKind]
  return entry ? entry.label : kind.charAt(0).toUpperCase() + kind.slice(1)
}

export function isEntityKind(kind: string): boolean {
  const entry = NODE_KINDS[kind as NodeKind]
  return entry?.isEntity ?? false
}

/**
 * Access levels for wiki articles.
 */
export type WikiAccess = "private" | "shared" | "public"

/**
 * Article metadata — each article is a node in the knowledge graph.
 */
export interface WikiArticleMeta {
  title: string
  kind: string                    // NodeKind — what IS this (person, project, event, etc.)
  parent?: string                 // Path to parent node (e.g., "work/noqta" for a team member)
  owner: string                   // Agent ID that created/owns this article
  access: WikiAccess
  sharedWith?: string[]
  created: string                 // ISO date
  lastUpdated: string             // ISO date
  refs: string[]                  // Paths to related entities (cross-references)
  sources: string[]               // Raw entry IDs this was compiled from
  tags?: string[]
  // Event-specific fields
  date?: string                   // When the event occurred (ISO date)
  involves?: string[]             // Entity paths involved in this event
}

export interface WikiArticle {
  meta: WikiArticleMeta
  content: string
  path: string                    // Path in tree = position in hierarchy
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

/**
 * Tree node for the knowledge graph.
 */
export interface WikiTreeNode {
  path: string
  title: string
  kind: string
  children: WikiTreeNode[]
  articlePath?: string            // Path to the article file (if exists)
  hasArticle: boolean
}

export interface WikiIndex {
  articles: Array<{
    path: string
    title: string
    kind: string
    parent?: string
    owner: string
    access: WikiAccess
    sharedWith?: string[]
    aliases: string[]
    backlinks: number
    sources?: string[]
    lastUpdated?: string
    date?: string
    involves?: string[]
  }>
  lastRebuilt: string
}

// --- Backward compat: map old "type" field to "kind" ---
export function normalizeKind(typeOrKind: string): string {
  return typeOrKind // kinds are now a superset of old types
}

// Legacy helpers (used by store.ts internals)
export function wikiTypeDir(kind: string): string {
  return kind
}

export function wikiTypeLabel(kind: string): string {
  return nodeKindLabel(kind)
}

// Legacy alias
export type WikiType = NodeKind
export const WIKI_TYPES = NODE_KINDS
