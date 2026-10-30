/**
 * The wiki retrieval check (#603, fix 7): does BM25 find the right article
 * for questions the operator wrote about their own wiki?
 *
 * The audit found the old check meaningless: it read raw entries as
 * articles (11,591 "articles"), its expected titles were placeholders not in
 * any live wiki, and it passed on misses. Now it reads articles only, the
 * questions and their expected titles live in a private file outside the
 * repository (they name real people and systems), and it fails under a
 * floor the file sets. test/eval/real-data-eval.test.ts runs it.
 */
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

/** Where the private questions are read from, inside the wiki folder's parent (.agentx/). */
export const RETRIEVAL_CASES_FILE = "retrieval-cases.json"

/** R@3 under this fails the check when the file sets no floor. */
export const DEFAULT_RETRIEVAL_FLOOR = 0.6

export interface RetrievalCase {
  name: string
  query: string
  /** The right article's title contains this (any case). */
  expectedTitleContains: string
  category?: string
}

export interface RetrievalCases {
  /** Share of cases whose article must be in the top three, 0 to 1. */
  floor: number
  cases: RetrievalCase[]
}

/**
 * A compiled article, by its path relative to the wiki folder: Markdown,
 * not under raw/ (captured entries waiting for absorb) and not a working
 * file (_*, WIKI.md, log.md, worldview.md).
 */
export function isArticlePath(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  const base = parts[parts.length - 1]
  if (!base.endsWith(".md")) return false
  if (parts.some((p) => p === "raw" || p.startsWith("_"))) return false
  return !["WIKI.md", "log.md", "worldview.md"].includes(base)
}

/** Read and check the questions file. Throws with what is wrong. */
export function parseRetrievalCases(text: string): RetrievalCases {
  const data = JSON.parse(text)
  const list = Array.isArray(data) ? data : data?.cases
  if (!Array.isArray(list) || list.length === 0) throw new Error("no cases: give a list, or { floor, cases: [...] }")
  const cases = list.map((c: any, i: number): RetrievalCase => {
    for (const k of ["query", "expectedTitleContains"]) {
      if (typeof c?.[k] !== "string" || !c[k].trim()) throw new Error(`case ${i + 1}: "${k}" is missing`)
    }
    return { name: typeof c.name === "string" && c.name ? c.name : c.query, query: c.query, expectedTitleContains: c.expectedTitleContains, ...(c.category ? { category: String(c.category) } : {}) }
  })
  const floor = Array.isArray(data) || data.floor === undefined ? DEFAULT_RETRIEVAL_FLOOR : Number(data.floor)
  if (!(floor >= 0 && floor <= 1)) throw new Error(`"floor" must be between 0 and 1, got ${data.floor}`)
  return { floor, cases }
}

/** The questions file: $AGENTX_RETRIEVAL_CASES, else .agentx/retrieval-cases.json. Null when there is none. */
export function findRetrievalCases(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.AGENTX_RETRIEVAL_CASES || resolve(cwd, ".agentx", RETRIEVAL_CASES_FILE)
  return existsSync(file) ? file : null
}

export function loadRetrievalCases(file: string): RetrievalCases {
  try {
    return parseRetrievalCases(readFileSync(file, "utf-8"))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
}

/** Whether one of the first `k` titles contains the expected one. */
export function hitAt(titles: string[], expected: string, k: number): boolean {
  const want = expected.toLowerCase()
  return titles.slice(0, k).some((t) => t.toLowerCase().includes(want))
}
