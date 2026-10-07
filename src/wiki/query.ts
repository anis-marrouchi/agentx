import { readFileSync, existsSync } from "fs"
import { buildIndex, scoreAll } from "@/memory/bm25"
import { askSeat } from "@/decisions/seat"
import { ancestryScore } from "@/graph"
import {
  DEFAULT_SHORTLIST,
  WIKI_RERANK_SEAT,
  rerankQuestions,
  rerankState,
  toRanking,
  type RerankCandidate,
} from "@/decisions/seats/wiki-rerank"
import { claudeCliEnv } from "@/utils/workspace-env"
import { resolve } from "path"
import { execSync } from "child_process"
import type { WikiArticle } from "./types"
import type { WikiStore } from "./store"

/**
 * Agentic wiki query — the "Farzapedia-faithful" retrieval path.
 *
 * Two LLM calls + a deterministic graph walk:
 *   1. Selector (cheap): read `_index.md` + question → pick up to `maxCandidates`
 *      candidate articles by title + type.
 *   2. Walk (pure code): starting from candidates, follow `related` wikilinks
 *      up to `maxHops`, capped at `maxArticles` total.
 *   3. Synthesis (main): answer the question from the walked subgraph.
 *
 * Returns an answer with citations and a trace of which articles were walked,
 * so callers can audit the retrieval path.
 */

export interface AgenticQueryOptions {
  /** Candidate-selection model (cheap). Defaults to "haiku". */
  selectorModel?: string
  /** Synthesis model (main). Defaults to "sonnet". */
  synthModel?: string
  /** Number of candidates the selector is asked to return. Default 3. */
  maxCandidates?: number
  /** Wikilink hops from candidates. Default 2. */
  maxHops?: number
  /** Hard cap on total articles walked. Default 8. */
  maxArticles?: number
  /** Timeout per LLM call, ms. Default 60_000. */
  timeoutMs?: number
  /** Logger — defaults to console.error. */
  log?: (...args: unknown[]) => void
  /** Intent-graph path the question's request was classified under.
   *  Articles on the same branch rank higher in candidate selection. */
  messagePath?: string[]
  /** Weight of the branch match against the text match, 0–1. Default 0.6
   *  (`graph.retrievalWeights.graph`). */
  graphWeight?: number
}

export interface AgenticQueryResult {
  answer: string
  citations: Array<{ title: string; path: string; type?: string }>
  /** Titles/paths the selector picked. */
  candidates: Array<{ title: string; path: string }>
  /** Full article subgraph the walk produced. */
  walked: Array<{ title: string; path: string; type?: string; hop: number }>
  /** "no-catalog" | "no-candidates" | "ok" */
  status: "ok" | "no-catalog" | "no-candidates" | "error"
  /** For operator debugging only. */
  trace?: {
    selectorMs: number
    synthesisMs: number
    selectorOutput?: string
  }
  error?: string
}

/**
 * Run an agentic query against a specific agent's WikiStore.
 *
 * `requesterId` is used for permission checks — only articles the requester
 * can read will be included in the synthesis input.
 */
export async function agenticQuery(
  question: string,
  store: WikiStore,
  requesterId: string | undefined,
  opts: AgenticQueryOptions = {},
): Promise<AgenticQueryResult> {
  const selectorModel = opts.selectorModel ?? "haiku"
  const synthModel = opts.synthModel ?? "sonnet"
  const maxCandidates = opts.maxCandidates ?? 3
  const maxHops = opts.maxHops ?? 2
  const maxArticles = opts.maxArticles ?? 8
  const timeoutMs = opts.timeoutMs ?? 60_000
  const log = opts.log ?? console.error.bind(console, "[wiki-query]")
  const messagePath = opts.messagePath?.length ? opts.messagePath : undefined
  const graphWeight = opts.graphWeight ?? DEFAULT_GRAPH_WEIGHT

  // --- Step 1: Load the catalog ---
  const catalogPath = resolve(store.baseDir, "_index.md")
  if (!existsSync(catalogPath)) {
    return emptyResult("no-catalog", question, "No _index.md found — run `agentx wiki status` to rebuild.")
  }
  const catalog = readFileSync(catalogPath, "utf-8")

  // --- Step 2: Selector — pick candidates ---
  const selectorStart = Date.now()
  let candidates: Array<{ title: string; path: string }> = []
  let selectorOutput = ""
  try {
    const viaSeat = await selectCandidatesViaSeat(question, store, requesterId, maxCandidates, messagePath, graphWeight)
    if (viaSeat) {
      candidates = viaSeat
      selectorOutput = `[wiki-rerank seat] ${viaSeat.map((c) => c.title).join(" | ")}`
    } else {
      selectorOutput = await runClaude(
        buildSelectorPrompt(question, catalog, maxCandidates, messagePath),
        selectorModel,
        timeoutMs,
      )
      candidates = parseCandidates(selectorOutput)
    }
  } catch (e: any) {
    log("selector failed:", e?.message)
    return { ...emptyResult("error", question, `Selector: ${e?.message || "unknown"}`), trace: { selectorMs: Date.now() - selectorStart, synthesisMs: 0, selectorOutput } }
  }
  const selectorMs = Date.now() - selectorStart

  if (candidates.length === 0) {
    return { ...emptyResult("no-candidates", question, "Selector returned no candidates."), trace: { selectorMs, synthesisMs: 0, selectorOutput } }
  }

  // --- Step 3: Walk the subgraph via `related` wikilinks ---
  const walked = walkSubgraph(candidates, store, requesterId, maxHops, maxArticles)

  if (walked.length === 0) {
    return { ...emptyResult("no-candidates", question, "Candidates did not resolve to readable articles."), candidates, trace: { selectorMs, synthesisMs: 0, selectorOutput } }
  }

  // --- Step 4: Synthesize the answer ---
  const synthStart = Date.now()
  let answer = ""
  try {
    answer = await runClaude(
      buildSynthesisPrompt(question, walked),
      synthModel,
      timeoutMs * 2,
    )
  } catch (e: any) {
    log("synthesis failed:", e?.message)
    return { ...emptyResult("error", question, `Synthesis: ${e?.message || "unknown"}`), candidates, walked: walked.map(w => ({ title: w.meta.title, path: w.path, type: w.meta.type, hop: (w as any).hop ?? 0 })), trace: { selectorMs, synthesisMs: Date.now() - synthStart, selectorOutput } }
  }
  const synthesisMs = Date.now() - synthStart

  return {
    answer: answer.trim(),
    citations: walked.map(a => ({ title: a.meta.title, path: a.path, type: a.meta.type })),
    candidates,
    walked: walked.map(w => ({ title: w.meta.title, path: w.path, type: w.meta.type, hop: (w as any).hop ?? 0 })),
    status: "ok",
    trace: { selectorMs, synthesisMs, selectorOutput },
  }
}

// --- Helpers ---

function emptyResult(
  status: AgenticQueryResult["status"],
  _question: string,
  error?: string,
): AgenticQueryResult {
  return {
    answer: "",
    citations: [],
    candidates: [],
    walked: [],
    status,
    error,
  }
}

function walkSubgraph(
  candidates: Array<{ title: string; path: string }>,
  store: WikiStore,
  requesterId: string | undefined,
  maxHops: number,
  maxArticles: number,
): Array<WikiArticle & { hop: number }> {
  // Build a title → path index from the store so wikilinks resolve.
  const titleIndex = new Map<string, string>()
  for (const article of store.listArticles(requesterId || "")) {
    titleIndex.set(article.meta.title.toLowerCase(), article.path)
  }

  const opened = new Map<string, WikiArticle & { hop: number }>()
  let frontier: Array<{ path: string; hop: number }> = []

  for (const c of candidates) {
    if (!opened.has(c.path)) frontier.push({ path: c.path, hop: 0 })
  }

  while (frontier.length && opened.size < maxArticles) {
    const next = frontier.shift()!
    if (opened.has(next.path)) continue
    if (next.hop > maxHops) continue

    const article = requesterId
      ? store.readArticleAs(next.path, requesterId)
      : store.readArticle(next.path)
    if (!article) continue

    opened.set(next.path, { ...article, hop: next.hop })
    if (next.hop >= maxHops) continue

    for (const target of article.meta.related || []) {
      const path = titleIndex.get(target.toLowerCase())
      if (path && !opened.has(path)) {
        frontier.push({ path, hop: next.hop + 1 })
      }
    }
  }

  return Array.from(opened.values())
}

// --- Prompts ---

/**
 * Pick candidates with the wiki-rerank seat instead of a Claude CLI call.
 *
 * The selector is 56% of a wiki query — 14.1s of a 25s total, measured —
 * and its whole job is "pick 3 articles from this catalog", which is a
 * Choice with per-option probabilities. Jev answers that in about a
 * second. Synthesis stays on Sonnet; it writes prose, which Jev cannot.
 *
 * BM25 shortlists first because the shared catalog carries 971 entries,
 * past the 255-option cap. Same two-stage shape as findRelevantReranked,
 * and it reuses that seat rather than introducing a second one.
 *
 * Returns null whenever the seat is off, errors, or has nothing to rank,
 * and the caller falls back to the CLI selector — so this is strictly an
 * accelerator, never a new way to fail.
 */
async function selectCandidatesViaSeat(
  question: string,
  store: WikiStore,
  requesterId: string | undefined,
  maxCandidates: number,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
): Promise<Array<{ title: string; path: string }> | null> {
  try {
    return await rerankPool(question, catalogPool(store), requesterId, maxCandidates, messagePath, graphWeight)
  } catch {
    return null
  }
}

type CatalogEntry = { title: string; path: string; type?: string; tags?: string[]; related?: string[]; graphPath?: string[] }

function catalogPool(store: WikiStore): CatalogEntry[] {
  const index = store.rebuildIndex()
  return (index.articles ?? []).filter((a) => a.path && !a.path.includes("/_versions/"))
}

/** BM25 shortlist of `pool`, re-ranked by the wiki-rerank seat. Null when
 *  the seat is off, errors, or the pool is too small to rank. */
async function rerankPool(
  question: string,
  pool: CatalogEntry[],
  requesterId: string | undefined,
  maxCandidates: number,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
): Promise<Array<{ title: string; path: string }> | null> {
  try {
    if (pool.length < 2) return null

    const shortlist = rankCatalogPool(question, pool, messagePath, graphWeight).slice(0, DEFAULT_SHORTLIST)

    const candidates: RerankCandidate[] = shortlist.map((i) => ({
      id: `k${i}`,
      title: pool[i].title || pool[i].path,
      tags: pool[i].tags,
      // The catalog has no body — a title, its type, its wikilinks and its
      // branch of the intent graph are what the selector chooses on.
      excerpt: [
        pool[i].type ? `type: ${pool[i].type}` : "",
        (pool[i].related ?? []).length ? `related: ${(pool[i].related ?? []).join(", ")}` : "",
        (pool[i].graphPath ?? []).length ? `graph: ${(pool[i].graphPath ?? []).join(" › ")}` : "",
      ].filter(Boolean).join(" · "),
    }))

    const result = await askSeat(
      WIKI_RERANK_SEAT,
      rerankState({ query: question, candidates, excerptChars: 300 }),
      rerankQuestions(candidates),
      { features: { agent: requesterId ?? "unknown", stage: "catalog-selector" } },
    )
    if (!result || result.mode !== "active") return null

    const ranking = toRanking(result.answers as never, candidates)
    const picked = ranking.ranked
      .slice(0, maxCandidates)
      .map((id) => pool[Number(id.slice(1))])
      .filter(Boolean)
      .map((a) => ({ title: a.title, path: a.path }))
    return picked.length > 0 ? picked : null
  } catch {
    return null
  }
}

export interface FindArticlesOptions {
  /** Articles picked per query before the walk. Default 2. */
  perQuery?: number
  /** Wikilink hops from the picked articles. Default 1. */
  maxHops?: number
  /** Hard cap on articles returned across all queries. Default 8. */
  maxArticles?: number
}

/**
 * The retrieval half of `agenticQuery`, without the synthesis call: for
 * each query, a BM25 shortlist re-ranked by the wiki-rerank seat, then the
 * `related` wikilink walk. Picked articles come first, in query order.
 *
 * Absorb uses it to show the model the articles an entry may already be
 * covered by. It never falls back to the CLI selector — that call reads the
 * whole catalog per query — but to the BM25 text matches alone.
 */
export async function findArticles(
  queries: string[],
  store: WikiStore,
  requesterId: string | undefined,
  opts: FindArticlesOptions = {},
): Promise<Array<WikiArticle & { hop: number }>> {
  const perQuery = opts.perQuery ?? 2
  const maxHops = opts.maxHops ?? 1
  const maxArticles = opts.maxArticles ?? 8
  const pool = catalogPool(store)
  if (pool.length === 0) return []

  const picked = new Map<string, { title: string; path: string }>()
  for (const query of queries) {
    const viaSeat = await rerankPool(query, pool, requesterId, perQuery)
    const hits = viaSeat ?? bandCatalogPool(query, pool).matched
      .slice(0, perQuery)
      .map((i) => ({ title: pool[i].title, path: pool[i].path }))
    for (const hit of hits) if (!picked.has(hit.path)) picked.set(hit.path, hit)
  }
  return walkSubgraph([...picked.values()], store, requesterId, maxHops, maxArticles)
}

/** Weight of the intent-graph branch match against the text match when
 *  shortlisting catalog candidates. Mirrors `graph.retrievalWeights.graph`. */
export const DEFAULT_GRAPH_WEIGHT = 0.6

/**
 * Order the catalog pool for a question. Three bands, never mixed:
 *
 *   1. articles the text match scored, ordered by `text * (1 + w * branch)`
 *      when the request was classified: the branch reorders text matches
 *      but cannot lift an unrelated article above one;
 *   2. articles on the request's branch that the text never matched, by
 *      how much of the path they share;
 *   3. the rest, in catalog order.
 *
 * Band 1 comes first in full because the shortlist the reranker sees is
 * finite (DEFAULT_SHORTLIST): a busy category holds more same-branch
 * articles than that, and a blended score let them push the article that
 * actually answers the question out of the list.
 *
 * Exported for tests; the seat and the CLI selector both consume the order.
 */
export function rankCatalogPool(
  question: string,
  pool: Array<{ title: string; tags?: string[]; related?: string[]; graphPath?: string[] }>,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
): number[] {
  const { matched, branchOnly } = bandCatalogPool(question, pool, messagePath, graphWeight)
  const ranked = [...matched, ...branchOnly]
  for (let i = 0; i < pool.length; i++) if (!ranked.includes(i)) ranked.push(i)
  return ranked
}

/** Bands 1 and 2 of `rankCatalogPool`, kept apart: `matched` holds only
 *  the articles the text match scored. */
function bandCatalogPool(
  question: string,
  pool: Array<{ title: string; tags?: string[]; related?: string[]; graphPath?: string[] }>,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
): { matched: number[]; branchOnly: number[] } {
  const docs = pool.map((a) =>
    [a.title, (a.tags ?? []).join(" "), (a.related ?? []).join(" ")].join(" "),
  )
  const bm25 = scoreAll(question, buildIndex(docs))
  const maxBm25 = bm25.reduce((m, r) => Math.max(m, r.score), 0)
  const text = new Map(bm25.map((r) => [r.docIndex, maxBm25 > 0 ? r.score / maxBm25 : 0]))
  const useGraph = !!messagePath?.length
  const branch = (a: { graphPath?: string[] }) =>
    useGraph && a.graphPath?.length ? ancestryScore(messagePath!, a.graphPath) : 0

  const byScore = (x: { i: number; score: number }, y: { i: number; score: number }) => y.score - x.score || x.i - y.i
  const matched = pool
    .map((a, i) => ({ i, score: (text.get(i) ?? 0) * (1 + graphWeight * branch(a)) }))
    .filter((c) => text.has(c.i))
    .sort(byScore)
  const branchOnly = pool
    .map((a, i) => ({ i, score: branch(a) }))
    .filter((c) => !text.has(c.i) && c.score > 0)
    .sort(byScore)
  return { matched: matched.map((c) => c.i), branchOnly: branchOnly.map((c) => c.i) }
}

function buildSelectorPrompt(question: string, catalog: string, maxCandidates: number, messagePath?: string[]): string {
  const branch = messagePath?.length
    ? `\n## Intent\n\nThe request was classified under the intent-graph path "${messagePath.join(" › ")}". Prefer articles filed under the same branch when their titles are equally plausible.\n`
    : ""
  return `You are picking candidate articles from a wiki catalog to answer a question. You do NOT answer the question. You pick which articles the answer is likely to come from.

## Question

${question}
${branch}
## Catalog (_index.md — articles grouped by type, with wikilink previews)

${catalog}

## Your task

Pick up to ${maxCandidates} articles from the catalog that are most likely to answer the question. Prefer:
- Articles whose title directly names a subject in the question.
- Articles of the right type (e.g. a "who owns X" question → person or project; a "what happened on DATE" → event).
- Articles whose wikilinks suggest they sit at the center of a relevant subgraph.

Return ONLY valid JSON, no markdown fencing, no prose:

[
  {"title": "Exact Article Title", "path": "path/from/catalog.md"},
  ...
]

If none of the articles match, return [].`
}

function buildSynthesisPrompt(
  question: string,
  articles: Array<WikiArticle & { hop: number }>,
): string {
  const articlesBlock = articles
    .map(a => {
      const header = `### ${a.meta.title} — ${a.meta.type || "untyped"} (${a.path}) [hop ${a.hop}]`
      const related = a.meta.related?.length ? `Related: ${a.meta.related.join(", ")}` : ""
      return [header, related, "", a.content].filter(Boolean).join("\n")
    })
    .join("\n\n---\n\n")

  return `You are answering a question using a small subgraph of wiki articles. The articles were walked from the catalog; trust them over your prior knowledge.

## Question

${question}

## Articles (${articles.length} walked from the catalog)

${articlesBlock}

## Your task

Answer the question in 2–6 sentences. Cite articles by their title in square brackets like [Article Title]. If the articles do not answer the question, say so plainly (do not invent). Prefer concrete facts over hedging.

Output ONLY the answer — no preamble, no "here is my answer:", no markdown fencing.`
}

function parseCandidates(raw: string): Array<{ title: string; path: string }> {
  const match = raw.match(/\[[\s\S]*?\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x: any) => x && typeof x.title === "string" && typeof x.path === "string")
      .map((x: any) => ({ title: x.title, path: x.path }))
  } catch {
    return []
  }
}

async function runClaude(prompt: string, model: string, timeoutMs: number): Promise<string> {
  // Use stdin via a temp-file pipe to avoid shell-escaping a huge prompt.
  // Prompts can exceed the `-E` arg buffer on macOS, so we always pipe.
  const { writeFileSync, mkdirSync, rmSync } = await import("fs")
  const { tmpdir } = await import("os")
  const dir = resolve(tmpdir(), `agentx-wiki-query-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const promptPath = resolve(dir, `prompt-${Date.now()}.txt`)
  writeFileSync(promptPath, prompt)
  try {
    const cmd = `cat '${promptPath}' | claude -p - --output-format json --max-turns 1 --model ${model} --disallowedTools "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch NotebookEdit"`
    const raw = execSync(cmd, { env: claudeCliEnv(), encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    try {
      const envelope = JSON.parse(raw)
      return String(envelope.result || envelope.content || "")
    } catch {
      return raw
    }
  } finally {
    try { rmSync(promptPath, { force: true }) } catch {}
  }
}
