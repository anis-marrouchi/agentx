import { describe, it, expect } from "vitest"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildIndex, scoreAll, tokenize } from "../../src/memory/bm25"
import { bm25, grade, loadSnapshot, normalizeUnicode, tokenizeUnicode, type ResultLine } from "../../bench/leann-1390/lib"
import { runArm } from "../../bench/leann-1390/run"

// Harness of the LEANN vs BM25 spike (#1390): arms A and B must differ
// only in the tokenizer, and result files must never carry text.

const DEMO = join(__dirname, "../../bench/leann-1390/demo/snapshot")

describe("leann-1390 arm B tokenizer", () => {
  it("keeps Arabic, as the shipped tokenizer now does too", () => {
    expect(tokenize("اجتماع الفريق يوم الاثنين")).toEqual(["اجتماع", "فريق", "يوم", "اثنين"])
    expect(tokenizeUnicode("اجتماع الفريق يوم الاثنين")).toEqual(["اجتماع", "الفريق", "يوم", "الاثنين"])
  })

  it("matches French words with and without accents", () => {
    expect(tokenize("Réunion d'équipe")).toEqual(["reunion", "equipe"])
    expect(tokenizeUnicode("Réunion d'équipe")).toEqual(["reunion", "equipe"])
    expect(tokenizeUnicode("reunion equipe")).toEqual(tokenizeUnicode("RÉUNION ÉQUIPE"))
  })

  it("unifies Arabic letter variants and strips tashkeel and tatweel", () => {
    expect(normalizeUnicode("إلى")).toBe(normalizeUnicode("الى"))
    expect(normalizeUnicode("فاتورة")).toBe(normalizeUnicode("فاتوره"))
    expect(normalizeUnicode("مُدِير")).toBe("مدير")
    expect(normalizeUnicode("مـــدير")).toBe("مدير")
    expect(normalizeUnicode("٢٠٤١")).toBe("2041")
  })

  it("drops French and Arabic stop words", () => {
    expect(tokenizeUnicode("dans les cartons pour nous")).toEqual(["cartons"])
    expect(tokenizeUnicode("في المكتب على الطاولة")).toEqual(["المكتب", "الطاوله"])
  })
})

describe("leann-1390 BM25", () => {
  it("ranks exactly as src/memory/bm25.ts when given the shipped tokenizer", () => {
    const docs = loadSnapshot(DEMO).docs.map((d) => d.text)
    const query = bm25(docs, tokenize)
    const index = buildIndex(docs)
    for (const q of ["invoice INV-2041 paid", "staging deploy", "réunion équipe", "backup thirty days", "nothing matches"]) {
      const mine = query(q).map((r) => [r.docIndex, r.score.toFixed(9)])
      const shipped = scoreAll(q, index).map((r) => [r.docIndex, r.score.toFixed(9)])
      expect(mine).toEqual(shipped)
    }
  })
})

describe("leann-1390 snapshot", () => {
  it("rejects a question whose expected id is not in the corpus", () => {
    const dir = mkdtempSync(join(tmpdir(), "leann-1390-"))
    try {
      writeFileSync(join(dir, "corpus.jsonl"), JSON.stringify({ id: "a", text: "x" }) + "\n")
      writeFileSync(join(dir, "questions.jsonl"), JSON.stringify({ qid: "q1", lang: "en", query: "x", expected: ["b"] }) + "\n")
      expect(() => loadSnapshot(dir)).toThrow(/expected id not in corpus: b/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("leann-1390 grading", () => {
  const line = (rank: number | null, hits: number, ms: number): ResultLine => ({
    ts: "", run_id: "r", arm: "A", variant: "v", snapshot: "s", qid: "q", lang: "en", type: null, k: 10,
    latency_ms: ms, hits: Array.from({ length: hits }, (_, i) => ({ id: `d${i}`, score: 1 })), expected: ["x"], first_hit_rank: rank,
  })

  it("computes recall@k, MRR, zero-result rate and latency percentiles", () => {
    const g = grade([line(1, 5, 1), line(4, 5, 2), line(null, 5, 3), line(null, 0, 4)])
    expect(g).toEqual({ n: 4, recall3: 0.25, recall5: 0.5, mrr: (1 + 0.25) / 4, zero: 0.25, p50: 2, p95: 4 })
  })
})

describe("leann-1390 run", () => {
  it("writes ids, scores and timings but no document or question text", () => {
    const state = mkdtempSync(join(tmpdir(), "leann-1390-"))
    const write = process.stdout.write
    try {
      mkdirSync(join(state, "snapshot"))
      cpSync(DEMO, join(state, "snapshot"), { recursive: true })
      process.stdout.write = (() => true) as typeof process.stdout.write
      runArm([state, "--arm", "B", "--run-id", "test-B"])
      process.stdout.write = write

      expect(readdirSync(state).sort()).toEqual(["COMMANDS.md", "results-test-B.jsonl", "snapshot"])
      const raw = readFileSync(join(state, "results-test-B.jsonl"), "utf-8")
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as ResultLine)
      const snap = loadSnapshot(join(state, "snapshot"))
      expect(lines.map((l) => l.qid)).toEqual(snap.questions.map((q) => q.qid))
      for (const l of lines) expect(Object.keys(l)).not.toContain("query")
      for (const d of snap.docs) expect(raw).not.toContain(d.text.slice(0, 20))
      for (const q of snap.questions) expect(raw).not.toContain(q.query)
      expect(readFileSync(join(state, "COMMANDS.md"), "utf-8")).toContain(`snapshot: ${snap.hash}`)
    } finally {
      process.stdout.write = write
      rmSync(state, { recursive: true, force: true })
    }
  })
})
