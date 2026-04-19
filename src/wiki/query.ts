import { readFileSync, existsSync } from "fs"
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
    selectorOutput = await runClaude(
      buildSelectorPrompt(question, catalog, maxCandidates),
      selectorModel,
      timeoutMs,
    )
    candidates = parseCandidates(selectorOutput)
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

function buildSelectorPrompt(question: string, catalog: string, maxCandidates: number): string {
  return `You are picking candidate articles from a wiki catalog to answer a question. You do NOT answer the question. You pick which articles the answer is likely to come from.

## Question

${question}

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
    const raw = execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
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
