// --- Wiki contradiction linter (semantic pass) ---
//
// Karpathy's LLM-Wiki spec calls out contradiction detection as runtime
// insurance — without it, a wiki becomes a cache of stale facts with no
// health feedback. The structural lint() in store.ts catches broken links,
// orphans, and stubs but cannot detect "article A says X" vs "article B
// says NOT X."
//
// This pass:
//   1. Enumerates articles in the store (no permission filter — admin/lint).
//   2. Groups by type (concept | decision | pattern most likely to conflict).
//   3. Picks article pairs that share wikilinks (overlap = contradiction risk).
//   4. Asks Claude (or any callable model) per batch: "any factual conflicts?"
//   5. Returns issues with `type: "contradiction"` for the existing lint
//      reporter to render.
//
// Cost-bounded: caps articles, pairs, batches; defaults to a fast model.
// Async by design — the structural lint() stays sync; this runs on demand
// (`agentx wiki lint --semantic`) or in a cron.

import { execSync } from "child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { relative, resolve } from "path"
import type { WikiArticle, WikiArticleType } from "./types"
import type { WikiStore } from "./store"

export interface ContradictionIssue {
  type: "contradiction"
  articles: string[]   // paths of articles that conflict
  message: string      // model's verbatim description of the conflict
  confidence?: "low" | "medium" | "high"
}

export interface LintContradictionsOptions {
  /** Maximum articles to consider. Default: 40. */
  maxArticles?: number
  /** Maximum pairs to evaluate. Default: 20. */
  maxPairs?: number
  /** Articles per batch (each batch = one LLM call). Default: 4. */
  batchSize?: number
  /** Model name passed to `claude -p --model`. Default: claude-haiku-4-5. */
  model?: string
  /** Per-batch timeout. Default: 30s. */
  timeoutMs?: number
  /** Restrict to these article types. Default: contradiction-prone types. */
  types?: WikiArticleType[]
  /** Logger (defaults to silent). */
  log?: (msg: string) => void
}

const DEFAULT_TYPES: WikiArticleType[] = ["concept", "decision", "pattern"]

/**
 * Run the contradiction linter against a wiki store.
 * Returns an array of contradiction issues (empty if none found).
 *
 * Cost: roughly `ceil(pairs / batchSize)` LLM calls; with defaults that's
 * `ceil(20 / 4) = 5` calls. At Haiku rates with ≤4KB articles each, this is
 * a few cents per run.
 */
export async function lintContradictions(
  store: WikiStore,
  options: LintContradictionsOptions = {},
): Promise<ContradictionIssue[]> {
  const maxArticles = options.maxArticles ?? 40
  const maxPairs = options.maxPairs ?? 20
  const batchSize = Math.max(2, options.batchSize ?? 4)
  const model = options.model ?? "claude-haiku-4-5"
  const timeoutMs = options.timeoutMs ?? 30_000
  const types = options.types ?? DEFAULT_TYPES
  const log = options.log ?? (() => {})

  // 1. Enumerate articles by walking the wiki dir directly (admin scope —
  //    no permission filter, this is a maintenance pass run by the wiki owner).
  const articles = enumerateArticles(store, maxArticles, types)
  if (articles.length < 2) {
    log(`[contradictions] only ${articles.length} eligible articles; skipping`)
    return []
  }

  // 2. Build candidate pairs prioritized by overlap. Articles that already
  //    cite each other via wikilinks are far more likely to contradict than
  //    random pairs — that's where overlap of claims happens.
  const pairs = buildCandidatePairs(articles, maxPairs)
  if (pairs.length === 0) {
    log("[contradictions] no candidate pairs (no shared wikilinks)")
    return []
  }

  // 3. Group pairs into batches. We send N articles per call and ask the
  //    model to find conflicts among them — covers all O(N²/2) sub-pairs in
  //    one call. Articles are deduped within a batch.
  const batches = batchPairs(pairs, batchSize)

  // 4. Run each batch through Claude.
  const issues: ContradictionIssue[] = []
  for (const batch of batches) {
    log(`[contradictions] checking batch of ${batch.length} articles…`)
    try {
      const batchIssues = await checkBatch(batch, model, timeoutMs)
      for (const issue of batchIssues) issues.push(issue)
    } catch (e: any) {
      log(`[contradictions] batch failed: ${e?.message ?? e}`)
    }
  }

  return issues
}

// -- internals --

function enumerateArticles(
  store: WikiStore,
  maxArticles: number,
  types: WikiArticleType[],
): WikiArticle[] {
  const baseDir = store.baseDir
  const articles: WikiArticle[] = []
  const typeSet = new Set<string>(types)

  walkMarkdown(baseDir, (filePath) => {
    if (articles.length >= maxArticles) return
    const relPath = relative(baseDir, filePath)
    if (relPath.startsWith("raw/") || relPath.startsWith("_") || relPath === "WIKI.md" || relPath === "log.md") return
    const article = store.readArticle(relPath)
    if (!article) return
    if (article.meta.type && !typeSet.has(article.meta.type)) return
    articles.push(article)
  })

  return articles
}

function walkMarkdown(dir: string, visit: (filePath: string) => void): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue
    const full = resolve(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkMarkdown(full, visit)
    } else if (stat.isFile() && full.endsWith(".md")) {
      visit(full)
    }
  }
}

interface Pair {
  a: WikiArticle
  b: WikiArticle
  overlap: number  // shared wikilink count — proxy for conflict risk
}

function buildCandidatePairs(articles: WikiArticle[], maxPairs: number): Pair[] {
  const linksByPath = new Map<string, Set<string>>()
  for (const a of articles) {
    const links = new Set([
      ...(a.meta.related ?? []),
      ...extractInlineWikilinks(a.content),
    ])
    linksByPath.set(a.path, links)
  }

  const pairs: Pair[] = []
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const a = articles[i]
      const b = articles[j]
      const aLinks = linksByPath.get(a.path) ?? new Set()
      const bLinks = linksByPath.get(b.path) ?? new Set()
      let overlap = 0
      // Direct mutual link
      if (aLinks.has(b.meta.title)) overlap += 2
      if (bLinks.has(a.meta.title)) overlap += 2
      // Shared third-party links
      for (const l of aLinks) if (bLinks.has(l)) overlap += 1
      // Same-type pairs are also worth checking even with low overlap
      if (a.meta.type && a.meta.type === b.meta.type) overlap += 0.5
      if (overlap > 0) pairs.push({ a, b, overlap })
    }
  }

  pairs.sort((x, y) => y.overlap - x.overlap)
  return pairs.slice(0, maxPairs)
}

function extractInlineWikilinks(content: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m
  while ((m = re.exec(content)) !== null) {
    const target = m[1].split("|")[0].trim()
    if (target) out.push(target)
  }
  return out
}

function batchPairs(pairs: Pair[], batchSize: number): WikiArticle[][] {
  const batches: WikiArticle[][] = []
  const seen = new Set<string>()
  let current: WikiArticle[] = []
  for (const p of pairs) {
    for (const art of [p.a, p.b]) {
      if (seen.has(art.path)) continue
      seen.add(art.path)
      current.push(art)
      if (current.length >= batchSize) {
        batches.push(current)
        current = []
      }
    }
  }
  if (current.length >= 2) batches.push(current)
  return batches
}

async function checkBatch(
  articles: WikiArticle[],
  model: string,
  timeoutMs: number,
): Promise<ContradictionIssue[]> {
  const prompt = buildPrompt(articles)
  const raw = runClaude(prompt, model, timeoutMs)
  return parseClaudeResponse(raw, articles)
}

function buildPrompt(articles: WikiArticle[]): string {
  const blocks = articles.map((a, i) => {
    const body = a.content.length > 2000 ? a.content.slice(0, 2000) + "\n…[truncated]" : a.content
    return `### Article ${i + 1}\nTitle: ${a.meta.title}\nPath: ${a.path}\nType: ${a.meta.type ?? "unknown"}\n\n${body}`
  }).join("\n\n---\n\n")

  return [
    "You are a wiki contradiction linter. Examine the following articles and identify any FACTUAL contradictions between them.",
    "",
    "A contradiction means two articles assert claims that cannot both be true (e.g., 'X is the founder' vs 'Y is the founder'; 'launched in 2024' vs 'launched in 2025'; 'requires Postgres' vs 'works with SQLite only').",
    "",
    "Do NOT flag:",
    "- Different perspectives on the same topic",
    "- Different scopes (one article describes part, another describes whole)",
    "- Different time-points clearly labeled (history vs current state)",
    "- Stylistic differences",
    "",
    "Return STRICT JSON, no prose, no markdown fences. Schema:",
    `{"contradictions": [{"articles": ["path1.md", "path2.md"], "message": "short description", "confidence": "low|medium|high"}]}`,
    "",
    "If no contradictions, return: {\"contradictions\": []}",
    "",
    "--- ARTICLES ---",
    "",
    blocks,
  ].join("\n")
}

function runClaude(prompt: string, model: string, timeoutMs: number): string {
  const dir = resolve(tmpdir(), `agentx-wiki-lint-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const promptPath = resolve(dir, `prompt-${Date.now()}.txt`)
  writeFileSync(promptPath, prompt)
  try {
    const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${model} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
    const raw = execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    try {
      const envelope = JSON.parse(raw)
      return String(envelope.result ?? envelope.content ?? "")
    } catch {
      return raw
    }
  } finally {
    try { rmSync(promptPath, { force: true }) } catch {}
  }
}

function parseClaudeResponse(raw: string, batch: WikiArticle[]): ContradictionIssue[] {
  // Strip code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Fall back to first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return []
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return []
    }
  }
  const list = parsed?.contradictions
  if (!Array.isArray(list)) return []
  const validPaths = new Set(batch.map(a => a.path))
  const issues: ContradictionIssue[] = []
  for (const item of list) {
    if (!item || !Array.isArray(item.articles) || typeof item.message !== "string") continue
    const articles = item.articles.filter((p: unknown): p is string => typeof p === "string" && validPaths.has(p))
    if (articles.length < 2) continue
    const confidence = item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
      ? item.confidence
      : undefined
    issues.push({
      type: "contradiction",
      articles,
      message: item.message,
      confidence,
    })
  }
  return issues
}
