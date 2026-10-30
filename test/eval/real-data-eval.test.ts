import { describe, it, expect, beforeAll } from "vitest"
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync } from "fs"
import { join, relative } from "path"
import { buildIndex, scoreAll } from "../../src/memory/bm25"
import { DEFAULT_RETRIEVAL_FLOOR, findRetrievalCases, hitAt, isArticlePath, loadRetrievalCases } from "../../src/wiki/retrieval-check"

// --- Load real wiki articles from .agentx/wiki ---

interface Article {
  path: string
  title: string
  tags: string[]
  content: string
}

function walkDir(dir: string, cb: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walkDir(full, cb)
    else cb(full)
  }
}

function parseArticle(filePath: string): Article | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    // Parse YAML frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) return null

    const fm = fmMatch[1]
    const content = fmMatch[2]

    const titleMatch = fm.match(/title:\s*"([^"]*)"/)
    const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/)

    const title = titleMatch?.[1] ?? ""
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""))
      : []

    return { path: filePath, title, tags, content }
  } catch {
    return null
  }
}

// --- Old word-overlap scoring for comparison ---
function oldScoreRelevance(section: string, query: string): number {
  const qWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  )
  if (qWords.size === 0) return 0
  const sWords = new Set(
    section.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  )
  let overlap = 0
  for (const w of qWords) {
    if (sWords.has(w)) overlap++
  }
  return overlap / qWords.size
}

// --- Test cases: the operator's own questions (#603) ---
// They name real people and systems, so they live outside the repository:
// $AGENTX_RETRIEVAL_CASES or .agentx/retrieval-cases.json, as
// { "floor": 0.6, "cases": [{ "name", "query", "expectedTitleContains", "category" }] }.
// See src/wiki/retrieval-check.ts.
const CASES_FILE = findRetrievalCases()
const { floor: FLOOR, cases: REAL_CASES } = CASES_FILE ? loadRetrievalCases(CASES_FILE) : { floor: DEFAULT_RETRIEVAL_FLOOR, cases: [] }

// This grades retrieval against the operator's OWN wiki and questions, so it
// only means anything on a machine that has both. A clean checkout (CI, a
// new clone) has neither and skips: the repo deliberately ships no data.
const WIKI_DIR = join(process.cwd(), ".agentx/wiki")
const hasWiki = existsSync(WIKI_DIR) && REAL_CASES.length > 0

describe.skipIf(!hasWiki)("Real Data Eval: BM25 vs Word-Overlap on Wiki Articles", () => {
  let articles: Article[] = []
  let docs: string[] = []

  beforeAll(() => {
    const wikiBase = WIKI_DIR
    walkDir(wikiBase, (filePath) => {
      // Compiled articles only: raw/ holds captured entries waiting for
      // absorb, and reading them as articles inflated the corpus 40-fold.
      if (!isArticlePath(relative(wikiBase, filePath))) return

      const article = parseArticle(filePath)
      if (article) articles.push(article)
    })

    // Build searchable docs: title + tags + content (same as wiki findRelevant)
    docs = articles.map(
      (a) => `${a.title} ${a.tags.join(" ")} ${a.content}`,
    )
  })

  it("loads real wiki articles", () => {
    console.log(`\nLoaded ${articles.length} real wiki articles`)
    expect(articles.length).toBeGreaterThan(10)
  })

  function findWithOld(query: string): number[] {
    const scores = docs.map((doc, i) => ({
      index: i,
      score: oldScoreRelevance(doc, query),
    }))
    scores.sort((a, b) => b.score - a.score)
    return scores.map((s) => s.index)
  }

  function findWithBM25(query: string): number[] {
    const index = buildIndex(docs)
    const results = scoreAll(query, index)
    const ranked = results.map((r) => r.docIndex)
    for (let i = 0; i < docs.length; i++) {
      if (!ranked.includes(i)) ranked.push(i)
    }
    return ranked
  }

  function isHit(ranked: number[], expectedTitle: string, k: number): boolean {
    return hitAt(ranked.slice(0, k).map((idx) => articles[idx].title), expectedTitle, k)
  }

  // Per-case tests
  for (const tc of REAL_CASES) {
    it(`BM25 finds "${tc.expectedTitleContains}" for: ${tc.name}`, () => {
      const ranked = findWithBM25(tc.query)
      const top3 = ranked.slice(0, 3).map((i) => articles[i].title)

      const hit3 = isHit(ranked, tc.expectedTitleContains, 3)
      const hit5 = isHit(ranked, tc.expectedTitleContains, 5)
      const marker = tc.category === "synonym" ? "[synonym]" : ""

      if (!hit3) {
        console.log(
          `  ${marker} MISS: ${tc.name} — expected "${tc.expectedTitleContains}" in top 3`,
        )
        console.log(`  Got: ${JSON.stringify(top3)}`)
      }

      // Eval benchmarks: report, don't hard-fail (except track for aggregate)
      // This lets us see the full picture without stopping early
    })
  }

  // Aggregate comparison
  it("prints comparison table", () => {
    const categories = new Map<
      string,
      { oldR1: number; oldR3: number; newR1: number; newR3: number; count: number }
    >()

    let totalOldR1 = 0, totalOldR3 = 0
    let totalNewR1 = 0, totalNewR3 = 0

    const details: string[] = []

    for (const tc of REAL_CASES) {
      const oldRanked = findWithOld(tc.query)
      const newRanked = findWithBM25(tc.query)

      const oR1 = isHit(oldRanked, tc.expectedTitleContains, 1) ? 1 : 0
      const oR3 = isHit(oldRanked, tc.expectedTitleContains, 3) ? 1 : 0
      const nR1 = isHit(newRanked, tc.expectedTitleContains, 1) ? 1 : 0
      const nR3 = isHit(newRanked, tc.expectedTitleContains, 3) ? 1 : 0

      totalOldR1 += oR1; totalOldR3 += oR3
      totalNewR1 += nR1; totalNewR3 += nR3

      const cat = categories.get(tc.category ?? "all") ?? { oldR1: 0, oldR3: 0, newR1: 0, newR3: 0, count: 0 }
      cat.oldR1 += oR1; cat.oldR3 += oR3; cat.newR1 += nR1; cat.newR3 += nR3; cat.count++
      categories.set(tc.category ?? "all", cat)

      // Detail line
      const oldTop1 = articles[oldRanked[0]]?.title ?? "?"
      const newTop1 = articles[newRanked[0]]?.title ?? "?"
      const oldMark = oR1 ? "+" : oR3 ? "~" : "X"
      const newMark = nR1 ? "+" : nR3 ? "~" : "X"
      details.push(
        `  ${newMark}/${oldMark} ${tc.name.padEnd(35)} BM25→"${newTop1.slice(0, 40)}" | Old→"${oldTop1.slice(0, 40)}"`,
      )
    }

    const n = REAL_CASES.length

    console.log("\n=== Real Data Eval ===")
    console.log(`Corpus: ${articles.length} wiki articles\n`)
    console.table({
      "Word-Overlap": {
        "R@1": `${((totalOldR1 / n) * 100).toFixed(1)}%`,
        "R@3": `${((totalOldR3 / n) * 100).toFixed(1)}%`,
      },
      "BM25": {
        "R@1": `${((totalNewR1 / n) * 100).toFixed(1)}%`,
        "R@3": `${((totalNewR3 / n) * 100).toFixed(1)}%`,
      },
    })

    console.log("\n=== Per-Category R@1 / R@3 ===\n")
    const catTable: Record<string, { "Old R@1": string; "Old R@3": string; "BM25 R@1": string; "BM25 R@3": string }> = {}
    for (const [tag, cat] of categories) {
      catTable[tag] = {
        "Old R@1": `${((cat.oldR1 / cat.count) * 100).toFixed(0)}%`,
        "Old R@3": `${((cat.oldR3 / cat.count) * 100).toFixed(0)}%`,
        "BM25 R@1": `${((cat.newR1 / cat.count) * 100).toFixed(0)}%`,
        "BM25 R@3": `${((cat.newR3 / cat.count) * 100).toFixed(0)}%`,
      }
    }
    console.table(catTable)

    console.log("\n=== Per-Query Detail (+= R@1 hit, ~= R@3 hit, X= miss) ===")
    console.log(`  BM25/Old  ${"Query".padEnd(35)} Top-1 results`)
    for (const d of details) console.log(d)
    console.log()

    // Append to RETRIEVAL_SCORES.md if --update flag or TRACK_SCORES env
    if (process.env.TRACK_SCORES) {
      const scoreFile = join(process.cwd(), ".agentx/RETRIEVAL_SCORES.md")
      const date = new Date().toISOString().slice(0, 10)
      const bm25R1 = ((totalNewR1 / n) * 100).toFixed(1)
      const bm25R3 = ((totalNewR3 / n) * 100).toFixed(1)
      const oldR1 = ((totalOldR1 / n) * 100).toFixed(1)
      const oldR3 = ((totalOldR3 / n) * 100).toFixed(1)
      const misses = REAL_CASES.filter((tc) => {
        const ranked = findWithBM25(tc.query)
        return !isHit(ranked, tc.expectedTitleContains, 3)
      }).map((tc) => tc.name)

      const entry = `| ${date} | ${articles.length} | ${n} | ${bm25R1}% | ${bm25R3}% | ${oldR1}% | ${oldR3}% | ${misses.length > 0 ? misses.join(", ") : "none"} |\n`

      if (!existsSync(scoreFile)) {
        const header =
          "# Retrieval Eval Scores\n\n" +
          "Track retrieval quality over time. Run `TRACK_SCORES=1 npm run eval` to append.\n\n" +
          "| Date | Articles | Cases | BM25 R@1 | BM25 R@3 | Old R@1 | Old R@3 | Misses |\n" +
          "|------|----------|-------|----------|----------|---------|---------|--------|\n"
        appendFileSync(scoreFile, header)
      }
      appendFileSync(scoreFile, entry)
      console.log(`Score tracked → RETRIEVAL_SCORES.md`)
    }
  })

  // The check itself (#603): a miss counts. Under the floor the questions
  // file sets, the run fails.
  it(`finds the right article in the top three for at least the floor of the questions`, () => {
    const hits = REAL_CASES.filter((tc) => isHit(findWithBM25(tc.query), tc.expectedTitleContains, 3)).length
    const share = hits / REAL_CASES.length
    console.log(`BM25 R@3: ${hits}/${REAL_CASES.length} (${(share * 100).toFixed(1)}%), floor ${(FLOOR * 100).toFixed(0)}%`)
    expect(share, `R@3 ${hits}/${REAL_CASES.length} is under the floor ${FLOOR}`).toBeGreaterThanOrEqual(FLOOR)
  })
})
