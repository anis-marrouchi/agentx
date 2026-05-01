import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs"
import { join } from "path"
import type { GraphStore } from "./store"
import { type IndexFile, indexFileSchema, type Classification, classificationSchema } from "./types"

// --- Phase 2 of classifier-retire — bulk remap of past classifications ---
//
// The Phase 1 schema migration auto-converts schema.json + nodes.json from
// v1 (scope/location/org/unit/activity) → v2 (category/verb). It does NOT
// touch the two stores that hold real classification history:
//
//   classifications.jsonl  — append-only audit log of every decision
//   index.json             — fingerprint → path cache used at hot-path
//
// Without remapping those, every recurring message keeps hitting the cache
// and resolving to a v1 path that no longer exists in nodes.json. The UI
// then renders raw ids ("activity-rotate-tokens") instead of the verb
// label ("Rotate credential"). This module rewrites them in-place via
// keyword heuristics — no LLM calls, no paid path.
//
// Idempotent: re-running on already-v2 data is a no-op.

const CATEGORY_SET = new Set([
  "code", "ops", "support", "admin", "knowledge", "social", "system",
])

/** Best-effort keyword mapping from a v1 leaf slug to a v2 (category, verb)
 *  pair. Patterns are checked in order; first match wins. Anything that
 *  doesn't hit a pattern is left alone (the next live classification will
 *  re-classify the fingerprint with the new prompt). */
const PATTERNS: Array<{ test: RegExp; category: string; verb: string }> = [
  // --- code ---
  { test: /\b(review[-_.]?(merge[-_.]?request|mr|pull[-_.]?request|pr))\b/i, category: "code", verb: "review.merge-request" },
  { test: /\breview[-_.]?(code|change|diff|snippet)\b/i,                     category: "code", verb: "review.code-change" },
  { test: /\b(fix|patch)[-_.]/i,                                              category: "code", verb: "fix.bug" },
  { test: /\b(implement|build|add)[-_.]?(feature|cli|api|endpoint)\b/i,       category: "code", verb: "implement.feature" },
  { test: /\bimplement[-_.]/i,                                                category: "code", verb: "implement.feature" },
  { test: /\b(debug|investigate)[-_.]/i,                                      category: "code", verb: "investigate.error" },
  { test: /\brefactor\b/i,                                                    category: "code", verb: "refactor.code" },
  { test: /\b(plan|spec|rfc|design)[-_.]/i,                                   category: "code", verb: "spec.feature" },
  { test: /\b(handle|triage)[-_.]?(github|gitlab)?[-_.]?(issue|push|pr|mr|webhook|comment)\b/i, category: "code", verb: "triage.issue" },
  { test: /\btriage[-_.]?(issue|ticket)?\b/i,                                 category: "code", verb: "triage.issue" },
  { test: /\banswer[-_.]?(code[-_.]?question|technical[-_.]?question)\b/i,    category: "code", verb: "answer.code-question" },
  { test: /\b(commit|push|checkout|sync|merge)[-_.]/i,                        category: "code", verb: "refactor.code" },
  { test: /\bauthor[-_.]?(workflow|spec|rfc)\b/i,                             category: "code", verb: "spec.feature" },

  // --- ops ---
  { test: /\bdeploy[-_.]?(staging|preview|qa|test)\b/i,                       category: "ops", verb: "deploy.staging" },
  { test: /\bdeploy[-_.]?(prod|production|live|release)\b/i,                  category: "ops", verb: "deploy.production" },
  { test: /\bdeploy[-_.]/i,                                                   category: "ops", verb: "deploy.staging" },
  { test: /\brollback\b/i,                                                    category: "ops", verb: "rollback.release" },
  { test: /\binvestigate[-_.]?incident\b/i,                                   category: "ops", verb: "investigate.incident" },
  { test: /\b(monitor|status|health[-_.]?check|metrics)\b/i,                  category: "ops", verb: "monitor.system" },
  { test: /\b(restart|stop|start)[-_.]?(daemon|service|server)\b/i,           category: "ops", verb: "monitor.system" },
  { test: /\brun[-_.]?(server|infra)?[-_.]?(security|audit)\b/i,              category: "ops", verb: "audit.security" },
  { test: /\brotate[-_.]?(token|tokens|credential|credentials|key|cert|secret)s?\b/i, category: "ops", verb: "rotate.credential" },
  { test: /\baudit\b/i,                                                       category: "ops", verb: "audit.security" },
  { test: /\bsetup[-_.]/i,                                                    category: "ops", verb: "monitor.system" },

  // --- support ---
  { test: /\b(greet(ing)?|hello|hi[-_.]?there)\b/i,                           category: "support", verb: "chat.greeting" },
  { test: /\b(support[-_.]?request|help[-_.]?request|customer[-_.]?question)\b/i, category: "support", verb: "chat.support-request" },
  { test: /\b(casual|chitchat|smalltalk)\b/i,                                 category: "support", verb: "chat.casual" },
  { test: /\b(query|ask|clarify|confirm)[-_.]/i,                              category: "support", verb: "answer.question" },
  { test: /\b(reply|respond)[-_.]/i,                                          category: "support", verb: "route.request" },
  { test: /\banswer[-_.]?question\b/i,                                        category: "support", verb: "answer.question" },
  { test: /\broute[-_.]?(request|message|to[-_.]?agent)\b/i,                  category: "support", verb: "route.request" },

  // --- admin ---
  { test: /\bconfig[-_.]?(change|update|edit)?\b/i,                           category: "admin", verb: "config.change" },
  { test: /\bconfigure[-_.]/i,                                                category: "admin", verb: "config.change" },
  { test: /\b(schedule|cron)[-_.]?(add|create|new)\b/i,                       category: "admin", verb: "schedule.add" },
  { test: /\b(reminder|remind)\b/i,                                           category: "admin", verb: "schedule.add" },
  { test: /\b(schedule|cron)[-_.]?(remove|delete|disable)\b/i,                category: "admin", verb: "schedule.remove" },
  { test: /\b(provide|assign|copy)[-_.]?(token|tokens|credential|credentials|cert|secret)s?\b/i, category: "admin", verb: "token.create" },
  { test: /\b(token[-_.]?(create|mint|issue)|mint[-_.]?token)\b/i,            category: "admin", verb: "token.create" },
  { test: /\bagent[-_.]?(add|onboard|new|configure)\b/i,                      category: "admin", verb: "agent.add" },
  { test: /\bchannel[-_.]?(add|wire|new|configure)\b/i,                       category: "admin", verb: "channel.add" },
  { test: /\bauthorize[-_.]/i,                                                category: "admin", verb: "config.change" },
  { test: /\bcorrect[-_.]/i,                                                  category: "admin", verb: "config.change" },

  // --- knowledge ---
  { test: /\b(document|docs|readme|wiki[-_.]?write)\b/i,                      category: "knowledge", verb: "document.feature" },
  { test: /\bsummariz?e\b/i,                                                  category: "knowledge", verb: "summarize.thread" },
  { test: /\b(research|analyze|compare|investigate[-_.]?repo)\b/i,            category: "knowledge", verb: "research.topic" },
  { test: /\bwiki[-_.]?(absorb|ingest|import|run)\b/i,                        category: "knowledge", verb: "wiki.absorb" },
  { test: /\bcompile[-_.]?(brief|report|digest)\b/i,                          category: "knowledge", verb: "summarize.thread" },

  // --- social ---
  { test: /\b(daily[-_.]?brief|brief[-_.]?daily|morning[-_.]?digest)\b/i,     category: "social", verb: "brief.daily" },
  { test: /\b(draft[-_.]?(social|post|tweet|announcement|blog|article)|social[-_.]?post)\b/i, category: "social", verb: "draft.post" },
  { test: /\bcreate[-_.]?(blog|article|post)\b/i,                             category: "social", verb: "draft.post" },
  { test: /\bcompile[-_.]?(marketing|social)\b/i,                             category: "social", verb: "brief.daily" },
  { test: /\b(weekly[-_.]?report|report[-_.]?weekly|status[-_.]?report)\b/i,  category: "social", verb: "report.weekly" },

  // --- system ---
  { test: /\b(classify[-_.]?intent|graph[-_.]?classify)\b/i,                  category: "system", verb: "classify.intent" },
]

export interface MigrateOptions {
  /** When true, log the would-be changes and exit without writing. */
  dryRun?: boolean
  log?: (...args: unknown[]) => void
}

export interface MigrateResult {
  /** How many fingerprint cache entries we touched. */
  indexRemapped: number
  /** Cache entries already in v2 shape (no change). */
  indexSkippedV2: number
  /** Cache entries we couldn't map (left untouched; will re-classify on next event). */
  indexUnmapped: number
  /** Classification log rows rewritten. */
  jsonlRemapped: number
  jsonlSkippedV2: number
  jsonlUnmapped: number
  /** Backup file paths created. */
  backups: string[]
  /** Per-pattern hit counts, useful for tuning the heuristic. */
  patternHits: Record<string, number>
}

/** Run the v1 → v2 remap on the given graph store dir. */
export function migrateV2(store: GraphStore, opts: MigrateOptions = {}): MigrateResult {
  const log = opts.log ?? console.error.bind(console, "[graph-migrate]")
  const baseDir = store.baseDir

  const result: MigrateResult = {
    indexRemapped: 0,
    indexSkippedV2: 0,
    indexUnmapped: 0,
    jsonlRemapped: 0,
    jsonlSkippedV2: 0,
    jsonlUnmapped: 0,
    backups: [],
    patternHits: {},
  }

  // ----- index.json -----
  const indexPath = join(baseDir, "index.json")
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, "utf-8")
    const parsed = indexFileSchema.parse(JSON.parse(raw))
    const updated: IndexFile = { version: parsed.version, entries: {} }
    for (const [fp, entry] of Object.entries(parsed.entries)) {
      const remapped = remapPath(entry.path, result.patternHits)
      if (remapped === "v2") {
        updated.entries[fp] = entry
        result.indexSkippedV2++
        continue
      }
      if (remapped === null) {
        updated.entries[fp] = entry
        result.indexUnmapped++
        continue
      }
      updated.entries[fp] = {
        ...entry,
        path: remapped,
        updatedAt: new Date().toISOString(),
      }
      result.indexRemapped++
    }
    if (!opts.dryRun) {
      const backup = `${indexPath}.v1.bak.${Date.now()}.json`
      copyFileSync(indexPath, backup)
      result.backups.push(backup)
      writeFileSync(indexPath, JSON.stringify(updated, null, 2), "utf-8")
    }
  }

  // ----- classifications.jsonl -----
  const jsonlPath = join(baseDir, "classifications.jsonl")
  if (existsSync(jsonlPath)) {
    const raw = readFileSync(jsonlPath, "utf-8")
    const lines = raw.split("\n")
    const out: string[] = []
    for (const line of lines) {
      if (!line.trim()) { out.push(line); continue }
      let parsed: Classification
      try {
        parsed = classificationSchema.parse(JSON.parse(line))
      } catch {
        // Pass through anything we can't parse — better to keep the audit
        // log intact than drop unrecognized rows.
        out.push(line)
        continue
      }
      const remapped = remapPath(parsed.path, result.patternHits)
      if (remapped === "v2") {
        result.jsonlSkippedV2++
        out.push(line)
        continue
      }
      if (remapped === null) {
        result.jsonlUnmapped++
        out.push(line)
        continue
      }
      const next: Classification = {
        ...parsed,
        path: remapped,
        // Strip v1 axes — they reference nodes that no longer exist post-migration.
        proposedAxes: {},
      }
      out.push(JSON.stringify(next))
      result.jsonlRemapped++
    }
    if (!opts.dryRun) {
      const backup = `${jsonlPath}.v1.bak.${Date.now()}.jsonl`
      copyFileSync(jsonlPath, backup)
      result.backups.push(backup)
      writeFileSync(jsonlPath, out.join("\n"), "utf-8")
    }
  }

  log(
    `index: ${result.indexRemapped} remapped, ${result.indexSkippedV2} already v2, ${result.indexUnmapped} unmapped`,
  )
  log(
    `jsonl: ${result.jsonlRemapped} remapped, ${result.jsonlSkippedV2} already v2, ${result.jsonlUnmapped} unmapped`,
  )
  if (opts.dryRun) log("(dry-run — no files written)")
  else log(`backups: ${result.backups.join(", ")}`)
  return result
}

/** Map a v1 path to a v2 path, OR detect that it's already v2, OR give up.
 *    "v2"   → path is already in v2 shape (length 1–2, root in CATEGORY_SET)
 *    null   → no pattern matched; caller should leave the entry alone
 *    array  → the new v2 path */
function remapPath(path: string[], hits: Record<string, number>): string[] | "v2" | null {
  if (!Array.isArray(path) || path.length === 0) return null
  // Already v2 if the root is one of the closed categories.
  if (CATEGORY_SET.has(path[0])) return "v2"

  // The leaf carries the verb information in v1 (e.g. "activity-review-mr").
  // We also try the full path joined, because some leaves are just numeric ids.
  const haystack = `${path.join(" ")} ${path[path.length - 1] ?? ""}`
  for (const p of PATTERNS) {
    if (p.test.test(haystack)) {
      hits[p.verb] = (hits[p.verb] ?? 0) + 1
      return [p.category, p.verb]
    }
  }
  return null
}
