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
import { freshSummaries, hasSummaries, loadSummaries } from "./summaries"
import {
  LIVE_READ_KINDS,
  describeSources,
  runLiveReads,
  validateReads,
  type AgentxNode,
  type LiveLine,
  type LiveSource,
} from "./live-read"

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
  /** How pages are picked (#855). "auto" (default): from the page
   *  summaries when the agent's wiki has them, else from the catalog.
   *  "catalog" is the method above, unchanged. */
  method?: QueryMethod
  /** Counts and models of the summaries method. */
  summaries?: Partial<SummaryQuerySettings>
  /** The live read before the answer (summaries method only). Nothing is
   *  read while it is off or lists no sources. */
  live?: LiveReadSettings
  /** Runs one model call. Default: the `claude` CLI. */
  runModel?: (prompt: string, model: string, timeoutMs: number) => Promise<string>
}

export type QueryMethod = "auto" | "summaries" | "catalog"

export interface SummaryQuerySettings {
  /** Pages of the agent's own wiki shortlisted by word match. */
  shortlist: number
  /** Pages of the shared wiki added to the shortlist. */
  sharedShortlist: number
  /** Pages the selector may pick. */
  maxPages: number
  /** Characters of each picked page given to the answer. */
  pageChars: number
  /** Picks pages from the shortlist. */
  selectorModel: string
  /** Names the live reads. */
  plannerModel: string
  /** Writes the answer. */
  answerModel: string
}

export const DEFAULT_SUMMARY_QUERY: SummaryQuerySettings = {
  shortlist: 12,
  sharedShortlist: 4,
  maxPages: 3,
  pageChars: 6000,
  selectorModel: "haiku",
  plannerModel: "haiku",
  answerModel: "sonnet",
}

export interface LiveReadSettings {
  enabled: boolean
  sources: LiveSource[]
  /** Nodes an `agentx` source asks: this node first, then mesh peers. */
  nodes?: AgentxNode[]
  /** Reads per question. Default 6. */
  maxReads?: number
  /** Each read's timeout, ms. Default 8000. */
  timeoutMs?: number
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
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
  /** Which method picked the pages. */
  method?: "summaries" | "catalog"
  /** Lines the live read returned, cited in the answer as [live N]. */
  live?: LiveLine[]
  /** For operator debugging only. */
  trace?: {
    selectorMs: number
    synthesisMs: number
    selectorOutput?: string
    /** Naming the live reads, and running them. */
    planMs?: number
    liveMs?: number
    planOutput?: string
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
  const method = opts.method ?? "auto"
  if (method === "summaries" || (method === "auto" && hasSummaries(store))) {
    return summariesQuery(question, store, requesterId, opts)
  }
  const runClaude = opts.runModel ?? runClaudeCli

  // --- Step 1: Load the catalog ---
  const catalogPath = resolve(store.baseDir, "_index.md")
  const view = scopeView(store, requesterId, opts.shared)
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
    method: "catalog",
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

// --- Summaries + live read (#855) ---

/** A page offered to the selector: its catalog line and summary. */
interface SummaryEntry {
  path: string
  title: string
  type?: string
  tags: string[]
  related?: string[]
  graphPath?: string[]
  aliases?: string[]
  owner?: string
  lastUpdated?: string
  summary?: string
}

/**
 * The summaries method:
 *   1. no model: rank every readable page by the words it shares with the
 *      question, over title, tags and summary; keep `shortlist` of the
 *      agent's own pages and `sharedShortlist` shared ones;
 *   2. small model: pick up to `maxPages` pages from those lines, or none;
 *   3. small model: name up to `live.maxReads` live reads (names only);
 *   4. code: validate and run the reads, in parallel;
 *   5. answer from the pages and the live lines, marking live facts.
 */
async function summariesQuery(
  question: string,
  store: WikiStore,
  requesterId: string | undefined,
  opts: AgenticQueryOptions,
): Promise<AgenticQueryResult> {
  const cfg = { ...DEFAULT_SUMMARY_QUERY, ...stripUndefined(opts.summaries ?? {}) }
  // The options callers already pass for the catalog method name the same
  // steps here, and win over the configured ones.
  if (opts.selectorModel) cfg.selectorModel = opts.selectorModel
  if (opts.synthModel) cfg.answerModel = opts.synthModel
  if (opts.maxCandidates) cfg.maxPages = opts.maxCandidates
  const run = opts.runModel ?? runClaudeCli
  const timeoutMs = opts.timeoutMs ?? 60_000
  const log = opts.log ?? console.error.bind(console, "[wiki-query]")
  const messagePath = opts.messagePath?.length ? opts.messagePath : undefined
  const graphWeight = opts.graphWeight ?? DEFAULT_GRAPH_WEIGHT
  const view = scopeView(store, requesterId, opts.shared)
  const base = { method: "summaries" as const }

  // --- 1. Shortlist by word match ---
  const own = summaryEntries(store, requesterId)
  const shared = (opts.shared ?? [])
    .filter((s) => s.store.baseDir !== store.baseDir)
    .flatMap((s) => summaryEntries(s.store, requesterId, s.skip).map((e) => ({ ...e, path: `@${s.id}/${e.path}` })))
  const shortlist = [
    ...shortlistBySummary(question, own, cfg.shortlist, messagePath, graphWeight),
    ...shortlistBySummary(question, shared, cfg.sharedShortlist, messagePath, graphWeight),
  ]
  if (shortlist.length === 0) {
    return { ...emptyResult("no-candidates", question, "No page shares a word with the question."), ...base }
  }

  // --- 2. Pick pages ---
  const selectorStart = Date.now()
  let selectorOutput = ""
  let picked: SummaryEntry[]
  try {
    selectorOutput = await run(buildSummarySelectorPrompt(question, shortlist, cfg.maxPages), cfg.selectorModel, timeoutMs)
    picked = parsePicks(selectorOutput, shortlist).slice(0, cfg.maxPages)
  } catch (e: any) {
    log("selector failed:", e?.message)
    return { ...emptyResult("error", question, `Selector: ${e?.message || "unknown"}`), ...base, trace: { selectorMs: Date.now() - selectorStart, synthesisMs: 0, selectorOutput } }
  }
  const selectorMs = Date.now() - selectorStart
  const candidates = picked.map((p) => ({ title: p.title, path: p.path }))
  const pages = picked
    .map((p) => view.read(p.path))
    .filter((a): a is WikiArticle => !!a)
    .map((a) => ({ ...a, hop: 0, content: a.content.length > cfg.pageChars ? a.content.slice(0, cfg.pageChars) + "\n…" : a.content }))
  if (pages.length === 0) {
    return { ...emptyResult("no-candidates", question, "The selector picked no page."), ...base, candidates, trace: { selectorMs, synthesisMs: 0, selectorOutput } }
  }

  // --- 3–4. Live read ---
  const live = opts.live
  const sources = live?.enabled ? live.sources : []
  let lines: LiveLine[] = []
  let planOutput = ""
  let planMs = 0
  let liveMs = 0
  if (sources.length > 0 && (live?.maxReads ?? 6) > 0) {
    const planStart = Date.now()
    try {
      planOutput = await run(buildLivePlanPrompt(question, pages, sources, live?.maxReads ?? 6), cfg.plannerModel, timeoutMs)
    } catch (e: any) {
      // The answer is still given from the pages.
      log("live-read planner failed:", e?.message)
    }
    planMs = Date.now() - planStart
    const reads = validateReads(parseJsonArray(planOutput), sources, live?.maxReads ?? 6)
    const liveStart = Date.now()
    if (reads.length) {
      lines = await runLiveReads(reads, sources, {
        timeoutMs: live?.timeoutMs ?? 8000,
        nodes: live?.nodes,
        fetch: live?.fetch,
        env: live?.env,
      })
    }
    liveMs = Date.now() - liveStart
  }

  // --- 5. Answer ---
  const synthStart = Date.now()
  const walked = pages.map((w) => ({ title: w.meta.title, path: w.path, type: w.meta.type, hop: 0 }))
  let answer = ""
  try {
    answer = await run(buildSynthesisPrompt(question, pages, lines), cfg.answerModel, timeoutMs * 2)
  } catch (e: any) {
    log("synthesis failed:", e?.message)
    return {
      ...emptyResult("error", question, `Synthesis: ${e?.message || "unknown"}`), ...base, candidates, walked, live: lines,
      trace: { selectorMs, synthesisMs: Date.now() - synthStart, selectorOutput, planMs, liveMs, planOutput },
    }
  }
  return {
    answer: answer.trim(),
    citations: pages.map((a) => ({ title: a.meta.title, path: a.path, type: a.meta.type })),
    candidates,
    walked,
    status: "ok",
    ...base,
    live: lines,
    trace: { selectorMs, synthesisMs: Date.now() - synthStart, selectorOutput, planMs, liveMs, planOutput },
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** The pages of one store the requester may read, with their summaries. */
function summaryEntries(store: WikiStore, requesterId: string | undefined, skip?: (path: string) => boolean): SummaryEntry[] {
  const articles = store.listArticles(requesterId || "").filter((a) => !a.path.includes("/_versions/") && !skip?.(a.path))
  const summaries = freshSummaries(articles, loadSummaries(store))
  return articles.map((a) => ({
    path: a.path,
    title: a.meta.title,
    type: a.meta.type,
    tags: a.meta.tags ?? [],
    related: a.meta.related,
    graphPath: a.meta.graphPath,
    aliases: a.meta.aliases,
    owner: a.meta.owner,
    lastUpdated: a.meta.lastUpdated,
    summary: summaries.get(a.path),
  }))
}

/**
 * The `n` pages that share the most rare words with the question, over
 * title, other names, tags and summary. Pages that share none are left
 * out. Exported for tests.
 */
export function shortlistBySummary<T extends { title: string; tags?: string[]; aliases?: string[]; summary?: string; graphPath?: string[] }>(
  question: string,
  entries: T[],
  n: number,
  messagePath?: string[],
  graphWeight: number = DEFAULT_GRAPH_WEIGHT,
): T[] {
  if (n <= 0 || entries.length === 0) return []
  const docs = entries.map((e) => ({
    title: [e.title, ...(e.aliases ?? [])].join(" "),
    tags: e.tags,
    summary: e.summary,
    graphPath: e.graphPath,
  }))
  const matched = new Set(scoreAll(question, buildIndex(docs.map(catalogDoc))).map((r) => r.docIndex))
  return rankCatalogPool(question, docs, messagePath, graphWeight)
    .filter((i) => matched.has(i))
    .slice(0, n)
    .map((i) => entries[i])
}

function buildSummarySelectorPrompt(question: string, shortlist: SummaryEntry[], maxPages: number): string {
  const lines = shortlist.map((e, i) => {
    const from = [e.owner ? `owner ${e.owner}` : "", e.lastUpdated ? `updated ${e.lastUpdated.slice(0, 10)}` : ""].filter(Boolean).join(", ")
    return `k${i + 1}. ${e.title}${e.type ? ` [${e.type}]` : ""}${from ? ` {${from}}` : ""} — ${e.summary || "(no summary)"}`
  })
  return `You pick wiki pages that answer a question. You do NOT answer it.

## Question

${question}

## Pages (title, then a one-line summary)

${lines.join("\n")}

## Your task

Pick up to ${maxPages} pages whose summary says they hold the answer, best first. Pick none when no page fits.

Return ONLY a JSON array of page ids, no markdown fencing, no prose: ["k2", "k5"] or [].`
}

/** Page ids from the selector's reply, in its order, without repeats. */
function parsePicks<T>(raw: string, shortlist: T[]): T[] {
  const ids = parseJsonArray(raw)
  const out: T[] = []
  for (const id of ids) {
    const n = Number(/^k(\d+)$/i.exec(String(id).trim())?.[1])
    const entry = Number.isInteger(n) ? shortlist[n - 1] : undefined
    if (entry && !out.includes(entry)) out.push(entry)
  }
  return out
}

function parseJsonArray(raw: string): unknown[] {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Characters of each picked page the live-read planner sees. */
const PLAN_PAGE_CHARS = 2500

function buildLivePlanPrompt(
  question: string,
  pages: Array<WikiArticle & { hop: number }>,
  sources: LiveSource[],
  maxReads: number,
): string {
  const block = pages.map((a) => {
    const body = a.content.length > PLAN_PAGE_CHARS ? a.content.slice(0, PLAN_PAGE_CHARS) + "\n…" : a.content
    return `### ${a.meta.title}${a.meta.lastUpdated ? ` (updated ${a.meta.lastUpdated.slice(0, 10)})` : ""}\n\n${body}`
  }).join("\n\n---\n\n")
  return `A question will be answered from the wiki pages below. Pages can be out of date. Name the live reads that would confirm what may have changed since a page was written: the state of an issue or merge request the pages name, the newest release of a repository, the AgentX version running on each node. You only name reads; the system runs them.

## Question

${question}

## Pages

${block}

## Reads you may name

${describeSources(sources)}

## Your task

Name at most ${maxReads} reads that bear on the question, most useful first. Use only the sources and repositories listed. Name none when the pages need no check.

Return ONLY a JSON array, no markdown fencing, no prose. Each item is one of:
{"source": "<name>", "kind": "issue", "repo": "<repository>", "id": <number>}
{"source": "<name>", "kind": "merge_request", "repo": "<repository>", "id": <number>}
{"source": "<name>", "kind": "search", "repo": "<repository>", "query": "<a few words>"}
{"source": "<name>", "kind": "releases", "repo": "<repository>"}
{"source": "<name>", "kind": "version"}

Allowed kinds: ${LIVE_READ_KINDS.join(", ")}. Return [] for none.`
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
  pool: Array<{ title: string; tags?: string[]; related?: string[]; graphPath?: string[]; summary?: string }>,
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

/** What BM25 sees of a catalog entry: the catalog carries no body, only
 *  the page summary when there is one (#855). */
function catalogDoc(a: { title: string; tags?: string[]; related?: string[]; summary?: string }): string {
  return [a.title, (a.tags ?? []).join(" "), (a.related ?? []).join(" "), a.summary ?? ""].join(" ")
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

export function buildSynthesisPrompt(
  question: string,
  articles: Array<WikiArticle & { hop: number }>,
  live: LiveLine[] = [],
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
${live.length ? `
## Live read (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)

${live.map((l) => `- [${l.label}] ${l.source}: ${l.text}`).join("\n")}
` : ""}
## Your task

Answer the question in 2–6 sentences. Cite articles by their title in square brackets like [Article Title]. When two articles disagree, prefer the one updated more recently, and say which agent's page and date the answer comes from. If the articles do not answer the question, say so plainly (do not invent). Prefer concrete facts over hedging.${live.length ? LIVE_ANSWER_RULES : ""}

Output ONLY the answer — no preamble, no "here is my answer:", no markdown fencing.`
}

const LIVE_ANSWER_RULES = `

The live read is the state of the source system read just now. Where it and an article disagree about the current state of something, the live read wins. Mark each fact taken from the live read with its label, like [live 2], so the reader knows which facts came from the live read. A closed issue or a merged merge request does not by itself mean the change is released or deployed: say it is released or deployed only if an article or live line says so. If something the question needs was not read live, answer from the articles and say the current state was not checked.`

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

/** One model call through the `claude` CLI, no tools. */
export async function runClaudeCli(prompt: string, model: string, timeoutMs: number): Promise<string> {
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

/**
 * `wiki.query` from agentx.json as query options (#855): the method, the
 * counts and models of the summaries method, and the live read with the
 * nodes an `agentx` source asks. Empty when there is no config to read:
 * the method is then "auto" and nothing is read live. The CLI and the
 * `agentx_wiki_query` tool both ask here.
 */
export async function queryOptionsFromConfig(configPath?: string): Promise<Pick<AgenticQueryOptions, "method" | "summaries" | "live">> {
  let config: import("@/daemon/config").DaemonConfig
  try {
    const { loadDaemonConfig } = await import("@/daemon/config")
    config = loadDaemonConfig(configPath)
  } catch {
    return {}
  }
  const q = config.wiki.query
  const nodes: AgentxNode[] = [
    { name: config.node.name, url: config.dashboard.daemonUrl, token: config.dashboard.token },
    ...config.mesh.peers.map((p) => ({ name: p.name, url: p.url, token: p.token })),
  ]
  return {
    method: q.method,
    summaries: {
      shortlist: q.shortlist,
      sharedShortlist: q.sharedShortlist,
      maxPages: q.maxPages,
      pageChars: q.pageChars,
      selectorModel: q.models.selector,
      plannerModel: q.models.planner,
      answerModel: q.models.answer,
    },
    live: {
      enabled: q.live.enabled,
      sources: q.live.sources as LiveSource[],
      nodes,
      maxReads: q.live.maxReads,
      timeoutMs: q.live.timeoutMs,
    },
  }
}
