import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { AgentMemory, type MemoryRecord, type MemoryType } from "../agents/agent-memory"
import type { WikiIndex } from "./types"

// --- Memory → wiki promotion ---
//
// Finishes the architecture documented in agent-memory.ts: memory is
// experiential / per-agent; the wiki is authoritative / cross-agent. This
// module reads per-agent memories, decides (via an LLM judge) which are
// durable and fleet-relevant, and writes them as [[wikilinked]] articles
// in the SHARED wiki store.
//
// Idempotency has two layers, both keyed on the versioned stamp
// `memory:<agentId>/<type>_<name>@<updatedAt>`:
//
//   1. Promoted memories: the stamp is recorded in the target article's
//      `sources[]` frontmatter (same pattern as getUnabsorbedEntries).
//   2. Skipped memories: recorded in `.agentx/wiki/_memory-promotions.json`
//      so permanently-irrelevant memories aren't re-judged every night.
//
// A bumped `updatedAt` beats both — an edited memory re-enters the
// pipeline, and mergeSources() replaces the stale stamp for its key so
// frontmatter stays bounded (one stamp per memory, not per edit).

export const PROMOTER_OWNER = "memory-promoter"
export const DEFAULT_PROMOTE_TYPES: MemoryType[] = ["project", "reference", "feedback"]
export const PROMOTION_LEDGER_FILE = "_memory-promotions.json"

const STAMP_PREFIX = "memory:"
const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"]

export interface MemoryCandidate {
  agentId: string
  memory: MemoryRecord
  /** Identity without version: `<agentId>/<type>_<name>` */
  key: string
  /** Identity + version: `memory:<key>@<updatedAt>` */
  stamp: string
}

export interface PromotionLedgerEntry {
  stamp: string
  decision: "promoted" | "skipped"
  /** Article path when promoted. */
  article?: string
  /** LLM skip reason. */
  reason?: string
  /** ISO run timestamp. */
  at: string
}

export type PromotionLedger = PromotionLedgerEntry[]

// --- Stamps -------------------------------------------------------------

export function memoryKey(agentId: string, m: Pick<MemoryRecord, "type" | "name">): string {
  return `${agentId}/${m.type}_${m.name}`
}

export function memoryStamp(agentId: string, m: Pick<MemoryRecord, "type" | "name" | "updatedAt">): string {
  return `${STAMP_PREFIX}${memoryKey(agentId, m)}@${m.updatedAt}`
}

/** Parse a `memory:<agentId>/<type>_<name>@<updatedAt>` source stamp.
 *  Returns null for anything else (raw entry ids, malformed stamps) so
 *  callers can filter article `sources[]` safely. */
export function parseMemoryStamp(s: string): {
  agentId: string
  type: MemoryType
  name: string
  updatedAt: string
  key: string
} | null {
  if (!s.startsWith(STAMP_PREFIX)) return null
  const rest = s.slice(STAMP_PREFIX.length)
  const slash = rest.indexOf("/")
  const at = rest.lastIndexOf("@")
  if (slash <= 0 || at <= slash) return null
  const agentId = rest.slice(0, slash)
  const typeName = rest.slice(slash + 1, at)
  const updatedAt = rest.slice(at + 1)
  if (!updatedAt) return null
  const underscore = typeName.indexOf("_")
  if (underscore <= 0) return null
  const type = typeName.slice(0, underscore) as MemoryType
  const name = typeName.slice(underscore + 1)
  if (!MEMORY_TYPES.includes(type) || !name) return null
  return { agentId, type, name, updatedAt, key: `${agentId}/${typeName}` }
}

/** Merge new promotion stamps into an article's existing sources: a new
 *  stamp REPLACES any prior stamp sharing its key (one stamp per memory,
 *  not one per edit); everything else (raw entry ids, other memories'
 *  stamps) is kept. Deduped, order-stable. */
export function mergeSources(existing: string[] | undefined, newStamps: string[]): string[] {
  const newKeys = new Set<string>()
  for (const s of newStamps) {
    const parsed = parseMemoryStamp(s)
    if (parsed) newKeys.add(parsed.key)
  }
  const out: string[] = []
  for (const s of existing ?? []) {
    const parsed = parseMemoryStamp(s)
    if (parsed && newKeys.has(parsed.key)) continue // superseded
    if (!out.includes(s)) out.push(s)
  }
  for (const s of newStamps) {
    if (!out.includes(s)) out.push(s)
  }
  return out
}

// --- Cross-agent memory enumeration --------------------------------------

/** List every agent's memories. AgentMemory has no cross-agent API — we
 *  enumerate the agent subdirs of `.agentx/agent-memory/` ourselves.
 *  `memoryRoot` is the `.agentx` directory (AgentMemory's baseDir root). */
export function listAllAgentMemories(
  memoryRoot: string = resolve(process.cwd(), ".agentx"),
): Array<{ agentId: string; memory: MemoryRecord }> {
  const store = new AgentMemory({ baseDir: memoryRoot })
  if (!existsSync(store.baseDir)) return []
  const out: Array<{ agentId: string; memory: MemoryRecord }> = []
  for (const entry of readdirSync(store.baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    for (const memory of store.list(entry.name)) {
      out.push({ agentId: entry.name, memory })
    }
  }
  return out
}

// --- Skip ledger ----------------------------------------------------------

export function readPromotionLedger(wikiBaseDir: string): PromotionLedger {
  const path = resolve(wikiBaseDir, PROMOTION_LEDGER_FILE)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is PromotionLedgerEntry =>
        e && typeof e.stamp === "string" && (e.decision === "promoted" || e.decision === "skipped"),
    )
  } catch {
    // Corrupt ledger → treat as empty. Worst case: skipped memories are
    // re-judged once. Promoted memories stay deduped via article sources.
    return []
  }
}

/** Append entries and compact: keep only the newest entry per memory key
 *  so the ledger stays bounded. */
export function appendPromotionLedger(wikiBaseDir: string, entries: PromotionLedgerEntry[]): void {
  const merged = [...readPromotionLedger(wikiBaseDir), ...entries]
  const byKey = new Map<string, PromotionLedgerEntry>()
  for (const e of merged) {
    const parsed = parseMemoryStamp(e.stamp)
    const key = parsed?.key ?? e.stamp
    const prev = byKey.get(key)
    if (!prev || (parsed && (parseMemoryStamp(prev.stamp)?.updatedAt ?? "") <= parsed.updatedAt)) {
      byKey.set(key, e)
    }
  }
  writeFileSync(
    resolve(wikiBaseDir, PROMOTION_LEDGER_FILE),
    JSON.stringify([...byKey.values()], null, 2),
  )
}

// --- Candidate selection ---------------------------------------------------

export interface UnpromotedOptions {
  /** Memory types to consider. Default: project, reference, feedback. */
  types?: MemoryType[]
  /** Only memories updated within this window (ms before `now`). */
  sinceMs?: number
  /** Only this agent's memories. */
  agentFilter?: string
  /** Reference clock for `sinceMs` (injectable for tests). Default Date.now(). */
  now?: number
  /** Cap on returned candidates (newest first). Default 20. */
  max?: number
}

/** Diff all agent memories against what's already been promoted (article
 *  `sources[]` stamps across the shared index) or deliberately skipped
 *  (ledger). A memory is a candidate iff its key is unseen OR its
 *  `updatedAt` is newer than the recorded one — ISO-8601 strings compare
 *  lexicographically, so plain `>` is safe. */
export function getUnpromotedMemories(
  all: Array<{ agentId: string; memory: MemoryRecord }>,
  index: WikiIndex,
  ledger: PromotionLedger,
  opts: UnpromotedOptions = {},
): MemoryCandidate[] {
  const types = opts.types ?? DEFAULT_PROMOTE_TYPES
  const now = opts.now ?? Date.now()
  const max = opts.max ?? 20

  // key → newest updatedAt already handled (promoted or skipped)
  const seen = new Map<string, string>()
  const record = (stamp: string) => {
    const parsed = parseMemoryStamp(stamp)
    if (!parsed) return
    const prev = seen.get(parsed.key)
    if (!prev || parsed.updatedAt > prev) seen.set(parsed.key, parsed.updatedAt)
  }
  for (const article of index.articles) {
    for (const s of article.sources ?? []) record(s)
  }
  for (const e of ledger) record(e.stamp)

  const candidates: MemoryCandidate[] = []
  for (const { agentId, memory } of all) {
    if (!types.includes(memory.type)) continue
    if (opts.agentFilter && agentId !== opts.agentFilter) continue
    if (opts.sinceMs !== undefined) {
      const updated = Date.parse(memory.updatedAt)
      if (!Number.isFinite(updated) || updated < now - opts.sinceMs) continue
    }
    const key = memoryKey(agentId, memory)
    const handled = seen.get(key)
    if (handled && memory.updatedAt <= handled) continue
    candidates.push({ agentId, memory, key, stamp: memoryStamp(agentId, memory) })
  }

  return candidates
    .sort((a, b) => b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, max)
}
