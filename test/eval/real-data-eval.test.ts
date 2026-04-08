import { describe, it, expect, beforeAll } from "vitest"
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync } from "fs"
import { join, relative } from "path"
import { buildIndex, scoreAll } from "../../src/memory/bm25"

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

// --- Test cases: realistic queries an agent would receive ---
// Each has a query and a substring that MUST appear in the correct article's title or path
interface RealTestCase {
  name: string
  query: string
  /** The correct article's title must contain this (case-insensitive) */
  expectedTitleContains: string
  /** Category for reporting */
  category: "infra" | "incident" | "people" | "project" | "cross-agent" | "synonym"
}

const REAL_CASES: RealTestCase[] = [
  // --- Infrastructure queries ---
  {
    name: "mtgl staging deployment steps",
    query: "how do I deploy mtgl to staging",
    expectedTitleContains: "MTGL DevOps Environment",
    category: "infra",
  },
  {
    name: "noqta website deploy pipeline",
    query: "how does noqta.tn deployment work",
    expectedTitleContains: "Noqta.tn Website",
    category: "infra",
  },
  {
    name: "elevenlabs voice integration",
    query: "what is the elevenlabs meet voice pipeline spike",
    expectedTitleContains: "ElevenLabs",
    category: "infra",
  },

  // --- Incident queries ---
  {
    name: "gitlab token expired",
    query: "gitlab token expired what happened",
    expectedTitleContains: "GITLAB_TOKEN Expired",
    category: "incident",
  },
  {
    name: "whatsapp echo loop",
    query: "whatsapp bot sending messages to itself in a loop",
    expectedTitleContains: "WhatsApp Echo Loop",
    category: "incident",
  },
  {
    name: "gitlab token renewal process",
    query: "how to renew the gitlab personal access token",
    expectedTitleContains: "GITLAB_TOKEN Expired",
    category: "incident",
  },

  // --- People queries ---
  {
    name: "who is seif",
    query: "who is seif al-arabi and what does he do",
    expectedTitleContains: "Seif al-Arabi",
    category: "people",
  },

  // --- Agent queries ---
  {
    name: "what does atlas do",
    query: "what is atlas agent responsible for",
    expectedTitleContains: "Atlas",
    category: "cross-agent",
  },

  // --- Project queries ---
  {
    name: "seo keywords noqta",
    query: "what are our SEO keyword targets for noqta.tn",
    expectedTitleContains: "SEO Priorities",
    category: "project",
  },

  // --- Synonym/indirect queries (harder) ---
  {
    name: "bot stuck in loop",
    query: "the bot keeps repeating itself what is wrong",
    expectedTitleContains: "Echo Loop",
    category: "synonym",
  },
  {
    name: "server credentials",
    query: "what are the database credentials for mtgl",
    expectedTitleContains: "MTGL DevOps Environment",
    category: "synonym",
  },
  {
    name: "CI pipeline stages",
    query: "what are the CI pipeline stages for the website",
    expectedTitleContains: "Noqta.tn Website",
    category: "synonym",
  },
]

describe("Real Data Eval: BM25 vs Word-Overlap on Wiki Articles", () => {
  let articles: Article[] = []
  let docs: string[] = []

  beforeAll(() => {
    const wikiBase = join(process.cwd(), ".agentx/wiki")
    walkDir(wikiBase, (filePath) => {
      if (!filePath.endsWith(".md")) return
      const rel = relative(wikiBase, filePath)
      if (rel.includes("/raw/") || rel.startsWith("_")) return
      // Skip index/log/worldview files
      const base = filePath.split("/").pop() ?? ""
      if (["WIKI.md", "log.md", "worldview.md"].includes(base)) return
      if (base.startsWith("_")) return

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
    const topK = ranked.slice(0, k)
    return topK.some((idx) =>
      articles[idx].title.toLowerCase().includes(expectedTitle.toLowerCase()),
    )
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

      const cat = categories.get(tc.category) ?? { oldR1: 0, oldR3: 0, newR1: 0, newR3: 0, count: 0 }
      cat.oldR1 += oR1; cat.oldR3 += oR3; cat.newR1 += nR1; cat.newR3 += nR3; cat.count++
      categories.set(tc.category, cat)

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
})
