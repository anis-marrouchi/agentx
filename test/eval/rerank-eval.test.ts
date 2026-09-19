import { describe, it, expect, beforeAll } from "vitest"
import { buildIndex, scoreAll } from "../../src/memory/bm25"
import {
  REAL_CASES, hasWiki, isHit, loadCorpus, type Article,
} from "./wiki-corpus"
import { getDecisionBackend, registerDecisionBackend } from "../../src/decisions/backend"
import { createSimpleJevBackend } from "../../src/decisions/backends/simple-jev"
import {
  DEFAULT_SHORTLIST, rerankQuestions, rerankState, toRanking,
  type RerankCandidate,
} from "../../src/decisions/seats/wiki-rerank"

// Does re-ranking a BM25 shortlist with Jev actually retrieve better?
//
// Opt-in: it spends real money (about a cent a run) and needs a key.
//   AGENTX_RERANK_EVAL=1 TYPESAFE_API_KEY=... npx vitest run test/eval/rerank-eval.test.ts
//
// Baseline on this corpus is BM25 at R@1 33.3% / R@3 41.7% over 11,656
// articles. The arms share ground truth via wiki-corpus.ts — a re-ranker
// graded against its own expectations measures nothing.
//
// Twelve queries is a small set. The assertions below are deliberately
// weak (no regression, and the per-query table is the real output),
// because on n=12 a two-query swing looks like a 17-point move. Read the
// table, not the headline.

const live = process.env.AGENTX_RERANK_EVAL === "1" && Boolean(process.env.TYPESAFE_API_KEY)
// The shortlist is the ceiling: the re-ranker can only find what BM25
// handed it. Sweepable, because the first run put R@3 exactly on that
// ceiling — every remaining miss was a recall failure, not a ranking one.
const SHORTLIST = Number(process.env.AGENTX_RERANK_K ?? DEFAULT_SHORTLIST)
const EXCERPT = Number(process.env.AGENTX_RERANK_EXCERPT ?? 600)

describe.skipIf(!hasWiki || !live)("Re-ranking: BM25 vs BM25 + Jev", () => {
  let articles: Article[] = []
  let docs: string[] = []

  beforeAll(() => {
    const corpus = loadCorpus()
    articles = corpus.articles
    docs = corpus.docs
    registerDecisionBackend("typesafe", () =>
      createSimpleJevBackend({
        name: "typesafe",
        baseUrl: "https://api.typesafe.ai/v1",
        path: "/systemone",
        model: "jev-latest",
        apiKeyEnv: "TYPESAFE_API_KEY",
        probabilitySource: "native",
        maxChoiceOptions: 255,
        maxStateChars: 90_000,
        timeoutMs: 60_000,
      }),
    )
  })

  function bm25Rank(query: string): number[] {
    const index = buildIndex(docs)
    const ranked = scoreAll(query, index).map((r) => r.docIndex)
    for (let i = 0; i < docs.length; i++) if (!ranked.includes(i)) ranked.push(i)
    return ranked
  }

  it("re-ranks the shortlist and reports R@1 / R@3 against BM25", async () => {
    const rows: Array<Record<string, string>> = []
    let bm25At1 = 0, bm25At3 = 0, jevAt1 = 0, jevAt3 = 0
    let cost = 0, calls = 0, ms = 0, truncated = 0

    for (const tc of REAL_CASES) {
      const baseline = bm25Rank(tc.query)
      const shortlist = baseline.slice(0, SHORTLIST)

      const candidates: RerankCandidate[] = shortlist.map((idx) => ({
        // Index as id: titles are not unique and a Choice needs distinct keys.
        id: `a${idx}`,
        title: articles[idx].title || `(untitled ${idx})`,
        tags: articles[idx].tags,
        excerpt: articles[idx].content,
      }))

      const started = Date.now()
      const res = await getDecisionBackend("typesafe").decide({
        state: rerankState({ query: tc.query, candidates, excerptChars: EXCERPT }),
        questions: rerankQuestions(candidates),
        timeoutMs: 60_000,
      })
      ms += Date.now() - started
      calls++
      cost += res.usage.inputTokens
      if (res.meta.stateTruncated) truncated++

      const ranking = toRanking(res.answers as any, candidates)
      const jevRanked = ranking.ranked.map((id) => Number(id.slice(1)))

      const b1 = isHit(articles, baseline, tc.expectedTitleContains, 1)
      const b3 = isHit(articles, baseline, tc.expectedTitleContains, 3)
      const j1 = isHit(articles, jevRanked, tc.expectedTitleContains, 1)
      const j3 = isHit(articles, jevRanked, tc.expectedTitleContains, 3)
      // Can the re-ranker even succeed? If BM25's 30 missed it, no.
      const inShortlist = isHit(articles, shortlist, tc.expectedTitleContains, SHORTLIST)

      if (b1) bm25At1++
      if (b3) bm25At3++
      if (j1) jevAt1++
      if (j3) jevAt3++

      rows.push({
        query: tc.name.slice(0, 32).padEnd(32),
        cat: tc.category.slice(0, 11).padEnd(11),
        inTop30: inShortlist ? "y" : "n",
        bm25: `${b1 ? "1" : b3 ? "3" : "X"}`,
        jev: `${j1 ? "1" : j3 ? "3" : "X"}`,
        move: !inShortlist ? "-" : j1 && !b1 ? "UP" : b1 && !j1 ? "DOWN" : "=",
        answerable: ranking.answerable.toFixed(2),
        conf: ranking.confidence.toFixed(3),
      })
    }

    const n = REAL_CASES.length
    const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`
    console.log("\n=== Per-query (1 = top-1 hit, 3 = top-3 hit, X = miss) ===")
    console.log(
      "query                            cat         top30 bm25 jev  move answerable conf",
    )
    for (const r of rows) {
      console.log(
        `${r.query} ${r.cat} ${r.inTop30.padEnd(5)} ${r.bm25.padEnd(4)} ${r.jev.padEnd(4)} ${r.move.padEnd(4)} ${r.answerable.padEnd(10)} ${r.conf}`,
      )
    }
    const ceiling = rows.filter((r) => r.inTop30 === "y").length
    console.log(`\n=== Totals (k=${SHORTLIST}, excerpt=${EXCERPT}) ===`)
    console.log(`  BM25        R@1 ${pct(bm25At1)}   R@3 ${pct(bm25At3)}`)
    console.log(`  BM25 + Jev  R@1 ${pct(jevAt1)}   R@3 ${pct(jevAt3)}`)
    console.log(
      `  Ceiling     ${pct(ceiling)} — the re-ranker can only find what BM25's top ${SHORTLIST} contained`,
    )
    console.log(
      `  ${calls} calls, ${cost.toLocaleString()} input tokens, ${ms}ms, ~$${((cost / 1e6) * 0.042).toFixed(4)}`,
    )
    // A truncated state drops the tail of the shortlist silently, so a run
    // with truncation is not measuring the k it claims to.
    if (truncated > 0) {
      console.log(`  WARNING: ${truncated}/${calls} states were TRUNCATED — effective k is lower than ${SHORTLIST}`)
    }
    console.log(`  n=${n}. One query is ${(100 / n).toFixed(1)} points; read the table, not the headline.`)

    // Deliberately weak: this is a measurement, not a gate. It fails only
    // if re-ranking actively destroys recall that BM25 already had.
    expect(jevAt3).toBeGreaterThanOrEqual(bm25At3 - 1)
  }, 300_000)
})
