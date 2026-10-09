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
import type { WikiArticle, WikiIndex } from "./types"
import type { WikiStore } from "./store"
import { claudeModelCall, type ModelCall } from "./model-call"
import type { FetchLike, LiveLine } from "./live-read"
import { DEFAULT_SUMMARIES_QUERY, collectSummaries, summariesQuery, type SummariesQuerySettings } from "./query-summaries"
import type { QueryMethod } from "./query-settings"

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
  /** Other wikis to search besides `store`: the shared wiki (#824). Only
   *  articles the requester may read are offered. Their paths come back
   *  as `@<id>/<path>`. */
  shared?: SharedWikiStore[]
  /** How pages are picked (#855). `summaries`: from the one-line page
   *  summaries, then a live read (query-summaries.ts). `auto`: that, once
   *  most of the requester's own pages have a summary
   *  (AUTO_SUMMARY_COVERAGE). Default "catalog". */
  method?: QueryMethod
  /** Settings of the summaries method. An explicit `selectorModel` or
   *  `synthModel` overrides its models. */
  summaries?: SummariesQuerySettings
  /** Model call and HTTP GET of the summaries method; tests pass their own. */
  call?: ModelCall
  fetch?: FetchLike
}

/** Share of the requester's own pages that must have a summary before
 *  `auto` picks pages from summaries. Below it, an unsummarised page
 *  would be ranked on its title and tags alone, so the catalog walk is
 *  kept: one `wiki summarize --agent <id>` or `--limit` run must not
 *  switch every agent that can read that store. */
export const AUTO_SUMMARY_COVERAGE = 0.8

/** Share of the pages in reach that have a summary: the requester's own
 *  pages, or the shared pages when the requester has none. */
function summaryCoverage(store: WikiStore, requesterId: string | undefined, view: ScopeView, summaries: Map<string, string>): number {
  if (summaries.size === 0) return 0
  let paths = store.listArticles(requesterId || "").map((a) => a.path).filter((p) => !p.includes("/_versions/"))
  if (paths.length === 0) paths = view.sharedPool.map((e) => e.path)
  if (paths.length === 0) return 0
  return paths.filter((p) => summaries.has(p)).length / paths.length
}

/** A wiki searched alongside the requester's own. */
export interface SharedWikiStore {
  /** Shown in citations as `@<id>/<path>`: an agent id, or "shared". */
  id: string
  store: WikiStore
  /** Paths to leave out, e.g. the agents/ tree under the root store. */
  skip?: (path: string) => boolean
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
  /** How the pages were picked. */
  method?: "summaries" | "catalog"
  /** Lines read at the source for this answer (summaries method). */
  live?: LiveLine[]
  /** Live reads the model named and the config allowed. */
  liveAsked?: number
  /** For operator debugging only. */
  trace?: {
    selectorMs: number
    synthesisMs: number
    selectorOutput?: string
    planMs?: number
    liveMs?: number
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
  const view = scopeView(store, requesterId, opts.shared)

  const method = opts.method ?? "catalog"
  if (method !== "catalog") {
    const summaries = collectSummaries(store, opts.shared)
    if (method === "summaries" || summaryCoverage(store, requesterId, view, summaries) >= AUTO_SUMMARY_COVERAGE) {
      const base = opts.summaries ?? DEFAULT_SUMMARIES_QUERY
      const out = await summariesQuery(question, view, summaries, {
        ...base,
        navigatorModel: opts.selectorModel ?? base.navigatorModel,
        answerModel: opts.synthModel ?? base.answerModel,
      }, { call: opts.call ?? claudeModelCall, fetch: opts.fetch, timeoutMs, log })
      const pages = out.picked.map((a) => ({ title: a.meta.title, path: a.path, type: a.meta.type }))
      return {
        answer: out.answer,
        citations: out.status === "ok" ? pages : [],
        candidates: pages.map(({ title, path }) => ({ title, path })),
        walked: pages.map((p) => ({ ...p, hop: 0 })),
        status: out.status,
        method: "summaries",
        live: out.live,
        liveAsked: out.liveAsked,
        trace: out.trace,
        ...(out.error ? { error: out.error } : {}),
      }
    }
  }

  if (!existsSync(catalogPath) && view.sharedPool.length === 0) {
    return emptyResult("no-catalog", question, "No _index.md found — run `agentx wiki status` to rebuild.")
  }
  const ownCatalog = existsSync(catalogPath) ? readFileSync(catalogPath, "utf-8") : ""
  const catalog = ownCatalog + renderSharedCatalog(question, view.sharedPool, messagePath, graphWeight)

  // --- Step 2: Selector — pick candidates ---
  const selectorStart = Date.now()
  let candidates: Array<{ title: string; path: string }> = []
  let selectorOutput = ""
  try {
    const viaSeat = await selectCandidatesViaSeat(question, view.pool, requesterId, maxCandidates, messagePath, graphWeight)
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
  const walked = walkSubgraph(candidates, view, maxHops, maxArticles)

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

export interface RetrieveOptions {
  /** Articles picked before the walk. Default 3. */
  maxCandidates?: number
  /** Wikilink hops from the picked articles. Default 1. */
  maxHops?: number
  /** Hard cap on articles returned. Default 6. */
  maxArticles?: number
  messagePath?: string[]
  graphWeight?: number
  /** The catalog to pick from. Pass it when retrieving many times in a row,
   *  so the index is not rebuilt for every call. */
  pool?: CatalogEntry[]
  /** Seat telemetry label. */
  stage?: string
}

/**
 * The retrieval half of agenticQuery, without the synthesis call: BM25
 * shortlist, rerank seat, then the `related` wikilink walk. Returns the
 * walked articles, hop 0 first.
 *
 * When the seat is off or fails, the BM25 order decides on its own, and
 * only articles the text matched are picked: an article chosen for
 * nothing but its catalog position is noise here, not a candidate. There
 * is no CLI fallback, so this never spends an LLM call.
 */
export async function retrieveArticles(
  question: string,
  store: WikiStore,
  requesterId: string | undefined,
  opts: RetrieveOptions = {},
): Promise<Array<WikiArticle & { hop: number }>> {
  const maxCandidates = opts.maxCandidates ?? 3
  const graphWeight = opts.graphWeight ?? DEFAULT_GRAPH_WEIGHT
  const messagePath = opts.messagePath?.length ? opts.messagePath : undefined
  const pool = opts.pool ?? catalogPool(store)
  if (pool.length === 0 || !question.trim()) return []

  let candidates = await selectCandidatesViaSeat(
    question, pool, requesterId, maxCandidates, messagePath, graphWeight, opts.stage ?? "retrieve",
  )
  if (!candidates) {
    const matched = new Set(scoreAll(question, buildIndex(pool.map(catalogDoc))).map((r) => r.docIndex))
    candidates = rankCatalogPool(question, pool, messagePath, graphWeight)
      .filter((i) => matched.has(i))
      .slice(0, maxCandidates)
      .map((i) => ({ title: pool[i].title, path: pool[i].path }))
  }
  if (candidates.length === 0) return []
  return walkSubgraph(candidates, scopeView(store, requesterId), opts.maxHops ?? 1, opts.maxArticles ?? 6)
}

export type CatalogEntry = WikiIndex["articles"][number]

/** The catalog retrieval picks from: every indexed article but old versions. */
export function catalogPool(store: WikiStore): CatalogEntry[] {
  try {
    return (store.rebuildIndex().articles ?? []).filter((a) => a.path && !a.path.includes("/_versions/"))
  } catch {
    return []
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

/**
 * The articles a query may open: the requester's own wiki first, then
 * each shared one. Shared paths carry an `@<id>/` prefix so the walk
 * knows which store to read; a title the own wiki has resolves there.
 */
interface ScopeView {
  /** Own catalog, then the shared articles. */
  pool: CatalogEntry[]
  sharedPool: CatalogEntry[]
  titleIndex: Map<string, string>
  /** Title (lowercased) → pages whose `related` names it, newest first.
   *  Built only when shared wikis are searched. */
  backlinks: Map<string, string[]>
  /** Paths the requester may read, own and shared. */
  readable: Set<string>
  read(path: string): WikiArticle | null
}

function scopeView(store: WikiStore, requesterId: string | undefined, shared: SharedWikiStore[] = []): ScopeView {
  const titleIndex = new Map<string, string>()
  const linking: Array<{ path: string; related: string[]; lastUpdated: string }> = []
  for (const article of store.listArticles(requesterId || "")) {
    titleIndex.set(article.meta.title.toLowerCase(), article.path)
    linking.push({ path: article.path, related: article.meta.related ?? [], lastUpdated: article.meta.lastUpdated ?? "" })
  }
  const sharedPool: CatalogEntry[] = []
  const byId = new Map<string, SharedWikiStore>()
  for (const s of shared) {
    if (s.store.baseDir === store.baseDir) continue
    byId.set(s.id, s)
    // listArticles is cached and already drops what the requester can't
    // read; rebuilding every agent's index per query would not be.
    for (const a of s.store.listArticles(requesterId || "")) {
      if (a.path.includes("/_versions/") || s.skip?.(a.path)) continue
      const path = `@${s.id}/${a.path}`
      sharedPool.push(catalogEntry(a, path))
      linking.push({ path, related: a.meta.related ?? [], lastUpdated: a.meta.lastUpdated ?? "" })
      const key = a.meta.title.toLowerCase()
      if (!titleIndex.has(key)) titleIndex.set(key, path)
    }
  }
  // In a fleet's shared pool the page that answers a question often links
  // TO the page the selector picked (a decision about a person), and the
  // forward walk never reaches it (#824 review: ranked 103rd of ~5,700).
  const backlinks = new Map<string, string[]>()
  if (byId.size > 0) {
    for (const l of [...linking].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))) {
      for (const t of l.related) {
        const key = t.toLowerCase()
        const list = backlinks.get(key) ?? []
        if (!list.includes(l.path)) list.push(l.path)
        backlinks.set(key, list)
      }
    }
  }
  let pool: CatalogEntry[] | undefined
  return {
    backlinks,
    readable: new Set(linking.map((l) => l.path)),
    // Lazy: retrieveArticles brings its own pool, and building this one
    // rebuilds the index.
    get pool() { return (pool ??= [...catalogPool(store), ...sharedPool]) },
    sharedPool,
    titleIndex,
    read(path) {
      const m = path.match(/^@([^/]+)\/(.+)$/)
      const target = m ? byId.get(m[1]) : undefined
      if (m && !target) return null
      const s = target?.store ?? store
      const rel = m ? m[2] : path
      const article = requesterId ? s.readArticleAs(rel, requesterId) : s.readArticle(rel)
      return article ? { ...article, path } : null
    },
  }
}

function catalogEntry(a: WikiArticle, path: string): CatalogEntry {
  return {
    path,
    title: a.meta.title,
    type: a.meta.type,
    related: a.meta.related,
    tags: a.meta.tags || [],
    owner: a.meta.owner,
    access: a.meta.access,
    sharedWith: a.meta.sharedWith,
    aliases: [a.meta.title.toLowerCase(), ...(a.meta.aliases ?? []).map((x) => x.toLowerCase())],
    backlinks: 0,
    sources: a.meta.sources,
    lastUpdated: a.meta.lastUpdated,
    graphPath: a.meta.graphPath,
  }
}

/** Shared articles most related to the question, for the CLI selector.
 *  Capped: a fleet's shared catalog would not fit one prompt. */
export const SHARED_CATALOG_LINES = 150

function renderSharedCatalog(question: string, pool: CatalogEntry[], messagePath: string[] | undefined, graphWeight: number): string {
  if (pool.length === 0) return ""
  const lines = rankCatalogPool(question, pool, messagePath, graphWeight)
    .slice(0, SHARED_CATALOG_LINES)
    .map((i) => `- ${pool[i].title}${pool[i].type ? ` [${pool[i].type}]` : ""} (${pool[i].path})`)
  return `\n\n## Shared wiki (other agents' articles)\n\n${lines.join("\n")}\n`
}

/** Pages that link to a picked page, opened per picked page. */
const BACKLINKS_PER_PICK = 3

function walkSubgraph(
  candidates: Array<{ title: string; path: string }>,
  view: ScopeView,
  maxHops: number,
  maxArticles: number,
): Array<WikiArticle & { hop: number }> {
  const titleIndex = view.titleIndex
  const isShared = (path: string) => path.startsWith("@")

  // The agent's own pages come first, and shared pages may take at most
  // half the walk when it has any: in the #824 trial shared pages took
  // the slots of the agent's own correct pages and its score dropped.
  const ordered = [...candidates.filter((c) => !isShared(c.path)), ...candidates.filter((c) => isShared(c.path))]
  let sharedCap = ordered.length > 0 && !isShared(ordered[0].path) ? Math.floor(maxArticles / 2) : maxArticles

  const opened = new Map<string, WikiArticle & { hop: number }>()
  let sharedOpened = 0
  let frontier: Array<{ path: string; hop: number }> = ordered.map((c) => ({ path: c.path, hop: 0 }))
  // Shared pages turned away by the cap, in walk order. When the agent's
  // own pages run out first they get the slots left: an own pick with no
  // own neighbours must not leave the walk short of shared pages that answer.
  const deferred: Array<{ path: string; hop: number }> = []

  while (opened.size < maxArticles) {
    if (!frontier.length) {
      if (!deferred.length || sharedCap >= maxArticles) break
      sharedCap = maxArticles
      frontier = deferred.splice(0)
    }
    const next = frontier.shift()!
    if (opened.has(next.path)) continue
    if (next.hop > maxHops) continue
    if (isShared(next.path) && sharedOpened >= sharedCap) { deferred.push(next); continue }

    const article = view.read(next.path)
    if (!article) continue

    opened.set(next.path, { ...article, hop: next.hop })
    if (isShared(next.path)) sharedOpened++
    if (next.hop >= maxHops) continue

    if (next.hop === 0) {
      // Pages link to a subject by any of its names; skip what is already
      // open before taking the newest few, or an opened page uses a slot.
      const names = [article.meta.title, ...(article.meta.aliases ?? [])].map((n) => n.toLowerCase())
      const linking = [...new Set(names.flatMap((n) => view.backlinks.get(n) ?? []))]
        .filter((path) => path !== next.path && !opened.has(path))
        .slice(0, BACKLINKS_PER_PICK)
      for (const path of linking) frontier.push({ path, hop: 1 })
    }
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
  pool: CatalogEntry[],
  requesterId: string | undefined,
  maxCandidates: number,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
  stage = "catalog-selector",
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
      { features: { agent: requesterId ?? "unknown", stage } },
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
  const bm25 = scoreAll(question, buildIndex(pool.map(catalogDoc)))
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
  const ranked = [...matched, ...branchOnly].map((c) => c.i)
  for (let i = 0; i < pool.length; i++) if (!ranked.includes(i)) ranked.push(i)
  return ranked
}

/** What BM25 sees of a catalog entry: the catalog carries no body. */
function catalogDoc(a: { title: string; tags?: string[]; related?: string[] }): string {
  return [a.title, (a.tags ?? []).join(" "), (a.related ?? []).join(" ")].join(" ")
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
      // Owner and date let the answer say where a fact came from and pick
      // the newer page when two disagree (#824).
      const from = [a.meta.owner ? `owner: ${a.meta.owner}` : "", a.meta.lastUpdated ? `updated: ${a.meta.lastUpdated}` : ""].filter(Boolean).join(", ")
      const header = `### ${a.meta.title} — ${a.meta.type || "untyped"} (${a.path}) [hop ${a.hop}]${from ? ` {${from}}` : ""}`
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

Answer the question in 2–6 sentences. Cite articles by their title in square brackets like [Article Title]. When two articles disagree, prefer the one updated more recently, and say which agent's page and date the answer comes from. If the articles do not answer the question, say so plainly (do not invent). Prefer concrete facts over hedging.

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

/** `wiki.query.shared` from agentx.json: whether a query also searches the
 *  shared wiki. On when there is no config to read. The CLI and the
 *  `agentx_wiki_query` tool both ask here, so the switch reaches both. */
export async function sharedQueryEnabled(configPath?: string): Promise<boolean> {
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    return loadDaemonConfig(configPath).wiki.query.shared
  } catch {
    return true
  }
}
