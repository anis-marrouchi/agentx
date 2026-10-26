// Shared pieces of the LEANN vs BM25 spike (#1390): snapshot loading,
// the arm B tokenizer, BM25 with a pluggable tokenizer, result lines,
// and grading. Plan: notes/architecture/leann-vs-bm25-spike.md.
//
// Nothing here prints or writes document or question text. Result lines
// carry ids, scores and timings only, so they can go on screen.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { STOP_WORDS } from "../../src/memory/bm25"

export type Lang = "ar" | "fr" | "en" | "mixed"

export interface Doc {
  id: string
  /** "memory" or "wiki": a question with `kind` set searches only that pool. */
  kind?: string
  /** The text exactly as the product indexes it (see README). */
  text: string
}

export interface Question {
  qid: string
  lang: Lang | string
  /** same-lang-exact, same-lang-paraphrase, cross-lang, arabizi, morphology, identifier */
  type?: string
  kind?: string
  query: string
  /** Doc ids that answer the question. A hit is any of them in the top k. */
  expected: string[]
}

export interface Snapshot {
  docs: Doc[]
  questions: Question[]
  /** sha256 of corpus.jsonl + questions.jsonl, first 16 hex chars. */
  hash: string
}

export interface Hit { id: string; score: number }

/** One line of results-*.jsonl: one question, one arm, one run. */
export interface ResultLine {
  ts: string
  run_id: string
  arm: string
  variant: string
  snapshot: string
  qid: string
  lang: string
  type: string | null
  k: number
  latency_ms: number
  hits: Hit[]
  expected: string[]
  /** 1-based rank of the first expected doc in `hits`, null if absent. */
  first_hit_rank: number | null
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as T } catch { throw new Error(`${path}:${i + 1}: not JSON`) }
  })
}

/** Loads `<dir>/corpus.jsonl` and `<dir>/questions.jsonl` and checks every
 *  expected id exists, so a labelling typo fails before a run, not after. */
export function loadSnapshot(dir: string): Snapshot {
  const corpusPath = join(dir, "corpus.jsonl")
  const questionsPath = join(dir, "questions.jsonl")
  const docs = readJsonl<Doc>(corpusPath)
  const questions = readJsonl<Question>(questionsPath)
  const ids = new Set<string>()
  for (const d of docs) {
    if (!d.id || typeof d.text !== "string") throw new Error(`corpus entry without id/text: ${JSON.stringify(d.id)}`)
    if (ids.has(d.id)) throw new Error(`duplicate doc id: ${d.id}`)
    ids.add(d.id)
  }
  const qids = new Set<string>()
  for (const q of questions) {
    if (!q.qid || typeof q.query !== "string") throw new Error(`question without qid/query: ${JSON.stringify(q.qid)}`)
    if (qids.has(q.qid)) throw new Error(`duplicate qid: ${q.qid}`)
    qids.add(q.qid)
    if (!q.expected?.length) throw new Error(`${q.qid}: no expected ids (unlabelled)`)
    for (const id of q.expected) if (!ids.has(id)) throw new Error(`${q.qid}: expected id not in corpus: ${id}`)
  }
  const h = createHash("sha256")
  h.update(readFileSync(corpusPath))
  h.update(readFileSync(questionsPath))
  return { docs, questions, hash: h.digest("hex").slice(0, 16) }
}

// --- Arm B tokenizer ---
//
// As written in the plan: Unicode letters and digits, French accents
// stripped for matching, light Arabic normalization, FR + AR stop words
// added to the English list, 2-letter tokens kept for Arabic. No
// stemming: "الفاتورة" and "فاتورة" stay different tokens, which the
// `morphology` questions measure.

const ARABIC = /\p{Script=Arabic}/u

/** NFKC, lowercase, strip combining marks (French accents, Arabic
 *  tashkeel, and the hamza/madda that NFD splits off أ إ آ ؤ ئ), drop
 *  tatweel, unify ٱ→ا ى→ي ة→ه, Arabic-Indic digits → ASCII. */
export function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ـ/g, "")
    .replace(/ٱ/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
}

const FR_STOP = [
  "les", "des", "une", "est", "sont", "ete", "etre", "avoir", "ont", "etait", "aux", "avec", "pour",
  "par", "sur", "dans", "sous", "chez", "vers", "sans", "entre", "tres", "aussi", "tout", "tous",
  "toute", "toutes", "comme", "quand", "comment", "pourquoi", "oui", "non", "que", "qui", "quoi",
  "dont", "mais", "donc", "car", "cet", "cette", "ces", "mon", "mes", "ton", "tes", "son", "ses",
  "notre", "nos", "votre", "vos", "leur", "leurs", "nous", "vous", "ils", "elle", "elles", "lui",
  "pas", "plus", "avons", "avez", "fait", "faire", "peut", "quel", "quelle", "quels", "quelles",
]

const AR_STOP = [
  "في", "من", "إلى", "الى", "على", "عن", "مع", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي", "الذين",
  "هو", "هي", "هم", "هن", "أنا", "نحن", "أنت", "أنتم", "كان", "كانت", "يكون", "ما", "ماذا", "لا",
  "لم", "لن", "قد", "ثم", "أو", "أم", "بل", "كل", "بعض", "أي", "أن", "إن", "عند", "حتى", "لكن",
  "إذا", "كيف", "متى", "أين", "هل", "به", "بها", "له", "لها", "فيه", "فيها", "منه", "منها",
]

export const UNICODE_STOP_WORDS = new Set(
  [...STOP_WORDS, ...FR_STOP, ...AR_STOP].map(normalizeUnicode),
)

export function tokenizeUnicode(text: string): string[] {
  return normalizeUnicode(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => (ARABIC.test(w) ? w.length >= 2 : w.length > 2) && !UNICODE_STOP_WORDS.has(w))
}

// --- BM25 with a pluggable tokenizer ---
//
// Same formula and defaults as src/memory/bm25.ts (k1=1.2, b=0.75, +1
// inside the IDF log). With src's `tokenize` it must rank exactly as
// src's scoreAll does; the test pins that, so A and B differ only in
// the tokenizer.

/** Builds the index once; the returned function scores one query, sorted
 *  descending, zero scores left out (as src's scoreAll). */
export function bm25(
  docs: string[],
  tokenizer: (s: string) => string[],
  k1 = 1.2,
  b = 0.75,
): (query: string) => Array<{ docIndex: number; score: number }> {
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of tokenizer(d)) tf.set(t, (tf.get(t) ?? 0) + 1)
    return tf
  })
  const lens = tfs.map((tf) => [...tf.values()].reduce((a, n) => a + n, 0))
  const avg = docs.length ? lens.reduce((a, n) => a + n, 0) / docs.length : 0
  const df = new Map<string, number>()
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  return (query) => {
    const q = tokenizer(query)
    const out: Array<{ docIndex: number; score: number }> = []
    for (let i = 0; i < docs.length; i++) {
      let s = 0
      for (const term of q) {
        const n = df.get(term) ?? 0
        const f = tfs[i].get(term) ?? 0
        if (!n || !f) continue
        const idf = Math.log((docs.length - n + 0.5) / (n + 0.5) + 1)
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (lens[i] / avg)))
      }
      if (s > 0) out.push({ docIndex: i, score: s })
    }
    return out.sort((x, y) => y.score - x.score)
  }
}

export function firstHitRank(hits: Hit[], expected: string[]): number | null {
  const i = hits.findIndex((h) => expected.includes(h.id))
  return i >= 0 ? i + 1 : null
}

/** Run id: UTC time to the second plus the arm, e.g. 20261027T081500Z-B. */
export function newRunId(arm: string, now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${arm}`
}

// --- Grading ---

export interface Grade {
  n: number
  recall3: number
  recall5: number
  mrr: number
  zero: number
  p50: number
  p95: number
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function grade(lines: ResultLine[]): Grade {
  const n = lines.length
  if (!n) return { n: 0, recall3: 0, recall5: 0, mrr: 0, zero: 0, p50: 0, p95: 0 }
  const at = (k: number) => lines.filter((l) => l.first_hit_rank !== null && l.first_hit_rank <= k).length / n
  const lat = lines.map((l) => l.latency_ms).sort((a, b) => a - b)
  return {
    n,
    recall3: at(3),
    recall5: at(5),
    mrr: lines.reduce((s, l) => s + (l.first_hit_rank ? 1 / l.first_hit_rank : 0), 0) / n,
    zero: lines.filter((l) => l.hits.length === 0).length / n,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
  }
}
