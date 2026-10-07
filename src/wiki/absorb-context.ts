// What `agentx wiki absorb` knows about the wiki before it writes (#801).
//
// Absorb used to show the model the catalog — titles and paths — and
// nothing else. In the 2026-10-07 A/B one model rewrote an existing event
// article it had never read and lost the commit, the test count and the
// review URL; the other wrote a second event article beside the first.
// Both are what a writer does when it cannot see the page it is editing.
//
// So before the compile call, each entry is run through the wiki query
// retrieval (BM25 shortlist, rerank seat, wikilink walk) and the articles
// it lands on go into the prompt in full. After the call, a save that
// would drop a commit, link or number from the article it replaces is
// refused, and a new article whose title an existing one already has is
// written over that one instead of beside it.

import { retrieveArticles, type CatalogEntry } from "./query"
import type { WikiArticle } from "./types"
import type { WikiStore } from "./store"

export type CoveringArticle = WikiArticle & { hop: number; entries: string[] }

export interface FindCoveringOptions {
  /** Articles picked per entry before the walk. Default 2. */
  perEntry?: number
  /** Cap on articles across the batch. Default 8. */
  maxArticles?: number
  /** Query text taken from each entry. Default 1500 chars. */
  queryChars?: number
  /** Swappable for tests. */
  retrieve?: typeof retrieveArticles
}

/**
 * The existing articles a batch of entries is about. Each entry is its own
 * query, so one batch mixing three subjects finds all three. Articles
 * picked directly (hop 0) and by more entries come first.
 */
export async function findCoveringArticles(
  entries: Array<{ id: string; content: string }>,
  store: WikiStore,
  agentId: string,
  pool: CatalogEntry[],
  opts: FindCoveringOptions = {},
): Promise<CoveringArticle[]> {
  const retrieve = opts.retrieve ?? retrieveArticles
  const perEntry = opts.perEntry ?? 2
  const maxArticles = opts.maxArticles ?? 8
  const queryChars = opts.queryChars ?? 1500
  const found = new Map<string, CoveringArticle>()

  for (const entry of entries) {
    let hits: Array<WikiArticle & { hop: number }> = []
    try {
      hits = await retrieve(entry.content.slice(0, queryChars), store, agentId, {
        pool,
        maxCandidates: perEntry,
        maxHops: 1,
        maxArticles: perEntry * 2,
        stage: "absorb-covering",
      })
    } catch {
      // Retrieval is an aid; an absorb without it is the old absorb.
    }
    for (const hit of hits) {
      const seen = found.get(hit.path)
      if (seen) {
        seen.hop = Math.min(seen.hop, hit.hop)
        if (!seen.entries.includes(entry.id)) seen.entries.push(entry.id)
      } else {
        found.set(hit.path, { ...hit, entries: [entry.id] })
      }
    }
  }

  return [...found.values()]
    .sort((a, b) => a.hop - b.hop || b.entries.length - a.entries.length || a.path.localeCompare(b.path))
    .slice(0, maxArticles)
}

/** The prompt section carrying the covering articles, in full. Articles are
 *  never cut short: the drop-guard checks the whole old article, so the
 *  model must have seen all of it. */
export function renderCoveringBlock(articles: CoveringArticle[]): string {
  if (articles.length === 0) return ""
  const body = articles
    .map((a) => {
      const header = `### ${a.meta.title} — ${a.meta.type || "untyped"} (${a.path})`
      const why = `Found for entries: ${a.entries.join(", ")}${a.hop > 0 ? " (linked from a match)" : ""}`
      const related = a.meta.related?.length ? `Related: ${a.meta.related.join(", ")}` : ""
      return [header, why, related, "", a.content].filter((l) => l !== "").join("\n")
    })
    .join("\n\n---\n\n")
  return `
## Articles already covering these entries

These ${articles.length} articles were found by searching the wiki for each entry below. Read them before you write.

- When an entry is about the subject of one of these articles, UPDATE that article: write it at the SAME path with the SAME title, carrying its full content merged with what the entry adds.
- Keep every fact the article already has: commit hashes, URLs, numbers, dates and [[wikilinks]]. Restructure freely, but do not drop one unless an entry explicitly says it is wrong. A save that drops one is refused and the entries stay queued.
- Do not create a second article (a new path or a near-identical title) for a subject one of these already covers.

${body}
`
}

// --- Drop-guard ---

export interface ArticleFacts {
  commits: string[]
  urls: string[]
  wikilinks: string[]
  numbers: string[]
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
// A short or full git hash: 7–40 hex chars holding at least one digit and
// one letter, so words like "defaced" and plain numbers are not hashes.
const COMMIT_RE = /(?<![\w-])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/gi
// A number standing on its own: "12", "1,234", "3.5", "2026-10-07", "14:30",
// "v2"-style suffixes excluded by the look-behind.
const NUMBER_RE = /(?<![\w.,:/-])\d+(?:[.,:\-/]\d+)*(?![\w])/g
const LIST_MARKER_RE = /^\s*\d+[.)]\s/gm

/** The facts a rewrite must not lose, extracted from an article body. */
export function extractFacts(text: string): ArticleFacts {
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?'"]+$/, ""))
  const wikilinks = [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim())
  // Hashes and numbers are read with URLs and wikilink targets removed, so
  // a path segment or "Release 2" in a link is not counted twice.
  const rest = text.replace(URL_RE, " ").replace(WIKILINK_RE, " ").replace(LIST_MARKER_RE, " ")
  const commits = [...rest.matchAll(COMMIT_RE)].map((m) => m[0].toLowerCase())
  const withoutCommits = rest.replace(COMMIT_RE, " ")
  const numbers = [...withoutCommits.matchAll(NUMBER_RE)]
    .map((m) => normaliseNumber(m[0]))
  return {
    commits: unique(commits),
    urls: unique(urls),
    wikilinks: unique(wikilinks),
    numbers: unique(numbers),
  }
}

/**
 * The facts in `oldContent` that `newContent` no longer carries. Empty
 * means the rewrite is safe to save.
 *
 * A short hash is kept when the new text has it at any length; a URL or
 * wikilink is compared without case or trailing slash; a number is
 * compared as a token (thousands separators ignored), so "12" is not
 * found inside "2012".
 */
export function droppedFacts(oldContent: string, newContent: string): string[] {
  const before = extractFacts(oldContent)
  const after = extractFacts(newContent)
  const lowerNew = newContent.toLowerCase()
  const dropped: string[] = []

  for (const c of before.commits) {
    if (!lowerNew.includes(c) && !after.commits.some((n) => n.startsWith(c) || c.startsWith(n))) {
      dropped.push(`commit ${c}`)
    }
  }
  const urlKey = (u: string) => u.toLowerCase().replace(/\/+$/, "")
  const newUrls = new Set(after.urls.map(urlKey))
  for (const u of before.urls) {
    if (!newUrls.has(urlKey(u))) dropped.push(`link ${u}`)
  }
  const newLinks = new Set(after.wikilinks.map((l) => l.toLowerCase()))
  for (const l of before.wikilinks) {
    if (!newLinks.has(l.toLowerCase())) dropped.push(`link [[${l}]]`)
  }
  const newNumbers = new Set(after.numbers)
  for (const n of before.numbers) {
    if (!newNumbers.has(n)) dropped.push(`number ${n}`)
  }
  return dropped
}

function normaliseNumber(n: string): string {
  // 1,234 → 1234; leave 3,5 (a decimal comma) and dates alone.
  return /^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, "") : n
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

// --- Duplicate redirect ---

/**
 * Where an absorbed article is written. A new path whose title an existing
 * article already carries is the same subject filed twice, so it goes to
 * the existing article — where the drop-guard then applies.
 */
export function absorbTargetPath(
  article: { path: string; title: string },
  catalog: Array<{ path: string; title: string }>,
): string {
  if (catalog.some((a) => a.path === article.path)) return article.path
  const key = titleKey(article.title)
  if (!key) return article.path
  return catalog.find((a) => titleKey(a.title) === key)?.path ?? article.path
}

function titleKey(title: string): string {
  return (title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}
