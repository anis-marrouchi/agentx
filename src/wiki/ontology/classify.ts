// --- Give a wiki page its ontology type (#811) ---

import type { WikiArticleMeta } from "../types"
import type { Ontology } from "./types"

const patternCache = new Map<string, RegExp | null>()

function titlePattern(src: string): RegExp | null {
  if (!patternCache.has(src)) {
    try {
      patternCache.set(src, new RegExp(src, "i"))
    } catch {
      patternCache.set(src, null) // reported by checkOntology; the rule never matches
    }
  }
  return patternCache.get(src) ?? null
}

/**
 * The page's own `class` when the ontology knows it, else the first
 * classify rule whose every condition matches, else the fallback type.
 * `path` is relative to the agent's wiki, e.g. `clients/example.md`.
 */
export function classifyPage(meta: WikiArticleMeta, path: string, o: Ontology): string {
  const known = new Set(o.types.map(t => t.id))
  if (meta.class && known.has(meta.class)) return meta.class

  const folders = path.split("/").slice(0, -1).map(f => f.toLowerCase())
  const tags = new Set((meta.tags ?? []).map(t => t.toLowerCase()))
  for (const rule of o.classify) {
    if (!known.has(rule.type)) continue
    let conditions = 0
    if (rule.legacy) {
      conditions++
      if (!meta.type || !rule.legacy.includes(meta.type)) continue
    }
    if (rule.path) {
      conditions++
      if (!rule.path.some(p => folders.includes(p.toLowerCase()))) continue
    }
    if (rule.tags) {
      conditions++
      if (!rule.tags.some(t => tags.has(t.toLowerCase()))) continue
    }
    if (rule.title) {
      conditions++
      const re = titlePattern(rule.title)
      if (!re || !re.test(meta.title)) continue
    }
    if (conditions > 0) return rule.type
  }
  return known.has(o.fallback_type) ? o.fallback_type : o.types[0].id
}
