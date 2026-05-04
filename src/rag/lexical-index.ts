import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { resolve, basename, relative } from "path"
import fg from "fast-glob"
// minisearch ships both CJS and ESM; tsup transpiles either way.
import MiniSearch from "minisearch"

// --- Lexical RAG index per agent ---
//
// Improvement plan #7 — embedding-free retrieval-augmented context for
// agents. BM25-style scoring via the minisearch library (~30KB pure
// JS, no native deps). Each agent gets its own index at
// `.agentx/rag/<agentId>/index.json`; `agentx rag add` builds it from
// a glob, the rag.lexical built-in action queries it.
//
// Fields indexed: title (extracted from first H1 or filename) + body
// (full file text). Title is boosted 2× at search time so a
// well-titled doc beats a body-only mention. Path is stored as a
// non-indexed field so query results can cite the source file.
//
// Why not use embeddings: zero new keys, deterministic results, fast
// (sub-ms search even with hundreds of docs), works offline. The
// trade is no semantic synonymy — but for the kinds of operator
// docs / wiki entries / playbook lookups agents typically need,
// keyword recall is enough. Embedding-backed mode is opt-in
// future work.

export interface IndexedDoc {
  /** Stable id within an index — usually the workspace-relative path. */
  id: string
  title: string
  body: string
  /** Absolute path on disk. Stored, not indexed. */
  path: string
  /** ISO timestamp when this doc was indexed. */
  indexedAt: string
}

export interface RagSearchHit {
  id: string
  title: string
  path: string
  score: number
  /** A short body excerpt around the highest-scoring term. Useful for
   *  citation-style "here's what we found" responses. */
  snippet: string
}

const FIELDS_INDEXED = ["title", "body"]
const FIELDS_STORED = ["title", "body", "path", "indexedAt"]

function indexFilePath(agentId: string, baseDir: string = ".agentx/rag"): string {
  return resolve(process.cwd(), baseDir, agentId, "index.json")
}

function newSearchEngine(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>({
    fields: FIELDS_INDEXED,
    storeFields: FIELDS_STORED,
    searchOptions: { boost: { title: 2 }, fuzzy: 0.2, prefix: true },
  })
}

/**
 * Read a markdown / text file and split into indexable fields. Title
 * comes from the first H1 line (`# ...`); falls back to the filename
 * stem when there isn't one. Body is the full text.
 */
function fileToDoc(absPath: string, idBase: string): IndexedDoc {
  const text = readFileSync(absPath, "utf8")
  const h1Match = text.match(/^\s*#\s+(.+)$/m)
  const title = h1Match ? h1Match[1].trim() : basename(absPath).replace(/\.[^.]+$/, "")
  return {
    id: idBase,
    title,
    body: text,
    path: absPath,
    indexedAt: new Date().toISOString(),
  }
}

/**
 * Build an index from one or more globs. Globs resolve from cwd. The
 * resulting index is persisted under .agentx/rag/<agentId>/index.json
 * and returned to the caller for synchronous use.
 */
export async function buildIndex(
  agentId: string,
  globs: string[],
  opts: { baseDir?: string; cwd?: string; verbose?: boolean } = {},
): Promise<{ docs: number; path: string }> {
  const cwd = opts.cwd ?? process.cwd()
  const files = (await fg(globs, { cwd, absolute: true, dot: false }))
    .filter((p) => {
      try { return statSync(p).isFile() } catch { return false }
    })

  const ms = newSearchEngine()
  for (const abs of files) {
    const idBase = relative(cwd, abs)
    const doc = fileToDoc(abs, idBase)
    ms.add(doc)
    if (opts.verbose) process.stderr.write(`[rag] indexed ${idBase} (${doc.body.length} bytes)\n`)
  }

  const out = indexFilePath(agentId, opts.baseDir)
  mkdirSync(resolve(out, ".."), { recursive: true })
  writeFileSync(out, JSON.stringify(ms.toJSON()), "utf8")
  return { docs: files.length, path: out }
}

/**
 * Load a previously-built index. Returns null when no index exists for
 * this agent (caller can fall back to "no RAG" gracefully). Loading is
 * a small JSON parse + minisearch deserialize — sub-millisecond on
 * typical operator-doc indices.
 */
export function loadIndex(
  agentId: string,
  opts: { baseDir?: string } = {},
): MiniSearch<IndexedDoc> | null {
  const path = indexFilePath(agentId, opts.baseDir)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    return MiniSearch.loadJSON<IndexedDoc>(raw, {
      fields: FIELDS_INDEXED,
      storeFields: FIELDS_STORED,
      searchOptions: { boost: { title: 2 }, fuzzy: 0.2, prefix: true },
    })
  } catch (e: any) {
    process.stderr.write(`[rag] failed to load ${path}: ${e?.message || String(e)}\n`)
    return null
  }
}

const SNIPPET_RADIUS = 80
const SNIPPET_MAX = SNIPPET_RADIUS * 2 + 60

/** Extract a snippet around the FIRST occurrence of any of `terms` in
 *  `body`. Returns the head of the body when no term hits. */
function makeSnippet(body: string, terms: string[]): string {
  const lc = body.toLowerCase()
  let bestPos = -1
  for (const t of terms) {
    const i = lc.indexOf(t.toLowerCase())
    if (i >= 0 && (bestPos === -1 || i < bestPos)) bestPos = i
  }
  if (bestPos === -1) {
    return body.slice(0, SNIPPET_MAX).replace(/\s+/g, " ").trim()
  }
  const start = Math.max(0, bestPos - SNIPPET_RADIUS)
  const end = Math.min(body.length, bestPos + SNIPPET_RADIUS)
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim()
  return (start > 0 ? "…" : "") + slice + (end < body.length ? "…" : "")
}

export interface SearchOpts {
  /** How many top hits to return. Default 5, capped at 50. */
  k?: number
  baseDir?: string
}

/**
 * Lexical query against an agent's index. Returns at most `k` results,
 * each with a score, the title, the source path, and a snippet around
 * the matched term. Empty array when no index exists or no hits.
 */
export function lexicalSearch(
  agentId: string,
  query: string,
  opts: SearchOpts = {},
): RagSearchHit[] {
  const ms = loadIndex(agentId, { baseDir: opts.baseDir })
  if (!ms) return []
  const k = Math.max(1, Math.min(50, opts.k ?? 5))
  const raw = ms.search(query) as unknown as Array<{
    id: string
    score: number
    title: string
    body: string
    path: string
    terms: string[]
  }>
  return raw.slice(0, k).map((r) => ({
    id: r.id,
    title: r.title,
    path: r.path,
    score: r.score,
    snippet: makeSnippet(r.body || "", r.terms || []),
  }))
}

/** List metadata about an agent's index without loading the full thing. */
export function indexInfo(agentId: string, opts: { baseDir?: string } = {}): {
  exists: boolean
  path: string
  docs: number
} {
  const path = indexFilePath(agentId, opts.baseDir)
  if (!existsSync(path)) return { exists: false, path, docs: 0 }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    // minisearch v7 puts the stored fields under `storedFields` (no
    // leading underscore), keyed by internal numeric doc id. Earlier
    // versions used `_storedFields`. Honour both for robustness across
    // minor minisearch upgrades.
    const sf = raw?.storedFields ?? raw?._storedFields
    if (typeof raw?.documentCount === "number") return { exists: true, path, docs: raw.documentCount }
    const docs = sf && typeof sf === "object" ? Object.keys(sf).length : 0
    return { exists: true, path, docs }
  } catch {
    return { exists: true, path, docs: 0 }
  }
}
