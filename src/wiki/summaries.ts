import { createHash } from "crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { WikiArticle } from "./types"
import type { WikiStore } from "./store"

/**
 * Page summaries (#855): one short line per wiki page, kept in a side file
 * beside the agent's catalog. `wiki query` picks pages from these lines
 * instead of from titles alone.
 *
 * The pages themselves are never touched. Each line carries a hash of the
 * page it was written from, so a page that changed is summarised again and
 * an unchanged one is skipped. The file is saved after every batch, so a
 * run that stops halfway resumes where it left off.
 */

export const SUMMARY_FILE = "_summaries.json"
/** Longest summary kept, in words. */
export const SUMMARY_MAX_WORDS = 35
/** Characters of a page the summariser reads. */
const PAGE_CHARS_FOR_SUMMARY = 3000

export interface SummaryLine {
  /** Hash of the page title and text the line was written from. */
  hash: string
  summary: string
  /** When the line was written. */
  at: string
  model?: string
}

export interface SummaryFile {
  version: 1
  pages: Record<string, SummaryLine>
}

export function summaryPath(store: WikiStore): string {
  return resolve(store.baseDir, SUMMARY_FILE)
}

/** Hash of what a summary is written from: the title and the page text. */
export function pageHash(article: Pick<WikiArticle, "meta" | "content">): string {
  return createHash("sha1").update(`${article.meta.title}\n${article.content}`).digest("hex").slice(0, 16)
}

export function loadSummaries(store: WikiStore): SummaryFile {
  const path = summaryPath(store)
  if (!existsSync(path)) return { version: 1, pages: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (parsed && typeof parsed.pages === "object" && parsed.pages) return { version: 1, pages: parsed.pages }
  } catch {}
  return { version: 1, pages: {} }
}

export function saveSummaries(store: WikiStore, file: SummaryFile): void {
  const path = summaryPath(store)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(file, null, 2))
  renameSync(tmp, path)
}

/** Whether the store has a summary file with at least one line. */
export function hasSummaries(store: WikiStore): boolean {
  return Object.keys(loadSummaries(store).pages).length > 0
}

/** Pages a summary is kept for: every page but old versions. */
function summarisable(store: WikiStore, skip?: (path: string) => boolean): WikiArticle[] {
  return store.listAllArticles().filter((a) => !a.path.includes("/_versions/") && !skip?.(a.path))
}

/**
 * Summaries still true of their page, by page path. A line whose page
 * changed since it was written is left out: a stale summary would pick a
 * page for what it used to say.
 */
export function freshSummaries(articles: WikiArticle[], file: SummaryFile): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of articles) {
    const line = file.pages[a.path]
    if (line && line.hash === pageHash(a) && line.summary) out.set(a.path, line.summary)
  }
  return out
}

/** Pages with no summary or one written from an older text, and lines
 *  whose page is gone. */
export function staleSummaries(
  articles: WikiArticle[],
  file: SummaryFile,
): { stale: WikiArticle[]; removed: string[] } {
  const live = new Set(articles.map((a) => a.path))
  const stale = articles.filter((a) => file.pages[a.path]?.hash !== pageHash(a))
  const removed = Object.keys(file.pages).filter((p) => !live.has(p))
  return { stale, removed }
}

/** Cut a summary to one line of at most SUMMARY_MAX_WORDS words. */
export function clipSummary(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  if (words.length <= SUMMARY_MAX_WORDS) return words.join(" ")
  return words.slice(0, SUMMARY_MAX_WORDS).join(" ").replace(/[,;:]$/, "") + "…"
}

export function buildSummaryPrompt(pages: WikiArticle[]): string {
  const blocks = pages.map((a, i) => {
    const body = a.content.length > PAGE_CHARS_FOR_SUMMARY ? a.content.slice(0, PAGE_CHARS_FOR_SUMMARY) + "\n…" : a.content
    return `### p${i + 1}: ${a.meta.title}${a.meta.type ? ` [${a.meta.type}]` : ""}\n\n${body}`
  }).join("\n\n---\n\n")
  return `You write one-line summaries of wiki pages. A search reads these lines to decide which page answers a question, so name what the page is about and the facts it holds: the people, projects, systems, issue or merge request numbers, repositories, versions and dates it names.

Rules:
- One line per page, ${SUMMARY_MAX_WORDS} words at most.
- Say only what the page says. Do not add or guess.
- No "This page…" opener; start with the subject.

## Pages

${blocks}

## Reply

Return ONLY a JSON object mapping each page id to its line, no markdown fencing:

{"p1": "…", "p2": "…"}`
}

/** Read the model's reply: page id → line. Unknown ids and empty lines
 *  are dropped. */
export function parseSummaryReply(raw: string, count: number): Map<number, string> {
  const out = new Map<number, string>()
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return out
  let parsed: unknown
  try { parsed = JSON.parse(match[0]) } catch { return out }
  if (!parsed || typeof parsed !== "object") return out
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(/^p(\d+)$/.exec(key)?.[1])
    if (!Number.isInteger(n) || n < 1 || n > count || typeof value !== "string") continue
    const line = clipSummary(value)
    if (line) out.set(n - 1, line)
  }
  return out
}

export interface SummarizeOptions {
  model?: string
  /** Pages per model call. Default 20. */
  batchSize?: number
  /** Stop after this many pages; the next run picks up the rest. */
  limit?: number
  /** Count the pages that need a summary without calling the model. */
  dryRun?: boolean
  /** Paths to leave out (the agents/ tree under the root store). */
  skip?: (path: string) => boolean
  /** Runs one model call; the CLI passes the `claude` CLI runner. */
  run: (prompt: string, model: string) => Promise<string>
  log?: (line: string) => void
}

export interface SummarizeResult {
  pages: number
  stale: number
  written: number
  failed: number
  removed: number
  batches: number
}

/**
 * Bring a store's summary file up to date: summarise new and changed
 * pages in batches, drop lines whose page is gone. Saves after each batch.
 */
export async function summarizeStore(store: WikiStore, opts: SummarizeOptions): Promise<SummarizeResult> {
  const model = opts.model ?? "haiku"
  const batchSize = Math.max(1, opts.batchSize ?? 20)
  const articles = summarisable(store, opts.skip)
  const file = loadSummaries(store)
  const { stale, removed } = staleSummaries(articles, file)
  const todo = opts.limit !== undefined ? stale.slice(0, Math.max(0, opts.limit)) : stale
  const result: SummarizeResult = { pages: articles.length, stale: stale.length, written: 0, failed: 0, removed: removed.length, batches: 0 }
  if (opts.dryRun) return result

  if (removed.length) {
    for (const p of removed) delete file.pages[p]
    saveSummaries(store, file)
  }
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize)
    result.batches++
    let lines: Map<number, string>
    try {
      lines = parseSummaryReply(await opts.run(buildSummaryPrompt(batch), model), batch.length)
    } catch (e: any) {
      opts.log?.(`batch ${result.batches} failed: ${e?.message || e}`)
      result.failed += batch.length
      continue
    }
    const at = new Date().toISOString()
    batch.forEach((a, k) => {
      const summary = lines.get(k)
      if (!summary) { result.failed++; return }
      file.pages[a.path] = { hash: pageHash(a), summary, at, model }
      result.written++
    })
    saveSummaries(store, file)
    opts.log?.(`batch ${result.batches}: ${lines.size}/${batch.length} pages summarised`)
  }
  return result
}
